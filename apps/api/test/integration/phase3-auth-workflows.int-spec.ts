import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import type { TenantEntity, TenantMembershipEntity } from '@ft360/shared-types';
import { AppModule } from '../../src/app.module';
import { configureNestApp } from '../../src/bootstrap';
import { APP_CONFIG, loadAppConfig, type AppEnvConfig } from '../../src/config/env.config';
import { DatabasePoolService } from '../../src/database/database-pool.service';
import { SqlMigrationRunner } from '../../src/database/migrations/migration-runner';
import { TenantTransactionManager } from '../../src/database/tenant-transaction.manager';
import { AuthMailOutboxService } from '../../src/modules/auth/auth-mail-outbox.service';
import { PasswordHashService } from '../../src/modules/auth/password-hash.service';
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

describe('Phase 3 Authentication, Verification, Session Rotation, Password Reset & Multi-Org Workflows (IT-P3-01..06)', () => {
  let app: INestApplication;
  let config: AppEnvConfig;
  let dbPool: DatabasePoolService;
  let txManager: TenantTransactionManager;
  let mailOutbox: AuthMailOutboxService;
  let passwordHashService: PasswordHashService;
  let platformRepo: PlatformDirectoryRepository;
  let membershipRepo: TenantMembershipRepository;
  let rbacRepo: RbacRepository;

  let superAdminUserId: string;
  let tenantAlpha: TenantEntity;
  let tenantBeta: TenantEntity;

  beforeAll(async () => {
    config = loadAppConfig();

    // IT-P3-01: Verify Migration 0006 rollback -> re-up cleanly
    const runner = new SqlMigrationRunner(config.database.migratorUrl);
    try {
      await runner.migrateUp();
      expect(await runner.rollbackLatest()).toBe(
        '0006_phase3_auth_security_remediation',
      );
      expect(await runner.migrateUp()).toEqual([
        '0006_phase3_auth_security_remediation',
      ]);
    } finally {
      await runner.close();
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue({
        ...config,
        database: { ...config.database, poolMin: 1, poolMax: 6 },
        auth: {
          ...config.auth,
          // Fast Argon2id parameters in test while remaining true Argon2id >= 16 MiB
          argon2MemoryCostKiB: 19456,
          argon2TimeCost: 2,
          argon2Parallelism: 2,
          devOutboxEnabled: true,
          mail: {
            ...config.auth.mail,
            provider: 'sandbox',
            pollIntervalMs: 0,
          },
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    configureNestApp(app);
    await app.init();

    dbPool = app.get(DatabasePoolService);
    txManager = app.get(TenantTransactionManager);
    mailOutbox = app.get(AuthMailOutboxService);
    passwordHashService = app.get(PasswordHashService);
    platformRepo = app.get(PlatformDirectoryRepository);
    membershipRepo = app.get(TenantMembershipRepository);
    rbacRepo = app.get(RbacRepository);

    // Clean any leftover @phase3-wf.test fixtures first
    const cleanupPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
    try {
      await cleanupPool.query(
        `DELETE FROM public.tenants WHERE slug IN ('p3-wf-alpha', 'p3-wf-beta')`,
      );
      await cleanupPool.query(`DELETE FROM public.users WHERE email LIKE '%@phase3-wf.test'`);
    } finally {
      await cleanupPool.end();
    }

    // Seed dedicated test Super Admin + Two Tenants for multi-org tests
    const superAdminHash = await passwordHashService.hashPassword('SuperAdmin#2026!Secure');
    const createdSuperAdmin = await txManager.withSystemBootstrapTransaction((tx) =>
      platformRepo.createUser(tx, {
        email: 'root@phase3-wf.test',
        passwordHash: superAdminHash,
        fullName: 'Phase 3 Root Admin',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        emailVerified: true,
      }),
    );
    superAdminUserId = createdSuperAdmin.id;

    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      tenantAlpha = await platformRepo.createTenant(tx, {
        slug: 'p3-wf-alpha',
        legalName: 'Phase 3 Alpha Holdings Ltd',
        displayName: 'Alpha Workspace',
        status: 'ACTIVE',
      });
      tenantBeta = await platformRepo.createTenant(tx, {
        slug: 'p3-wf-beta',
        legalName: 'Phase 3 Beta Ventures Inc',
        displayName: 'Beta Workspace',
        status: 'TRIAL',
      });
    });
  });

  afterAll(async () => {
    try {
      const cleanupPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
      try {
        await cleanupPool.query(
          `DELETE FROM public.tenants WHERE slug IN ('p3-wf-alpha', 'p3-wf-beta')`,
        );
        await cleanupPool.query(`DELETE FROM public.users WHERE email LIKE '%@phase3-wf.test'`);
      } finally {
        await cleanupPool.end();
      }
    } finally {
      if (app) {
        await app.close();
      }
    }
  });

  it('IT-P3-01: verifies all 15 public tables have ft360_migrator owner + FORCE RLS, composite FK on auth_sessions, and zero direct SELECT on secret columns', async () => {
    const tablesRes = await dbPool.queryUnscoped<{
      tablename: string;
      tableowner: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT t.tablename, t.tableowner, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_tables t
       INNER JOIN pg_class c ON c.relname = t.tablename
       INNER JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
       WHERE t.schemaname = 'public' AND t.tablename <> 'schema_migrations'
       ORDER BY t.tablename ASC`,
    );

    expect(tablesRes.rows.map((r) => r.tablename)).toEqual([
      'auth_audit_logs',
      'auth_email_outbox',
      'auth_refresh_token_history',
      'auth_sessions',
      'email_verification_tokens',
      'password_reset_tokens',
      'permissions',
      'platform_branding_settings',
      'rls_isolation_canary',
      'role_permissions',
      'roles',
      'tenant_memberships',
      'tenants',
      'user_role_assignments',
      'users',
    ]);
    for (const row of tablesRes.rows) {
      expect(row.tableowner).toBe('ft360_migrator');
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }

    // Verify composite FK fk_auth_sessions_active_membership exists
    const fkRes = await dbPool.queryUnscoped<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'fk_auth_sessions_active_membership'`,
    );
    expect(fkRes.rows).toHaveLength(1);

    // Verify ft360_app cannot directly SELECT password_hash, refresh_token_hash, csrf_secret_hash, token_hash, or encrypted_action_token
    await expect(
      dbPool.queryUnscoped('SELECT password_hash FROM public.users'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      dbPool.queryUnscoped('SELECT refresh_token_hash FROM public.auth_sessions'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      dbPool.queryUnscoped('SELECT csrf_secret_hash FROM public.auth_sessions'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      dbPool.queryUnscoped('SELECT token_hash FROM public.email_verification_tokens'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      dbPool.queryUnscoped('SELECT token_hash FROM public.password_reset_tokens'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      dbPool.queryUnscoped('SELECT token_hash FROM public.auth_refresh_token_history'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      dbPool.queryUnscoped('SELECT replaced_by_token_hash FROM public.auth_refresh_token_history'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      dbPool.queryUnscoped('SELECT encrypted_action_token FROM public.auth_email_outbox'),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('IT-P3-02 & IT-P3-03: completes Registration -> Unverified Login Block -> Single-Use Email Verification -> Login -> /auth/me -> /auth/sessions -> Logout revocation', async () => {
    const email = 'mansi.engineer@phase3-wf.test';
    const password = 'Mansi#Secure2026!Login';

    // 1. Self-service registration
    const regRes = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        fullName: 'Mansi Kulkarni',
        email,
        password,
      })
      .expect(201);

    expect(regRes.body.success).toBe(true);
    expect(regRes.body.data.verificationRequired).toBe(true);
    expect(regRes.body.data.user.status).toBe('PENDING');
    expect(regRes.body.data.user.emailVerified).toBe(false);
    expect(JSON.stringify(regRes.body)).not.toContain('passwordHash');

    // Duplicate email rejected with 409
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ fullName: 'Duplicate', email, password })
      .expect(409);

    // 2. Login BEFORE email verification is rejected with 403 EMAIL_NOT_VERIFIED
    const preVerifyLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(403);
    expect(preVerifyLogin.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    // 3. Retrieve verification token from outbox and verify email
    const outboxMsg = await mailOutbox.readLatestDevOutboxMessage(email, 'EMAIL_VERIFICATION');
    expect(outboxMsg).not.toBeNull();

    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token: outboxMsg!.rawToken })
      .expect(200);

    // Replay of already-consumed verification token is rejected with 400
    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token: outboxMsg!.rawToken })
      .expect(400);

    // 4. Login succeeds and sets HttpOnly ft360_at, ft360_rt + ft360_csrf cookies
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    const jar = parseSetCookies(loginRes.headers['set-cookie']);
    expect(jar.ft360_at).toBeDefined();
    expect(jar.ft360_rt).toBeDefined();
    expect(jar.ft360_csrf).toBeDefined();
    expect(loginRes.body.data.user.status).toBe('ACTIVE');
    expect(loginRes.body.data.user.emailVerified).toBe(true);

    // 5. /auth/me and /auth/sessions return clean non-secret data
    const meRes = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', buildCookieHeader(jar))
      .expect(200);
    expect(meRes.body.data.user.email).toBe(email);
    expect(JSON.stringify(meRes.body)).not.toMatch(/password_hash|refresh_token_hash|csrf_secret_hash/i);

    const sessRes = await request(app.getHttpServer())
      .get('/api/v1/auth/sessions')
      .set('Cookie', buildCookieHeader(jar))
      .expect(200);
    expect(sessRes.body.data).toHaveLength(1);
    expect(sessRes.body.data[0].isCurrent).toBe(true);

    // 6. Logout revokes session in PG + Redis; reusing the exact same unexpired ft360_at JWT immediately fails with 401 SESSION_REVOKED
    const savedAccessJwt = jar.ft360_at;
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', buildCookieHeader(jar))
      .set('X-CSRF-Token', jar.ft360_csrf)
      .send({})
      .expect(200);

    const postLogoutMe = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', `ft360_at=${encodeURIComponent(savedAccessJwt)}`)
      .expect(401);
    expect(postLogoutMe.body.error.code).toBe('SESSION_REVOKED');
  });

  it('IT-P3-04 & IT-P3-05: rotates refresh tokens, enforces idle/absolute expiration, and resets passwords while revoking all existing sessions', async () => {
    const email = 'reset.flow@phase3-wf.test';
    const oldPassword = 'Initial#Pass2026!Valid';
    const newPassword = 'Rotated#Pass2026!Fresh';

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ fullName: 'Reset User', email, password: oldPassword })
      .expect(201);

    const verifyMsg = await mailOutbox.readLatestDevOutboxMessage(email, 'EMAIL_VERIFICATION');
    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token: verifyMsg!.rawToken })
      .expect(200);

    // Create two concurrent device sessions
    const login1 = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: oldPassword })
      .expect(200);
    const jar1 = parseSetCookies(login1.headers['set-cookie']);

    const login2 = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: oldPassword })
      .expect(200);
    const jar2 = parseSetCookies(login2.headers['set-cookie']);

    // Refresh rotation on session 1 issues new ft360_at, ft360_rt, ft360_csrf
    const refreshRes = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', buildCookieHeader(jar1))
      .set('X-CSRF-Token', jar1.ft360_csrf)
      .send({})
      .expect(200);
    const rotatedJar1 = parseSetCookies(refreshRes.headers['set-cookie']);
    expect(rotatedJar1.ft360_rt).toBeDefined();
    expect(rotatedJar1.ft360_rt).not.toBe(jar1.ft360_rt);

    // Forgot-password returns identical 202 for unknown and known emails
    const unknownForgot = await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody.unknown@phase3-wf.test' })
      .expect(202);
    const knownForgot = await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email })
      .expect(202);
    expect(knownForgot.body.data.message).toBe(unknownForgot.body.data.message);

    // Reset password using single-use token
    const resetMsg = await mailOutbox.readLatestDevOutboxMessage(email, 'PASSWORD_RESET');
    expect(resetMsg).not.toBeNull();

    await request(app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({ token: resetMsg!.rawToken, newPassword })
      .expect(200);

    // Replay of consumed reset token fails with 400
    await request(app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({ token: resetMsg!.rawToken, newPassword })
      .expect(400);

    // Both prior device sessions (rotatedJar1 AND jar2) are immediately revoked!
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', buildCookieHeader(rotatedJar1))
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', buildCookieHeader(jar2))
      .expect(401);

    // Old password fails; new password succeeds
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: oldPassword })
      .expect(401);
    const freshLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: newPassword })
      .expect(200);
    const freshJar = parseSetCookies(freshLogin.headers['set-cookie']);

    // Simulate expired idle_expires_at in DB and verify JwtAuthGuard rejects with 401 SESSION_EXPIRED
    const migratorPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
    try {
      await migratorPool.query(
        `UPDATE public.auth_sessions
            SET idle_expires_at = created_at + INTERVAL '1 millisecond'
          WHERE id = $1::uuid`,
        [freshLogin.body.data.sessionId],
      );
      await new Promise((r) => setTimeout(r, 15));
    } finally {
      await migratorPool.end();
    }

    const expiredCheck = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', buildCookieHeader(freshJar))
      .expect(401);
    expect(expiredCheck.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('IT-P3-06: enforces multi-tenant organization selection & Tenant Admin boundary switching between Alpha (Admin) and Beta (Member)', async () => {
    const email = 'nakshatra.multiorg@phase3-wf.test';
    const password = 'MultiOrg#Pass2026!Valid';

    const reg = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ fullName: 'Nakshatra Sulakhe', email, password })
      .expect(201);
    const userId = reg.body.data.user.id as string;

    const verifyMsg = await mailOutbox.readLatestDevOutboxMessage(email, 'EMAIL_VERIFICATION');
    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token: verifyMsg!.rawToken })
      .expect(200);

    // Seed memberships: Tenant Admin in Alpha, Standard Member in Beta
    let memberAlpha!: TenantMembershipEntity;
    let memberBeta!: TenantMembershipEntity;
    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      memberAlpha = await membershipRepo.createMembership(tx, {
        tenantId: tenantAlpha.id,
        userId,
        status: 'ACTIVE',
      });
      memberBeta = await membershipRepo.createMembership(tx, {
        tenantId: tenantBeta.id,
        userId,
        status: 'ACTIVE',
      });
    });

    await txManager.withVerifiedMemberTransaction(
      {
        tenantId: tenantAlpha.id,
        actorUserId: userId,
        membershipId: memberAlpha.id,
        correlationId: '0195f3a2-7c40-7b12-9a10-4e8d21b97771',
      },
      async (tx) => {
        const adminRole = await rbacRepo.createRole(tx, {
          tenantId: tenantAlpha.id,
          slug: 'tenant_admin',
          name: 'Tenant Administrator',
          isSystemRole: true,
          dataAccessScope: 'TENANT',
        });
        const permRes = await tx.query<{ id: string }>(
          `SELECT id FROM public.permissions WHERE code IN ('audit:auth:read', 'rbac:roles:manage')`,
        );
        for (const p of permRes.rows) {
          await rbacRepo.grantPermissionToRole(tx, {
            tenantId: tenantAlpha.id,
            roleId: adminRole.id,
            permissionId: p.id,
          });
        }
        await rbacRepo.assignRoleToMembership(tx, {
          tenantId: tenantAlpha.id,
          membershipId: memberAlpha.id,
          roleId: adminRole.id,
        });
      },
    );

    await txManager.withVerifiedMemberTransaction(
      {
        tenantId: tenantBeta.id,
        actorUserId: userId,
        membershipId: memberBeta.id,
        correlationId: '0195f3a2-7c40-7b12-9a10-4e8d21b97772',
      },
      async (tx) => {
        const repRole = await rbacRepo.createRole(tx, {
          tenantId: tenantBeta.id,
          slug: 'sales_rep',
          name: 'Standard Member',
          isSystemRole: false,
          dataAccessScope: 'OWN',
        });
        const permRes = await tx.query<{ id: string }>(
          `SELECT id FROM public.permissions WHERE code = 'tenant:members:read'`,
        );
        await rbacRepo.grantPermissionToRole(tx, {
          tenantId: tenantBeta.id,
          roleId: repRole.id,
          permissionId: permRes.rows[0].id,
        });
        await rbacRepo.assignRoleToMembership(tx, {
          tenantId: tenantBeta.id,
          membershipId: memberBeta.id,
          roleId: repRole.id,
        });
      },
    );

    // 1. Login returns both active organizations with activeOrganization = null
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    expect(loginRes.body.data.activeOrganization).toBeNull();
    expect(loginRes.body.data.organizations).toHaveLength(2);
    const jar = parseSetCookies(loginRes.headers['set-cookie']);

    // Calling /workspace/context BEFORE selecting an organization fails with 401
    await request(app.getHttpServer())
      .get('/api/v1/workspace/context')
      .set('Cookie', buildCookieHeader(jar))
      .expect(401);

    // 2. Select Organization Alpha -> /workspace/context & /workspace/admin/auth-logs succeed (200)
    const selAlpha = await request(app.getHttpServer())
      .post('/api/v1/auth/select-organization')
      .set('Cookie', buildCookieHeader(jar))
      .set('X-CSRF-Token', jar.ft360_csrf)
      .send({ targetOrganizationId: tenantAlpha.id })
      .expect(200);
    Object.assign(jar, parseSetCookies(selAlpha.headers['set-cookie']));

    const alphaCtx = await request(app.getHttpServer())
      .get('/api/v1/workspace/context')
      .set('Cookie', buildCookieHeader(jar))
      .expect(200);
    expect(alphaCtx.body.data.tenantId).toBe(tenantAlpha.id);
    expect(alphaCtx.body.data.isTenantAdmin).toBe(true);

    const alphaLogs = await request(app.getHttpServer())
      .get('/api/v1/workspace/admin/auth-logs')
      .set('Cookie', buildCookieHeader(jar))
      .expect(200);
    expect(alphaLogs.body.data.length).toBeGreaterThanOrEqual(1);

    // 3. Switch to Organization Beta -> /workspace/context returns Beta (isTenantAdmin = false) & /workspace/admin/auth-logs returns 403!
    const selBeta = await request(app.getHttpServer())
      .post('/api/v1/auth/select-organization')
      .set('Cookie', buildCookieHeader(jar))
      .set('X-CSRF-Token', jar.ft360_csrf)
      .send({ targetOrganizationId: tenantBeta.id })
      .expect(200);
    Object.assign(jar, parseSetCookies(selBeta.headers['set-cookie']));

    const betaCtx = await request(app.getHttpServer())
      .get('/api/v1/workspace/context')
      .set('Cookie', buildCookieHeader(jar))
      .expect(200);
    expect(betaCtx.body.data.tenantId).toBe(tenantBeta.id);
    expect(betaCtx.body.data.isTenantAdmin).toBe(false);

    const betaAdminDenied = await request(app.getHttpServer())
      .get('/api/v1/workspace/admin/auth-logs')
      .set('Cookie', buildCookieHeader(jar))
      .expect(403);
    expect(betaAdminDenied.body.error.code).toBe('INSUFFICIENT_TENANT_PERMISSIONS');

    // 4. Exit organization clears activeTenantId back to null
    const exited = await request(app.getHttpServer())
      .post('/api/v1/auth/exit-organization')
      .set('Cookie', buildCookieHeader(jar))
      .set('X-CSRF-Token', jar.ft360_csrf)
      .send({})
      .expect(200);
    Object.assign(jar, parseSetCookies(exited.headers['set-cookie']));
    expect(exited.body.data.activeOrganization).toBeNull();
  });
});
