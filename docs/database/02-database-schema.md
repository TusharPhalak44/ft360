# Core Database Schema & Table Catalog

**Last Updated:** 2026-11-16  
**Status:** Phase 4 Stage 4A Implemented Schema (`0001`–`0008`, `22` `FORCE RLS` Public Tables) + Phases 6–7 Roadmap Catalog  
**Version:** 0.4.0

---

## 1. Required PostgreSQL Extensions

Provisioned at database initialization (`docker/postgres/init/01-init-roles.sh`, `scripts/infra.mjs`, and `.github/workflows/ci.yml`):
- `citext` — Case-insensitive emails (`users.email`, `tenant_invitations.email`), tenant slugs (`tenants.slug`), and role slugs (`roles.slug`).
- `pgcrypto` — Cryptographic digest helpers where required in SQL.
- `pg_trgm` — Trigram indexing for fuzzy search in CRM / Master DBMS modules.
- `btree_gist` — Exclusion constraints for time-range integrity.
- Built-in PostgreSQL 18 `uuidv7()` — Time-ordered UUIDv7 primary keys across all domain tables.

---

## 2. Implemented Tables (`migrations 0001–0008` — `22` Public Application Tables)

| Table Name | Migration | Scope Plane | Primary Key | `tenant_id`? | `ENABLE` + `FORCE RLS` | `ft360_app` Grants |
|---|---|---|---|---|---|---|
| `schema_migrations` | Runner | Infrastructure | `version VARCHAR(64)` | No | No (`ft360_migrator` owned) | `SELECT` only |
| `platform_branding_settings` | `0002` | Platform | `singleton_key BOOLEAN` | No | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE` |
| `rls_isolation_canary` | `0002` | Tenant Canary | `id UUID DEFAULT uuidv7()` | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE, DELETE` |
| `users` | `0003` / `0007` | Platform Identity | `id UUID DEFAULT uuidv7()` | No | **Yes (`FORCE`)** | Column `SELECT` *(no `password_hash`)*, `INSERT`, `UPDATE` |
| `tenants` | `0003` / `0007` | Platform / Root Org | `id UUID DEFAULT uuidv7()` | Root (`id`) | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE` |
| `tenant_memberships` | `0003` / `0007` | Tenant Bridge | `id UUID DEFAULT uuidv7()` | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE, DELETE` |
| `permissions` | `0004` / `0007` | Platform Catalog (`24` seeds) | `id UUID DEFAULT uuidv7()` | No | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE` |
| `roles` | `0004` | Tenant RBAC | `id UUID DEFAULT uuidv7()` | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE, DELETE` |
| `role_permissions` | `0004` | Tenant RBAC | `id UUID DEFAULT uuidv7()` | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE, DELETE` |
| `user_role_assignments` | `0004` | Tenant RBAC | `id UUID DEFAULT uuidv7()` | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE, DELETE` |
| `auth_sessions` | `0005` | Auth Session Ledger | `id UUID DEFAULT uuidv7()` | Nullable `active_tenant_id` | **Yes (`FORCE`)** | Column `SELECT` *(no refresh/csrf hashes)*, Column `UPDATE` *(revocation only)* |
| `email_verification_tokens` | `0005` | Auth Verification | `id UUID DEFAULT uuidv7()` | No | **Yes (`FORCE`)** | Column `SELECT` *(no `token_hash`, Super Admin only)* |
| `password_reset_tokens` | `0005` | Auth Recovery | `id UUID DEFAULT uuidv7()` | No | **Yes (`FORCE`)** | Column `SELECT` *(no `token_hash`, Super Admin only)* |
| `auth_audit_logs` | `0005` / `0006` | Append-Only Auth Audit | `id UUID DEFAULT uuidv7()` | Nullable `tenant_id` | **Yes (`FORCE`)** | `SELECT, INSERT` *(zero `UPDATE`/`DELETE`; recursive `chk_auth_audit_logs_no_secret_keys`)* |
| `auth_refresh_token_history` | `0006` | Auth Replay Lineage | `id UUID DEFAULT uuidv7()` | No | **Yes (`FORCE`)** | Column `SELECT` *(no `token_hash` / `replaced_by_token_hash`; Super Admin only)* |
| `auth_email_outbox` | `0006` / `0008` | Durable Mail Outbox | `id UUID DEFAULT uuidv7()` | Nullable `tenant_id` | **Yes (`FORCE`)** | Column `SELECT` *(no `encrypted_action_token`; Super Admin only)* |
| `tenant_onboarding_states` | `0007` | Tenant Onboarding | `tenant_id UUID` (`1:1`) | **Yes (`PK`)** | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE` *(operational tenant or Super Admin)* |
| `tenant_profiles` | `0007` | Tenant Profile | `tenant_id UUID` (`1:1`) | **Yes (`PK`)** | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE` *(operational tenant or Super Admin)* |
| `tenant_settings` | `0007` | Tenant Settings | `tenant_id UUID` (`1:1`) | **Yes (`PK`)** | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE` *(operational tenant or Super Admin)* |
| `tenant_branding_assets` | `0007` | Tenant Branding Assets | `id UUID DEFAULT uuidv7()` | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | `SELECT, INSERT, DELETE` *(immutable binary metadata; operational tenant or Super Admin)* |
| `tenant_branding_settings` | `0007` | Tenant Theme | `tenant_id UUID` (`1:1`) | **Yes (`PK`)** | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE` *(operational tenant or Super Admin)* |
| `tenant_audit_logs` | `0007` | Append-Only Tenant Audit | `id UUID DEFAULT uuidv7()` | **Yes (`NOT NULL`, `RESTRICT`)** | **Yes (`FORCE`)** | `SELECT, INSERT` *(zero `UPDATE`/`DELETE`; `chk_tal_no_secret_keys`)* |
| `tenant_invitations` | `0008` | Tenant Invitations | `id UUID DEFAULT uuidv7()` | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | Column `SELECT` *(no `token_hash`)* *(writes via narrow `fn_tenant_*` / `fn_invitation_*` only)* |

---

## 3. Referential Integrity, Unique Constraints & Security Triggers (`0002`–`0008`)

1. **Global Identity & Organization Uniqueness (with Concurrency Hardening):**
   - `users`: `uq_users_email UNIQUE (email)` (`CITEXT`), `chk_users_email_canonical_trimmed CHECK (email::text = lower(btrim(email::text)) AND length(btrim(email::text)) >= 3)`, functional unique index `uq_users_email_normalized ON public.users (lower(btrim(email::text)))`, and `chk_users_status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED')`.
   - `tenants`: `uq_tenants_slug UNIQUE (slug)` (`CITEXT`), `chk_tenants_status IN ('PROVISIONING', 'TRIAL', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'CANCELLED')`, `chk_tenants_deactivated_at_consistency`, `chk_tenants_cancelled_at_consistency`, and `chk_tenants_status_reason_bounds`.
2. **Multi-Tenant Membership, Primary Owner & Composite FK Anchors:**
   - `tenant_memberships`: `uq_tenant_memberships_tenant_user UNIQUE (tenant_id, user_id)`, `uq_tenant_memberships_tenant_id_id UNIQUE (tenant_id, id)`, partial unique index `uq_tenant_memberships_employee_code (tenant_id, employee_code) WHERE employee_code IS NOT NULL`, `chk_tenant_memberships_primary_owner_invariant` (`is_primary_owner = TRUE` requires `status = 'ACTIVE' AND membership_type = 'INTERNAL'`), and partial unique index `uq_tenant_memberships_primary_owner ON tenant_memberships (tenant_id) WHERE is_primary_owner = TRUE`.
   - `roles`: `uq_roles_tenant_slug UNIQUE (tenant_id, slug)`, `uq_roles_tenant_id_id UNIQUE (tenant_id, id)`.
   - `tenant_branding_assets`: `uq_tba_tenant_id_id UNIQUE (tenant_id, id)`, `uq_tba_storage_key UNIQUE (storage_key)`, `chk_tba_mime_no_svg` (strict raster allowlist `image/png`, `image/jpeg`, `image/webp`; SVG prohibited), pixel-bomb dimension/area limits (`<= 2048x2048` / `<= 4,194,304 px` logos; square `<= 512x512` / `<= 262,144 px` favicons).
   - `tenant_invitations`: `uq_ti_tenant_id_id UNIQUE (tenant_id, id)`, `uq_ti_token_hash UNIQUE (token_hash)`, partial unique index `uq_tenant_invitations_pending_email (tenant_id, email) WHERE status = 'PENDING'`, `chk_ti_pending_recipient_unbound` (`PENDING` rows never pre-bind `accepted_by_user_id` or `accepted_membership_id`), and `chk_ti_initiator_recipient_distinct` (`accepted_by_user_id <> invited_by_user_id`).
3. **Mandatory Composite Foreign Keys (Cross-Tenant Link Prevention):**
   - `role_permissions.fk_role_permissions_tenant_role`: `(tenant_id, role_id) -> roles(tenant_id, id) ON DELETE CASCADE`.
   - `user_role_assignments`: `fk_ura_tenant_membership`, `fk_ura_tenant_role`, `fk_ura_assigned_by_membership`.
   - `auth_sessions.fk_auth_sessions_active_membership`: `(active_tenant_id, active_membership_id) -> tenant_memberships(tenant_id, id) ON DELETE SET NULL`.
   - `tenant_onboarding_states.fk_tos_completed_by_membership`: `(tenant_id, completed_by_membership_id) -> tenant_memberships(tenant_id, id) ON DELETE SET NULL (completed_by_membership_id)`.
   - `tenant_profiles.fk_tp_updated_by_membership` & `tenant_settings.fk_ts_updated_by_membership`: `(tenant_id, updated_by_membership_id) -> tenant_memberships(tenant_id, id) ON DELETE SET NULL (updated_by_membership_id)`.
   - `tenant_branding_assets.fk_tba_uploaded_by_membership`: `(tenant_id, uploaded_by_membership_id) -> tenant_memberships(tenant_id, id) ON DELETE SET NULL (uploaded_by_membership_id)`.
   - `tenant_branding_settings`: `fk_tbs_logo_light_asset`, `fk_tbs_logo_dark_asset`, `fk_tbs_favicon_asset` (`-> tenant_branding_assets(tenant_id, id)`), and `fk_tbs_updated_by_membership`.
   - `tenant_invitations`: `fk_ti_tenant_role` (`-> roles(tenant_id, id)`), `fk_ti_invited_by_membership`, `fk_ti_accepted_membership`, and `fk_ti_revoked_by_membership` (`-> tenant_memberships(tenant_id, id)`).
   - `auth_email_outbox.fk_aeo_tenant_invitation`: `(tenant_id, invitation_id) -> tenant_invitations(tenant_id, id) ON DELETE CASCADE`, paired with `chk_auth_email_outbox_anchor` (`TENANT_INVITATION` requires `user_id IS NULL` + `(tenant_id, invitation_id) IS NOT NULL`; `EMAIL_VERIFICATION`/`PASSWORD_RESET` require `user_id IS NOT NULL AND initiated_by_user_id IS NULL AND tenant_id IS NULL AND invitation_id IS NULL`).
   - `tenant_audit_logs`: `fk_tal_tenant` (`ON DELETE RESTRICT` -> raises `23001` on physical tenant delete), `fk_tal_actor_membership`, and `fk_tal_target_membership`.
4. **Database Security, Lifecycle, Concurrency & Immutability Triggers:**
   - `trigger_protect_user_privileged_fields()` blocks non-Super-Admin `ft360_app` mutations to `users.is_platform_super_admin`, `users.status`, and `users.email` (`42501`).
   - `trigger_protect_tenant_lifecycle()` (`0007`) blocks non-Super-Admin mutations to `tenants.status`, `slug`, `created_by_user_id`, and lifecycle timestamps (`42501`), blocks outbound transitions from terminal `CANCELLED` (`23514`), and enforces `OD-P1` requiring prior `SUSPENDED` or `DEACTIVATED` before `CANCELLED` (`23514`).
   - `trigger_enforce_tenant_permission_scope()` prevents granting `scope_plane = 'PLATFORM'` permissions to any tenant role (`42501`).
   - `trigger_enforce_admin_membership_type()` (`0008`, `AFTER INSERT OR UPDATE`) prevents `CLIENT_PORTAL` or `PARTNER` memberships from holding `tenant_admin` (`42501`).
   - `trigger_prevent_last_tenant_admin_removal()` (`0008`) acquires a serialized row-level lock (`SELECT status FROM public.tenants WHERE id = v_tenant_id FOR UPDATE`) before counting remaining active `INTERNAL` `tenant_admin` assignments, deterministically preventing concurrent two-admin demotion/suspension/revocation races from orphaning operational (`PROVISIONING`, `TRIAL`, `ACTIVE`, `SUSPENDED`) tenants (`42501`).
   - `trigger_protect_auth_audit_immutability()` and `trigger_protect_tenant_audit_immutability()` (`0007`) block all runtime `UPDATE` and `DELETE` operations (`42501`, even under Platform Super Admin GUCs) paired with recursive JSONB secret rejection (`fn_jsonb_has_forbidden_secret_key` -> `23514`).
