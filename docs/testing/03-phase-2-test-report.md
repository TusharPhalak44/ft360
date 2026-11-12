# Phase 2 – Database Foundation & Mandatory Negative RLS Test Report

**Execution Date:** 2026-11-13  
**Branch:** `feature/phase-2-database-foundation` -> [PR #1](https://github.com/TusharPhalak44/ft360/pull/1) into `development`  
**Environment:** Local (`PostgreSQL 18.6` on `127.0.0.1:5434`, `Redis 8.10.3` on `127.0.0.1:6379`, `Node v26.13.0`) + GitHub Actions Cloud CI (`ubuntu-latest`, Docker `postgres:18-alpine` + `redis:7-alpine`, Run `#43309962474`)  
**Prepared By:** Mansi (Security & QA), Tushar (Architecture & DB), Nakshatra (Full-Stack Repositories)

> **Integrity Statement:** Every test and SQL migration verification below was executed against live PostgreSQL 18 (`ft360_migrator` for DDL and `ft360_app` with `NOBYPASSRLS` for runtime queries). Zero ORMs exist in the repository.

---

## 1. Master Verification Gate Summary

| # | Verification Gate | Command Executed | Status | Actual Result | Verbatim Evidence |
|---|---|---|---|---|---|
| 1 | **Zero-ORM & Boundary Check** | `npm run check:no-orm` | **EXECUTED** | **PASSED (`Exit 0`)** | `0` ORM packages; `0` frontend DB imports; `0` raw `new Pool()` calls in `apps/api/src/**` outside approved pool/migration services. |
| 2 | **Workspace ESLint** | `npm run lint` | **EXECUTED** | **PASSED (`Exit 0`)** | `0` errors / `0` warnings across API & Web. |
| 3 | **Strict TypeScript Typecheck** | `npm run typecheck` | **EXECUTED** | **PASSED (`Exit 0`)** | `0` compiler errors across `@ft360/shared-types`, `@ft360/api`, and `@ft360/web`. |
| 4 | **Clean-Database Migration + Full Rollback & Reapplication** | `npm run db:migrate` / `db:migrate:rollback` + `phase2-database-foundation-rls.int-spec.ts` | **EXECUTED** | **PASSED** | Rolled back `0004 -> 0003 -> 0002 -> 0001` leaving `0` domain tables (`schema_migrations` only), applied `0001..0004` from clean DB, rolled back `0004 -> 0003`, and re-applied `0003 -> 0004`. |
| 5 | **Unit Test Suite** | `npm run test:unit` | **EXECUTED** | **PASSED (`32/32` in `7.123 s`)** | `3/3` suites passed (`env-and-security-guards`, `http-pipeline-and-swagger`, `phase2-repositories-and-verifier` incl. broken-socket `client.release(true)` & Super Admin DB verification). |
| 6 | **PostgreSQL 18 Integration & Negative RLS Suite** | `npm run test:integration` | **EXECUTED** | **PASSED (`12/12` in `8.202 s`)** | `2/2` suites passed (`foundation-stack-and-rls.int-spec.ts` `6/6` + `phase2-database-foundation-rls.int-spec.ts` `6/6` incl. column-level `password_hash` denial, system-role protection, `INVITED` isolation, and 2-char slugs). |
| 7 | **Production Builds** | `npm run build` | **EXECUTED** | **PASSED (`Exit 0`)** | Compiled `@ft360/shared-types`, `@ft360/api`, and `@ft360/web` (`Next.js 15.5.29`). |
| 8 | **Playwright Chromium E2E** | `npm run test:e2e` | **EXECUTED** | **PASSED (`1/1` in `3.7 s`)** | Preserved 100% of Phase 1 live telemetry (`API: HEALTHY`, `Role: ft360_app`, `false / false`, `Applied SQL Migrations: 4`, `0` browser/console/HTTP errors). |
| 9 | **GitHub Actions Cloud CI (`pull_request`)** | `.github/workflows/ci.yml` (Run `#43309962474` on PR `#1`) | **EXECUTED** | **PASSED (`completed / success`)** | All 14 cloud steps passed on `postgres:18-alpine` + `redis:7-alpine`: Zero-ORM gate, `ft360_migrator` & `ft360_app` provisioning, ESLint, Typecheck, SQL Migrations (`up -> rollback -> up`), Unit (`30/30`), Integration & Negative RLS (`12/12`), Build, and Playwright Chromium E2E (`1/1`). |

---

## 2. Migration Checksums & Least-Privilege Role Verification

### 2.1 Applied SQL Migrations (`schema_migrations`)
| Version | Migration Name | SHA-256 Checksum (`up.sql`) | Applied By |
|---|---|---|---|
| `0001` | `0001_foundation_rls_helpers` | `b657babba38778c6a162c607477749b6f9c259f09b78509d1f10c63d3397f5e9` | `ft360_migrator` |
| `0002` | `0002_foundation_branding_and_rls_canary` | `53d2325732b5a67443f249ab92ca3ecc7358abeae6031bdf67127efc4b3e0171` | `ft360_migrator` |
| `0003` | `0003_users_tenants_and_memberships` | `67a87a19fc8b6057b468ee411bd276aa30361d868662fb1447eefb3a45d17f9a` | `ft360_migrator` |
| `0004` | `0004_rbac_roles_permissions_and_assignments` | `de566ec957599a2eea88bd5e7df3b90e774c804b3c1393b0aa181dc01753bf7f` | `ft360_migrator` |

### 2.2 Database Role & `FORCE RLS` Catalog Verification
- `ft360_app`: `rolsuper = false`, `rolbypassrls = false`, `rolcreatedb = false`, `rolcreaterole = false`, `rolinherit = false`, `owned_tables = 0`.
- **100% RLS Catalog Completeness:** All 9 application tables (`permissions`, `platform_branding_settings`, `rls_isolation_canary`, `role_permissions`, `roles`, `tenant_memberships`, `tenants`, `user_role_assignments`, `users`) are owned by `ft360_migrator` and have `relrowsecurity = true` and `relforcerowsecurity = true`.
- **Table Grants (`ft360_app`):**
  - `schema_migrations`: `SELECT` only
  - `users`: Column-level `SELECT` **omitting `password_hash`** (`id, email, full_name, phone_e164, status, is_platform_super_admin, email_verified, last_login_at, created_at, updated_at`), `INSERT`, `UPDATE` (no `DELETE`)
  - `tenants`, `permissions`, `platform_branding_settings`: `SELECT, INSERT, UPDATE` (no `DELETE`)
  - `tenant_memberships`, `roles`, `role_permissions`, `user_role_assignments`, `rls_isolation_canary`: `SELECT, INSERT, UPDATE, DELETE` (governed by `FORCE RLS` + `trigger_protect_system_roles` on `roles`)

---

## 3. Mandatory 10-Scenario Negative Security & Isolation Evidence

Executed live in `apps/api/test/integration/phase2-database-foundation-rls.int-spec.ts`:

| # | Mandatory Negative Test | Actual Result | SQL / HTTP Verification Evidence |
|---|---|---|---|
| 1 | **Tenant A cannot read Tenant B records** | **PASSED** | Inside verified Tenant Alpha transaction, `SELECT` on `tenants`, `users` (Beta-only users), `tenant_memberships` (including shared user's Beta membership), `roles`, `role_permissions`, and `user_role_assignments` returned **`0` Tenant Beta rows**. |
| 2 | **Tenant A cannot update Tenant B records** | **PASSED** | `UPDATE` targeting Tenant Beta `tenants`, `users` (Beta-only & shared multi-org users), `tenant_memberships`, and `roles` affected **`0` rows** (`rowCount = 0`). |
| 3 | **Tenant A cannot delete Tenant B records** | **PASSED** | `DELETE` targeting Tenant Beta `tenant_memberships`, `roles`, `role_permissions`, and `user_role_assignments` affected **`0` rows** (`rowCount = 0`). |
| 4 | **Tenant A cannot insert records referencing Tenant B ( + Global Platform Protection)** | **PASSED** | `INSERT` with `tenant_id = Tenant_Beta` into `tenant_memberships`, `roles`, `role_permissions`, and `user_role_assignments` rejected with SQLSTATE **`42501`**. Tenant writes to global `permissions` or `tenants`, self-escalation to `is_platform_super_admin`, self-changing `tenants.status`, and granting `PLATFORM`-scoped permissions to tenant roles all rejected with **`42501`**. |
| 5 | **Missing tenant context is rejected** | **PASSED** | Unscoped `SELECT` via `ft360_app` across all 7 Phase 2 tables returned **`0` rows**; unscoped `INSERT` into `roles` rejected with **`42501`**; empty `tenantId` in `withVerifiedMemberTransaction` threw `InvalidTenantContextError`. |
| 6 | **Invalid tenant context is rejected** | **PASSED** | SQLi string `' OR '1'='1` threw `InvalidTenantContextError` before acquiring a connection; raw SQL `set_config('app.current_tenant_id', 'invalid-uuid-value', true)` failed closed with **`0` rows** across all 7 tables. |
| 7 | **Unauthorized membership is rejected** | **PASSED** | Tested in both `TenantMembershipGuard` (HTTP) and `withVerifiedMemberTransaction` (DB): Tenant Alpha user targeting Tenant Beta -> `403 TENANT_MEMBERSHIP_DENIED` / `UnauthorizedTenantMembershipError`; `PENDING` user / `SUSPENDED` membership -> `403 USER_ACCOUNT_INACTIVE`; `ACTIVE` member in `SUSPENDED` tenant -> `403 TENANT_SUSPENDED_OR_INACTIVE`. |
| 8 | **Cross-tenant composite foreign key violations are rejected** | **PASSED** | Even when bypassing RLS via `ft360_migrator`, PostgreSQL rejected cross-tenant references with SQLSTATE **`23503`** on `fk_role_permissions_tenant_role`, `fk_ura_tenant_membership`, `fk_ura_tenant_role`, and `fk_ura_assigned_by_membership`. Also verified `ON DELETE SET NULL (assigned_by_membership_id)` preserved `tenant_id`. |
| 9 | **Rollback clears transaction-scoped tenant context** | **PASSED** | Inserting `rolled_back_role` inside Tenant Alpha transaction followed by thrown exception rolled back the insert (`0` rows persisted) and unwound `set_config(..., true)`. |
| 10 | **Reused connections cannot expose previous tenant context** | **PASSED** | On a `max: 1` `pg.Pool` (same `pg_backend_pid()` verified), consecutive Tenant Alpha `COMMIT`, Tenant Alpha `ROLLBACK`, rogue session `SET`, Tenant Beta `COMMIT`, and subsequent unscoped checkout returned `tid = null`, `uid = null`, `super_flag = false`, and **`0` rows** across `tenants`, `tenant_memberships`, and `roles`. |

