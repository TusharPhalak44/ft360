import { getQueueToken } from '@nestjs/bullmq';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueueEvents, type Queue } from 'bullmq';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureNestApp } from '../../src/bootstrap';
import { RedisService } from '../../src/cache/redis.service';
import { APP_CONFIG, loadAppConfig, type AppEnvConfig } from '../../src/config/env.config';
import { DatabasePoolService } from '../../src/database/database-pool.service';
import { InvalidTenantContextError } from '../../src/database/database.types';
import { SqlMigrationRunner } from '../../src/database/migrations/migration-runner';
import { TenantTransactionManager } from '../../src/database/tenant-transaction.manager';
import {
  SYSTEM_MAINTENANCE_QUEUE,
  type CanaryJobPayload,
  type CanaryJobResult,
} from '../../src/jobs/foundation-canary.processor';
import { createTenantJobEnvelope } from '../../src/jobs/tenant-job-envelope';

const TENANT_ALPHA = '0195f3a2-7c40-7b12-9a10-4e8d21b91111';
const TENANT_BETA = '0195f3a2-7c40-7b12-9a10-4e8d21b92222';
const USER_ALPHA = '0195f3a2-7c40-7b12-9a10-4e8d21b9aaaa';
const USER_BETA = '0195f3a2-7c40-7b12-9a10-4e8d21b9bbbb';
const CORR_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b9cccc';

describe('Phase 1 Live Infrastructure, PostgreSQL 18 RLS, Pool & BullMQ Suite', () => {
  let app: INestApplication;
  let config: AppEnvConfig;
  let dbPool: DatabasePoolService;
  let txManager: TenantTransactionManager;
  let redisService: RedisService;
  let maintenanceQueue: Queue;
  let queueEvents: QueueEvents;

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

    // 2. Boot full NestJS application (including BullMQ WorkerHost) against real PostgreSQL 18 + Redis
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue({ ...config, database: { ...config.database, poolMin: 1, poolMax: 6 } })
      .compile();

    app = moduleRef.createNestApplication();
    configureNestApp(app);
    await app.init();

    dbPool = app.get(DatabasePoolService);
    txManager = app.get(TenantTransactionManager);
    redisService = app.get(RedisService);
    maintenanceQueue = app.get<Queue>(getQueueToken(SYSTEM_MAINTENANCE_QUEUE));

    queueEvents = new QueueEvents(SYSTEM_MAINTENANCE_QUEUE, {
      prefix: 'ft360:q',
      connection: {
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        db: config.redis.queueDb,
      },
    });
    await queueEvents.waitUntilReady();

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
    if (queueEvents) {
      await queueEvents.close();
    }
    if (app) {
      await app.close();
    }
  });

  it('confirms actual PostgreSQL host/port, ft360_app least-privilege permissions, and migration SHA-256 checksums', async () => {
    const posture = await dbPool.queryUnscoped<{
      server_addr: string;
      server_port: number;
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      owned_tables: string;
      tableowner: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT
         host(inet_server_addr()) AS server_addr,
         inet_server_port() AS server_port,
         current_user::text AS current_user,
         r.rolsuper,
         r.rolbypassrls,
         r.rolcreatedb,
         r.rolcreaterole,
         r.rolinherit,
         (SELECT COUNT(*)::text FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owned_tables,
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
    expect(row.current_user).toBe('ft360_app');
    expect(row.rolsuper).toBe(false);
    expect(row.rolbypassrls).toBe(false);
    expect(row.rolcreatedb).toBe(false);
    expect(row.rolcreaterole).toBe(false);
    expect(row.rolinherit).toBe(false);
    expect(row.owned_tables).toBe('0');
    expect(row.tableowner).toBe('ft360_migrator');
    expect(row.relrowsecurity).toBe(true);
    expect(row.relforcerowsecurity).toBe(true);

    // Verify ft360_app cannot execute DDL (CREATE TABLE / DROP TABLE denied with 42501)
    await expect(
      dbPool.queryUnscoped('CREATE TABLE public.unauthorized_ddl_attempt (id int)'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      dbPool.queryUnscoped('DROP TABLE public.rls_isolation_canary'),
    ).rejects.toMatchObject({ code: '42501' });

    // Verify schema_migrations rows and exact SHA-256 checksum parity with disk files
    const runner = new SqlMigrationRunner(config.database.migratorUrl);
    try {
      const diskMigrations = runner.discoverMigrations();
      const dbLedger = await dbPool.queryUnscoped<{
        version: string;
        name: string;
        checksum_sha256: string;
      }>(`SELECT version, name, checksum_sha256 FROM public.schema_migrations ORDER BY version ASC`);

      expect(dbLedger.rows.length).toBe(diskMigrations.length);
      for (let i = 0; i < diskMigrations.length; i++) {
        expect(dbLedger.rows[i].version).toBe(diskMigrations[i].version);
        expect(dbLedger.rows[i].name).toBe(diskMigrations[i].name);
        expect(dbLedger.rows[i].checksum_sha256).toBe(diskMigrations[i].checksumSha256);
      }
    } finally {
      await runner.close();
    }
  });

  it('enforces cross-tenant RLS isolation and verifies concurrent connection pooling across tenants', async () => {
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

    // Negative cross-tenant checks from Tenant Beta
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

    // Concurrent multi-connection pool stress check across Tenant Alpha and Tenant Beta simultaneously
    const concurrentResults = await Promise.all(
      Array.from({ length: 8 }, (_, idx) => {
        const isAlpha = idx % 2 === 0;
        const tid = isAlpha ? TENANT_ALPHA : TENANT_BETA;
        const uid = isAlpha ? USER_ALPHA : USER_BETA;
        return txManager.withTenantTransaction(
          { tenantId: tid, actorUserId: uid, correlationId: CORR_ID },
          async (tx) => {
            const res = await tx.query<{ tenant_id: string }>(
              `SELECT tenant_id FROM public.rls_isolation_canary`,
            );
            return { expected: tid, rows: res.rows.map((r) => r.tenant_id) };
          },
        );
      }),
    );

    for (const item of concurrentResults) {
      expect(item.rows.length).toBeGreaterThanOrEqual(1);
      expect(item.rows.every((t) => t === item.expected)).toBe(true);
    }
  });

  it('fails closed on missing/invalid tenant context and prevents queries from bypassing TenantTransactionManager', async () => {
    // Missing/empty context rejected by TenantTransactionManager
    await expect(
      txManager.withTenantTransaction(
        { tenantId: '', actorUserId: USER_ALPHA, correlationId: CORR_ID },
        async () => 'never',
      ),
    ).rejects.toThrow(InvalidTenantContextError);

    // Invalid context rejected by TenantTransactionManager
    await expect(
      txManager.withTenantTransaction(
        { tenantId: 'invalid-tenant-context', actorUserId: USER_ALPHA, correlationId: CORR_ID },
        async () => 'never',
      ),
    ).rejects.toThrow(InvalidTenantContextError);

    // Direct unscoped SELECT bypassing TenantTransactionManager -> 0 rows
    const unscopedSelect = await dbPool.queryUnscoped(`SELECT * FROM public.rls_isolation_canary`);
    expect(unscopedSelect.rows).toHaveLength(0);

    // Direct unscoped INSERT bypassing TenantTransactionManager -> rejected by PostgreSQL RLS (42501)
    await expect(
      dbPool.queryUnscoped(
        `INSERT INTO public.rls_isolation_canary (tenant_id, probe_label) VALUES ($1, $2)`,
        [TENANT_ALPHA, 'bypass-attempt'],
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Malformed app.current_tenant_id in SQL fails closed to NULL (0 rows)
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

  it('verifies transaction rollback atomicity and zero context leakage on single-connection pool reuse', async () => {
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

      // Step A: Valid COMMIT under Tenant Alpha
      await singleTxMgr.withTenantTransaction(
        { tenantId: TENANT_ALPHA, actorUserId: USER_ALPHA, correlationId: CORR_ID },
        async (tx) => {
          const rows = await tx.query(`SELECT * FROM public.rls_isolation_canary`);
          expect(rows.rows.length).toBeGreaterThanOrEqual(1);
        },
      );

      // Reuse same physical connection without context -> 0 rows
      const afterCommit = await singleConnPool.query(`SELECT * FROM public.rls_isolation_canary`);
      expect(afterCommit.rows).toHaveLength(0);

      // Step B: Insert row then throw inside transaction -> verify ROLLBACK discards row AND resets connection
      await expect(
        singleTxMgr.withTenantTransaction(
          { tenantId: TENANT_ALPHA, actorUserId: USER_ALPHA, correlationId: CORR_ID },
          async (tx) => {
            await tx.query(
              `INSERT INTO public.rls_isolation_canary (tenant_id, probe_label) VALUES ($1, $2)`,
              [TENANT_ALPHA, 'must-rollback-atomically'],
            );
            throw new Error('force-rollback');
          },
        ),
      ).rejects.toThrow('force-rollback');

      const afterRollback = await singleConnPool.query(`SELECT * FROM public.rls_isolation_canary`);
      expect(afterRollback.rows).toHaveLength(0);

      // Verify rolled-back row does not exist in Tenant Alpha
      await singleTxMgr.withTenantTransaction(
        { tenantId: TENANT_ALPHA, actorUserId: USER_ALPHA, correlationId: CORR_ID },
        async (tx) => {
          const check = await tx.query(
            `SELECT * FROM public.rls_isolation_canary WHERE probe_label = $1`,
            ['must-rollback-atomically'],
          );
          expect(check.rows).toHaveLength(0);
        },
      );

      // Step C: Simulate rogue session-level SET on pooled connection -> TenantTransactionManager sanitizes it
      await singleConnPool.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [
        TENANT_ALPHA,
      ]);
      await singleTxMgr.withTenantTransaction(
        { tenantId: TENANT_BETA, actorUserId: USER_BETA, correlationId: CORR_ID },
        async (tx) => {
          const rows = await tx.query<{ tenant_id: string }>(
            `SELECT tenant_id FROM public.rls_isolation_canary`,
          );
          expect(rows.rows.every((r) => r.tenant_id === TENANT_BETA)).toBe(true);
        },
      );

      const afterSanitize = await singleConnPool.query(`SELECT * FROM public.rls_isolation_canary`);
      expect(afterSanitize.rows).toHaveLength(0);
    } finally {
      await singleConnPool.end();
    }
  });

  it('verifies Redis tenant key isolation AND executes real BullMQ jobs (completion + failure rollback)', async () => {
    // 1. Redis tenant key isolation
    await redisService.setTenantJson(TENANT_ALPHA, 'settings', 'theme', { color: 'blue' }, 30);
    const alphaRead = await redisService.getTenantJson<{ color: string }>(
      TENANT_ALPHA,
      'settings',
      'theme',
    );
    const betaRead = await redisService.getTenantJson<{ color: string }>(
      TENANT_BETA,
      'settings',
      'theme',
    );
    expect(alphaRead).toEqual({ color: 'blue' });
    expect(betaRead).toBeNull();
    await redisService.deleteTenantKey(TENANT_ALPHA, 'settings', 'theme');

    // 2. BullMQ queue creation + successful tenant-isolated background job execution
    const successEnvelope = createTenantJobEnvelope<CanaryJobPayload>(
      { tenantId: TENANT_ALPHA, actorUserId: USER_ALPHA, correlationId: CORR_ID },
      { probeLabel: 'bullmq-alpha-completed-job' },
    );
    const successJob = await maintenanceQueue.add('canary-ok', successEnvelope);
    const jobResult = (await successJob.waitUntilFinished(queueEvents, 10000)) as CanaryJobResult;

    expect(jobResult.tenantId).toBe(TENANT_ALPHA);
    expect(jobResult.probeLabel).toBe('bullmq-alpha-completed-job');

    // Verify Tenant Alpha sees the job's DB write while Tenant Beta sees nothing
    await txManager.withTenantTransaction(
      { tenantId: TENANT_ALPHA, actorUserId: USER_ALPHA, correlationId: CORR_ID },
      async (tx) => {
        const res = await tx.query(
          `SELECT id FROM public.rls_isolation_canary WHERE id = $1`,
          [jobResult.insertedId],
        );
        expect(res.rowCount).toBe(1);
      },
    );
    await txManager.withTenantTransaction(
      { tenantId: TENANT_BETA, actorUserId: USER_BETA, correlationId: CORR_ID },
      async (tx) => {
        const res = await tx.query(
          `SELECT id FROM public.rls_isolation_canary WHERE id = $1`,
          [jobResult.insertedId],
        );
        expect(res.rowCount).toBe(0);
      },
    );

    // 3. BullMQ job failure handling + DB transaction rollback on worker error
    const failEnvelope = createTenantJobEnvelope<CanaryJobPayload>(
      { tenantId: TENANT_ALPHA, actorUserId: USER_ALPHA, correlationId: CORR_ID },
      { probeLabel: 'bullmq-must-rollback', simulateFailure: true },
    );
    const failingJob = await maintenanceQueue.add('canary-fail', failEnvelope);
    await expect(failingJob.waitUntilFinished(queueEvents, 10000)).rejects.toThrow(
      /Simulated BullMQ worker failure/,
    );
    expect(await failingJob.getState()).toBe('failed');

    await txManager.withTenantTransaction(
      { tenantId: TENANT_ALPHA, actorUserId: USER_ALPHA, correlationId: CORR_ID },
      async (tx) => {
        const res = await tx.query(
          `SELECT id FROM public.rls_isolation_canary WHERE probe_label = $1`,
          ['bullmq-must-rollback'],
        );
        expect(res.rowCount).toBe(0);
      },
    );

    // 4. BullMQ rejection when background job lacks valid tenant envelope
    const forgedJob = await maintenanceQueue.add('canary-forged', {
      tenantId: 'not-a-valid-uuid',
      payload: { probeLabel: 'forged' },
    });
    await expect(forgedJob.waitUntilFinished(queueEvents, 10000)).rejects.toThrow(/job\.tenantId/);
    expect(await forgedJob.getState()).toBe('failed');
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
