# Phase 1 – Live Application Verification & Test Execution Report

**Execution Date:** 2026-11-13  
**Environment:** Windows Workstation (`Node v26.13.0`, `npm 11.5.2`, `PostgreSQL 18.6` isolated local cluster on `127.0.0.1:5434`, `Redis 8.10.3` persistent AOF instance on `127.0.0.1:6379`, `Playwright Chromium v1254`)  
**Prepared By:** Engineering & QA Team (Mansi, Tushar, Nakshatra)

> **Integrity Statement:** Every check and test suite documented below was executed live against the running application (`http://localhost:3000` and `http://localhost:4000`) and real PostgreSQL 18.6 / Redis 8.10.3 instances. No test was mocked where live infrastructure was required, and no unexecuted check is marked passed.

---

## 1. Root-Cause Investigation of Visible Next.js `"1 Issue"` Indicator

| Inspection Target | Finding | Action Taken & Verification |
|---|---|---|
| **Clean Playwright Chromium Load (`http://localhost:3000`)** | `nextjs-portal [data-nextjs-toast]` reported `data-error="false"` (`0` React runtime errors, `0` uncaught exceptions). | Confirmed zero inherent React component errors in clean browser context. |
| **Cause A – Desktop Chrome Extensions Mutating `<html>`/`<body>` Before Hydration** | Reproducing Chrome extension attribute injection (`data-new-gr-c-s-check-loaded`, `cz-shortcut-listen` from Grammarly / ColorZilla visible in desktop Chrome) triggered `data-error="true"` (`"1 Issue"`) with React 19 error: *"A tree hydrated but some attributes of the server rendered HTML didn't match the client properties..."* | Added one-level `suppressHydrationWarning` to root `<html>` and `<body>` in `apps/web/src/app/layout.tsx` (standard Next.js 15 / React 19 pattern that only applies one level deep and never hides child component hydration bugs). Verified via Playwright DOM mutation test: `data-error` remains `"false"`. |
| **Cause B – `GET /favicon.ico` Returning `404 Not Found`** | Browser network log recorded `GET http://localhost:3000/favicon.ico -> 404 Not Found` on initial tab load. | Added white-label dynamic `apps/web/src/app/icon.tsx` (`ImageResponse`) rendering the configured `productName` initial and `primaryColorHex` from `/api/v1/public/branding`. Verified `GET /icon -> 200 OK (image/png)`. |
| **Build Directory Isolation (`next dev` vs `next build`)** | Running `next build` while `next dev` is active on `:3000` overwrites `.next` manifests if shared. | Configured `apps/web/next.config.ts` (`distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next' : '.next-build'`) so production builds never corrupt an active dev server. |

---

## 2. Master Execution Matrix (All 10 Mandatory Test Suites)

| # | Test / Gate | Command Executed | Status | Actual Result | Failure / Remediation History | Verbatim Evidence |
|---|---|---|---|---|---|---|
| 1 | **Zero-ORM Dependency & Boundary Gate** | `npm run check:no-orm` | **EXECUTED** | **PASSED (`Exit 0`)** | None | `0` ORM packages (`prisma`, `typeorm`, `drizzle-orm`, `sequelize`, `knex`, `@mikro-orm/*`, `objection`) in manifests or `package-lock.json`; `0` frontend DB imports; `0` unauthorized `new Pool()` calls. |
| 2 | **Workspace Typecheck** | `npm run typecheck` | **EXECUTED** | **PASSED (`Exit 0`)** | None | `tsc --noEmit` succeeded with `0` errors across `@ft360/shared-types`, `@ft360/api`, and `@ft360/web`. |
| 3 | **ESLint** | `npm run lint` | **EXECUTED** | **PASSED (`Exit 0`)** | None | `0` errors and `0` warnings across `apps/api/{src,test}/**/*.ts` and `apps/web/src/**/*.{ts,tsx}`. |
| 4 | **Unit Tests (`env`, guards, Redis key isolation, Job envelope)** | `npm run test:unit` (`env-and-security-guards.spec.ts`) | **EXECUTED** | **PASSED (`13/13`)** | None | Validated distinct DB role enforcement, `UntrustedTenantInputGuard` (`body`/`query`/`headers`/`params`), `RedisService` `t:{tenantId}:*` enforcement, `assertValidJobEnvelope`, and SQL migration file discovery. |
| 5 | **NestJS HTTP Pipeline & Membership Guard Tests** | `npm run test:unit` (`http-pipeline-and-swagger.spec.ts`) | **EXECUTED** | **PASSED (`7/7`)** | **Initial Failure (`1/7`):** `404 RESOURCE_NOT_FOUND` test generated a fresh UUID instead of echoing `X-Correlation-Id` header because Express router throws `NotFoundException` before `CorrelationIdInterceptor` runs.<br>**Fix Applied:** Updated `GlobalExceptionFilter` (`apps/api/src/common/global-exception.filter.ts`) to fall back to validated `req.headers['x-correlation-id']` when `req.correlationId` is unset. Re-ran suite: **`20/20` unit tests passed (`4.933 s`)**. | Verified `ApiSuccessResponse` & `ApiErrorResponse` envelopes, `X-Correlation-Id` echo/sanitization across `200`/`400`/`401`/`403`/`404`, `UntrustedTenantInputGuard` HTTP `400`, and `TenantMembershipGuard` wrong-membership `403 TENANT_MEMBERSHIP_DENIED` + suspended-tenant `403`. |
| 6 | **Swagger / OpenAPI Supertest & Live Docs Check** | `http-pipeline-and-swagger.spec.ts` + `GET :4000/api/docs` | **EXECUTED** | **PASSED** | None | `/api/docs` returned `200 OK`; `/api/docs-json` returned valid OpenAPI `3.0.0` spec dynamically titled `${productName} API` containing `/api/v1/health`, `/api/v1/health/ready`, `/api/v1/health/live`, and `/api/v1/public/branding`. |
| 7 | **Migration Checksum & Rollback Tests** | `env-and-security-guards.spec.ts` + `foundation-stack-and-rls.int-spec.ts` + `npm run db:migrate:status` | **EXECUTED** | **PASSED** | None | Verified SHA-256 checksums in `schema_migrations` match disk `.up.sql` files (`0001`: `b657babb...f5e9`, `0002`: `53d23257...0171`), and executed live `rollbackLastMigration()` -> `runPendingMigrations()` cycle on PostgreSQL 18.6. |
| 8 | **Database, RLS, Pool & BullMQ Integration Tests** | `npm run test:integration` (`foundation-stack-and-rls.int-spec.ts`) | **EXECUTED** | **PASSED (`6/6` in `4.968 s`)** | None | Verified live PG 18.6 (`127.0.0.1:5434`), `ft360_app` (`rolsuper=false`, `rolbypassrls=false`, `owned_tables=0`, `CREATE TABLE` denied `42501`), 8-way concurrent pool tenant isolation, unscoped/invalid UUID fail-closed (`0` rows / `22P02`), single-connection (`max: 1`) rollback & reuse after rogue `SET`, Redis key isolation, and live BullMQ worker job completion + failure rollback. |
| 9 | **Production Build** | `npm run build` | **EXECUTED** | **PASSED (`Exit 0`)** | None | Built `@ft360/shared-types`, `@ft360/api`, and `@ft360/web` (`Next.js 15.5.29` static `/` `2.57 kB`, dynamic `/icon` `122 B`, `First Load JS 105 kB`). |
| 10 | **End-to-End Browser Tests (Playwright Chromium)** | `npm run test:e2e` (`foundation-health.spec.ts`) | **EXECUTED** | **PASSED (`1/1` in `2.4 s`)** | None | Verified `http://localhost:3000` loads live backend data (`API: HEALTHY`, `Role: ft360_app`, `false / false`, `Connected (PONG)`), `/icon` returns `200 image/png`, `0` console/page/HTTP `>=400` errors, and `data-error !== "true"` even with simulated Chrome extension `<body>` attribute injection. |
| — | **Docker Compose Spec Check & Cloud GitHub Actions** | `docker compose config --quiet` / `.github/workflows/ci.yml` | **CONFIG VALIDATED / CLOUD PENDING** | **YAML VALID (`Exit 0`); CLOUD RUN PENDING** | Host CPU `VirtualizationFirmwareEnabled = False` blocks Docker Linux VM locally; GitHub remote URL not yet supplied per Section 3. | All equivalent CI steps passed locally; cloud workflow will execute upon pushing to GitHub once remote URL is provided. |

---

## 3. PostgreSQL 18, Role Permissions & Migration Checksum Evidence

### 3.1 Host vs. Application PostgreSQL Instance
- **Existing Host Windows Service (`postgresql-x64-18`, PID `5688`):** Listens on `0.0.0.0:5433` (`C:\Program Files\PostgreSQL\18\data`). **Untouched and not used by FunnelTrack360.**
- **Application PostgreSQL Cluster:** Dedicated isolated PostgreSQL `18.6` cluster running in `d:\FT360\.local-infra\postgres-data` bound strictly to **`127.0.0.1:5434`**, managed by `scripts/infra.mjs` (`Docker-first`, automatic local cluster fallback while BIOS `VT-x` is disabled).

### 3.2 Verbatim Catalog Query Output (`ft360_app` Connection)
- **Connection:** `addr = 127.0.0.1/32`, `port = 5434`, `db = ft360_dev`, `current_user = ft360_app`, `server_version = 18.6`
- **Role Flags (`pg_roles`):**
  - `ft360_app`: `rolsuper = false`, `rolbypassrls = false`, `rolcreatedb = false`, `rolcreaterole = false`, `owned_tables = 0` (`CREATE TABLE` rejected with SQLSTATE `42501`)
  - `ft360_migrator`: `rolsuper = false`, `rolbypassrls = false`, `rolcreatedb = false`, `rolcreaterole = false`
- **Explicit Table Grants (`information_schema.role_table_grants` for `ft360_app`):**
  - `schema_migrations`: `SELECT` only (cannot tamper with migration history)
  - `platform_branding_settings`: `INSERT, SELECT, UPDATE` (no `DELETE`)
  - `rls_isolation_canary`: `DELETE, INSERT, SELECT, UPDATE` (governed by `ENABLE` + `FORCE ROW LEVEL SECURITY`)
- **Applied Migrations & Verified SHA-256 Checksums (`schema_migrations`):**
  - `0001` (`0001_foundation_rls_helpers`): `b657babba38778c6a162c607477749b6f9c259f09b78509d1f10c63d3397f5e9` (`applied_by = ft360_migrator`)
  - `0002` (`0002_foundation_branding_and_rls_canary`): `53d2325732b5a67443f249ab92ca3ecc7358abeae6031bdf67127efc4b3e0171` (`applied_by = ft360_migrator`)

---

## 4. Redis 8 & BullMQ Background Job Execution Evidence

- **Redis Connectivity:** Isolated persistent Redis `8.10.3` (`127.0.0.1:6379`, AOF `appendonly yes`) responding `PONG` (`~0.4–3.0 ms` latency).
- **BullMQ Queue & Worker Verification (`FoundationCanaryProcessor` on `system-maintenance` queue):**
  1. **Successful Tenant Job Execution:** Enqueued `foundation.rls-canary` job with `TenantJobEnvelope` for Tenant Alpha -> `QueueEvents.waitUntilFinished` resolved `{ insertedId, tenantId }` -> verified row committed inside `rls_isolation_canary` for Tenant Alpha and invisible (`0` rows) to Tenant Beta.
  2. **Failed Job & Transaction Rollback:** Enqueued `foundation.rls-canary` job with `simulateFailure: true` -> worker inserted canary row inside `TenantTransactionManager.withTenantTransaction()`, threw intentional error, BullMQ marked job failed (`CANARY_SIMULATED_JOB_FAILURE`), and PostgreSQL rolled back the `INSERT` (`0` rows persisted).
  3. **Invalid Envelope Rejection:** Enqueued job with malformed `tenantId: "not-a-uuid"` -> worker rejected immediately with `Invalid or missing tenantId in job envelope`.
- **Tenant-Aware Key Isolation:** Verified `RedisService.setTenantJson(tenantAlpha, ...)` writes strictly under `t:{tenantAlpha}:*` and returns `null` when queried under `tenantBeta`; empty/whitespace `tenantId` throws synchronously.

---

## 5. Security & Multi-Tenant Negative Test Matrix

| Security Scenario | Test Location | Result | Evidence |
|---|---|---|---|
| **Missing Tenant Context (Bypassing `TenantTransactionManager`)** | `foundation-stack-and-rls.int-spec.ts` | **PASSED** | Direct `poolService.getPool().query('SELECT * FROM rls_isolation_canary')` returned `0` rows (fail-closed); direct `INSERT` failed with SQLSTATE `42501` (`new row violates row-level security policy`). |
| **Invalid / Malformed Tenant Context** | `foundation-stack-and-rls.int-spec.ts` | **PASSED** | `TenantTransactionManager` rejected non-UUID `"not-a-uuid'` + `' OR 1=1"` before touching `pg.Pool`; direct SQL `set_config('app.current_tenant_id', 'not-a-valid-uuid', true)` + `SELECT` failed closed (`22P02`). |
| **Cross-Tenant Data Access (`SELECT`/`UPDATE`/`DELETE`/`INSERT`)** | `foundation-stack-and-rls.int-spec.ts` | **PASSED** | Tenant Beta read `0` rows of Tenant Alpha data, updated `0` rows, deleted `0` rows, and cross-tenant `INSERT` with Tenant Alpha `tenant_id` inside Tenant Beta tx threw SQLSTATE `42501`. |
| **Untrusted Frontend Tenant Input (`body`, `query`, `header`, `param`)** | `env-and-security-guards.spec.ts` + `http-pipeline-and-swagger.spec.ts` | **PASSED** | `UntrustedTenantInputGuard` rejected `tenant_id`, `tenantId`, `x-tenant-id`, `organization_id` with `400 UNTRUSTED_TENANT_INPUT_REJECTED`. |
| **Access Through Wrong / Inactive Tenant Membership or Suspended Tenant** | `http-pipeline-and-swagger.spec.ts` (`TenantMembershipGuard`) | **PASSED** | User authenticated in Tenant A attempting access to Tenant B received `403 TENANT_MEMBERSHIP_DENIED`; suspended tenant membership received `403 TENANT_MEMBERSHIP_DENIED`; unauthenticated request received `401 AUTHENTICATION_REQUIRED`. |
| **Transaction Rollback & Pooled Connection Reuse (`max: 1`)** | `foundation-stack-and-rls.int-spec.ts` | **PASSED** | On a `max: 1` `pg.Pool`, verified `COMMIT`, `ROLLBACK` (discarding aborted `INSERT`), and rogue session-level `SET app.current_tenant_id` (`finally { RESET app.current_tenant_id }`) all left `0` leaked tenant rows on subsequent connection checkout. |
