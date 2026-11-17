import { BadRequestException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import type { RoleEntity, TenantEntity, TenantMembershipEntity } from '@ft360/shared-types';
import { AppModule } from '../../src/app.module';
import { configureNestApp } from '../../src/bootstrap';
import { RedisService } from '../../src/cache/redis.service';
import { APP_CONFIG, loadAppConfig, type AppEnvConfig } from '../../src/config/env.config';
import { DatabasePoolService } from '../../src/database/database-pool.service';
import { SqlMigrationRunner } from '../../src/database/migrations/migration-runner';
import { TenantTransactionManager } from '../../src/database/tenant-transaction.manager';
import { AuthMailOutboxService } from '../../src/modules/auth/auth-mail-outbox.service';
import { AuthRepository } from '../../src/modules/auth/auth.repository';
import { PasswordHashService } from '../../src/modules/auth/password-hash.service';
import { TokenService } from '../../src/modules/auth/token.service';
import { PlatformDirectoryRepository } from '../../src/modules/foundation-db/platform-directory.repository';
import { RbacRepository } from '../../src/modules/foundation-db/rbac.repository';
import { TenantMembershipRepository } from '../../src/modules/foundation-db/tenant-membership.repository';
import { TenantAuditService } from '../../src/modules/tenant-audit/tenant-audit.service';

const CORR_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b94a01';
const SHA256_SAMPLE_A = 'a'.repeat(64);
const SHA256_SAMPLE_B = 'b'.repeat(64);
const SHA256_SAMPLE_C = 'c'.repeat(64);

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

describe('Phase 4 Stage 4A — Database Foundation, Concurrency Locks, RLS & TenantAuditModule Integration Suite', () => {
  let app: INestApplication;
  let config: AppEnvConfig;
  let dbPool: DatabasePoolService;
  let redisService: RedisService;
  let txManager: TenantTransactionManager;
  let mailOutbox: AuthMailOutboxService;
  let authRepo: AuthRepository;
  let passwordHashService: PasswordHashService;
  let tokenService: TokenService;
  let platformRepo: PlatformDirectoryRepository;
  let membershipRepo: TenantMembershipRepository;
  let rbacRepo: RbacRepository;
  let tenantAuditService: TenantAuditService;

  let superAdminUserId: string;
  let alphaOwnerUserId: string;
  let alphaSecondAdminUserId: string;
  let alphaStandardMemberUserId: string;
  let betaOwnerUserId: string;

  let tenantAlpha: TenantEntity;
  let tenantBeta: TenantEntity;

  let memberAlphaOwner: TenantMembershipEntity;
  let memberAlphaSecondAdmin: TenantMembershipEntity;
  let memberAlphaStandard: TenantMembershipEntity;
  let memberBetaOwner: TenantMembershipEntity;

  let roleAlphaAdmin: RoleEntity;
  let roleAlphaMember: RoleEntity;
  let roleBetaAdmin: RoleEntity;

  const USER_PW = 'Stage4A#Secure2026!Ok';

  async function cleanStage4AFixtures(migratorUrl: string): Promise<void> {
    const cleanupPool = new Pool({ connectionString: migratorUrl, max: 1 });
    try {
      const regRes = await cleanupPool.query<{ exists: boolean }>(
        `SELECT to_regclass('public.tenant_audit_logs') IS NOT NULL AS exists`,
      );
      if (regRes.rows[0]?.exists) {
        await cleanupPool.query(
          `DELETE FROM public.tenant_audit_logs
            WHERE tenant_id IN (SELECT id FROM public.tenants WHERE slug LIKE 'p4a-%')`,
        );
      }
      await cleanupPool.query(`DELETE FROM public.tenants WHERE slug LIKE 'p4a-%'`);
      await cleanupPool.query(`DELETE FROM public.users WHERE lower(email::text) LIKE '%@phase4a.test'`);
    } finally {
      await cleanupPool.end();
    }
  }

  async function createVerifiedUserViaDb(fullName: string, email: string): Promise<string> {
    const passwordHash = await passwordHashService.hashPassword(USER_PW);
    const secret = tokenService.generateOpaqueSecret();
    const reg = await authRepo.registerPendingUser({
      email,
      passwordHash,
      fullName,
      phoneE164: null,
      verifyTokenHash: secret.tokenHashHex,
      verifyTtlSeconds: 900,
      requestedIp: '127.0.0.1',
    });
    await authRepo.consumeEmailVerificationToken(secret.tokenHashHex);
    return reg.id;
  }

  beforeAll(async () => {
    config = loadAppConfig();

    // =========================================================================
    // DB-P4-01: Verify Migrations 0007 & 0008 Up -> Rollback -> Re-Up Cleanly
    // =========================================================================
    const runner = new SqlMigrationRunner(config.database.migratorUrl);
    const migratorCheckPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
    try {
      await runner.migrateUp();

      expect(await runner.rollbackLatest()).toBe(
        '0009_phase4b_tenant_registration_routines',
      );
      expect(await runner.rollbackLatest()).toBe(
        '0008_phase4_invitations_outbox_and_integrity_routines',
      );
      expect(await runner.rollbackLatest()).toBe(
        '0007_phase4_tenant_core_schema_and_audit',
      );

      // Confirm all 7 Phase 4 tables and 10 new permissions are cleanly removed after rollback to 0006
      const postRollbackTables = await migratorCheckPool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND tablename LIKE 'tenant\\_%' ESCAPE '\\'
          ORDER BY tablename ASC`,
      );
      expect(postRollbackTables.rows.map((r) => r.tablename)).toEqual(['tenant_memberships']);

      const postRollbackPerms = await migratorCheckPool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM public.permissions`,
      );
      expect(postRollbackPerms.rows[0].cnt).toBe('14');

      // Re-apply 0007, 0008, and 0009 cleanly
      expect(await runner.migrateUp()).toEqual([
        '0007_phase4_tenant_core_schema_and_audit',
        '0008_phase4_invitations_outbox_and_integrity_routines',
        '0009_phase4b_tenant_registration_routines',
      ]);
    } finally {
      await migratorCheckPool.end();
      await runner.close();
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue({
        ...config,
        corsAllowedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
        database: { ...config.database, poolMin: 1, poolMax: 8 },
        auth: {
          ...config.auth,
          argon2MemoryCostKiB: 19456,
          argon2TimeCost: 2,
          argon2Parallelism: 2,
          rateLimitIpBurstMax: 500,
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
    redisService = app.get(RedisService);
    txManager = app.get(TenantTransactionManager);
    mailOutbox = app.get(AuthMailOutboxService);
    authRepo = app.get(AuthRepository);
    passwordHashService = app.get(PasswordHashService);
    tokenService = app.get(TokenService);
    platformRepo = app.get(PlatformDirectoryRepository);
    membershipRepo = app.get(TenantMembershipRepository);
    rbacRepo = app.get(RbacRepository);
    tenantAuditService = app.get(TenantAuditService);

    await cleanStage4AFixtures(config.database.migratorUrl);

    const saHash = await passwordHashService.hashPassword(USER_PW);
    const sa = await txManager.withSystemBootstrapTransaction((tx) =>
      platformRepo.createUser(tx, {
        email: 'root.superadmin@phase4a.test',
        passwordHash: saHash,
        fullName: 'Stage 4A Root Super Admin',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        emailVerified: true,
      }),
    );
    superAdminUserId = sa.id;

    alphaOwnerUserId = await createVerifiedUserViaDb('Alpha Primary Owner', 'alpha.owner@phase4a.test');
    alphaSecondAdminUserId = await createVerifiedUserViaDb('Alpha Secondary Admin', 'alpha.admin2@phase4a.test');
    alphaStandardMemberUserId = await createVerifiedUserViaDb('Alpha Standard Member', 'alpha.member@phase4a.test');
    betaOwnerUserId = await createVerifiedUserViaDb('Beta Primary Owner', 'beta.owner@phase4a.test');

    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      tenantAlpha = await platformRepo.createTenant(tx, {
        slug: 'p4a-alpha',
        legalName: 'Phase 4A Alpha Cloud Pvt Ltd',
        displayName: 'Alpha Cloud',
        status: 'ACTIVE',
        defaultTimezone: 'Asia/Kolkata',
        defaultCurrency: 'INR',
      });
      tenantBeta = await platformRepo.createTenant(tx, {
        slug: 'p4a-beta',
        legalName: 'Phase 4A Beta Systems LLC',
        displayName: 'Beta Systems',
        status: 'TRIAL',
        defaultTimezone: 'UTC',
        defaultCurrency: 'USD',
      });

      memberAlphaOwner = await membershipRepo.createMembership(tx, {
        tenantId: tenantAlpha.id,
        userId: alphaOwnerUserId,
        membershipType: 'INTERNAL',
        status: 'ACTIVE',
        jobTitle: 'Founder',
      });
      await tx.query(
        `UPDATE public.tenant_memberships SET is_primary_owner = TRUE WHERE tenant_id = $1 AND id = $2`,
        [tenantAlpha.id, memberAlphaOwner.id],
      );

      memberBetaOwner = await membershipRepo.createMembership(tx, {
        tenantId: tenantBeta.id,
        userId: betaOwnerUserId,
        membershipType: 'INTERNAL',
        status: 'ACTIVE',
        jobTitle: 'CEO',
      });
      await tx.query(
        `UPDATE public.tenant_memberships SET is_primary_owner = TRUE WHERE tenant_id = $1 AND id = $2`,
        [tenantBeta.id, memberBetaOwner.id],
      );
    });

    // Seed roles & assignments in Tenant Alpha and Tenant Beta
    await txManager.withVerifiedMemberTransaction(
      {
        tenantId: tenantAlpha.id,
        actorUserId: alphaOwnerUserId,
        membershipId: memberAlphaOwner.id,
        correlationId: CORR_ID,
      },
      async (tx) => {
        memberAlphaSecondAdmin = await membershipRepo.createMembership(tx, {
          tenantId: tenantAlpha.id,
          userId: alphaSecondAdminUserId,
          membershipType: 'INTERNAL',
          status: 'ACTIVE',
        });
        memberAlphaStandard = await membershipRepo.createMembership(tx, {
          tenantId: tenantAlpha.id,
          userId: alphaStandardMemberUserId,
          membershipType: 'INTERNAL',
          status: 'ACTIVE',
        });

        roleAlphaAdmin = await rbacRepo.createRole(tx, {
          tenantId: tenantAlpha.id,
          slug: 'tenant_admin',
          name: 'Tenant Administrator',
          isSystemRole: true,
          dataAccessScope: 'TENANT',
        });
        roleAlphaMember = await rbacRepo.createRole(tx, {
          tenantId: tenantAlpha.id,
          slug: 'member',
          name: 'Standard Member',
          isSystemRole: true,
          dataAccessScope: 'OWN',
        });

        const tenantPerms = await tx.query<{ id: string; code: string }>(
          `SELECT id, code FROM public.permissions WHERE scope_plane = 'TENANT'`,
        );
        for (const p of tenantPerms.rows) {
          await rbacRepo.grantPermissionToRole(tx, {
            tenantId: tenantAlpha.id,
            roleId: roleAlphaAdmin.id,
            permissionId: p.id,
          });
          if (
            ['tenant:organization:read', 'tenant:settings:read', 'tenant:branding:read', 'tenant:members:read'].includes(
              p.code,
            )
          ) {
            await rbacRepo.grantPermissionToRole(tx, {
              tenantId: tenantAlpha.id,
              roleId: roleAlphaMember.id,
              permissionId: p.id,
            });
          }
        }

        await rbacRepo.assignRoleToMembership(tx, {
          tenantId: tenantAlpha.id,
          membershipId: memberAlphaOwner.id,
          roleId: roleAlphaAdmin.id,
        });
        await rbacRepo.assignRoleToMembership(tx, {
          tenantId: tenantAlpha.id,
          membershipId: memberAlphaSecondAdmin.id,
          roleId: roleAlphaAdmin.id,
        });
        await rbacRepo.assignRoleToMembership(tx, {
          tenantId: tenantAlpha.id,
          membershipId: memberAlphaStandard.id,
          roleId: roleAlphaMember.id,
        });

        // Seed Tenant Alpha 1:1 records & branding asset
        await tx.query(
          `INSERT INTO public.tenant_onboarding_states (tenant_id) VALUES ($1)`,
          [tenantAlpha.id],
        );
        await tx.query(
          `INSERT INTO public.tenant_profiles (tenant_id, organization_type, industry, country_code)
           VALUES ($1, 'COMPANY', 'SAAS_TECHNOLOGY', 'IN')`,
          [tenantAlpha.id],
        );
        await tx.query(
          `INSERT INTO public.tenant_settings (tenant_id, timezone, default_currency)
           VALUES ($1, 'Asia/Kolkata', 'INR')`,
          [tenantAlpha.id],
        );
        await tx.query(
          `INSERT INTO public.tenant_branding_settings (tenant_id, brand_display_name)
           VALUES ($1, 'Alpha Cloud Brand')`,
          [tenantAlpha.id],
        );
      },
    );

    await txManager.withVerifiedMemberTransaction(
      {
        tenantId: tenantBeta.id,
        actorUserId: betaOwnerUserId,
        membershipId: memberBetaOwner.id,
        correlationId: CORR_ID,
      },
      async (tx) => {
        roleBetaAdmin = await rbacRepo.createRole(tx, {
          tenantId: tenantBeta.id,
          slug: 'tenant_admin',
          name: 'Tenant Administrator',
          isSystemRole: true,
          dataAccessScope: 'TENANT',
        });
        const tenantPerms = await tx.query<{ id: string }>(
          `SELECT id FROM public.permissions WHERE scope_plane = 'TENANT'`,
        );
        for (const p of tenantPerms.rows) {
          await rbacRepo.grantPermissionToRole(tx, {
            tenantId: tenantBeta.id,
            roleId: roleBetaAdmin.id,
            permissionId: p.id,
          });
        }
        await rbacRepo.assignRoleToMembership(tx, {
          tenantId: tenantBeta.id,
          membershipId: memberBetaOwner.id,
          roleId: roleBetaAdmin.id,
        });

        await tx.query(
          `INSERT INTO public.tenant_onboarding_states (tenant_id) VALUES ($1)`,
          [tenantBeta.id],
        );
        await tx.query(
          `INSERT INTO public.tenant_profiles (tenant_id, organization_type, industry, country_code)
           VALUES ($1, 'COMPANY', 'CONSULTING', 'US')`,
          [tenantBeta.id],
        );
        await tx.query(
          `INSERT INTO public.tenant_settings (tenant_id, timezone, default_currency)
           VALUES ($1, 'UTC', 'USD')`,
          [tenantBeta.id],
        );
        await tx.query(
          `INSERT INTO public.tenant_branding_settings (tenant_id, brand_display_name)
           VALUES ($1, 'Beta Brand')`,
          [tenantBeta.id],
        );
      },
    );
  });

  afterAll(async () => {
    try {
      await cleanStage4AFixtures(config.database.migratorUrl);
    } finally {
      if (app) {
        await app.close();
      }
    }
  });

  it('DB-P4-02 & SEC-P4-13: verifies all 22 public tables have ft360_migrator ownership + FORCE RLS, 24 canonical permissions, and least-privilege grants (no token_hash SELECT, no direct audit writes)', async () => {
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

    expect(tablesRes.rows).toHaveLength(22);
    for (const row of tablesRes.rows) {
      expect(row.tableowner).toBe('ft360_migrator');
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }

    // Verify 24 canonical permissions (5 PLATFORM + 18 TENANT + 1 PORTAL)
    const perms = await txManager.withPlatformAdminTransaction(superAdminUserId, (tx) =>
      platformRepo.listPermissions(tx),
    );
    expect(perms).toHaveLength(24);
    expect(perms.map((p) => p.code)).toEqual(
      expect.arrayContaining([
        'tenant:settings:read',
        'tenant:settings:manage',
        'tenant:branding:read',
        'tenant:branding:manage',
        'tenant:roles:assign',
        'tenant:invitations:read',
        'tenant:invitations:manage',
        'tenant:admins:read',
        'tenant:admins:manage',
        'audit:tenant:read',
      ]),
    );

    // Verify ft360_app cannot SELECT token_hash on tenant_invitations (42501)
    await expect(
      dbPool.queryUnscoped(`SELECT token_hash FROM public.tenant_invitations`),
    ).rejects.toMatchObject({ code: '42501' });

    // Verify ft360_app has zero direct INSERT, UPDATE, or DELETE privilege on tenant_audit_logs (42501)
    await expect(
      txManager.withVerifiedMemberTransaction(
        {
          tenantId: tenantAlpha.id,
          actorUserId: alphaOwnerUserId,
          membershipId: memberAlphaOwner.id,
          correlationId: CORR_ID,
        },
        (tx) =>
          tx.query(
            `INSERT INTO public.tenant_audit_logs (
               tenant_id, event_type, resource_type, outcome, actor_plane, correlation_id
             ) VALUES ($1, 'FORGED', 'TENANT', 'SUCCESS', 'TENANT', $2)`,
            [tenantAlpha.id, CORR_ID],
          ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Verify DELETE privilege is omitted on 1:1 companion & asset tables (42501)
    for (const table of [
      'tenant_onboarding_states',
      'tenant_profiles',
      'tenant_settings',
      'tenant_branding_assets',
      'tenant_branding_settings',
    ]) {
      await expect(
        txManager.withPlatformAdminTransaction(superAdminUserId, (tx) =>
          tx.query(`DELETE FROM public.${table}`),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('DB-P4-03 & SEC-P4-08: rejects cross-tenant composite foreign key violations (23503) and SVG/path-traversal branding asset constraints (23514) even under migrator role', async () => {
    const migratorPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
    try {
      // Seed a valid asset in Tenant Beta
      const betaAssetRes = await migratorPool.query<{ id: string }>(
        `INSERT INTO public.tenant_branding_assets (
           tenant_id, asset_kind, storage_key, original_filename, mime_type,
           byte_size, sha256_checksum, width_px, height_px, uploaded_by_membership_id
         ) VALUES ($1, 'LOGO_LIGHT', $2, 'logo.png', 'image/png', 1024, $3, 256, 256, $4)
         RETURNING id`,
        [
          tenantBeta.id,
          `tenants/${tenantBeta.id}/branding/LOGO_LIGHT/beta-logo.png`,
          SHA256_SAMPLE_A,
          memberBetaOwner.id,
        ],
      );
      const betaAssetId = betaAssetRes.rows[0].id;

      // 1. tenant_onboarding_states: Alpha tenant + Beta membership -> 23503
      await expect(
        migratorPool.query(
          `UPDATE public.tenant_onboarding_states SET completed_by_membership_id = $2 WHERE tenant_id = $1`,
          [tenantAlpha.id, memberBetaOwner.id],
        ),
      ).rejects.toMatchObject({ code: '23503', constraint: 'fk_tos_completed_by_membership' });

      // 2. tenant_profiles: Alpha tenant + Beta membership -> 23503
      await expect(
        migratorPool.query(
          `UPDATE public.tenant_profiles SET updated_by_membership_id = $2 WHERE tenant_id = $1`,
          [tenantAlpha.id, memberBetaOwner.id],
        ),
      ).rejects.toMatchObject({ code: '23503', constraint: 'fk_tenant_profiles_updated_by' });

      // 3. tenant_settings: Alpha tenant + Beta membership -> 23503
      await expect(
        migratorPool.query(
          `UPDATE public.tenant_settings SET updated_by_membership_id = $2 WHERE tenant_id = $1`,
          [tenantAlpha.id, memberBetaOwner.id],
        ),
      ).rejects.toMatchObject({ code: '23503', constraint: 'fk_tenant_settings_updated_by' });

      // 4. tenant_branding_settings: Alpha tenant + Beta logo_light_asset_id -> 23503
      await expect(
        migratorPool.query(
          `UPDATE public.tenant_branding_settings SET logo_light_asset_id = $2 WHERE tenant_id = $1`,
          [tenantAlpha.id, betaAssetId],
        ),
      ).rejects.toMatchObject({ code: '23503', constraint: 'fk_tbs_logo_light' });

      // 5. tenant_invitations: Alpha tenant + Beta target_role_id -> 23503
      await expect(
        migratorPool.query(
          `INSERT INTO public.tenant_invitations (
             tenant_id, invited_email, target_role_id, token_hash, expires_at
           ) VALUES ($1, 'crossfk@phase4a.test', $2, $3, NOW() + interval '7 days')`,
          [tenantAlpha.id, roleBetaAdmin.id, SHA256_SAMPLE_A],
        ),
      ).rejects.toMatchObject({ code: '23503', constraint: 'fk_ti_target_role' });

      // 6. tenant_audit_logs: Alpha tenant + Beta actor_membership_id -> 23503
      await expect(
        migratorPool.query(
          `INSERT INTO public.tenant_audit_logs (
             tenant_id, event_type, resource_type, outcome, actor_plane, actor_membership_id, correlation_id
           ) VALUES ($1, 'TEST', 'PROFILE', 'SUCCESS', 'TENANT', $2, $3)`,
          [tenantAlpha.id, memberBetaOwner.id, CORR_ID],
        ),
      ).rejects.toMatchObject({ code: '23503', constraint: 'fk_tal_actor_membership' });

      // 7. Branding asset check constraints: SVG mime_type (23514), path traversal / wrong tenant prefix (23514), pixel bomb (23514)
      await expect(
        migratorPool.query(
          `INSERT INTO public.tenant_branding_assets (
             tenant_id, asset_kind, storage_key, original_filename, mime_type,
             byte_size, sha256_checksum, width_px, height_px
           ) VALUES ($1, 'LOGO_LIGHT', $2, 'xss.svg', 'image/svg+xml', 512, $3, 128, 128)`,
          [tenantAlpha.id, `tenants/${tenantAlpha.id}/branding/LOGO_LIGHT/xss.svg`, SHA256_SAMPLE_B],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'chk_tba_mime_allowlist' });

      await expect(
        migratorPool.query(
          `INSERT INTO public.tenant_branding_assets (
             tenant_id, asset_kind, storage_key, original_filename, mime_type,
             byte_size, sha256_checksum, width_px, height_px
           ) VALUES ($1, 'LOGO_LIGHT', $2, 'logo.png', 'image/png', 512, $3, 128, 128)`,
          [tenantAlpha.id, `tenants/${tenantBeta.id}/branding/LOGO_LIGHT/other.png`, SHA256_SAMPLE_B],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'chk_tba_storage_prefix' });

      await expect(
        migratorPool.query(
          `INSERT INTO public.tenant_branding_assets (
             tenant_id, asset_kind, storage_key, original_filename, mime_type,
             byte_size, sha256_checksum, width_px, height_px
           ) VALUES ($1, 'LOGO_LIGHT', $2, 'bomb.png', 'image/png', 1024, $3, 4096, 4096)`,
          [tenantAlpha.id, `tenants/${tenantAlpha.id}/branding/LOGO_LIGHT/bomb.png`, SHA256_SAMPLE_B],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'chk_tba_dimension_and_pixel_bounds' });
    } finally {
      await migratorPool.end();
    }
  });

  it('RLS-P4-01..06: enforces fail-closed missing-context denial and strict cross-tenant isolation across all 7 Phase 4 tables', async () => {
    const phase4Tables: Array<{ name: string; pkCol: string }> = [
      { name: 'tenant_onboarding_states', pkCol: 'tenant_id' },
      { name: 'tenant_profiles', pkCol: 'tenant_id' },
      { name: 'tenant_settings', pkCol: 'tenant_id' },
      { name: 'tenant_branding_assets', pkCol: 'id' },
      { name: 'tenant_branding_settings', pkCol: 'tenant_id' },
      { name: 'tenant_invitations', pkCol: 'id' },
      { name: 'tenant_audit_logs', pkCol: 'id' },
    ];

    // 1. Missing GUC context returns 0 rows on every Phase 4 table
    for (const tbl of phase4Tables) {
      const res = await dbPool.queryUnscoped(`SELECT ${tbl.pkCol} FROM public.${tbl.name}`);
      expect(res.rows).toHaveLength(0);
    }

    // 2. Tenant Alpha sees ONLY Tenant Alpha rows and CANNOT read or mutate Tenant Beta rows
    await txManager.withVerifiedMemberTransaction(
      {
        tenantId: tenantAlpha.id,
        actorUserId: alphaOwnerUserId,
        membershipId: memberAlphaOwner.id,
        correlationId: CORR_ID,
      },
      async (tx) => {
        for (const tbl of [
          'tenant_onboarding_states',
          'tenant_profiles',
          'tenant_settings',
          'tenant_branding_settings',
        ]) {
          const rows = await tx.query<{ tenant_id: string }>(`SELECT tenant_id FROM public.${tbl}`);
          expect(rows.rows).toEqual([{ tenant_id: tenantAlpha.id }]);

          const crossUpdate = await tx.query(
            `UPDATE public.${tbl} SET version = version + 1 WHERE tenant_id = $1`,
            [tenantBeta.id],
          );
          expect(crossUpdate.rowCount).toBe(0);
        }

        // Check default D3 (168h) & D4 (allow_member_directory_view = false)
        const settingsRes = await tx.query<{
          invitation_expiry_hours: number;
          allow_member_directory_view: boolean;
        }>(
          `SELECT invitation_expiry_hours, allow_member_directory_view
             FROM public.tenant_settings
            WHERE tenant_id = $1`,
          [tenantAlpha.id],
        );
        expect(settingsRes.rows[0]).toEqual({
          invitation_expiry_hours: 168,
          allow_member_directory_view: false,
        });
      },
    );

    // Cross-tenant INSERT from Tenant Alpha targeting Tenant Beta aborts transaction with 42501
    await expect(
      txManager.withVerifiedMemberTransaction(
        {
          tenantId: tenantAlpha.id,
          actorUserId: alphaOwnerUserId,
          membershipId: memberAlphaOwner.id,
          correlationId: CORR_ID,
        },
        (tx) =>
          tx.query(
            `INSERT INTO public.tenant_profiles (tenant_id, organization_type, industry, country_code)
             VALUES ($1, 'COMPANY', 'OTHER', 'US')`,
            [tenantBeta.id],
          ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('DB-P4-04, SEC-P4-04 & SEC-P4-17: enforces primary ownership uniqueness, concurrent ownership transfer serialization, sole-admin protection, and concurrent 2-admin removal serialization', async () => {
    const alphaOwnerCtx = {
      tenantId: tenantAlpha.id,
      actorUserId: alphaOwnerUserId,
      membershipId: memberAlphaOwner.id,
      correlationId: CORR_ID,
    };
    const alphaAdmin2Ctx = {
      tenantId: tenantAlpha.id,
      actorUserId: alphaSecondAdminUserId,
      membershipId: memberAlphaSecondAdmin.id,
      correlationId: CORR_ID,
    };

    // 1. Direct SQL mutation of `is_primary_owner` by ft360_app is blocked by trigger (42501)
    await expect(
      txManager.withVerifiedMemberTransaction(alphaAdmin2Ctx, (tx) =>
        tx.query(
          `UPDATE public.tenant_memberships SET is_primary_owner = TRUE WHERE id = $1`,
          [memberAlphaSecondAdmin.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // 2. Partial unique index `uq_tenant_memberships_primary_owner` rejects 2 active primary owners even under migrator (23505)
    const migratorPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
    try {
      await expect(
        migratorPool.query(
          `UPDATE public.tenant_memberships SET is_primary_owner = TRUE WHERE id = $1`,
          [memberAlphaSecondAdmin.id],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    } finally {
      await migratorPool.end();
    }

    // 3. External (`CLIENT_PORTAL` / `PARTNER`) memberships cannot be assigned `tenant_admin` (42501)
    const portalUserId = await createVerifiedUserViaDb('Portal User', 'portal.ext@phase4a.test');
    await expect(
      txManager.withVerifiedMemberTransaction(alphaOwnerCtx, async (tx) => {
        const portalMember = await membershipRepo.createMembership(tx, {
          tenantId: tenantAlpha.id,
          userId: portalUserId,
          membershipType: 'CLIENT_PORTAL',
          status: 'ACTIVE',
        });
        await rbacRepo.assignRoleToMembership(tx, {
          tenantId: tenantAlpha.id,
          membershipId: portalMember.id,
          roleId: roleAlphaAdmin.id,
        });
      }),
    ).rejects.toMatchObject({ code: '42501' });

    // 4. Secondary admin CANNOT transfer primary ownership (42501 PRIMARY_OWNER_REQUIRED)
    await expect(
      txManager.withVerifiedMemberTransaction(alphaAdmin2Ctx, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_tenant_transfer_primary_owner($1::uuid, $2::uuid, $3, $4::uuid)`,
          [
            tenantAlpha.id,
            memberAlphaSecondAdmin.id,
            'Unauthorized hijack attempt by secondary admin',
            CORR_ID,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // 5. Concurrent Primary Ownership Transfer Race across 2 parallel transactions:
    // Promote memberAlphaStandard to a 3rd admin temporarily so Owner races transfer to Admin2 vs Admin3 simultaneously!
    await txManager.withVerifiedMemberTransaction(alphaOwnerCtx, (tx) =>
      rbacRepo.assignRoleToMembership(tx, {
        tenantId: tenantAlpha.id,
        membershipId: memberAlphaStandard.id,
        roleId: roleAlphaAdmin.id,
      }),
    );

    const transferRace = await Promise.allSettled([
      txManager.withVerifiedMemberTransaction(alphaOwnerCtx, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_tenant_transfer_primary_owner($1::uuid, $2::uuid, $3, $4::uuid)`,
          [
            tenantAlpha.id,
            memberAlphaSecondAdmin.id,
            'Concurrent transfer target B reason valid',
            CORR_ID,
          ],
        ),
      ),
      txManager.withVerifiedMemberTransaction(alphaOwnerCtx, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_tenant_transfer_primary_owner($1::uuid, $2::uuid, $3, $4::uuid)`,
          [
            tenantAlpha.id,
            memberAlphaStandard.id,
            'Concurrent transfer target C reason valid',
            CORR_ID,
          ],
        ),
      ),
    ]);

    const fulfilledTransfers = transferRace.filter((r) => r.status === 'fulfilled');
    const rejectedTransfers = transferRace.filter((r) => r.status === 'rejected');
    expect(fulfilledTransfers).toHaveLength(1);
    expect(rejectedTransfers).toHaveLength(1);

    // Confirm strictly 1 active primary owner exists after concurrent transfer race, then restore to memberAlphaOwner via Platform break-glass recovery
    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      const owners = await tx.query<{ id: string }>(
        `SELECT id FROM public.tenant_memberships
          WHERE tenant_id = $1 AND is_primary_owner = TRUE AND status = 'ACTIVE'`,
        [tenantAlpha.id],
      );
      expect(owners.rows).toHaveLength(1);

      await tx.query(
        `SELECT * FROM public.fn_tenant_transfer_primary_owner($1::uuid, $2::uuid, $3, $4::uuid)`,
        [
          tenantAlpha.id,
          memberAlphaOwner.id,
          'Break-glass restore primary ownership to founder',
          CORR_ID,
        ],
      );
    });

    // Remove temporary admin role from memberAlphaStandard -> now Tenant Alpha has EXACTLY 2 admins (memberAlphaOwner & memberAlphaSecondAdmin)
    await txManager.withVerifiedMemberTransaction(alphaOwnerCtx, (tx) =>
      tx.query(
        `DELETE FROM public.user_role_assignments WHERE tenant_id = $1 AND membership_id = $2 AND role_id = $3`,
        [tenantAlpha.id, memberAlphaStandard.id, roleAlphaAdmin.id],
      ),
    );

    // 6. SEC-P4-17: Concurrent 2-Admin Mutual Removal Race!
    // Tx 1 demotes Admin 2 (`DELETE FROM user_role_assignments`) AT THE EXACT SAME INSTANT
    // Tx 2 suspends Admin 1 (`UPDATE tenant_memberships SET status = 'SUSPENDED'`)!
    // Parent-row `SELECT ... FROM public.tenants FOR UPDATE` MUST serialize them so 1 commits and 1 aborts (42501)!
    const adminRace = await Promise.allSettled([
      txManager.withVerifiedMemberTransaction(alphaOwnerCtx, (tx) =>
        tx.query(
          `DELETE FROM public.user_role_assignments
            WHERE tenant_id = $1 AND membership_id = $2 AND role_id = $3`,
          [tenantAlpha.id, memberAlphaSecondAdmin.id, roleAlphaAdmin.id],
        ),
      ),
      txManager.withVerifiedMemberTransaction(alphaAdmin2Ctx, (tx) =>
        tx.query(
          `UPDATE public.tenant_memberships
              SET status = 'SUSPENDED', is_primary_owner = FALSE, suspended_at = NOW()
            WHERE tenant_id = $1 AND id = $2`,
          [tenantAlpha.id, memberAlphaOwner.id],
        ),
      ),
    ]);

    const adminRaceFulfilled = adminRace.filter((r) => r.status === 'fulfilled');
    const adminRaceRejected = adminRace.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(adminRaceFulfilled).toHaveLength(1);
    expect(adminRaceRejected).toHaveLength(1);
    expect(adminRaceRejected[0].reason).toMatchObject({ code: '42501' });

    // Verify Tenant Alpha STILL has >= 1 active INTERNAL tenant_admin, and sole remaining admin CANNOT be removed!
    const verifyPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
    try {
      const remaining = await verifyPool.query<{ membership_id: string }>(
        `SELECT ura.membership_id
           FROM public.user_role_assignments ura
           INNER JOIN public.roles r ON r.tenant_id = ura.tenant_id AND r.id = ura.role_id
           INNER JOIN public.tenant_memberships tm ON tm.tenant_id = ura.tenant_id AND tm.id = ura.membership_id
          WHERE ura.tenant_id = $1
            AND r.slug = 'tenant_admin'::citext
            AND tm.status = 'ACTIVE'
            AND tm.membership_type = 'INTERNAL'`,
        [tenantAlpha.id],
      );
      expect(remaining.rows).toHaveLength(1);
      const soleAdminMembershipId = remaining.rows[0].membership_id;

      // Attempting to remove or suspend the sole remaining admin fails with 42501 even under migrator!
      await expect(
        verifyPool.query(
          `DELETE FROM public.user_role_assignments
            WHERE tenant_id = $1 AND membership_id = $2 AND role_id = $3`,
          [tenantAlpha.id, soleAdminMembershipId, roleAlphaAdmin.id],
        ),
      ).rejects.toMatchObject({ code: '42501' });

      // Restore both admins & primary owner for subsequent tests
      await verifyPool.query(
        `UPDATE public.tenant_memberships
            SET status = 'ACTIVE', suspended_at = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [tenantAlpha.id, memberAlphaOwner.id],
      );
      await verifyPool.query(
        `INSERT INTO public.user_role_assignments (tenant_id, membership_id, role_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, membership_id, role_id) DO NOTHING`,
        [tenantAlpha.id, memberAlphaSecondAdmin.id, roleAlphaAdmin.id],
      );
      await verifyPool.query(
        `UPDATE public.tenant_memberships SET is_primary_owner = FALSE
          WHERE tenant_id = $1 AND is_primary_owner = TRUE`,
        [tenantAlpha.id],
      );
      await verifyPool.query(
        `UPDATE public.tenant_memberships SET is_primary_owner = TRUE
          WHERE tenant_id = $1 AND id = $2`,
        [tenantAlpha.id, memberAlphaOwner.id],
      );
    } finally {
      await verifyPool.end();
    }
  });

  it('DB-P4-06, DB-P4-07, SEC-P4-19 & SEC-P4-20: enforces concurrent duplicate global email uniqueness (23505/409) and strict invitation initiator vs. recipient separation', async () => {
    // 1. Concurrent Duplicate Global Email Registration Race across 4 parallel requests with mixed case/whitespace
    const raceResults = await Promise.all([
      request(app.getHttpServer()).post('/api/v1/auth/register').send({
        fullName: 'Race Candidate 1',
        email: 'Concurrent.Global@phase4a.test',
        password: USER_PW,
      }),
      request(app.getHttpServer()).post('/api/v1/auth/register').send({
        fullName: 'Race Candidate 2',
        email: 'CONCURRENT.GLOBAL@PHASE4A.TEST',
        password: USER_PW,
      }),
      request(app.getHttpServer()).post('/api/v1/auth/register').send({
        fullName: 'Race Candidate 3',
        email: 'concurrent.global@phase4a.test',
        password: USER_PW,
      }),
    ]);

    const createdCount = raceResults.filter((r) => r.status === 201).length;
    const conflictCount = raceResults.filter((r) => r.status === 409).length;
    expect(createdCount).toBe(1);
    expect(conflictCount).toBe(2);

    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      const countRes = await tx.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
           FROM public.users
          WHERE lower(btrim(email::text)) = 'concurrent.global@phase4a.test'`,
      );
      expect(countRes.rows[0].cnt).toBe('1');
    });

    // 2. Initiator vs. Recipient Separation in `tenant_invitations` and `auth_email_outbox`
    const migratorPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
    try {
      // (a) PENDING invitation cannot pre-bind accepted_by_user_id (23514 chk_ti_pending_recipient_unbound)
      await expect(
        migratorPool.query(
          `INSERT INTO public.tenant_invitations (
             tenant_id, invited_email, target_role_id, token_hash, status, expires_at,
             invited_by_user_id, accepted_by_user_id
           ) VALUES ($1, 'pending.bound@phase4a.test', $2, $3, 'PENDING', NOW() + interval '7 days', $4, $5)`,
          [
            tenantAlpha.id,
            roleAlphaMember.id,
            SHA256_SAMPLE_B,
            alphaOwnerUserId,
            alphaStandardMemberUserId,
          ],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'chk_ti_pending_recipient_unbound' });

      // (b) ACCEPTED invitation cannot set accepted_by_user_id = invited_by_user_id (23514 chk_ti_initiator_recipient_distinct)
      await expect(
        migratorPool.query(
          `INSERT INTO public.tenant_invitations (
             tenant_id, invited_email, target_role_id, token_hash, status, expires_at,
             invited_by_user_id, accepted_by_user_id, accepted_membership_id, accepted_at
           ) VALUES ($1, 'self.accept@phase4a.test', $2, $3, 'ACCEPTED', NOW() + interval '7 days', $4, $4, $5, NOW())`,
          [
            tenantAlpha.id,
            roleAlphaMember.id,
            SHA256_SAMPLE_B,
            alphaOwnerUserId,
            memberAlphaOwner.id,
          ],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'chk_ti_initiator_recipient_distinct' });

      // Seed valid PENDING invitation for recipient `invitee.outbox@phase4a.test` initiated by `alphaOwnerUserId`
      const invRes = await migratorPool.query<{ id: string }>(
        `INSERT INTO public.tenant_invitations (
           tenant_id, invited_email, membership_type, target_role_id, token_hash,
           status, expires_at, invited_by_user_id, invited_by_membership_id
         ) VALUES ($1, 'invitee.outbox@phase4a.test', 'INTERNAL', $2, $3, 'PENDING', NOW() + interval '7 days', $4, $5)
         RETURNING id`,
        [
          tenantAlpha.id,
          roleAlphaMember.id,
          SHA256_SAMPLE_C,
          alphaOwnerUserId,
          memberAlphaOwner.id,
        ],
      );
      const invitationId = invRes.rows[0].id;

      // (c) `chk_auth_email_outbox_anchor` REJECTS storing initiating admin's `user_id` in `auth_email_outbox.user_id` for TENANT_INVITATION (23514)
      await expect(
        migratorPool.query(
          `INSERT INTO public.auth_email_outbox (
             kind, user_id, initiated_by_user_id, tenant_id, invitation_id,
             recipient_email, recipient_full_name, encrypted_action_token, token_expires_at, correlation_id
           ) VALUES (
             'TENANT_INVITATION', $1, $1, $2, $3,
             'invitee.outbox@phase4a.test', 'Invitee', 'v1:aa:bb:cc', NOW() + interval '7 days', $4
           )`,
          [alphaOwnerUserId, tenantAlpha.id, invitationId, CORR_ID],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'chk_auth_email_outbox_anchor' });

      // (d) Valid enqueue via `fn_tenant_enqueue_invitation_email_outbox` stores `user_id = NULL` and `initiated_by_user_id = alphaOwnerUserId`, and delivers cleanly via AuthMailOutboxService!
      const rawInviteToken = 'ft360_inv_stage4a_outbox_verification_secret_token';
      const sealedInviteToken = mailOutbox.sealActionToken(
        rawInviteToken,
        'invitee.outbox@phase4a.test',
        'TENANT_INVITATION',
      );

      const outboxId = await txManager.withVerifiedMemberTransaction(
        {
          tenantId: tenantAlpha.id,
          actorUserId: alphaOwnerUserId,
          membershipId: memberAlphaOwner.id,
          correlationId: CORR_ID,
        },
        async (tx) => {
          const r = await tx.query<{ outbox_id: string }>(
            `SELECT public.fn_tenant_enqueue_invitation_email_outbox(
               $1::uuid, $2::uuid, $3::citext, $4, $5, 3, $6::uuid
             ) AS outbox_id`,
            [
              tenantAlpha.id,
              invitationId,
              'invitee.outbox@phase4a.test',
              'Invitee Candidate',
              sealedInviteToken,
              CORR_ID,
            ],
          );
          return r.rows[0].outbox_id;
        },
      );

      const outboxMeta = await txManager.withPlatformAdminTransaction(
        superAdminUserId,
        async (tx) => {
          const r = await tx.query<{
            user_id: string | null;
            initiated_by_user_id: string | null;
            tenant_id: string | null;
            invitation_id: string | null;
          }>(
            `SELECT user_id, initiated_by_user_id, tenant_id, invitation_id
               FROM public.auth_email_outbox
              WHERE id = $1`,
            [outboxId],
          );
          return r.rows[0];
        },
      );
      expect(outboxMeta).toEqual({
        user_id: null,
        initiated_by_user_id: alphaOwnerUserId,
        tenant_id: tenantAlpha.id,
        invitation_id: invitationId,
      });

      const deliveryOutcome = await mailOutbox.deliverOutboxItem(outboxId);
      expect(deliveryOutcome.delivered).toBe(true);
      expect(deliveryOutcome.status).toBe('SENT');
    } finally {
      await migratorPool.end();
    }
  });

  it('SEC-P4-09 & SEC-P4-18: enforces 6-state lifecycle transitions (including OD-P1 two-step cancellation) and 4-layer PostgreSQL lifecycle validation even when Redis is unavailable', async () => {
    let lifecycleTenant!: TenantEntity;
    let lifecycleMember!: TenantMembershipEntity;
    const lifecycleUserId = await createVerifiedUserViaDb(
      'Lifecycle User',
      'lifecycle.member@phase4a.test',
    );

    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      lifecycleTenant = await platformRepo.createTenant(tx, {
        slug: 'p4a-lifecycle',
        legalName: 'Lifecycle Test Org Ltd',
        displayName: 'Lifecycle Org',
        status: 'PROVISIONING',
      });
      lifecycleMember = await membershipRepo.createMembership(tx, {
        tenantId: lifecycleTenant.id,
        userId: lifecycleUserId,
        membershipType: 'INTERNAL',
        status: 'ACTIVE',
      });
    });

    // 1. PROVISIONING -> TRIAL -> ACTIVE succeeds; direct TRIAL/ACTIVE -> CANCELLED is REJECTED by OD-P1 (23514)!
    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      const toTrial = await tx.query<{ current_status: string }>(
        `SELECT current_status FROM public.fn_platform_transition_tenant_status(
           $1::uuid, 'ACTIVATE', 'TRIAL', 'Initial trial activation approved', $2::uuid
         )`,
        [lifecycleTenant.id, CORR_ID],
      );
      expect(toTrial.rows[0].current_status).toBe('TRIAL');
    });

    // Direct TRIAL -> CANCELLED blocked by OD-P1!
    await expect(
      txManager.withPlatformAdminTransaction(superAdminUserId, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_platform_transition_tenant_status(
             $1::uuid, 'CANCEL', 'CANCELLED', 'Attempted direct cancel from trial', $2::uuid
           )`,
          [lifecycleTenant.id, CORR_ID],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      const toActive = await tx.query<{ current_status: string }>(
        `SELECT current_status FROM public.fn_platform_transition_tenant_status(
           $1::uuid, 'ACTIVATE', 'ACTIVE', 'Upgraded from trial to active subscription', $2::uuid
         )`,
        [lifecycleTenant.id, CORR_ID],
      );
      expect(toActive.rows[0].current_status).toBe('ACTIVE');
    });

    // Direct ACTIVE -> CANCELLED blocked by OD-P1!
    await expect(
      txManager.withPlatformAdminTransaction(superAdminUserId, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_platform_transition_tenant_status(
             $1::uuid, 'CANCEL', 'CANCELLED', 'Attempted direct cancel from active', $2::uuid
           )`,
          [lifecycleTenant.id, CORR_ID],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // 2. Sign in lifecycle user and select `p4a-lifecycle` organization
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'lifecycle.member@phase4a.test', password: USER_PW })
      .expect(200);
    const jar = parseSetCookies(loginRes.headers['set-cookie']);

    const selRes = await request(app.getHttpServer())
      .post('/api/v1/auth/select-organization')
      .set('Cookie', buildCookieHeader(jar))
      .set('X-CSRF-Token', jar.ft360_csrf)
      .send({ targetOrganizationId: lifecycleTenant.id })
      .expect(200);
    Object.assign(jar, parseSetCookies(selRes.headers['set-cookie']));

    await request(app.getHttpServer())
      .get('/api/v1/workspace/context')
      .set('Cookie', buildCookieHeader(jar))
      .expect(200);

    // 3. Simulate COMPLETE Redis outage while suspending `p4a-lifecycle`!
    const getAuthSpy = jest
      .spyOn(redisService, 'getAuthJson')
      .mockRejectedValue(new Error('ECONNREFUSED simulated Redis outage'));
    const setAuthSpy = jest
      .spyOn(redisService, 'setAuthJson')
      .mockRejectedValue(new Error('ECONNREFUSED simulated Redis outage'));
    const delAuthSpy = jest
      .spyOn(redisService, 'deleteAuthKeys')
      .mockRejectedValue(new Error('ECONNREFUSED simulated Redis outage'));

    try {
      const t0 = Date.now();
      await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
        const susp = await tx.query<{
          current_status: string;
          evicted_session_ids: string[];
        }>(
          `SELECT current_status, evicted_session_ids
             FROM public.fn_platform_transition_tenant_status(
               $1::uuid, 'SUSPEND', 'SUSPENDED', 'Security compliance hold during Redis outage test', $2::uuid
             )`,
          [lifecycleTenant.id, CORR_ID],
        );
        expect(susp.rows[0].current_status).toBe('SUSPENDED');
        expect(susp.rows[0].evicted_session_ids.length).toBeGreaterThanOrEqual(1);
      });

      // Immediately issue workspace call with existing cookie while Redis is STILL offline:
      // Must NOT 500 and must NOT fail open — denied in < 200ms directly via PostgreSQL!
      const deniedRes = await request(app.getHttpServer())
        .get('/api/v1/workspace/context')
        .set('Cookie', buildCookieHeader(jar));
      const elapsedMs = Date.now() - t0;

      expect([401, 403]).toContain(deniedRes.status);
      expect(elapsedMs).toBeLessThan(200);

      // Layer 4 check: even raw `withTenantTransaction` INSERT into operational table is blocked by PostgreSQL write-RLS (`fn_is_current_tenant_operational`)!
      await expect(
        txManager.withTenantTransaction(
          {
            tenantId: lifecycleTenant.id,
            actorUserId: lifecycleUserId,
            membershipId: lifecycleMember.id,
            correlationId: CORR_ID,
          },
          (tx) =>
            tx.query(
              `INSERT INTO public.tenant_onboarding_states (tenant_id) VALUES ($1)`,
              [lifecycleTenant.id],
            ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      getAuthSpy.mockRestore();
      setAuthSpy.mockRestore();
      delAuthSpy.mockRestore();
    }

    // 4. Transition SUSPENDED -> DEACTIVATED -> CANCELLED and verify terminal CANCELLED rejects all outbound transitions!
    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      await tx.query(
        `SELECT * FROM public.fn_platform_transition_tenant_status(
           $1::uuid, 'DEACTIVATE', 'DEACTIVATED', 'Customer requested account deactivation', $2::uuid
         )`,
        [lifecycleTenant.id, CORR_ID],
      );

      await tx.query(
        `SELECT * FROM public.fn_platform_transition_tenant_status(
           $1::uuid, 'CANCEL', 'CANCELLED', 'Final contract termination after deactivation', $2::uuid
         )`,
        [lifecycleTenant.id, CORR_ID],
      );

      await expect(
        tx.query(
          `SELECT * FROM public.fn_platform_transition_tenant_status(
             $1::uuid, 'REACTIVATE', 'ACTIVE', 'Attempted reactivation of cancelled tenant', $2::uuid
           )`,
          [lifecycleTenant.id, CORR_ID],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('DB-P4-05, SEC-P4-16 & IT-P4-06: verifies TenantAuditModule append-only immutability, recursive secret rejection, plane boundaries, and Endpoint #29 GET /api/v1/workspace/audit-logs pagination/filtering', async () => {
    const alphaCtx = {
      tenantId: tenantAlpha.id,
      actorUserId: alphaOwnerUserId,
      membershipId: memberAlphaOwner.id,
      correlationId: CORR_ID,
    };
    const betaCtx = {
      tenantId: tenantBeta.id,
      actorUserId: betaOwnerUserId,
      membershipId: memberBetaOwner.id,
      correlationId: CORR_ID,
    };

    // 1. Record domain state-diff events in Tenant Alpha & Tenant Beta + Platform event on Tenant Alpha
    await txManager.withVerifiedMemberTransaction(alphaCtx, async (tx) => {
      const diff = tenantAuditService.computeFieldDiff(
        { timezone: 'UTC', invitationExpiryHours: 168 },
        { timezone: 'Asia/Kolkata', invitationExpiryHours: 72 },
      );
      await tenantAuditService.recordTenantEvent(tx, alphaCtx, {
        eventType: 'TENANT_SETTINGS_UPDATED',
        resourceType: 'SETTINGS',
        resourceId: tenantAlpha.id,
        beforeState: diff.beforeState,
        afterState: diff.afterState,
        metadata: { changedFields: diff.changedFields },
        ipAddress: '127.0.0.1',
        userAgent: 'Stage4A-Integration-Test',
      });

      await tenantAuditService.recordTenantEvent(tx, alphaCtx, {
        eventType: 'TENANT_PROFILE_UPDATED',
        resourceType: 'PROFILE',
        resourceId: tenantAlpha.id,
        beforeState: { displayName: 'Alpha Old' },
        afterState: { displayName: 'Alpha Cloud' },
        metadata: { version: 2 },
      });
    });

    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      await tenantAuditService.recordPlatformTenantEvent(tx, {
        tenantId: tenantAlpha.id,
        actorUserId: superAdminUserId,
        correlationId: CORR_ID,
        eventType: 'PLATFORM_TENANT_NOTE_RECORDED',
        resourceType: 'TENANT',
        resourceId: tenantAlpha.id,
        reason: 'Compliance verification audit checkpoint',
        metadata: { ticketRef: 'COMP-401' },
      });
    });

    await txManager.withVerifiedMemberTransaction(betaCtx, async (tx) => {
      await tenantAuditService.recordTenantEvent(tx, betaCtx, {
        eventType: 'TENANT_SETTINGS_UPDATED',
        resourceType: 'SETTINGS',
        resourceId: tenantBeta.id,
        afterState: { timezone: 'America/New_York' },
      });
    });

    // 2. Service-level AND Database-level recursive secret-key rejection (400 & 23514)
    await expect(
      txManager.withVerifiedMemberTransaction(alphaCtx, (tx) =>
        tenantAuditService.recordTenantEvent(tx, alphaCtx, {
          eventType: 'TENANT_SETTINGS_UPDATED',
          resourceType: 'SETTINGS',
          afterState: { nestedArray: [{ refresh_token: 'secret' }] },
        }),
      ),
    ).rejects.toThrow(BadRequestException);

    await expect(
      txManager.withVerifiedMemberTransaction(alphaCtx, (tx) =>
        tx.query(
          `SELECT public.fn_record_tenant_audit_log(
             $1::uuid, 'TENANT_SETTINGS_UPDATED', 'SETTINGS', 'SUCCESS', 'TENANT',
             $2::uuid, NULL, $3::uuid, $4::uuid, NULL, NULL,
             '{"deep":{"items":[{"token_hash":"deadbeef"}]}}'::jsonb, '{}'::jsonb, NULL, NULL
           )`,
          [tenantAlpha.id, CORR_ID, alphaOwnerUserId, memberAlphaOwner.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // 3. Immutability & plane forgery checks: UPDATE / DELETE fail with 42501 even for Super Admin; ON DELETE RESTRICT blocks tenant deletion (23503)
    await expect(
      txManager.withPlatformAdminTransaction(superAdminUserId, (tx) =>
        tx.query(`UPDATE public.tenant_audit_logs SET outcome = 'FAILURE' WHERE tenant_id = $1`, [
          tenantAlpha.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      txManager.withPlatformAdminTransaction(superAdminUserId, (tx) =>
        tx.query(`DELETE FROM public.tenant_audit_logs WHERE tenant_id = $1`, [tenantAlpha.id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const migratorPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
    try {
      await expect(
        migratorPool.query(`DELETE FROM public.tenants WHERE id = $1`, [tenantAlpha.id]),
      ).rejects.toMatchObject({ code: '23001', constraint: 'fk_tal_tenant' });
    } finally {
      await migratorPool.end();
    }

    // Cross-tenant audit forgery from Tenant Alpha claiming Tenant Beta fails with 42501
    await expect(
      txManager.withVerifiedMemberTransaction(alphaCtx, (tx) =>
        tx.query(
          `SELECT public.fn_record_tenant_audit_log(
             $1::uuid, 'FORGED_CROSS_TENANT', 'SETTINGS', 'SUCCESS', 'TENANT', $2::uuid
           )`,
          [tenantBeta.id, CORR_ID],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // 4. HTTP Endpoint #29 (`GET /api/v1/workspace/audit-logs`) Verification:
    // (a) Standard member without `audit:tenant:read` receives 403 INSUFFICIENT_TENANT_PERMISSIONS
    const stdLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'alpha.member@phase4a.test', password: USER_PW })
      .expect(200);
    const stdJar = parseSetCookies(stdLogin.headers['set-cookie']);
    const stdSel = await request(app.getHttpServer())
      .post('/api/v1/auth/select-organization')
      .set('Cookie', buildCookieHeader(stdJar))
      .set('X-CSRF-Token', stdJar.ft360_csrf)
      .send({ targetOrganizationId: tenantAlpha.id })
      .expect(200);
    Object.assign(stdJar, parseSetCookies(stdSel.headers['set-cookie']));

    const deniedMemberRes = await request(app.getHttpServer())
      .get('/api/v1/workspace/audit-logs')
      .set('Cookie', buildCookieHeader(stdJar))
      .expect(403);
    expect(deniedMemberRes.body.error.code).toBe('INSUFFICIENT_TENANT_PERMISSIONS');

    // (b) Tenant Alpha Owner (`audit:tenant:read`) receives paginated Tenant Alpha logs ONLY (zero Tenant Beta leakage!)
    const ownerLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'alpha.owner@phase4a.test', password: USER_PW })
      .expect(200);
    const ownerJar = parseSetCookies(ownerLogin.headers['set-cookie']);
    const ownerSel = await request(app.getHttpServer())
      .post('/api/v1/auth/select-organization')
      .set('Cookie', buildCookieHeader(ownerJar))
      .set('X-CSRF-Token', ownerJar.ft360_csrf)
      .send({ targetOrganizationId: tenantAlpha.id })
      .expect(200);
    Object.assign(ownerJar, parseSetCookies(ownerSel.headers['set-cookie']));

    const page1 = await request(app.getHttpServer())
      .get('/api/v1/workspace/audit-logs?limit=2')
      .set('Cookie', buildCookieHeader(ownerJar))
      .expect(200);

    expect(page1.body.success).toBe(true);
    expect(page1.body.data.items).toHaveLength(2);
    expect(
      page1.body.data.items.every((item: { tenantId: string }) => item.tenantId === tenantAlpha.id),
    ).toBe(true);
    expect(page1.body.data.nextCursor).toEqual(expect.any(String));

    const page2 = await request(app.getHttpServer())
      .get(`/api/v1/workspace/audit-logs?limit=2&cursor=${encodeURIComponent(page1.body.data.nextCursor)}`)
      .set('Cookie', buildCookieHeader(ownerJar))
      .expect(200);
    expect(page2.body.data.items.length).toBeGreaterThanOrEqual(1);
    expect(
      page2.body.data.items.every((item: { tenantId: string }) => item.tenantId === tenantAlpha.id),
    ).toBe(true);

    // Filter by resourceType=SETTINGS returns exact beforeState/afterState diff & correlationId
    const filtered = await request(app.getHttpServer())
      .get('/api/v1/workspace/audit-logs?resourceType=SETTINGS&eventType=TENANT_SETTINGS_UPDATED')
      .set('Cookie', buildCookieHeader(ownerJar))
      .expect(200);
    expect(filtered.body.data.items).toHaveLength(1);
    expect(filtered.body.data.items[0]).toMatchObject({
      tenantId: tenantAlpha.id,
      eventType: 'TENANT_SETTINGS_UPDATED',
      resourceType: 'SETTINGS',
      actorPlane: 'TENANT',
      actorUserId: alphaOwnerUserId,
      actorMembershipId: memberAlphaOwner.id,
      beforeState: { invitationExpiryHours: 168, timezone: 'UTC' },
      afterState: { invitationExpiryHours: 72, timezone: 'Asia/Kolkata' },
      correlationId: CORR_ID,
    });

    // Spoofed x-tenant-id header on #29 is rejected with 400 UNTRUSTED_TENANT_INPUT_REJECTED
    await request(app.getHttpServer())
      .get('/api/v1/workspace/audit-logs')
      .set('Cookie', buildCookieHeader(ownerJar))
      .set('x-tenant-id', tenantBeta.id)
      .expect(400);
  });
});
