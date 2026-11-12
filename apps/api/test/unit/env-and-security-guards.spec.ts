import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PoolClient } from 'pg';
import { RedisService } from '../../src/cache/redis.service';
import { UntrustedTenantInputGuard } from '../../src/common/untrusted-tenant-input.guard';
import { loadAppConfig } from '../../src/config/env.config';
import type { DatabasePoolService } from '../../src/database/database-pool.service';
import { InvalidTenantContextError } from '../../src/database/database.types';
import { TenantTransactionManager } from '../../src/database/tenant-transaction.manager';
import {
  createTenantJobEnvelope,
  verifyTenantJobEnvelope,
} from '../../src/jobs/tenant-job-envelope';
import { SqlMigrationRunner } from '../../src/database/migrations/migration-runner';

const TENANT_A = '0195f3a2-7c40-7b12-9a10-4e8d21b90001';
const USER_A = '0195f3a2-7c40-7b12-9a10-4e8d21b90099';
const CORR_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b90888';

function createMockExecutionContext(req: {
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({
        headers: req.headers ?? {},
        query: req.query ?? {},
        body: req.body ?? {},
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('Environment & Mandatory Tenant Security Unit Suite', () => {
  describe('loadAppConfig()', () => {
    const validEnv: NodeJS.ProcessEnv = {
      DATABASE_MIGRATOR_URL: 'postgresql://ft360_migrator:pw1@localhost:5433/ft360_dev',
      DATABASE_APP_URL: 'postgresql://ft360_app:pw2@localhost:5433/ft360_dev',
      DEFAULT_PRODUCT_NAME: 'CustomBrandCRM',
    };

    it('loads configurable product identity and distinct DB roles', () => {
      const cfg = loadAppConfig(validEnv);
      expect(cfg.brandingDefaults.productName).toBe('CustomBrandCRM');
      expect(cfg.database.appUrl).not.toBe(cfg.database.migratorUrl);
    });

    it('rejects identical DATABASE_APP_URL and DATABASE_MIGRATOR_URL', () => {
      expect(() =>
        loadAppConfig({
          DATABASE_MIGRATOR_URL: 'postgresql://same:pw@localhost:5433/ft360_dev',
          DATABASE_APP_URL: 'postgresql://same:pw@localhost:5433/ft360_dev',
        }),
      ).toThrow(/distinct PostgreSQL roles/i);
    });
  });

  describe('UntrustedTenantInputGuard', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const guard = new UntrustedTenantInputGuard(reflector);

    it('allows clean requests without client-supplied tenant identifiers', () => {
      const ctx = createMockExecutionContext({
        headers: { 'x-correlation-id': CORR_ID },
        query: { page: '1' },
        body: { name: 'Acme' },
      });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('rejects x-tenant-id header spoofing', () => {
      const ctx = createMockExecutionContext({
        headers: { 'x-tenant-id': TENANT_A },
      });
      expect(() => guard.canActivate(ctx)).toThrow(BadRequestException);
    });

    it('rejects ?tenant_id= query parameter spoofing', () => {
      const ctx = createMockExecutionContext({
        query: { tenant_id: TENANT_A },
      });
      expect(() => guard.canActivate(ctx)).toThrow(BadRequestException);
    });

    it('rejects nested body tenantId spoofing', () => {
      const ctx = createMockExecutionContext({
        body: { filter: { tenantId: TENANT_A } },
      });
      expect(() => guard.canActivate(ctx)).toThrow(BadRequestException);
    });
  });

  describe('TenantTransactionManager (Mocked Pool Verification)', () => {
    function buildMockPool() {
      const executedSql: Array<{ sql: string; params?: readonly unknown[] }> = [];
      const queryMock = jest.fn(async (sql: string, params?: readonly unknown[]) => {
        executedSql.push({ sql: sql.trim(), params });
        return { rows: [{ ok: 1 }], rowCount: 1 };
      });
      const releaseMock = jest.fn();
      const mockClient = {
        query: queryMock,
        release: releaseMock,
      } as unknown as PoolClient;
      const mockPoolService = {
        connectClient: jest.fn(async () => mockClient),
      } as unknown as DatabasePoolService;

      return { executedSql, queryMock, releaseMock, manager: new TenantTransactionManager(mockPoolService) };
    }

    it('rejects missing or invalid tenantId before acquiring a DB client', async () => {
      const { manager, queryMock } = buildMockPool();
      await expect(
        manager.withTenantTransaction(
          { tenantId: 'not-a-uuid', actorUserId: USER_A, correlationId: CORR_ID },
          async () => 'nope',
        ),
      ).rejects.toThrow(InvalidTenantContextError);
      expect(queryMock).not.toHaveBeenCalled();
    });

    it('scopes tenant context locally in transaction and resets session state on commit & release', async () => {
      const { manager, executedSql, releaseMock } = buildMockPool();

      const out = await manager.withTenantTransaction(
        { tenantId: TENANT_A, actorUserId: USER_A, correlationId: CORR_ID },
        async (tx) => {
          await tx.query('SELECT * FROM rls_isolation_canary WHERE probe_label = $1', ['alpha']);
          return 'done';
        },
      );

      expect(out).toBe('done');
      expect(executedSql[0].sql).toContain('RESET app.current_tenant_id');
      expect(executedSql[1].sql).toBe('BEGIN');
      expect(executedSql[2].sql).toContain("set_config('app.current_tenant_id', $1, true)");
      expect(executedSql[2].params).toEqual([TENANT_A, USER_A]);
      expect(executedSql[4].sql).toBe('COMMIT');
      expect(executedSql[5].sql).toContain('RESET app.current_tenant_id');
      expect(releaseMock).toHaveBeenCalledTimes(1);
    });

    it('rolls back and resets session variables when callback throws', async () => {
      const { manager, executedSql, releaseMock } = buildMockPool();

      await expect(
        manager.withTenantTransaction(
          { tenantId: TENANT_A, actorUserId: USER_A, correlationId: CORR_ID },
          async () => {
            throw new Error('simulated domain error');
          },
        ),
      ).rejects.toThrow('simulated domain error');

      const sqlList = executedSql.map((e) => e.sql);
      expect(sqlList).toContain('ROLLBACK');
      expect(sqlList[sqlList.length - 1]).toContain('RESET app.current_tenant_id');
      expect(releaseMock).toHaveBeenCalledTimes(1);
    });

    it('blocks SET SESSION / SET ROLE / manual COMMIT tampering inside callback', async () => {
      const { manager } = buildMockPool();
      await expect(
        manager.withTenantTransaction(
          { tenantId: TENANT_A, actorUserId: USER_A, correlationId: CORR_ID },
          async (tx) => {
            await tx.query("SET SESSION app.current_tenant_id = 'abc'");
          },
        ),
      ).rejects.toThrow(/Prohibited SQL control statement/i);
    });
  });

  describe('Tenant Cache Key & BullMQ Job Envelope Isolation', () => {
    it('builds deterministic tenant-prefixed Redis keys and rejects invalid tenantId', () => {
      const proto = RedisService.prototype;
      expect(proto.buildTenantKey(TENANT_A, 'permissions', 'member_1')).toBe(
        `t:${TENANT_A}:permissions:member_1`,
      );
      expect(() => proto.buildTenantKey('', 'permissions', 'member_1')).toThrow(/Invalid or missing tenantId/);
      expect(() => proto.buildTenantKey(TENANT_A, 'bad space!', 'member_1')).toThrow(/Invalid Redis namespace/);
    });

    it('enforces verified UUID metadata on BullMQ job envelopes', () => {
      const env = createTenantJobEnvelope(
        { tenantId: TENANT_A, actorUserId: USER_A, correlationId: CORR_ID },
        { exportFormat: 'csv' },
      );
      const verified = verifyTenantJobEnvelope<{ exportFormat: string }>(env);
      expect(verified.tenantId).toBe(TENANT_A);
      expect(verified.payload.exportFormat).toBe('csv');
      expect(() => verifyTenantJobEnvelope({ tenantId: 'bad-id' })).toThrow(/job\.tenantId/);
    });
  });

  describe('SqlMigrationRunner Discovery & Checksum Integrity', () => {
    it('discovers paired up/down SQL migrations and computes deterministic SHA-256 checksums', async () => {
      const runner = new SqlMigrationRunner('postgresql://ft360_migrator:pw@localhost:5433/ft360_dev');
      try {
        const migrations = runner.discoverMigrations();
        expect(migrations.length).toBeGreaterThanOrEqual(2);
        expect(migrations[0].version).toBe('0001');
        expect(migrations[0].name).toBe('0001_foundation_rls_helpers');
        expect(migrations[0].checksumSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(migrations[1].version).toBe('0002');
        expect(migrations[1].name).toBe('0002_foundation_branding_and_rls_canary');
        expect(migrations[1].checksumSha256).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await runner.close();
      }
    });
  });
});
