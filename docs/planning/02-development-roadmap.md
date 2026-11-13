# Development Roadmap

**Last Updated:** 2026-11-13  
**Status:** Phase 2 COMPLETED (`PR #1` Approved by `NakshtraSulakhe`, Merged into `development` @ `8746ba5`, Post-Merge Cloud CI `#43435582940` Green) — Phase 3 Awaiting Explicit Authorization  
**Version:** 0.2.1

---

## 1. Execution Philosophy

1. **Foundation First (Phases 0–9):** Complete multi-tenancy, native `pg` + RLS isolation, authentication, RBAC, branding, billing foundation, application shell, and negative cross-tenant security verification **before** writing business modules.
2. **Gate-Driven Progression:** Every phase requires code review, automated test execution evidence, updated `/docs/`, and explicit sign-off from Tushar before advancing.
3. **Wave-Based Business Delivery (Post-Phase 9):** The remaining business modules execute in logical domain waves aligned with the Module Dependency Matrix, each following the mandatory 18-step lifecycle.

---

## 2. Foundation Roadmap (Phases 0 – 9)

| Phase | Name | Key Deliverables | Exit Gate / Verification Criteria | Est. Duration (3 Devs) |
|---|---|---|---|---|
| **Phase 0** | **Project Audit & Architecture** | Environment inspection, stack confirmation, ADRs, multi-tenant & RLS design, ER diagrams, 32-module matrix, roadmap, QA strategy, cost/risk report | Approved by Tushar on `2026-11-12` | **APPROVED & COMPLETED** |
| **Phase 1** | **Project Foundation** | Monorepo (`apps/web`, `apps/api`), Docker Compose + Local PG 18/Redis 8 runtime, Git branches & rules, native SQL migration CLI, Jest + Supertest + Playwright harness, GitHub Actions CI + Zero-ORM check | All local & GitHub Cloud CI gates (`#43302143641` & `#43302143632`), migrations, RLS/Pool/BullMQ (`6/6`), unit/HTTP (`20/20`), Playwright E2E (`1/1`), & `main` branch protection verified | **APPROVED, PUSHED & CLOUD CI GREEN (`2026-11-13`)** |
| **Phase 2** | **Database Foundation** | Core SQL migrations (`0003`–`0004`), `ft360_migrator` vs `ft360_app` (`NOBYPASSRLS`), `users`, `tenants`, `tenant_memberships`, `permissions`, `roles`, `role_permissions`, `user_role_assignments`, composite FKs, `FORCE RLS`, `PostgresTenantMembershipVerifier` | Clean-DB migration + rollback + 10-scenario negative RLS/FK/pool suite (`12/12` int, `32/32` unit, `1/1` E2E), Independent Approval (`NakshtraSulakhe`, Review `#5891968735`), PR `#1` merged @ `8746ba5`, & Post-Merge Cloud CI Run `#43435582940` green | **COMPLETED (`2026-11-13`)** |
| **Phase 3** | **Platform Identity (M01, M03)** | Argon2id auth, JWT + rotating refresh sessions, password recovery, multi-tenant session switcher, global & tenant branding config endpoints, Platform Super Admin bootstrap | Unit + Supertest auth security suite (token replay, brute-force rate limit, branding load) | 1.5 Weeks |
| **Phase 4** | **Tenant Management (M02, M04)** | Tenant registration, onboarding wizard, member invitations, activation/suspension kill-switch, `tenant_settings`, `tenant_branding_settings` | Suspended tenant access blocked within <1s across API & cache tests | 1.5 Weeks |
| **Phase 5** | **Roles & Permissions (M05)** | Canonical permission catalog, seeded default tenant roles, custom role CRUD, `user_role_assignments`, `@RequirePermissions()` guard + data-scope helpers (`OWN`/`TEAM`/`TENANT`) | Full RBAC matrix integration tests across roles & multi-org memberships | 1.5 Weeks |
| **Phase 6** | **Foundation Security & QA (M31 Core)** | Append-only `platform_audit_logs` & `tenant_audit_logs`, systematic cross-tenant penetration tests (API, DB, Redis, S3, BullMQ), defect remediation | Zero High/Critical defects; signed Security Test Report by Mansi & Tushar | 1–1.5 Weeks |
| **Phase 7** | **Subscription Foundation (M06)** | `subscription_plans`, `tenant_subscriptions`, `tenant_usage_counters`, feature/module entitlement guard, seat-limit enforcement, billing webhook skeleton | Quota & module-gate integration tests passing | 1 Week |
| **Phase 8** | **Application Shell** | White-label theming engine, Super Admin console shell, Tenant Workspace shell, role-based sidebar navigation for all 9 persona areas, reusable table/form/state components | Playwright E2E role-navigation, tenant-switching, and responsive UI tests passing | 2 Weeks |
| **Phase 9** | **Foundation Release** | End-to-end regression suite, Staging deployment & backup restore drill, UAT execution, Release Approval | Signed UAT & Release Approval by Tushar | 1 Week |

*Estimated Foundation Total (Phases 1–9): ~11–12.5 Weeks with disciplined testing and documentation.*

---

## 3. Post-Foundation Business Module Waves (Planned & Approved Individually)

| Wave | Focus Area | Modules Included | Prerequisite |
|---|---|---|---|
| **Wave 1** | **Core CRM & Sales Pipeline** | M09 (Accounts & Companies), M08 (Leads & Contacts), M07 (CRM Workspace), M11 (Pipeline & Opportunities) | Phase 9 Release |
| **Wave 2** | **Master DBMS, Campaigns & Outbound Marketing** | M14 (Master Contact DB / DBMS), M15 (Data Research & Enrichment), M10 (Campaign Mgmt), M12 (Marketing Mgmt), M13 (Email Marketing & Blasting), M26 (Calendar & Booking), M27 (Workflow Automation) | Wave 1 Sign-off |
| **Wave 3** | **Operations, Lead Routing, Telephony & QA** | M16 (Operations Mgmt), M17 (Lead Allocation & Dist), M18 (Dialer & VoIP), M19 (Call Recording & CDR), M20 (QA & Quality Mgmt) | Wave 2 Sign-off |
| **Wave 4** | **AI Speech, Client Portal, HRIS & Finance** | M21 (AI Transcript Processing), M22 (Client Portal), M23 (HRIS & Employee Mgmt), M24 (Attendance & Performance), M25 (Finance & Revenue Mgmt) | Wave 3 Sign-off |
| **Wave 5** | **BI Analytics, Jarvis AI & Enterprise Scale** | M28 (Cross-Platform Analytics & Reporting), M29 (Jarvis AI Assistant), M30 (Integrations Hub), M31 (Advanced Compliance/Exports), M32 (Enterprise Admin: SSO/SCIM/Custom Domains) | Wave 4 Sign-off |

