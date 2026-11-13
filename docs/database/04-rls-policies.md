# PostgreSQL Row-Level Security (RLS) Policies

**Last Updated:** 2026-11-13  
**Status:** Phase 3 Implemented & Negatively Verified (`migrations 0001–0006`)  
**Version:** 0.3.1

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
| `auth_sessions` | `app_is_super_admin() OR (app_current_tenant_id() IS NULL AND user_id = app_current_user_id())` *(column-level `SELECT` omits refresh/csrf hashes)* | Denied (`fn_auth_create_session` only) | `app_is_super_admin() OR (app_current_tenant_id() IS NULL AND user_id = app_current_user_id())` *(revocation cols only)* | Denied (no grant/policy) |
| `email_verification_tokens` | `app_is_super_admin()` *(column-level `SELECT` omits `token_hash`)* | Denied (`fn_auth_*` only) | Denied (`fn_auth_*` only) | Denied (no grant/policy) |
| `password_reset_tokens` | `app_is_super_admin()` *(column-level `SELECT` omits `token_hash`)* | Denied (`fn_auth_*` only) | Denied (`fn_auth_*` only) | Denied (no grant/policy) |
| `auth_audit_logs` | `app_is_super_admin() OR (app_current_tenant_id() IS NOT NULL AND tenant_id = app_current_tenant_id())` | `app_is_super_admin() OR (app_current_tenant_id() IS NOT NULL AND tenant_id = app_current_tenant_id())` | Denied (`42501` immutability trigger + no grant) | Denied (`42501` immutability trigger + no grant) |
| `auth_refresh_token_history` | `app_is_super_admin()` *(column-level `SELECT` omits `token_hash` & `replaced_by_token_hash`)* | Denied (`fn_auth_rotate_refresh_session` only) | Denied | Denied |
| `auth_email_outbox` | `app_is_super_admin()` *(column-level `SELECT` omits `encrypted_action_token`)* | Denied (`fn_auth_enqueue_email_outbox` only) | Denied (`fn_auth_*_email_outbox` only) | Denied |

---

## 3. Narrow `SECURITY DEFINER` Membership & Authentication Functions (`0003`, `0005`, `0006`)

Owned by `ft360_migrator` with `SET search_path = pg_catalog, public, pg_temp` and `REVOKE ALL FROM PUBLIC`:
- `fn_verify_tenant_membership(p_user_id UUID, p_tenant_id UUID)`: Used by `PostgresTenantMembershipVerifier` (`TenantMembershipGuard`) and `TenantTransactionManager.withVerifiedMemberTransaction()` to verify `user_status = 'ACTIVE'`, `membership_status = 'ACTIVE'`, and `tenant_status IN ('ACTIVE', 'TRIAL')` before executing domain SQL.
- `fn_list_user_tenants(p_user_id UUID)`: Lists active/trial organizations for an active user without relaxing `FORCE ROW LEVEL SECURITY` on `users`, `tenants`, or `tenant_memberships`.
- `fn_auth_register_user`, `fn_auth_get_login_candidate`, `fn_auth_verify_email_token`, `fn_auth_issue_email_verification_token`, `fn_auth_issue_password_reset_token`, `fn_auth_reset_password`, `fn_auth_create_session`, `fn_auth_validate_session`, `fn_auth_rotate_refresh_session`, `fn_auth_bind_session_organization`, `fn_auth_revoke_session`, `fn_auth_revoke_session_by_refresh_hash`, `fn_auth_revoke_all_user_sessions`, `fn_auth_enqueue_email_outbox`, `fn_auth_claim_email_outbox_by_id`, `fn_auth_claim_email_outbox_batch`, `fn_auth_complete_email_outbox`, `fn_auth_fail_email_outbox`, `fn_auth_get_email_outbox_status`, `fn_auth_bootstrap_initial_super_admin`:
  - All reject execution inside a tenant transaction (`IF public.app_current_tenant_id() IS NOT NULL THEN RAISE EXCEPTION ... USING ERRCODE = '42501'`), preserving zero direct table `SELECT` on `users.password_hash`, `auth_sessions.refresh_token_hash`, `auth_sessions.csrf_secret_hash`, `auth_refresh_token_history.token_hash`, `auth_email_outbox.encrypted_action_token`, and verification/reset `token_hash`.
  - Session creation, validation, organization binding, and revocation routines additionally verify caller identity inside PostgreSQL (`app_current_user_id() = p_user_id` OR independently verified `app_is_super_admin()`), raising `42501` on any unscoped or cross-user attempt.
- `fn_record_auth_audit_log`: Enforces all 5 isolation invariants directly in PostgreSQL (`42501` if a tenant transaction mismatches `app_current_tenant_id()` or lacks an `ACTIVE` membership; `42501` if an unscoped call supplies a non-null `p_tenant_id`; `42501` if `PLATFORM_*` is invoked outside an independently verified Platform Super Admin transaction; `42501` if `p_session_id` mismatches `p_actor_user_id` or `p_tenant_id`) paired with recursive JSONB secret rejection (`fn_jsonb_has_forbidden_secret_key` -> `23514`).
