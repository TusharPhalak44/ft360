# PostgreSQL Row-Level Security (RLS) Policies

**Last Updated:** 2026-11-13  
**Status:** Phase 2 Implemented & Negatively Verified (`migrations 0001–0004`)  
**Version:** 0.2.0

---

## 1. Fail-Closed Transaction Context Helpers (`0001`)

- `app_current_tenant_id() RETURNS UUID`: Reads `current_setting('app.current_tenant_id', true)`, trims whitespace, validates canonical UUID regex, and returns `NULL` on missing, empty, or malformed input.
- `app_current_user_id() RETURNS UUID`: Reads `current_setting('app.current_user_id', true)` and fails closed to `NULL` if missing or malformed.
- `app_is_super_admin() RETURNS BOOLEAN`: Returns `true` strictly when transaction-local `app.is_super_admin = 'true'`.
- **Pool Hygiene:** `TenantTransactionManager` executes `RESET app.current_tenant_id; RESET app.current_user_id; RESET app.is_super_admin;` both before `BEGIN` and inside `finally` before `client.release()`, while binding transaction values with `set_config(..., true)`.

---

## 2. Implemented RLS Policy Matrix (`0002`–`0004`)

Every application table in `public` has `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` enabled and is owned by `ft360_migrator` (`ft360_app` owns `0` tables and has `rolbypassrls = false`, `rolsuper = false`, `rolinherit = false`):

| Table | `ft360_app` `SELECT` Policy | `ft360_app` `INSERT` Policy | `ft360_app` `UPDATE` Policy | `ft360_app` `DELETE` Policy |
|---|---|---|---|---|
| `platform_branding_settings` | `true` (public branding read) | `app_is_super_admin()` | `app_is_super_admin()` | Denied (no grant/policy) |
| `rls_isolation_canary` | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` |
| `users` | `app_is_super_admin() OR id = app_current_user_id() OR EXISTS (co-member in app_current_tenant_id())` | `app_is_super_admin()` | `app_is_super_admin() OR id = app_current_user_id()` *(+ trigger blocking privilege escalation)* | Denied (no grant/policy) |
| `tenants` | `app_is_super_admin() OR id = app_current_tenant_id()` | `app_is_super_admin()` | `app_is_super_admin() OR id = app_current_tenant_id()` *(+ trigger blocking status/slug tampering)* | Denied (no grant/policy) |
| `tenant_memberships` | `tenant_id = app_current_tenant_id() OR app_is_super_admin()` | `tenant_id = app_current_tenant_id() OR app_is_super_admin()` | `tenant_id = app_current_tenant_id() OR app_is_super_admin()` | `tenant_id = app_current_tenant_id() OR app_is_super_admin()` |
| `permissions` | `app_current_tenant_id() IS NOT NULL OR app_is_super_admin()` | `app_is_super_admin()` | `app_is_super_admin()` | Denied (no grant/policy) |
| `roles` | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` |
| `role_permissions` | `tenant_id = app_current_tenant_id()` *(+ trigger blocking `PLATFORM` scope)* | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` |
| `user_role_assignments` | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` |

---

## 3. Narrow `SECURITY DEFINER` Membership Verification Functions (`0003`)

Owned by `ft360_migrator` with `SET search_path = public, pg_temp` and `REVOKE ALL FROM PUBLIC`:
- `fn_verify_tenant_membership(p_user_id UUID, p_tenant_id UUID)`: Used by `PostgresTenantMembershipVerifier` (`TenantMembershipGuard`) and `TenantTransactionManager.withVerifiedMemberTransaction()` to verify `user_status = 'ACTIVE'`, `membership_status = 'ACTIVE'`, and `tenant_status IN ('ACTIVE', 'TRIAL')` before executing domain SQL.
- `fn_list_user_tenants(p_user_id UUID)`: Lists active/trial organizations for an active user without relaxing `FORCE ROW LEVEL SECURITY` on `users`, `tenants`, or `tenant_memberships`.
