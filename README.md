# Multi-Tenant Enterprise CRM & Business Management Platform

> **Configurable Product Codename:** `FunnelTrack360` *(resolved dynamically via Platform & Tenant Branding Settings — never hardcoded in UI or API business logic).*

## 1. Architecture & Non-Negotiable Standards

- **Architecture:** Modular Monolith (`npm workspaces`)
- **Frontend (`@ft360/web`):** Next.js (App Router), React, TypeScript, Tailwind CSS
- **Backend (`@ft360/api`):** NestJS, TypeScript, Swagger/OpenAPI (`/api/docs`)
- **Database:** PostgreSQL 18 via native `pg` driver + parameterized SQL + version-controlled `.sql` migrations
- **ORM Policy:** **Strictly Prohibited** (`npm run check:no-orm` blocks Prisma, TypeORM, Drizzle, Sequelize, Knex, MikroORM, Objection)
- **Multi-Tenant Isolation:** Transaction-scoped `set_config('app.current_tenant_id', $1, true)` via `TenantTransactionManager` + `FORCE ROW LEVEL SECURITY` + non-owner runtime DB role (`ft360_app` with `NOBYPASSRLS`)
- **Cache & Queues:** Redis + BullMQ with mandatory `t:{tenantId}:*` cache key isolation and verified job envelopes
- **Testing:** Jest (Unit), Supertest + Real PostgreSQL 18 & Redis (Integration & Negative RLS Security), Playwright (E2E)

---

## 2. Quickstart (All Developers: Tushar, Nakshatra, Mansi)

### Prerequisites
- **Node.js** `>= 22.x` & **npm** `>= 10.x`
- **Docker Desktop** (running Linux containers)
- **Git** `>= 2.40`

### Step-by-Step Initialization

```bash
# 1. Copy environment template (never commit .env)
cp .env.example .env
# Note: Default Docker PostgreSQL host port is 5433 (-> container 5432).
# If your local Windows PostgreSQL service already listens on 5433, set POSTGRES_HOST_PORT=5434
# and update the port in DATABASE_MIGRATOR_URL & DATABASE_APP_URL inside .env.

# 2. Start PostgreSQL 18 and Redis containers
npm run infra:up

# 3. Install monorepo dependencies & verify Zero-ORM policy
npm install
npm run check:no-orm

# 4. Build shared contracts & apply version-controlled SQL migrations
npm run build --workspace=@ft360/shared-types
npm run db:migrate
npm run db:migrate:status

# 5. Start both Backend (:4000, Swagger :4000/api/docs) and Frontend (:3000) together
npm run dev

# Or run them in separate terminals if preferred:
# npm run dev:api
# npm run dev:web
```

---

## 3. Running Quality & Security Verification Suites

```bash
npm run check:no-orm       # Enforce Zero-ORM & pg.Pool / frontend boundary rules
npm run lint               # ESLint across workspaces
npm run typecheck          # Strict TypeScript compiler checks
npm run test:unit          # Jest unit tests
npm run test:integration   # Supertest + Real PostgreSQL 18 RLS & Pool-Reuse negative tests
npm run test:e2e           # Playwright Frontend <-> Backend E2E verification
```

---

## 4. Git Branching & Collaboration Workflow

- **`main`:** Protected production release branch (tagged `vX.Y.Z`).
- **`development`:** Active integration branch for verified features.
- **Working Branches:**
  - `feature/M<id>-<short-slug>` (e.g., `feature/M03-session-rotation`)
  - `bugfix/M<id>-<short-slug>`
  - `hotfix/<short-slug>`
- Every merge requires a Pull Request, peer code review, green GitHub Actions CI, and updated documentation in [/docs/README.md](file:///d:/FT360/docs/README.md).

