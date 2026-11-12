# SQL Migrations Framework & Indexing Strategy

**Last Updated:** 2026-11-12  
**Status:** Phase 0 Database Specification  
**Version:** 0.1.0

---

## 1. Version-Controlled Native SQL Migration Framework

Because ORMs are prohibited, database schema evolution is managed through explicit, deterministic SQL migration files stored in `/db/migrations/` and executed via a dedicated TypeScript CLI runner using `pg` under the `ft360_migrator` database role.

### 1.1 File Naming Convention
```text
db/migrations/
├── 0001_extensions_and_roles.up.sql
├── 0001_extensions_and_roles.down.sql
├── 0002_platform_identity_and_branding.up.sql
├── 0002_platform_identity_and_branding.down.sql
├── 0003_tenants_and_memberships.up.sql
├── 0003_tenants_and_memberships.down.sql
├── 0004_rbac_roles_and_permissions.up.sql
├── 0004_rbac_roles_and_permissions.down.sql
├── 0005_rls_policies_and_audit_triggers.up.sql
└── 0005_rls_policies_and_audit_triggers.down.sql
```

### 1.2 Migration Ledger (`schema_migrations`)
| Column | Type | Description |
|---|---|---|
| `version` | `VARCHAR(64) PRIMARY KEY` | Numeric prefix + slug (e.g., `0003_tenants_and_memberships`) |
| `checksum_sha256` | `CHAR(64) NOT NULL` | SHA-256 hash of `.up.sql`; runner aborts if an already-applied file was mutated |
| `applied_by` | `VARCHAR(128) NOT NULL` | DB role / CI pipeline actor |
| `execution_ms` | `INTEGER NOT NULL` | Duration in milliseconds |
| `applied_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | Execution timestamp |

### 1.3 Migration Safety Rules
1. **Immutability:** Once merged to `development` or `main`, an applied `.up.sql` file is **never edited**—schema changes always use a new sequential migration file.
2. **Transactional DDL:** Every migration runs inside `BEGIN ... COMMIT` ( leveraging PostgreSQL's transactional DDL), except `CREATE INDEX CONCURRENTLY` migrations on large live tables, which explicitly declare `-- tx: false`.
3. **CI Up/Down Verification:** Every PR automatically runs all `.up.sql` files from scratch, runs `.down.sql` rollback verification on the newly added migration, and re-applies `.up.sql` before running integration tests.
4. **Zero-Downtime Discipline (Post-Release):** Follow Expand -> Migrate -> Contract patterns (never drop or rename an active column in the same release that deploys code still referencing it).

---

## 2. Indexing Strategy for Multi-Tenant Performance

In a shared-schema multi-tenant database, **every query inside a tenant filters by `tenant_id`**. Therefore, index column order is critical:

1. **Leading `tenant_id` Rule:** Composite B-tree indexes on tenant-scoped tables place `tenant_id` first:
   - Lookup by status/owner: `CREATE INDEX idx_leads_tenant_status_owner ON leads (tenant_id, status, owner_membership_id);`
   - Chronological feeds / cursor pagination: `CREATE INDEX idx_audit_tenant_created_id ON tenant_audit_logs (tenant_id, created_at DESC, id DESC);`
   - Case-insensitive uniqueness within tenant: `CREATE UNIQUE INDEX uq_contacts_tenant_email ON contacts (tenant_id, email) WHERE deleted_at IS NULL;`
2. **Cross-Tenant Membership Discovery Index:** Because login needs to list all tenants for a `user_id` prior to choosing a tenant, `tenant_memberships` carries **both**:
   - `(tenant_id, user_id)` (unique, serves tenant-scoped queries)
   - `(user_id, status)` (serves login workspace picker)
3. **Full-Text & Fuzzy Search Indexes:**
   - GIN trigram / `tsvector` indexes combined with `btree_gin` on `(tenant_id, search_vector)` for sub-50ms search across millions of Master DBMS / CRM records.
4. **Query Plan Verification:** Repositories for high-volume modules (CRM, Master DBMS, CDRs, Analytics) must validate `EXPLAIN (ANALYZE, BUFFERS)` plans during integration QA to ensure index scans (`Index Scan` / `Bitmap Index Scan`) and zero unexpected full-table sequential scans.

