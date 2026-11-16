# PostgreSQL Database Architecture

**Last Updated:** 2026-11-16  
**Status:** Phase 4 Stage 4A Implemented Architecture (`0001`–`0008`, `22` `FORCE RLS` Tables)  
**Version:** 0.4.0

---

## 1. Database Engine & Role Separation

PostgreSQL 18 is the single authoritative relational store. To ensure Row-Level Security (RLS) cannot be accidentally bypassed by application connections, database roles are strictly separated:

| Database Role | Privileges | Usage Scope |
|---|---|---|
| `ft360_migrator` | `DDL` owner (`CREATE`, `ALTER`, `DROP` via approved migrations), `NOBYPASSRLS` not relied upon during runtime | Executed **only** by the CLI/CI SQL migration runner (`0001`–`0008`) |
| `ft360_app` | Least-privilege table/column `SELECT`, `INSERT`, `UPDATE`, `DELETE` + `EXECUTE` on narrow `SECURITY DEFINER` routines; **`NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`** | Used by NestJS API (`apps/api`) and BullMQ Worker runtime pools (`0` tables owned) |
| `ft360_readonly` (Optional Ops) | Read-only diagnostics with `NOBYPASSRLS` | Controlled operational debugging if needed |

> **Critical Rule:** Because table owners bypass RLS by default in PostgreSQL unless `FORCE ROW LEVEL SECURITY` is enabled, **both** role separation (`ft360_app` != `ft360_migrator`) **and** `ALTER TABLE ... FORCE ROW LEVEL SECURITY` are enforced across all `22` application tables in `public`.

---

## 2. Native `pg` Data Access Architecture

No ORM is used (`npm run check:no-orm`). Database access in NestJS is structured into three clean internal tiers:

```text
Controller (DTOs)
   └── Domain Service (Business Logic & Orchestration)
          └── Domain Repository (Parameterized SQL + Row Mapping)
                 └── DatabaseService / TenantTransactionManager (pg.Pool)
```

### 2.1 Connection Pool Sizing Strategy
- **`pg.Pool` Configuration (per API/Worker replica):**
  - `max`: Configurable via `DB_POOL_MAX` (default `20` per API instance, `10` per Worker instance).
  - `idleTimeoutMillis`: `30000` (30s)
  - `connectionTimeoutMillis`: `5000` (5s fail-fast)
  - `statement_timeout`: `15000` (15s default on API pool to prevent runaway queries).
  - `application_name`: `ft360-api` or `ft360-worker` for `pg_stat_activity` observability.

### 2.2 Execution Modes in `DatabasePoolService` & `TenantTransactionManager`
1. **`TenantTransactionManager.withVerifiedMemberTransaction(ctx, fn)` / `withTenantTransaction(ctx, fn)`**:
   - Validates canonical UUID format for `ctx.tenantId` and `ctx.actorUserId` before touching the pool.
   - Verifies live `users.status = 'ACTIVE'`, `tenant_memberships.status = 'ACTIVE'`, and `tenants.status IN ('ACTIVE', 'TRIAL')` via `fn_verify_tenant_membership`.
   - Acquires a `PoolClient` connected as `ft360_app` (`NOSUPERUSER`, `NOBYPASSRLS`, non-owner).
   - Executes `RESET app.current_tenant_id; RESET app.current_user_id; RESET app.is_super_admin;` prior to `BEGIN`, sets transaction-local GUCs via `set_config(..., true)`, blocks `SET SESSION`/`SET ROLE`/manual tx statements, and resets GUCs again in `finally` before `client.release()` (destroying poisoned connections if rollback fails).
2. **`TenantTransactionManager.withPlatformAdminTransaction(actorSuperAdminUserId, fn)`**:
   - Restricted to Platform Super Admin services; verifies live `is_platform_super_admin = TRUE` and `status = 'ACTIVE'`, sets `app.is_super_admin = 'true'`, `app.current_tenant_id = ''`, and `app.current_user_id = $1` locally within the transaction, and resets in `finally`.
3. **`TenantTransactionManager.withUserTransaction(actorUserId, fn)`**:
   - Sets `app.current_user_id = $1` with `app.current_tenant_id = ''` and `app.is_super_admin = 'false'` for authenticated user-scoped auth/session operations prior to workspace selection.
4. **`DatabasePoolService.queryUnscoped(sql, params)`**:
   - Used strictly for non-tenant readiness probes, pre-auth routines, and public platform branding reads (`platform_branding_settings`). Because RLS fails closed when `app.current_tenant_id` is unset or invalid, any query bypassing `TenantTransactionManager` against a tenant table returns `0` rows (`SELECT`) or fails with `42501` (`INSERT`).

---

## 3. Referential Integrity, Serialized Concurrency & Lifecycle Enforcement

- **Composite Foreign Keys:** Every tenant-scoped child table enforces composite foreign keys `(tenant_id, parent_id) REFERENCES parent_table (tenant_id, id)` across memberships, roles, invitations, branding assets/settings, onboarding/profile/settings companions, email outbox rows, and `tenant_audit_logs`.
- **Serialized Concurrency Invariants (`0007`–`0008`):**
  - **Last-Active-Admin Anti-Lockout:** `trigger_prevent_last_tenant_admin_removal()` locks the parent `public.tenants` row `FOR UPDATE` before evaluating remaining `ACTIVE` `INTERNAL` `tenant_admin` assignments, preventing concurrent demotions or revocations from leaving an operational tenant with zero administrators.
  - **Primary Owner Singleton:** Partial unique index `uq_tenant_memberships_primary_owner ON tenant_memberships (tenant_id) WHERE is_primary_owner = TRUE` + atomic `fn_tenant_transfer_primary_owner`.
  - **Global Email Uniqueness:** `CITEXT` `uq_users_email` + `chk_users_email_canonical_trimmed` + functional `uq_users_email_normalized` + `pg_advisory_xact_lock` inside `fn_invitation_accept_new_user`.
- **4-Layer PostgreSQL Lifecycle Validation on Redis Outage:** Even when Redis session/settings caches are offline (`RedisSessionCacheService` degrades gracefully via `REDIS_UNAVAILABLE_FALLBACK_PG`), PostgreSQL enforces `tenants.status IN ('ACTIVE', 'TRIAL')` across `fn_auth_validate_session`, `fn_verify_tenant_membership`, `withVerifiedMemberTransaction`, and `fn_is_current_tenant_operational()` / `fn_assert_tenant_operational()`.

---

## 4. Schema Conventions & Data Types

- **Naming:** `snake_case` plural table names (`tenants`, `tenant_memberships`, `tenant_audit_logs`, `tenant_invitations`), singular column names (`id`, `tenant_id`, `created_at`).
- **Primary Keys:** `UUID PRIMARY KEY DEFAULT uuidv7()` (PostgreSQL 18 native time-ordered UUIDs) or `tenant_id UUID PRIMARY KEY` on `1:1` tenant companion tables (`tenant_onboarding_states`, `tenant_profiles`, `tenant_settings`, `tenant_branding_settings`).
- **Timestamps:** `TIMESTAMPTZ NOT NULL DEFAULT NOW()` (`created_at`, `updated_at`; always UTC).
- **Append-Only Audit Retention (`OD-P2`):** `auth_audit_logs` and `tenant_audit_logs` block all runtime `UPDATE`/`DELETE` (`42501`), enforce recursive secret-key checks (`23514`), and retain `365 days` hot relational storage before archival.
