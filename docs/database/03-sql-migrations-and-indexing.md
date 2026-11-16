# SQL Migrations Framework & Indexing Strategy

**Last Updated:** 2026-11-16  
**Status:** Phase 4 Stage 4A Active Specification (`0001`–`0008` Applied & Verified)  
**Version:** 0.4.0

---

## 1. Version-Controlled Native SQL Migration Files

All schema evolution is managed via deterministic `.up.sql` and `.down.sql` pairs in `/db/migrations/` executed by `SqlMigrationRunner` (`apps/api/src/database/migrations/migration-runner.ts`) using native `pg` under the `ft360_migrator` role:

```text
db/migrations/
├── 0001_foundation_rls_helpers.up.sql
├── 0001_foundation_rls_helpers.down.sql
├── 0002_foundation_branding_and_rls_canary.up.sql
├── 0002_foundation_branding_and_rls_canary.down.sql
├── 0003_users_tenants_and_memberships.up.sql
├── 0003_users_tenants_and_memberships.down.sql
├── 0004_rbac_roles_permissions_and_assignments.up.sql
├── 0004_rbac_roles_permissions_and_assignments.down.sql
├── 0005_authentication_sessions_tokens_and_audit.up.sql
├── 0005_authentication_sessions_tokens_and_audit.down.sql
├── 0006_phase3_auth_security_remediation.up.sql
├── 0006_phase3_auth_security_remediation.down.sql
├── 0007_phase4_tenant_core_schema_and_audit.up.sql
├── 0007_phase4_tenant_core_schema_and_audit.down.sql
├── 0008_phase4_invitations_outbox_and_integrity_routines.up.sql
└── 0008_phase4_invitations_outbox_and_integrity_routines.down.sql
```

### Migration Safety Rules
1. **SHA-256 Checksum Immutability:** `schema_migrations` stores `checksum_sha256` for every applied `.up.sql`; `SqlMigrationRunner` aborts immediately if an applied migration file (`0001`–`0008`) is altered on disk.
2. **Advisory Lock Serialization:** Concurrent deploys serialize via `pg_advisory_lock`.
3. **Clean-DB + Full Rollback Verification:** CI, `phase2-database-foundation-rls.int-spec.ts`, and `phase3-auth-workflows.int-spec.ts` (`IT-P3-01`) verify full clean-DB teardown (`0008` down to `schema_migrations` only), clean re-application (`0001`..`0008`), and incremental rollback/re-apply (`0008 -> 0007 -> 0006 -> 0007 -> 0008`).

---

## 2. Implemented Multi-Tenant & Security Indexes (`0002`–`0008`)

1. **Leading `tenant_id` B-Tree Indexes (`0002`–`0004`):**
   - `idx_rls_canary_tenant_created ON rls_isolation_canary (tenant_id, created_at DESC)`
   - `uq_tenant_memberships_tenant_user ON tenant_memberships (tenant_id, user_id)`
   - `uq_tenant_memberships_tenant_id_id ON tenant_memberships (tenant_id, id)`
   - `uq_tenant_memberships_employee_code ON tenant_memberships (tenant_id, employee_code) WHERE employee_code IS NOT NULL`
   - `idx_tenant_memberships_tenant_status ON tenant_memberships (tenant_id, status, membership_type)`
   - `uq_roles_tenant_slug ON roles (tenant_id, slug)`
   - `uq_roles_tenant_id_id ON roles (tenant_id, id)`
   - `idx_roles_tenant_system ON roles (tenant_id, is_system_role)`
   - `uq_role_permissions_tenant_role_perm ON role_permissions (tenant_id, role_id, permission_id)`
   - `idx_role_permissions_tenant_role ON role_permissions (tenant_id, role_id)`
   - `uq_user_role_assignments_member_role ON user_role_assignments (tenant_id, membership_id, role_id)`
   - `idx_ura_tenant_membership ON user_role_assignments (tenant_id, membership_id)`
   - `idx_ura_tenant_role ON user_role_assignments (tenant_id, role_id)`
2. **Cross-Tenant Workspace Discovery & Platform Indexes (`0003`–`0004`):**
   - `idx_tenant_memberships_user_status ON tenant_memberships (user_id, status)`
   - `idx_users_status_created ON users (status, created_at DESC)`
   - `idx_tenants_status_created ON tenants (status, created_at DESC)`
   - `idx_permissions_scope_module ON permissions (scope_plane, module_code)`
   - `idx_role_permissions_permission ON role_permissions (permission_id)`
3. **Phase 3 Authentication, Session Lineage & Remediation Indexes (`0005`–`0006`):**
   - `uq_auth_sessions_refresh_token_hash ON auth_sessions (refresh_token_hash)`
   - `idx_auth_sessions_user_active ON auth_sessions (user_id, expires_at DESC) WHERE revoked_at IS NULL`
   - `idx_auth_sessions_family_id ON auth_sessions (family_id)`
   - `idx_auth_sessions_prev_refresh_hash ON auth_sessions (previous_refresh_token_hash) WHERE previous_refresh_token_hash IS NOT NULL`
   - `idx_auth_sessions_active_tenant_member ON auth_sessions (active_tenant_id, active_membership_id) WHERE active_tenant_id IS NOT NULL`
   - `uq_email_verification_tokens_hash ON email_verification_tokens (token_hash)`
   - `idx_email_verification_tokens_user_active ON email_verification_tokens (user_id, expires_at DESC) WHERE consumed_at IS NULL`
   - `uq_password_reset_tokens_hash ON password_reset_tokens (token_hash)`
   - `idx_password_reset_tokens_user_active ON password_reset_tokens (user_id, expires_at DESC) WHERE consumed_at IS NULL`
   - `idx_auth_audit_logs_tenant_created ON auth_audit_logs (tenant_id, created_at DESC) WHERE tenant_id IS NOT NULL`
   - `idx_auth_audit_logs_actor_created ON auth_audit_logs (actor_user_id, created_at DESC) WHERE actor_user_id IS NOT NULL`
   - `idx_auth_audit_logs_event_created ON auth_audit_logs (event_type, outcome, created_at DESC)`
   - `uq_auth_rt_history_token_hash ON auth_refresh_token_history (token_hash)`
   - `idx_auth_rt_history_family_rotated ON auth_refresh_token_history (family_id, rotated_at DESC)`
   - `idx_auth_rt_history_session_rotated ON auth_refresh_token_history (session_id, rotated_at DESC)`
   - `idx_auth_email_outbox_due ON auth_email_outbox (next_attempt_at ASC) WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`
   - `idx_auth_email_outbox_user_created ON auth_email_outbox (user_id, created_at DESC)`
4. **Phase 4 Stage 4A Tenant Schema, Concurrency, Invitations & Audit Indexes (`0007`–`0008`):**
   - `uq_users_email_normalized ON users (lower(btrim(email::text)))` *(canonical normalized global email uniqueness)*
   - `idx_tenants_created_by_user ON tenants (created_by_user_id, created_at DESC) WHERE created_by_user_id IS NOT NULL`
   - `uq_tenant_memberships_primary_owner ON tenant_memberships (tenant_id) WHERE is_primary_owner = TRUE` *(at most 1 primary owner per tenant)*
   - `idx_tos_status_updated ON tenant_onboarding_states (status, updated_at DESC)`
   - `idx_tp_country_industry ON tenant_profiles (country_code, industry) WHERE country_code IS NOT NULL`
   - `uq_tba_tenant_id_id ON tenant_branding_assets (tenant_id, id)`
   - `uq_tba_storage_key ON tenant_branding_assets (storage_key)`
   - `idx_tba_tenant_kind_created ON tenant_branding_assets (tenant_id, asset_kind, created_at DESC)`
   - `uq_tal_tenant_id_id ON tenant_audit_logs (tenant_id, id)`
   - `idx_tal_tenant_created_id ON tenant_audit_logs (tenant_id, created_at DESC, id DESC)` *(deterministic cursor pagination for Endpoint `#29`)*
   - `idx_tal_tenant_event_created ON tenant_audit_logs (tenant_id, event_type, created_at DESC)`
   - `idx_tal_tenant_resource_created ON tenant_audit_logs (tenant_id, resource_type, resource_id, created_at DESC)`
   - `idx_tal_tenant_actor_created ON tenant_audit_logs (tenant_id, actor_user_id, created_at DESC) WHERE actor_user_id IS NOT NULL`
   - `idx_tal_correlation_id ON tenant_audit_logs (correlation_id)`
   - `uq_ti_tenant_id_id ON tenant_invitations (tenant_id, id)`
   - `uq_ti_token_hash ON tenant_invitations (token_hash)`
   - `uq_tenant_invitations_pending_email ON tenant_invitations (tenant_id, email) WHERE status = 'PENDING'`
   - `idx_ti_tenant_status_created ON tenant_invitations (tenant_id, status, created_at DESC)`
   - `idx_ti_email_status ON tenant_invitations (email, status)`
   - `idx_aeo_tenant_invitation ON auth_email_outbox (tenant_id, invitation_id, created_at DESC) WHERE invitation_id IS NOT NULL`
   - `idx_aeo_initiated_by_user ON auth_email_outbox (initiated_by_user_id, created_at DESC) WHERE initiated_by_user_id IS NOT NULL`
