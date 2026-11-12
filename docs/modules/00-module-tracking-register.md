# Permanent Module Development & QA Tracking Register

**Last Updated:** 2026-11-12  
**Document Version:** 0.1.0  
**Maintained By:** Tushar (Product & Architecture), Nakshatra (Full-Stack), Mansi (Security & QA)

> **Governance Rule:** Never mark any test or status column as passed/approved without actual execution evidence linked under *Test Report References*. Every module progresses strictly through the 19-stage Status Lifecycle below.

---

## 1. Authorized Status Lifecycle

`BACKLOG` → `REQUIREMENT` → `DESIGN` → `READY FOR DEVELOPMENT` → `IN DEVELOPMENT` → `CODE REVIEW` → `UNIT TESTING` → `INTEGRATION TESTING` → `SYSTEM TESTING` → `SECURITY TESTING` → `QA TESTING` → `REWORK` *(if defects found)* → `QA APPROVED` → `UAT APPROVED` → `STAGING VERIFIED` → `READY FOR RELEASE` → `PRODUCTION` → `MONITORING` → `COMPLETED`

---

## 2. Master Summary Matrix (All 32 Roadmap Modules)

| ID | Module Name | Wave / Phase | Lead Dev | Dev Status | DB | API | UI | Unit | Integ | Sec | QA | UAT | Defects | Updated | Ver |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **M01** | Platform Super Admin | Phase 3–8 | Tushar | `DESIGN` | `DESIGN` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M02** | Tenant Registration & Mgmt | Phase 4 | Tushar | `DESIGN` | `DESIGN` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M03** | Authentication & User Mgmt | Phase 3 | Mansi | `DESIGN` | `DESIGN` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M04** | Organization Management | Phase 4–8 | Nakshatra | `DESIGN` | `DESIGN` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M05** | Roles & Permissions | Phase 5 | Mansi | `DESIGN` | `DESIGN` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M06** | Subscription & Billing | Phase 7 | Tushar | `DESIGN` | `DESIGN` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M07** | CRM | Wave 1 | Nakshatra | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M08** | Leads & Contacts | Wave 1 | Nakshatra | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M09** | Accounts & Companies | Wave 1 | Tushar | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M10** | Campaign Management | Wave 2 | Nakshatra | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M11** | Pipeline & Opportunity Mgmt | Wave 1 | Mansi | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M12** | Marketing Management | Wave 2 | Nakshatra | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M13** | Email Marketing & Blasting | Wave 2 | Tushar | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M14** | Master Contact DB / DBMS | Wave 2 | Tushar | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M15** | Data Research & Enrichment | Wave 2 | Mansi | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M16** | Operations Management | Wave 3 | Nakshatra | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M17** | Lead Allocation & Distribution | Wave 3 | Tushar | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M18** | Dialer & VoIP Integration | Wave 3 | Tushar | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M19** | Call Recording & CDR | Wave 3 | Mansi | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M20** | QA & Quality Management | Wave 3 | Mansi | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M21** | AI Transcript Processing | Wave 4 | Tushar | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M22** | Client Portal | Wave 4 | Nakshatra | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M23** | HRIS & Employee Management | Wave 4 | Nakshatra | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M24** | Attendance & Performance Mgmt | Wave 4 | Mansi | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M25** | Finance & Revenue Management | Wave 4 | Tushar | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M26** | Calendar & Meeting Booking | Wave 2 | Nakshatra | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M27** | Notifications & Workflow Auto | Phase 8 / Wave 2 | Nakshatra | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M28** | Analytics & Reporting | Wave 5 | Tushar | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M29** | Jarvis AI Assistant | Wave 5 | Tushar | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M30** | Integrations | Wave 5 | Nakshatra | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M31** | Audit & Compliance | Phase 6 / Wave 5 | Mansi | `DESIGN` | `DESIGN` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |
| **M32** | Enterprise Administration | Wave 5 | Mansi | `BACKLOG` | `NOT STARTED` | `NOT STARTED` | `NOT STARTED` | `NOT RUN` | `NOT RUN` | `NOT RUN` | `PENDING` | `PENDING` | 0 | 2026-11-12 | 0.1.0 |

---

## 3. Detailed Permanent Module Records (M01 – M32)

> Every record below maintains all 21 mandatory tracking attributes specified in the Master Instructions. Foundation modules (`M01`–`M06`, `M31`) are currently in `DESIGN` awaiting Phase 0 sign-off; Wave 1–5 business modules are registered in `BACKLOG` awaiting individual phase planning.

### M01 – Platform Super Admin
- **Module ID:** `M01`
- **Module Name:** Platform Super Admin
- **Description:** Global SaaS control plane for managing tenant organizations, global product identity/white-labeling, platform staff roles, system health, and platform-wide audit logs.
- **Requirements:** Global branding CRUD (`platform_branding_settings`), tenant directory & lifecycle controls, platform metrics, controlled break-glass support audit trail.
- **Assigned Developer:** Tushar (Support: Nakshatra UI, Mansi QA)
- **Development Status:** `DESIGN`
- **Database Status:** `DESIGN` (`platform_branding_settings`, `platform_audit_logs`)
- **API Status:** `NOT STARTED`
- **Frontend Status:** `NOT STARTED`
- **Unit Test Status:** `NOT RUN`
- **Integration Test Status:** `NOT RUN`
- **Security Test Status:** `NOT RUN`
- **QA Status:** `PENDING`
- **UAT Status:** `PENDING`
- **Outstanding Defects:** None (`0`)
- **Pending Tasks:** Phase 0 approval -> SQL migration `0002` -> `/api/v1/platform/*` endpoints -> Super Admin Console UI.
- **GitHub Issue / PR References:** Pending repo initialization in Phase 1
- **Test Report References:** [02-phase-1-test-report.md](file:///d:/FT360/docs/testing/02-phase-1-test-report.md) (Phase 1 Foundation branding/health HTTP & unit checks passed; live PG18/Redis integration pending host BIOS virtualization)
- **Approval Details:** Phase 0 Approved by Tushar on `2026-11-12`; Phase 1 Foundation in review
- **Last Updated Date:** `2026-11-12`
- **Version Number:** `0.1.1`

### M02 – Tenant Registration and Management
- **Module ID:** `M02`
- **Module Name:** Tenant Registration and Management
- **Description:** Self-service and admin-driven tenant provisioning, onboarding workflows, status transitions (`PROVISIONING`, `TRIAL`, `ACTIVE`, `SUSPENDED`, `CANCELLED`), and immediate suspension enforcement.
- **Requirements:** Atomic tenant + owner membership + default roles provisioning transaction, slug validation, suspension kill-switch across API/Redis/Workers.
- **Assigned Developer:** Tushar (Support: Nakshatra Onboarding UI, Mansi Security Tests)
- **Development Status:** `DESIGN`
- **Database Status:** `DESIGN` (`tenants`, `tenant_invitations`)
- **API Status:** `NOT STARTED`
- **Frontend Status:** `NOT STARTED`
- **Unit Test Status:** `NOT RUN`
- **Integration Test Status:** `NOT RUN`
- **Security Test Status:** `NOT RUN`
- **QA Status:** `PENDING`
- **UAT Status:** `PENDING`
- **Outstanding Defects:** None (`0`)
- **Pending Tasks:** Phase 0 approval -> SQL migration `0003` -> Provisioning service -> Onboarding UI.
- **GitHub Issue / PR References:** Pending Phase 1
- **Test Report References:** None
- **Approval Details:** Pending Phase 0 Sign-off by Tushar
- **Last Updated Date:** `2026-11-12`
- **Version Number:** `0.1.0`

### M03 – Authentication and User Management
- **Module ID:** `M03`
- **Module Name:** Authentication and User Management
- **Description:** Global user identity decoupled from single tenants, Argon2id credentials, short-lived JWT access tokens + rotating opaque refresh tokens, password reset, and verified multi-tenant workspace switching.
- **Requirements:** Login/logout/refresh with reuse detection, multi-org membership discovery, `switch-tenant` token exchange, account lockout/throttling, user profile management.
- **Assigned Developer:** Mansi (Support: Tushar DB/Token Arch, Nakshatra Auth UI)
- **Development Status:** `DESIGN`
- **Database Status:** `DESIGN` (`users`, `auth_sessions`, `password_reset_tokens`, `tenant_memberships`)
- **API Status:** `NOT STARTED`
- **Frontend Status:** `NOT STARTED`
- **Unit Test Status:** `NOT RUN`
- **Integration Test Status:** `NOT RUN`
- **Security Test Status:** `NOT RUN`
- **QA Status:** `PENDING`
- **UAT Status:** `PENDING`
- **Outstanding Defects:** None (`0`)
- **Pending Tasks:** Phase 0 approval -> Auth SQL schema -> NestJS Guards -> Auth & Workspace Switcher UI.
- **GitHub Issue / PR References:** Pending Phase 1
- **Test Report References:** None
- **Approval Details:** Pending Phase 0 Sign-off by Tushar
- **Last Updated Date:** `2026-11-12`
- **Version Number:** `0.1.0`

### M04 – Organization Management
- **Module ID:** `M04`
- **Module Name:** Organization Management
- **Description:** Tenant-level organization profile, security & locale settings, per-tenant white-label branding (`tenant_branding_settings`), member directory, invitations, departments/teams.
- **Requirements:** Tenant settings CRUD, white-label theme/logo configuration, member invite/suspend/revoke workflows, multi-tenant user membership coexistence.
- **Assigned Developer:** Nakshatra (Support: Tushar APIs, Mansi RLS QA)
- **Development Status:** `DESIGN`
- **Database Status:** `DESIGN` (`tenant_settings`, `tenant_branding_settings`)
- **API Status:** `NOT STARTED`
- **Frontend Status:** `NOT STARTED`
- **Unit Test Status:** `NOT RUN`
- **Integration Test Status:** `NOT RUN`
- **Security Test Status:** `NOT RUN`
- **QA Status:** `PENDING`
- **UAT Status:** `PENDING`
- **Outstanding Defects:** None (`0`)
- **Pending Tasks:** Phase 0 approval -> Tenant Settings & Branding APIs -> Tenant Admin Settings UI.
- **GitHub Issue / PR References:** Pending Phase 1
- **Test Report References:** None
- **Approval Details:** Pending Phase 0 Sign-off by Tushar
- **Last Updated Date:** `2026-11-12`
- **Version Number:** `0.1.0`

### M05 – Roles and Permissions
- **Module ID:** `M05`
- **Module Name:** Roles and Permissions
- **Description:** Tenant-scoped RBAC engine combining canonical permissions (`module:resource:action`) with custom tenant roles and record-level visibility scopes (`OWN`, `TEAM`, `TENANT`).
- **Requirements:** Seeded system roles per tenant, custom role CRUD, `user_role_assignments` bound via composite FK to `tenant_memberships`, Redis-cached permission resolution with instant invalidation.
- **Assigned Developer:** Mansi (Support: Nakshatra Role Matrix UI, Tushar Scope Arch)
- **Development Status:** `DESIGN`
- **Database Status:** `DESIGN` (`permissions`, `roles`, `role_permissions`, `user_role_assignments`)
- **API Status:** `NOT STARTED`
- **Frontend Status:** `NOT STARTED`
- **Unit Test Status:** `NOT RUN`
- **Integration Test Status:** `NOT RUN`
- **Security Test Status:** `NOT RUN`
- **QA Status:** `PENDING`
- **UAT Status:** `PENDING`
- **Outstanding Defects:** None (`0`)
- **Pending Tasks:** Phase 0 approval -> SQL migration `0004` -> `PermissionsGuard` -> RBAC Matrix UI & negative tests.
- **GitHub Issue / PR References:** Pending Phase 1
- **Test Report References:** None
- **Approval Details:** Pending Phase 0 Sign-off by Tushar
- **Last Updated Date:** `2026-11-12`
- **Version Number:** `0.1.0`

### M06 – Subscription and Billing
- **Module ID:** `M06`
- **Module Name:** Subscription and Billing
- **Description:** SaaS plan catalog, tenant subscription lifecycle, module entitlements, usage quotas (seats, storage, emails, DBMS records), and payment gateway webhook integration.
- **Requirements:** Plan management (Super Admin), tenant subscription mapping, `@RequireEntitlement()` guard, atomic usage counters, signed billing webhooks.
- **Assigned Developer:** Tushar (Support: Nakshatra Billing UI, Mansi Quota QA)
- **Development Status:** `DESIGN`
- **Database Status:** `DESIGN` (`subscription_plans`, `tenant_subscriptions`, `tenant_usage_counters`)
- **API Status:** `NOT STARTED`
- **Frontend Status:** `NOT STARTED`
- **Unit Test Status:** `NOT RUN`
- **Integration Test Status:** `NOT RUN`
- **Security Test Status:** `NOT RUN`
- **QA Status:** `PENDING`
- **UAT Status:** `PENDING`
- **Outstanding Defects:** None (`0`)
- **Pending Tasks:** Complete Phases 1–6 -> Implement Phase 7 Subscription Foundation.
- **GitHub Issue / PR References:** Pending Phase 1
- **Test Report References:** None
- **Approval Details:** Pending Phase 0 Sign-off by Tushar
- **Last Updated Date:** `2026-11-12`
- **Version Number:** `0.1.0`

### M07 through M30, and M32 – Roadmap Business & Enterprise Modules
*(Standardized baseline record applied individually to **M07, M08, M09, M10, M11, M12, M13, M14, M15, M16, M17, M18, M19, M20, M21, M22, M23, M24, M25, M26, M27, M28, M29, M30, M32** as summarized in Section 2 above; expanded into dedicated `/docs/modules/M<ID>-<slug>.md` specification files as each wave enters Step 1 `REQUIREMENT`)*:
- **Development / DB / API / Frontend Status:** `BACKLOG` / `NOT STARTED`
- **Unit / Integration / Security / QA / UAT Status:** `NOT RUN` / `PENDING`
- **Outstanding Defects:** `0`
- **Pending Tasks:** Blocked on Phase 0–9 Foundation completion and explicit per-wave Requirement & Technical Planning sign-off by Tushar (see [01-module-dependency-matrix.md](file:///d:/FT360/docs/planning/01-module-dependency-matrix.md)).
- **GitHub Issue / PR References:** None
- **Test Report References:** None
- **Approval Details:** Roadmap registered in Phase 0 (`2026-11-12`, `v0.1.0`).

### M31 – Audit and Compliance
- **Module ID:** `M31`
- **Module Name:** Audit and Compliance
- **Description:** Immutable, append-only platform and tenant audit trails (`platform_audit_logs`, `tenant_audit_logs`), correlation tracing, data retention policies, and compliance export tooling.
- **Requirements:** Phase 6 Core: append-only PostgreSQL triggers, automatic mutation/security event capture, RLS-isolated audit log viewer. Wave 5 Advanced: cold S3 archival, GDPR/DPDP subject export & retention automation.
- **Assigned Developer:** Mansi (Support: Tushar Partitioning/Arch, Nakshatra Audit Viewer UI)
- **Development Status:** `DESIGN` (Core Foundation scope)
- **Database Status:** `DESIGN` (`platform_audit_logs`, `tenant_audit_logs` + immutability triggers)
- **API Status:** `NOT STARTED`
- **Frontend Status:** `NOT STARTED`
- **Unit Test Status:** `NOT RUN`
- **Integration Test Status:** `NOT RUN`
- **Security Test Status:** `NOT RUN`
- **QA Status:** `PENDING`
- **UAT Status:** `PENDING`
- **Outstanding Defects:** None (`0`)
- **Pending Tasks:** Phase 2 audit tables & triggers -> Phase 6 audit interceptor & viewer API.
- **GitHub Issue / PR References:** Pending Phase 1
- **Test Report References:** None
- **Approval Details:** Pending Phase 0 Sign-off by Tushar
- **Last Updated Date:** `2026-11-12`
- **Version Number:** `0.1.0`

