import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { VerifiedTenantContext } from '@ft360/shared-types';
import { isValidUuid } from '../common/uuid.util';
import { DatabasePoolService } from './database-pool.service';
import { InvalidTenantContextError, type QueryExecutor } from './database.types';

const PROHIBITED_TX_SQL_PATTERN = /\b(SET\s+SESSION|SET\s+ROLE|RESET\s+ROLE|COMMIT|ROLLBACK|BEGIN)\b/i;

@Injectable()
export class TenantTransactionManager {
  constructor(private readonly dbPool: DatabasePoolService) {}

  /**
   * Executes `work` inside an isolated PostgreSQL transaction with
   * transaction-scoped (`is_local = true`) tenant context.
   *
   * Security guarantees:
   * 1. Rejects missing, empty, or non-UUID `tenantId` / `actorUserId` before touching PG.
   * 2. Uses `set_config(..., true)` inside `BEGIN ... COMMIT` so PostgreSQL automatically
   *    unwinds the tenant context on both COMMIT and ROLLBACK.
   * 3. Blocks raw `SET SESSION`, `SET ROLE`, or manual transaction control inside callbacks.
   * 4. Resets `app.current_tenant_id`, `app.current_user_id`, and `app.is_super_admin`
   *    both BEFORE `BEGIN` (sanitizing any prior rogue session state on the borrowed client)
   *    and in `finally` BEFORE `client.release()` (preventing pool leakage).
   */
  async withTenantTransaction<T>(
    ctx: VerifiedTenantContext,
    work: (tx: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    if (!ctx || !isValidUuid(ctx.tenantId)) {
      throw new InvalidTenantContextError(
        'TenantTransactionManager rejected execution: verified tenantId must be a valid canonical UUID.',
      );
    }
    if (!isValidUuid(ctx.actorUserId)) {
      throw new InvalidTenantContextError(
        'TenantTransactionManager rejected execution: verified actorUserId must be a valid canonical UUID.',
      );
    }

    const normalizedTenantId = ctx.tenantId.trim().toLowerCase();
    const normalizedUserId = ctx.actorUserId.trim().toLowerCase();

    const client = await this.dbPool.connectClient();
    let inTransaction = false;

    try {
      await this.sanitizeSessionVariables(client);
      await client.query('BEGIN');
      inTransaction = true;

      await client.query(
        `SELECT
           set_config('app.current_tenant_id', $1, true),
           set_config('app.current_user_id', $2, true),
           set_config('app.is_super_admin', 'false', true)`,
        [normalizedTenantId, normalizedUserId],
      );

      const safeExecutor = this.createSafeExecutor(client);
      const result = await work(safeExecutor);

      await client.query('COMMIT');
      inTransaction = false;
      return result;
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback failure on broken socket; client reset follows
        }
      }
      throw error;
    } finally {
      try {
        await this.sanitizeSessionVariables(client);
      } finally {
        client.release();
      }
    }
  }

  /**
   * Dedicated Platform Super Admin transaction wrapper.
   * Never sets a tenant context; sets transaction-local `app.is_super_admin = 'true'`.
   */
  async withPlatformAdminTransaction<T>(
    actorSuperAdminUserId: string,
    work: (tx: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    if (!isValidUuid(actorSuperAdminUserId)) {
      throw new InvalidTenantContextError(
        'PlatformAdminTransaction rejected execution: actorSuperAdminUserId must be a valid canonical UUID.',
      );
    }

    const client = await this.dbPool.connectClient();
    let inTransaction = false;

    try {
      await this.sanitizeSessionVariables(client);
      await client.query('BEGIN');
      inTransaction = true;

      await client.query(
        `SELECT
           set_config('app.current_tenant_id', '', true),
           set_config('app.current_user_id', $1, true),
           set_config('app.is_super_admin', 'true', true)`,
        [actorSuperAdminUserId.trim().toLowerCase()],
      );

      const safeExecutor = this.createSafeExecutor(client);
      const result = await work(safeExecutor);

      await client.query('COMMIT');
      inTransaction = false;
      return result;
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback error
        }
      }
      throw error;
    } finally {
      try {
        await this.sanitizeSessionVariables(client);
      } finally {
        client.release();
      }
    }
  }

  private createSafeExecutor(client: PoolClient): QueryExecutor {
    return {
      query: async <R extends QueryResultRow = QueryResultRow>(
        sql: string,
        params: readonly unknown[] = [],
      ): Promise<QueryResult<R>> => {
        if (PROHIBITED_TX_SQL_PATTERN.test(sql)) {
          throw new Error(
            'Prohibited SQL control statement inside managed transaction callback (SET SESSION / SET ROLE / BEGIN / COMMIT / ROLLBACK).',
          );
        }
        return client.query<R>(sql, [...params]);
      },
    };
  }

  private async sanitizeSessionVariables(client: PoolClient): Promise<void> {
    await client.query(
      'RESET app.current_tenant_id; RESET app.current_user_id; RESET app.is_super_admin;',
    );
  }
}

