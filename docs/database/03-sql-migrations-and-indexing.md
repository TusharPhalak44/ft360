# SQL Migrations Framework & Indexing Strategy

**Last Updated:** 2026-11-13  
**Status:** Phase 2 Active Specification (`0001`–`0004` Applied & Verified)  
**Version:** 0.2.0

---

## 1. Version-Controlled Native SQL Migration Files

All schema evolution is managed via deterministic `.up.sql` and `.down.sql` pairs in `/db/migrations/` executed by `SqlMigrationRunner` (`apps/api/src/database/migrations/migration-runner.ts`) using `pg` under the `ft360_migrator` role:

```text
db/migrations/
├── 0001_foundation_rls_helpers.up.sql
├── 0001_foundation_rls_helpers.down.sql
├── 0002_foundation_branding_and_rls_canary.up.sql
├── 0002_foundation_branding_and_rls_canary.down.sql
├── 0003_users_tenants_and_memberships.up.sql
├── 0003_users_tenants_and_memberships.down.sql
├── 0004_rbac_roles_permissions_and_assignments.up.sql
└── 0004_rbac_roles_permissions_and_assignments.down.sql
```

### Migration Safety Rules
1. **SHA-256 Checksum Immutability:** `schema_migrations` stores `checksum_sha256` for every applied `.up.sql`; `SqlMigrationRunner` aborts immediately if an applied migration file is altered on disk.
2. **Advisory Lock Serialization:** Concurrent deploys serialize via `pg_advisory_lock`.
3. **Clean-DB + Full Rollback Verification:** CI and `phase2-database-foundation-rls.int-spec.ts` roll back down to an empty `public` schema (`schema_migrations` only), apply `0001`..`0004` from scratch, roll back `0004` -> `0003`, and re-apply `0003` -> `0004`.

---

## 2. Implemented Multi-Tenant Indexes (`0002`–`0004`)

1. **Leading `tenant_id` B-Tree Indexes:**
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
2. **Cross-Tenant Workspace Discovery & Platform Indexes:**
   - `idx_tenant_memberships_user_status ON tenant_memberships (user_id, status)`
   - `idx_users_status_created ON users (status, created_at DESC)`
   - `idx_tenants_status_created ON tenants (status, created_at DESC)`
   - `idx_permissions_scope_module ON permissions (scope_plane, module_code)`
   - `idx_role_permissions_permission ON role_permissions (permission_id)`
