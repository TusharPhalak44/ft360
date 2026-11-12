import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureNestApp } from '../../src/bootstrap';
import { RedisService } from '../../src/cache/redis.service';
import { APP_CONFIG, loadAppConfig, type AppEnvConfig } from '../../src/config/env.config';
import { DatabasePoolService } from '../../src/database/database-pool.service';
import { SqlMigrationRunner } from '../../src/database/migrations/migration-runner';
import { TenantTransactionManager } from '../../src/database/tenant-transaction.manager';

const TENANT_ALPHA = '0195f3a2-7c40-7b12-9a10-4e8d21b91111';
const TENANT_BETA = '0195f3a2-7c40-7b12-9a10-4e8d21b92222';
const USER_ALPHA = '0195f3a2-7c40-7b12-9a10-4e8d21b9aaaa';
const USER_BETA = '0195f3a2-7c40-7b12-9a10-4e8d21b9bbbb';
const CORR_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b9cccc';

describe('Phase 1 Integration & Database RLS Isolation Suite (Real PostgreSQL 18 + Redis)', () => {
  let app: INestApplication;
  let config: AppEnvConfig;
  let dbPool: DatabasePoolService;
  let txManager: TenantTransactionManager;
  let redisService: RedisService;

  beforeAll(async () => {
    config = loadAppConfig();

    // 1. Verify SQL migration framework: migrate up -> rollback latest -> re-migrate up
    const runner = new SqlMigrationRunner(config.database.migratorUrl);
    try {
      await runner.migrateUp();
      const rolledBack = await runner.rollbackLatest();
      expect(rolledBack).toBe('0002_foundation_branding_and_rls_canary');
      const reApplied = await runner.migrateUp();
      expect(reApplied).toContain('0002_foundation_branding_and_rls_canary');
    } finally {
      await runner.close();
    }

    // 2. Boot full NestJS application against real PostgreSQL 18 + Redis
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue({ ...config, database: { ...config.database, poolMin: 1, poolMax: 4 } })
      .compile();

    app = moduleRef.createNestApplication();
    configureNestApp(app);
    await app.init();

    dbPool = app.get(DatabasePoolService);
    txManager = app.get(TenantTransactionManager);
    redisService = app.get(RedisService);

    // Clean any leftover canary rows inside isolated tenant transactions
    for (const [tid, uid] of [
      [TENANT_ALPHA, USER_ALPHA],
      [TENANT_BETA, USER_BETA],
    ] as const) {
      await txManager.withTenantTransaction(
        { tenantId: tid, actorUserId: uid, correlationId: CORR_ID },
        (tx) => tx.query('DELETE FROM public.rls_isolation_canary'),
      );
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('enforces least-privilege runtime DB role (non-owner, NOSUPERUSER, NOBYPASSRLS) and FORCE RLS', async () => {
    const posture = await dbPool.queryUnscoped<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      tableowner: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT
         current_user::text AS current_user,
         r.rolsuper,
         r.rolbypassrls,
         t.tableowner,
         c.relrowsecurity,
         c.relforcerowsecurity
       FROM pg_roles r
       CROSS JOIN pg_tables t
       JOIN pg_class c ON c.relname = t.tablename
       WHERE r.rolname = current_user
         AND t.schemaname = 'public'
         AND t.tablename = 'rls_isolation_canary'`,
    );

    const row = posture.rows[0];
    expect(row).toBeDefined();
    expect(row.rolsuper).toBe(false);
    expect(row.rolbypassrls).toBe(false);
    expect(row.tableowner).not.toBe(row.current_user);
    expect(row.relrowsecurity).toBe(true);
    expect(row.relforcerowsecurity).toBe(true);
  });

  it('isolates Tenant Alpha and Tenant Beta records and blocks cross-tenant INSERT/UPDATE/DELETE', async () => {
    const alphaInsert = await txManager.withTenantTransaction(
      { tenantId: TENANT_ALPHA, actorUserId: USER_ALPHA, correlationId: CORR_ID },
      (tx) =>
        tx.query<{ id: string; tenant_id: string }>(
          `INSERT INTO public.rls_isolation_canary (tenant_id, probe_label)
           VALUES ($1, $2)
           RETURNING id, tenant_id`,
          [TENANT_ALPHA, 'alpha-secret-record'],
        ),
    );
    const alphaRowId = alphaInsert.rows[0].id;

    await txManager.withTenantTransaction(
      { tenantId: TENANT_BETA, actorUserId: USER_BETA, correlationId: CORR_ID },
      (tx) =>
        tx.query(
          `INSERT INTO public.rls_isolation_canary (tenant_id, probe_label)
           VALUES ($1, $2)`,
          [TENANT_BETA, 'beta-secret-record'],
        ),
    );

    // Tenant Beta cannot SELECT, UPDATE, or DELETE Tenant Alpha's row, nor INSERT with Tenant Alpha's tenant_id
    await txManager.withTenantTransaction(
      { tenantId: TENANT_BETA, actorUserId: USER_BETA, correlationId: CORR_ID },
      async (tx) => {
        const visible = await tx.query<{ probe_label: string }>(
          `SELECT probe_label FROM public.rls_isolation_canary`,
        );
        expect(visible.rows).toEqual([{ probe_label: 'beta-secret-record' }]);

        const updateCross = await tx.query(
          `UPDATE public.rls_isolation_canary SET probe_label = 'tampered' WHERE id = $1`,
          [alphaRowId],
        );
        expect(updateCross.rowCount).toBe(0);

        const deleteCross = await tx.query(
          `DELETE FROM public.rls_isolation_canary WHERE id = $1`,
          [alphaRowId],
        );
        expect(deleteCross.rowCount).toBe(0);

        await expect(
          tx.query(
            `INSERT INTO public.rls_isolation_canary (tenant_id, probe_label) VALUES ($1, $2)`,
            [TENANT_ALPHA, 'forged-from-beta'],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      },
    );
  });

  it('fails closed when queries bypass TenantTransactionManager or supply malformed SQL tenant context', async () => {
    // 1. Direct unscoped SELECT bypassing TenantTransactionManager -> 0 rows
    const unscopedSelect = await dbPool.queryUnscoped(
      `SELECT * FROM public.rls_isolation_canary`,
    );
    expect(unscopedSelect.rows).toHaveLength(0);

    // 2. Direct unscoped INSERT bypassing TenantTransactionManager -> rejected by PostgreSQL RLS (42501)
    await expect(
      dbPool.queryUnscoped(
        `INSERT INTO public.rls_isolation_canary (tenant_id, probe_label) VALUES ($1, $2)`,
        [TENANT_ALPHA, 'bypass-attempt'],
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // 3. Malformed app.current_tenant_id in SQL fails closed to NULL (0 rows, no crash)
    const client = await dbPool.connectClient();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', 'malformed-not-uuid', true)`);
      const malformedRes = await client.query<{ tid: string | null; count: string }>(
        `SELECT app_current_tenant_id()::text AS tid, COUNT(*)::text AS count FROM public.rls_isolation_canary`,
      );
      expect(malformedRes.rows[0].tid).toBeNull();
      expect(malformedRes.rows[0].count).toBe('0');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('prevents connection-pool context leakage across COMMIT, ROLLBACK, and rogue session SET on a single-connection pool', async () => {
    const singleConnPool = new Pool({
      connectionString: config.database.appUrl,
      min: 1,
      max: 1,
    });

    try {
      const singlePoolService = {
        connectClient: () => singleConnPool.connect(),
      } as unknown as DatabasePoolService;
      const singleTxMgr = new TenantTransactionManager(singlePoolService);

      // Step A: Execute valid COMMIT under Tenant Alpha
      await singleTxMgr.withTenantTransaction(
        { tenantId: TENANT_ALPHA, actorUserId: USER_ALPHA, correlationId: CORR_ID },
        async (tx) => {
          const rows = await tx.query(`SELECT * FROM public.rls_isolation_canary`);
          expect(rows.rows.length).toBeGreaterThanOrEqual(1);
        },
      );

      // Reuse exact same physical connection without setting context -> must see 0 rows
      const afterCommit = await singleConnPool.query(`SELECT * FROM public.rls_isolation_canary`);
      expect(afterCommit.rows).toHaveLength(0);

      // Step B: Execute failing transaction (ROLLBACK) under Tenant Alpha
      await expect(
        singleTxMgr.withTenantTransaction(
          { tenantId: TENANT_ALPHA, actorUserId: USER_ALPHA, correlationId: CORR_ID },
          async (tx) => {
            await tx.query(`SELECT * FROM public.rls_isolation_canary`);
            throw new Error('force-rollback');
          },
        ),
      ).rejects.toThrow('force-rollback');

      const afterRollback = await singleConnPool.query(`SELECT * FROM public.rls_isolation_canary`);
      expect(afterRollback.rows).toHaveLength(0);

      // Step C: Simulate a rogue session-level SET on the pooled connection, then verify TenantTransactionManager sanitizes it
      await singleConnPool.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [TENANT_ALPHA]);
      await singleTxMgr.withTenantTransaction(
        { tenantId: TENANT_BETA, actorUserId: USER_BETA, correlationId: CORR_ID },
        async (tx) => {
          const rows = await tx.query<{ tenant_id: string }>(`SELECT tenant_id FROM public.rls_isolation_canary`);
          expect(rows.rows.every((r) => r.tenant_id === TENANT_BETA)).toBe(true);
        },
      );

      // And after release, even the prior rogue session variable was wiped clean!
      const afterSanitize = await singleConnPool.query(`SELECT * FROM public.rls_isolation_canary`);
      expect(afterSanitize.rows).toHaveLength(0);
    } finally {
      await singleConnPool.end();
    }
  });

  it('isolates Redis cache entries strictly by tenant UUID prefix', async () => {
    await redisService.setTenantJson(TENANT_ALPHA, 'settings', 'theme', { color: 'blue' }, 30);
    const alphaRead = await redisService.getTenantJson<{ color: string }>(TENANT_ALPHA, 'settings', 'theme');
    const betaRead = await redisService.getTenantJson<{ color: string }>(TENANT_BETA, 'settings', 'theme');

    expect(alphaRead).toEqual({ color: 'blue' });
    expect(betaRead).toBeNull();

    await redisService.deleteTenantKey(TENANT_ALPHA, 'settings', 'theme');
  });

  it('serves health, configurable branding, Swagger OpenAPI, and rejects untrusted tenant HTTP inputs', async () => {
    const httpServer = app.getHttpServer();

    const liveRes = await request(httpServer)
      .get('/api/v1/health/live')
      .set('X-Correlation-Id', CORR_ID)
      .expect(200);
    expect(liveRes.headers['x-correlation-id']).toBe(CORR_ID);
    expect(liveRes.body.success).toBe(true);
    expect(liveRes.body.data.status).toBe('alive');

    const healthRes = await request(httpServer).get('/api/v1/health').expect(200);
    expect(healthRes.body.success).toBe(true);
    expect(healthRes.body.data.status).toBe('healthy');
    expect(healthRes.body.data.database.connected).toBe(true);
    expect(healthRes.body.data.database.bypassRls).toBe(false);
    expect(healthRes.body.data.database.isSuperuser).toBe(false);
    expect(healthRes.body.data.database.appliedMigrations).toBeGreaterThanOrEqual(2);
    expect(healthRes.body.data.redis.connected).toBe(true);

    const brandingRes = await request(httpServer).get('/api/v1/public/branding').expect(200);
    expect(brandingRes.body.success).toBe(true);
    expect(brandingRes.body.data.productName).toBeTruthy();

    const swaggerRes = await request(httpServer).get('/api/docs-json').expect(200);
    expect(swaggerRes.body.openapi).toMatch(/^3\./);
    expect(swaggerRes.body.paths['/api/v1/health']).toBeDefined();

    const spoofHeaderRes = await request(httpServer)
      .get('/api/v1/health')
      .set('x-tenant-id', TENANT_ALPHA)
      .expect(400);
    expect(spoofHeaderRes.body.success).toBe(false);
    expect(spoofHeaderRes.body.error.code).toBe('UNTRUSTED_TENANT_INPUT_REJECTED');

    const spoofQueryRes = await request(httpServer)
      .get(`/api/v1/public/branding?tenant_id=${TENANT_ALPHA}`)
      .expect(400);
    expect(spoofQueryRes.body.error.code).toBe('UNTRUSTED_TENANT_INPUT_REJECTED');
  });
});

