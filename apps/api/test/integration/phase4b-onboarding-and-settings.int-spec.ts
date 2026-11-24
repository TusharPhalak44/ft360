import * as crypto from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import type {
  ApiErrorResponse,
  ApiSuccessResponse,
  CompleteOnboardingPayload,
  OrganizationProfilePayload,
  TenantEntity,
  TenantOnboardingStatePayload,
  TenantRegistrationResponsePayload,
  TenantSettingsPayload,
  UserEntity,
} from '@ft360/shared-types';
import { AppModule } from '../../src/app.module';
import { configureNestApp } from '../../src/bootstrap';
import { RedisService } from '../../src/cache/redis.service';
import { APP_CONFIG, loadAppConfig, type AppEnvConfig } from '../../src/config/env.config';
import { SqlMigrationRunner } from '../../src/database/migrations/migration-runner';
import { TokenService } from '../../src/modules/auth/token.service';

function randomSha256Hex(): string {
  return crypto.randomBytes(32).toString('hex');
}

describe('Phase 4 Stage 4B-API-02: Onboarding, Profile & Settings Integration Suite', () => {
  let app: INestApplication;
  let config: AppEnvConfig;
  let migratorPool: Pool;
  let tokenService: TokenService;
  let redisService: RedisService;

  let ownerUser: UserEntity;
  let ownerToken: string;
  let tenantAlpha: TenantEntity;

  let secondUser: UserEntity;

  interface RedisTestClient {
    status: string;
    keys(pattern: string): Promise<string[]>;
    del(...keys: string[]): Promise<number>;
    once(event: string, listener: (...args: unknown[]) => void): void;
    removeListener(event: string, listener: (...args: unknown[]) => void): void;
  }

  async function waitForRedisReady(client: RedisTestClient): Promise<void> {
    if (client.status === 'ready') return;
    await new Promise<void>((resolve, reject) => {
      if (client.status === 'ready') return resolve();
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Redis client failed to reach ready state within 5s (current status: ${client.status})`,
          ),
        );
      }, 5000);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (err: unknown) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        client.removeListener('ready', onReady);
        client.removeListener('error', onError);
      };
      client.once('ready', onReady);
      client.once('error', onError);
    });
  }

  async function cleanRateLimits(): Promise<void> {
    if (!redisService) return;
    const client = (redisService as unknown as { client: RedisTestClient }).client;
    if (!client || client.status === 'end' || client.status === 'close') return;
    if (client.status !== 'ready') {
      await waitForRedisReady(client);
    }
    const keys = await client.keys('auth:rl_*');
    if (keys.length > 0) {
      await client.del(...keys);
    }
  }

  async function cleanFixtures(pool: Pool): Promise<void> {
    await pool.query(
      `DELETE FROM public.tenant_audit_logs
       WHERE tenant_id IN (
         SELECT id FROM public.tenants WHERE slug LIKE 'p4b-obs-%'
       )`,
    );
    await pool.query(
      `DELETE FROM public.auth_audit_logs
       WHERE correlation_id::text LIKE '0195f3b5-%'
          OR metadata->>'slug' LIKE 'p4b-obs-%'`,
    );
    await pool.query(`DELETE FROM public.tenants WHERE slug LIKE 'p4b-obs-%'`);
    await pool.query(`DELETE FROM public.users WHERE email LIKE '%@p4b-obs.test'`);
  }

  async function createSessionAndToken(
    userId: string,
    tenantId: string | null = null,
    membershipId: string | null = null,
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
      activeTenantId: tenantId,
      activeMembershipId: membershipId,
      isPlatformSuperAdmin: false,
    });

    return { sessionId, token };
  }

  beforeAll(async () => {
    config = loadAppConfig();

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

    tokenService = app.get(TokenService);
    redisService = app.get(RedisService);
    await cleanRateLimits();

    // 1. Seed verified test user 1 (Owner of Alpha)
    const user1Res = await migratorPool.query<UserEntity>(
      `INSERT INTO public.users (
         email, password_hash, full_name, status, email_verified, email_verified_at, created_at, updated_at
       )
       VALUES (
         'owner1@p4b-obs.test',
         '$argon2id$v=19$m=19456,t=2,p=2$mockhash$mockhash',
         'Owner Alpha',
         'ACTIVE',
         TRUE,
         NOW(),
         NOW(),
         NOW()
       )
       RETURNING *`,
    );
    ownerUser = user1Res.rows[0];

    // 2. Seed verified test user 2 (Owner of Beta)
    const user2Res = await migratorPool.query<UserEntity>(
      `INSERT INTO public.users (
         email, password_hash, full_name, status, email_verified, email_verified_at, created_at, updated_at
       )
       VALUES (
         'owner2@p4b-obs.test',
         '$argon2id$v=19$m=19456,t=2,p=2$mockhash$mockhash',
         'Owner Beta',
         'ACTIVE',
         TRUE,
         NOW(),
         NOW(),
         NOW()
       )
       RETURNING *`,
    );
    secondUser = user2Res.rows[0];

    // 3. Register Tenant Alpha via Registration API to establish complete baseline
    const { token: regToken1 } = await createSessionAndToken(ownerUser.id);
    const regRes1 = await request(app.getHttpServer())
      .post('/api/v1/tenants/register')
      .set('Authorization', `Bearer ${regToken1}`)
      .send({
        displayName: 'Alpha Logistics',
        legalName: 'Alpha Logistics International LLC',
        slug: 'p4b-obs-alpha',
        organizationType: 'COMPANY',
        industry: 'LOGISTICS_SUPPLY_CHAIN',
        countryCode: 'US',
        defaultTimezone: 'America/New_York',
        defaultCurrency: 'USD',
      })
      .expect(201);

    const regData1 = (regRes1.body as ApiSuccessResponse<TenantRegistrationResponsePayload>).data;
    tenantAlpha = regData1.tenant;
    // Sign an explicit bearer token bound to tenantAlpha
    const { token: activeAlphaToken } = await createSessionAndToken(
      ownerUser.id,
      tenantAlpha.id,
      regData1.membership.id,
    );
    ownerToken = activeAlphaToken;

    // 4. Register Tenant Beta for cross-tenant RLS negative tests
    const { token: regToken2 } = await createSessionAndToken(secondUser.id);
    const regRes2 = await request(app.getHttpServer())
      .post('/api/v1/tenants/register')
      .set('Authorization', `Bearer ${regToken2}`)
      .send({
        displayName: 'Beta Healthcare',
        legalName: 'Beta Healthcare Corp',
        slug: 'p4b-obs-beta',
        organizationType: 'COMPANY',
        industry: 'HEALTHCARE_LIFE_SCIENCES',
        countryCode: 'US',
        defaultTimezone: 'UTC',
        defaultCurrency: 'USD',
      })
      .expect(201);

    const regData2 = (regRes2.body as ApiSuccessResponse<TenantRegistrationResponsePayload>).data;
    expect(regData2.tenant.id).toBeDefined();
  });

  afterAll(async () => {
    try {
      await cleanFixtures(migratorPool);
      await cleanRateLimits();
      if (app) {
        await app.close();
      }
      if (migratorPool) {
        await migratorPool.end();
      }
    } catch {
      // Ignore teardown errors
    }
  });

  // =========================================================================
  // 1. Onboarding Wizard APIs (API #3, #4, #5)
  // =========================================================================
  describe('1. Onboarding Wizard APIs (#3, #4, #5)', () => {
    it('API #3: GET /api/v1/workspace/onboarding retrieves initial state', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/workspace/onboarding')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      const body = res.body as ApiSuccessResponse<TenantOnboardingStatePayload>;
      expect(body.success).toBe(true);
      expect(body.data.tenantId).toBe(tenantAlpha.id);
      expect(body.data.onboardingStatus).toBe('IN_PROGRESS');
      expect(body.data.currentStep).toBe('ORG_PROFILE');
      expect(body.data.version).toBe(1);
      expect(body.data.steps.orgProfile.completed).toBe(false);
      expect(body.data.steps.orgSettings.completed).toBe(false);
    });

    it('API #4: PATCH /api/v1/workspace/onboarding/steps/org-profile rejects skip with 422', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/v1/workspace/onboarding/steps/org-profile')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          expectedVersion: 1,
          skipped: true,
        })
        .expect(422);

      const body = res.body as ApiErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('REQUIRED_ONBOARDING_STEP');
    });

    it('API #4: PATCH /api/v1/workspace/onboarding/steps/org-profile completes Step 1 and advances to Step 2', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/v1/workspace/onboarding/steps/org-profile')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          expectedVersion: 1,
        })
        .expect(200);

      const body = res.body as ApiSuccessResponse<TenantOnboardingStatePayload>;
      expect(body.success).toBe(true);
      expect(body.data.currentStep).toBe('ORG_SETTINGS');
      expect(body.data.steps.orgProfile.completed).toBe(true);
      expect(body.data.steps.orgProfile.completedAt).toBeDefined();
      expect(body.data.version).toBe(2);
    });

    it('API #4: PATCH rejects stale expectedVersion with 409 ONBOARDING_VERSION_CONFLICT', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/v1/workspace/onboarding/steps/org-settings')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          expectedVersion: 1, // Current is 2
        })
        .expect(409);

      const body = res.body as ApiErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('ONBOARDING_VERSION_CONFLICT');
    });

    it('API #5: POST /api/v1/workspace/onboarding/complete fails with 422 before Step 2 is completed', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/workspace/onboarding/complete')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          expectedVersion: 2,
        })
        .expect(422);

      const body = res.body as ApiErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('ONBOARDING_PREREQUISITES_INCOMPLETE');
    });

    it('API #4: Completes Step 2 (org-settings), skips Step 3 (org-branding), and skips Step 4 (team-invites)', async () => {
      // Complete Step 2
      const step2Res = await request(app.getHttpServer())
        .patch('/api/v1/workspace/onboarding/steps/org-settings')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ expectedVersion: 2 })
        .expect(200);
      expect((step2Res.body as ApiSuccessResponse<TenantOnboardingStatePayload>).data.currentStep).toBe(
        'ORG_BRANDING',
      );

      // Skip Step 3
      const step3Res = await request(app.getHttpServer())
        .patch('/api/v1/workspace/onboarding/steps/org-branding')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ expectedVersion: 3, skipped: true })
        .expect(200);
      expect((step3Res.body as ApiSuccessResponse<TenantOnboardingStatePayload>).data.currentStep).toBe(
        'TEAM_INVITES',
      );

      // Skip Step 4
      const step4Res = await request(app.getHttpServer())
        .patch('/api/v1/workspace/onboarding/steps/team-invites')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ expectedVersion: 4, skipped: true })
        .expect(200);
      expect((step4Res.body as ApiSuccessResponse<TenantOnboardingStatePayload>).data.currentStep).toBe(
        'REVIEW_COMPLETE',
      );
    });

    it('API #5: POST /api/v1/workspace/onboarding/complete marks onboarding COMPLETED', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/workspace/onboarding/complete')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          expectedVersion: 5,
        })
        .expect(200);

      const body = res.body as ApiSuccessResponse<CompleteOnboardingPayload>;
      expect(body.success).toBe(true);
      expect(body.data.onboardingStatus).toBe('COMPLETED');
      expect(body.data.version).toBe(6);
      expect(body.data.completedAt).toBeDefined();

      // Verify database state directly
      const dbCheck = await migratorPool.query<{ onboarding_status: string }>(
        `SELECT onboarding_status FROM public.tenant_onboarding_states WHERE tenant_id = $1::uuid`,
        [tenantAlpha.id],
      );
      expect(dbCheck.rows[0].onboarding_status).toBe('COMPLETED');
    });
  });

  // =========================================================================
  // 2. Organization Profile APIs (API #6, #7)
  // =========================================================================
  describe('2. Organization Profile APIs (#6, #7)', () => {
    it('API #6: GET /api/v1/workspace/organization/profile retrieves current joined profile', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/workspace/organization/profile')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      const body = res.body as ApiSuccessResponse<OrganizationProfilePayload>;
      expect(body.success).toBe(true);
      expect(body.data.tenantId).toBe(tenantAlpha.id);
      expect(body.data.slug).toBe('p4b-obs-alpha');
      expect(body.data.displayName).toBe('Alpha Logistics');
      expect(body.data.countryCode).toBe('US');
      expect(body.data.version).toBe(1);
    });

    it('API #7: PUT /api/v1/workspace/organization/profile rejects version mismatch with 409', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/v1/workspace/organization/profile')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          displayName: 'Alpha Logistics Updated',
          legalName: 'Alpha Logistics International LLC',
          organizationType: 'COMPANY',
          industry: 'LOGISTICS_SUPPLY_CHAIN',
          countryCode: 'US',
          expectedVersion: 99,
        })
        .expect(409);

      const body = res.body as ApiErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('PROFILE_VERSION_CONFLICT');
    });

    it('API #7: PUT /api/v1/workspace/organization/profile updates profile and syncs tenant names', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/v1/workspace/organization/profile')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          displayName: 'Alpha Global Logistics',
          legalName: 'Alpha Global Logistics Inc',
          organizationType: 'COMPANY',
          industry: 'LOGISTICS_SUPPLY_CHAIN',
          countryCode: 'US',
          companySizeBand: '51-200',
          registrationNumber: 'REG-ALPHA-001',
          websiteUrl: 'https://alpha-logistics.test',
          primaryContactName: 'John Alpha',
          primaryContactEmail: 'john@alpha-logistics.test',
          primaryContactPhoneE164: '+12125550199',
          city: 'New York',
          stateProvince: 'NY',
          postalCode: '10001',
          expectedVersion: 1,
        })
        .expect(200);

      const body = res.body as ApiSuccessResponse<OrganizationProfilePayload>;
      expect(body.success).toBe(true);
      expect(body.data.displayName).toBe('Alpha Global Logistics');
      expect(body.data.legalName).toBe('Alpha Global Logistics Inc');
      expect(body.data.companySizeBand).toBe('51-200');
      expect(body.data.registrationNumber).toBe('REG-ALPHA-001');
      expect(body.data.version).toBe(2);

      // Verify tenants table synchronization in DB
      const tenantCheck = await migratorPool.query<{ display_name: string; legal_name: string }>(
        `SELECT display_name, legal_name FROM public.tenants WHERE id = $1::uuid`,
        [tenantAlpha.id],
      );
      expect(tenantCheck.rows[0].display_name).toBe('Alpha Global Logistics');
      expect(tenantCheck.rows[0].legal_name).toBe('Alpha Global Logistics Inc');
    });
  });

  // =========================================================================
  // 3. Organization Settings APIs (API #8, #9)
  // =========================================================================
  describe('3. Organization Settings APIs (#8, #9)', () => {
    it('API #8: GET /api/v1/workspace/organization/settings returns settings and caches in Redis', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/workspace/organization/settings')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      const body = res.body as ApiSuccessResponse<TenantSettingsPayload>;
      expect(body.success).toBe(true);
      expect(body.data.tenantId).toBe(tenantAlpha.id);
      expect(body.data.timezone).toBe('America/New_York');
      expect(body.data.defaultCurrency).toBe('USD');
      expect(body.data.version).toBe(1);

      // Verify key was set in Redis
      const cached = await redisService.getTenantJson<TenantSettingsPayload>(
        tenantAlpha.id,
        'settings',
        'active',
      );
      expect(cached).toBeDefined();
      expect(cached?.timezone).toBe('America/New_York');
    });

    it('API #9: PUT /api/v1/workspace/organization/settings rejects version mismatch with 409', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/v1/workspace/organization/settings')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          timezone: 'America/Chicago',
          locale: 'en-US',
          dateFormat: 'YYYY-MM-DD',
          timeFormat: '24H',
          defaultCurrency: 'USD',
          weekStartDay: 1,
          fiscalYearStartMonth: 1,
          invitationExpiryHours: 168,
          allowMemberDirectoryView: false,
          expectedVersion: 99,
        })
        .expect(409);

      const body = res.body as ApiErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('SETTINGS_VERSION_CONFLICT');
    });

    it('API #9: PUT /api/v1/workspace/organization/settings updates settings, invalidates Redis, and syncs tenant', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/v1/workspace/organization/settings')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          timezone: 'America/Chicago',
          locale: 'en-US',
          dateFormat: 'MM/DD/YYYY',
          timeFormat: '12H',
          defaultCurrency: 'USD',
          weekStartDay: 0,
          fiscalYearStartMonth: 4,
          invitationExpiryHours: 72,
          allowMemberDirectoryView: true,
          expectedVersion: 1,
        })
        .expect(200);

      const body = res.body as ApiSuccessResponse<TenantSettingsPayload>;
      expect(body.success).toBe(true);
      expect(body.data.timezone).toBe('America/Chicago');
      expect(body.data.dateFormat).toBe('MM/DD/YYYY');
      expect(body.data.timeFormat).toBe('12H');
      expect(body.data.weekStartDay).toBe(0);
      expect(body.data.fiscalYearStartMonth).toBe(4);
      expect(body.data.invitationExpiryHours).toBe(72);
      expect(body.data.allowMemberDirectoryView).toBe(true);
      expect(body.data.version).toBe(2);

      // Verify Redis cache key was invalidated
      const cached = await redisService.getTenantJson<TenantSettingsPayload>(
        tenantAlpha.id,
        'settings',
        'active',
      );
      expect(cached).toBeNull();

      // Verify default_timezone was synced on public.tenants
      const tenantCheck = await migratorPool.query<{ default_timezone: string }>(
        `SELECT default_timezone FROM public.tenants WHERE id = $1::uuid`,
        [tenantAlpha.id],
      );
      expect(tenantCheck.rows[0].default_timezone).toBe('America/Chicago');
    });
  });

  // =========================================================================
  // 4. Security, RLS Isolation, and Audit Trail Verification
  // =========================================================================
  describe('4. Security, RLS Isolation & Audit Trail', () => {
    it('cross-tenant query attempt is rejected (User Beta cannot access Tenant Alpha settings)', async () => {
      // User Beta attempts to query with activeTenantId = tenantAlpha.id
      const { token: maliciousToken } = await createSessionAndToken(
        secondUser.id,
        tenantAlpha.id, // Target Alpha without membership
      );

      const res = await request(app.getHttpServer())
        .get('/api/v1/workspace/organization/settings')
        .set('Authorization', `Bearer ${maliciousToken}`)
        .expect(403);

      const body = res.body as ApiErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('TENANT_MEMBERSHIP_DENIED');
    });

    it('verifies audit logs recorded in public.tenant_audit_logs for all 4B mutations', async () => {
      const logs = await migratorPool.query<{ event_type: string; resource_type: string }>(
        `SELECT event_type, resource_type
         FROM public.tenant_audit_logs
         WHERE tenant_id = $1::uuid
         ORDER BY created_at ASC`,
        [tenantAlpha.id],
      );

      const eventTypes = logs.rows.map((r) => r.event_type);
      expect(eventTypes).toContain('TENANT_ONBOARDING_STEP_SAVED');
      expect(eventTypes).toContain('TENANT_ONBOARDING_COMPLETED');
      expect(eventTypes).toContain('TENANT_PROFILE_UPDATED');
      expect(eventTypes).toContain('TENANT_SETTINGS_UPDATED');
    });
  });
});
