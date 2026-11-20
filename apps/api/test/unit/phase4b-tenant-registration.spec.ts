import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Response } from 'express';
import type { RedisService } from '../../src/cache/redis.service';
import type { RequestWithAuthSession } from '../../src/common/jwt-auth.guard';
import { loadAppConfig, type AppEnvConfig } from '../../src/config/env.config';
import type { QueryExecutor } from '../../src/database/database.types';
import type { TenantTransactionManager } from '../../src/database/tenant-transaction.manager';
import type { AuthAuditService } from '../../src/modules/auth/auth-audit.service';
import type { RedisSessionCacheService } from '../../src/modules/auth/session-cache.service';
import type { TokenService } from '../../src/modules/auth/token.service';
import { TenantRegistrationController } from '../../src/modules/tenant-registration/tenant-registration.controller';
import {
  CheckSlugAvailabilityQueryDto,
  RegisterTenantDto,
} from '../../src/modules/tenant-registration/tenant-registration.dto';
import type {
  ProvisionOrganizationRow,
  TenantRegistrationRepository,
} from '../../src/modules/tenant-registration/tenant-registration.repository';
import {
  TenantRegistrationService,
  type RegistrationSessionContext,
} from '../../src/modules/tenant-registration/tenant-registration.service';

const USER_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b91101';
const SESSION_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b91202';
const TENANT_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b91404';
const MEMBERSHIP_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b91505';
const CORRELATION_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b91606';

const baseConfig: AppEnvConfig = loadAppConfig({
  NODE_ENV: 'test',
  DATABASE_MIGRATOR_URL: 'postgresql://ft360_migrator:pw1@localhost:5434/ft360_dev',
  DATABASE_APP_URL: 'postgresql://ft360_app:pw2@localhost:5434/ft360_dev',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
  AUTH_JWT_SECRET: 'unit-test-jwt-secret-key-at-least-32-characters-long!!',
  TENANT_SELF_REGISTRATION_ENABLED: 'true',
});

describe('Phase 4 Stage 4B Unit Suite — Tenant Registration Backend', () => {
  describe('1. DTO Validation & Transformation', () => {
    describe('CheckSlugAvailabilityQueryDto', () => {
      it('accepts valid slugs (3-63 lowercase alphanumeric with hyphens)', async () => {
        const validSlugs = ['acme', 'acme-corp', 'my-org-123', 'a-b-c-d', 'a1b2c3d4'];
        for (const slug of validSlugs) {
          const dto = plainToInstance(CheckSlugAvailabilityQueryDto, { slug });
          const errors = await validate(dto);
          expect(errors).toHaveLength(0);
          expect(dto.slug).toBe(slug);
        }
      });

      it('normalizes untrimmed uppercase slugs via Transform', async () => {
        const dto = plainToInstance(CheckSlugAvailabilityQueryDto, { slug: '  ACME-CORP  ' });
        const errors = await validate(dto);
        expect(errors).toHaveLength(0);
        expect(dto.slug).toBe('acme-corp');
      });

      it('rejects malformed slugs (<3 chars, >63 chars, leading/trailing hyphens, invalid chars)', async () => {
        const invalidSlugs = [
          'ab', // < 3 chars
          'a'.repeat(64), // > 63 chars
          '-acme', // leading hyphen
          'acme-', // trailing hyphen
          'acme_corp', // underscore forbidden
          'acme.corp', // period forbidden
          'acme@corp', // special chars forbidden
          '', // empty
        ];

        for (const slug of invalidSlugs) {
          const dto = plainToInstance(CheckSlugAvailabilityQueryDto, { slug });
          const errors = await validate(dto);
          expect(errors.length).toBeGreaterThan(0);
        }
      });
    });

    describe('RegisterTenantDto', () => {
      const validPayload = {
        displayName: 'Acme Corporation',
        legalName: 'Acme Corporation LLC',
        slug: 'acme-corp',
        organizationType: 'COMPANY',
        industry: 'SAAS_TECHNOLOGY',
        countryCode: 'US',
        defaultTimezone: 'America/New_York',
        defaultCurrency: 'USD',
      };

      it('validates a complete, canonical registration payload', async () => {
        const dto = plainToInstance(RegisterTenantDto, validPayload);
        const errors = await validate(dto);
        expect(errors).toHaveLength(0);
      });

      it('transforms and trims string fields correctly', async () => {
        const dto = plainToInstance(RegisterTenantDto, {
          ...validPayload,
          displayName: '  Acme Corporation  ',
          legalName: '  Acme Corporation LLC  ',
          slug: '  ACME-CORP  ',
          organizationType: 'company',
          industry: 'saas_technology',
          countryCode: 'us',
          defaultCurrency: 'usd',
        });
        const errors = await validate(dto);
        expect(errors).toHaveLength(0);
        expect(dto.displayName).toBe('Acme Corporation');
        expect(dto.legalName).toBe('Acme Corporation LLC');
        expect(dto.slug).toBe('acme-corp');
        expect(dto.organizationType).toBe('COMPANY');
        expect(dto.industry).toBe('SAAS_TECHNOLOGY');
        expect(dto.countryCode).toBe('US');
        expect(dto.defaultCurrency).toBe('USD');
      });

      it('rejects invalid organization types', async () => {
        const dto = plainToInstance(RegisterTenantDto, {
          ...validPayload,
          organizationType: 'INVALID_TYPE',
        });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === 'organizationType')).toBe(true);
      });

      it('rejects invalid industries', async () => {
        const dto = plainToInstance(RegisterTenantDto, {
          ...validPayload,
          industry: 'INVALID_INDUSTRY',
        });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === 'industry')).toBe(true);
      });

      it('rejects invalid country codes', async () => {
        const dto = plainToInstance(RegisterTenantDto, {
          ...validPayload,
          countryCode: 'USA', // not ISO 3166-1 alpha-2
        });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === 'countryCode')).toBe(true);
      });

      it('rejects invalid IANA timezones', async () => {
        const dto = plainToInstance(RegisterTenantDto, {
          ...validPayload,
          defaultTimezone: 'Invalid/Timezone',
        });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === 'defaultTimezone')).toBe(true);
      });

      it('rejects invalid ISO-4217 currencies', async () => {
        const dto = plainToInstance(RegisterTenantDto, {
          ...validPayload,
          defaultCurrency: 'ZZZ', // invalid currency code
        });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === 'defaultCurrency')).toBe(true);
      });
    });
  });

  describe('2. TenantRegistrationService — checkSlugAvailability', () => {
    function setupService(overrides?: {
      config?: AppEnvConfig;
      available?: boolean;
      lockoutTtl?: number;
      userBurstCount?: number;
      ipBurstCount?: number;
      userSustainedCount?: number;
      redisError?: Error;
    }) {
      const mockTx = {} as QueryExecutor;
      const repo = {
        checkSlugAvailable: jest
          .fn()
          .mockResolvedValue(overrides?.available !== undefined ? overrides.available : true),
        provisionOrganization: jest.fn(),
      } as unknown as TenantRegistrationRepository;

      const txManager = {
        withAuthenticatedUserTransaction: jest
          .fn()
          .mockImplementation(async (_uid: string, work: (tx: QueryExecutor) => Promise<unknown>) => {
            return work(mockTx);
          }),
      } as unknown as TenantTransactionManager;

      const redis = {
        getAuthKeyTtl: jest.fn().mockImplementation(async () => {
          if (overrides?.redisError) throw overrides.redisError;
          return overrides?.lockoutTtl ?? 0;
        }),
        incrementAuthCounterWithTtl: jest.fn().mockImplementation(async (ns: string) => {
          if (overrides?.redisError) throw overrides.redisError;
          if (ns === 'rl_slug_user_burst') {
            return { count: overrides?.userBurstCount ?? 1, ttlSeconds: 60 };
          }
          if (ns === 'rl_slug_ip_burst') {
            return { count: overrides?.ipBurstCount ?? 1, ttlSeconds: 60 };
          }
          if (ns === 'rl_slug_user_sustained') {
            return { count: overrides?.userSustainedCount ?? 1, ttlSeconds: 3600 };
          }
          return { count: 1, ttlSeconds: 60 };
        }),
        setAuthJson: jest.fn().mockResolvedValue(undefined),
      } as unknown as RedisService;

      const sessionCache = {
        evictSessionCache: jest.fn().mockResolvedValue(undefined),
      } as unknown as RedisSessionCacheService;

      const tokenService = {
        signAccessToken: jest.fn().mockReturnValue('mock-jwt-token'),
        setSessionCookies: jest.fn(),
      } as unknown as TokenService;

      const auditService = {
        record: jest.fn().mockResolvedValue(undefined),
      } as unknown as AuthAuditService;

      const config = overrides?.config ?? baseConfig;

      const service = new TenantRegistrationService(
        repo,
        txManager,
        redis,
        sessionCache,
        tokenService,
        auditService,
        config,
      );

      return { service, repo, txManager, redis, auditService };
    }

    it('returns { slug, available: true } when repository indicates availability', async () => {
      const { service, repo, txManager } = setupService({ available: true });
      const result = await service.checkSlugAvailability(
        USER_ID,
        '192.168.1.1',
        'Mozilla/5.0',
        CORRELATION_ID,
        { slug: 'acme-corp' },
      );

      expect(result).toEqual({ slug: 'acme-corp', available: true });
      expect(txManager.withAuthenticatedUserTransaction).toHaveBeenCalledWith(
        USER_ID,
        expect.any(Function),
      );
      expect(repo.checkSlugAvailable).toHaveBeenCalledWith(expect.anything(), 'acme-corp');
    });

    it('returns { slug, available: false } when slug is already occupied or reserved', async () => {
      const { service } = setupService({ available: false });
      const result = await service.checkSlugAvailability(
        USER_ID,
        '192.168.1.1',
        'Mozilla/5.0',
        CORRELATION_ID,
        { slug: 'admin' },
      );

      expect(result).toEqual({ slug: 'admin', available: false });
    });

    it('enforces 15 req/60s burst limit per userId (429)', async () => {
      const { service } = setupService({ userBurstCount: 16 });

      await expect(
        service.checkSlugAvailability(
          USER_ID,
          '192.168.1.1',
          'Mozilla/5.0',
          CORRELATION_ID,
          { slug: 'acme-corp' },
        ),
      ).rejects.toThrow(HttpException);
    });

    it('enforces 20 req/60s burst limit per IP (429)', async () => {
      const { service } = setupService({ userBurstCount: 5, ipBurstCount: 21 });

      await expect(
        service.checkSlugAvailability(
          USER_ID,
          '192.168.1.1',
          'Mozilla/5.0',
          CORRELATION_ID,
          { slug: 'acme-corp' },
        ),
      ).rejects.toThrow(HttpException);
    });

    it('enforces 100 req/hr sustained limit with 15-minute lockout and audit log (429)', async () => {
      const { service, redis, auditService } = setupService({
        userBurstCount: 1,
        ipBurstCount: 1,
        userSustainedCount: 101,
      });

      await expect(
        service.checkSlugAvailability(
          USER_ID,
          '192.168.1.1',
          'Mozilla/5.0',
          CORRELATION_ID,
          { slug: 'acme-corp' },
        ),
      ).rejects.toThrow(HttpException);

      expect(redis.setAuthJson).toHaveBeenCalledWith(
        'rl_slug_lock',
        USER_ID,
        expect.objectContaining({ reason: 'SUSTAINED_CAP_EXCEEDED' }),
        900,
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'AUTH_RATE_LIMIT_EXCEEDED',
          outcome: 'DENIED',
          actorUserId: USER_ID,
        }),
      );
    });

    it('fails closed (503 SERVICE_TEMPORARILY_UNAVAILABLE) if Redis is offline', async () => {
      const { service } = setupService({
        redisError: new Error('Connection lost to Redis at localhost:6379'),
      });

      try {
        await service.checkSlugAvailability(
          USER_ID,
          '192.168.1.1',
          'Mozilla/5.0',
          CORRELATION_ID,
          { slug: 'acme-corp' },
        );
        fail('Expected 503 error to be thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpException);
        const httpErr = err as HttpException;
        expect(httpErr.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        expect(httpErr.getResponse()).toEqual(
          expect.objectContaining({ code: 'SERVICE_TEMPORARILY_UNAVAILABLE' }),
        );
      }
    });

    it('maps database security exceptions (EMAIL_NOT_VERIFIED -> 403, USER_ACCOUNT_INACTIVE -> 403)', async () => {
      const { service, txManager } = setupService();

      (txManager.withAuthenticatedUserTransaction as jest.Mock).mockRejectedValueOnce({
        code: '42501',
        message: 'EMAIL_NOT_VERIFIED: email address must be verified',
      });

      await expect(
        service.checkSlugAvailability(
          USER_ID,
          '192.168.1.1',
          'Mozilla/5.0',
          CORRELATION_ID,
          { slug: 'acme-corp' },
        ),
      ).rejects.toThrow(ForbiddenException);

      (txManager.withAuthenticatedUserTransaction as jest.Mock).mockRejectedValueOnce({
        code: '42501',
        message: 'USER_ACCOUNT_INACTIVE: active account required',
      });

      await expect(
        service.checkSlugAvailability(
          USER_ID,
          '192.168.1.1',
          'Mozilla/5.0',
          CORRELATION_ID,
          { slug: 'acme-corp' },
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('3. TenantRegistrationService — registerTenant', () => {
    const mockProvisionRow: ProvisionOrganizationRow = {
      tenant_id: TENANT_ID,
      tenant_slug: 'acme-corp',
      legal_name: 'Acme Corporation LLC',
      display_name: 'Acme Corporation',
      tenant_status: 'TRIAL',
      default_timezone: 'America/New_York',
      default_currency: 'USD',
      created_by_user_id: USER_ID,
      tenant_created_at: new Date('2026-11-20T12:00:00Z'),
      tenant_updated_at: new Date('2026-11-20T12:00:00Z'),
      membership_id: MEMBERSHIP_ID,
      membership_type: 'INTERNAL',
      membership_status: 'ACTIVE',
      is_primary_owner: true,
      admin_role_id: '0195f3a2-7c40-7b12-9a10-4e8d21b92001',
      member_role_id: '0195f3a2-7c40-7b12-9a10-4e8d21b92002',
      onboarding_status: 'IN_PROGRESS',
      onboarding_current_step: 'ORG_PROFILE',
      onboarding_version: 1,
      bound_session_id: SESSION_ID,
      tenant_audit_log_id: '0195f3a2-7c40-7b12-9a10-4e8d21b93001',
      auth_audit_log_id: '0195f3a2-7c40-7b12-9a10-4e8d21b93002',
      effective_permissions: [
        'audit:auth:read',
        'audit:tenant:read',
        'auth:sessions:manage',
        'rbac:roles:manage',
        'rbac:roles:read',
        'tenant:admins:manage',
        'tenant:admins:read',
        'tenant:branding:manage',
        'tenant:branding:read',
        'tenant:invitations:manage',
        'tenant:invitations:read',
        'tenant:members:manage',
        'tenant:members:read',
        'tenant:organization:manage',
        'tenant:organization:read',
        'tenant:roles:assign',
        'tenant:settings:manage',
        'tenant:settings:read',
      ],
    };

    function setupService(overrides?: {
      config?: AppEnvConfig;
      provisionRow?: ProvisionOrganizationRow;
      provisionError?: unknown;
      userRegCount?: number;
      ipRegCount?: number;
    }) {
      const mockTx = {} as QueryExecutor;
      const repo = {
        checkSlugAvailable: jest.fn(),
        provisionOrganization: jest.fn().mockImplementation(async () => {
          if (overrides?.provisionError) throw overrides.provisionError;
          return overrides?.provisionRow ?? mockProvisionRow;
        }),
      } as unknown as TenantRegistrationRepository;

      const txManager = {
        withAuthenticatedUserTransaction: jest
          .fn()
          .mockImplementation(async (_uid: string, work: (tx: QueryExecutor) => Promise<unknown>) => {
            return work(mockTx);
          }),
      } as unknown as TenantTransactionManager;

      const redis = {
        incrementAuthCounterWithTtl: jest.fn().mockImplementation(async () => {
          return {
            count: overrides?.userRegCount ?? 1,
            ttlSeconds: 3600,
          };
        }),
      } as unknown as RedisService;

      const sessionCache = {
        evictSessionCache: jest.fn().mockResolvedValue(undefined),
      } as unknown as RedisSessionCacheService;

      const tokenService = {
        signAccessToken: jest.fn().mockReturnValue('new-access-token-with-active-tenant'),
        setSessionCookies: jest.fn(),
      } as unknown as TokenService;

      const auditService = {
        record: jest.fn().mockResolvedValue(undefined),
      } as unknown as AuthAuditService;

      const config = overrides?.config ?? baseConfig;

      const service = new TenantRegistrationService(
        repo,
        txManager,
        redis,
        sessionCache,
        tokenService,
        auditService,
        config,
      );

      return { service, repo, txManager, sessionCache, tokenService };
    }

    const validDto: RegisterTenantDto = {
      displayName: 'Acme Corporation',
      legalName: 'Acme Corporation LLC',
      slug: 'acme-corp',
      organizationType: 'COMPANY',
      industry: 'SAAS_TECHNOLOGY',
      countryCode: 'US',
      defaultTimezone: 'America/New_York',
      defaultCurrency: 'USD',
    };

    const sessionCtx: RegistrationSessionContext = {
      userId: USER_ID,
      sessionId: SESSION_ID,
      isPlatformSuperAdmin: false,
    };

    const mockRes = {} as Response;

    it('provisions organization, binds session, evicts Redis session cache, and updates cookies', async () => {
      const { service, repo, txManager, sessionCache, tokenService } = setupService();

      const response = await service.registerTenant(
        sessionCtx,
        '192.168.1.1',
        'Mozilla/5.0',
        CORRELATION_ID,
        validDto,
        mockRes,
      );

      expect(txManager.withAuthenticatedUserTransaction).toHaveBeenCalledWith(
        USER_ID,
        expect.any(Function),
      );
      expect(repo.provisionOrganization).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          actorUserId: USER_ID,
          sessionId: SESSION_ID,
          slug: 'acme-corp',
          displayName: 'Acme Corporation',
          legalName: 'Acme Corporation LLC',
        }),
      );

      expect(sessionCache.evictSessionCache).toHaveBeenCalledWith(SESSION_ID);
      expect(tokenService.signAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          sessionId: SESSION_ID,
          activeTenantId: TENANT_ID,
          activeMembershipId: MEMBERSHIP_ID,
          isPlatformSuperAdmin: false,
        }),
      );
      expect(tokenService.setSessionCookies).toHaveBeenCalledWith(mockRes, {
        accessToken: 'new-access-token-with-active-tenant',
      });

      expect(response).toEqual({
        tenant: expect.objectContaining({
          id: TENANT_ID,
          slug: 'acme-corp',
          displayName: 'Acme Corporation',
          status: 'TRIAL',
        }),
        membership: expect.objectContaining({
          id: MEMBERSHIP_ID,
          membershipType: 'INTERNAL',
          status: 'ACTIVE',
          isPrimaryOwner: true,
        }),
        onboarding: {
          onboardingStatus: 'IN_PROGRESS',
          currentStep: 'ORG_PROFILE',
        },
        activeSessionBound: true,
        effectiveTenantPermissions: expect.arrayContaining([
          'tenant:organization:manage',
          'tenant:organization:read',
          'tenant:settings:manage',
          'tenant:settings:read',
        ]),
      });
    });

    it('rejects registration when TENANT_SELF_REGISTRATION_ENABLED is false (403)', async () => {
      const disabledConfig: AppEnvConfig = {
        ...baseConfig,
        tenantSelfRegistrationEnabled: false,
      };
      const { service } = setupService({ config: disabledConfig });

      await expect(
        service.registerTenant(
          sessionCtx,
          '192.168.1.1',
          'Mozilla/5.0',
          CORRELATION_ID,
          validDto,
          mockRes,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects registration by Platform Super Admin (403 PLATFORM_ADMIN_CANNOT_OWN_TENANT)', async () => {
      const { service } = setupService();

      await expect(
        service.registerTenant(
          { ...sessionCtx, isPlatformSuperAdmin: true },
          '192.168.1.1',
          'Mozilla/5.0',
          CORRELATION_ID,
          validDto,
          mockRes,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('maps SQLSTATE 23505 to ConflictException (409 TENANT_SLUG_UNAVAILABLE)', async () => {
      const { service } = setupService({
        provisionError: {
          code: '23505',
          message: 'TENANT_SLUG_UNAVAILABLE: requested slug is unavailable',
        },
      });

      await expect(
        service.registerTenant(
          sessionCtx,
          '192.168.1.1',
          'Mozilla/5.0',
          CORRELATION_ID,
          validDto,
          mockRes,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('maps SQLSTATE 23514 to UnprocessableEntityException (422 TENANT_CREATION_QUOTA_EXCEEDED)', async () => {
      const { service } = setupService({
        provisionError: {
          code: '23514',
          message: 'TENANT_CREATION_QUOTA_EXCEEDED: user has reached the maximum of 5 owned organizations',
        },
      });

      await expect(
        service.registerTenant(
          sessionCtx,
          '192.168.1.1',
          'Mozilla/5.0',
          CORRELATION_ID,
          validDto,
          mockRes,
        ),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('maps SQLSTATE 42501 (EMAIL_NOT_VERIFIED) to ForbiddenException (403)', async () => {
      const { service } = setupService({
        provisionError: {
          code: '42501',
          message: 'EMAIL_NOT_VERIFIED: email verification is required before registering an organization',
        },
      });

      await expect(
        service.registerTenant(
          sessionCtx,
          '192.168.1.1',
          'Mozilla/5.0',
          CORRELATION_ID,
          validDto,
          mockRes,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('4. TenantRegistrationController', () => {
    const mockService = {
      checkSlugAvailability: jest.fn().mockResolvedValue({ slug: 'acme-corp', available: true }),
      registerTenant: jest.fn().mockResolvedValue({
        tenant: { id: TENANT_ID, slug: 'acme-corp' },
        activeSessionBound: true,
      }),
    } as unknown as TenantRegistrationService;

    const controller = new TenantRegistrationController(mockService);

    it('delegates checkSlugAvailability with authenticated session and client metadata', async () => {
      const req = {
        authSession: { userId: USER_ID, sessionId: SESSION_ID, isPlatformSuperAdmin: false },
        ip: '203.0.113.195',
        headers: { 'x-forwarded-for': '203.0.113.195', 'user-agent': 'JestTestRunner' },
        correlationId: CORRELATION_ID,
      } as unknown as RequestWithAuthSession;

      const result = await controller.checkSlugAvailability({ slug: 'acme-corp' }, req);
      expect(result).toEqual({ slug: 'acme-corp', available: true });
      expect(mockService.checkSlugAvailability).toHaveBeenCalledWith(
        USER_ID,
        '203.0.113.195',
        'JestTestRunner',
        CORRELATION_ID,
        { slug: 'acme-corp' },
      );
    });

    it('rejects unauthenticated requests in checkSlugAvailability (401)', async () => {
      const req = { authSession: null } as unknown as RequestWithAuthSession;

      await expect(
        controller.checkSlugAvailability({ slug: 'acme-corp' }, req),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('delegates registerTenant with authenticated session and response context', async () => {
      const req = {
        authSession: {
          userId: USER_ID,
          sessionId: SESSION_ID,
          isPlatformSuperAdmin: false,
          activeTenantId: null,
          activeMembershipId: null,
        },
        ip: '203.0.113.195',
        headers: { 'x-forwarded-for': '203.0.113.195', 'user-agent': 'JestTestRunner' },
        correlationId: CORRELATION_ID,
      } as unknown as RequestWithAuthSession;
      const res = {} as Response;
      const dto: RegisterTenantDto = {
        displayName: 'Acme Corporation',
        legalName: 'Acme Corporation LLC',
        slug: 'acme-corp',
        organizationType: 'COMPANY',
        industry: 'SAAS_TECHNOLOGY',
        countryCode: 'US',
        defaultTimezone: 'America/New_York',
        defaultCurrency: 'USD',
      };

      const result = await controller.registerTenant(dto, req, res);
      expect(result).toHaveProperty('activeSessionBound', true);
      expect(mockService.registerTenant).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_ID, sessionId: SESSION_ID }),
        '203.0.113.195',
        'JestTestRunner',
        CORRELATION_ID,
        dto,
        res,
      );
    });

    it('rejects unauthenticated requests in registerTenant (401)', async () => {
      const req = { authSession: null } as unknown as RequestWithAuthSession;
      const res = {} as Response;

      await expect(
        controller.registerTenant({} as RegisterTenantDto, req, res),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('Feature Toggle & Production Security Defaults', () => {
    const dummyDbEnv = {
      DATABASE_MIGRATOR_URL: 'postgresql://ft360_migrator:pw1@localhost:5434/ft360_dev',
      DATABASE_APP_URL: 'postgresql://ft360_app:pw2@localhost:5434/ft360_dev',
    };

    it('defaults tenantSelfRegistrationEnabled to false in production when unspecified', () => {
      const prodConfig = loadAppConfig({
        ...dummyDbEnv,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        AUTH_JWT_SECRET: 'a'.repeat(32),
      });
      expect(prodConfig.tenantSelfRegistrationEnabled).toBe(false);
    });

    it('defaults tenantSelfRegistrationEnabled to true in development when unspecified', () => {
      const devConfig = loadAppConfig({
        ...dummyDbEnv,
        NODE_ENV: 'development',
      });
      expect(devConfig.tenantSelfRegistrationEnabled).toBe(true);
    });

    it('honors explicit TENANT_SELF_REGISTRATION_ENABLED=true in production', () => {
      const prodConfig = loadAppConfig({
        ...dummyDbEnv,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        AUTH_JWT_SECRET: 'a'.repeat(32),
        TENANT_SELF_REGISTRATION_ENABLED: 'true',
      });
      expect(prodConfig.tenantSelfRegistrationEnabled).toBe(true);
    });

    it('honors explicit TENANT_SELF_REGISTRATION_ENABLED=false in development', () => {
      const devConfig = loadAppConfig({
        ...dummyDbEnv,
        NODE_ENV: 'development',
        TENANT_SELF_REGISTRATION_ENABLED: 'false',
      });
      expect(devConfig.tenantSelfRegistrationEnabled).toBe(false);
    });
  });
});

