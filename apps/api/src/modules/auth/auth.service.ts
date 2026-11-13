import { timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import type {
  AuthMeResponsePayload,
  AuthSessionSummary,
  LoginResponsePayload,
  RegisterUserResponsePayload,
  SelectOrganizationResponsePayload,
} from '@ft360/shared-types';
import {
  AUTH_COOKIE_NAMES,
  extractClientIp,
  extractUserAgent,
  parseRequestCookies,
} from '../../common/http-cookie.util';
import type { RequestWithAuthSession } from '../../common/jwt-auth.guard';
import { APP_CONFIG, type AppEnvConfig } from '../../config/env.config';
import { TenantTransactionManager } from '../../database/tenant-transaction.manager';
import { RbacRepository } from '../foundation-db/rbac.repository';
import { AuthAuditService } from './auth-audit.service';
import type {
  ForgotPasswordDto,
  LoginDto,
  RegisterUserDto,
  ResendVerificationDto,
  ResetPasswordDto,
  SelectOrganizationDto,
  VerifyEmailDto,
} from './auth.dto';
import { AuthMailOutboxService } from './auth-mail-outbox.service';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { AuthRepository } from './auth.repository';
import { PasswordHashService } from './password-hash.service';
import { RedisSessionCacheService } from './session-cache.service';
import { TokenService } from './token.service';

@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppEnvConfig,
    private readonly authRepo: AuthRepository,
    private readonly passwordHashService: PasswordHashService,
    private readonly tokenService: TokenService,
    private readonly sessionCache: RedisSessionCacheService,
    private readonly rateLimiter: AuthRateLimitService,
    private readonly auditService: AuthAuditService,
    private readonly mailOutbox: AuthMailOutboxService,
    private readonly txManager: TenantTransactionManager,
    private readonly rbacRepo: RbacRepository,
  ) {}

  issuePreAuthCsrfToken(res: Response): { csrfToken: string } {
    const csrfSecret = this.tokenService.generateOpaqueSecret();
    this.tokenService.setPreAuthCsrfCookie(res, csrfSecret.rawToken);
    return { csrfToken: csrfSecret.rawToken };
  }

  async register(
    dto: RegisterUserDto,
    req: RequestWithAuthSession,
    res: Response,
  ): Promise<RegisterUserResponsePayload> {
    const ip = extractClientIp(req);
    const ua = extractUserAgent(req);
    await this.rateLimiter.assertIpEndpointAllowed('register', ip, res);

    const normalizedEmail = dto.email.trim().toLowerCase();
    this.passwordHashService.validatePasswordPolicy(dto.password, normalizedEmail);

    const passwordHash = await this.passwordHashService.hashPassword(dto.password);
    const verifySecret = this.tokenService.generateOpaqueSecret();

    try {
      const user = await this.authRepo.registerPendingUser({
        email: normalizedEmail,
        passwordHash,
        fullName: dto.fullName.trim(),
        phoneE164: dto.phoneE164 ?? null,
        verifyTokenHash: verifySecret.tokenHashHex,
        verifyTtlSeconds: this.config.auth.emailVerificationTtlSeconds,
        requestedIp: ip,
      });

      await this.auditService.record({
        eventType: 'AUTH_USER_REGISTERED',
        outcome: 'SUCCESS',
        correlationId: req.correlationId,
        actorUserId: user.id,
        targetUserId: user.id,
        ipAddress: ip,
        userAgent: ua,
        metadata: { email: user.email },
      });

      await this.mailOutbox.enqueueEmailVerification({
        userId: user.id,
        email: user.email,
        fullName: user.fullName,
        rawToken: verifySecret.rawToken,
        correlationId: req.correlationId ?? '00000000-0000-0000-0000-000000000000',
      });

      return {
        user,
        verificationRequired: true,
      };
    } catch (err) {
      if (this.isPgUniqueViolation(err)) {
        await this.auditService.record({
          eventType: 'AUTH_REGISTER_CONFLICT',
          outcome: 'FAILURE',
          correlationId: req.correlationId,
          ipAddress: ip,
          userAgent: ua,
          metadata: { email: normalizedEmail },
        });
        throw new ConflictException({
          code: 'EMAIL_ALREADY_REGISTERED',
          message: 'An account with this email address already exists.',
        });
      }
      throw err;
    }
  }

  async verifyEmail(
    dto: VerifyEmailDto,
    req: RequestWithAuthSession,
    res: Response,
  ): Promise<{ verified: true }> {
    const ip = extractClientIp(req);
    const ua = extractUserAgent(req);
    await this.rateLimiter.assertIpEndpointAllowed('verify_email', ip, res);

    const tokenHashHex = this.tokenService.sha256Hex(dto.token.trim());
    const verified = await this.authRepo.consumeEmailVerificationToken(tokenHashHex);

    if (!verified) {
      await this.auditService.record({
        eventType: 'AUTH_EMAIL_VERIFICATION_FAILED',
        outcome: 'FAILURE',
        correlationId: req.correlationId,
        ipAddress: ip,
        userAgent: ua,
      });
      throw new BadRequestException({
        code: 'INVALID_OR_EXPIRED_VERIFICATION_TOKEN',
        message: 'Email verification link is invalid, expired, or has already been used.',
      });
    }

    await this.auditService.record({
      eventType: 'AUTH_EMAIL_VERIFIED',
      outcome: 'SUCCESS',
      correlationId: req.correlationId,
      actorUserId: verified.userId,
      targetUserId: verified.userId,
      ipAddress: ip,
      userAgent: ua,
      metadata: { email: verified.email },
    });

    return { verified: true };
  }

  async resendVerification(
    dto: ResendVerificationDto,
    req: RequestWithAuthSession,
    res: Response,
  ): Promise<{ accepted: true; message: string }> {
    const ip = extractClientIp(req);
    const ua = extractUserAgent(req);
    await this.rateLimiter.assertIpEndpointAllowed('resend_verify', ip, res);

    const normalizedEmail = dto.email.trim().toLowerCase();
    const secret = this.tokenService.generateOpaqueSecret();
    const issued = await this.authRepo.issueEmailVerificationToken({
      email: normalizedEmail,
      tokenHashHex: secret.tokenHashHex,
      ttlSeconds: this.config.auth.emailVerificationTtlSeconds,
      requestedIp: ip,
    });

    if (issued) {
      await this.mailOutbox.enqueueEmailVerification({
        userId: issued.userId,
        email: issued.email,
        fullName: issued.fullName,
        rawToken: secret.rawToken,
        correlationId: req.correlationId ?? '00000000-0000-0000-0000-000000000000',
      });
      await this.auditService.record({
        eventType: 'AUTH_VERIFICATION_RESENT',
        outcome: 'SUCCESS',
        correlationId: req.correlationId,
        actorUserId: issued.userId,
        targetUserId: issued.userId,
        ipAddress: ip,
        userAgent: ua,
      });
    } else {
      await this.auditService.record({
        eventType: 'AUTH_VERIFICATION_RESEND_NOOP',
        outcome: 'SUCCESS',
        correlationId: req.correlationId,
        ipAddress: ip,
        userAgent: ua,
      });
    }

    return {
      accepted: true,
      message:
        'If an unverified account exists for that email address, a verification link has been sent.',
    };
  }

  async login(
    dto: LoginDto,
    req: RequestWithAuthSession,
    res: Response,
  ): Promise<LoginResponsePayload> {
    const ip = extractClientIp(req);
    const ua = extractUserAgent(req);
    const normalizedEmail = dto.email.trim().toLowerCase();

    await this.rateLimiter.assertIpEndpointAllowed('login', ip, res);

    const existingLock = await this.rateLimiter.checkLoginLockout(normalizedEmail, ip);
    if (existingLock.locked) {
      await this.auditService.record({
        eventType: 'AUTH_LOGIN_LOCKED',
        outcome: 'DENIED',
        correlationId: req.correlationId,
        ipAddress: ip,
        userAgent: ua,
        metadata: { email: normalizedEmail, retryAfterSeconds: existingLock.retryAfterSeconds },
      });
      this.rateLimiter.throwRateLimited(res, existingLock.retryAfterSeconds);
    }

    const candidate = await this.authRepo.findLoginCandidateByEmail(normalizedEmail);
    const passwordMatches = await this.passwordHashService.verifyPasswordConstantTime(
      candidate?.passwordHash,
      dto.password,
    );

    if (!candidate || !passwordMatches) {
      const failureStatus = await this.rateLimiter.recordLoginFailure(normalizedEmail, ip);
      if (failureStatus.locked) {
        await this.auditService.record({
          eventType: 'AUTH_LOGIN_LOCKED',
          outcome: 'DENIED',
          correlationId: req.correlationId,
          targetUserId: candidate?.userId ?? null,
          ipAddress: ip,
          userAgent: ua,
          metadata: {
            email: normalizedEmail,
            failureCount: failureStatus.failureCount,
            retryAfterSeconds: failureStatus.retryAfterSeconds,
          },
        });
        this.rateLimiter.throwRateLimited(res, failureStatus.retryAfterSeconds);
      }

      await this.auditService.record({
        eventType: 'AUTH_LOGIN_FAILED',
        outcome: 'FAILURE',
        correlationId: req.correlationId,
        targetUserId: candidate?.userId ?? null,
        ipAddress: ip,
        userAgent: ua,
        metadata: {
          email: normalizedEmail,
          failureCount: failureStatus.failureCount,
        },
      });

      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email address or password.',
      });
    }

    if (!candidate.emailVerified) {
      await this.auditService.record({
        eventType: 'AUTH_LOGIN_DENIED_UNVERIFIED',
        outcome: 'DENIED',
        correlationId: req.correlationId,
        actorUserId: candidate.userId,
        targetUserId: candidate.userId,
        ipAddress: ip,
        userAgent: ua,
        metadata: { email: candidate.email },
      });
      throw new ForbiddenException({
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email address before signing in.',
      });
    }

    if (candidate.status !== 'ACTIVE') {
      await this.auditService.record({
        eventType: 'AUTH_LOGIN_DENIED_INACTIVE',
        outcome: 'DENIED',
        correlationId: req.correlationId,
        actorUserId: candidate.userId,
        targetUserId: candidate.userId,
        ipAddress: ip,
        userAgent: ua,
        metadata: { email: candidate.email, userStatus: candidate.status },
      });
      throw new ForbiddenException({
        code: 'USER_ACCOUNT_INACTIVE',
        message: 'Your user account is not active.',
      });
    }

    await this.rateLimiter.clearLoginFailures(normalizedEmail, ip);

    const refreshSecret = this.tokenService.generateOpaqueSecret();
    const csrfSecret = this.tokenService.generateOpaqueSecret();

    const createdSession = await this.authRepo.createSession({
      userId: candidate.userId,
      refreshTokenHashHex: refreshSecret.tokenHashHex,
      csrfSecretHashHex: csrfSecret.tokenHashHex,
      idleTtlSeconds: this.config.auth.refreshIdleTtlSeconds,
      absoluteTtlSeconds: this.config.auth.sessionAbsoluteTtlSeconds,
      ipAddress: ip,
      userAgent: ua,
    });

    await this.sessionCache.cacheActiveSession({
      sessionId: createdSession.sessionId,
      familyId: createdSession.familyId,
      userId: candidate.userId,
      activeTenantId: null,
      activeMembershipId: null,
      isPlatformSuperAdmin: candidate.isPlatformSuperAdmin,
      idleExpiresAtEpochMs: createdSession.idleExpiresAtEpochMs,
      expiresAtEpochMs: createdSession.expiresAtEpochMs,
    });

    const accessToken = this.tokenService.signAccessToken({
      userId: candidate.userId,
      sessionId: createdSession.sessionId,
      activeTenantId: null,
      activeMembershipId: null,
      isPlatformSuperAdmin: candidate.isPlatformSuperAdmin,
    });

    this.tokenService.setSessionCookies(res, {
      accessToken,
      refreshToken: refreshSecret.rawToken,
      csrfToken: csrfSecret.rawToken,
    });

    const organizations = await this.authRepo.listActiveUserTenants(candidate.userId);
    const nowIso = new Date().toISOString();

    await this.auditService.record({
      eventType: 'AUTH_LOGIN_SUCCESS',
      outcome: 'SUCCESS',
      correlationId: req.correlationId,
      actorUserId: candidate.userId,
      targetUserId: candidate.userId,
      sessionId: createdSession.sessionId,
      ipAddress: ip,
      userAgent: ua,
      metadata: {
        organizationCount: organizations.length,
        isPlatformSuperAdmin: candidate.isPlatformSuperAdmin,
      },
    });

    return {
      user: {
        id: candidate.userId,
        email: candidate.email,
        fullName: candidate.fullName,
        phoneE164: candidate.phoneE164,
        status: candidate.status,
        emailVerified: candidate.emailVerified,
        isPlatformSuperAdmin: candidate.isPlatformSuperAdmin,
        lastLoginAt: nowIso,
      },
      sessionId: createdSession.sessionId,
      activeOrganization: null,
      organizations,
      requiresOrganizationSelection: organizations.length > 0,
    };
  }

  async refreshSession(
    req: RequestWithAuthSession,
    res: Response,
  ): Promise<{ refreshed: true; sessionId: string; activeTenantId: string | null }> {
    const ip = extractClientIp(req);
    const ua = extractUserAgent(req);
    await this.rateLimiter.assertIpEndpointAllowed('refresh', ip, res);

    const cookies = parseRequestCookies(req.headers.cookie);
    const rawRefreshToken = cookies[AUTH_COOKIE_NAMES.refreshToken];
    if (!rawRefreshToken || rawRefreshToken.trim() === '') {
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_MISSING',
        message: 'Refresh session cookie is missing.',
      });
    }

    // Enforce double-submit CSRF cookie + header equality before rotating cookies
    const csrfCookie = cookies[AUTH_COOKIE_NAMES.csrfToken];
    const csrfHeaderRaw = req.headers['x-csrf-token'];
    const csrfHeader = Array.isArray(csrfHeaderRaw) ? csrfHeaderRaw[0] : csrfHeaderRaw;
    if (
      !csrfCookie ||
      !csrfHeader ||
      Buffer.byteLength(csrfCookie.trim()) !== Buffer.byteLength(csrfHeader.trim()) ||
      !timingSafeEqual(Buffer.from(csrfCookie.trim()), Buffer.from(csrfHeader.trim()))
    ) {
      throw new ForbiddenException({
        code: 'CSRF_TOKEN_INVALID',
        message: 'Missing or invalid CSRF protection token for session refresh.',
      });
    }

    const presentedRefreshHashHex = this.tokenService.sha256Hex(rawRefreshToken.trim());
    const candidateCsrfHashHex = this.tokenService.sha256Hex(csrfHeader.trim());
    const nextRefresh = this.tokenService.generateOpaqueSecret();
    const nextCsrf = this.tokenService.generateOpaqueSecret();

    const rotated = await this.authRepo.rotateRefreshSession({
      presentedRefreshHashHex,
      newRefreshHashHex: nextRefresh.tokenHashHex,
      newCsrfHashHex: nextCsrf.tokenHashHex,
      idleTtlSeconds: this.config.auth.refreshIdleTtlSeconds,
      candidateCsrfHashHex,
      requireCsrf: true,
      ipAddress: ip,
      userAgent: ua,
    });

    if (rotated.outcome === 'REPLAY_DETECTED') {
      await this.sessionCache.tombstoneSessions(
        rotated.revokedFamilySessionIds,
        'REPLAY_COMPROMISE',
      );
      this.tokenService.clearSessionCookies(res);
      await this.auditService.record({
        eventType: 'AUTH_REFRESH_REPLAY_DETECTED',
        outcome: 'DENIED',
        correlationId: req.correlationId,
        actorUserId: rotated.userId,
        targetUserId: rotated.userId,
        sessionId: rotated.sessionId,
        ipAddress: ip,
        userAgent: ua,
        metadata: {
          familyId: rotated.familyId,
          activeTenantId: rotated.activeTenantId,
          revokedSessionCount: rotated.revokedFamilySessionIds.length,
        },
      });
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_REPLAY_DETECTED',
        message: 'Session security alert: rotated refresh token reuse detected. All sessions in family revoked.',
      });
    }

    if (rotated.outcome === 'CSRF_INVALID') {
      await this.auditService.record({
        eventType: 'AUTH_REFRESH_CSRF_DENIED',
        outcome: 'DENIED',
        correlationId: req.correlationId,
        actorUserId: rotated.userId,
        sessionId: rotated.sessionId,
        ipAddress: ip,
        userAgent: ua,
      });
      throw new ForbiddenException({
        code: 'CSRF_TOKEN_INVALID',
        message: 'CSRF token does not match server session.',
      });
    }

    if (
      rotated.outcome !== 'ROTATED' ||
      !rotated.sessionId ||
      !rotated.familyId ||
      !rotated.userId ||
      !rotated.idleExpiresAtEpochMs ||
      !rotated.expiresAtEpochMs
    ) {
      if (rotated.sessionId) {
        await this.sessionCache.tombstoneSessions([rotated.sessionId], rotated.outcome);
      }
      this.tokenService.clearSessionCookies(res);
      await this.auditService.record({
        eventType: 'AUTH_REFRESH_FAILED',
        outcome: 'FAILURE',
        correlationId: req.correlationId,
        actorUserId: rotated.userId,
        sessionId: rotated.sessionId,
        ipAddress: ip,
        userAgent: ua,
        metadata: { reason: rotated.outcome },
      });
      throw new UnauthorizedException({
        code: rotated.outcome === 'EXPIRED' ? 'SESSION_EXPIRED' : 'INVALID_REFRESH_TOKEN',
        message: 'Refresh session is expired or invalid. Please sign in again.',
      });
    }

    await this.sessionCache.cacheActiveSession({
      sessionId: rotated.sessionId,
      familyId: rotated.familyId,
      userId: rotated.userId,
      activeTenantId: rotated.activeTenantId,
      activeMembershipId: rotated.activeMembershipId,
      isPlatformSuperAdmin: rotated.isPlatformSuperAdmin,
      idleExpiresAtEpochMs: rotated.idleExpiresAtEpochMs,
      expiresAtEpochMs: rotated.expiresAtEpochMs,
    });

    const accessToken = this.tokenService.signAccessToken({
      userId: rotated.userId,
      sessionId: rotated.sessionId,
      activeTenantId: rotated.activeTenantId,
      activeMembershipId: rotated.activeMembershipId,
      isPlatformSuperAdmin: rotated.isPlatformSuperAdmin,
    });

    this.tokenService.setSessionCookies(res, {
      accessToken,
      refreshToken: nextRefresh.rawToken,
      csrfToken: nextCsrf.rawToken,
    });

    await this.auditService.record({
      eventType: 'AUTH_SESSION_REFRESHED',
      outcome: 'SUCCESS',
      correlationId: req.correlationId,
      actorUserId: rotated.userId,
      sessionId: rotated.sessionId,
      ipAddress: ip,
      userAgent: ua,
      metadata: {
        activeTenantId: rotated.activeTenantId,
      },
    });

    return {
      refreshed: true,
      sessionId: rotated.sessionId,
      activeTenantId: rotated.activeTenantId,
    };
  }

  async logout(req: RequestWithAuthSession, res: Response): Promise<{ loggedOut: true }> {
    const ip = extractClientIp(req);
    const ua = extractUserAgent(req);
    let session = req.authSession;

    if (!session?.sessionId) {
      const authHeader = req.headers.authorization;
      const rawBearer = Array.isArray(authHeader) ? authHeader[0] : authHeader;
      const cookies = parseRequestCookies(req.headers.cookie);
      const rawAt =
        typeof rawBearer === 'string' && /^Bearer\s+\S+/i.test(rawBearer)
          ? rawBearer.replace(/^Bearer\s+/i, '').trim()
          : cookies[AUTH_COOKIE_NAMES.accessToken];
      if (rawAt) {
        try {
          const claims = this.tokenService.verifyAccessToken(rawAt);
          session = {
            userId: claims.sub,
            sessionId: claims.sid,
            activeTenantId: claims.tid,
          };
        } catch {
          // Access token may already be expired; fall through to refresh-cookie revocation below
        }
      }
    }

    if (session?.sessionId && session.userId) {
      await this.authRepo.revokeSession(session.sessionId, session.userId, 'USER_LOGOUT');
      await this.sessionCache.tombstoneSessions([session.sessionId], 'USER_LOGOUT');
      await this.auditService.record({
        eventType: 'AUTH_LOGOUT',
        outcome: 'SUCCESS',
        correlationId: req.correlationId,
        actorUserId: session.userId,
        sessionId: session.sessionId,
        ipAddress: ip,
        userAgent: ua,
        metadata: {
          activeTenantId: session.activeTenantId ?? null,
        },
      });
    } else {
      const cookies = parseRequestCookies(req.headers.cookie);
      const rawRt = cookies[AUTH_COOKIE_NAMES.refreshToken];
      if (rawRt && rawRt.trim() !== '') {
        const rtHash = this.tokenService.sha256Hex(rawRt.trim());
        const revoked = await this.authRepo.revokeSessionByRefreshHash(rtHash, 'USER_LOGOUT');
        if (revoked) {
          await this.sessionCache.tombstoneSessions([revoked.sessionId], 'USER_LOGOUT');
          await this.auditService.record({
            eventType: 'AUTH_LOGOUT',
            outcome: 'SUCCESS',
            correlationId: req.correlationId,
            actorUserId: revoked.userId,
            sessionId: revoked.sessionId,
            ipAddress: ip,
            userAgent: ua,
            metadata: {
              activeTenantId: revoked.activeTenantId,
            },
          });
        }
      }
    }

    this.tokenService.clearSessionCookies(res);
    return { loggedOut: true };
  }

  async logoutAll(
    req: RequestWithAuthSession,
    res: Response,
  ): Promise<{ loggedOutAll: true; revokedCount: number }> {
    const session = this.requireAuthSession(req);
    const revokedIds = await this.authRepo.revokeAllUserSessions(
      session.userId,
      'USER_LOGOUT_ALL',
    );
    await this.sessionCache.markAllUserSessionsRevoked(
      session.userId,
      revokedIds,
      'USER_LOGOUT_ALL',
    );
    this.tokenService.clearSessionCookies(res);

    await this.auditService.record({
      eventType: 'AUTH_LOGOUT_ALL',
      outcome: 'SUCCESS',
      correlationId: req.correlationId,
      actorUserId: session.userId,
      targetUserId: session.userId,
      sessionId: session.sessionId,
      ipAddress: extractClientIp(req),
      userAgent: extractUserAgent(req),
      metadata: { revokedCount: revokedIds.length },
    });

    return {
      loggedOutAll: true,
      revokedCount: revokedIds.length,
    };
  }

  async forgotPassword(
    dto: ForgotPasswordDto,
    req: RequestWithAuthSession,
    res: Response,
  ): Promise<{ accepted: true; message: string }> {
    const ip = extractClientIp(req);
    const ua = extractUserAgent(req);
    await this.rateLimiter.assertIpEndpointAllowed('forgot_password', ip, res);

    const normalizedEmail = dto.email.trim().toLowerCase();
    const resetSecret = this.tokenService.generateOpaqueSecret();
    const issued = await this.authRepo.issuePasswordResetToken({
      email: normalizedEmail,
      tokenHashHex: resetSecret.tokenHashHex,
      ttlSeconds: this.config.auth.passwordResetTtlSeconds,
      requestedIp: ip,
    });

    if (issued) {
      await this.mailOutbox.enqueuePasswordReset({
        userId: issued.userId,
        email: issued.email,
        fullName: issued.fullName,
        rawToken: resetSecret.rawToken,
        correlationId: req.correlationId ?? '00000000-0000-0000-0000-000000000000',
      });
      await this.auditService.record({
        eventType: 'AUTH_PASSWORD_RESET_REQUESTED',
        outcome: 'SUCCESS',
        correlationId: req.correlationId,
        actorUserId: issued.userId,
        targetUserId: issued.userId,
        ipAddress: ip,
        userAgent: ua,
      });
    } else {
      await this.auditService.record({
        eventType: 'AUTH_PASSWORD_RESET_REQUEST_NOOP',
        outcome: 'SUCCESS',
        correlationId: req.correlationId,
        ipAddress: ip,
        userAgent: ua,
      });
    }

    return {
      accepted: true,
      message:
        'If an active account exists for that email address, password reset instructions have been sent.',
    };
  }

  async resetPassword(
    dto: ResetPasswordDto,
    req: RequestWithAuthSession,
    res: Response,
  ): Promise<{ passwordReset: true }> {
    const ip = extractClientIp(req);
    const ua = extractUserAgent(req);
    await this.rateLimiter.assertIpEndpointAllowed('reset_password', ip, res);

    this.passwordHashService.validatePasswordPolicy(dto.newPassword);
    const newPasswordHash = await this.passwordHashService.hashPassword(dto.newPassword);
    const tokenHashHex = this.tokenService.sha256Hex(dto.token.trim());

    const result = await this.authRepo.resetPasswordWithToken({
      tokenHashHex,
      newPasswordHash,
      consumedIp: ip,
    });

    if (!result) {
      await this.auditService.record({
        eventType: 'AUTH_PASSWORD_RESET_FAILED',
        outcome: 'FAILURE',
        correlationId: req.correlationId,
        ipAddress: ip,
        userAgent: ua,
      });
      throw new BadRequestException({
        code: 'INVALID_OR_EXPIRED_RESET_TOKEN',
        message: 'Password reset token is invalid, expired, or has already been used.',
      });
    }

    await this.sessionCache.markAllUserSessionsRevoked(
      result.userId,
      result.revokedSessionIds,
      'PASSWORD_RESET',
    );
    this.tokenService.clearSessionCookies(res);

    await this.auditService.record({
      eventType: 'AUTH_PASSWORD_RESET_COMPLETED',
      outcome: 'SUCCESS',
      correlationId: req.correlationId,
      actorUserId: result.userId,
      targetUserId: result.userId,
      ipAddress: ip,
      userAgent: ua,
      metadata: { revokedSessionCount: result.revokedSessionIds.length },
    });

    return { passwordReset: true };
  }

  async getMe(req: RequestWithAuthSession): Promise<AuthMeResponsePayload> {
    const session = this.requireAuthSession(req);
    const user = await this.txManager.withAuthenticatedUserTransaction(session.userId, (tx) =>
      this.authRepo.getAuthenticatedUserProfile(tx, session.userId),
    );
    if (!user) {
      throw new UnauthorizedException({
        code: 'INVALID_SESSION',
        message: 'Authenticated user record not found.',
      });
    }

    const organizations = await this.authRepo.listActiveUserTenants(session.userId);
    const activeOrg = session.activeTenantId
      ? organizations.find(
          (o) => o.tenantId.toLowerCase() === session.activeTenantId!.toLowerCase(),
        ) ?? null
      : null;

    let effectiveTenantPermissions: string[] = [];
    if (activeOrg && session.activeMembershipId) {
      effectiveTenantPermissions = await this.txManager.withVerifiedMemberTransaction(
        {
          tenantId: activeOrg.tenantId,
          actorUserId: session.userId,
          membershipId: session.activeMembershipId,
          correlationId: req.correlationId ?? '00000000-0000-0000-0000-000000000000',
        },
        async (tx, verifiedMembershipId) => {
          const perms = await this.rbacRepo.listEffectivePermissionsForMembership(
            tx,
            activeOrg.tenantId,
            verifiedMembershipId,
          );
          return perms.map((p) => p.code);
        },
      );
    }

    return {
      user,
      sessionId: session.sessionId!,
      activeOrganization: activeOrg,
      organizations,
      requiresOrganizationSelection: !activeOrg && organizations.length > 0,
      effectiveTenantPermissions,
    };
  }

  async listOwnSessions(req: RequestWithAuthSession): Promise<AuthSessionSummary[]> {
    const session = this.requireAuthSession(req);
    return this.txManager.withAuthenticatedUserTransaction(session.userId, (tx) =>
      this.authRepo.listOwnActiveSessions(tx, session.userId, session.sessionId!),
    );
  }

  async revokeOwnSessionById(
    targetSessionId: string,
    req: RequestWithAuthSession,
    res: Response,
  ): Promise<{ revoked: true }> {
    const session = this.requireAuthSession(req);
    const revoked = await this.authRepo.revokeSession(
      targetSessionId,
      session.userId,
      'USER_DEVICE_REVOKE',
    );
    if (!revoked) {
      throw new NotFoundException({
        code: 'SESSION_NOT_FOUND',
        message: 'Target active session was not found.',
      });
    }

    await this.sessionCache.tombstoneSessions([targetSessionId], 'USER_DEVICE_REVOKE');
    if (targetSessionId.toLowerCase() === session.sessionId!.toLowerCase()) {
      this.tokenService.clearSessionCookies(res);
    }

    await this.auditService.record({
      eventType: 'AUTH_SESSION_REVOKED',
      outcome: 'SUCCESS',
      correlationId: req.correlationId,
      actorUserId: session.userId,
      targetUserId: session.userId,
      sessionId: session.sessionId,
      ipAddress: extractClientIp(req),
      userAgent: extractUserAgent(req),
      metadata: { revokedSessionId: targetSessionId },
    });

    return { revoked: true };
  }

  async selectOrganization(
    dto: SelectOrganizationDto,
    req: RequestWithAuthSession,
    res: Response,
  ): Promise<SelectOrganizationResponsePayload> {
    const session = this.requireAuthSession(req);
    const ip = extractClientIp(req);
    const ua = extractUserAgent(req);
    const targetTenantId = dto.targetOrganizationId.trim().toLowerCase();

    const bound = await this.authRepo.bindSessionOrganization({
      sessionId: session.sessionId!,
      userId: session.userId,
      targetTenantId,
    });

    if (bound.outcome === 'SESSION_INVALID') {
      throw new UnauthorizedException({
        code: 'INVALID_SESSION',
        message: 'Authenticated session is no longer active.',
      });
    }

    if (bound.outcome !== 'BOUND' || !bound.activeTenantId || !bound.activeMembershipId) {
      await this.auditService.record({
        eventType: 'AUTH_ORGANIZATION_SELECTION_DENIED',
        outcome: 'DENIED',
        correlationId: req.correlationId,
        actorUserId: session.userId,
        sessionId: session.sessionId,
        ipAddress: ip,
        userAgent: ua,
        metadata: {
          attemptedOrganizationId: targetTenantId,
          reason: bound.outcome,
        },
      });
      throw new ForbiddenException({
        code: bound.outcome,
        message: 'Access denied: you do not have an active membership in the requested organization.',
      });
    }

    await this.sessionCache.evictSessionCache(session.sessionId!);

    const accessToken = this.tokenService.signAccessToken({
      userId: session.userId,
      sessionId: session.sessionId!,
      activeTenantId: bound.activeTenantId,
      activeMembershipId: bound.activeMembershipId,
      isPlatformSuperAdmin: Boolean(session.isPlatformSuperAdmin),
    });

    this.tokenService.setSessionCookies(res, { accessToken });

    const organizations = await this.authRepo.listActiveUserTenants(session.userId);
    const activeOrg =
      organizations.find((o) => o.tenantId.toLowerCase() === bound.activeTenantId!.toLowerCase()) ??
      null;

    const effectiveTenantPermissions = await this.txManager.withVerifiedMemberTransaction(
      {
        tenantId: bound.activeTenantId,
        actorUserId: session.userId,
        membershipId: bound.activeMembershipId,
        correlationId: req.correlationId ?? '00000000-0000-0000-0000-000000000000',
      },
      async (tx, verifiedMembershipId) => {
        const perms = await this.rbacRepo.listEffectivePermissionsForMembership(
          tx,
          bound.activeTenantId!,
          verifiedMembershipId,
        );
        await this.auditService.record({
          eventType: 'AUTH_ORGANIZATION_SELECTED',
          outcome: 'SUCCESS',
          correlationId: req.correlationId,
          actorUserId: session.userId,
          tenantId: bound.activeTenantId,
          sessionId: session.sessionId,
          ipAddress: ip,
          userAgent: ua,
          metadata: { membershipId: verifiedMembershipId },
          tx,
        });
        return perms.map((p) => p.code);
      },
    );

    return {
      sessionId: session.sessionId!,
      activeOrganization: activeOrg,
      effectiveTenantPermissions,
    };
  }

  async exitOrganization(
    req: RequestWithAuthSession,
    res: Response,
  ): Promise<SelectOrganizationResponsePayload> {
    const session = this.requireAuthSession(req);
    const previousTenantId = session.activeTenantId ?? null;

    const cleared = await this.authRepo.bindSessionOrganization({
      sessionId: session.sessionId!,
      userId: session.userId,
      targetTenantId: null,
    });

    if (cleared.outcome === 'SESSION_INVALID') {
      throw new UnauthorizedException({
        code: 'INVALID_SESSION',
        message: 'Authenticated session is no longer active.',
      });
    }

    await this.sessionCache.evictSessionCache(session.sessionId!);

    const accessToken = this.tokenService.signAccessToken({
      userId: session.userId,
      sessionId: session.sessionId!,
      activeTenantId: null,
      activeMembershipId: null,
      isPlatformSuperAdmin: Boolean(session.isPlatformSuperAdmin),
    });
    this.tokenService.setSessionCookies(res, { accessToken });

    await this.auditService.record({
      eventType: 'AUTH_ORGANIZATION_EXITED',
      outcome: 'SUCCESS',
      correlationId: req.correlationId,
      actorUserId: session.userId,
      sessionId: session.sessionId,
      ipAddress: extractClientIp(req),
      userAgent: extractUserAgent(req),
      metadata: { previousTenantId },
    });

    return {
      sessionId: session.sessionId!,
      activeOrganization: null,
      effectiveTenantPermissions: [],
    };
  }

  private requireAuthSession(req: RequestWithAuthSession) {
    if (!req.authSession?.userId || !req.authSession.sessionId) {
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authenticated session is required.',
      });
    }
    return req.authSession;
  }

  private isPgUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    );
  }
}
