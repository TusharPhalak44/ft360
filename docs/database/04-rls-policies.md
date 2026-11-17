# PostgreSQL Row-Level Security (RLS) Policies & Database Function Catalog

**Last Updated:** 2026-11-17  
**Status:** Phase 4B Database Prerequisite Verified (`migrations 0001–0009`, `22` `FORCE RLS` Tables)  
**Version:** 0.4.1

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
| `tenants` | `app_is_super_admin() OR id = app_current_tenant_id()` | `app_is_super_admin()` *(or via `fn_tenant_provision_organization`)* | `app_is_super_admin() OR id = app_current_tenant_id()` *(+ `trigger_protect_tenant_lifecycle` enforcing `42501` & `OD-P1`)* | Denied (`fk_tal_tenant` `ON DELETE RESTRICT` + no grant) |
| `tenant_memberships` | `tenant_id = app_current_tenant_id() OR app_is_super_admin()` | `tenant_id = app_current_tenant_id() OR app_is_super_admin()` *(+ primary-owner trigger)* | `tenant_id = app_current_tenant_id() OR app_is_super_admin()` *(+ serialized last-admin trigger)* | `tenant_id = app_current_tenant_id() OR app_is_super_admin()` *(+ serialized last-admin trigger)* |
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
| `tenant_branding_assets` | `app_is_super_admin() OR tenant_id = app_current_tenant_id()` | `app_is_super_admin() OR (tenant_id = app_current_tenant_id() AND fn_is_current_tenant_operational())` | `app_is_super_admin() OR (tenant_id = app_current_tenant_id() AND fn_is_current_tenant_operational())` | Denied (no grant/policy) |
| `tenant_branding_settings` | `app_is_super_admin() OR tenant_id = app_current_tenant_id()` | `app_is_super_admin() OR (tenant_id = app_current_tenant_id() AND fn_is_current_tenant_operational())` | `app_is_super_admin() OR (tenant_id = app_current_tenant_id() AND fn_is_current_tenant_operational())` | Denied (no grant/policy) |
| `tenant_audit_logs` | `app_is_super_admin() OR tenant_id = app_current_tenant_id()` | Denied (`fn_record_tenant_audit_log` / internal provisioning routines only; `SELECT` grant only on table) | Denied (`42501` immutability trigger + no grant) | Denied (`42501` immutability trigger + no grant) |
| `tenant_invitations` | `app_is_super_admin() OR tenant_id = app_current_tenant_id()` *(column-level `SELECT` omits `token_hash` -> `42501`)* | Denied (`SECURITY DEFINER` invitation routines only) | Denied (`SECURITY DEFINER` invitation routines only) | Denied (no grant/policy) |

---

## 3. Implemented Narrow `SECURITY DEFINER` Function Catalog (`0003`, `0005`–`0009`)

Every `SECURITY DEFINER` function is owned by `ft360_migrator` with `SET search_path = pg_catalog, public, pg_temp`, `REVOKE ALL FROM PUBLIC`, and explicit `GRANT EXECUTE TO ft360_app`:

1. **Membership & Operational Lifecycle Verification (`0003`, `0005`, `0007`, `0008`):**
   - `fn_verify_tenant_membership(p_user_id UUID, p_tenant_id UUID)` (`0003`)
   - `fn_list_user_tenants(p_user_id UUID)` (`0003`)
   - `fn_is_current_tenant_operational()` (`0007`)
   - `fn_assert_tenant_operational(p_tenant_id UUID)` (`0007`)
2. **Authentication, Sessions & Durable Outbox (`0005`, `0006`, `0008`):**
   - `fn_auth_register_user` (`0005`, upgraded in `0008` with `pg_advisory_xact_lock` on normalized email)
   - `fn_auth_get_login_candidate`, `fn_auth_verify_email_token`, `fn_auth_issue_email_verification_token`, `fn_auth_issue_password_reset_token`, `fn_auth_reset_password` (`0005`)
   - `fn_auth_create_session`, `fn_auth_validate_session`, `fn_auth_rotate_refresh_session`, `fn_auth_bind_session_organization`, `fn_auth_revoke_session`, `fn_auth_revoke_session_by_refresh_hash`, `fn_auth_revoke_all_user_sessions` (`0005` / `0006`)
   - `fn_auth_enqueue_email_outbox`, `fn_tenant_enqueue_invitation_email_outbox` (`0008`), `fn_auth_claim_email_outbox_by_id` (`0006` / `0008`), `fn_auth_claim_email_outbox_batch` (`0006` / `0008`), `fn_auth_complete_email_outbox_delivery`, `fn_auth_fail_email_outbox_delivery`, `fn_auth_get_email_outbox_status` (`0006`)
   - `fn_auth_bootstrap_initial_super_admin`, `fn_record_auth_audit_log` (`0006`)
3. **Tenant Governance, Ownership & Lifecycle (`0007`, `0008`):**
   - `fn_record_tenant_audit_log(...)` (`0007`)
   - `fn_tenant_evict_member_sessions(p_tenant_id UUID, p_membership_id UUID)` (`0008`)
   - `fn_tenant_transfer_primary_owner(...)` (`0008`)
   - `fn_platform_transition_tenant_status(...)` (`0008`)
4. **Phase 4B Tenant Registration & Provisioning (`0009`):**
   - **`fn_check_tenant_slug_available(p_slug CITEXT) RETURNS BOOLEAN` (`0009`):** Rejects active tenant GUC context (`42501`), requires verified `app_current_user_id()` (`users.status = 'ACTIVE'` AND `email_verified = TRUE`, `42501` otherwise), uniformly returns `FALSE` for `NULL`/untrimmed/uppercase/invalid syntax, `41` reserved system/route slugs, and occupied `tenants.slug` rows, and returns strictly a boolean with zero tenant metadata exposed.
   - **`fn_tenant_provision_organization(...)` (`0009`):** Requires `app_current_tenant_id() IS NULL`, `app_is_super_admin() = FALSE`, `app_current_user_id() = p_actor_user_id`, `users.status = 'ACTIVE'`, `users.email_verified = TRUE`, `users.is_platform_super_admin = FALSE`, and a valid unrevoked/unexpired `auth_sessions` row belonging to `p_actor_user_id`; never elevates `app.is_super_admin`; serializes per-user ownership quota (`<= 5` `ACTIVE`/`TRIAL` owned tenants, with `PROVISIONING`/`SUSPENDED` self-created tenants also counted per `D2`) via `pg_advisory_xact_lock`; atomically creates `tenants` (`TRIAL`), `roles` (`tenant_admin` with exact `18` `TENANT` permissions; `member` with exact `4` baseline `TENANT` read permissions), `is_primary_owner = TRUE` `tenant_memberships` + `user_role_assignments`, `1:1` companion rows (`tenant_profiles`, `tenant_settings`, `tenant_branding_settings`, `tenant_onboarding_states`), binds only `p_session_id`, and writes dual-ledger `TENANT_REGISTERED` audit entries sharing `p_correlation_id`.

*(Note: Stage 4D directory & invitation workflow routines `fn_tenant_list_workspace_members`, `fn_tenant_issue_or_resend_invitation`, `fn_tenant_revoke_invitation`, `fn_invitation_preview_by_token`, `fn_invitation_accept_existing_user`, and `fn_invitation_accept_new_user` remain scheduled for Stage 4D).*
