import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { APP_CONFIG, type AppEnvConfig } from '../config/env.config';
import { AUTH_COOKIE_NAMES, parseRequestCookies } from './http-cookie.util';
import type { RequestWithAuthSession } from './jwt-auth.guard';

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfProtectionGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppEnvConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithAuthSession>();
    const method = (req.method || 'GET').toUpperCase();

    if (SAFE_HTTP_METHODS.has(method)) {
      return true;
    }

    // Explicit Authorization: Bearer clients do not rely on ambient browser cookies
    const authHeader = req.headers.authorization;
    const rawBearer = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (
      req.authSession?.authTransport === 'bearer' ||
      (typeof rawBearer === 'string' && /^Bearer\s+\S+/i.test(rawBearer))
    ) {
      return true;
    }

    this.verifyOriginIfPresent(req);

    const cookies = parseRequestCookies(req.headers.cookie);
    const cookieCsrf = cookies[AUTH_COOKIE_NAMES.csrfToken];
    const headerRaw = req.headers['x-csrf-token'];
    const headerCsrf = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;

    if (
      typeof cookieCsrf !== 'string' ||
      cookieCsrf.trim() === '' ||
      typeof headerCsrf !== 'string' ||
      headerCsrf.trim() === ''
    ) {
      throw new ForbiddenException({
        code: 'CSRF_TOKEN_INVALID',
        message: 'Missing required CSRF protection token.',
      });
    }

    const cookieBuf = Buffer.from(cookieCsrf.trim(), 'utf8');
    const headerBuf = Buffer.from(headerCsrf.trim(), 'utf8');
    if (cookieBuf.length !== headerBuf.length || !timingSafeEqual(cookieBuf, headerBuf)) {
      throw new ForbiddenException({
        code: 'CSRF_TOKEN_INVALID',
        message: 'CSRF token validation failed.',
      });
    }

    // When JwtAuthGuard has validated the session in PostgreSQL, enforce cryptographic hash match too
    if (req.csrfVerifiedBySession === false) {
      throw new ForbiddenException({
        code: 'CSRF_TOKEN_INVALID',
        message: 'CSRF token does not match active server session.',
      });
    }

    return true;
  }

  private verifyOriginIfPresent(req: RequestWithAuthSession): void {
    const originHeader = req.headers.origin;
    const rawOrigin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (rawOrigin && rawOrigin.trim() !== '') {
      const normalized = rawOrigin.trim().replace(/\/+$/, '');
      const allowed = this.config.corsAllowedOrigins.map((o) => o.replace(/\/+$/, ''));
      if (!allowed.includes(normalized)) {
        throw new ForbiddenException({
          code: 'CSRF_TOKEN_INVALID',
          message: 'Cross-site request origin is not permitted.',
        });
      }
      return;
    }

    const refererHeader = req.headers.referer;
    const rawReferer = Array.isArray(refererHeader) ? refererHeader[0] : refererHeader;
    if (rawReferer && rawReferer.trim() !== '') {
      let refererOrigin = '';
      try {
        refererOrigin = new URL(rawReferer.trim()).origin;
      } catch {
        throw new ForbiddenException({
          code: 'CSRF_TOKEN_INVALID',
          message: 'Malformed Referer header rejected by CSRF policy.',
        });
      }
      const allowed = this.config.corsAllowedOrigins.map((o) => o.replace(/\/+$/, ''));
      if (!allowed.includes(refererOrigin)) {
        throw new ForbiddenException({
          code: 'CSRF_TOKEN_INVALID',
          message: 'Cross-site Referer origin is not permitted.',
        });
      }
    }
  }
}
