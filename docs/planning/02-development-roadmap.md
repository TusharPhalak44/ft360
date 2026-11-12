# Development Roadmap

**Last Updated:** 2026-11-13  
**Status:** Phase 1 Live Verification Completed – Awaiting Sign-Off & Phase 2 Authorization  
**Version:** 0.1.1

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
| **Phase 1** | **Project Foundation** | Monorepo (`apps/web`, `apps/api`), Docker Compose + Local PG 18/Redis 8 runtime, Git branches & rules, native SQL migration CLI, Jest + Supertest + Playwright harness, GitHub Actions CI + Zero-ORM check | All local CI gates, migrations, RLS/Pool/BullMQ integration (`6/6`), unit/HTTP (`20/20`), and Playwright E2E (`1/1`) verified | **LOCAL VERIFICATION COMPLETE (PENDING TUSHAR SIGN-OFF, GITHUB URL & PHASE 2 APPROVAL)** |
| **Phase 2** | **Database Foundation** | Core SQL migrations (`0001`–`0005`), `ft360_migrator` vs `ft360_app` (`NOBYPASSRLS`) roles, `users`, `tenants`, `tenant_memberships`, composite FKs, RLS policies, `TenantTransactionManager` | Automated RLS catalog check + negative SQL isolation suite passing 100% | 1–1.5 Weeks |
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

