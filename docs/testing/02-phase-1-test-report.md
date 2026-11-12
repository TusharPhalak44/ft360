# Phase 1 – Test Execution & Verification Evidence Report

**Execution Date:** 2026-11-12  
**Environment:** Windows Workstation (`Node v26.13.0`, `npm 11.5.2`, `Git 2.56.0.windows.4`, `Docker CLI 29.9.2`, `Docker Compose v5.6.1`)  
**Prepared By:** Engineering & QA Team (Mansi, Tushar, Nakshatra)

> **Integrity Statement:** Every result below reflects actual command execution on `2026-11-12`. Tests requiring live Linux containers (`postgres:18-alpine`, `redis:7-alpine`) are explicitly marked **`BLOCKED (NOT EXECUTED)`** due to disabled BIOS/firmware hardware virtualization (`WslVirtualizationDisabledInFirmware`) on the host machine, and Phase 1 remains open until container runtime verification completes.

---

## 1. Summary of Executed Checks

| Check / Suite | Command Executed | Exit Code | Result | Evidence Summary |
|---|---|---|---|---|
| **Zero-ORM & Boundary Scanner** | `npm run check:no-orm` | `0` | **PASSED** | `0` prohibited ORM packages across all `package.json` & `package-lock.json`; `0` frontend DB imports; `0` unauthorized `new Pool()` calls outside `apps/api/src/database/`. |
| **Docker Compose Spec Validation** | `docker compose config --quiet` | `0` | **PASSED** | Validated `postgres:18-alpine`, `redis:7-alpine` (AOF persistent), `api`, and `web` services and `${POSTGRES_HOST_PORT:-5433}:5432` port mapping. |
| **Workspace ESLint** | `npm run lint` | `0` | **PASSED** | `0` errors / `0` warnings across `@ft360/api` (`src/**/*.ts`, `test/**/*.ts`) and `@ft360/web` (`src/**/*.{ts,tsx}`). |
| **Strict TypeScript Typecheck** | `npm run typecheck` | `0` | **PASSED** | `0` compiler errors across `@ft360/shared-types`, `@ft360/api`, and `@ft360/web` (`strict: true`, `noImplicitAny: true`). |
| **Backend Unit & HTTP Pipeline Suite** | `npm run test:unit` | `0` | **PASSED (18/18)** | `2` suites passed, `18` tests passed (`4.637 s`):<br>• `env-and-security-guards.spec.ts` (13 passed): env role-separation check, `UntrustedTenantInputGuard` header/query/nested-body rejection, `TenantTransactionManager` UUID check + `set_config(..., true)` + `RESET` on commit/rollback + SQL `SET SESSION` block, `RedisService.buildTenantKey` isolation, `TenantJobEnvelope` verification, `SqlMigrationRunner` paired `.up.sql`/`.down.sql` discovery & SHA-256 checksums.<br>• `http-pipeline-and-swagger.spec.ts` (5 passed): Supertest verification of `/api/v1/health/live`, `/api/v1/health`, `/api/v1/public/branding`, `/api/docs-json` (OpenAPI 3), CORS, `X-Correlation-Id`, and HTTP `400 UNTRUSTED_TENANT_INPUT_REJECTED`. |
| **Monorepo Production Builds** | `npm run build` | `0` | **PASSED** | Compiled `@ft360/shared-types`, `@ft360/api` (`dist/main.js`), and `@ft360/web` (Next.js `15.5.29` optimized build). |
| **Next.js Frontend Server Boot** | `npm run start --workspace=@ft360/web` + HTTP probe `http://127.0.0.1:3000` | `0` | **PASSED** | Server started cleanly and returned `NEXT_WEB_HTTP_STATUS=200`. |
| **Docker Engine Container Startup (`postgres`, `redis`)** | `docker desktop start` / `docker compose up -d postgres redis` | `1` | **BLOCKED (HOST BIOS)** | Docker Desktop backend reported `noVirtualizationReason: "WslVirtualizationDisabledInFirmware"` (`HCS_E_HYPERV_NOT_INSTALLED`). Host Windows `postgresql-x64-18` (PID `5688` on port `5433`) was intentionally left untouched per instructions. |
| **Live SQL Migration Execution (`up` / `rollback`)** | `npm run db:migrate` | — | **NOT EXECUTED (BLOCKED)** | Awaits Docker PostgreSQL 18 container startup after host BIOS virtualization is enabled. |
| **Real PG18 + Redis Integration & Negative RLS Suite** | `npm run test:integration` (`foundation-stack-and-rls.int-spec.ts`) | — | **NOT EXECUTED (BLOCKED)** | Written and typechecked/linted; awaits live Docker `postgres:18-alpine` + `redis:7-alpine` containers. **Note:** Per Mandatory Security Corrections, tenant isolation is **not** claimed secure until this negative suite executes and passes against live PostgreSQL 18. |
| **Playwright Full-Stack E2E** | `npm run test:e2e` (`foundation-health.spec.ts`) | — | **NOT EXECUTED (BLOCKED)** | Written and typechecked; awaits live PostgreSQL 18 + Redis backing the running NestJS API. |
| **GitHub Actions Cloud Run** | `.github/workflows/ci.yml` | — | **PENDING REMOTE URL** | Workflow configured; push paused per instruction until GitHub repository URL is provided. |

---

## 2. Diagnostic Evidence for Host Docker Blocker

Recorded verbatim from `%LOCALAPPDATA%\Docker\log\host\docker-desktop.exe.log`:

```text
{"docker":"stopped","dockerAPI":"stopped","hasNoVirtualization":true,"mode":"linux",
 "noVirtualizationReason":"WslVirtualizationDisabledInFirmware",
 "stopReason":"WSL2 is unable to start since virtualization is not enabled on this machine.
 Please ensure the \"Virtual Machine Platform\" optional component is enabled and virtualization
 is turned on in your computer's firmware settings.
 Error code: Wsl/Service/RegisterDistro/CreateVm/HCS/HCS_E_HYPERV_NOT_INSTALLED"}
```

### Exact Remediation Steps to Unblock Container Verification
1. Enable **Intel VT-x** or **AMD-V / SVM** in system BIOS/UEFI settings.
2. In Administrator PowerShell, run:
   ```powershell
   wsl.exe --install --no-distribution
   ```
3. Reboot Windows, start Docker Desktop, and run:
   ```powershell
   npm run infra:up
   npm run db:migrate
   npm run test:integration
   ```

