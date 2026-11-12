# Final Technology Stack Specification

**Last Updated:** 2026-11-12  
**Status:** Confirmed Project Standard  
**Version:** 0.1.0

---

## 1. Authoritative Stack Matrix

| Layer | Standard Technology | Planned Version / Package | Notes & Constraints |
|---|---|---|---|
| **Frontend Framework** | Next.js (App Router) | `next` (Latest LTS / 15.x+) | TypeScript strict mode; zero DB logic in Next.js |
| **UI Library** | React | `react`, `react-dom` (19.x) | Accessible enterprise component primitives |
| **Frontend Styling** | Tailwind CSS | `tailwindcss` (v4 / v3.4+) | Driven by CSS custom properties for white-labeling |
| **Form & Schema Validation (UI)** | React Hook Form + Zod | `react-hook-form`, `zod` | Client-side UX validation mirroring API schemas |
| **Backend Framework** | NestJS | `@nestjs/core`, `@nestjs/common` (11.x) | Express or Fastify adapter (standardized in Phase 1) |
| **Programming Language** | TypeScript | `typescript` (5.x, `strict: true`) | `noImplicitAny`, `strictNullChecks` mandatory |
| **Primary Database** | PostgreSQL | PostgreSQL `18.x` | Native `uuidv7()`, RLS, JSONB, partitioning |
| **Database Driver** | Node `pg` | `pg`, `@types/pg` | Official node-postgres driver with `pg.Pool` |
| **ORM Policy** | **NONE** | **Strictly Prohibited** | Prisma, TypeORM, Drizzle, Sequelize, Knex forbidden |
| **SQL Migration Tooling** | Native SQL Migration Runner | Versioned `.sql` files + `schema_migrations` table | Deterministic `UP`/`DOWN` SQL with SHA-256 checksums |
| **Cache & Ephemeral Store** | Redis | Redis `7.x` / `8.x` (`ioredis`) | Tenant-prefixed keys mandatory |
| **Background Queues** | BullMQ | `bullmq`, `@nestjs/bullmq` | Backed by Redis (`maxmemory-policy noeviction` for queue instance/DB) |
| **API Style & Docs** | REST + OpenAPI 3.1 | `@nestjs/swagger` | Versioned under `/api/v1/*` |
| **Authentication** | JWT Access + Opaque Refresh Sessions | `@nestjs/jwt`, `argon2` | Short-lived access token + revocable HttpOnly refresh session |
| **Object Storage** | S3-Compatible Storage | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | MinIO/RustFS locally via Docker; AWS S3 / Cloudflare R2 / DigitalOcean Spaces in cloud |
| **Unit Testing** | Jest | `jest`, `ts-jest` | Backend services, guards, mappers, utilities |
| **Integration & Security Testing** | Supertest + Real PostgreSQL/Redis | `supertest` | Runs against isolated test DB with RLS enabled |
| **Frontend E2E Testing** | Playwright | `@playwright/test` | Multi-role & cross-tenant UI workflows |
| **Containerization** | Docker & Docker Compose | Docker Engine + Compose | Reproducible local dev, CI, and production images |
| **CI/CD & SCM** | Git + GitHub + GitHub Actions | `.github/workflows/*.yml` | Automated lint, typecheck, SQL migration check, unit, integration, and security gates |

---

## 2. Explicit Anti-ORM Enforcement Policy

To uphold architectural rules:
1. **Prohibited Packages:** `prisma`, `@prisma/client`, `typeorm`, `@nestjs/typeorm`, `sequelize`, `sequelize-typescript`, `drizzle-orm`, `mikro-orm`, `objection`, `knex`.
2. **Automated CI Guardrail (Phase 1):** A CI step scans `package.json` and `package-lock.json` across all workspaces and fails the build immediately if any prohibited ORM package is introduced without a signed ADR override from Tushar.
3. **Parameterized Query Discipline:** Raw string interpolation into SQL (`query(\`SELECT ... ${input}\`)`) is banned via ESLint custom rules and code review checklists. Every dynamic value uses positional parameters (`$1`, `$2`, ...).

