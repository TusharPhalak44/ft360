# PostgreSQL Row-Level Security (RLS) Policies

**Last Updated:** 2026-11-12  
**Status:** Mandatory Database Security Specification  
**Version:** 0.1.0

---

## 1. Session Context Helper Functions (Fail-Closed on Missing or Invalid Context)

Created in `0005_rls_policies_and_audit_triggers.up.sql` to safely read transaction-local settings and deterministically **fail closed** (`RETURN NULL`) whenever context is missing, empty, or malformed:

```sql
CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_raw TEXT;
BEGIN
  v_raw := NULLIF(btrim(current_setting('app.current_tenant_id', true)), '');
  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;

  -- Validate canonical UUID format; fail closed (NULL) on any invalid value
  IF v_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;

  RETURN v_raw::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION app_is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(current_setting('app.is_super_admin', true) = 'true', false);
$$;
```

- When no transaction context is set—or when an invalid/malformed string is set—`app_current_tenant_id()` returns `NULL`.
- In SQL, `tenant_id = NULL` evaluates to `UNKNOWN` (falsy), guaranteeing **fail-closed** zero-row `SELECT`/`UPDATE`/`DELETE` and immediate `42501` policy rejection on `INSERT` if any query bypasses `TenantTransactionManager`.
- **Pool Reuse Defense-in-Depth:** In addition to using transaction-scoped `set_config(..., true)`, `TenantTransactionManager` explicitly executes `RESET app.current_tenant_id; RESET app.current_user_id; RESET app.is_super_admin;` prior to releasing any `PoolClient` back to `pg.Pool`, ensuring even an accidental session-level `SET` can never leak across pooled connections.

---

## 2. Standard Tenant Table RLS Policy Template

Applied to **every** tenant-owned table (`roles`, `role_permissions`, `user_role_assignments`, `tenant_settings`, `tenant_branding_settings`, `tenant_subscriptions`, `tenant_audit_logs`, and all future CRM/Ops/HR/Finance tables):

```sql
ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON tenant_settings
  FOR SELECT
  TO ft360_app
  USING (tenant_id = app_current_tenant_id());

CREATE POLICY tenant_isolation_insert ON tenant_settings
  FOR INSERT
  TO ft360_app
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY tenant_isolation_update ON tenant_settings
  FOR UPDATE
  TO ft360_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY tenant_isolation_delete ON tenant_settings
  FOR DELETE
  TO ft360_app
  USING (tenant_id = app_current_tenant_id());
```

> **Note on `WITH CHECK`:** Including `WITH CHECK (tenant_id = app_current_tenant_id())` on `INSERT` and `UPDATE` guarantees that Tenant A can neither insert a row tagged with Tenant B's `tenant_id` nor mutate an existing Tenant A row's `tenant_id` into Tenant B.

---

## 3. Special Policy Rules for Bridge & Platform Tables

1. **`tenant_memberships`:**
   - Standard tenant operations match `tenant_id = app_current_tenant_id()`.
   - Pre-tenant login discovery uses a narrow `SECURITY DEFINER` function (`fn_get_user_active_memberships(p_user_id UUID)`) owned by `ft360_migrator` with `SET search_path = public, pg_temp`, returning only `(membership_id, tenant_id, tenant_slug, tenant_display_name, status)` for the authenticated user—avoiding broad RLS exceptions on `tenant_memberships`.
2. **Audit Logs (`tenant_audit_logs`):**
   - `SELECT` and `INSERT` allowed where `tenant_id = app_current_tenant_id()`.
   - **No `UPDATE` or `DELETE` policies exist**, reinforced by an immutability trigger.

---

## 4. Automated RLS Verification Gate

Every CI run executes two mandatory RLS checks:
1. **Catalog Completeness Query:** Queries `pg_class` + `pg_namespace` + `information_schema.columns` to assert that **100% of tables containing a `tenant_id` column** have both `relrowsecurity = true` and `relforcerowsecurity = true`. If a developer adds a new table with `tenant_id` and forgets `ENABLE/FORCE ROW LEVEL SECURITY`, CI fails immediately.
2. **Negative Cross-Tenant Attack Suite:** Seeds Tenant A and Tenant B, sets `app.current_tenant_id` to Tenant A, and asserts:
   - `SELECT * FROM <table>` returns **only** Tenant A rows (`0` Tenant B rows).
   - `UPDATE <table> SET ... WHERE id = <tenant_b_row_id>` affects `0` rows.
   - `DELETE FROM <table> WHERE id = <tenant_b_row_id>` affects `0` rows.
   - `INSERT INTO <table> (tenant_id, ...) VALUES (<tenant_b_id>, ...)` fails with PostgreSQL RLS error `42501`.
   - Querying with **no** `app.current_tenant_id` set returns `0` rows and rejects `INSERT`.

