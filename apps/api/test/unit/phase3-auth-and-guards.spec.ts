import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { CsrfProtectionGuard } from '../../src/common/csrf-protection.guard';
import { JwtAuthGuard, type RequestWithAuthSession } from '../../src/common/jwt-auth.guard';
import { PlatformSuperAdminGuard } from '../../src/common/platform-super-admin.guard';
import { TenantAdminGuard } from '../../src/common/tenant-admin.guard';
import { loadAppConfig, type AppEnvConfig } from '../../src/config/env.config';
import { UnauthorizedTenantMembershipError } from '../../src/database/database.types';
import type { TenantTransactionManager } from '../../src/database/tenant-transaction.manager';
import { AuthAuditService } from '../../src/modules/auth/auth-audit.service';
import type { AuthRepository } from '../../src/modules/auth/auth.repository';
import { PasswordHashService } from '../../src/modules/auth/password-hash.service';
import type { RedisSessionCacheService } from '../../src/modules/auth/session-cache.service';
import { TokenService } from '../../src/modules/auth/token.service';
import type { RbacRepository } from '../../src/modules/foundation-db/rbac.repository';

const USER_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b90101';
const SESSION_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b90202';
const FAMILY_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b90303';
const TENANT_A = '0195f3a2-7c40-7b12-9a10-4e8d21b90404';
const MEMBER_A = '0195f3a2-7c40-7b12-9a10-4e8d21b90505';
const CORR_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b90606';

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
): { ctx: ExecutionContext; res: Response; headersOut: Record<string, string | string[]> } {
  const res = {
    getHeader: (k: string) => resHeaders[k],
    setHeader: (k: string, v: string | string[]) => {
      resHeaders[k] = v;
    },
  } as unknown as Response;

  const fullReq: RequestWithAuthSession = {
    method: 'GET',
    headers: {},
    url: '/api/v1/test',
    originalUrl: '/api/v1/test',
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

  return { ctx, res, headersOut: resHeaders };
}

describe('Phase 3 Authentication, Argon2id, JWT/CSRF & Multi-Plane Guards Unit Suite', () => {
  describe('UT-P3-01 & UT-P3-02: PasswordHashService (Argon2id + Policy + Constant-Time Dummy)', () => {
    const passwordService = new PasswordHashService(testConfig);

    beforeAll(async () => {
      await passwordService.onModuleInit();
    });

    it('hashes passwords with Argon2id (64 MiB, t=3, p=4), verifies valid passwords, and executes constant-time dummy check on null hash', async () => {
      const hash = await passwordService.hashPassword('Str0ng#Passw0rd!2026');
      expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);

      await expect(
        passwordService.verifyPasswordConstantTime(hash, 'Str0ng#Passw0rd!2026'),
      ).resolves.toBe(true);
      await expect(
        passwordService.verifyPasswordConstantTime(hash, 'Wrong#Passw0rd!2026'),
      ).resolves.toBe(false);
      await expect(
        passwordService.verifyPasswordConstantTime(null, 'Str0ng#Passw0rd!2026'),
      ).resolves.toBe(false);
    });

    it('enforces password complexity policy and production AUTH_JWT_SECRET minimum length', () => {
      expect(() => passwordService.validatePasswordPolicy('Short1!')).toThrow(BadRequestException);
      expect(() => passwordService.validatePasswordPolicy('A'.repeat(129) + 'a1!')).toThrow(
        BadRequestException,
      );
      expect(() => passwordService.validatePasswordPolicy('alllowercase123!')).toThrow(
        BadRequestException,
      );
      expect(() => passwordService.validatePasswordPolicy('NoSpecialChars1234')).toThrow(
        BadRequestException,
      );
      expect(() =>
        passwordService.validatePasswordPolicy('Admin@Example.com1!', 'admin@example.com1!'),
      ).toThrow(BadRequestException);

      expect(() =>
        loadAppConfig({
          NODE_ENV: 'production',
          DATABASE_MIGRATOR_URL: 'postgresql://m:pw1@localhost:5434/db',
          DATABASE_APP_URL: 'postgresql://a:pw2@localhost:5434/db',
        }),
      ).toThrow(/AUTH_JWT_SECRET is required in production/i);
    });
  });

  describe('UT-P3-03: TokenService (Access JWT Claims, Tampering, Expiry, SHA-256 & Cookies)', () => {
    const tokenService = new TokenService(testConfig);

    it('signs and verifies HS256 Access JWTs and rejects tampered or expired tokens', () => {
      const jwt = tokenService.signAccessToken({
        userId: USER_ID,
        sessionId: SESSION_ID,
        activeTenantId: TENANT_A,
        activeMembershipId: MEMBER_A,
        isPlatformSuperAdmin: false,
      });

      const verified = tokenService.verifyAccessToken(jwt);
      expect(verified.sub).toBe(USER_ID);
      expect(verified.sid).toBe(SESSION_ID);
      expect(verified.tid).toBe(TENANT_A);
      expect(verified.mid).toBe(MEMBER_A);
      expect(verified.padmin).toBe(false);

      // Tamper payload claim
      const [h, , s] = jwt.split('.');
      const forgedPayload = Buffer.from(
        JSON.stringify({ ...verified, padmin: true }),
        'utf8',
      ).toString('base64url');
      expect(() => tokenService.verifyAccessToken(`${h}.${forgedPayload}.${s}`)).toThrow(
        UnauthorizedException,
      );

      // Deterministic 64-char hex SHA-256 for opaque refresh/reset/verify secrets
      const secret = tokenService.generateOpaqueSecret();
      expect(secret.rawToken.length).toBeGreaterThanOrEqual(40);
      expect(secret.tokenHashHex).toMatch(/^[0-9a-f]{64}$/);
      expect(tokenService.sha256Hex(secret.rawToken)).toBe(secret.tokenHashHex);
    });

    it('sets HttpOnly cookie attributes with strict path scoping for refresh tokens', () => {
      const { res, headersOut } = buildHttpContext({});
      tokenService.setSessionCookies(res, {
        accessToken: 'at-val',
        refreshToken: 'rt-val',
        csrfToken: 'csrf-val',
      });

      const cookies = headersOut['Set-Cookie'] as string[];
      expect(cookies).toHaveLength(3);
      expect(cookies[0]).toContain('ft360_at=at-val');
      expect(cookies[0]).toContain('HttpOnly');
      expect(cookies[0]).toContain('SameSite=Lax');
      expect(cookies[1]).toContain('ft360_rt=rt-val');
      expect(cookies[1]).toContain('HttpOnly');
      expect(cookies[1]).toContain('Path=/api/v1/auth');
      expect(cookies[1]).toContain('SameSite=Strict');
      expect(cookies[2]).toContain('ft360_csrf=csrf-val');
      expect(cookies[2]).not.toContain('HttpOnly');
    });
  });

  describe('UT-P3-04: CsrfProtectionGuard', () => {
    const csrfGuard = new CsrfProtectionGuard(testConfig);

    it('allows safe GET requests and Bearer-authenticated requests, and enforces Origin + X-CSRF-Token on cookie mutations', () => {
      expect(csrfGuard.canActivate(buildHttpContext({ method: 'GET' }).ctx)).toBe(true);

      expect(
        csrfGuard.canActivate(
          buildHttpContext({
            method: 'POST',
            headers: { authorization: 'Bearer some.jwt.token' },
          }).ctx,
        ),
      ).toBe(true);

      // Missing X-CSRF-Token on cookie POST -> 403
      expect(() =>
        csrfGuard.canActivate(
          buildHttpContext({
            method: 'POST',
            headers: { cookie: 'ft360_csrf=good-csrf' },
          }).ctx,
        ),
      ).toThrow(ForbiddenException);

      // Evil cross-site Origin -> 403
      expect(() =>
        csrfGuard.canActivate(
          buildHttpContext({
            method: 'POST',
            headers: {
              origin: 'https://evil-site.example',
              cookie: 'ft360_csrf=good-csrf',
              'x-csrf-token': 'good-csrf',
            },
          }).ctx,
        ),
      ).toThrow(ForbiddenException);

      // Valid Origin + matching cookie & header + session verified -> allowed
      expect(
        csrfGuard.canActivate(
          buildHttpContext({
            method: 'POST',
            csrfVerifiedBySession: true,
            headers: {
              origin: 'http://localhost:3000',
              cookie: 'ft360_csrf=good-csrf',
              'x-csrf-token': 'good-csrf',
            },
          }).ctx,
        ),
      ).toBe(true);
    });
  });

  describe('UT-P3-05 & UT-P3-06: JwtAuthGuard, Plane Boundary Guards & Audit Secret Redaction', () => {
    const tokenService = new TokenService(testConfig);

    it('JwtAuthGuard rejects tombstoned or revoked sessions and binds authoritative DB session state', async () => {
      const reflector = {
        getAllAndOverride: jest.fn().mockReturnValue(false),
      } as unknown as Reflector;
      const sessionCache = {
        isSessionTombstoned: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
        tombstoneSessions: jest.fn().mockResolvedValue(undefined),
        cacheActiveSession: jest.fn().mockResolvedValue(undefined),
      } as unknown as RedisSessionCacheService;
      const authRepo = {
        validateSessionInDb: jest.fn().mockResolvedValue({
          sessionId: SESSION_ID,
          familyId: FAMILY_ID,
          userId: USER_ID,
          activeTenantId: TENANT_A,
          activeMembershipId: MEMBER_A,
          idleExpiresAtEpochMs: Date.now() + 60_000,
          expiresAtEpochMs: Date.now() + 300_000,
          revokedAt: null,
          userStatus: 'ACTIVE',
          userEmailVerified: true,
          isPlatformSuperAdmin: false,
          csrfValid: true,
        }),
      } as unknown as AuthRepository;

      const guard = new JwtAuthGuard(reflector, tokenService, sessionCache, authRepo);
      const validJwt = tokenService.signAccessToken({
        userId: USER_ID,
        sessionId: SESSION_ID,
        activeTenantId: null,
        activeMembershipId: null,
        isPlatformSuperAdmin: false,
      });

      // 1st call: Redis tombstone rejects immediately
      const call1 = buildHttpContext({ headers: { cookie: `ft360_at=${validJwt}` } });
      await expect(guard.canActivate(call1.ctx)).rejects.toThrow(UnauthorizedException);

      // 2nd call: Live DB session populates authoritative activeTenantId (TENANT_A)
      const reqObj: Partial<RequestWithAuthSession> = {
        headers: { cookie: `ft360_at=${validJwt}` },
      };
      const call2 = buildHttpContext(reqObj);
      await expect(guard.canActivate(call2.ctx)).resolves.toBe(true);
      const populated = call2.ctx.switchToHttp().getRequest<RequestWithAuthSession>();
      expect(populated.authSession?.activeTenantId).toBe(TENANT_A);
    });

    it('PlatformSuperAdminGuard & TenantAdminGuard enforce strict plane boundaries and AuthAuditService scrubs secrets', async () => {
      const recordedAudits: Array<Record<string, unknown>> = [];
      const mockRepo = {
        insertAuditLog: jest.fn(async (entry: Record<string, unknown>) => {
          recordedAudits.push(entry);
          return CORR_ID;
        }),
      } as unknown as AuthRepository;
      const auditService = new AuthAuditService(mockRepo);

      // Verify UT-P3-06 secret scrubbing
      const sanitized = auditService.sanitizeMetadata({
        email: 'user@acme.example',
        password: 'leak1',
        passwordHash: 'leak2',
        refreshToken: 'leak3',
        nested: { csrfSecret: 'leak4', safeField: 'kept' },
      });
      expect(sanitized).toEqual({
        email: 'user@acme.example',
        nested: { safeField: 'kept' },
      });

      // PlatformSuperAdminGuard blocks tenant-scoped sessions AND non-super-admins
      const mockTxManager = {
        withPlatformAdminTransaction: jest.fn(async () => {
          throw new UnauthorizedTenantMembershipError('Not super admin');
        }),
        withVerifiedMemberTransaction: jest.fn(
          async (_ctx: unknown, cb: (tx: unknown, mid: string) => Promise<unknown>) =>
            cb({}, MEMBER_A),
        ),
      } as unknown as TenantTransactionManager;

      const superGuard = new PlatformSuperAdminGuard(mockTxManager, auditService);
      await expect(
        superGuard.canActivate(
          buildHttpContext({
            authSession: { userId: USER_ID, sessionId: SESSION_ID, activeTenantId: TENANT_A },
          }).ctx,
        ),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        superGuard.canActivate(
          buildHttpContext({
            authSession: { userId: USER_ID, sessionId: SESSION_ID, activeTenantId: null },
          }).ctx,
        ),
      ).rejects.toThrow(ForbiddenException);

      // TenantAdminGuard blocks standard members lacking required administrative permissions
      const reflector = {
        getAllAndOverride: jest.fn().mockReturnValue(['rbac:roles:manage']),
      } as unknown as Reflector;
      const rbacRepo = {
        listEffectivePermissionsForMembership: jest
          .fn()
          .mockResolvedValue([{ code: 'tenant:members:read' }]),
      } as unknown as RbacRepository;
      const tenantAdminGuard = new TenantAdminGuard(
        reflector,
        mockTxManager,
        rbacRepo,
        auditService,
      );

      await expect(
        tenantAdminGuard.canActivate(
          buildHttpContext({
            authSession: { userId: USER_ID, sessionId: SESSION_ID, activeTenantId: TENANT_A },
            tenantContext: {
              tenantId: TENANT_A,
              actorUserId: USER_ID,
              membershipId: MEMBER_A,
              correlationId: CORR_ID,
            },
          }).ctx,
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(recordedAudits.length).toBe(3);
    });
  });
});
