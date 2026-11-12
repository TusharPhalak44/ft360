# PostgreSQL Database Architecture

**Last Updated:** 2026-11-12  
**Status:** Phase 0 Architecture Specification  
**Version:** 0.1.0

---

## 1. Database Engine & Role Separation

PostgreSQL 18 is the single authoritative relational store. To ensure Row-Level Security (RLS) cannot be accidentally bypassed by application connections, database roles are strictly separated:

| Database Role | Privileges | Usage Scope |
|---|---|---|
| `ft360_migrator` | `DDL` owner (`CREATE`, `ALTER`, `DROP` via approved migrations), `NOBYPASSRLS` not relied upon during runtime | Executed **only** by the CLI/CI SQL migration runner |
| `ft360_app` | `CONNECT`, `SELECT`, `INSERT`, `UPDATE`, `DELETE` on application tables; **`NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`** | Used by NestJS API (`apps/api`) and BullMQ Worker runtime pools |
| `ft360_readonly` (Optional Ops) | Read-only diagnostics with `NOBYPASSRLS` | Controlled operational debugging if needed |

> **Critical Rule:** Because table owners bypass RLS by default in PostgreSQL unless `FORCE ROW LEVEL SECURITY` is enabled, **both** role separation (`ft360_app` != `ft360_migrator`) **and** `ALTER TABLE ... FORCE ROW LEVEL SECURITY` are mandated on every tenant-owned table.

---

## 2. Native `pg` Data Access Architecture

No ORM is used. Database access in NestJS is structured into three clean internal tiers:

```text
Controller (DTOs)
   └── Domain Service (Business Logic & Orchestration)
          └── Domain Repository (Parameterized SQL + Row Mapping)
                 └── DatabaseService / TenantTransactionManager (pg.Pool)
```

### 2.1 Connection Pool Sizing Strategy
- **`pg.Pool` Configuration (per API/Worker replica):**
  - `max`: Configurable via `DB_POOL_MAX` (default `20` per API instance, `10` per Worker instance; scaled via PgBouncer in transaction mode once replica counts grow).
  - `idleTimeoutMillis`: `30000` (30s)
  - `connectionTimeoutMillis`: `5000` (5s fail-fast)
  - `statement_timeout`: `15000` (15s default on API pool to prevent runaway queries; separate controlled timeout on heavy reporting/export jobs).
  - `application_name`: `ft360-api` or `ft360-worker` for `pg_stat_activity` observability.

### 2.2 Execution Modes in `DatabasePoolService` & `TenantTransactionManager`
1. **`TenantTransactionManager.withTenantTransaction(ctx: VerifiedTenantContext, fn)`**:
   - Validates canonical UUID format for `ctx.tenantId` and `ctx.actorUserId` before touching the pool.
   - Acquires a `PoolClient` connected as `ft360_app` (`NOSUPERUSER`, `NOBYPASSRLS`, non-owner).
   - Executes `RESET app.current_tenant_id; RESET app.current_user_id; RESET app.is_super_admin;` prior to `BEGIN` to wipe any residual session state.
   - Runs `BEGIN`.
   - Runs `SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_user_id', $2, true), set_config('app.is_super_admin', 'false', true)` (strictly transaction-local).
   - Passes a restricted `QueryExecutor` (blocking `SET SESSION`, `SET ROLE`, and manual transaction control) to `fn(tx)`.
   - Commits on success; rolls back in `catch`; resets session variables again in `finally` before `client.release()`.
2. **`TenantTransactionManager.withPlatformAdminTransaction(actorSuperAdminUserId, fn)`**:
   - Explicitly restricted to Platform Super Admin services.
   - Sets `app.is_super_admin = 'true'`, `app.current_tenant_id = ''`, and `app.current_user_id = $1` locally within the transaction and resets in `finally`.
3. **`DatabasePoolService.queryUnscoped(sql, params)`**:
   - Used strictly for non-tenant readiness probes and public platform branding reads (`platform_branding_settings`). Because RLS fails closed when `app.current_tenant_id` is unset or invalid, any query bypassing `TenantTransactionManager` against a tenant table returns `0` rows (`SELECT`) or fails with `42501` (`INSERT`).

---

## 3. Referential Integrity: Composite Foreign Keys for Tenant Safety

Standard single-column foreign keys (`lead.assigned_membership_id -> tenant_memberships.id`) alone could theoretically allow linking a record in Tenant A to a parent record in Tenant B if RLS were misconfigured.

**Mandatory Standard:** Every tenant-scoped child table enforces **composite foreign keys** including `tenant_id`:
- Parent table defines `UNIQUE (tenant_id, id)`.
- Child table defines `FOREIGN KEY (tenant_id, parent_id) REFERENCES parent_table (tenant_id, id)`.

This guarantees at the mathematical constraint level inside PostgreSQL that cross-tenant relational links are impossible to store.

---

## 4. Schema Conventions & Data Types

- **Naming:** `snake_case` plural table names (`tenants`, `tenant_memberships`, `user_role_assignments`), singular column names (`id`, `tenant_id`, `created_at`).
- **Primary Keys:** `UUID PRIMARY KEY DEFAULT uuidv7()` (PostgreSQL 18 native time-ordered UUIDs).
- **Timestamps:** `TIMESTAMPTZ NOT NULL DEFAULT NOW()` (`created_at`, `updated_at`; always UTC).
- **Soft Deletion / Archival:** Business-critical records use `deleted_at TIMESTAMPTZ NULL` (with partial unique indexes `WHERE deleted_at IS NULL`) rather than physical `DELETE`, preserving audit and financial history.
- **Monetary Values:** `NUMERIC(19, 4)` paired with explicit ISO-4217 `currency_code CHAR(3)` — never `FLOAT`/`REAL`.
- **Extensible Custom Fields:** Validated `JSONB` columns (`custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb`) indexed selectively via GIN where tenant custom field schemas require filtering.
- **High-Volume Table Partitioning (Future Phases):** `tenant_audit_logs`, `call_detail_records`, and `email_events` will be range-partitioned monthly by `created_at` while retaining `tenant_id` leading composite indexes.

