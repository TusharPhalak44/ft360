import * as crypto from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import type {
  ApiErrorResponse,
  ApiSuccessResponse,
  CheckSlugAvailabilityResponsePayload,
  TenantEntity,
  TenantRegistrationResponsePayload,
  UserEntity,
} from '@ft360/shared-types';
import { AppModule } from '../../src/app.module';
import { configureNestApp } from '../../src/bootstrap';
import { APP_CONFIG, loadAppConfig, type AppEnvConfig } from '../../src/config/env.config';
import { SqlMigrationRunner } from '../../src/database/migrations/migration-runner';
import { TenantTransactionManager } from '../../src/database/tenant-transaction.manager';
import { TokenService } from '../../src/modules/auth/token.service';
import { PlatformDirectoryRepository } from '../../src/modules/foundation-db/platform-directory.repository';

function randomSha256Hex(): string {
  return crypto.randomBytes(32).toString('hex');
}

describe('Phase 4 Stage 4B-API-01: Tenant Registration Endpoints Integration Suite', () => {
  let app: INestApplication;
  let config: AppEnvConfig;
  let txManager: TenantTransactionManager;
  let platformRepo: PlatformDirectoryRepository;
  let tokenService: TokenService;
  let migratorPool: Pool;

  let verifiedUser: UserEntity;
  let verifiedUserSessionId: string;
  let verifiedUserToken: string;

  let unverifiedUser: UserEntity;
  let unverifiedUserToken: string;

  let suspendedUser: UserEntity;
  let suspendedUserToken: string;

  let superAdminUser: UserEntity;
  let superAdminToken: string;

  let quotaUser: UserEntity;
  let quotaUserToken: string;

  let existingTenant: TenantEntity;

  async function cleanFixtures(pool: Pool): Promise<void> {
    await pool.query(
      `DELETE FROM public.tenant_audit_logs
        WHERE tenant_id IN (
          SELECT id FROM public.tenants WHERE slug LIKE 'p4b-api-%'
        )`,
    );
    await pool.query(
      `DELETE FROM public.auth_audit_logs
        WHERE correlation_id LIKE '0195f3b4-%'
           OR metadata->>'slug' LIKE 'p4b-api-%'`,
    );
    await pool.query(`DELETE FROM public.tenants WHERE slug LIKE 'p4b-api-%'`);
    await pool.query(`DELETE FROM public.users WHERE email LIKE '%@p4b-api.test'`);
  }

  async function createSessionAndToken(
    userId: string,
    isPlatformSuperAdmin = false,
  ): Promise<{ sessionId: string; token: string }> {
    const res = await migratorPool.query<{ id: string }>(
      `INSERT INTO public.auth_sessions (
         user_id, refresh_token_hash, csrf_secret_hash, created_at, idle_expires_at, expires_at
       )
       VALUES (
         $1::uuid, $2, $3,
         NOW(),
         NOW() + INTERVAL '1 hour',
         NOW() + INTERVAL '24 hours'
       )
       RETURNING id`,
      [userId, randomSha256Hex(), randomSha256Hex()],
    );

    const sessionId = res.rows[0].id;
    const token = tokenService.signAccessToken({
      userId,
      sessionId,
      activeTenantId: null,
      activeMembershipId: null,
      isPlatformSuperAdmin,
    });

    return { sessionId, token };
  }

  beforeAll(async () => {
    config = loadAppConfig();

    // Ensure all migrations up to 0009 are applied
    const runner = new SqlMigrationRunner(config.database.migratorUrl);
    try {
      await runner.migrateUp();
    } finally {
      await runner.close();
    }

    migratorPool = new Pool({
      connectionString: config.database.migratorUrl,
      max: 2,
    });

    await cleanFixtures(migratorPool);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue({
        ...config,
        tenantSelfRegistrationEnabled: true,
        database: { ...config.database, poolMin: 1, poolMax: 6 },
        auth: {
          ...config.auth,
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

    txManager = app.get(TenantTransactionManager);
    platformRepo = app.get(PlatformDirectoryRepository);
    tokenService = app.get(TokenService);

    // 1. Seed verified user
    verifiedUser = await txManager.withSystemBootstrapTransaction((tx) =>
      platformRepo.createUser(tx, {
        email: 'verified@p4b-api.test',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=2$mockHash1$mockHash1',
        fullName: 'Verified Test User',
        status: 'ACTIVE',
        isPlatformSuperAdmin: false,
        emailVerified: true,
      }),
    );
    const vSession = await createSessionAndToken(verifiedUser.id, false);
    verifiedUserSessionId = vSession.sessionId;
    verifiedUserToken = vSession.token;

    // 2. Seed unverified user
    unverifiedUser = await txManager.withSystemBootstrapTransaction((tx) =>
      platformRepo.createUser(tx, {
        email: 'unverified@p4b-api.test',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=2$mockHash2$mockHash2',
        fullName: 'Unverified Test User',
        status: 'ACTIVE',
        isPlatformSuperAdmin: false,
        emailVerified: false,
      }),
    );
    const uSession = await createSessionAndToken(unverifiedUser.id, false);
    unverifiedUserToken = uSession.token;

    // 3. Seed suspended user
    suspendedUser = await txManager.withSystemBootstrapTransaction((tx) =>
      platformRepo.createUser(tx, {
        email: 'suspended@p4b-api.test',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=2$mockHash3$mockHash3',
        fullName: 'Suspended Test User',
        status: 'SUSPENDED',
        isPlatformSuperAdmin: false,
        emailVerified: true,
      }),
    );
    const sSession = await createSessionAndToken(suspendedUser.id, false);
    suspendedUserToken = sSession.token;

    // 4. Seed Platform Super Admin
    superAdminUser = await txManager.withSystemBootstrapTransaction((tx) =>
      platformRepo.createUser(tx, {
        email: 'superadmin@p4b-api.test',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=2$mockHash4$mockHash4',
        fullName: 'Platform Super Admin User',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        emailVerified: true,
      }),
    );
    const aSession = await createSessionAndToken(superAdminUser.id, true);
    superAdminToken = aSession.token;

    // 5. Seed Quota user
    quotaUser = await txManager.withSystemBootstrapTransaction((tx) =>
      platformRepo.createUser(tx, {
        email: 'quota@p4b-api.test',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=2$mockHash5$mockHash5',
        fullName: 'Quota Limit User',
        status: 'ACTIVE',
        isPlatformSuperAdmin: false,
        emailVerified: true,
      }),
    );
    const qSession = await createSessionAndToken(quotaUser.id, false);
    quotaUserToken = qSession.token;

    // Seed an existing tenant to test occupancy detection
    await txManager.withPlatformAdminTransaction(superAdminUser.id, async (tx) => {
      existingTenant = await platformRepo.createTenant(tx, {
        slug: 'p4b-api-occupied',
        legalName: 'Occupied Holdings LLC',
        displayName: 'Occupied Workspace',
        status: 'ACTIVE',
      });
    });
  });

  afterAll(async () => {
    try {
      if (migratorPool) {
        await cleanFixtures(migratorPool);
        await migratorPool.end();
      }
    } finally {
      if (app) {
        await app.close();
      }
    }
  });

  describe('Endpoint #1 — GET /api/v1/tenants/slug-availability', () => {
    it('rejects unauthenticated requests (401 AUTHENTICATION_REQUIRED)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/tenants/slug-availability?slug=p4b-api-test')
        .expect(401);

      const body = res.body as ApiErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('rejects unverified user accounts (403 EMAIL_NOT_VERIFIED or USER_ACCOUNT_INACTIVE)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/tenants/slug-availability?slug=p4b-api-test')
        .set('Authorization', `Bearer ${unverifiedUserToken}`)
        .expect(403);

      const body = res.body as ApiErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('USER_ACCOUNT_INACTIVE');
    });

    it('rejects suspended accounts (403 USER_ACCOUNT_INACTIVE)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/tenants/slug-availability?slug=p4b-api-test')
        .set('Authorization', `Bearer ${suspendedUserToken}`)
        .expect(403);

      const body = res.body as ApiErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('USER_ACCOUNT_INACTIVE');
    });

    it('rejects malformed slugs with validation error (400 VALIDATION_ERROR)', async () => {
      const invalidSlugs = ['ab', 'a'.repeat(64), '-leading', 'trailing-', 'with_underscore', 'with.dot'];

      for (const slug of invalidSlugs) {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/tenants/slug-availability?slug=${encodeURIComponent(slug)}`)
          .set('Authorization', `Bearer ${verifiedUserToken}`)
          .expect(400);

        const body = res.body as ApiErrorResponse;
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('returns available: true for an unoccupied candidate slug (200 OK)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/tenants/slug-availability?slug=p4b-api-free-slug')
        .set('Authorization', `Bearer ${verifiedUserToken}`)
        .expect(200);

      const body = res.body as ApiSuccessResponse<CheckSlugAvailabilityResponsePayload>;
      expect(body.success).toBe(true);
      expect(body.data).toEqual({
        slug: 'p4b-api-free-slug',
        available: true,
      });
      expect(body.meta).toHaveProperty('correlationId');
    });

    it('returns available: false for reserved slugs (200 OK, zero metadata disclosure)', async () => {
      const reservedSlugs = ['admin', 'api', 'auth', 'platform', 'workspace', 'billing', 'root'];

      for (const slug of reservedSlugs) {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/tenants/slug-availability?slug=${slug}`)
          .set('Authorization', `Bearer ${verifiedUserToken}`)
          .expect(200);

        const body = res.body as ApiSuccessResponse<CheckSlugAvailabilityResponsePayload>;
        expect(body.success).toBe(true);
        expect(body.data).toEqual({
          slug,
          available: false,
        });
        // Asserts zero tenant metadata is leaked
        expect(body.data).not.toHaveProperty('tenantId');
        expect(body.data).not.toHaveProperty('status');
      }
    });

    it('returns available: false for occupied tenant slugs (200 OK, zero metadata disclosure)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/tenants/slug-availability?slug=${existingTenant.slug}`)
        .set('Authorization', `Bearer ${verifiedUserToken}`)
        .expect(200);

      const body = res.body as ApiSuccessResponse<CheckSlugAvailabilityResponsePayload>;
      expect(body.success).toBe(true);
      expect(body.data).toEqual({
        slug: existingTenant.slug,
        available: false,
      });
      // Zero metadata exposure
      expect(body.data).not.toHaveProperty('tenantId');
      expect(body.data).not.toHaveProperty('displayName');
    });
  });

  describe('Endpoint #2 — POST /api/v1/tenants/register', () => {
    it('rejects unauthenticated requests (401 AUTHENTICATION_REQUIRED)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/tenants/register')
        .send({
          displayName: 'Acme Corporation',
          legalName: 'Acme Corporation LLC',
          slug: 'p4b-api-unauth',
          organizationType: 'COMPANY',
          industry: 'SAAS_TECHNOLOGY',
          countryCode: 'US',
          defaultTimezone: 'America/New_York',
          defaultCurrency: 'USD',
        })
        .expect(401);

      const body = res.body as ApiErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('rejects Platform Super Admin accounts (403 PLATFORM_ADMIN_CANNOT_OWN_TENANT)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/tenants/register')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          displayName: 'Super Admin Org',
          legalName: 'Super Admin Org LLC',
          slug: 'p4b-api-superadmin-org',
          organizationType: 'COMPANY',
          industry: 'SAAS_TECHNOLOGY',
          countryCode: 'US',
          defaultTimezone: 'America/New_York',
          defaultCurrency: 'USD',
        })
        .expect(403);

      const body = res.body as ApiErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('PLATFORM_ADMIN_CANNOT_OWN_TENANT');
    });

    it('rejects malformed registration payload (400 VALIDATION_ERROR)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/tenants/register')
        .set('Authorization', `Bearer ${verifiedUserToken}`)
        .send({
          displayName: 'A', // < 2 chars
          legalName: '', // empty
          slug: 'INVALID_SLUG!',
          organizationType: 'NON_EXISTENT_TYPE',
          industry: 'NON_EXISTENT_INDUSTRY',
          countryCode: 'INVALID',
          defaultTimezone: 'Invalid/Zone',
          defaultCurrency: 'NOT_A_CURRENCY',
        })
        .expect(400);

      const body = res.body as ApiErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details?.length).toBeGreaterThan(0);
    });

    it('atomically provisions organization, seeds roles, binds session, and sets cookies (201 Created)', async () => {
      const registrationPayload = {
        displayName: 'Alpha Operations',
        legalName: 'Alpha Operations International LLC',
        slug: 'p4b-api-alpha-ops',
        organizationType: 'COMPANY' as const,
        industry: 'SAAS_TECHNOLOGY' as const,
        countryCode: 'US',
        defaultTimezone: 'America/New_York',
        defaultCurrency: 'USD',
      };

      const res = await request(app.getHttpServer())
        .post('/api/v1/tenants/register')
        .set('Authorization', `Bearer ${verifiedUserToken}`)
        .send(registrationPayload)
        .expect(201);

      const body = res.body as ApiSuccessResponse<TenantRegistrationResponsePayload>;
      expect(body.success).toBe(true);

      const data = body.data;
      expect(data.tenant.slug).toBe('p4b-api-alpha-ops');
      expect(data.tenant.displayName).toBe('Alpha Operations');
      expect(data.tenant.legalName).toBe('Alpha Operations International LLC');
      expect(data.tenant.status).toBe('TRIAL');
      expect(data.tenant.createdByUserId).toBe(verifiedUser.id);

      expect(data.membership.membershipType).toBe('INTERNAL');
      expect(data.membership.status).toBe('ACTIVE');
      expect(data.membership.isPrimaryOwner).toBe(true);

      expect(data.onboarding.onboardingStatus).toBe('IN_PROGRESS');
      expect(data.onboarding.currentStep).toBe('ORG_PROFILE');

      expect(data.activeSessionBound).toBe(true);
      expect(data.effectiveTenantPermissions).toEqual(
        expect.arrayContaining([
          'tenant:organization:manage',
          'tenant:organization:read',
          'tenant:settings:manage',
          'tenant:settings:read',
          'tenant:branding:manage',
          'tenant:branding:read',
          'tenant:members:manage',
          'tenant:members:read',
          'tenant:invitations:manage',
          'tenant:invitations:read',
          'tenant:admins:manage',
          'tenant:admins:read',
          'tenant:roles:assign',
          'rbac:roles:manage',
          'rbac:roles:read',
          'audit:tenant:read',
          'audit:auth:read',
          'auth:sessions:manage',
        ]),
      );

      // Verify response cookie contains rotated access token with tenant binding
      const setCookieHeaders = res.header['set-cookie'] as unknown as string[] | undefined;
      expect(setCookieHeaders).toBeDefined();
      const atCookie = setCookieHeaders?.find((c) => c.startsWith('ft360_at='));
      expect(atCookie).toBeDefined();

      // Verify database session binding
      const sessionCheck = await migratorPool.query<{
        active_tenant_id: string;
        active_membership_id: string;
      }>(
        `SELECT active_tenant_id, active_membership_id
         FROM public.auth_sessions
         WHERE id = $1::uuid`,
        [verifiedUserSessionId],
      );
      expect(sessionCheck.rows[0].active_tenant_id).toBe(data.tenant.id);
      expect(sessionCheck.rows[0].active_membership_id).toBe(data.membership.id);

      // Verify 1:1 companion records exist in PostgreSQL
      const profileCheck = await migratorPool.query(
        `SELECT * FROM public.tenant_profiles WHERE tenant_id = $1::uuid`,
        [data.tenant.id],
      );
      expect(profileCheck.rows.length).toBe(1);
      expect(profileCheck.rows[0].organization_type).toBe('COMPANY');
      expect(profileCheck.rows[0].industry).toBe('SAAS_TECHNOLOGY');
      expect(profileCheck.rows[0].country_code).toBe('US');

      const settingsCheck = await migratorPool.query(
        `SELECT * FROM public.tenant_settings WHERE tenant_id = $1::uuid`,
        [data.tenant.id],
      );
      expect(settingsCheck.rows.length).toBe(1);
      expect(settingsCheck.rows[0].allow_member_directory_view).toBe(false);
      expect(settingsCheck.rows[0].invitation_expiry_hours).toBe(168);

      const brandingCheck = await migratorPool.query(
        `SELECT * FROM public.tenant_branding_settings WHERE tenant_id = $1::uuid`,
        [data.tenant.id],
      );
      expect(brandingCheck.rows.length).toBe(1);

      const onboardingCheck = await migratorPool.query(
        `SELECT * FROM public.tenant_onboarding_states WHERE tenant_id = $1::uuid`,
        [data.tenant.id],
      );
      expect(onboardingCheck.rows.length).toBe(1);
      expect(onboardingCheck.rows[0].onboarding_status).toBe('IN_PROGRESS');

      // Verify dual-ledger audit logs
      const tenantAuditCheck = await migratorPool.query(
        `SELECT * FROM public.tenant_audit_logs WHERE tenant_id = $1::uuid AND event_type = 'TENANT_REGISTERED'`,
        [data.tenant.id],
      );
      expect(tenantAuditCheck.rows.length).toBe(1);
      expect(tenantAuditCheck.rows[0].outcome).toBe('SUCCESS');
      expect(tenantAuditCheck.rows[0].actor_user_id).toBe(verifiedUser.id);
      expect(tenantAuditCheck.rows[0].actor_plane).toBe('USER_ONBOARDING');

      const authAuditCheck = await migratorPool.query(
        `SELECT * FROM public.auth_audit_logs WHERE tenant_id = $1::uuid AND event_type = 'TENANT_REGISTERED'`,
        [data.tenant.id],
      );
      expect(authAuditCheck.rows.length).toBe(1);
      expect(authAuditCheck.rows[0].outcome).toBe('SUCCESS');
    });

    it('rejects duplicate slug registration (409 TENANT_SLUG_UNAVAILABLE)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/tenants/register')
        .set('Authorization', `Bearer ${verifiedUserToken}`)
        .send({
          displayName: 'Duplicate Org',
          legalName: 'Duplicate Org LLC',
          slug: 'p4b-api-alpha-ops', // already registered in previous test
          organizationType: 'COMPANY',
          industry: 'SAAS_TECHNOLOGY',
          countryCode: 'US',
          defaultTimezone: 'America/New_York',
          defaultCurrency: 'USD',
        })
        .expect(409);

      const body = res.body as ApiErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('TENANT_SLUG_UNAVAILABLE');
    });

    it('rejects reserved slug registration (409 TENANT_SLUG_UNAVAILABLE)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/tenants/register')
        .set('Authorization', `Bearer ${verifiedUserToken}`)
        .send({
          displayName: 'Admin Org',
          legalName: 'Admin Org LLC',
          slug: 'admin',
          organizationType: 'COMPANY',
          industry: 'SAAS_TECHNOLOGY',
          countryCode: 'US',
          defaultTimezone: 'America/New_York',
          defaultCurrency: 'USD',
        })
        .expect(409);

      const body = res.body as ApiErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('TENANT_SLUG_UNAVAILABLE');
    });

    it('enforces 5-tenant ownership quota limit (422 TENANT_CREATION_QUOTA_EXCEEDED)', async () => {
      // Provision 5 tenants for quotaUser
      for (let i = 1; i <= 5; i++) {
        const slug = `p4b-api-quota-org-${i}`;
        const res = await request(app.getHttpServer())
          .post('/api/v1/tenants/register')
          .set('Authorization', `Bearer ${quotaUserToken}`)
          .send({
            displayName: `Quota Org ${i}`,
            legalName: `Quota Org ${i} LLC`,
            slug,
            organizationType: 'COMPANY',
            industry: 'SAAS_TECHNOLOGY',
            countryCode: 'US',
            defaultTimezone: 'UTC',
            defaultCurrency: 'USD',
          })
          .expect(201);

        expect(res.body.success).toBe(true);
      }

      // 6th registration attempt must fail with 422 TENANT_CREATION_QUOTA_EXCEEDED
      const failRes = await request(app.getHttpServer())
        .post('/api/v1/tenants/register')
        .set('Authorization', `Bearer ${quotaUserToken}`)
        .send({
          displayName: 'Quota Org 6 Exceeded',
          legalName: 'Quota Org 6 Exceeded LLC',
          slug: 'p4b-api-quota-org-6',
          organizationType: 'COMPANY',
          industry: 'SAAS_TECHNOLOGY',
          countryCode: 'US',
          defaultTimezone: 'UTC',
          defaultCurrency: 'USD',
        })
        .expect(422);

      const failBody = failRes.body as ApiErrorResponse;
      expect(failBody.success).toBe(false);
      expect(failBody.error.code).toBe('TENANT_CREATION_QUOTA_EXCEEDED');
    });
  });
});
