import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { IS_PUBLIC_ROUTE_KEY } from './auth.decorators';
import { AUTH_COOKIE_NAMES, parseRequestCookies } from './http-cookie.util';
import type { RequestWithVerifiedTenant } from './tenant-membership.guard';
import { AuthRepository } from '../modules/auth/auth.repository';
import { RedisSessionCacheService } from '../modules/auth/session-cache.service';
import { TokenService } from '../modules/auth/token.service';

export interface RequestWithAuthSession extends RequestWithVerifiedTenant {
  csrfVerifiedBySession?: boolean;
  effectiveTenantPermissions?: string[];
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
    private readonly sessionCache: RedisSessionCacheService,
    private readonly authRepo: AuthRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const http = context.switchToHttp();
    const req = http.getRequest<RequestWithAuthSession>();
    const res = http.getResponse<Response>();

    const { rawAccessToken, transport } = this.extractAccessToken(req);
    if (!rawAccessToken || !transport) {
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication is required to access this resource.',
      });
    }

    const claims = this.tokenService.verifyAccessToken(rawAccessToken);

    if (await this.sessionCache.isSessionTombstoned(claims.sid)) {
      if (transport === 'cookie') {
        this.tokenService.clearSessionCookies(res);
      }
      throw new UnauthorizedException({
        code: 'SESSION_REVOKED',
        message: 'Session has been revoked. Please sign in again.',
      });
    }

    const method = (req.method || 'GET').toUpperCase();
    const rawCsrfHeader = req.headers['x-csrf-token'];
    const csrfTokenHeader = Array.isArray(rawCsrfHeader) ? rawCsrfHeader[0] : rawCsrfHeader;
    const candidateCsrfHash =
      transport === 'cookie' &&
      MUTATING_METHODS.has(method) &&
      typeof csrfTokenHeader === 'string' &&
      csrfTokenHeader.trim() !== ''
        ? this.tokenService.sha256Hex(csrfTokenHeader.trim())
        : null;

    const dbSession = await this.authRepo.validateSessionInDb(
      claims.sid,
      candidateCsrfHash,
      claims.sub,
    );
    if (!dbSession || dbSession.userId.toLowerCase() !== claims.sub.toLowerCase()) {
      if (transport === 'cookie') {
        this.tokenService.clearSessionCookies(res);
      }
      throw new UnauthorizedException({
        code: 'INVALID_SESSION',
        message: 'Authenticated session could not be verified.',
      });
    }

    if (dbSession.revokedAt !== null) {
      await this.sessionCache.tombstoneSessions([dbSession.sessionId], 'DB_REVOKED');
      if (transport === 'cookie') {
        this.tokenService.clearSessionCookies(res);
      }
      throw new UnauthorizedException({
        code: 'SESSION_REVOKED',
        message: 'Session has been revoked. Please sign in again.',
      });
    }

    const nowMs = Date.now();
    if (dbSession.expiresAtEpochMs <= nowMs || dbSession.idleExpiresAtEpochMs <= nowMs) {
      await this.sessionCache.tombstoneSessions([dbSession.sessionId], 'EXPIRED');
      if (transport === 'cookie') {
        this.tokenService.clearSessionCookies(res);
      }
      throw new UnauthorizedException({
        code: 'SESSION_EXPIRED',
        message: 'Session has expired. Please sign in again.',
      });
    }

    if (dbSession.userStatus !== 'ACTIVE' || !dbSession.userEmailVerified) {
      await this.sessionCache.tombstoneSessions([dbSession.sessionId], 'USER_INACTIVE');
      if (transport === 'cookie') {
        this.tokenService.clearSessionCookies(res);
      }
      throw new ForbiddenException({
        code: 'USER_ACCOUNT_INACTIVE',
        message: 'User account is inactive or suspended.',
      });
    }

    await this.sessionCache.cacheActiveSession({
      sessionId: dbSession.sessionId,
      familyId: dbSession.familyId,
      userId: dbSession.userId,
      activeTenantId: dbSession.activeTenantId,
      activeMembershipId: dbSession.activeMembershipId,
      isPlatformSuperAdmin: dbSession.isPlatformSuperAdmin,
      idleExpiresAtEpochMs: dbSession.idleExpiresAtEpochMs,
      expiresAtEpochMs: dbSession.expiresAtEpochMs,
    });

    req.csrfVerifiedBySession = dbSession.csrfValid;
    req.authSession = Object.freeze({
      userId: dbSession.userId,
      activeTenantId: dbSession.activeTenantId,
      activeMembershipId: dbSession.activeMembershipId,
      sessionId: dbSession.sessionId,
      familyId: dbSession.familyId,
      isPlatformSuperAdmin: dbSession.isPlatformSuperAdmin,
      authTransport: transport,
    });

    return true;
  }

  private extractAccessToken(req: RequestWithAuthSession): {
    rawAccessToken: string | null;
    transport: 'bearer' | 'cookie' | null;
  } {
    const authHeader = req.headers.authorization;
    const rawBearer = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (typeof rawBearer === 'string' && /^Bearer\s+\S+/i.test(rawBearer)) {
      return {
        rawAccessToken: rawBearer.replace(/^Bearer\s+/i, '').trim(),
        transport: 'bearer',
      };
    }

    const cookies = parseRequestCookies(req.headers.cookie);
    const cookieToken = cookies[AUTH_COOKIE_NAMES.accessToken];
    if (typeof cookieToken === 'string' && cookieToken.trim() !== '') {
      return {
        rawAccessToken: cookieToken.trim(),
        transport: 'cookie',
      };
    }

    return { rawAccessToken: null, transport: null };
  }
}
