import {
  BadRequestException,
  ForbiddenException,
  Logger,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { RedisService } from '../../src/cache/redis.service';
import { JwtAuthGuard, type RequestWithAuthSession } from '../../src/common/jwt-auth.guard';
import { TenantAdminGuard } from '../../src/common/tenant-admin.guard';
import { TenantPermissionGuard } from '../../src/common/tenant-permission.guard';
import { loadAppConfig, type AppEnvConfig } from '../../src/config/env.config';
import { InvalidTenantContextError, type QueryExecutor } from '../../src/database/database.types';
import type { TenantTransactionManager } from '../../src/database/tenant-transaction.manager';
import type { AuthAuditService } from '../../src/modules/auth/auth-audit.service';
import { redactMailLogText } from '../../src/modules/auth/auth-mail-outbox.service';
import type { AuthRepository } from '../../src/modules/auth/auth.repository';
import { RedisSessionCacheService } from '../../src/modules/auth/session-cache.service';
import { TokenService } from '../../src/modules/auth/token.service';
import type { RbacRepository } from '../../src/modules/foundation-db/rbac.repository';
import {
  decodeTenantAuditCursor,
  encodeTenantAuditCursor,
  type TenantAuditRepository,
} from '../../src/modules/tenant-audit/tenant-audit.repository';
import { TenantAuditService } from '../../src/modules/tenant-audit/tenant-audit.service';

const USER_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b91101';
const SESSION_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b91202';
const FAMILY_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b91303';
const TENANT_A = '0195f3a2-7c40-7b12-9a10-4e8d21b91404';
const MEMBER_A = '0195f3a2-7c40-7b12-9a10-4e8d21b91505';
const CORR_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b91606';

const testConfig: AppEnvConfig = loadAppConfig({
  NODE_ENV: 'test',
  DATABASE_MIGRATOR_URL: 'postgresql://ft360_migrator:pw1@localhost:5434/ft360_dev',
  DATABASE_APP_URL: 'postgresql://ft360_app:pw2@localhost:5434/ft360_dev',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3000,http://127.0.0.1:3000',
  AUTH_JWT_SECRET: 'unit-test-jwt-secret-key-at-least-32-characters-long!!',
});

function buildHttpContext(
  req: Partial<RequestWithAuthSession>,
  resHeaders: Record<string, string | string[]> = {},
): { ctx: ExecutionContext; res: Response } {
  const res = {
    getHeader: (k: string) => resHeaders[k],
    setHeader: (k: string, v: string | string[]) => {
      resHeaders[k] = v;
    },
  } as unknown as Response;

  const fullReq: RequestWithAuthSession = {
    method: 'GET',
    headers: {},
    url: '/api/v1/workspace/audit-logs',
    originalUrl: '/api/v1/workspace/audit-logs',
    correlationId: CORR_ID,
    ...req,
  } as RequestWithAuthSession;

  const ctx = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => fullReq,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;

  return { ctx, res };
}

describe('Phase 4 Stage 4A Unit Suite (UT-P4-05, UT-P4-07, UT-P4-08)', () => {
  describe('UT-P4-05: TenantAuditService Diff Builder, Recursive Secret-Key Rejection & Cursor Validation', () => {
    const mockTx = {} as QueryExecutor;

    function createService() {
      const repo = {
        insertAuditLog: jest.fn().mockResolvedValue('0195f3a2-7c40-7b12-9a10-4e8d21b9aaaa'),
        listAuditLogs: jest.fn(),
      } as unknown as TenantAuditRepository;
      const txManager = {
        withVerifiedMemberTransaction: jest.fn(),
        withPlatformAdminTransaction: jest.fn(),
      } as unknown as TenantTransactionManager;
      return { service: new TenantAuditService(repo, txManager), repo };
    }

    it('computes minimal field-level diffs and omits unchanged properties', () => {
      const { service } = createService();

      const diff = service.computeFieldDiff(
        {
          displayName: 'Acme Old',
          defaultCurrency: 'USD',
          timezone: 'UTC',
          allowMemberDirectoryView: false,
        },
        {
          displayName: 'Acme Cloud',
          defaultCurrency: 'INR',
          timezone: 'UTC',
          allowMemberDirectoryView: false,
        },
      );

      expect(diff).toEqual({
        beforeState: {
          defaultCurrency: 'USD',
          displayName: 'Acme Old',
        },
        afterState: {
          defaultCurrency: 'INR',
          displayName: 'Acme Cloud',
        },
        changedFields: ['defaultCurrency', 'displayName'],
      });

      const noChange = service.computeFieldDiff({ timezone: 'UTC' }, { timezone: 'UTC' });
      expect(noChange).toEqual({
        beforeState: null,
        afterState: null,
        changedFields: [],
      });
    });

    it('recursively rejects forbidden secret keys in beforeState, afterState, and metadata across nested objects and arrays', async () => {
      const { service, repo } = createService();
      const validCtx = {
        tenantId: TENANT_A,
        actorUserId: USER_ID,
        membershipId: MEMBER_A,
        correlationId: CORR_ID,
      };

      const secretPayloads = [
        { beforeState: { password_hash: 'leaked' } },
        { afterState: { nested: { refreshToken: 'rt_123' } } },
        { metadata: { items: [{ ok: 1 }, { deep: { encrypted_action_token: 'v1:x' } }] } },
        { metadata: { headers: { Authorization: 'Bearer xyz' } } },
        { metadata: { invite: { action_url: 'https://app.example/invitations/accept?token=abc' } } },
      ];

      for (const bad of secretPayloads) {
        await expect(
          service.recordTenantEvent(mockTx, validCtx, {
            eventType: 'TENANT_SETTINGS_UPDATED',
            resourceType: 'SETTINGS',
            ...bad,
          }),
        ).rejects.toThrow(BadRequestException);
      }

      expect(repo.insertAuditLog).not.toHaveBeenCalled();
    });

    it('enforces valid tenant context, correlationId, and plane separation in recordTenantEvent & recordPlatformTenantEvent', async () => {
      const { service, repo } = createService();

      await expect(
        service.recordTenantEvent(
          mockTx,
          { tenantId: 'bad', actorUserId: USER_ID, correlationId: CORR_ID },
          { eventType: 'TENANT_SETTINGS_UPDATED', resourceType: 'SETTINGS' },
        ),
      ).rejects.toThrow(InvalidTenantContextError);

      await expect(
        service.recordTenantEvent(
          mockTx,
          { tenantId: TENANT_A, actorUserId: USER_ID, membershipId: MEMBER_A, correlationId: 'not-a-uuid' },
          { eventType: 'TENANT_SETTINGS_UPDATED', resourceType: 'SETTINGS' },
        ),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.recordTenantEvent(
          mockTx,
          { tenantId: TENANT_A, actorUserId: USER_ID, membershipId: MEMBER_A, correlationId: CORR_ID },
          { eventType: 'PLATFORM_TENANT_STATUS_CHANGED', resourceType: 'TENANT' },
        ),
      ).rejects.toThrow(ForbiddenException);

      const id = await service.recordTenantEvent(
        mockTx,
        { tenantId: TENANT_A, actorUserId: USER_ID, membershipId: MEMBER_A, correlationId: CORR_ID },
        {
          eventType: 'TENANT_SETTINGS_UPDATED',
          resourceType: 'SETTINGS',
          resourceId: TENANT_A,
          beforeState: { timezone: 'UTC' },
          afterState: { timezone: 'Asia/Kolkata' },
          metadata: { version: 2 },
        },
      );
      expect(id).toBe('0195f3a2-7c40-7b12-9a10-4e8d21b9aaaa');
      expect(repo.insertAuditLog).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          tenantId: TENANT_A,
          actorPlane: 'TENANT',
          actorUserId: USER_ID,
          actorMembershipId: MEMBER_A,
          correlationId: CORR_ID,
        }),
      );
    });

    it('encodes and validates keyset pagination cursors and scrubs invitation action URLs in mail logs', () => {
      const iso = '2026-11-16T15:00:00.000Z';
      const cursor = encodeTenantAuditCursor(iso, USER_ID);
      expect(decodeTenantAuditCursor(cursor)).toEqual({
        createdAtIso: iso,
        id: USER_ID,
      });

      expect(() => decodeTenantAuditCursor('tampered-cursor')).toThrow(BadRequestException);
      expect(() =>
        decodeTenantAuditCursor(
          Buffer.from(JSON.stringify({ c: iso, id: 'not-a-uuid' })).toString('base64url'),
        ),
      ).toThrow(BadRequestException);

      const scrubbed = redactMailLogText(
        'Failed dispatching https://app.ft360.local/invitations/accept?token=ft360_inv_secret123456 to user',
        'ft360_inv_secret123456',
      );
      expect(scrubbed).not.toContain('ft360_inv_secret123456');
      expect(scrubbed).not.toContain('/invitations/accept');
    });
  });

  describe('UT-P4-07: TenantPermissionGuard & TenantAdminGuard Phase 4 Permissions', () => {
    it('TenantPermissionGuard enforces explicit @RequirePermissions and logs AUTH_TENANT_PERMISSION_DENIED on 403', async () => {
      const auditRecord = jest.fn().mockResolvedValue('audit-id');
      const auditService = { record: auditRecord } as unknown as AuthAuditService;
      const rbacRepo = {
        listEffectivePermissionsForMembership: jest
          .fn()
          .mockResolvedValue([{ code: 'tenant:organization:read' }]),
      } as unknown as RbacRepository;
      const txManager = {
        withVerifiedMemberTransaction: jest
          .fn()
          .mockImplementation((_ctx, cb) => cb({} as QueryExecutor, MEMBER_A)),
      } as unknown as TenantTransactionManager;

      // 1. Missing @RequirePermissions metadata fails closed (403)
      const emptyReflector = {
        getAllAndOverride: jest.fn().mockReturnValue(undefined),
      } as unknown as Reflector;
      const guardNoMeta = new TenantPermissionGuard(emptyReflector, txManager, rbacRepo, auditService);
      await expect(
        guardNoMeta.canActivate(
          buildHttpContext({
            tenantContext: {
              tenantId: TENANT_A,
              actorUserId: USER_ID,
              membershipId: MEMBER_A,
              correlationId: CORR_ID,
            },
          }).ctx,
        ),
      ).rejects.toThrow(ForbiddenException);

      // 2. Missing required permission logs AUTH_TENANT_PERMISSION_DENIED and throws 403
      const reqReflector = {
        getAllAndOverride: jest.fn().mockReturnValue(['tenant:settings:read']),
      } as unknown as Reflector;
      const guard = new TenantPermissionGuard(reqReflector, txManager, rbacRepo, auditService);
      await expect(
        guard.canActivate(
          buildHttpContext({
            authSession: { userId: USER_ID, sessionId: SESSION_ID },
            tenantContext: {
              tenantId: TENANT_A,
              actorUserId: USER_ID,
              membershipId: MEMBER_A,
              correlationId: CORR_ID,
            },
          }).ctx,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(auditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'AUTH_TENANT_PERMISSION_DENIED',
          outcome: 'DENIED',
          tenantId: TENANT_A,
        }),
      );

      // 3. Holding required permission allows request
      const allowReflector = {
        getAllAndOverride: jest.fn().mockReturnValue(['tenant:organization:read']),
      } as unknown as Reflector;
      const allowGuard = new TenantPermissionGuard(allowReflector, txManager, rbacRepo, auditService);
      await expect(
        allowGuard.canActivate(
          buildHttpContext({
            tenantContext: {
              tenantId: TENANT_A,
              actorUserId: USER_ID,
              membershipId: MEMBER_A,
              correlationId: CORR_ID,
            },
          }).ctx,
        ),
      ).resolves.toBe(true);
    });

    it('TenantAdminGuard recognizes new Phase 4 canonical permissions (e.g. audit:tenant:read)', async () => {
      const reflector = {
        getAllAndOverride: jest.fn().mockReturnValue(['audit:tenant:read']),
      } as unknown as Reflector;
      const rbacRepo = {
        listEffectivePermissionsForMembership: jest
          .fn()
          .mockResolvedValue([{ code: 'audit:tenant:read' }]),
      } as unknown as RbacRepository;
      const txManager = {
        withVerifiedMemberTransaction: jest
          .fn()
          .mockImplementation((_ctx, cb) => cb({} as QueryExecutor, MEMBER_A)),
      } as unknown as TenantTransactionManager;
      const auditService = { record: jest.fn() } as unknown as AuthAuditService;

      const adminGuard = new TenantAdminGuard(reflector, txManager, rbacRepo, auditService);
      await expect(
        adminGuard.canActivate(
          buildHttpContext({
            tenantContext: {
              tenantId: TENANT_A,
              actorUserId: USER_ID,
              membershipId: MEMBER_A,
              correlationId: CORR_ID,
            },
          }).ctx,
        ),
      ).resolves.toBe(true);
    });
  });

  describe('UT-P4-08: RedisSessionCacheService Outage Resilience & JwtAuthGuard PostgreSQL Fallback', () => {
    it('catches Redis connection failures without throwing 500 and delegates session validation to PostgreSQL', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const offlineRedis = {
          setAuthJson: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
          getAuthJson: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
          deleteAuthKeys: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
        } as unknown as RedisService;

        const cache = new RedisSessionCacheService(offlineRedis, testConfig);

        await expect(cache.isSessionTombstoned(SESSION_ID)).resolves.toBe(false);
        await expect(cache.getCachedSession(SESSION_ID)).resolves.toBeNull();
        await expect(
          cache.cacheActiveSession({
            sessionId: SESSION_ID,
            familyId: FAMILY_ID,
            userId: USER_ID,
            activeTenantId: TENANT_A,
            activeMembershipId: MEMBER_A,
            isPlatformSuperAdmin: false,
            idleExpiresAtEpochMs: Date.now() + 60_000,
            expiresAtEpochMs: Date.now() + 300_000,
          }),
        ).resolves.toBeUndefined();
        await expect(cache.tombstoneSessions([SESSION_ID], 'TEST')).resolves.toBeUndefined();
        await expect(cache.evictSessionCache(SESSION_ID)).resolves.toBeUndefined();

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[REDIS_UNAVAILABLE_FALLBACK_PG]'),
        );

        // Verify JwtAuthGuard still rejects DB-revoked sessions even when Redis is completely down!
        const tokenService = new TokenService(testConfig);
        const jwt = tokenService.signAccessToken({
          userId: USER_ID,
          sessionId: SESSION_ID,
          activeTenantId: TENANT_A,
          activeMembershipId: MEMBER_A,
          isPlatformSuperAdmin: false,
        });

        const reflector = {
          getAllAndOverride: jest.fn().mockReturnValue(false),
        } as unknown as Reflector;
        const authRepo = {
          validateSessionInDb: jest.fn().mockResolvedValueOnce({
            sessionId: SESSION_ID,
            familyId: FAMILY_ID,
            userId: USER_ID,
            activeTenantId: null,
            activeMembershipId: null,
            idleExpiresAtEpochMs: Date.now() + 60_000,
            expiresAtEpochMs: Date.now() + 300_000,
            revokedAt: new Date().toISOString(),
            userStatus: 'ACTIVE',
            userEmailVerified: true,
            isPlatformSuperAdmin: false,
            csrfValid: false,
          }),
        } as unknown as AuthRepository;

        const jwtGuard = new JwtAuthGuard(reflector, tokenService, cache, authRepo);
        await expect(
          jwtGuard.canActivate(
            buildHttpContext({
              headers: { authorization: `Bearer ${jwt}` },
            }).ctx,
          ),
        ).rejects.toThrow(UnauthorizedException);
        expect(authRepo.validateSessionInDb).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
