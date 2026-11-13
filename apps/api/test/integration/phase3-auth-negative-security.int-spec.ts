import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import type { TenantEntity, TenantMembershipEntity } from '@ft360/shared-types';
import { AppModule } from '../../src/app.module';
import { configureNestApp } from '../../src/bootstrap';
import { APP_CONFIG, loadAppConfig, type AppEnvConfig } from '../../src/config/env.config';
import { DatabasePoolService } from '../../src/database/database-pool.service';
import { TenantTransactionManager } from '../../src/database/tenant-transaction.manager';
import { AuthMailOutboxService } from '../../src/modules/auth/auth-mail-outbox.service';
import { BootstrapSuperAdminService } from '../../src/modules/auth/bootstrap-super-admin.service';
import { PlatformDirectoryRepository } from '../../src/modules/foundation-db/platform-directory.repository';
import { RbacRepository } from '../../src/modules/foundation-db/rbac.repository';
import { TenantMembershipRepository } from '../../src/modules/foundation-db/tenant-membership.repository';

function parseSetCookies(setCookieHeader: string | string[] | undefined): Record<string, string> {
  const arr = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : typeof setCookieHeader === 'string'
      ? [setCookieHeader]
      : [];
  const map: Record<string, string> = {};
  for (const raw of arr) {
    const first = raw.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) {
      map[first.slice(0, eq).trim()] = decodeURIComponent(first.slice(eq + 1).trim());
    }
  }
  return map;
}

function buildCookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('; ');
}

describe('Phase 3 Mandatory Negative Authentication & Authorization Security Suite (SEC-P3-01..08)', () => {
  let app: INestApplication;
  let config: AppEnvConfig;
  let dbPool: DatabasePoolService;
  let txManager: TenantTransactionManager;
  let mailOutbox: AuthMailOutboxService;
  let bootstrapSuperAdmin: BootstrapSuperAdminService;
  let platformRepo: PlatformDirectoryRepository;
  let membershipRepo: TenantMembershipRepository;
  let rbacRepo: RbacRepository;

  let superAdminUserId: string;
  let tenantAlpha: TenantEntity;
  let tenantBeta: TenantEntity;
  let tenantSuspended: TenantEntity;

  const SUPER_ADMIN_EMAIL = 'superadmin@phase3-sec.test';
  const SUPER_ADMIN_PW = 'SuperAdmin#Sec2026!Ok';

  async function registerAndVerifyUser(fullName: string, email: string, password: string) {
    const reg = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ fullName, email, password })
      .expect(201);
    const msg = await mailOutbox.readLatestDevOutboxMessage(email, 'EMAIL_VERIFICATION');
    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token: msg!.rawToken })
      .expect(200);
    return reg.body.data.user.id as string;
  }

  beforeAll(async () => {
    config = loadAppConfig();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue({
        ...config,
        corsAllowedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
        database: { ...config.database, poolMin: 1, poolMax: 6 },
        auth: {
          ...config.auth,
          argon2MemoryCostKiB: 19456,
          argon2TimeCost: 2,
          argon2Parallelism: 2,
          rateLimitMaxLoginFailures: 5,
          rateLimitWindowSeconds: 300,
          rateLimitLockoutSeconds: 120,
          rateLimitIpBurstMax: 200,
          devOutboxEnabled: true,
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    configureNestApp(app);
    await app.init();

    dbPool = app.get(DatabasePoolService);
    txManager = app.get(TenantTransactionManager);
    mailOutbox = app.get(AuthMailOutboxService);
    bootstrapSuperAdmin = app.get(BootstrapSuperAdminService);
    platformRepo = app.get(PlatformDirectoryRepository);
    membershipRepo = app.get(TenantMembershipRepository);
    rbacRepo = app.get(RbacRepository);

    const cleanupPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
    try {
      await cleanupPool.query(
        `DELETE FROM public.tenants WHERE slug IN ('p3-sec-alpha', 'p3-sec-beta', 'p3-sec-suspended')`,
      );
      await cleanupPool.query(`DELETE FROM public.users WHERE email LIKE '%@phase3-sec.test'`);
    } finally {
      await cleanupPool.end();
    }

    const sa = await bootstrapSuperAdmin.ensureSuperAdminProvisioned({
      email: SUPER_ADMIN_EMAIL,
      password: SUPER_ADMIN_PW,
      fullName: 'Security Root Super Admin',
    });
    superAdminUserId = sa.userId;

    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      tenantAlpha = await platformRepo.createTenant(tx, {
        slug: 'p3-sec-alpha',
        legalName: 'Alpha Security Corp',
        displayName: 'Alpha Sec',
        status: 'ACTIVE',
      });
      tenantBeta = await platformRepo.createTenant(tx, {
        slug: 'p3-sec-beta',
        legalName: 'Beta Security Corp',
        displayName: 'Beta Sec',
        status: 'ACTIVE',
      });
      tenantSuspended = await platformRepo.createTenant(tx, {
        slug: 'p3-sec-suspended',
        legalName: 'Suspended Corp',
        displayName: 'Suspended Sec',
        status: 'SUSPENDED',
      });
    });
  });

  afterAll(async () => {
    try {
      const cleanupPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
      try {
        await cleanupPool.query(
          `DELETE FROM public.tenants WHERE slug IN ('p3-sec-alpha', 'p3-sec-beta', 'p3-sec-suspended')`,
        );
        await cleanupPool.query(`DELETE FROM public.users WHERE email LIKE '%@phase3-sec.test'`);
      } finally {
        await cleanupPool.end();
      }
    } finally {
      if (app) {
        await app.close();
      }
    }
  });

  it('SEC-P3-01: detects refresh token replay/theft and immediately revokes the entire session family lineage', async () => {
    const email = 'replay.victim@phase3-sec.test';
    const pw = 'Victim#Pass2026!Safe';
    await registerAndVerifyUser('Replay Victim', email, pw);

    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: pw })
      .expect(200);
    const initialJar = parseSetCookies(loginRes.headers['set-cookie']);

    // Legitimate rotation RT1 -> RT2
    const rotatedRes = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', buildCookieHeader(initialJar))
      .set('X-CSRF-Token', initialJar.ft360_csrf)
      .send({})
      .expect(200);
    const victimJar = parseSetCookies(rotatedRes.headers['set-cookie']);

    // Attacker replays stolen retired RT1!
    const replayRes = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', buildCookieHeader(initialJar))
      .set('X-CSRF-Token', initialJar.ft360_csrf)
      .send({})
      .expect(401);
    expect(replayRes.body.error.code).toBe('REFRESH_TOKEN_REPLAY_DETECTED');

    // Victim's rotated session (AT2 & RT2) is ALSO immediately revoked across the family!
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', buildCookieHeader(victimJar))
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', buildCookieHeader(victimJar))
      .set('X-CSRF-Token', victimJar.ft360_csrf)
      .send({})
      .expect(401);
  });

  it('SEC-P3-02: rejects client-spoofed tenant IDs (400), unauthorized/suspended org selection (403), and composite FK cross-tenant session corruption (23503)', async () => {
    const email = 'spoof.tester@phase3-sec.test';
    const pw = 'Spoof#Pass2026!Check';
    const userId = await registerAndVerifyUser('Spoof Tester', email, pw);

    let memberSuspendedInAlpha!: TenantMembershipEntity;
    let memberActiveInSuspendedTenant!: TenantMembershipEntity;
    let memberActiveInBeta!: TenantMembershipEntity;

    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      memberSuspendedInAlpha = await membershipRepo.createMembership(tx, {
        tenantId: tenantAlpha.id,
        userId,
        status: 'SUSPENDED',
      });
      memberActiveInSuspendedTenant = await membershipRepo.createMembership(tx, {
        tenantId: tenantSuspended.id,
        userId,
        status: 'ACTIVE',
      });
      memberActiveInBeta = await membershipRepo.createMembership(tx, {
        tenantId: tenantBeta.id,
        userId,
        status: 'ACTIVE',
      });
    });
    expect(memberSuspendedInAlpha.id).toBeDefined();
    expect(memberActiveInSuspendedTenant.id).toBeDefined();

    // 1. Client-spoofed tenantId in body/header/query is universally rejected with 400 UNTRUSTED_TENANT_INPUT_REJECTED
    const spoofBody = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: pw, tenantId: tenantAlpha.id })
      .expect(400);
    expect(spoofBody.body.error.code).toBe('UNTRUSTED_TENANT_INPUT_REJECTED');

    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: pw })
      .expect(200);
    const jar = parseSetCookies(loginRes.headers['set-cookie']);

    await request(app.getHttpServer())
      .get('/api/v1/workspace/context')
      .set('Cookie', buildCookieHeader(jar))
      .set('x-tenant-id', tenantBeta.id)
      .expect(400);

    // 2. Selecting an organization with SUSPENDED membership fails with 403 TENANT_MEMBERSHIP_INACTIVE
    const suspMemberRes = await request(app.getHttpServer())
      .post('/api/v1/auth/select-organization')
      .set('Cookie', buildCookieHeader(jar))
      .set('X-CSRF-Token', jar.ft360_csrf)
      .send({ targetOrganizationId: tenantAlpha.id })
      .expect(403);
    expect(suspMemberRes.body.error.code).toBe('TENANT_MEMBERSHIP_INACTIVE');

    // 3. Selecting a SUSPENDED tenant fails with 403 TENANT_SUSPENDED_OR_INACTIVE
    const suspTenantRes = await request(app.getHttpServer())
      .post('/api/v1/auth/select-organization')
      .set('Cookie', buildCookieHeader(jar))
      .set('X-CSRF-Token', jar.ft360_csrf)
      .send({ targetOrganizationId: tenantSuspended.id })
      .expect(403);
    expect(suspTenantRes.body.error.code).toBe('TENANT_SUSPENDED_OR_INACTIVE');

    // 4. Composite FK fk_auth_sessions_active_membership rejects pairing Tenant Alpha with Membership in Tenant Beta (23503)
    const migratorPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
    try {
      await expect(
        migratorPool.query(
          `UPDATE public.auth_sessions
              SET active_tenant_id = $2::uuid,
                  active_membership_id = $3::uuid
            WHERE id = $1::uuid`,
          [loginRes.body.data.sessionId, tenantAlpha.id, memberActiveInBeta.id],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await migratorPool.end();
    }
  });

  it('SEC-P3-03: enforces immediate mid-session kill-switch when membership or user account is suspended while 15m JWT is still unexpired', async () => {
    const email = 'killswitch@phase3-sec.test';
    const pw = 'KillSwitch#2026!Live';
    const userId = await registerAndVerifyUser('KillSwitch User', email, pw);

    let membership!: TenantMembershipEntity;
    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      membership = await membershipRepo.createMembership(tx, {
        tenantId: tenantAlpha.id,
        userId,
        status: 'ACTIVE',
      });
    });

    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: pw })
      .expect(200);
    const jar = parseSetCookies(loginRes.headers['set-cookie']);

    const selRes = await request(app.getHttpServer())
      .post('/api/v1/auth/select-organization')
      .set('Cookie', buildCookieHeader(jar))
      .set('X-CSRF-Token', jar.ft360_csrf)
      .send({ targetOrganizationId: tenantAlpha.id })
      .expect(200);
    Object.assign(jar, parseSetCookies(selRes.headers['set-cookie']));

    await request(app.getHttpServer())
      .get('/api/v1/workspace/context')
      .set('Cookie', buildCookieHeader(jar))
      .expect(200);

    // Revoke membership mid-session while 15-minute JWT is unexpired
    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      await tx.query(
        `UPDATE public.tenant_memberships SET status = 'REVOKED' WHERE id = $1::uuid`,
        [membership.id],
      );
    });

    const afterMemberRevoke = await request(app.getHttpServer())
      .get('/api/v1/workspace/context')
      .set('Cookie', buildCookieHeader(jar))
      .expect(403);
    expect(afterMemberRevoke.body.error.code).toBe('TENANT_MEMBERSHIP_INACTIVE');

    // Suspend global user mid-session -> even /auth/me immediately blocks with 403 USER_ACCOUNT_INACTIVE
    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      await tx.query(`UPDATE public.users SET status = 'SUSPENDED' WHERE id = $1::uuid`, [userId]);
    });

    const afterUserSuspend = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', buildCookieHeader(jar))
      .expect(403);
    expect(afterUserSuspend.body.error.code).toBe('USER_ACCOUNT_INACTIVE');
  });

  it('SEC-P3-04 & SEC-P3-05: enforces strict Platform Super Admin vs Tenant Admin boundaries and CSRF protection on cookie mutations', async () => {
    const email = 'alpha.admin@phase3-sec.test';
    const pw = 'AlphaAdmin#2026!Safe';
    const alphaAdminUserId = await registerAndVerifyUser('Alpha Admin', email, pw);

    let alphaAdminMember!: TenantMembershipEntity;
    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      alphaAdminMember = await membershipRepo.createMembership(tx, {
        tenantId: tenantAlpha.id,
        userId: alphaAdminUserId,
        status: 'ACTIVE',
      });
    });

    await txManager.withVerifiedMemberTransaction(
      {
        tenantId: tenantAlpha.id,
        actorUserId: alphaAdminUserId,
        membershipId: alphaAdminMember.id,
        correlationId: '0195f3a2-7c40-7b12-9a10-4e8d21b98881',
      },
      async (tx) => {
        const role = await rbacRepo.createRole(tx, {
          tenantId: tenantAlpha.id,
          slug: 'sec_tenant_admin',
          name: 'Sec Tenant Admin',
          isSystemRole: true,
          dataAccessScope: 'TENANT',
        });
        const perm = await tx.query<{ id: string }>(
          `SELECT id FROM public.permissions WHERE code = 'audit:auth:read'`,
        );
        await rbacRepo.grantPermissionToRole(tx, {
          tenantId: tenantAlpha.id,
          roleId: role.id,
          permissionId: perm.rows[0].id,
        });
        await rbacRepo.assignRoleToMembership(tx, {
          tenantId: tenantAlpha.id,
          membershipId: alphaAdminMember.id,
          roleId: role.id,
        });
      },
    );

    // 1. Tenant Admin calling /api/v1/platform/auth/overview -> 403 PLATFORM_SUPER_ADMIN_REQUIRED
    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: pw })
      .expect(200);
    const adminJar = parseSetCookies(adminLogin.headers['set-cookie']);

    const platformDenied = await request(app.getHttpServer())
      .get('/api/v1/platform/auth/overview')
      .set('Cookie', buildCookieHeader(adminJar))
      .expect(403);
    expect(platformDenied.body.error.code).toBe('PLATFORM_SUPER_ADMIN_REQUIRED');

    // 2. SEC-P3-05: Cookie-authenticated POST without X-CSRF-Token or with evil Origin -> 403 CSRF_TOKEN_INVALID
    const missingCsrf = await request(app.getHttpServer())
      .post('/api/v1/auth/select-organization')
      .set('Cookie', buildCookieHeader(adminJar))
      .send({ targetOrganizationId: tenantAlpha.id })
      .expect(403);
    expect(missingCsrf.body.error.code).toBe('CSRF_TOKEN_INVALID');

    const evilOrigin = await request(app.getHttpServer())
      .post('/api/v1/auth/select-organization')
      .set('Cookie', buildCookieHeader(adminJar))
      .set('Origin', 'https://attacker-cross-site.example')
      .set('X-CSRF-Token', adminJar.ft360_csrf)
      .send({ targetOrganizationId: tenantAlpha.id })
      .expect(403);
    expect(evilOrigin.body.error.code).toBe('CSRF_TOKEN_INVALID');

    // 3. Platform Super Admin can access /api/v1/platform/auth/overview in unscoped session,
    //    but CANNOT select or enter Tenant Beta without an active membership!
    const saLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: SUPER_ADMIN_EMAIL, password: SUPER_ADMIN_PW })
      .expect(200);
    const saJar = parseSetCookies(saLogin.headers['set-cookie']);

    const saOverview = await request(app.getHttpServer())
      .get('/api/v1/platform/auth/overview')
      .set('Cookie', buildCookieHeader(saJar))
      .expect(200);
    expect(saOverview.body.data.plane).toBe('PLATFORM_CONTROL_PLANE');

    const saUnauthorizedTenant = await request(app.getHttpServer())
      .post('/api/v1/auth/select-organization')
      .set('Cookie', buildCookieHeader(saJar))
      .set('X-CSRF-Token', saJar.ft360_csrf)
      .send({ targetOrganizationId: tenantBeta.id })
      .expect(403);
    expect(saUnauthorizedTenant.body.error.code).toBe('TENANT_MEMBERSHIP_DENIED');
  });

  it('SEC-P3-06: enforces progressive login brute-force lockout (5 failures -> 429 + Retry-After, blocking even valid password on 6th attempt)', async () => {
    const email = `lockout.${Date.now()}@phase3-sec.test`;
    const correctPw = 'Correct#Pass2026!Lock';
    await registerAndVerifyUser('Lockout Target', email, correctPw);

    // Failures 1..4 -> 401 INVALID_CREDENTIALS
    for (let i = 1; i <= 4; i++) {
      const failRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: `Wrong#PassAttempt${i}!` })
        .expect(401);
      expect(failRes.body.error.code).toBe('INVALID_CREDENTIALS');
    }

    // 5th consecutive failure -> 429 AUTH_RATE_LIMITED + Retry-After header
    const fifthRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'Wrong#PassAttempt5!' })
      .expect(429);
    expect(fifthRes.body.error.code).toBe('AUTH_RATE_LIMITED');
    expect(Number.parseInt(fifthRes.headers['retry-after'], 10)).toBeGreaterThan(0);

    // 6th attempt WITH THE CORRECT PASSWORD during lockout -> STILL 429 AUTH_RATE_LIMITED!
    const sixthCorrectRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: correctPw })
      .expect(429);
    expect(sixthCorrectRes.body.error.code).toBe('AUTH_RATE_LIMITED');
  });

  it('SEC-P3-07 & SEC-P3-08: enforces auth_audit_logs immutability, cross-tenant RLS isolation, and blocks SECURITY DEFINER auth calls inside tenant transactions', async () => {
    const betaEmail = 'beta.admin@phase3-sec.test';
    const betaPw = 'BetaAdmin#2026!Safe';
    const betaAdminUserId = await registerAndVerifyUser('Beta Admin', betaEmail, betaPw);

    let betaMember!: TenantMembershipEntity;
    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      betaMember = await membershipRepo.createMembership(tx, {
        tenantId: tenantBeta.id,
        userId: betaAdminUserId,
        status: 'ACTIVE',
      });
    });

    await txManager.withVerifiedMemberTransaction(
      {
        tenantId: tenantBeta.id,
        actorUserId: betaAdminUserId,
        membershipId: betaMember.id,
        correlationId: '0195f3a2-7c40-7b12-9a10-4e8d21b98889',
      },
      async (tx) => {
        const role = await rbacRepo.createRole(tx, {
          tenantId: tenantBeta.id,
          slug: 'beta_sec_admin',
          name: 'Beta Sec Admin',
          isSystemRole: true,
          dataAccessScope: 'TENANT',
        });
        const perm = await tx.query<{ id: string }>(
          `SELECT id FROM public.permissions WHERE code = 'audit:auth:read'`,
        );
        await rbacRepo.grantPermissionToRole(tx, {
          tenantId: tenantBeta.id,
          roleId: role.id,
          permissionId: perm.rows[0].id,
        });
        await rbacRepo.assignRoleToMembership(tx, {
          tenantId: tenantBeta.id,
          membershipId: betaMember.id,
          roleId: role.id,
        });
      },
    );

    // SEC-P3-08: Calling narrow SECURITY DEFINER auth routines inside a tenant transaction MUST fail closed (42501)
    await expect(
      txManager.withVerifiedMemberTransaction(
        {
          tenantId: tenantBeta.id,
          actorUserId: betaAdminUserId,
          membershipId: betaMember.id,
          correlationId: '0195f3a2-7c40-7b12-9a10-4e8d21b98891',
        },
        async (tx) =>
          tx.query(`SELECT * FROM public.fn_auth_get_login_candidate($1::citext)`, [betaEmail]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Forging an audit record for Tenant Alpha from inside Tenant Beta tx MUST fail closed (42501)
    await expect(
      txManager.withVerifiedMemberTransaction(
        {
          tenantId: tenantBeta.id,
          actorUserId: betaAdminUserId,
          membershipId: betaMember.id,
          correlationId: '0195f3a2-7c40-7b12-9a10-4e8d21b98892',
        },
        async (tx) =>
          tx.query(
            `SELECT public.fn_record_auth_audit_log('FORGED', 'SUCCESS', $1::uuid, NULL, NULL, $2::uuid)`,
            ['0195f3a2-7c40-7b12-9a10-4e8d21b98890', tenantAlpha.id],
          ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Select Beta org so Beta has tenant-scoped audit logs
    const betaLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: betaEmail, password: betaPw })
      .expect(200);
    const betaJar = parseSetCookies(betaLogin.headers['set-cookie']);

    const betaSel = await request(app.getHttpServer())
      .post('/api/v1/auth/select-organization')
      .set('Cookie', buildCookieHeader(betaJar))
      .set('X-CSRF-Token', betaJar.ft360_csrf)
      .send({ targetOrganizationId: tenantBeta.id })
      .expect(200);
    Object.assign(betaJar, parseSetCookies(betaSel.headers['set-cookie']));

    const betaLogsRes = await request(app.getHttpServer())
      .get('/api/v1/workspace/admin/auth-logs')
      .set('Cookie', buildCookieHeader(betaJar))
      .expect(200);

    // Every single audit log returned to Beta Admin MUST belong strictly to Tenant Beta (zero Tenant Alpha or NULL global rows)
    expect(betaLogsRes.body.data.length).toBeGreaterThanOrEqual(1);
    for (const log of betaLogsRes.body.data as Array<{ tenantId: string | null }>) {
      expect(log.tenantId).toBe(tenantBeta.id);
    }

    // Unscoped queries on auth_audit_logs and auth_sessions return 0 rows
    const unscopedAudit = await dbPool.queryUnscoped('SELECT id FROM public.auth_audit_logs');
    expect(unscopedAudit.rows).toEqual([]);
    const unscopedSessions = await dbPool.queryUnscoped('SELECT id FROM public.auth_sessions');
    expect(unscopedSessions.rows).toEqual([]);

    // Even inside Platform Super Admin transaction, UPDATE and DELETE on auth_audit_logs fail with 42501!
    await expect(
      txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) =>
        tx.query(`UPDATE public.auth_audit_logs SET outcome = 'SUCCESS'`),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) =>
        tx.query(`DELETE FROM public.auth_audit_logs`),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
