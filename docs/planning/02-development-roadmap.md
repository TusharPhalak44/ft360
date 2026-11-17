# Development Roadmap

**Last Updated:** 2026-11-17  
**Status:** Phases 0–3 CLOSED & COMPLETED (`main` @ `d416187`) · Stage 4A Merged (`PR #6` @ `42d4de2`) · **Stage 4B Database Prerequisite (`0009`) Verified (`52/52` Unit, `42/42` Int/Sec) & In PR Review (`Stage 4B App/UI` & `Stages 4C–4E` Not Started)**  
**Version:** 0.4.1

---

## 1. Execution Philosophy

1. **Foundation First (Phases 0–9):** Complete multi-tenancy, native `pg` + RLS isolation, authentication, tenant management, RBAC, branding, billing foundation, application shell, and negative cross-tenant security verification **before** writing business modules.
2. **Gate-Driven Progression:** Every phase and vertical stage requires independent code review, automated test execution evidence, updated `/docs/`, and post-merge CI verification before advancing.
3. **Wave-Based Business Delivery (Post-Phase 9):** The remaining business modules execute in logical domain waves aligned with the Module Dependency Matrix, each following the mandatory 19-step lifecycle.

---

## 2. Foundation Roadmap (Phases 0 – 9)

| Phase | Name | Key Deliverables | Exit Gate / Verification Criteria | Status |
|---|---|---|---|---|
| **Phase 0** | **Project Audit & Architecture** | Environment inspection, stack confirmation, ADRs, multi-tenant & RLS design, ER diagrams, 32-module matrix, roadmap, QA strategy, cost/risk report | Approved by Tushar on `2026-11-12` | **APPROVED & COMPLETED** |
| **Phase 1** | **Project Foundation** | Monorepo (`apps/web`, `apps/api`), Docker Compose + Local PG 18/Redis 8 runtime, Git branches & rules, native SQL migration CLI, Jest + Supertest + Playwright harness, GitHub Actions CI + Zero-ORM check | Local & GitHub Cloud CI gates (`#43302143641`), migrations, RLS/Pool/BullMQ (`6/6`), unit/HTTP (`20/20`), Playwright E2E (`1/1`), & branch protection verified | **CLOSED & COMPLETED (`2026-11-13`)** |
| **Phase 2** | **Database Foundation** | Core SQL migrations (`0003`–`0004`), `ft360_migrator` vs `ft360_app` (`NOBYPASSRLS`), `users`, `tenants`, `tenant_memberships`, `permissions`, `roles`, `role_permissions`, `user_role_assignments`, composite FKs, `FORCE RLS`, `PostgresTenantMembershipVerifier` | PR `#1` approved & merged @ `8746ba5`; Post-Merge Cloud CI Runs `#43435582940` + `#43437622771` green | **CLOSED & COMPLETED (`2026-11-13`)** |
| **Phase 3** | **Platform Identity & Auth (M01, M03, M31 Auth)** | Registration, email verification, Argon2id, login/logout, rotating opaque refresh sessions + multi-generation replay detection (`0006`), durable AES-256-GCM mail outbox + SMTP/Webhook adapters, org selection, CSRF/rate-limit/plane guards, `auth_audit_logs`, Next.js auth UI | PR `#3` (`627b3fe`) & release PR `#4` (`d416187`) independently reviewed, merged into `development` & `main`, and post-merge Cloud CI green | **CLOSED & COMPLETED (`2026-11-14`)** |
| **Phase 4** | **Tenant Management (M02, M04, M31 Tenant Audit)** | **5-Stage Delivery (`D6`):**<br>• **Planning (`PR #5`):** Merged @ `4caf3d9`<br>• **Stage 4A:** Migrations `0007`–`0008` (`22` `FORCE RLS` tables, `24` permissions, serialized last-admin lock, `OD-P1`, email uniqueness, initiator/recipient split, 4-layer PG/Redis-outage validation) + `TenantAuditModule` (`#29`)<br>• **Stages 4B–4E:** Registration/Onboarding/Settings (`4B`), Branding/`sharp`/S3 (`4C`), Invitations/Members/Admins (`4D`), Platform Lifecycle & E2E (`4E`) | **Stage 4A:** `52/52` unit, `37/37` PG18+Redis int/concurrency/RLS, `2/2` E2E passed (`IN PR REVIEW` on `feature/phase-4a-database-audit`).<br>**Stages 4B–4E:** `NOT STARTED`. | **STAGE 4A IN PR REVIEW (`Stages 4B–4E` Not Started)** |
| **Phase 5** | **Roles & Permissions (M05)** | Custom role CRUD, permission assignment matrix, Redis permission cache invalidation, data-scope helpers (`OWN`/`TEAM`/`TENANT`) | Full RBAC matrix integration tests across roles & multi-org memberships | Planned (1.5 Weeks) |
| **Phase 6** | **Foundation Security & QA (M31 Core)** | Append-only `platform_audit_logs`, systematic cross-tenant penetration tests (API, DB, Redis, S3, BullMQ), defect remediation | Zero High/Critical defects; signed Security Test Report | Planned (1–1.5 Weeks) |
| **Phase 7** | **Subscription Foundation (M06)** | `subscription_plans`, `tenant_subscriptions`, `tenant_usage_counters`, feature/module entitlement guard, seat-limit enforcement, billing webhook skeleton | Quota & module-gate integration tests passing | Planned (1 Week) |
| **Phase 8** | **Application Shell** | White-label theming engine, Super Admin console shell, Tenant Workspace shell, role-based sidebar navigation, reusable table/form/state components | Playwright E2E role-navigation, tenant-switching, and responsive UI tests passing | Planned (2 Weeks) |
| **Phase 9** | **Foundation Release** | End-to-end regression suite, Staging deployment & backup restore drill, UAT execution, Release Approval | Signed UAT & Release Approval by Tushar | Planned (1 Week) |

---

## 3. Post-Foundation Business Module Waves (Planned & Approved Individually)

| Wave | Focus Area | Modules Included | Prerequisite |
|---|---|---|---|
| **Wave 1** | **Core CRM & Sales Pipeline** | M09 (Accounts & Companies), M08 (Leads & Contacts), M07 (CRM Workspace), M11 (Pipeline & Opportunities) | Phase 9 Release |
| **Wave 2** | **Master DBMS, Campaigns & Outbound Marketing** | M14 (Master Contact DB / DBMS), M15 (Data Research & Enrichment), M10 (Campaign Mgmt), M12 (Marketing Mgmt), M13 (Email Marketing & Blasting), M26 (Calendar & Booking), M27 (Workflow Automation) | Wave 1 Sign-off |
| **Wave 3** | **Operations, Lead Routing, Telephony & QA** | M16 (Operations Mgmt), M17 (Lead Allocation & Dist), M18 (Dialer & VoIP), M19 (Call Recording & CDR), M20 (QA & Quality Mgmt) | Wave 2 Sign-off |
| **Wave 4** | **AI Speech, Client Portal, HRIS & Finance** | M21 (AI Transcript Processing), M22 (Client Portal), M23 (HRIS & Employee Mgmt), M24 (Attendance & Performance), M25 (Finance & Revenue Mgmt) | Wave 3 Sign-off |
| **Wave 5** | **BI Analytics, Jarvis AI & Enterprise Scale** | M28 (Cross-Platform Analytics & Reporting), M29 (Jarvis AI Assistant), M30 (Integrations Hub), M31 (Advanced Compliance/Exports), M32 (Enterprise Admin: SSO/SCIM/Custom Domains) | Wave 4 Sign-off |
