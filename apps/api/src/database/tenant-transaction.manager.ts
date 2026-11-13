import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { VerifiedTenantContext } from '@ft360/shared-types';
import { isValidUuid } from '../common/uuid.util';
import { DatabasePoolService } from './database-pool.service';
import {
  InvalidTenantContextError,
  UnauthorizedTenantMembershipError,
  type QueryExecutor,
} from './database.types';

const PROHIBITED_TX_SQL_PATTERN =
  /\b(SET\s+(?:SESSION|LOCAL)\b|SET\s+app\.|SET\s+ROLE\b|RESET\s+(?:ALL|ROLE)\b|RESET\s+app\.|DISCARD\b|set_config\s*\(|BEGIN(?:\s+TRANSACTION|\s+WORK)?\s*(?:;|$)|START\s+TRANSACTION\b|COMMIT\b|ROLLBACK\b|ABORT\b)|(?:^|;)\s*END(?:\s+TRANSACTION|\s+WORK)?\s*(?:;|$)/i;

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
    let destroyClient = false;

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
          destroyClient = true;
        }
      }
      throw error;
    } finally {
      if (!destroyClient) {
        try {
          await this.sanitizeSessionVariables(client);
        } catch {
          destroyClient = true;
        }
      }
      client.release(destroyClient);
    }
  }

  /**
   * Executes `work` inside a tenant-scoped transaction AND validates inside PostgreSQL
   * that `actorUserId` holds an `ACTIVE` membership in an `ACTIVE` or `TRIAL` tenant
   * with an `ACTIVE` global user account before running any domain SQL.
   */
  async withVerifiedMemberTransaction<T>(
    ctx: VerifiedTenantContext,
    work: (tx: QueryExecutor, verifiedMembershipId: string) => Promise<T>,
  ): Promise<T> {
    return this.withTenantTransaction(ctx, async (tx) => {
      const normalizedUserId = ctx.actorUserId.trim().toLowerCase();
      const normalizedTenantId = ctx.tenantId.trim().toLowerCase();

      const verifyRes = await tx.query<{
        membership_id: string;
        membership_status: string;
        tenant_status: string;
        user_status: string;
      }>(
        `SELECT membership_id, membership_status, tenant_status, user_status
         FROM public.fn_verify_tenant_membership($1::uuid, $2::uuid)`,
        [normalizedUserId, normalizedTenantId],
      );

      const membership = verifyRes.rows[0];
      if (!membership) {
        throw new UnauthorizedTenantMembershipError(
          'Access denied: actor is not a member of the target tenant.',
        );
      }
      if (membership.user_status !== 'ACTIVE') {
        throw new UnauthorizedTenantMembershipError(
          `Access denied: user status is ${membership.user_status}.`,
        );
      }
      if (membership.membership_status !== 'ACTIVE') {
        throw new UnauthorizedTenantMembershipError(
          `Access denied: membership status is ${membership.membership_status}.`,
        );
      }
      if (membership.tenant_status !== 'ACTIVE' && membership.tenant_status !== 'TRIAL') {
        throw new UnauthorizedTenantMembershipError(
          `Access denied: tenant status is ${membership.tenant_status}.`,
        );
      }

      if (
        ctx.membershipId &&
        ctx.membershipId.trim().toLowerCase() !== membership.membership_id.toLowerCase()
      ) {
        throw new UnauthorizedTenantMembershipError(
          'Access denied: context membershipId does not match verified database membership.',
        );
      }

      return work(tx, membership.membership_id);
    });
  }

  /**
   * Dedicated Platform Super Admin transaction wrapper.
   * Never sets a tenant context; sets transaction-local `app.is_super_admin = 'true'`
   * AND verifies inside PostgreSQL that `actorSuperAdminUserId` is an ACTIVE Platform Super Admin.
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

    const normalizedAdminId = actorSuperAdminUserId.trim().toLowerCase();
    return this.runSuperAdminScopedTransaction(normalizedAdminId, async (tx) => {
      const adminRes = await tx.query<{
        status: string;
        is_platform_super_admin: boolean;
      }>(
        `SELECT status, is_platform_super_admin
         FROM public.users
         WHERE id = $1::uuid`,
        [normalizedAdminId],
      );

      const adminRow = adminRes.rows[0];
      if (!adminRow || !adminRow.is_platform_super_admin || adminRow.status !== 'ACTIVE') {
        throw new UnauthorizedTenantMembershipError(
          'Access denied: actor is not an ACTIVE Platform Super Admin.',
        );
      }

      return work(tx);
    });
  }

  /**
   * System bootstrap transaction wrapper strictly for initial Platform Super Admin seeding
   * when no Super Admin user exists yet. Never sets a tenant context.
   */
  async withSystemBootstrapTransaction<T>(
    work: (tx: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    return this.runSuperAdminScopedTransaction('', work);
  }

  /**
   * Authenticated user-plane transaction wrapper (pre-tenant / user-self operations
   * such as inspecting own profile or active device sessions).
   * Sets `app.current_user_id` locally while keeping `app.current_tenant_id = ''`
   * and `app.is_super_admin = 'false'`.
   */
  async withAuthenticatedUserTransaction<T>(
    actorUserId: string,
    work: (tx: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    if (!isValidUuid(actorUserId)) {
      throw new InvalidTenantContextError(
        'AuthenticatedUserTransaction rejected execution: actorUserId must be a valid canonical UUID.',
      );
    }

    const normalizedUserId = actorUserId.trim().toLowerCase();
    const client = await this.dbPool.connectClient();
    let inTransaction = false;
    let destroyClient = false;

    try {
      await this.sanitizeSessionVariables(client);
      await client.query('BEGIN');
      inTransaction = true;

      await client.query(
        `SELECT
           set_config('app.current_tenant_id', '', true),
           set_config('app.current_user_id', $1, true),
           set_config('app.is_super_admin', 'false', true)`,
        [normalizedUserId],
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
          destroyClient = true;
        }
      }
      throw error;
    } finally {
      if (!destroyClient) {
        try {
          await this.sanitizeSessionVariables(client);
        } catch {
          destroyClient = true;
        }
      }
      client.release(destroyClient);
    }
  }

  private async runSuperAdminScopedTransaction<T>(
    normalizedActorId: string,
    work: (tx: QueryExecutor) => Promise<T>,
  ): Promise<T> {
    const client = await this.dbPool.connectClient();
    let inTransaction = false;
    let destroyClient = false;

    try {
      await this.sanitizeSessionVariables(client);
      await client.query('BEGIN');
      inTransaction = true;

      await client.query(
        `SELECT
           set_config('app.current_tenant_id', '', true),
           set_config('app.current_user_id', $1, true),
           set_config('app.is_super_admin', 'true', true)`,
        [normalizedActorId],
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
          destroyClient = true;
        }
      }
      throw error;
    } finally {
      if (!destroyClient) {
        try {
          await this.sanitizeSessionVariables(client);
        } catch {
          destroyClient = true;
        }
      }
      client.release(destroyClient);
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

