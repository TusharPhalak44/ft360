# Core Database Schema & Table Catalog (Foundation)

**Last Updated:** 2026-11-12  
**Status:** Phase 0 Schema Blueprint (Implemented in Phase 2 SQL Migrations)  
**Version:** 0.1.0

---

## 1. Required PostgreSQL Extensions

Enabled in migration `0001_extensions_and_roles.up.sql`:
- `citext` — Case-insensitive emails, tenant slugs, and custom domains.
- `pgcrypto` — Cryptographic digest helpers where required in SQL.
- `pg_trgm` — Fast `ILIKE` / fuzzy search indexes on names, emails, companies, and leads (scoped by `tenant_id`).
- `btree_gist` — Exclusion constraints (e.g., preventing overlapping subscription periods or calendar double-bookings in Module 26).

---

## 2. Table Classification & Ownership Matrix

| Table Name | Scope Plane | Contains `tenant_id`? | RLS Enabled & Forced? | Primary Purpose |
|---|---|---|---|---|
| `schema_migrations` | Infrastructure | No | No (`ft360_migrator` owned) | Tracks applied SQL migration versions, checksums, and execution timestamps |
| `platform_branding_settings` | Platform | No | No (Platform Admin service only) | Singleton/versioned global product name, logos, colors, support email |
| `users` | Platform Identity | No | Restricted Policy | Global user credentials and profile decoupled from any single tenant |
| `auth_sessions` | Platform Auth | `active_tenant_id` (nullable) | Restricted Policy | Refresh token hashes, device metadata, revocation & active workspace |
| `password_reset_tokens` | Platform Auth | No | Restricted Policy | Hashed single-use password reset tokens with short TTL |
| `permissions` | Platform Catalog | No | Read-Only to App | Canonical immutable catalog of platform, tenant, and portal permissions |
| `subscription_plans` | Platform Billing | No | Read-Only to App | SaaS tiers, base pricing, module entitlements, and usage quotas |
| `tenants` | Platform / Root | `id` (Root) | Restricted Policy | Registered customer organizations and lifecycle state |
| `platform_audit_logs` | Platform Compliance | `target_tenant_id` (nullable) | Platform Admin Only | Append-only audit trail of Super Admin & system lifecycle actions |
| `tenant_memberships` | Tenant Bridge | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | Many-to-many link binding `users` to `tenants` with membership status |
| `tenant_invitations` | Tenant Onboarding | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | Pending email invitations into a specific tenant and initial role set |
| `tenant_settings` | Tenant Config | **Yes (`PK`)** | **Yes (`FORCE`)** | Organization security policies, locale, working hours, feature flags |
| `tenant_branding_settings` | Tenant Branding | **Yes (`PK`)** | **Yes (`FORCE`)** | Per-tenant white-label overrides (logo, palette, custom domain) |
| `roles` | Tenant RBAC | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | System-seeded and custom roles within a specific tenant |
| `role_permissions` | Tenant RBAC | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | Maps tenant `roles` to canonical `permissions` |
| `user_role_assignments` | Tenant RBAC | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | Assigns tenant `roles` to a `tenant_membership` (composite FK enforced) |
| `tenant_subscriptions` | Tenant Billing | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | Active subscription plan, billing cycle, and quota overrides per tenant |
| `tenant_usage_counters` | Tenant Billing | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | Atomic counters for seats, DBMS contacts, emails sent, storage bytes |
| `tenant_audit_logs` | Tenant Compliance | **Yes (`NOT NULL`)** | **Yes (`FORCE`)** | Append-only tenant-scoped audit trail of user & data changes |

---

## 3. Key Integrity Constraints

1. **Unique Multi-Tenant Membership:** `UNIQUE (tenant_id, user_id)` on `tenant_memberships` ensures a user has at most one membership record per tenant (status transitions handle re-activation).
2. **Composite Foreign Keys Everywhere:**
   - `roles`: `UNIQUE (tenant_id, id)` and `UNIQUE (tenant_id, slug)`.
   - `tenant_memberships`: `UNIQUE (tenant_id, id)`.
   - `user_role_assignments`:
     - `FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id) ON DELETE CASCADE`
     - `FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id) ON DELETE CASCADE`
     - `UNIQUE (tenant_id, membership_id, role_id)`
3. **Append-Only Audit Protection:** PostgreSQL `BEFORE UPDATE OR DELETE` trigger on `platform_audit_logs` and `tenant_audit_logs` raises an exception (` Audit logs are immutable`), preventing accidental or malicious tampering even via SQL bugs.

