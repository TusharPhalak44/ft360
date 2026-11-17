# Phase 4 – Tenant Onboarding & Management Task & Verification Register

**Last Updated:** 2026-11-17  
**Active Branch:** `feature/phase-4b-registration-routines` (Target Base: `development` @ `42d4de2`)  
**Phase Status:** **`STAGE 4A CLOSED & MERGED (PR #6 @ 42d4de2) · STAGE 4B PREREQUISITE MIGRATION 0009 IN PR REVIEW · STAGE 4B APP/UI & STAGES 4C–4E NOT STARTED`**

> **Governance Rule:** Approved 5-PR vertical delivery strategy (`D6`: Stages `4A`–`4E`) merged via PR `#5` (`4caf3d9`), and Stage 4A merged via PR `#6` (`42d4de2`, Post-Merge CI Run `#43929316797`). Per Tushar's migration-first approval, `feature/phase-4b-registration-routines` delivers **only** Migration `0009` (`fn_check_tenant_slug_available` & `fn_tenant_provision_organization`) + mandatory database security/concurrency tests and documentation. Zero Stage 4B application APIs/UI have started.

---

## 1. Phase 4 Stage Execution Matrix (`Stages 4A–4E`)

| Stage / Task ID | Vertical Deliverable & Scope | Lead Owner | Status | Planned / Delivered Files | Verification Evidence |
|---|---|---|---|---|---|
| **P4-PLAN** | **Phase 4 Architecture & 10-Document Planning Suite (`D1`–`D6`, `OD-T1/T2`, `OD-P1/P2`)** | Tushar, Nakshatra, Mansi | **`CLOSED & MERGED` (`PR #5` @ `4caf3d9`)** | `docs/planning/phase-4/*`, `docs/README.md` | Independently reviewed, merged into `development` (`4caf3d9`), Post-Merge CI Run `#43504266924` green |
| **P4-4A-01..03** | **Stage 4A — Database Schema (`0007`–`0008`), `FORCE RLS`, Serialized Last-Admin Lock, PG Lifecycle Fallback & `TenantAuditModule` (`#29`)** | Tushar & Mansi | **`CLOSED & MERGED` (`PR #6` @ `42d4de2`)** | `db/migrations/0007*`, `0008*`, `apps/api/src/modules/tenant-audit/*`, `apps/api/src/common/tenant-permission.guard.ts` | Approved by `@NakshtraSulakhe` (`#5925270718`), merged @ `42d4de2`, Post-Merge CI Run `#43929316797` green |
| **P4-4B-00 (Migration `0009`)** | **Stage 4B Database Prerequisite — Tenant Registration Routines (`0009`)**<br>• `public.fn_check_tenant_slug_available(p_slug CITEXT) RETURNS BOOLEAN` (`ft360_migrator` `SECURITY DEFINER`, verified active user required, reserved/invalid/occupied slugs return uniform `FALSE`, `0` metadata)<br>• `public.fn_tenant_provision_organization(...)` (verifies `app_current_user_id() = p_actor_user_id`, active verified non-Super-Admin user, `app_current_tenant_id() IS NULL`, never elevates `app.is_super_admin`, `pg_advisory_xact_lock` `<= 5` cap, creates `TRIAL` tenant + `18`/`4` permissions + primary owner + `1:1` companions + isolated session bind + dual-ledger `TENANT_REGISTERED` audit) | **Tushar & Mansi** | **`IN CODE REVIEW` (`0009` Migration PR)** | `db/migrations/0009_phase4b_tenant_registration_routines.{up,down}.sql`, `apps/api/test/integration/phase4b-registration-routines.int-spec.ts` | **`PASSED`** (`0009` up -> down -> up, clean-DB `0001`–`0009`, `52/52` unit, `42/42` PG18+Redis integration incl. `0009-SEC-01..05`) |
| **P4-4B** | **Stage 4B Application & UI — Self-Service Registration (`TRIAL`), 4-Step Onboarding, Profile, Settings & Audit Viewer (`APIs #1–#9`, `7` Route-Views)** | Tushar & Nakshatra | **`NOT STARTED`** | Deferred until `0009` Migration PR is approved & merged | `PLANNED — NOT EXECUTED` |
| **P4-4C** | **Stage 4C — Organization Branding, `sharp` Decoding & `@aws-sdk/client-s3` / Local Asset Storage (`APIs #10–#14`, `1` Route-View)** | Nakshatra | **`NOT STARTED`** | Deferred until Stage 4B is merged (`sharp` & `@aws-sdk/client-s3` not installed yet) | `PLANNED — NOT EXECUTED` |
| **P4-4D** | **Stage 4D — Dual-Path User Invitations, Member Directory, Roles & Admin Management (`APIs #15–#28`, `4` Route-Views)** | Mansi | **`NOT STARTED`** | Deferred until Stage 4C is merged | `PLANNED — NOT EXECUTED` |
| **P4-4E** | **Stage 4E — Platform Lifecycle Matrix (`OD-P1`), `< 200ms` Suspension Gate & Full Playwright E2E (`APIs #30–#35`, `2` Route-Views)** | Tushar & Mansi | **`NOT STARTED`** | Deferred until Stage 4D is merged | `PLANNED — NOT EXECUTED` |
