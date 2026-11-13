# FunnelTrack360 — Phase 4 Acceptance Criteria & Confirmed Architecture Decisions

**Phase:** Phase 4 — Tenant Onboarding & Management (`Modules 4.1–4.10`)  
**Scope Alignment:** **`35` REST API Endpoints** (`#1`–`#35`) · **`14` Frontend Route-Views** (`RV-01`–`RV-14`: `11` new + `3` updated) · **`22` `FORCE RLS` Public Tables** (`15` existing + `7` new) · **`24` Canonical Permissions** (`14` existing + `10` new)  
**Verification Standard:** Every criterion must be verified by automated tests (`Jest`, `Supertest`, `PostgreSQL 18 RLS`, `Playwright Chromium` — currently `PLANNED — NOT EXECUTED`) and green GitHub Actions CI on protected branches before Phase 4 can be marked `COMPLETED`.  
**Document Status:** `PLANNING BASELINE — PRODUCT & TECHNICAL DECISIONS CONFIRMED (AWAITING PR REVIEW)`  
**Last Updated:** 2026-11-14

---

## 1. Module-by-Module Functional & Security Acceptance Criteria

### Module 4.1 — Tenant Registration
- [ ] **AC-4.1.1:** Authenticated, `ACTIVE`, email-verified non-Super-Admin users can register a new organization via `RV-01` (`/organizations/new` -> `#2 POST /api/v1/tenants/register`) in one atomic transaction (`fn_tenant_provision_organization`), initializing `tenants` (`status = 'TRIAL'` per confirmed `D1`), `1:1` companion rows, seeded `tenant_admin` & `member` roles, `is_primary_owner = TRUE` membership, bound session, and dual-ledger `TENANT_REGISTERED` audit rows.
- [ ] **AC-4.1.2:** `#1 GET /api/v1/tenants/slug-availability` requires a verified authenticated user, enforces multi-tier rate limits (`15/min/user`, `20/min/IP`, `100/hr/user` with `15-min` lockout), **fails closed (`503`)** if Redis is offline, and returns only `{ slug, available }` (identical `available: false` for reserved words and existing slugs, disclosing binary occupancy only with **zero** tenant metadata).
- [ ] **AC-4.1.3:** Unverified accounts (`email_verified = FALSE`), `Platform Super Admins`, duplicate slugs (`409`), and users exceeding the per-user quota (`<= 5` active/trial owned tenants per confirmed `D2`, serialized via `pg_advisory_xact_lock`) are deterministically rejected.

### Module 4.2 — Tenant Onboarding
- [ ] **AC-4.2.1:** Newly created tenants start in `onboarding_status = 'IN_PROGRESS'` (`current_step = 'ORG_PROFILE'`), persist each step (`org-profile`, `org-settings`, `org-branding`, `team-invites`) independently with `expectedVersion` optimistic locking on `RV-03` (`/workspace/onboarding`, `#3`–`#5`), and resume accurately across reloads/devices.
- [ ] **AC-4.2.2:** Steps 1 (`ORG_PROFILE`) and 2 (`ORG_SETTINGS`) are mandatory before `#5 POST /api/v1/workspace/onboarding/complete` succeeds (`422` otherwise); `RV-04` (`/workspace`) displays a non-blocking setup banner solely to admins with `tenant:organization:manage`.

### Module 4.3 — Organization Profile
- [ ] **AC-4.3.1:** `RV-05` (`/workspace/organization/profile`, `#6`–`#7`) enforces `tenant:organization:read` for viewing and `tenant:organization:manage` for editing, syncs `tenants.display_name` and `tenants.legal_name`, keeps `slug` and `status` immutable (`trigger_protect_tenant_lifecycle`), enforces `expectedVersion` (`409`), and logs field-level `before_state`/`after_state` diffs.

### Module 4.4 — Tenant Lifecycle Management & 4-Layer PostgreSQL Validation During Redis Outage
- [ ] **AC-4.4.1:** Platform Super Admins (`PlatformSuperAdminGuard` + `platform:tenants:read` / `platform:tenants:manage`) can inspect, provision (`#31`), and transition tenants (`#33`) across `PROVISIONING`, `TRIAL`, `ACTIVE`, `SUSPENDED`, `DEACTIVATED`, and terminal `CANCELLED` on `RV-13` & `RV-14` (`/platform/tenants`, `/platform/tenants/[tenantId]`) with a mandatory `10–500` character `reason`.
- [ ] **AC-4.4.2:** All invalid state transitions—including **direct `TRIAL -> CANCELLED` and `ACTIVE -> CANCELLED` without prior `SUSPENDED` or `DEACTIVATED` (`OD-P1`)** and any outbound transition from terminal `CANCELLED`—fail with `409 INVALID_TENANT_STATUS_TRANSITION`.
- [ ] **AC-4.4.3:** Transitioning to `SUSPENDED`, `DEACTIVATED`, or `CANCELLED` synchronously unbinds `auth_sessions.active_tenant_id = NULL` in PostgreSQL (`T = 0ms` at `COMMIT`) and enforces **4-layer PostgreSQL lifecycle validation when Redis is unavailable** (`RedisSessionCacheService` fail-safe degradation + `fn_auth_validate_session` tenant join + `fn_verify_tenant_membership` + `withVerifiedMemberTransaction` / `fn_assert_tenant_operational` / write-RLS `fn_is_current_tenant_operational()`), blocking workspace APIs, org selection, invitation acceptance, and raw tenant SQL writes within **`< 200ms` HTTP assertion (`< 1,000ms` SLA) even during a complete Redis outage**, while preserving users' sessions in other active organizations.

### Module 4.5 — Tenant Administrator Management
- [ ] **AC-4.5.1:** `RV-08` (`/workspace/admins`, `#20`) requires `tenant:admins:read`; promoting/demoting `tenant_admin` (`#19`), suspending/revoking an admin (`#17`), or inviting an admin (`#23`–`#25`) requires `tenant:admins:manage`, and non-`INTERNAL` members are blocked by `trigger_enforce_admin_membership_type()` (`422` / `42501`).
- [ ] **AC-4.5.2:** Primary ownership (`is_primary_owner = TRUE`, `uq_tenant_memberships_primary_owner`) can be transferred atomically only by the current Primary Owner (`#21`) or via break-glass Platform Super Admin recovery (`#34`) with mandatory `reason`.
- [ ] **AC-4.5.3:** Concurrent or single-actor mutations that would leave `< 1` `ACTIVE` `INTERNAL` `tenant_admin` in an operational (`TRIAL` / `ACTIVE`) tenant serialize on `SELECT id, status FROM public.tenants WHERE id = v_tenant_id FOR UPDATE` inside `trigger_prevent_last_tenant_admin_removal()` and deterministically abort (`409 LAST_TENANT_ADMIN_PROTECTED` / `SQLSTATE 42501`).

### Module 4.6 — User Invitations, Initiator/Recipient Separation & Duplicate Global Email Concurrency
- [ ] **AC-4.6.1:** Admins with `tenant:invitations:read` / `tenant:invitations:manage` can list (`#22`), issue (`#23`), resend (`#24`, rotating `token_hash`), and revoke (`#25`) invitations on `RV-10` (`/workspace/invitations`), with `256-bit` CSPRNG tokens stored only as unreadable SHA-256 `token_hash` in `tenant_invitations`, sealed via HKDF `AES-256-GCM` in `auth_email_outbox` (`kind = 'TENANT_INVITATION'`), and redacted from all logs.
- [ ] **AC-4.6.2 (Initiator vs. Recipient Identity Separation):** Initiator columns (`invited_by_user_id`, `invited_by_membership_id`, `auth_email_outbox.initiated_by_user_id`) derive strictly from server GUC `app_current_user_id()`; self-invites fail (`422 CANNOT_INVITE_SELF`); `chk_auth_email_outbox_anchor` enforces **`user_id IS NULL`** on `'TENANT_INVITATION'`; `chk_ti_pending_recipient_unbound` & `chk_ti_initiator_recipient_distinct` prevent recipient/initiator conflation; and clicking `#27` while signed in as the initiating admin (or wrong account) fails with `403 INVITATION_EMAIL_MISMATCH` without burning the token (`RV-12` renders an explicit Sign-Out / Switch-Account guard).
- [ ] **AC-4.6.3 (Atomic Dual-Path Acceptance & Duplicate Global Email Concurrency):** `#27` and `#28` lock `tenant_invitations` `FOR UPDATE` (`0` concurrent replays, `expires_at > NOW()`). On `#28 POST /api/v1/invitations/accept-register`, `pg_advisory_xact_lock` + PostgreSQL unique constraints `uq_users_email` (`CITEXT`), `chk_users_email_canonical_trimmed`, and `uq_users_email_normalized` (`SQLSTATE 23505`) guarantee **at most `1` global `public.users` row per email** under parallel `accept-register` and `/auth/register` races (`DB-P4-07`, `INV-P4-07`, `SEC-P4-19`), returning `409 USER_ALREADY_REGISTERED_SIGN_IN_TO_ACCEPT` to losers while leaving their `PENDING` invitation unburned.

### Module 4.7 — Tenant Membership Management
- [ ] **AC-4.7.1:** `#15 GET /api/v1/workspace/members` (`RV-09`) requires `tenant:members:read` and enforces `allow_member_directory_view = FALSE` by default (confirmed `D4`), returning `403 MEMBER_DIRECTORY_RESTRICTED` to ordinary members unless enabled by a Tenant Admin (while preserving `users_select` RLS unweakened and serving non-active member rows only to `tenant:members:manage` callers via `fn_tenant_list_workspace_members`).
- [ ] **AC-4.7.2:** Role lookup (`#18`, `rbac:roles:read`), role assignment (`#19`, `tenant:roles:assign`), metadata updates (`#16`, `tenant:members:manage`), and surgical single-tenant membership suspend/reactivate/revoke (`#17`, `tenant:members:manage`) operate without affecting `public.users` or memberships/sessions in other tenants.

### Module 4.8 — Organization Settings
- [ ] **AC-4.8.1:** `RV-06` (`/workspace/organization/settings`, `#8`–`#9`) enforces `tenant:settings:read` and `tenant:settings:manage`, validates IANA timezone / BCP-47 locale / ISO-4217 currency / `invitationExpiryHours` (`1..720`, default `168` per confirmed `D3`) / `allowMemberDirectoryView` (`default false` per confirmed `D4`), syncs `tenants` defaults, invalidates `t:{tenantId}:settings:active`, and logs diffs.

### Module 4.9 — Organization Branding
- [ ] **AC-4.9.1:** `RV-07` (`/workspace/organization/branding`, `#10`–`#14`) enforces `tenant:branding:read` and `tenant:branding:manage`, **unconditionally rejects `.svg`/HTML/XML (`415`)**, validates byte limits (`<= 2 MiB` / `<= 256 KiB`), magic bytes (`PNG`/`JPEG`/`WebP`), and dimension/pixel-count caps (`<= 4.19 MP` / `<= 0.26 MP`), **fully decodes pixel streams and strips all EXIF/XMP/IPTC/chunk metadata via `sharp` (`OD-T1`)**, isolates storage (`D5`: local outside web root in dev/CI; private S3 via **`@aws-sdk/client-s3` (`OD-T2`)** in staging/production), and streams `#13` under `FORCE RLS` (`404` cross-tenant) with `CSP: default-src 'none'; sandbox`.

### Module 4.10 — Tenant Audit Logging
- [ ] **AC-4.10.1:** Auth/session/rate-limit/guard-denial events route to `auth_audit_logs`, tenant domain state-diff mutations route to append-only `tenant_audit_logs` (`UPDATE`/`DELETE` blocked `42501`, `ON DELETE RESTRICT`, `365`-day minimum hot retention per confirmed `OD-P2`), the `5` cross-plane bridge events write atomically to both ledgers with matching `correlation_id`, and recursive JSONB secret checks (`fn_jsonb_has_forbidden_secret_key`) block any secret persistence (`23514`).

---

## 2. Cross-Cutting Quality & Governance Exit Gates

- [ ] **Zero ORM & Strict Privilege Preservation:** `npm run check:no-orm` passes; all `22` public tables owned by `ft360_migrator` with `ENABLE` + `FORCE ROW LEVEL SECURITY`; zero existing Phase 2–3 RLS policies or role/column privileges weakened.
- [ ] **100% Explicit Permission Mapping:** Every one of the `35` endpoints (`#1`–`#35`) enforces its documented guard and explicit permission from the `24`-permission catalog (`0` implicit guard fallbacks).
- [ ] **Automated Test & CI Gate:** All Phase 1–3 regression tests plus all Phase 4 unit (`UT-P4-01..08`), DB/concurrency/RLS (`DB-P4-01..07`, `RLS-P4-01..06`), API/RBAC/invitation/lifecycle (`IT-P4-01..06`, `RBAC-P4-01..04`, `INV-P4-01..07`, `LIFE-P4-01..05`), `20` negative security (`SEC-P4-01..20`), UI (`UI-P4-01..04`), and `4` Playwright Chromium E2E (`E2E-P4-01..04`) specs pass on GitHub Actions CI with `0` console errors, `0` uncaught page errors, and `0` HTTP `5xx` responses, and receive independent reviewer approval across PRs `4A`–`4E`.

---

## 3. Confirmed Product & Technical Decisions Register (`All 10 Confirmed — 2026-11-14`)

| ID | Topic | Confirmed Decision | Status |
|---|---|---|---|
| **`D1`** | Tenant registration initial status | Self-registered tenant begins in **`TRIAL`**. | **`CONFIRMED`** |
| **`D2`** | Tenant ownership limit | Maximum **`5` active/trial owned tenants per user** (`PROVISIONING`/`SUSPENDED` self-created tenants also counted against anti-abuse quota). | **`CONFIRMED`** |
| **`D3`** | Invitation expiry | **`168 hours` (`7 days`) by default**, configurable per tenant between **`1` and `720 hours` (`30 days`)**. | **`CONFIRMED`** |
| **`D4`** | Member directory visibility | **Restricted by default for ordinary members** (`allow_member_directory_view = FALSE`); Tenant Admin access (`tenant:members:manage`) remains available. | **`CONFIRMED`** |
| **`D5`** | Branding asset storage | **Local storage outside web root** (`.local/storage/tenants/{tenantId}/branding/...`) for development/CI; **private S3-compatible storage** for staging/production. | **`CONFIRMED`** |
| **`D6`** | Phase 4 PR delivery cadence | **`5` separate staged PRs: `4A`, `4B`, `4C`, `4D`, and `4E`** into `development` (followed by `1` release PR `development -> main`). | **`CONFIRMED`** |
| **`OD-T1`** | Raster image processing (`Stage 4C`) | **`sharp`** (`limitInputPixels` pixel-bomb guard, full pixel-stream decoding, EXIF/XMP/IPTC/chunk stripping, clean raster re-encoding). | **`CONFIRMED`** |
| **`OD-T2`** | S3 storage client (`Stage 4C`) | **`@aws-sdk/client-s3`** for private S3-compatible object storage in staging/production. | **`CONFIRMED`** |
| **`OD-P1`** | Tenant cancellation safeguard (`Module 4.4`) | **Require `SUSPENDED` or `DEACTIVATED` first** before operational (`TRIAL` / `ACTIVE`) tenants can transition to terminal `CANCELLED`. | **`CONFIRMED`** |
| **`OD-P2`** | Audit retention policy (`Module 4.10`) | **`365 days` minimum hot queryable PostgreSQL retention** (`0` runtime deletes in Phase 4). | **`CONFIRMED`** |

**Remaining Unresolved Decisions:** **`0`** — All product and technical decisions are resolved; awaiting independent review and merge of the Phase 4 planning PR (`feature/phase-4-planning -> development`).
