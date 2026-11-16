# FunnelTrack360 — Phase 4 Comprehensive Testing & QA Strategy

**Phase:** Phase 4 — Tenant Onboarding & Management  
**Scope Alignment:** **`35` REST API Endpoints** (`#1`–`#35`) · **`14` Frontend Route-Views** (`RV-01`–`RV-14`) · **`22` `FORCE RLS` Public Tables** · **`24` Canonical Permissions**  
**Test Frameworks:** Jest (`Unit` & `Supertest API + PostgreSQL 18 + Redis Integration`) + Playwright (`Real Chromium E2E`)  
**Execution Status:** **`STAGE 4A EXECUTED & PASSED · STAGES 4B–4E PLANNED — NOT EXECUTED`** *(Strict Governance Rule: Only Stage 4A test cases executed live against PostgreSQL 18 + Redis + Chromium are marked `PASSED (Stage 4A)`; every Stage 4B–4E test case remains `PLANNED — NOT EXECUTED`).*  
**Last Updated:** 2026-11-16

---

## 1. Testing Pyramid & Coverage Architecture

| Layer | Runner & Infrastructure | Coverage Scope | Status |
|---|---|---|---|
| **1. Unit Tests (`UT-P4-01` – `UT-P4-08`)** | Jest (`apps/api/test/unit/phase4*.spec.ts`) | Stage 4A: `UT-P4-05`, `UT-P4-07`, `UT-P4-08` (`52/52` total unit tests passing). Stages 4B–4E: `UT-P4-01..04`, `UT-P4-06`. | `UT-P4-05, 07, 08 PASSED (Stage 4A)` · `Others PLANNED — NOT EXECUTED` |
| **2. Database, Concurrency & RLS Integration (`DB-P4-01` – `DB-P4-07`, `RLS-P4-01` – `RLS-P4-06`)** | Jest + native `pg` (`ft360_migrator` + `ft360_app` on live PostgreSQL 18) | Migrations `0007`–`0008` forward/rollback/re-apply, all `22` public tables `FORCE RLS` & `ft360_migrator` ownership, composite FKs (`23503`), serialized `FOR UPDATE` last-admin lock (`42501`), duplicate global email `uq_users_email` / `uq_users_email_normalized` (`23505`) concurrency, initiator vs. recipient `chk_auth_email_outbox_anchor` & `chk_ti_initiator_recipient_distinct`, PostgreSQL write-RLS lifecycle check `fn_is_current_tenant_operational()`, `token_hash` column omission (`42501`), `SECURITY DEFINER` GUC checks | **`ALL PASSED (Stage 4A — 100%)`** |
| **3. API, RBAC, Invitation, Lifecycle & Security Integration (`IT-P4-01` – `IT-P4-06`, `RBAC-P4-01` – `RBAC-P4-04`, `INV-P4-01` – `INV-P4-07`, `LIFE-P4-01` – `LIFE-P4-05`, `SEC-P4-01` – `SEC-P4-20`)** | Jest + Supertest + PostgreSQL 18 + Redis 7/8 + BullMQ | Stage 4A: Endpoint `#29` (`IT-P4-06` workspace audit) + DB/Redis-outage/audit security (`SEC-P4-08`, `SEC-P4-13`, `SEC-P4-16`, `SEC-P4-17`). Stages 4B–4E: Endpoints `#1`–`#28`, `#30`–`#35`. | `Stage 4A Subset PASSED` · `Stages 4B–4E PLANNED — NOT EXECUTED` |
| **4. Frontend Route-View & Component Tests (`UI-P4-01` – `UI-P4-04`)** | Component / Rendering assertions + `next build` / `tsc --noEmit` | All `14` route-views (`RV-01`–`RV-14`: `11` new + `3` updated in Stages 4B–4E) | `PLANNED — NOT EXECUTED` |
| **5. Playwright End-to-End Browser Journeys (`E2E-P4-01` – `E2E-P4-04`)** | Playwright Chromium (`apps/web/tests/e2e/phase4-*.spec.ts`) | Multi-actor browser journeys scheduled in Stage 4E (`2/2` existing Phase 1 & Phase 3 E2E regression tests passing in Stage 4A) | `PLANNED — NOT EXECUTED (Stage 4E)` |
| **6. Phase 1–3 Full Regression Gate** | `npm run check:no-orm && npm run lint && npm run typecheck && npm test && npm run test:e2e` | Preserves all existing Phase 1–3 unit, DB/RLS, auth remediation, and Playwright suites without weakening any prior invariant | **`PASSED (Stage 4A)`** |

---

## 2. Detailed Test Specifications

### 2.1 Unit Test Suite (`UT-P4-01` – `UT-P4-08`)
- **`UT-P4-01` (Slug Syntax & Reserved Denylist — `PLANNED — NOT EXECUTED`):** Scheduled for Stage 4B.
- **`UT-P4-02` (Exhaustive 6-State Lifecycle Matrix & `OD-P1` Cancellation Rule — `PLANNED — NOT EXECUTED`):** HTTP/service unit matrix scheduled for Stage 4E *(PostgreSQL routine `fn_platform_transition_tenant_status` & `trigger_protect_tenant_lifecycle` already verified in `phase4a-database-integrity-and-audit.int-spec.ts`)*.
- **`UT-P4-03` (`sharp` Raster Image Decoding, Pixel-Bomb & Metadata Stripping — `PLANNED — NOT EXECUTED`):** Scheduled for Stage 4C.
- **`UT-P4-04` (Settings & Profile DTO Validators — `PLANNED — NOT EXECUTED`):** Scheduled for Stage 4B.
- **`UT-P4-05` (Audit Diff Calculation & Recursive Secret Redaction — `PASSED (Stage 4A)`):** Verified in `phase4a-tenant-audit-and-guards.spec.ts` (`computeFieldDiff(before, after)` emits only changed keys; `TenantAuditService` rejects nested forbidden secret keys across objects and arrays).
- **`UT-P4-06` (Tenant Storage Key Isolation — `PLANNED — NOT EXECUTED`):** Scheduled for Stage 4C.
- **`UT-P4-07` (`TenantPermissionGuard` & `TenantAdminGuard` Evaluation — `PASSED (Stage 4A)`):** Verified in `phase4a-tenant-audit-and-guards.spec.ts` across Phase 4 canonical permissions (`audit:tenant:read`, `tenant:settings:manage`, `tenant:members:manage`, `tenant:invitations:manage`, `tenant:roles:assign`, `tenant:admins:manage`) and strict `tid !== null` workspace enforcement.
- **`UT-P4-08` (Redis Outage Fallback Wrapper — `PASSED (Stage 4A)`):** Verified in `phase4a-tenant-audit-and-guards.spec.ts` that `RedisSessionCacheService` (`isSessionTombstoned`, `tombstoneSessions`, `cacheActiveSession`, `getCachedSession`, `evictSessionCache`) catches Redis errors, logs `[REDIS_UNAVAILABLE_FALLBACK_PG]`, and delegates cleanly to PostgreSQL; also verified `TENANT_INVITATION` outbox URL scrubbing (`redactMailLogText`).

### 2.2 Database, Concurrency & RLS Integration Suite (`DB-P4-01` – `DB-P4-07`, `RLS-P4-01` – `RLS-P4-06`)
- **`DB-P4-01` (Migration `0007`–`0008` Forward, Rollback & Re-Apply — `PASSED (Stage 4A)`):** Executed in `phase3-auth-workflows.int-spec.ts` (`IT-P3-01`), `phase2-database-foundation-rls.int-spec.ts` (clean-DB `0008 -> 0000 -> 0008`), and `phase4a-database-integrity-and-audit.int-spec.ts`.
- **`DB-P4-02` (`22`-Table Ownership, `FORCE RLS` & `24`-Permission Seed Check — `PASSED (Stage 4A)`):** Verified all `22` public tables are owned by `ft360_migrator` (`0` owned by `ft360_app`) with `relrowsecurity = true` and `relforcerowsecurity = true`, and all `24` permissions satisfy `chk_permissions_code_format`.
- **`DB-P4-03` (Composite Foreign Key Cross-Tenant Rejection — `PASSED (Stage 4A)`):** Verified cross-tenant `(tenant_alpha, tenant_beta_*)` inserts/updates on `tenant_onboarding_states`, `tenant_profiles`, `tenant_settings`, `tenant_branding_assets`, `tenant_branding_settings`, `tenant_audit_logs`, `tenant_invitations`, and `auth_email_outbox` fail with `23503`.
- **`DB-P4-04` (Serialized `FOR UPDATE` Last-Admin Lock, Concurrent Ownership Transfer & Internal-Only Admin Trigger — `PASSED (Stage 4A)`):** Verified `trigger_enforce_admin_membership_type()` blocks `CLIENT_PORTAL`/`PARTNER` `tenant_admin` assignments (`42501`), `trigger_prevent_last_tenant_admin_removal()` serializes concurrent two-admin demotion/suspension transactions via `SELECT ... FROM public.tenants FOR UPDATE` (`1` commits, `1` fails `42501`), and `fn_tenant_transfer_primary_owner` serializes concurrent ownership transfers cleanly leaving exactly `1` `is_primary_owner = TRUE`.
- **`DB-P4-05` (`tenant_audit_logs` Immutability, `ON DELETE RESTRICT` & Secret Check — `PASSED (Stage 4A)`):** Verified `UPDATE` and `DELETE` fail with `42501` (even under `PlatformAdmin` GUC), deleting a referenced tenant fails `23001` (`fk_tal_tenant` `ON DELETE RESTRICT`), and nested secret keys fail `23514`.
- **`DB-P4-06` (Initiator vs. Recipient Schema Invariants on `auth_email_outbox` & `tenant_invitations` — `PASSED (Stage 4A)`):** Verified `chk_auth_email_outbox_anchor` (`user_id IS NULL` + `initiated_by_user_id` for `'TENANT_INVITATION'`), `chk_ti_pending_recipient_unbound`, `chk_ti_initiator_recipient_distinct`, `42501` self-invite/self-accept rejection, and surgical single-tenant session unbinding (`fn_tenant_evict_member_sessions`).
- **`DB-P4-07` (Duplicate Global Email Database Unique Constraints & Concurrent Registration Race — `PASSED (Stage 4A)`):** Executed parallel PostgreSQL transactions (`Promise.all` across `fn_invitation_accept_new_user` and `fn_auth_register_user`) for case-variant emails (`'Race.Candidate@Example.COM'`, `'race.candidate@example.com'`, `'RACE.CANDIDATE@example.com'`), verifying exactly `1` row in `public.users`, `23505` on losers, unburned losing `PENDING` invitation tokens, and `23514` rejection on whitespace-padded emails (`chk_users_email_canonical_trimmed`).
- **`RLS-P4-01..06` (Unscoped Denial, Cross-Tenant Isolation, PostgreSQL Lifecycle Write-RLS, `token_hash` Omission & Unweakened `users_select` — `PASSED (Stage 4A)`):** Verified across all `7` new tables under `ft360_app`, including 4-layer PostgreSQL suspension enforcement (`fn_auth_validate_session`, `fn_verify_tenant_membership`, `fn_is_current_tenant_operational()`, `fn_assert_tenant_operational()`) with simulated complete Redis outage.

### 2.3 API, RBAC, Invitation, Lifecycle & Negative Security Integration Suite
- **`IT-P4-01` – `IT-P4-05`:** `PLANNED — NOT EXECUTED` (Stages 4B–4D).
- **`IT-P4-06` (Endpoints `#29` & `#35` Audit Querying):**
  - **Endpoint `#29` (`GET /api/v1/workspace/audit-logs`) — `PASSED (Stage 4A)`:** Verified cursor pagination, `eventType`/`resourceType`/`outcome` filters, `403 INSUFFICIENT_TENANT_PERMISSIONS` on ordinary members, `403 TENANT_MEMBERSHIP_REQUIRED` on unscoped/platform sessions, and strict cross-tenant Alpha/Beta isolation in `phase4a-database-integrity-and-audit.int-spec.ts`.
  - **Endpoint `#35` (`GET /api/v1/platform/tenants/:tenantId/audit-logs`) — `PLANNED — NOT EXECUTED` (Stage 4E).**
- **`RBAC-P4-01..04`, `INV-P4-01..07`, `LIFE-P4-01..05`:** HTTP API suites `PLANNED — NOT EXECUTED` (Stages 4B–4E).
- **`SEC-P4-01..20` (Mandatory 20-Case Negative Security Suite):**
  - **DB & Workspace Audit Cases (`SEC-P4-08` last-admin lock, `SEC-P4-13` `token_hash` `42501` omission, `SEC-P4-16` `tenant_audit_logs` immutability & secret scrubbing, `SEC-P4-17` DB-level initiator/recipient & concurrent email uniqueness) — `PASSED (Stage 4A)`.**
  - **Remaining HTTP/Storage/UI Cases (`SEC-P4-01..07`, `SEC-P4-09..12`, `SEC-P4-14..15`, `SEC-P4-18..20`) — `PLANNED — NOT EXECUTED` (Stages 4B–4E).**

### 2.4 Frontend Route-View (`UI-P4-01` – `UI-P4-04`) & Playwright E2E Suite (`E2E-P4-01` – `E2E-P4-04`)
- **`UI-P4-01..04` (`14` Route-Views `RV-01`–`RV-14`) — `PLANNED — NOT EXECUTED` (Stages 4B–4E).**
- **`E2E-P4-01..04` (Playwright Chromium Journeys) — `PLANNED — NOT EXECUTED` (Stage 4E).**

---

## 3. Phase 2–3 Migration & Catalog Regression Synchronization (Completed in Stage 4A)

`phase3-auth-workflows.int-spec.ts` (`IT-P3-01`) was synchronized in Stage 4A to verify `0008 -> 0007 -> 0006` rollback/re-apply, all `22` `FORCE RLS` public tables, and `42501` secret column exclusion across `tenant_invitations.token_hash` alongside all Phase 3 secret columns—without loosening any Phase 1–3 security assertion.
