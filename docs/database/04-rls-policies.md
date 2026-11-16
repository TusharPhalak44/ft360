# PostgreSQL Row-Level Security (RLS) Policies

**Last Updated:** 2026-11-16  
**Status:** Phase 4 Stage 4A Implemented & Negatively Verified (`migrations 0001–0008`, `22` `FORCE RLS` Tables)  
**Version:** 0.4.0

---

## 1. Fail-Closed Transaction Context & Operational Lifecycle Helpers (`0001`, `0007`)

- `app_current_tenant_id() RETURNS UUID`: Reads `current_setting('app.current_tenant_id', true)`, trims whitespace, validates canonical UUID regex, and returns `NULL` on missing, empty, or malformed input.
- `app_current_user_id() RETURNS UUID`: Reads `current_setting('app.current_user_id', true)` and fails closed to `NULL` if missing or malformed.
- `app_is_super_admin() RETURNS BOOLEAN`: Returns `true` strictly when transaction-local `app.is_super_admin = 'true'`.
- `fn_is_current_tenant_operational() RETURNS BOOLEAN` (`0007`, `SECURITY DEFINER`): Returns `true` strictly when `app_current_tenant_id()` is set and `public.tenants.status IN ('ACTIVE', 'TRIAL')`. Used directly in write-RLS policies on Phase 4 tenant domain tables so non-operational (`PROVISIONING`, `SUSPENDED`, `DEACTIVATED`, `CANCELLED`) tenants fail closed inside PostgreSQL even during a complete Redis outage.
- **Pool Hygiene:** `TenantTransactionManager` executes `RESET app.current_tenant_id; RESET app.current_user_id; RESET app.is_super_admin;` both before `BEGIN` and inside `finally` before `client.release()`, while binding transaction values with `set_config(..., true)`.

---

## 2. Implemented RLS Policy Matrix (`0002`–`0008` — All `22` Application Tables)

Every application table in `public` has `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` enabled and is owned by `ft360_migrator` (`ft360_app` owns `0` tables and has `rolbypassrls = false`, `rolsuper = false`, `rolinherit = false`):

| Table | `ft360_app` `SELECT` Policy | `ft360_app` `INSERT` Policy | `ft360_app` `UPDATE` Policy | `ft360_app` `DELETE` Policy |
|---|---|---|---|---|
| `platform_branding_settings` | `true` (public branding read) | `app_is_super_admin()` | `app_is_super_admin()` | Denied (no grant/policy) |
| `rls_isolation_canary` | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` |
| `users` | `app_is_super_admin() OR id = app_current_user_id() OR EXISTS (ACTIVE co-member in app_current_tenant_id())` *(unweakened: hides unaccepted `INVITED` global users)* | `app_is_super_admin()` | `app_is_super_admin() OR id = app_current_user_id()` *(+ trigger blocking privilege escalation)* | Denied (no grant/policy) |
| `tenants` | `app_is_super_admin() OR id = app_current_tenant_id()` | `app_is_super_admin()` | `app_is_super_admin() OR id = app_current_tenant_id()` *(+ `trigger_protect_tenant_lifecycle` enforcing `42501` & `OD-P1`)* | Denied (`fk_tal_tenant` `ON DELETE RESTRICT` + no grant) |
| `tenant_memberships` | `tenant_id = app_current_tenant_id() OR app_is_super_admin()` | `tenant_id = app_current_tenant_id() OR app_is_super_admin()` | `tenant_id = app_current_tenant_id() OR app_is_super_admin()` *(+ serialized last-admin trigger)* | `tenant_id = app_current_tenant_id() OR app_is_super_admin()` *(+ serialized last-admin trigger)* |
| `permissions` | `app_current_tenant_id() IS NOT NULL OR app_is_super_admin()` | `app_is_super_admin()` | `app_is_super_admin()` | Denied (no grant/policy) |
| `roles` | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` |
| `role_permissions` | `tenant_id = app_current_tenant_id()` *(+ trigger blocking `PLATFORM` scope)* | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` |
| `user_role_assignments` | `tenant_id = app_current_tenant_id()` | `tenant_id = app_current_tenant_id()` *(+ `INTERNAL` admin trigger)* | `tenant_id = app_current_tenant_id()` *(+ serialized last-admin trigger)* | `tenant_id = app_current_tenant_id()` *(+ serialized last-admin trigger)* |
| `auth_sessions` | `app_is_super_admin() OR (app_current_tenant_id() IS NULL AND user_id = app_current_user_id())` *(omits refresh/csrf hashes)* | Denied (`fn_auth_create_session` only) | `app_is_super_admin() OR (app_current_tenant_id() IS NULL AND user_id = app_current_user_id())` *(revocation cols only)* | Denied (no grant/policy) |
| `email_verification_tokens` | `app_is_super_admin()` *(omits `token_hash`)* | Denied (`fn_auth_*` only) | Denied (`fn_auth_*` only) | Denied (no grant/policy) |
| `password_reset_tokens` | `app_is_super_admin()` *(omits `token_hash`)* | Denied (`fn_auth_*` only) | Denied (`fn_auth_*` only) | Denied (no grant/policy) |
| `auth_audit_logs` | `app_is_super_admin() OR (app_current_tenant_id() IS NOT NULL AND tenant_id = app_current_tenant_id())` | `app_is_super_admin() OR (app_current_tenant_id() IS NOT NULL AND tenant_id = app_current_tenant_id())` | Denied (`42501` immutability trigger + no grant) | Denied (`42501` immutability trigger + no grant) |
| `auth_refresh_token_history` | `app_is_super_admin()` *(omits `token_hash` & `replaced_by_token_hash`)* | Denied (`fn_auth_rotate_refresh_session` only) | Denied | Denied |
| `auth_email_outbox` | `app_is_super_admin()` *(omits `encrypted_action_token`)* | Denied (`fn_auth_enqueue_email_outbox` / `fn_tenant_enqueue_invitation_email_outbox` only) | Denied (`fn_auth_*_email_outbox` only) | Denied |
| `tenant_onboarding_states` | `app_is_super_admin() OR tenant_id = app_current_tenant_id()` | `app_is_super_admin() OR (tenant_id = app_current_tenant_id() AND fn_is_current_tenant_operational())` | `app_is_super_admin() OR (tenant_id = app_current_tenant_id() AND fn_is_current_tenant_operational())` | Denied (no grant/policy) |
| `tenant_profiles` | `app_is_super_admin() OR tenant_id = app_current_tenant_id()` | `app_is_super_admin() OR (tenant_id = app_current_tenant_id() AND fn_is_current_tenant_operational())` | `app_is_super_admin() OR (tenant_id = app_current_tenant_id() AND fn_is_current_tenant_operational())` | Denied (no grant/policy) |
| `tenant_settings` | `app_is_super_admin() OR tenant_id = app_current_tenant_id()` | `app_is_super_admin() OR (tenant_id = app_current_tenant_id() AND fn_is_current_tenant_operational())` | `app_is_super_admin() OR (tenant_id = app_current_tenant_id() AND fn_is_current_tenant_operational())` | Denied (no grant/policy) |
| `tenant_branding_assets` | `app_is_super_admin() OR tenant_id = app_current_tenant_id()` | `app_is_super_admin() OR (tenant_id = app_current_tenant_id() AND fn_is_current_tenant_operational())` | Denied (immutable metadata; no `UPDATE` grant) | `app_is_super_admin() OR (tenant_id = app_current_tenant_id() AND fn_is_current_tenant_operational())` |
| `tenant_branding_settings` | `app_is_super_admin() OR tenant_id = app_current_tenant_id()` | `app_is_super_admin() OR (tenant_id = app_current_tenant_id() AND fn_is_current_tenant_operational())` | `app_is_super_admin() OR (tenant_id = app_current_tenant_id() AND fn_is_current_tenant_operational())` | Denied (no grant/policy) |
| `tenant_audit_logs` | `app_is_super_admin() OR (app_current_tenant_id() IS NOT NULL AND tenant_id = app_current_tenant_id())` | `app_is_super_admin() OR (app_current_tenant_id() IS NOT NULL AND tenant_id = app_current_tenant_id())` *(via `fn_record_tenant_audit_log`)* | Denied (`42501` immutability trigger + no grant) | Denied (`42501` immutability trigger + no grant) |
| `tenant_invitations` | `app_is_super_admin() OR tenant_id = app_current_tenant_id()` *(column-level `SELECT` omits `token_hash` -> `42501`)* | Denied (`fn_tenant_issue_or_resend_invitation` only) | Denied (`fn_tenant_*` / `fn_invitation_*` only) | Denied (no grant/policy) |

---

## 3. Narrow `SECURITY DEFINER` Routines (`0003`, `0005`–`0008`)

Owned by `ft360_migrator` with `SET search_path = pg_catalog, public, pg_temp` and `REVOKE ALL FROM PUBLIC`:
- **Membership & Session Validation (`0003`, `0005`, `0008`):**
  - `fn_verify_tenant_membership(p_user_id UUID, p_tenant_id UUID)`: Verifies `user_status = 'ACTIVE'`, `membership_status = 'ACTIVE'`, and `tenant_status IN ('ACTIVE', 'TRIAL')` directly in PostgreSQL.
  - `fn_auth_validate_session(p_session_id UUID)` (`0008` upgrade): Joins `auth_sessions`, `users`, `tenant_memberships`, **and `public.tenants`** so any session bound to a `SUSPENDED`, `DEACTIVATED`, `CANCELLED`, or `PROVISIONING` tenant immediately returns `active_tenant_status` to `JwtAuthGuard` even when Redis is completely unreachable (`403 TENANT_INACTIVE`).
  - `fn_assert_tenant_operational(p_tenant_id UUID)` (`0008`): Raises `42501` (`TENANT_NOT_OPERATIONAL`) whenever `tenants.status NOT IN ('ACTIVE', 'TRIAL')`, enforced inside invitation issuance/resend/revoke/acceptance and outbox claiming (`fn_auth_claim_email_outbox_by_id` & `fn_auth_claim_email_outbox_batch`).
- **Phase 3 Authentication & Outbox (`0005`–`0006`):** `fn_auth_register_user`, `fn_auth_get_login_candidate`, `fn_auth_verify_email_token`, `fn_auth_issue_email_verification_token`, `fn_auth_issue_password_reset_token`, `fn_auth_reset_password`, `fn_auth_create_session`, `fn_auth_rotate_refresh_session`, `fn_auth_bind_session_organization`, `fn_auth_revoke_session`, `fn_auth_revoke_session_by_refresh_hash`, `fn_auth_revoke_all_user_sessions`, `fn_auth_enqueue_email_outbox`, `fn_auth_complete_email_outbox`, `fn_auth_fail_email_outbox`, `fn_auth_get_email_outbox_status`, `fn_auth_bootstrap_initial_super_admin`, `fn_record_auth_audit_log`.
- **Phase 4 Stage 4A Tenant Audit, Ownership, Lifecycle & Invitations (`0007`–`0008`):**
  - `fn_record_tenant_audit_log(...)` (`0007`): Enforces caller-plane authorization (`TENANT` requires matching `app_current_tenant_id()` + `ACTIVE` membership; `PLATFORM` requires verified `app_is_super_admin()` + `ACTIVE` Super Admin user; `SYSTEM` requires verified unscoped/platform context), validates correlation ID and resource identifiers, and enforces recursive JSONB secret rejection (`23514`).
  - `fn_tenant_transfer_primary_owner(p_tenant_id, p_target_membership_id)` (`0008`): Locks `public.tenants FOR UPDATE`, verifies target is an `ACTIVE` `INTERNAL` `tenant_admin`, and atomically clears the old primary owner before promoting the target inside a single transaction.
  - `fn_platform_transition_tenant_status(...)` (`0008`): Verifies `app_is_super_admin()` + `ACTIVE` `users.is_platform_super_admin`, enforces the 6-state lifecycle matrix and `OD-P1` (`SUSPENDED`/`DEACTIVATED` required prior to `CANCELLED`), requires `10..500` char `p_reason`, unbinds `auth_sessions` on non-operational transitions, and writes an immutable `PLATFORM` audit entry in `tenant_audit_logs`.
  - `fn_tenant_evict_member_sessions(p_tenant_id, p_membership_id)` (`0008`): Surgically unbinds `(active_tenant_id, active_membership_id)` on sessions bound to the evicted membership without revoking sessions active in other organizations.
  - `fn_tenant_list_workspace_members(...)` (`0008`): Enforces `D4` (`allow_member_directory_view = FALSE` by default) and returns `SUSPENDED`/`REVOKED` member profiles only to callers holding `tenant:members:manage` without relaxing `users_select` RLS.
  - `fn_tenant_issue_or_resend_invitation`, `fn_tenant_enqueue_invitation_email_outbox`, `fn_tenant_revoke_invitation`, `fn_invitation_preview_by_token`, `fn_invitation_accept_existing_user`, and `fn_invitation_accept_new_user` (`0008`): Enforce `fn_assert_tenant_operational`, strict initiator vs. recipient separation (`p_actor_user_id <> recipient`, `user_id IS NULL` + `initiated_by_user_id` on `auth_email_outbox`), and `pg_advisory_xact_lock` + `uq_users_email` concurrency protection (`23505` without burning losing `PENDING` tokens).
