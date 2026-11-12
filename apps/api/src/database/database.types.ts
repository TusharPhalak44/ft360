import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Restricted parameterized SQL executor passed into domain repositories.
 * Intentionally hides raw PoolClient lifecycle methods (`release`, etc.)
 * so domain code cannot corrupt transaction or pool state.
 */
export interface QueryExecutor {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export class InvalidTenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTenantContextError';
  }
}

