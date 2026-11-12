# Phase 1 – Test Execution & Verification Evidence Report

**Execution Date:** 2026-11-13  
**Environment:** Windows Workstation (`Node v26.13.0`, `npm 11.5.2`, `PostgreSQL 18.6` isolated cluster on `:5434`, `Redis 8.10.3` persistent AOF instance on `:6379`, `Playwright Chromium v1254`)  
**Prepared By:** Engineering & QA Team (Mansi, Tushar, Nakshatra)

> **Integrity Statement:** Every result below was executed live on `2026-11-12` / `2026-11-13`. Because BIOS virtualization (`VT-x`) is disabled on this host, `scripts/infra.mjs` automatically provisioned an isolated user-space PostgreSQL 18.6 cluster (`.local-infra/postgres-data` on `:5434`, leaving the host's Windows PostgreSQL service on `:5433` untouched) and an isolated persistent Redis 8.10.3 server (`.local-infra/redis-data` on `:6379`) while preserving Docker Compose as primary whenever Docker Engine is active.

---

## 1. Summary of Executed Verification Gates

| Check / Suite | Command Executed | Exit Code | Actual Result | Verbatim Evidence |
|---|---|---|---|---|
| **Zero-ORM & Boundary Scanner** | `npm run check:no-orm` | `0` | **PASSED** | `0` ORM packages in workspace or `package-lock.json`; `0` frontend DB imports; `0` unauthorized `new Pool()` calls. |
| **Docker Compose Spec Validation** | `docker compose config --quiet` | `0` | **PASSED** | Compose YAML validated cleanly (`postgres:18-alpine`, `redis:7-alpine`, `api`, `web`). |
| **Workspace ESLint** | `npm run lint` | `0` | **PASSED** | `0` errors / `0` warnings across `@ft360/api` and `@ft360/web`. |
| **Strict TypeScript Typecheck** | `npm run typecheck` | `0` | **PASSED** | `0` compiler errors across `@ft360/shared-types`, `@ft360/api`, and `@ft360/web`. |
| **SQL Migrations (`up` -> `rollback` -> `up`)** | `npm run db:migrate` & `db:migrate:status` | `0` | **PASSED** | Applied `0001_foundation_rls_helpers` (`2026-11-12T19:42:20.971Z`) and `0002_foundation_branding_and_rls_canary` (`2026-11-12T19:42:20.980Z`); rollback + re-apply verified inside integration suite. |
| **Unit + HTTP Supertest Suite** | `npm run test:unit` | `0` | **PASSED (`18/18`)** | `2` suites passed, `18` tests passed (`5.985 s`). |
| **Real PG18 + Redis Integration & Negative RLS Suite** | `npm run test:integration` | `0` | **PASSED (`6/6`)** | `foundation-stack-and-rls.int-spec.ts` (`6.025 s`):<br>• Verified `ft360_app` has `rolsuper=false`, `rolbypassrls=false`, non-owner, and `FORCE ROW LEVEL SECURITY` active (`6 ms`)<br>• Verified Tenant Alpha vs Tenant Beta `SELECT`/`UPDATE`/`DELETE`/`INSERT` (`42501`) isolation (`13 ms`)<br>• Verified fail-closed behavior when bypassing `TenantTransactionManager` or passing malformed SQL UUID (`33 ms`)<br>• Verified zero context leakage across `COMMIT`, `ROLLBACK`, and rogue session `SET` on a single-connection (`max: 1`) pool (`160 ms`)<br>• Verified Redis `t:{tenantId}:*` cross-tenant cache isolation (`4 ms`)<br>• Verified `/api/v1/health`, `/api/v1/public/branding`, `/api/docs-json`, and `400 UNTRUSTED_TENANT_INPUT_REJECTED` (`73 ms`) |
| **Live Readiness Endpoint** | `GET http://localhost:4000/api/v1/health` | `200` | **PASSED** | `status: "healthy"`, `serverVersion: "18.6"`, `currentRole: "ft360_app"`, `bypassRls: false`, `isSuperuser: false`, `appliedMigrations: 2`, `redis.connected: true` (`0.38 ms`). |
| **Playwright Full-Stack Browser E2E** | `npm run test:e2e` | `0` | **PASSED (`1/1`)** | `[chromium] foundation-health.spec.ts` (`1.6s`) — verified live `API: HEALTHY`, `ft360_app`, `false / false` RLS posture, and `Connected (PONG)` in headless Chrome against `http://localhost:3000`. |
| **Production Builds** | `npm run build` | `0` | **PASSED** | Compiled `@ft360/shared-types`, `@ft360/api`, and `@ft360/web` (Next.js `15.5.29`). |
| **GitHub Actions Cloud Execution** | `.github/workflows/ci.yml` | — | **PENDING REMOTE URL** | Workflow configured and all local equivalent steps passed; remote push paused per Section 3 until GitHub repository URL is provided. |

---

## 2. Scope Note on Tenant Isolation Verification

- **Verified in Phase 1:** Foundation `TenantTransactionManager`, `ft360_app` least-privilege role (`NOBYPASSRLS`, non-owner), `FORCE ROW LEVEL SECURITY` on `rls_isolation_canary`, fail-closed unscoped/malformed context queries, single-connection pool reuse after commit/rollback/rogue `SET`, HTTP untrusted tenant parameter rejection, and `t:{tenantId}:*` Redis cache isolation.
- **Scheduled for Phases 2–6:** Full negative cross-tenant testing across core domain tables (`tenants`, `tenant_memberships`, `roles`, `audit_logs`), background job workers, file storage, exports, and reports before claiming platform-wide tenant isolation complete.
