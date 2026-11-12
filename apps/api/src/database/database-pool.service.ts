import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import type { DatabasePoolHealth } from '@ft360/shared-types';
import { APP_CONFIG, type AppEnvConfig } from '../config/env.config';

interface RoleSecurityProbeRow {
  current_user: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  server_version: string;
}

@Injectable()
export class DatabasePoolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabasePoolService.name);
  private readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) private readonly config: AppEnvConfig) {
    this.pool = new Pool({
      connectionString: this.config.database.appUrl,
      min: this.config.database.poolMin,
      max: this.config.database.poolMax,
      idleTimeoutMillis: this.config.database.idleTimeoutMs,
      connectionTimeoutMillis: this.config.database.connectionTimeoutMs,
      statement_timeout: this.config.database.statementTimeoutMs,
      application_name: 'ft360-api',
    });

    this.pool.on('error', (err) => {
      this.logger.error(`Unexpected idle PostgreSQL client error: ${err.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.verifyLeastPrivilegeRole();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Startup & runtime invariant: the application database pool MUST NEVER
   * connect as a PostgreSQL superuser or a role with BYPASSRLS enabled.
   */
  async verifyLeastPrivilegeRole(): Promise<RoleSecurityProbeRow> {
    const result = await this.pool.query<RoleSecurityProbeRow>(
      `SELECT
         current_user::text AS current_user,
         r.rolsuper,
         r.rolbypassrls,
         current_setting('server_version') AS server_version
       FROM pg_roles r
       WHERE r.rolname = current_user`,
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Unable to inspect PostgreSQL runtime role attributes.');
    }
    if (row.rolsuper) {
      throw new Error(
        `FATAL SECURITY VIOLATION: Runtime DB role "${row.current_user}" has SUPERUSER enabled. Refusing to start.`,
      );
    }
    if (row.rolbypassrls) {
      throw new Error(
        `FATAL SECURITY VIOLATION: Runtime DB role "${row.current_user}" has BYPASSRLS enabled. Refusing to start.`,
      );
    }

    return row;
  }

  /**
   * Internal client checkout reserved strictly for TenantTransactionManager.
   */
  async connectClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  /**
   * Executes a read-only or public-scope query WITHOUT tenant context.
   * Because PostgreSQL RLS fails closed when `app.current_tenant_id` is unset,
   * any accidental query against a tenant-owned table via this method returns
   * 0 rows (SELECT) or throws 42501 (INSERT).
   */
  async queryUnscoped<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    return this.pool.query<R>(sql, [...params]);
  }

  async getHealth(): Promise<DatabasePoolHealth> {
    const start = performance.now();
    const roleInfo = await this.verifyLeastPrivilegeRole();

    let appliedMigrations = 0;
    const regCheck = await this.pool.query<{ exists: string | null }>(
      `SELECT to_regclass('public.schema_migrations')::text AS exists`,
    );
    if (regCheck.rows[0]?.exists) {
      const countRes = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public.schema_migrations`,
      );
      appliedMigrations = Number.parseInt(countRes.rows[0]?.count ?? '0', 10);
    }

    const latencyMs = Math.round((performance.now() - start) * 100) / 100;

    return {
      connected: true,
      latencyMs,
      serverVersion: roleInfo.server_version,
      currentRole: roleInfo.current_user,
      bypassRls: roleInfo.rolbypassrls,
      isSuperuser: roleInfo.rolsuper,
      appliedMigrations,
      pool: {
        totalCount: this.pool.totalCount,
        idleCount: this.pool.idleCount,
        waitingCount: this.pool.waitingCount,
      },
    };
  }
}

