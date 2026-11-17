import * as crypto from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import type { UserEntity } from '@ft360/shared-types';
import { AppModule } from '../../src/app.module';
import { configureNestApp } from '../../src/bootstrap';
import { APP_CONFIG, loadAppConfig, type AppEnvConfig } from '../../src/config/env.config';
import { DatabasePoolService } from '../../src/database/database-pool.service';
import { SqlMigrationRunner } from '../../src/database/migrations/migration-runner';
import { TenantTransactionManager } from '../../src/database/tenant-transaction.manager';
import { PlatformDirectoryRepository } from '../../src/modules/foundation-db/platform-directory.repository';

const CORR_ID_1 = '0195f3a2-7c40-7b12-9a10-4e8d21b90901';
const CORR_ID_2 = '0195f3a2-7c40-7b12-9a10-4e8d21b90902';
const CORR_ID_ROLLBACK = '0195f3a2-7c40-7b12-9a10-4e8d21b90999';

const EXPECTED_18_ADMIN_PERMISSIONS = [
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
];

const EXPECTED_4_MEMBER_PERMISSIONS = [
  'tenant:branding:read',
  'tenant:members:read',
  'tenant:organization:read',
  'tenant:settings:read',
];

function randomSha256Hex(): string {
  return crypto.randomBytes(32).toString('hex');
}

describe('Phase 4 Stage 4B Prerequisite — Migration 0009 Tenant Registration Routines & Security Suite', () => {
  let app: INestApplication;
  let config: AppEnvConfig;
  let dbPool: DatabasePoolService;
  let txManager: TenantTransactionManager;
  let platformRepo: PlatformDirectoryRepository;
  let migratorPool: Pool;

  let superAdminUser: UserEntity;
  let verifiedUserAlpha: UserEntity;
  let verifiedUserBeta: UserEntity;
  let verifiedQuotaUser: UserEntity;
  let verifiedConcurrentUser: UserEntity;
  let unverifiedPendingUser: UserEntity;
  let activeUnverifiedUser: UserEntity;
  let suspendedUser: UserEntity;
  let archivedUser: UserEntity;

  async function cleanFixtures(pool: Pool): Promise<void> {
    await pool.query(
      `DELETE FROM public.tenant_audit_logs
        WHERE tenant_id IN (
          SELECT id FROM public.tenants WHERE slug LIKE 'p4b09-%'
        )`,
    );
    await pool.query(`DELETE FROM public.tenants WHERE slug LIKE 'p4b09-%'`);
    await pool.query(`DELETE FROM public.users WHERE email LIKE '%@p4b09.test'`);
  }

  async function createActiveSessionForUser(
    userId: string,
    opts?: { expired?: boolean; revoked?: boolean; viaMigrator?: boolean },
  ): Promise<string> {
    const idleTtl = 3600;
    const absTtl = 86400;

    if (opts?.expired || opts?.viaMigrator) {
      const intervalSql = opts?.expired ? `NOW() - INTERVAL '5 minutes'` : `NOW() + INTERVAL '1 hour'`;
      const res = await migratorPool.query<{ id: string }>(
        `INSERT INTO public.auth_sessions (
           user_id, refresh_token_hash, csrf_secret_hash, created_at, idle_expires_at, expires_at
         )
         VALUES (
           $1::uuid, $2, $3,
           NOW() - INTERVAL '1 hour',
           ${intervalSql},
           ${intervalSql}
         )
         RETURNING id`,
        [userId, randomSha256Hex(), randomSha256Hex()],
      );
      return res.rows[0].id;
    }

    const sessionId = await txManager.withAuthenticatedUserTransaction(userId, async (tx) => {
      const res = await tx.query<{ session_id: string }>(
        `SELECT session_id
           FROM public.fn_auth_create_session(
             $1::uuid, $2, $3, $4, $5, '127.0.0.1'::inet, 'Jest-P4B-0009'
           )`,
        [userId, randomSha256Hex(), randomSha256Hex(), idleTtl, absTtl],
      );
      return res.rows[0].session_id;
    });

    if (opts?.revoked) {
      await txManager.withAuthenticatedUserTransaction(userId, async (tx) => {
        await tx.query(
          `SELECT public.fn_auth_revoke_session($1::uuid, $2::uuid, 'TEST_REVOKED')`,
          [sessionId, userId],
        );
      });
    }

    return sessionId;
  }

  beforeAll(async () => {
    config = loadAppConfig();
    migratorPool = new Pool({ connectionString: config.database.migratorUrl, max: 2 });

    const runner = new SqlMigrationRunner(config.database.migratorUrl);
    try {
      await runner.migrateUp();
    } finally {
      await runner.close();
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue({
        ...config,
        database: { ...config.database, poolMin: 1, poolMax: 12 },
        auth: {
          ...config.auth,
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
    platformRepo = app.get(PlatformDirectoryRepository);

    await cleanFixtures(migratorPool);

    // Seed global actors
    await txManager.withSystemBootstrapTransaction(async (tx) => {
      superAdminUser = await platformRepo.createUser(tx, {
        email: 'superadmin@p4b09.test',
        fullName: 'P4B Super Admin',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$mocksuperadmin0009',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        emailVerified: true,
      });
    });

    await txManager.withPlatformAdminTransaction(superAdminUser.id, async (tx) => {
      verifiedUserAlpha = await platformRepo.createUser(tx, {
        email: 'alpha.founder@p4b09.test',
        fullName: 'Alpha Founder',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$mockalpha0009',
        status: 'ACTIVE',
        isPlatformSuperAdmin: false,
        emailVerified: true,
      });
      verifiedUserBeta = await platformRepo.createUser(tx, {
        email: 'beta.founder@p4b09.test',
        fullName: 'Beta Founder',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$mockbeta0009',
        status: 'ACTIVE',
        isPlatformSuperAdmin: false,
        emailVerified: true,
      });
      verifiedQuotaUser = await platformRepo.createUser(tx, {
        email: 'quota.owner@p4b09.test',
        fullName: 'Quota Owner',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$mockquota0009',
        status: 'ACTIVE',
        isPlatformSuperAdmin: false,
        emailVerified: true,
      });
      verifiedConcurrentUser = await platformRepo.createUser(tx, {
        email: 'concurrent.owner@p4b09.test',
        fullName: 'Concurrent Burst Owner',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$mockburst0009',
        status: 'ACTIVE',
        isPlatformSuperAdmin: false,
        emailVerified: true,
      });
      unverifiedPendingUser = await platformRepo.createUser(tx, {
        email: 'pending.unverified@p4b09.test',
        fullName: 'Pending Unverified User',
        status: 'PENDING',
        isPlatformSuperAdmin: false,
        emailVerified: false,
      });
      activeUnverifiedUser = await platformRepo.createUser(tx, {
        email: 'active.unverified@p4b09.test',
        fullName: 'Active Unverified User',
        status: 'ACTIVE',
        isPlatformSuperAdmin: false,
        emailVerified: false,
      });
      suspendedUser = await platformRepo.createUser(tx, {
        email: 'suspended.verified@p4b09.test',
        fullName: 'Suspended Verified User',
        status: 'SUSPENDED',
        isPlatformSuperAdmin: false,
        emailVerified: true,
      });
      archivedUser = await platformRepo.createUser(tx, {
        email: 'archived.verified@p4b09.test',
        fullName: 'Archived Verified User',
        status: 'ARCHIVED',
        isPlatformSuperAdmin: false,
        emailVerified: true,
      });
    });
  });

  afterAll(async () => {
    if (migratorPool) {
      await cleanFixtures(migratorPool);
      await migratorPool.end();
    }
    if (app) {
      await app.close();
    }
  });

  it('0009-SEC-01: verifies SECURITY DEFINER ownership (ft360_migrator), fixed search_path, PUBLIC revoke, ft360_app EXECUTE grant, and canonical 24-permission catalog', async () => {
    const fnRes = await migratorPool.query<{
      proname: string;
      owner_name: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      public_can_exec: boolean;
      app_can_exec: boolean;
    }>(
      `SELECT
         p.proname,
         r.rolname AS owner_name,
         p.prosecdef,
         p.proconfig,
         has_function_privilege('public', p.oid, 'EXECUTE') AS public_can_exec,
         has_function_privilege('ft360_app', p.oid, 'EXECUTE') AS app_can_exec
       FROM pg_proc p
       INNER JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('fn_check_tenant_slug_available', 'fn_tenant_provision_organization')
       ORDER BY p.proname ASC`,
    );

    expect(fnRes.rows).toHaveLength(2);
    for (const row of fnRes.rows) {
      expect(row.owner_name).toBe('ft360_migrator');
      expect(row.prosecdef).toBe(true);
      expect(row.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
      expect(row.public_can_exec).toBe(false);
      expect(row.app_can_exec).toBe(true);
    }

    // Step 5: Verify exact 24 canonical permissions breakdown (5 PLATFORM + 1 PORTAL + 18 TENANT)
    const permBreakdown = await migratorPool.query<{ scope_plane: string; cnt: string }>(
      `SELECT scope_plane, COUNT(*)::text AS cnt
         FROM public.permissions
        GROUP BY scope_plane
        ORDER BY scope_plane ASC`,
    );
    expect(permBreakdown.rows).toEqual([
      { scope_plane: 'PLATFORM', cnt: '5' },
      { scope_plane: 'PORTAL', cnt: '1' },
      { scope_plane: 'TENANT', cnt: '18' },
    ]);

    const tenantPermCodes = await migratorPool.query<{ code: string }>(
      `SELECT code FROM public.permissions WHERE scope_plane = 'TENANT' ORDER BY code ASC`,
    );
    expect(tenantPermCodes.rows.map((r) => r.code)).toEqual(EXPECTED_18_ADMIN_PERMISSIONS);
  });

  it('0009-SEC-02: blocks unauthenticated, unverified, inactive, actor-mismatched, Super Admin, session-mismatched, and direct raw table write attempts', async () => {
    const alphaSessionId = await createActiveSessionForUser(verifiedUserAlpha.id);
    const betaSessionId = await createActiveSessionForUser(verifiedUserBeta.id);
    const revokedSessionId = await createActiveSessionForUser(verifiedUserAlpha.id, {
      revoked: true,
    });
    const expiredSessionId = await createActiveSessionForUser(verifiedUserAlpha.id, {
      expired: true,
    });
    const superAdminSessionId = await createActiveSessionForUser(superAdminUser.id);

    // 1. Unauthenticated execution (app.current_user_id unset) -> 42501 on both functions
    await expect(
      dbPool.queryUnscoped(`SELECT public.fn_check_tenant_slug_available('p4b09-unauth')`),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      dbPool.queryUnscoped(
        `SELECT * FROM public.fn_tenant_provision_organization(
           $1::uuid, $2::uuid, 'p4b09-unauth', 'Unauth Co', 'Unauth Legal LLC',
           'COMPANY', 'SAAS_TECHNOLOGY', 'US', 'UTC', 'USD', $3::uuid
         )`,
        [verifiedUserAlpha.id, alphaSessionId, CORR_ID_1],
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Non-existent user UUID in GUC -> 42501
    const unknownUserId = '0195f3a2-0000-7000-8000-000000000000';
    await expect(
      txManager.withAuthenticatedUserTransaction(unknownUserId, (tx) =>
        tx.query(`SELECT public.fn_check_tenant_slug_available('p4b09-ghost')`),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // 2. Unverified users (PENDING + ACTIVE-but-unverified) -> 42501 EMAIL_NOT_VERIFIED / USER_ACCOUNT_INACTIVE
    for (const unverified of [unverifiedPendingUser, activeUnverifiedUser]) {
      const sessId = await createActiveSessionForUser(unverified.id, { viaMigrator: true });
      await expect(
        txManager.withAuthenticatedUserTransaction(unverified.id, (tx) =>
          tx.query(`SELECT public.fn_check_tenant_slug_available('p4b09-unverified')`),
        ),
      ).rejects.toMatchObject({ code: '42501' });

      await expect(
        txManager.withAuthenticatedUserTransaction(unverified.id, (tx) =>
          tx.query(
            `SELECT * FROM public.fn_tenant_provision_organization(
               $1::uuid, $2::uuid, 'p4b09-unverified', 'Unverified Org', 'Unverified Org LLC',
               'COMPANY', 'SAAS_TECHNOLOGY', 'US', 'UTC', 'USD', $3::uuid
             )`,
            [unverified.id, sessId, CORR_ID_1],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }

    // 3. Inactive users (SUSPENDED + ARCHIVED even with email_verified = true) -> 42501
    for (const inactive of [suspendedUser, archivedUser]) {
      const sessId = await createActiveSessionForUser(inactive.id, { viaMigrator: true });
      await expect(
        txManager.withAuthenticatedUserTransaction(inactive.id, (tx) =>
          tx.query(`SELECT public.fn_check_tenant_slug_available('p4b09-inactive')`),
        ),
      ).rejects.toMatchObject({ code: '42501' });

      await expect(
        txManager.withAuthenticatedUserTransaction(inactive.id, (tx) =>
          tx.query(
            `SELECT * FROM public.fn_tenant_provision_organization(
               $1::uuid, $2::uuid, 'p4b09-inactive', 'Inactive Org', 'Inactive Org LLC',
               'COMPANY', 'SAAS_TECHNOLOGY', 'US', 'UTC', 'USD', $3::uuid
             )`,
            [inactive.id, sessId, CORR_ID_1],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }

    // 4. Actor identity mismatch (`app.current_user_id` = Alpha, `p_actor_user_id` = Beta) -> 42501
    await expect(
      txManager.withAuthenticatedUserTransaction(verifiedUserAlpha.id, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_tenant_provision_organization(
             $1::uuid, $2::uuid, 'p4b09-mismatch', 'Mismatch Org', 'Mismatch Org LLC',
             'COMPANY', 'SAAS_TECHNOLOGY', 'US', 'UTC', 'USD', $3::uuid
           )`,
          [verifiedUserBeta.id, alphaSessionId, CORR_ID_1],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Cross-user session hijacking (`userAlpha` passing `betaSessionId`) -> 42501
    await expect(
      txManager.withAuthenticatedUserTransaction(verifiedUserAlpha.id, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_tenant_provision_organization(
             $1::uuid, $2::uuid, 'p4b09-hijack-sess', 'Hijack Sess', 'Hijack Sess LLC',
             'COMPANY', 'SAAS_TECHNOLOGY', 'US', 'UTC', 'USD', $3::uuid
           )`,
          [verifiedUserAlpha.id, betaSessionId, CORR_ID_1],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Revoked or expired session -> 42501
    for (const badSess of [revokedSessionId, expiredSessionId]) {
      await expect(
        txManager.withAuthenticatedUserTransaction(verifiedUserAlpha.id, (tx) =>
          tx.query(
            `SELECT * FROM public.fn_tenant_provision_organization(
               $1::uuid, $2::uuid, 'p4b09-bad-sess', 'Bad Sess', 'Bad Sess LLC',
               'COMPANY', 'SAAS_TECHNOLOGY', 'US', 'UTC', 'USD', $3::uuid
             )`,
            [verifiedUserAlpha.id, badSess, CORR_ID_1],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }

    // 5. Platform Super Admin rejection (both under SuperAdmin GUC and User GUC) -> 42501
    await expect(
      txManager.withPlatformAdminTransaction(superAdminUser.id, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_tenant_provision_organization(
             $1::uuid, $2::uuid, 'p4b09-super-1', 'Super Org', 'Super Org LLC',
             'COMPANY', 'SAAS_TECHNOLOGY', 'US', 'UTC', 'USD', $3::uuid
           )`,
          [superAdminUser.id, superAdminSessionId, CORR_ID_1],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      txManager.withAuthenticatedUserTransaction(superAdminUser.id, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_tenant_provision_organization(
             $1::uuid, $2::uuid, 'p4b09-super-2', 'Super Org', 'Super Org LLC',
             'COMPANY', 'SAAS_TECHNOLOGY', 'US', 'UTC', 'USD', $3::uuid
           )`,
          [superAdminUser.id, superAdminSessionId, CORR_ID_1],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // 6. Unauthorized direct table writes by ft360_app remain blocked (42501)
    await expect(
      txManager.withAuthenticatedUserTransaction(verifiedUserAlpha.id, (tx) =>
        tx.query(
          `INSERT INTO public.tenants (slug, legal_name, display_name, status)
           VALUES ('p4b09-raw-direct', 'Raw Legal', 'Raw Display', 'TRIAL')`,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      txManager.withAuthenticatedUserTransaction(verifiedUserAlpha.id, (tx) =>
        tx.query(
          `UPDATE public.auth_sessions SET active_tenant_id = NULL WHERE id = $1::uuid`,
          [alphaSessionId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('0009-SEC-03: enforces invalid/reserved/occupied slug rules, provisions TRIAL tenant atomically with exact 18/4 permissions, primary owner, isolated session bind, dual-ledger audits, and rejects active tenant context', async () => {
    // 1. Invalid & reserved slugs return strictly boolean `false` from `fn_check_tenant_slug_available`
    await txManager.withAuthenticatedUserTransaction(verifiedUserAlpha.id, async (tx) => {
      const invalidAndReserved = [
        null,
        '',
        'ab',
        'a'.repeat(64),
        '-leading-hyphen',
        'trailing-hyphen-',
        'UpperCase-Slug',
        ' spaces-around ',
        'under_score',
        "sql'-inject--",
        'admin',
        'api',
        'auth',
        'platform',
        'workspace',
        'portal',
        'www',
        'mail',
        'status',
        'health',
        'docs',
        'static',
        'assets',
        'billing',
        'support',
        'system',
        'root',
        'organizations',
        'invitations',
        'login',
        'register',
      ];

      for (const candidate of invalidAndReserved) {
        const res = await tx.query<{ available: boolean }>(
          `SELECT public.fn_check_tenant_slug_available($1::citext) AS available`,
          [candidate],
        );
        expect(Object.keys(res.rows[0])).toEqual(['available']);
        expect(res.rows[0].available).toBe(false);
      }

      const validCheck = await tx.query<{ available: boolean }>(
        `SELECT public.fn_check_tenant_slug_available('p4b09-acme-cloud') AS available`,
      );
      expect(Object.keys(validCheck.rows[0])).toEqual(['available']);
      expect(validCheck.rows[0].available).toBe(true);
    });

    const primarySessionId = await createActiveSessionForUser(verifiedUserAlpha.id);
    const secondaryDeviceSessionId = await createActiveSessionForUser(verifiedUserAlpha.id);

    // Reserved slug rejected on provisioning with uniform 23505 TENANT_SLUG_UNAVAILABLE
    await expect(
      txManager.withAuthenticatedUserTransaction(verifiedUserAlpha.id, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_tenant_provision_organization(
             $1::uuid, $2::uuid, 'platform', 'Platform Clone', 'Platform Clone LLC',
             'COMPANY', 'SAAS_TECHNOLOGY', 'US', 'UTC', 'USD', $3::uuid
           )`,
          [verifiedUserAlpha.id, primarySessionId, CORR_ID_1],
        ),
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // Malformed inputs rejected with 22023
    await expect(
      txManager.withAuthenticatedUserTransaction(verifiedUserAlpha.id, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_tenant_provision_organization(
             $1::uuid, $2::uuid, 'Bad_Slug', 'Acme', 'Acme Legal',
             'COMPANY', 'SAAS_TECHNOLOGY', 'US', 'UTC', 'USD', $3::uuid
           )`,
          [verifiedUserAlpha.id, primarySessionId, CORR_ID_1],
        ),
      ),
    ).rejects.toMatchObject({ code: '22023' });

    await expect(
      txManager.withAuthenticatedUserTransaction(verifiedUserAlpha.id, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_tenant_provision_organization(
             $1::uuid, $2::uuid, 'p4b09-bad-tz', 'Acme', 'Acme Legal',
             'COMPANY', 'SAAS_TECHNOLOGY', 'US', 'Not/A_Real_Timezone', 'USD', $3::uuid
           )`,
          [verifiedUserAlpha.id, primarySessionId, CORR_ID_1],
        ),
      ),
    ).rejects.toMatchObject({ code: '22023' });

    // 2. Provision valid organization in TRIAL status & verify app.is_super_admin never elevates
    const provisioned = await txManager.withAuthenticatedUserTransaction(
      verifiedUserAlpha.id,
      async (tx) => {
        const res = await tx.query<{
          tenant_id: string;
          tenant_slug: string;
          legal_name: string;
          display_name: string;
          tenant_status: string;
          default_timezone: string;
          default_currency: string;
          created_by_user_id: string;
          membership_id: string;
          membership_type: string;
          membership_status: string;
          is_primary_owner: boolean;
          admin_role_id: string;
          member_role_id: string;
          onboarding_status: string;
          onboarding_current_step: string;
          onboarding_version: number;
          bound_session_id: string;
          tenant_audit_log_id: string;
          auth_audit_log_id: string;
          effective_permissions: string[];
        }>(
          `SELECT * FROM public.fn_tenant_provision_organization(
             $1::uuid, $2::uuid, 'p4b09-acme-cloud', 'Acme Cloud', 'Acme Cloud Technologies Inc.',
             'COMPANY', 'SAAS_TECHNOLOGY', 'IN', 'Asia/Kolkata', 'INR', $3::uuid,
             '203.0.113.42'::inet, 'Playwright-Test-Agent/1.0'
           )`,
          [verifiedUserAlpha.id, primarySessionId, CORR_ID_1],
        );

        const gucCheck = await tx.query<{ is_super: boolean; current_tid: string | null }>(
          `SELECT public.app_is_super_admin() AS is_super, public.app_current_tenant_id() AS current_tid`,
        );
        expect(gucCheck.rows[0]).toEqual({ is_super: false, current_tid: null });

        return res.rows[0];
      },
    );

    expect(provisioned.tenant_slug).toBe('p4b09-acme-cloud');
    expect(provisioned.tenant_status).toBe('TRIAL');
    expect(provisioned.default_timezone).toBe('Asia/Kolkata');
    expect(provisioned.default_currency).toBe('INR');
    expect(provisioned.created_by_user_id).toBe(verifiedUserAlpha.id);
    expect(provisioned.membership_type).toBe('INTERNAL');
    expect(provisioned.membership_status).toBe('ACTIVE');
    expect(provisioned.is_primary_owner).toBe(true);
    expect(provisioned.onboarding_status).toBe('IN_PROGRESS');
    expect(provisioned.onboarding_current_step).toBe('ORG_PROFILE');
    expect(provisioned.onboarding_version).toBe(1);
    expect(provisioned.bound_session_id).toBe(primarySessionId);
    expect(provisioned.effective_permissions).toEqual(EXPECTED_18_ADMIN_PERMISSIONS);

    // 3. Slug occupancy check now returns `false` to another verified user (with zero metadata leaked),
    // and duplicate registration fails with `23505`
    await txManager.withAuthenticatedUserTransaction(verifiedUserBeta.id, async (tx) => {
      const checkRes = await tx.query<{ available: boolean }>(
        `SELECT public.fn_check_tenant_slug_available('p4b09-acme-cloud') AS available`,
      );
      expect(checkRes.rows[0]).toEqual({ available: false });
    });

    const betaSessionId = await createActiveSessionForUser(verifiedUserBeta.id);
    await expect(
      txManager.withAuthenticatedUserTransaction(verifiedUserBeta.id, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_tenant_provision_organization(
             $1::uuid, $2::uuid, 'p4b09-acme-cloud', 'Copycat', 'Copycat LLC',
             'COMPANY', 'OTHER', 'US', 'UTC', 'USD', $3::uuid
           )`,
          [verifiedUserBeta.id, betaSessionId, CORR_ID_2],
        ),
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // 4. Verify existing tenant context rejection (`app.current_tenant_id` non-null -> 42501 on both routines)
    const acmeCtx = {
      tenantId: provisioned.tenant_id,
      actorUserId: verifiedUserAlpha.id,
      membershipId: provisioned.membership_id,
      correlationId: CORR_ID_1,
    };

    await expect(
      txManager.withVerifiedMemberTransaction(acmeCtx, (tx) =>
        tx.query(`SELECT public.fn_check_tenant_slug_available('p4b09-inside-tenant-tx')`),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      txManager.withVerifiedMemberTransaction(acmeCtx, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_tenant_provision_organization(
             $1::uuid, $2::uuid, 'p4b09-inside-tenant-tx', 'Inside Tx', 'Inside Tx LLC',
             'COMPANY', 'SAAS_TECHNOLOGY', 'US', 'UTC', 'USD', $3::uuid
           )`,
          [verifiedUserAlpha.id, primarySessionId, CORR_ID_1],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // 5. Verify exact roles, permissions, 1:1 companion records, isolated session binding, no duplicate global users, and dual-ledger audits
    const adminPermsDb = await migratorPool.query<{ code: string }>(
      `SELECT p.code
         FROM public.role_permissions rp
         INNER JOIN public.permissions p ON p.id = rp.permission_id
        WHERE rp.tenant_id = $1::uuid AND rp.role_id = $2::uuid
        ORDER BY p.code ASC`,
      [provisioned.tenant_id, provisioned.admin_role_id],
    );
    expect(adminPermsDb.rows.map((r) => r.code)).toEqual(EXPECTED_18_ADMIN_PERMISSIONS);

    const memberPermsDb = await migratorPool.query<{ code: string }>(
      `SELECT p.code
         FROM public.role_permissions rp
         INNER JOIN public.permissions p ON p.id = rp.permission_id
        WHERE rp.tenant_id = $1::uuid AND rp.role_id = $2::uuid
        ORDER BY p.code ASC`,
      [provisioned.tenant_id, provisioned.member_role_id],
    );
    expect(memberPermsDb.rows.map((r) => r.code)).toEqual(EXPECTED_4_MEMBER_PERMISSIONS);

    const companionsRes = await migratorPool.query<{
      org_type: string;
      industry: string;
      country_code: string;
      timezone: string;
      default_currency: string;
      invitation_expiry_hours: number;
      allow_member_directory_view: boolean;
      primary_color_hex: string;
      onboarding_status: string;
      current_step: string;
    }>(
      `SELECT
         tp.organization_type AS org_type,
         tp.industry,
         tp.country_code,
         ts.timezone,
         ts.default_currency,
         ts.invitation_expiry_hours,
         ts.allow_member_directory_view,
         tbs.primary_color_hex,
         tos.onboarding_status,
         tos.current_step
       FROM public.tenants t
       INNER JOIN public.tenant_profiles tp ON tp.tenant_id = t.id
       INNER JOIN public.tenant_settings ts ON ts.tenant_id = t.id
       INNER JOIN public.tenant_branding_settings tbs ON tbs.tenant_id = t.id
       INNER JOIN public.tenant_onboarding_states tos ON tos.tenant_id = t.id
       WHERE t.id = $1::uuid`,
      [provisioned.tenant_id],
    );
    expect(companionsRes.rows[0]).toEqual({
      org_type: 'COMPANY',
      industry: 'SAAS_TECHNOLOGY',
      country_code: 'IN',
      timezone: 'Asia/Kolkata',
      default_currency: 'INR',
      invitation_expiry_hours: 168,
      allow_member_directory_view: false,
      primary_color_hex: '#2563EB',
      onboarding_status: 'IN_PROGRESS',
      current_step: 'ORG_PROFILE',
    });

    // Only `primarySessionId` was bound; `secondaryDeviceSessionId` remained unbound!
    const sessionsRes = await migratorPool.query<{
      id: string;
      active_tenant_id: string | null;
      active_membership_id: string | null;
    }>(
      `SELECT id, active_tenant_id, active_membership_id
         FROM public.auth_sessions
        WHERE id = ANY($1::uuid[])`,
      [[primarySessionId, secondaryDeviceSessionId]],
    );
    const byId = new Map(sessionsRes.rows.map((r) => [r.id, r]));
    expect(byId.get(primarySessionId)).toEqual({
      id: primarySessionId,
      active_tenant_id: provisioned.tenant_id,
      active_membership_id: provisioned.membership_id,
    });
    expect(byId.get(secondaryDeviceSessionId)).toEqual({
      id: secondaryDeviceSessionId,
      active_tenant_id: null,
      active_membership_id: null,
    });

    // Dual-ledger audit verification with identical correlation_id
    const talRes = await migratorPool.query<{
      id: string;
      event_type: string;
      resource_type: string;
      actor_plane: string;
      actor_user_id: string;
      actor_membership_id: string;
      correlation_id: string;
    }>(
      `SELECT id, event_type, resource_type, actor_plane, actor_user_id, actor_membership_id, correlation_id
         FROM public.tenant_audit_logs
        WHERE id = $1::uuid`,
      [provisioned.tenant_audit_log_id],
    );
    expect(talRes.rows[0]).toEqual({
      id: provisioned.tenant_audit_log_id,
      event_type: 'TENANT_REGISTERED',
      resource_type: 'TENANT',
      actor_plane: 'USER_ONBOARDING',
      actor_user_id: verifiedUserAlpha.id,
      actor_membership_id: provisioned.membership_id,
      correlation_id: CORR_ID_1,
    });

    const aalRes = await migratorPool.query<{
      id: string;
      event_type: string;
      actor_user_id: string;
      tenant_id: string;
      session_id: string;
      correlation_id: string;
    }>(
      `SELECT id, event_type, actor_user_id, tenant_id, session_id, correlation_id
         FROM public.auth_audit_logs
        WHERE id = $1::uuid`,
      [provisioned.auth_audit_log_id],
    );
    expect(aalRes.rows[0]).toEqual({
      id: provisioned.auth_audit_log_id,
      event_type: 'TENANT_REGISTERED',
      actor_user_id: verifiedUserAlpha.id,
      tenant_id: provisioned.tenant_id,
      session_id: primarySessionId,
      correlation_id: CORR_ID_1,
    });

    // Global user count for `alpha.founder@p4b09.test` remains strictly 1
    const userCountRes = await migratorPool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM public.users WHERE email = 'alpha.founder@p4b09.test'`,
    );
    expect(userCountRes.rows[0].cnt).toBe('1');
  });

  it('0009-SEC-04: serializes concurrent duplicate-slug races, enforces 5-tenant ownership cap (D2), and serializes 8 parallel burst registrations', async () => {
    // 1. Concurrent duplicate-slug race between Alpha and Beta
    const alphaRaceSession = await createActiveSessionForUser(verifiedUserAlpha.id);
    const betaRaceSession = await createActiveSessionForUser(verifiedUserBeta.id);

    const slugRaceResults = await Promise.allSettled([
      txManager.withAuthenticatedUserTransaction(verifiedUserAlpha.id, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_tenant_provision_organization(
             $1::uuid, $2::uuid, 'p4b09-contested-slug', 'Alpha Contested', 'Alpha Contested LLC',
             'COMPANY', 'SAAS_TECHNOLOGY', 'US', 'UTC', 'USD', $3::uuid
           )`,
          [verifiedUserAlpha.id, alphaRaceSession, CORR_ID_1],
        ),
      ),
      txManager.withAuthenticatedUserTransaction(verifiedUserBeta.id, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_tenant_provision_organization(
             $1::uuid, $2::uuid, 'p4b09-contested-slug', 'Beta Contested', 'Beta Contested LLC',
             'COMPANY', 'SAAS_TECHNOLOGY', 'US', 'UTC', 'USD', $3::uuid
           )`,
          [verifiedUserBeta.id, betaRaceSession, CORR_ID_2],
        ),
      ),
    ]);

    const slugWinners = slugRaceResults.filter((r) => r.status === 'fulfilled');
    const slugLosers = slugRaceResults.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(slugWinners).toHaveLength(1);
    expect(slugLosers).toHaveLength(1);
    expect((slugLosers[0].reason as { code?: string }).code).toBe('23505');

    const contestedCount = await migratorPool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM public.tenants WHERE slug = 'p4b09-contested-slug'`,
    );
    expect(contestedCount.rows[0].cnt).toBe('1');

    // 2. Sequential 5-tenant ownership cap (`D2`) + SUSPENDED still counts + DEACTIVATED frees slot
    const quotaSession = await createActiveSessionForUser(verifiedQuotaUser.id);
    const createdQuotaTenantIds: string[] = [];

    for (let i = 1; i <= 5; i++) {
      const res = await txManager.withAuthenticatedUserTransaction(verifiedQuotaUser.id, (tx) =>
        tx.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM public.fn_tenant_provision_organization(
             $1::uuid, $2::uuid, $3::citext, $4, $5,
             'COMPANY', 'CONSULTING', 'US', 'UTC', 'USD', $6::uuid
           )`,
          [
            verifiedQuotaUser.id,
            quotaSession,
            `p4b09-quota-org-${i}`,
            `Quota Org ${i}`,
            `Quota Org ${i} LLC`,
            CORR_ID_1,
          ],
        ),
      );
      createdQuotaTenantIds.push(res.rows[0].tenant_id);
    }

    // 6th registration fails with 23514 TENANT_CREATION_QUOTA_EXCEEDED
    await expect(
      txManager.withAuthenticatedUserTransaction(verifiedQuotaUser.id, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_tenant_provision_organization(
             $1::uuid, $2::uuid, 'p4b09-quota-org-6', 'Quota Org 6', 'Quota Org 6 LLC',
             'COMPANY', 'CONSULTING', 'US', 'UTC', 'USD', $3::uuid
           )`,
          [verifiedQuotaUser.id, quotaSession, CORR_ID_1],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // Suspending org #1 does NOT allow bypassing the 5-cap (`D2` anti-abuse safeguard)
    await txManager.withPlatformAdminTransaction(superAdminUser.id, (tx) =>
      tx.query(
        `SELECT * FROM public.fn_platform_transition_tenant_status(
           $1::uuid, 'SUSPEND', 'SUSPENDED', 'Compliance hold during quota test', $2::uuid
         )`,
        [createdQuotaTenantIds[0], CORR_ID_1],
      ),
    );

    await expect(
      txManager.withAuthenticatedUserTransaction(verifiedQuotaUser.id, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_tenant_provision_organization(
             $1::uuid, $2::uuid, 'p4b09-quota-org-6b', 'Quota Org 6B', 'Quota Org 6B LLC',
             'COMPANY', 'CONSULTING', 'US', 'UTC', 'USD', $3::uuid
           )`,
          [verifiedQuotaUser.id, quotaSession, CORR_ID_1],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // Deactivating org #1 leaves 4 ACTIVE/TRIAL owned tenants, allowing 1 replacement org
    await txManager.withPlatformAdminTransaction(superAdminUser.id, (tx) =>
      tx.query(
        `SELECT * FROM public.fn_platform_transition_tenant_status(
           $1::uuid, 'DEACTIVATE', 'DEACTIVATED', 'Customer requested workspace deactivation', $2::uuid
         )`,
        [createdQuotaTenantIds[0], CORR_ID_1],
      ),
    );

    const replacementRes = await txManager.withAuthenticatedUserTransaction(
      verifiedQuotaUser.id,
      (tx) =>
        tx.query<{ tenant_status: string }>(
          `SELECT tenant_status FROM public.fn_tenant_provision_organization(
             $1::uuid, $2::uuid, 'p4b09-quota-replacement', 'Quota Replacement', 'Quota Replacement LLC',
             'COMPANY', 'CONSULTING', 'US', 'UTC', 'USD', $3::uuid
           )`,
          [verifiedQuotaUser.id, quotaSession, CORR_ID_1],
        ),
    );
    expect(replacementRes.rows[0].tenant_status).toBe('TRIAL');

    // 3. Parallel 8-way concurrent registration burst serialized via `pg_advisory_xact_lock`
    const burstSessions = await Promise.all(
      Array.from({ length: 8 }, () => createActiveSessionForUser(verifiedConcurrentUser.id)),
    );

    const burstResults = await Promise.allSettled(
      burstSessions.map((sessId, idx) =>
        txManager.withAuthenticatedUserTransaction(verifiedConcurrentUser.id, (tx) =>
          tx.query(
            `SELECT * FROM public.fn_tenant_provision_organization(
               $1::uuid, $2::uuid, $3::citext, $4, $5,
               'AGENCY', 'MARKETING_AGENCY', 'US', 'UTC', 'USD', $6::uuid
             )`,
            [
              verifiedConcurrentUser.id,
              sessId,
              `p4b09-burst-${idx + 1}`,
              `Burst Agency ${idx + 1}`,
              `Burst Agency ${idx + 1} LLC`,
              CORR_ID_2,
            ],
          ),
        ),
      ),
    );

    const burstSuccesses = burstResults.filter((r) => r.status === 'fulfilled');
    const burstFailures = burstResults.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(burstSuccesses).toHaveLength(5);
    expect(burstFailures).toHaveLength(3);
    for (const failure of burstFailures) {
      expect((failure.reason as { code?: string }).code).toBe('23514');
    }

    const burstDbCount = await migratorPool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM public.tenants
        WHERE created_by_user_id = $1::uuid AND status IN ('TRIAL', 'ACTIVE')`,
      [verifiedConcurrentUser.id],
    );
    expect(burstDbCount.rows[0].cnt).toBe('5');
  });

  it('0009-SEC-05: guarantees complete ACID rollback on mid-transaction failure and preserves existing data across 0009 down -> 0009 up', async () => {
    const rollbackSessionId = await createActiveSessionForUser(verifiedUserBeta.id);

    // 1. Trigger a failure AFTER `fn_tenant_provision_organization` executes inside the same transaction
    await expect(
      txManager.withAuthenticatedUserTransaction(verifiedUserBeta.id, async (tx) => {
        await tx.query(
          `SELECT * FROM public.fn_tenant_provision_organization(
             $1::uuid, $2::uuid, 'p4b09-atomic-unwind', 'Atomic Unwind Co', 'Atomic Unwind Legal LLC',
             'COMPANY', 'FINANCE_FINTECH', 'GB', 'Europe/London', 'GBP', $3::uuid
           )`,
          [verifiedUserBeta.id, rollbackSessionId, CORR_ID_ROLLBACK],
        );
        throw new Error('SIMULATED_POST_PROVISION_FAILURE');
      }),
    ).rejects.toThrow('SIMULATED_POST_PROVISION_FAILURE');

    // Verify 0 residual rows across tenants, audit ledgers, and session binding
    const residualCheck = await migratorPool.query<{
      tenant_cnt: string;
      tal_cnt: string;
      aal_cnt: string;
      active_tid: string | null;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM public.tenants WHERE slug = 'p4b09-atomic-unwind') AS tenant_cnt,
         (SELECT COUNT(*)::text FROM public.tenant_audit_logs WHERE correlation_id = $1::uuid) AS tal_cnt,
         (SELECT COUNT(*)::text FROM public.auth_audit_logs WHERE correlation_id = $1::uuid) AS aal_cnt,
         (SELECT active_tenant_id::text FROM public.auth_sessions WHERE id = $2::uuid) AS active_tid`,
      [CORR_ID_ROLLBACK, rollbackSessionId],
    );
    expect(residualCheck.rows[0]).toEqual({
      tenant_cnt: '0',
      tal_cnt: '0',
      aal_cnt: '0',
      active_tid: null,
    });

    // 2. Verify `0009 down` removes ONLY the two 0009 routines without deleting existing tenant or user data
    const preDownCounts = await migratorPool.query<{ tenants_cnt: string; users_cnt: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM public.tenants WHERE slug LIKE 'p4b09-%') AS tenants_cnt,
         (SELECT COUNT(*)::text FROM public.users WHERE email LIKE '%@p4b09.test') AS users_cnt`,
    );
    expect(Number(preDownCounts.rows[0].tenants_cnt)).toBeGreaterThanOrEqual(7);

    const runner = new SqlMigrationRunner(config.database.migratorUrl);
    try {
      expect(await runner.rollbackLatest()).toBe('0009_phase4b_tenant_registration_routines');

      const fnDuringDown = await migratorPool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
           FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace
            AND proname IN ('fn_check_tenant_slug_available', 'fn_tenant_provision_organization')`,
      );
      expect(fnDuringDown.rows[0].cnt).toBe('0');

      const duringDownCounts = await migratorPool.query<{ tenants_cnt: string; users_cnt: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM public.tenants WHERE slug LIKE 'p4b09-%') AS tenants_cnt,
           (SELECT COUNT(*)::text FROM public.users WHERE email LIKE '%@p4b09.test') AS users_cnt`,
      );
      expect(duringDownCounts.rows[0]).toEqual(preDownCounts.rows[0]);

      expect(await runner.migrateUp()).toEqual(['0009_phase4b_tenant_registration_routines']);
    } finally {
      await runner.close();
    }
  });
});
