import { createHash } from 'node:crypto';
import * as net from 'node:net';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import type {
  CheckSlugAvailabilityResponsePayload,
  MembershipStatus,
  MembershipType,
  TenantRegistrationResponsePayload,
  TenantStatus,
} from '@ft360/shared-types';
import { RedisService } from '../../cache/redis.service';
import { APP_CONFIG, type AppEnvConfig } from '../../config/env.config';
import { TenantTransactionManager } from '../../database/tenant-transaction.manager';
import { AuthAuditService } from '../auth/auth-audit.service';
import { RedisSessionCacheService } from '../auth/session-cache.service';
import { TokenService } from '../auth/token.service';
import type {
  CheckSlugAvailabilityQueryDto,
  RegisterTenantDto,
} from './tenant-registration.dto';
import { TenantRegistrationRepository } from './tenant-registration.repository';

export interface RegistrationSessionContext {
  userId: string;
  sessionId: string;
  isPlatformSuperAdmin: boolean;
  activeTenantId?: string | null;
  activeMembershipId?: string | null;
}

@Injectable()
export class TenantRegistrationService {
  private readonly logger = new Logger(TenantRegistrationService.name);

  constructor(
    private readonly repo: TenantRegistrationRepository,
    private readonly txManager: TenantTransactionManager,
    private readonly redis: RedisService,
    private readonly sessionCache: RedisSessionCacheService,
    private readonly tokenService: TokenService,
    private readonly auditService: AuthAuditService,
    @Inject(APP_CONFIG) private readonly config: AppEnvConfig,
  ) {}

  /**
   * Endpoint #1: Checks candidate tenant slug availability.
   *
   * Enforces multi-tier rate limiting:
   * - 15 req / 60s burst per userId
   * - 20 req / 60s burst per IP
   * - 100 req / hr sustained per userId (15-min lockout + AUTH_RATE_LIMIT_EXCEEDED audit log on breach)
   * - Fails closed (503 SERVICE_TEMPORARILY_UNAVAILABLE) if Redis rate-limit backend is offline
   *
   * Executes public.fn_check_tenant_slug_available($1) inside withAuthenticatedUserTransaction.
   * Returns binary slug availability only, with zero tenant metadata disclosure.
   */
  async checkSlugAvailability(
    userId: string,
    ip: string | null,
    ua: string | null,
    correlationId: string,
    query: CheckSlugAvailabilityQueryDto,
  ): Promise<CheckSlugAvailabilityResponsePayload> {
    await this.enforceSlugAvailabilityRateLimits(userId, ip, ua, correlationId);

    try {
      const available = await this.txManager.withAuthenticatedUserTransaction(
        userId,
        async (tx) => {
          return this.repo.checkSlugAvailable(tx, query.slug);
        },
      );

      return {
        slug: query.slug,
        available,
      };
    } catch (err: unknown) {
      this.mapDatabaseSecurityError(err);
    }
  }

  /**
   * Endpoint #2: Atomically provisions a new organization and binds caller's session.
   *
   * - Validates self-registration eligibility (ACTIVE, email verified, non-Super Admin).
   * - Enforces 5 registrations / hour per user & IP rate limits.
   * - Executes public.fn_tenant_provision_organization inside withAuthenticatedUserTransaction.
   * - Handles PostgreSQL errors (23505 -> 409 TENANT_SLUG_UNAVAILABLE, 23514 -> 422 TENANT_CREATION_QUOTA_EXCEEDED, 42501 -> 403).
   * - Evicts session cache in Redis, signs new access token with bound tenant/membership, and updates response cookies.
   */
  async registerTenant(
    session: RegistrationSessionContext,
    ip: string | null,
    ua: string | null,
    correlationId: string,
    dto: RegisterTenantDto,
    res: Response,
  ): Promise<TenantRegistrationResponsePayload> {
    if (!this.config.tenantSelfRegistrationEnabled) {
      throw new ForbiddenException({
        code: 'SELF_REGISTRATION_DISABLED',
        message: 'Self-service tenant registration is currently disabled.',
      });
    }

    if (session.isPlatformSuperAdmin) {
      throw new ForbiddenException({
        code: 'PLATFORM_ADMIN_CANNOT_OWN_TENANT',
        message: 'Platform Super Admins cannot self-register customer tenant workspaces.',
      });
    }

    await this.enforceRegistrationRateLimits(session.userId, ip);

    const safeIp = ip && net.isIP(ip) !== 0 ? ip : null;
    const safeUa = ua ? ua.slice(0, 512) : null;

    try {
      const row = await this.txManager.withAuthenticatedUserTransaction(
        session.userId,
        async (tx) => {
          return this.repo.provisionOrganization(tx, {
            actorUserId: session.userId,
            sessionId: session.sessionId,
            slug: dto.slug,
            displayName: dto.displayName,
            legalName: dto.legalName,
            organizationType: dto.organizationType,
            industry: dto.industry,
            countryCode: dto.countryCode,
            defaultTimezone: dto.defaultTimezone,
            defaultCurrency: dto.defaultCurrency,
            correlationId,
            ipAddress: safeIp,
            userAgent: safeUa,
          });
        },
      );

      // Post-commit side effects:
      // 1. Evict existing cached session so subsequent requests reload the updated active_tenant_id binding
      await this.sessionCache.evictSessionCache(session.sessionId);

      // 2. Sign updated access token with active tenant & membership binding
      const accessToken = this.tokenService.signAccessToken({
        userId: row.created_by_user_id,
        sessionId: row.bound_session_id,
        activeTenantId: row.tenant_id,
        activeMembershipId: row.membership_id,
        isPlatformSuperAdmin: false,
      });

      // 3. Update access token cookie on response
      this.tokenService.setSessionCookies(res, { accessToken });

      return {
        tenant: {
          id: row.tenant_id,
          slug: row.tenant_slug,
          legalName: row.legal_name,
          displayName: row.display_name,
          status: row.tenant_status as TenantStatus,
          defaultTimezone: row.default_timezone,
          defaultCurrency: row.default_currency,
          activatedAt: null,
          suspendedAt: null,
          deactivatedAt: null,
          cancelledAt: null,
          statusReason: null,
          onboardingCompletedAt: null,
          createdByUserId: row.created_by_user_id,
          createdAt:
            row.tenant_created_at instanceof Date
              ? row.tenant_created_at.toISOString()
              : String(row.tenant_created_at),
          updatedAt:
            row.tenant_updated_at instanceof Date
              ? row.tenant_updated_at.toISOString()
              : String(row.tenant_updated_at),
        },
        membership: {
          id: row.membership_id,
          membershipType: row.membership_type as MembershipType,
          status: row.membership_status as MembershipStatus,
          isPrimaryOwner: Boolean(row.is_primary_owner),
        },
        onboarding: {
          onboardingStatus: row.onboarding_status as 'IN_PROGRESS' | 'COMPLETED',
          currentStep: row.onboarding_current_step,
        },
        activeSessionBound: true,
        effectiveTenantPermissions: row.effective_permissions ?? [],
      };
    } catch (err: unknown) {
      this.mapRegistrationError(err);
    }
  }

  private async enforceSlugAvailabilityRateLimits(
    userId: string,
    ip: string | null,
    ua: string | null,
    correlationId: string,
  ): Promise<void> {
    try {
      // 1. Check if user is under active sustained lockout
      const lockoutTtl = await this.redis.getAuthKeyTtl('rl_slug_lock', userId);
      if (lockoutTtl > 0) {
        throw new HttpException(
          {
            code: 'RATE_LIMIT_EXCEEDED',
            message: `Too many slug availability requests. Account lockout active for ${lockoutTtl} seconds.`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // 2. Burst rate limit per userId: 15 req / 60s
      const userBurst = await this.redis.incrementAuthCounterWithTtl(
        'rl_slug_user_burst',
        userId,
        60,
      );
      if (userBurst.count > 15) {
        throw new HttpException(
          {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Burst rate limit exceeded for slug availability checks (max 15 req/60s).',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // 3. Burst rate limit per IP: 20 req / 60s
      const ipDigest = this.digestValue(ip || 'unknown-ip');
      const ipBurst = await this.redis.incrementAuthCounterWithTtl(
        'rl_slug_ip_burst',
        ipDigest,
        60,
      );
      if (ipBurst.count > 20) {
        throw new HttpException(
          {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Burst rate limit exceeded for slug availability checks from this IP (max 20 req/60s).',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // 4. Sustained rate limit per userId: 100 req / 3600s
      const userSustained = await this.redis.incrementAuthCounterWithTtl(
        'rl_slug_user_sustained',
        userId,
        3600,
      );
      if (userSustained.count > 100) {
        // Apply 15-minute (900s) lockout
        await this.redis.setAuthJson(
          'rl_slug_lock',
          userId,
          { lockedAt: Date.now(), reason: 'SUSTAINED_CAP_EXCEEDED' },
          900,
        );

        // Record AUTH_RATE_LIMIT_EXCEEDED audit log
        try {
          await this.auditService.record({
            eventType: 'AUTH_RATE_LIMIT_EXCEEDED',
            outcome: 'DENIED',
            actorUserId: userId,
            correlationId,
            ipAddress: ip,
            userAgent: ua,
            metadata: {
              endpoint: 'slug-availability',
              reason: 'SUSTAINED_CAP_EXCEEDED',
              count: userSustained.count,
              limit: 100,
              windowSeconds: 3600,
              lockoutSeconds: 900,
            },
          });
        } catch (auditErr) {
          this.logger.warn(`Failed to record rate limit audit event: ${String(auditErr)}`);
        }

        throw new HttpException(
          {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Sustained rate limit exceeded. Account is temporarily locked from slug checks for 15 minutes.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (err: unknown) {
      if (err instanceof HttpException) {
        throw err;
      }
      // Fails closed if Redis rate-limit backend is unreachable
      this.logger.error(`Redis rate-limit failure in slug-availability: ${String(err)}`);
      throw new HttpException(
        {
          code: 'SERVICE_TEMPORARILY_UNAVAILABLE',
          message: 'Rate-limiting service is temporarily unavailable. Please retry shortly.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private async enforceRegistrationRateLimits(
    userId: string,
    ip: string | null,
  ): Promise<void> {
    try {
      // 5 registrations per hour per user
      const userCount = await this.redis.incrementAuthCounterWithTtl(
        'rl_reg_user',
        userId,
        3600,
      );
      if (userCount.count > 5) {
        throw new HttpException(
          {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Registration rate limit exceeded (maximum 5 registrations per hour).',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // 5 registrations per hour per IP
      const ipDigest = this.digestValue(ip || 'unknown-ip');
      const ipCount = await this.redis.incrementAuthCounterWithTtl(
        'rl_reg_ip',
        ipDigest,
        3600,
      );
      if (ipCount.count > 5) {
        throw new HttpException(
          {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Registration rate limit exceeded for this IP address (maximum 5 registrations per hour).',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (err: unknown) {
      if (err instanceof HttpException) {
        throw err;
      }
      this.logger.warn(`Redis rate-limit check failed during registration: ${String(err)}`);
    }
  }

  private mapDatabaseSecurityError(err: unknown): never {
    if (err instanceof HttpException) {
      throw err;
    }
    const pgErr = err as { code?: string; message?: string };
    if (pgErr?.code === '42501') {
      const msg = pgErr.message || '';
      if (msg.includes('EMAIL_NOT_VERIFIED')) {
        throw new ForbiddenException({
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Email verification is required before checking slug availability.',
        });
      }
      if (msg.includes('USER_ACCOUNT_INACTIVE')) {
        throw new ForbiddenException({
          code: 'USER_ACCOUNT_INACTIVE',
          message: 'Active user account is required to check slug availability.',
        });
      }
      if (msg.includes('AUTHENTICATION_REQUIRED')) {
        throw new UnauthorizedException({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication is required.',
        });
      }
      if (msg.includes('TENANT_CONTEXT_FORBIDDEN')) {
        throw new ForbiddenException({
          code: 'TENANT_CONTEXT_FORBIDDEN',
          message: 'Slug availability check cannot execute inside an active tenant context.',
        });
      }
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Operation denied by security policy.',
      });
    }
    if (pgErr?.code === '22023') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: pgErr.message || 'Invalid parameters supplied.',
      });
    }
    throw err;
  }

  private mapRegistrationError(err: unknown): never {
    if (err instanceof HttpException) {
      throw err;
    }
    const pgErr = err as { code?: string; message?: string };
    if (pgErr?.code === '23505') {
      throw new ConflictException({
        code: 'TENANT_SLUG_UNAVAILABLE',
        message: 'The requested tenant slug is already registered or reserved.',
      });
    }
    if (pgErr?.code === '23514') {
      throw new UnprocessableEntityException({
        code: 'TENANT_CREATION_QUOTA_EXCEEDED',
        message: 'You have reached the maximum allowed limit of 5 owned organizations.',
      });
    }
    if (pgErr?.code === '42501') {
      const msg = pgErr.message || '';
      if (msg.includes('PLATFORM_ADMIN_CANNOT_OWN_TENANT')) {
        throw new ForbiddenException({
          code: 'PLATFORM_ADMIN_CANNOT_OWN_TENANT',
          message: 'Platform Super Admins cannot self-register customer tenant workspaces.',
        });
      }
      if (msg.includes('EMAIL_NOT_VERIFIED')) {
        throw new ForbiddenException({
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Email verification is required before registering an organization.',
        });
      }
      if (msg.includes('USER_ACCOUNT_INACTIVE')) {
        throw new ForbiddenException({
          code: 'USER_ACCOUNT_INACTIVE',
          message: 'User account must be ACTIVE to register an organization.',
        });
      }
      if (msg.includes('AUTHENTICATION_REQUIRED')) {
        throw new UnauthorizedException({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication is required.',
        });
      }
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: pgErr.message || 'Operation denied by database security policy.',
      });
    }
    if (pgErr?.code === '22023') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: pgErr.message || 'Invalid parameters supplied.',
      });
    }
    if (pgErr?.code === 'P0002') {
      throw new InternalServerErrorException({
        code: 'PERMISSION_CATALOG_MISMATCH',
        message: 'Permission catalog mismatch during organization provisioning.',
      });
    }
    throw err;
  }

  private digestValue(val: string): string {
    return createHash('sha256').update(val, 'utf8').digest('hex').slice(0, 24);
  }
}
