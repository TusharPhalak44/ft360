# Core Database Schema & Table Catalog

**Last Updated:** 2026-11-13  
**Status:** Phase 3 Implemented Schema (`0001`–`0006`) + Phases 4–7 Roadmap Catalog  
**Version:** 0.3.1

---

## 1. Required PostgreSQL Extensions

Provisioned at database initialization (`docker/postgres/init/01-init-roles.sh`, `scripts/infra.mjs`, and `.github/workflows/ci.yml`):
- `citext` — Case-insensitive emails (`users.email`), tenant slugs (`tenants.slug`), and role slugs (`roles.slug`).
- `pgcrypto` — Cryptographic digest helpers where required in SQL.
- `pg_trgm` — Trigram indexing for fuzzy search in CRM / Master DBMS modules.
- `btree_gist` — Exclusion constraints for time-range integrity.
- Built-in PostgreSQL 18 `uuidv7()` — Time-ordered UUIDv7 primary keys across all domain tables.

---

## 2. Implemented Tables (`migrations 0001–0006`)

| Table Name | Migration | Scope Plane | Primary Key | `tenant_id`? | `ENABLE` + `FORCE RLS` | `ft360_app` Grants |
|---|---|---|---|---|---|---|
| `schema_migrations` | Runner | Infrastructure | `version VARCHAR(64)` | No | No (`ft360_migrator` owned) | `SELECT` only |
| `platform_branding_settings` | `0002` | Platform | `singleton_key BOOLEAN` | No | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE` |
| `rls_isolation_canary` | `0002` | Tenant Canary | `id UUID DEFAULT uuidv7()` | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE, DELETE` |
| `users` | `0003` | Platform Identity | `id UUID DEFAULT uuidv7()` | No | **Yes (`FORCE`)** | Column `SELECT` *(no `password_hash`)*, `INSERT`, `UPDATE` |
| `tenants` | `0003` | Platform / Root Org | `id UUID DEFAULT uuidv7()` | Root (`id`) | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE` |
| `tenant_memberships` | `0003` | Tenant Bridge | `id UUID DEFAULT uuidv7()` | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE, DELETE` |
| `permissions` | `0004` | Platform Catalog | `id UUID DEFAULT uuidv7()` | No | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE` |
| `roles` | `0004` | Tenant RBAC | `id UUID DEFAULT uuidv7()` | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE, DELETE` |
| `role_permissions` | `0004` | Tenant RBAC | `id UUID DEFAULT uuidv7()` | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE, DELETE` |
| `user_role_assignments` | `0004` | Tenant RBAC | `id UUID DEFAULT uuidv7()` | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | `SELECT, INSERT, UPDATE, DELETE` |
| `auth_sessions` | `0005` | Auth Session Ledger | `id UUID DEFAULT uuidv7()` | Nullable `active_tenant_id` | **Yes (`FORCE`)** | Column `SELECT` *(no refresh/csrf hashes)*, Column `UPDATE` *(revocation only)* |
| `email_verification_tokens` | `0005` | Auth Verification | `id UUID DEFAULT uuidv7()` | No | **Yes (`FORCE`)** | Column `SELECT` *(no `token_hash`, Super Admin only)* |
| `password_reset_tokens` | `0005` | Auth Recovery | `id UUID DEFAULT uuidv7()` | No | **Yes (`FORCE`)** | Column `SELECT` *(no `token_hash`, Super Admin only)* |
| `auth_audit_logs` | `0005` / `0006` | Append-Only Security Audit | `id UUID DEFAULT uuidv7()` | Nullable `tenant_id` | **Yes (`FORCE`)** | `SELECT, INSERT` *(zero `UPDATE`/`DELETE`; recursive `chk_auth_audit_logs_no_secret_keys`)* |
| `auth_refresh_token_history` | `0006` | Auth Replay Lineage | `id UUID DEFAULT uuidv7()` | No | **Yes (`FORCE`)** | Column `SELECT` *(no `token_hash` / `replaced_by_token_hash`; Super Admin only)* |
| `auth_email_outbox` | `0006` | Durable Auth Mail Outbox | `id UUID DEFAULT uuidv7()` | No | **Yes (`FORCE`)** | Column `SELECT` *(no `encrypted_action_token`; Super Admin only)* |

---

## 3. Phase 2 Referential Integrity, Unique Constraints & Triggers

1. **Global Identity & Organization Uniqueness:**
   - `users`: `uq_users_email UNIQUE (email)` (`CITEXT`), `chk_users_status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED')`.
   - `tenants`: `uq_tenants_slug UNIQUE (slug)` (`CITEXT`), `chk_tenants_status IN ('PROVISIONING', 'TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED')`.
2. **Multi-Tenant Membership & Composite FK Anchors:**
   - `tenant_memberships`: `uq_tenant_memberships_tenant_user UNIQUE (tenant_id, user_id)`, `uq_tenant_memberships_tenant_id_id UNIQUE (tenant_id, id)`, partial unique index `uq_tenant_memberships_employee_code (tenant_id, employee_code) WHERE employee_code IS NOT NULL`.
   - `roles`: `uq_roles_tenant_slug UNIQUE (tenant_id, slug)`, `uq_roles_tenant_id_id UNIQUE (tenant_id, id)`.
3. **Mandatory Composite Foreign Keys (Cross-Tenant Link Prevention):**
   - `role_permissions.fk_role_permissions_tenant_role`: `FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id) ON DELETE CASCADE` + `UNIQUE (tenant_id, role_id, permission_id)`.
   - `user_role_assignments.fk_ura_tenant_membership`: `FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id) ON DELETE CASCADE`.
   - `user_role_assignments.fk_ura_tenant_role`: `FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id) ON DELETE CASCADE`.
   - `user_role_assignments.fk_ura_assigned_by_membership`: `FOREIGN KEY (tenant_id, assigned_by_membership_id) REFERENCES tenant_memberships(tenant_id, id) ON DELETE SET NULL (assigned_by_membership_id)`.
   - `auth_sessions.fk_auth_sessions_active_membership`: `FOREIGN KEY (active_tenant_id, active_membership_id) REFERENCES tenant_memberships(tenant_id, id) ON DELETE SET NULL` paired with `chk_auth_sessions_tenant_member_pair` ensuring `active_tenant_id` and `active_membership_id` are either both `NULL` or both bound to a verified membership in that exact tenant.
4. **Database Security & Timestamp Triggers:**
   - `trigger_set_updated_at()` on `users`, `tenants`, `tenant_memberships`, `permissions`, `roles`, `role_permissions`, `user_role_assignments`, `auth_sessions`, and `platform_branding_settings`.
   - `trigger_protect_user_privileged_fields()` blocks non-Super-Admin `ft360_app` mutations to `users.is_platform_super_admin`, `users.status`, and `users.email` (`42501`).
   - `trigger_protect_tenant_lifecycle()` blocks non-Super-Admin `ft360_app` mutations to `tenants.status`, `tenants.slug`, `tenants.activated_at`, and `tenants.suspended_at` (`42501`).
   - `trigger_enforce_tenant_permission_scope()` prevents granting `scope_plane = 'PLATFORM'` permissions to any tenant role (`42501`).
   - `trigger_protect_auth_session_immutability()` prevents mutating `auth_sessions.id`, `family_id`, `user_id`, or `created_at` (`42501`).
   - `trigger_protect_auth_audit_immutability()` enforces strict append-only immutability on `auth_audit_logs` (`42501` on any runtime `UPDATE` or `DELETE`, including under Platform Super Admin transactions) paired with `chk_auth_audit_logs_no_secret_keys`.
