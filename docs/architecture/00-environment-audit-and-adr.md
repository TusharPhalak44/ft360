# Phase 0 – Environment Audit & Architectural Decision Records (ADRs)

**Last Updated:** 2026-11-12  
**Status:** Draft – Pending Review & Approval by Tushar (Product Owner & Lead Architect)  
**Version:** 0.1.0

---

## 1. Workspace & Environment Audit

An inspection of the active workspace (`d:\FT360`) and host workstation (Windows) was conducted on **2026-11-12** prior to creating any application code.

### 1.1 Repository Inspection
| Check | Observation | Action Planned for Phase 1 |
|---|---|---|
| Workspace Directory (`d:\FT360`) | Clean directory; no pre-existing source code or configuration files | Initialize monorepo directory layout (`apps/web`, `apps/api`, `db/migrations`, `packages/shared`, `docs/`) |
| Git Repository | Not yet initialized (`fatal: not a git repository`) | Run `git init`, configure `.gitignore`, establish `main` and `development` branches, connect to GitHub remote |
| Existing ORM Packages | None present | Enforce CI lint/dependency check blocking `prisma`, `@prisma/client`, `typeorm`, `sequelize`, `drizzle-orm`, `knex`, `mikro-orm` |

### 1.2 Host Toolchain Audit
| Tool | Installed Version | Status & Phase 1 Readiness Notes |
|---|---|---|
| OS / Shell | Windows / PowerShell | Ready |
| Git | `2.56.0.windows.4` | Ready |
| GitHub CLI (`gh`) | Not installed | Optional; install in Phase 1 if CLI PR workflows are desired |
| Node.js | `v26.13.0` | Installed (Note: verify package compatibility or pin LTS `v22.x`/`v24.x` via `.nvmrc` / Docker in Phase 1 so all 3 developers run identical runtimes) |
| npm | `11.5.2` | Ready (`npm workspaces` available out-of-the-box; `corepack`/`pnpm` optional) |
| Docker CLI | `29.9.2` (build `a82e528`) | Installed; **Docker Desktop Linux Engine daemon was not running** during audit — must be started before Phase 1 container spin-up |
| Docker Compose | `v5.6.1` | Ready |
| PostgreSQL (Host) | `PostgreSQL 18.6` (`postgresql-x64-18` service **Running** as PID `5688`) | Installed at `C:\Program Files\PostgreSQL\18\bin`. Active TCP socket audit (`Get-NetTCPConnection`) confirmed host `postgres.exe` occupies port **`5433`** on this workstation. `docker-compose.yml` defaults to `5433:5432` per spec via `${POSTGRES_HOST_PORT:-5433}:5432`, while local git-ignored `.env` uses `5434` on this machine so the existing Windows PostgreSQL service is never touched or disrupted. |
| Redis (Host) | No native Windows service | Will run via Docker Compose (`redis:7-alpine` / `8-alpine`) in Phase 1 |

---

## 2. Stack Suitability Confirmation

| Stack Component | Suitability Assessment | Rationale |
|---|---|---|
| **Next.js + React + TypeScript + Tailwind CSS** | **Confirmed Suitable** | App Router supports clean separation of role-specific layouts (Super Admin, Tenant Dashboards, Client Portal), strict TypeScript contracts, and dynamic CSS variable theming for per-tenant and global white-label branding. |
| **NestJS (TypeScript)** | **Confirmed Suitable** | Modular dependency injection, Guards, Interceptors, Pipes, and Swagger decorators map directly to a 32-module enterprise Modular Monolith with centralized authentication, RBAC, and tenant context enforcement. |
| **PostgreSQL 18** | **Confirmed Suitable** | Native Row-Level Security (RLS), `FORCE ROW LEVEL SECURITY`, transactional `set_config()`, JSONB for extensible custom CRM fields, partitioning support for high-volume call/audit logs, and native `uuidv7()` for time-sortable UUID primary keys without index fragmentation. |
| **Native `pg` Driver (No ORM)** | **Confirmed Suitable** | Eliminates ORM query generation opacity, connection-pool session leakage pitfalls, N+1 hidden queries, and migration drift. Gives full control over CTEs, `set_config` RLS transactions, bulk contact imports (`COPY` / `UNNEST`), and complex analytical queries. |
| **Redis + BullMQ** | **Confirmed Suitable** | Provides low-latency tenant-namespaced caching, sliding-window rate limiting, session revocation lists, and durable background job queues for email blasting, lead allocation, CDR ingestion, and AI transcript processing. |

**Zero-ORM Confirmation:** No ORM is required, installed, or permitted. All data access will flow through parameterized SQL executed via `pg.Pool` / `pg.PoolClient` inside dedicated repository classes.

---

## 3. Architectural Decision Records (ADRs)

### ADR-001: Modular Monolith over Early Microservices
- **Context:** A 3-developer team is building a 32-module multi-tenant SaaS platform with strict security and QA gates.
- **Decision:** Build as a **Modular Monolith** (`apps/api` in NestJS with strict module boundaries; `apps/web` in Next.js) backed by a single PostgreSQL cluster and Redis instance.
- **Consequences:** Minimal operational overhead, atomic cross-module database transactions where needed, unified CI/CD, and straightforward extraction of heavy workers (e.g., AI Transcript Processing, Email Blasting) into separate NestJS worker processes later using BullMQ queues.

### ADR-002: Native SQL (`pg`) with Repository Pattern & Zero ORM
- **Context:** Enterprise CRM, DBMS, lead routing, andPostgreSQL RLS require deterministic SQL execution and transaction-scoped session settings.
- **Decision:** Ban all ORMs (Prisma, TypeORM, Drizzle, Sequelize). Standardize on `pg` + parameterized SQL templates + explicit TypeScript row mappers + Zod/class-validator DTO validation.
- **Consequences:** Full SQL transparency, predictable query plans, clean RLS transaction wrapping, and zero ORM abstraction leaks. Requires disciplined repository test coverage (enforced in Phase 2 & 6).

### ADR-003: Defense-in-Depth Multi-Tenancy (Application Guard + PostgreSQL RLS)
- **Context:** A single bug in a SQL `WHERE` clause must never expose another tenant's leads, calls, HR, or finance records.
- **Decision:** Enforce tenant isolation at **two independent layers**:
  1. **Application Layer:** `TenantContextGuard` verifies JWT/session identity and active `tenant_memberships` status; repositories still include explicit `tenant_id` predicates for clarity and index targeting.
  2. **Database Layer:** Every tenant-owned table enables `ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`. Every tenant DB operation runs through `TenantDatabaseService.withTenantTransaction(tenantId, fn)` executing `SELECT set_config('app.current_tenant_id', $1, true)` inside a `BEGIN ... COMMIT` block under a non-superuser role (`ft360_app` with `NOBYPASSRLS`).
- **Consequences:** Even if a developer omits `WHERE tenant_id = $1`, PostgreSQL RLS blocks cross-tenant reads and writes automatically, while `set_config(..., true)` guarantees transaction-local scoping that resets automatically when the transaction ends—preventing connection-pool leakage.

### ADR-004: Multi-Organization User Identity Model
- **Context:** Consultants, agency operators, and enterprise group executives often belong to multiple organizations.
- **Decision:** Decouple `users` (global identity) from `tenants` (organizations) via `tenant_memberships`. Roles and permissions are scoped per `(tenant_id, membership_id)` via `user_role_assignments`. Active tenant context is selected at login or switched via a verified token/session exchange endpoint (`POST /api/v1/auth/switch-tenant`).
- **Consequences:** Users authenticate once and seamlessly switch organizations without duplicate accounts, while audit logs accurately track `(user_id, active_tenant_id)`.

### ADR-005: Configurable White-Label Product Identity
- **Context:** `FunnelTrack360` is a temporary product name; both global platform branding and per-tenant white-labeling must remain configurable.
- **Decision:** Store default fallback values only in environment config (`DEFAULT_PRODUCT_NAME`), override globally via `platform_branding_settings` (managed by Platform Super Admin), and allow tenant-level overrides via `tenant_branding_settings` (managed by Tenant Admin subject to subscription entitlements). Frontend consumes branding via a public bootstrap endpoint and CSS custom properties (`--brand-primary`, etc.).
- **Consequences:** Zero hardcoded brand strings, logos, support emails, or colors in React components, email templates, or PDF exports.

### ADR-006: PostgreSQL 18 Baseline & `uuidv7()` Primary Keys
- **Context:** Random `uuidv4` primary keys cause B-tree page splits and write amplification on large tables (leads, contacts, call logs, audit events), while sequential integers leak record counts and complicate multi-system imports.
- **Decision:** Standardize on **PostgreSQL 18** across Docker, CI, Staging, and Production, using native `uuidv7()` defaults for primary keys.
- **Consequences:** Globally unique, non-guessable IDs with monotonic time-ordered B-tree locality and high insert throughput.

