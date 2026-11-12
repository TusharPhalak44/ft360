# Testing, Security Verification & Quality Assurance Strategy

**Last Updated:** 2026-11-12  
**Status:** Mandatory QA Standard  
**QA Lead:** Mansi  
**Version:** 0.1.0

---

## 1. Zero-Fabrication Verification Policy

1. **Evidence Mandate:** No test status (`Unit`, `Integration`, `Security`, `QA`, `UAT`) may ever be marked `PASSED` or `APPROVED` without verifiable execution artifacts (CI run URL, Jest/Supertest JSON/JUnit output, Playwright trace/report, and dated test execution logs in `/docs/testing/reports/`).
2. **Definition of Done:** Code completion represents step 6 of 18 in the mandatory lifecycle. A module is incomplete until unit, integration, negative cross-tenant security, functional QA, regression, UAT, staging verification, and release approval gates are recorded.

---

## 2. Multi-Layer Test Pyramid

| Test Layer | Tooling | Execution Environment | Minimum Coverage / Gate Requirement |
|---|---|---|---|
| **Static & Policy Checks** | TypeScript (`tsc --noEmit`), ESLint, Zero-ORM Scanner, SQL Checksum Check | Every PR (GitHub Actions) | `0` errors; `0` ORM dependencies; `0` un-parameterized SQL string interpolations |
| **Unit Testing** | **Jest** (`ts-jest`) | Isolated in-memory mocks for pure domain logic | >= 85% branch coverage on guards, services, token validators, permission evaluators, and DTO mappers |
| **Database & RLS Testing** | **Jest + Real PostgreSQL 18** (`ft360_app` role) | Ephemeral test DB spun up via Docker in CI | 100% of `tenant_id` tables verified for `ENABLE` + `FORCE ROW LEVEL SECURITY` and composite FK constraints |
| **API & Integration Testing** | **Supertest + NestJS TestingModule + Real PG 18 & Redis** | Full HTTP pipeline including Guards, Pipes, Interceptors, SQL, and Redis | Happy paths, validation failures (`400`), unauthenticated (`401`), unauthorized RBAC (`403`), and cross-tenant isolation (`404`/`403`) for every endpoint |
| **Negative Security Testing** | **Dedicated Security Suite (Supertest + Custom Fuzz/Tamper Helpers)** | Seeded Multi-Tenant Fixture (`Tenant Alpha`, `Tenant Beta`, `Suspended Tenant`, `Portal User`) | Mandatory 10-vector cross-tenant attack checklist (Section 3 below) |
| **Frontend & E2E Testing** | **Playwright** | Real Next.js + NestJS + PostgreSQL + Redis stack | Login, tenant switching, role-based menu gating, white-label branding render, form error states, critical persona flows |

---

## 3. Mandatory 10-Vector Cross-Tenant Security Test Matrix

Before **any** module passes `SECURITY TESTING`, automated Supertest + Playwright assertions must prove that an authenticated user in **Tenant Alpha** (even with `Tenant Admin` privileges in Alpha) **cannot**:

1. **Body/Query Spoofing:** Inject `"tenant_id": "<tenant_beta_uuid>"` in `POST`/`PATCH` payloads or `?tenantId=` query params to create or view records in Tenant Beta.
2. **Direct ID Enumeration (IDOR):** Call `GET / PATCH / DELETE /api/v1/workspace/<resource>/<tenant_beta_record_uuid>` (must return `404` with zero side effects and zero metadata leakage).
3. **Relational Link Injection:** Reference a `role_id`, `membership_id`, `account_id`, or `campaign_id` belonging to Tenant Beta when creating a record in Tenant Alpha (blocked by both service checks and composite foreign keys).
4. **Unverified Tenant Switch:** Request `POST /api/v1/auth/switch-tenant` for Tenant Beta without an `ACTIVE` `tenant_memberships` record.
5. **Revoked Membership Replay:** Continue using a valid non-expired Access JWT after their `tenant_memberships.status` is changed to `SUSPENDED` or `REVOKED` (blocked immediately via `TenantContextGuard`).
6. **Suspended Tenant Access:** Execute API calls or background jobs when `tenants.status = 'SUSPENDED'`.
7. **Cache Key Bleed:** Retrieve cached lookups, permissions, or dashboards belonging to Tenant Beta via Redis key collision.
8. **Object Storage Traversal:** Generate download URLs or upload files referencing `tenants/<tenant_beta_uuid>/...` S3 keys.
9. **Search & Export Bleed:** Trigger full-text search, analytics aggregations, or CSV exports that include any row from Tenant Beta.
10. **Connection Pool Contamination:** Run 100+ concurrent interleaved requests across Tenant Alpha and Tenant Beta (including deliberate mid-transaction SQL errors) and verify `0` cross-tenant row leaks.

---

## 4. Defect Classification & Release Blocking Rules

Tracked permanently in `/docs/testing/defect-register.md` (initialized in Phase 1):

| Severity | Definition | Release Gate Rule |
|---|---|---|
| **S1 – Critical** | Cross-tenant data exposure, auth bypass, SQL injection, data corruption, system crash | **Immediate Hard Block** — halts merge & deployment across all environments |
| **S2 – High** | Broken core workflow, RBAC privilege mismatch, broken migration rollback, missing audit log | **Hard Block** — module cannot enter `QA APPROVED` until fixed & regression-tested |
| **S3 – Medium** | Non-critical UI edge case, minor filter defect with workaround | Must have documented triage & scheduled fix sprint approved by Tushar |
| **S4 – Low** | Cosmetic alignment, copy tweak | Tracked in backlog |

