# FunnelTrack360 — Phase 4 Security Threat Model & Negative Test Matrix

**Phase:** Phase 4 — Tenant Onboarding & Management  
**Scope Alignment:** **`35` REST API Endpoints** (`#1`–`#35`) · **`14` Frontend Route-Views** (`RV-01`–`RV-14`) · **`22` `FORCE RLS` Public Tables** (`15` existing + `7` new) · **`24` Canonical Permissions** (`14` existing + `10` new)  
**Document Status:** `PLANNING BASELINE — PRODUCT & TECHNICAL DECISIONS CONFIRMED (AWAITING PR REVIEW)`  
**Last Updated:** 2026-11-14

---

## 1. Threat Analysis & Multi-Layer Mitigations (`14` Mandatory Domains)

### T-01: Cross-Tenant Data & Asset Exposure
- **Attack Vector:** Authenticated user or Tenant Admin in **Tenant Alpha** attempts to read or mutate **Tenant Beta**'s profile, onboarding state, regional settings, branding assets, member directory, invitations, or audit logs via forged UUIDs, manipulated query parameters, or injected `x-tenant-id` headers.
- **Security Controls:**
  1. **Edge Guard:** `UntrustedTenantInputGuard` rejects any unsolicited `tenantId`, `organizationId`, or `x-tenant-id` input (`400 UNTRUSTED_TENANT_INPUT_REJECTED`). Only explicit control-plane routes (`#32`–`#35`) and `/api/v1/auth/select-organization` opt in via `@AllowExplicitTenantTarget()`.
  2. **Session-Derived Context:** `TenantMembershipGuard` derives `req.tenantContext` strictly from server-validated `auth_sessions.(active_tenant_id, active_membership_id)` across all `24` single-tenant workspace endpoints (`#3`–`#25`, `#29`).
  3. **Database `FORCE RLS` + Composite FKs:** All `7` new Phase 4 tables (`22` total public tables) enforce `ENABLE` + `FORCE ROW LEVEL SECURITY` (`tenant_id = app_current_tenant_id()`), and all intra-tenant references (`role_id`, `membership_id`, `asset_id`, `invitation_id`) use composite foreign keys `(tenant_id, id)`.
  4. **Authenticated Asset Stream Isolation:** `#13 GET /api/v1/workspace/branding/assets/:assetId/content` resolves `storage_key` inside `withVerifiedMemberTransaction` under `FORCE RLS` (`tenant:branding:read`), returning `404 BRANDING_ASSET_NOT_FOUND` for any cross-tenant `assetId`.
- **Negative Tests:** `SEC-P4-01`, `RLS-P4-01..06`.

### T-02: Unauthorized Tenant Creation & Resource Exhaustion
- **Attack Vector:** Unauthenticated caller, unverified `PENDING` user (`email_verified = FALSE`), `SUSPENDED` account, or scripted bot creates hundreds of organizations; or a Platform Super Admin creates a personal customer workspace inside the wrong plane.
- **Security Controls:**
  1. `#2 POST /api/v1/tenants/register` requires `JwtAuthGuard`, `CsrfProtectionGuard`, live `users.status = 'ACTIVE'`, `users.email_verified = TRUE`, and `users.is_platform_super_admin = FALSE` (Platform Super Admins provision customer tenants exclusively via `#31 POST /api/v1/platform/tenants` with mandatory `reason`).
  2. `fn_tenant_provision_organization` acquires transaction advisory lock `pg_advisory_xact_lock(hashtext('tenant_reg:' || actor_user_id::text))` to serialize per-user quota checks (`<= 5` active/trial owned tenants per confirmed `D2`).
  3. Redis rate limit (`5` registration attempts / hour / `userId` & IP) + `TENANT_SELF_REGISTRATION_ENABLED` emergency kill-switch.
- **Negative Tests:** `SEC-P4-02`.

### T-03: Unauthorized Tenant Admin Assignment, Concurrent Write-Skew & Last-Admin Lockout
- **Attack Vector:** Ordinary member or `tenant:roles:assign`-only operator promotes someone to `tenant_admin`; `CLIENT_PORTAL` or `PARTNER` external user is granted `tenant_admin`; secondary admin hijacks `is_primary_owner`; sole `tenant_admin` demotes/revokes themselves; or **two concurrent `READ COMMITTED` transactions** (Admin A demoting Admin B while Admin B suspends Admin A) commit simultaneously and leave `0` active administrators.
- **Security Controls:**
  1. Explicit `tenant:admins:manage` is required whenever promoting/demoting `tenant_admin` (`#19`), suspending/revoking an admin (`#17`), inviting for `tenant_admin` (`#23`–`#25`), or transferring primary ownership (`#21`).
  2. Service validation + PostgreSQL trigger `trigger_enforce_admin_membership_type()` (`422` / `SQLSTATE 42501`) prohibit non-`INTERNAL` (`CLIENT_PORTAL`, `PARTNER`) memberships from holding `tenant_admin`.
  3. `#21 POST /api/v1/workspace/admins/transfer-ownership` requires `caller.isPrimaryOwner === true` + `confirmationSlug` + `reason`; `fn_tenant_transfer_primary_owner` locks `public.tenants` `FOR UPDATE` and updates `is_primary_owner` atomically under partial unique index `uq_tenant_memberships_primary_owner` (break-glass recovery when an owner is unreachable is restricted to `#34 POST /api/v1/platform/tenants/:tenantId/recover-owner`).
  4. **Serialized Parent-Row Lock (`FOR UPDATE`):** Both service mutations and `AFTER UPDATE OR DELETE` trigger `trigger_prevent_last_tenant_admin_removal()` first execute **`SELECT id, status FROM public.tenants WHERE id = v_tenant_id FOR UPDATE`**, serializing concurrent membership and role changes on the same tenant so `READ COMMITTED` write-skew is impossible; any change leaving `< 1` `ACTIVE` `INTERNAL` `tenant_admin` in a `TRIAL` or `ACTIVE` tenant aborts with `409 LAST_TENANT_ADMIN_PROTECTED` (`SQLSTATE 42501`).
  5. Existing `trigger_enforce_tenant_permission_scope()` guarantees `tenant_admin` can never receive `PLATFORM` permissions.
- **Negative Tests:** `SEC-P4-03`, `SEC-P4-04`, `SEC-P4-17`.

### T-04: Invitation Token Replay, Duplicate Global Email Race & Initiator/Recipient Identity Confusion
- **Attack Vector:** Attacker extracts invitation tokens from logs/DB, replays an `ACCEPTED`/`REVOKED`/`EXPIRED` link, fires concurrent `Promise.all` requests on `accept-register` (or races `accept-register` against `/auth/register`) to create duplicate global `public.users` rows for the same email, conflates the **initiating admin's** `user_id` with the **recipient's** identity in `auth_email_outbox` or `tenant_invitations`, or clicks an invitation link while still signed in as the initiating admin.
- **Security Controls:**
  1. `32`-byte (`256-bit`) CSPRNG raw tokens; `tenant_invitations` stores **only** `CHAR(64)` SHA-256 `token_hash`, with column-level `SELECT` on `token_hash` **omitted from `ft360_app` grants** (`42501`).
  2. **Strict Initiator vs. Recipient Separation:** `invited_by_user_id` / `invited_by_membership_id` (plus `auth_email_outbox.initiated_by_user_id`) derive exclusively from server GUC `app_current_user_id()`; self-invites (`lower(btrim(inviter.email)) = lower(btrim(invited_email))`) fail (`422 CANNOT_INVITE_SELF`); `chk_auth_email_outbox_anchor` enforces **`user_id IS NULL`** on `kind = 'TENANT_INVITATION'`; `chk_ti_pending_recipient_unbound` keeps `accepted_by_user_id IS NULL` while `PENDING`; and `chk_ti_initiator_recipient_distinct` enforces `accepted_by_user_id <> invited_by_user_id`.
  3. **Atomic `FOR UPDATE` Single-Use & Expiration Enforcement:** `fn_invitation_accept_existing_user` (`#27`) and `fn_invitation_accept_new_user` (`#28`) lock `SELECT * FROM public.tenant_invitations WHERE token_hash = p_token_hash FOR UPDATE`, verify `status = 'PENDING'`, `expires_at > NOW()`, and operational tenant status via `fn_assert_tenant_operational`, and transition to `ACCEPTED` in one ACID transaction; `#24 resend` rotates `token_hash` immediately.
  4. **Recipient Email Match & Duplicate Global Email Concurrency Protection:** `#27 accept` enforces `caller.id <> v_inv.invited_by_user_id` and `lower(btrim(users.email)) = lower(btrim(invitation.invited_email))` (`403 INVITATION_EMAIL_MISMATCH` without burning the token). `#28 accept-register` serializes on `pg_advisory_xact_lock(hashtext('global_user_email:' || lower(btrim(v_inv.invited_email::text))))` AND enforces PostgreSQL unique constraints `uq_users_email` (`CITEXT`), `chk_users_email_canonical_trimmed`, and `uq_users_email_normalized` (`UNIQUE (lower(btrim(email::text)))` -> `SQLSTATE 23505` `unique_violation`), aborting concurrent duplicate global email registrations with `409 USER_ALREADY_REGISTERED_SIGN_IN_TO_ACCEPT` while keeping the losing `PENDING` invitation unburned.
- **Negative Tests:** `SEC-P4-05`, `SEC-P4-06`, `SEC-P4-19`, `SEC-P4-20`.

### T-05: Slug Occupancy Scraping, Email Enumeration & Directory Privacy Leakage
- **Attack Vector:** Attacker scrapes `#1 GET /api/v1/tenants/slug-availability` at high volume to harvest tenant slugs or metadata, probes invitation endpoints to enumerate registered emails, or uses an ordinary member account to harvest member emails/statuses across the organization.
- **Security Controls:**
  1. **Honest Occupancy Disclosure + Zero Metadata Exposure:** Because slug uniqueness is user-visible during registration, `#1 slug-availability` and `#2 register` (`409`) necessarily disclose **binary slug occupancy** (`available: boolean`) and **do not claim strict slug non-enumeration**. Instead, `#1` requires an authenticated verified user (`JwtAuthGuard`, `email_verified = TRUE`), returns the minimal uniform payload `{ slug, available }` (returning identical `available: false` for reserved system words and existing tenants, with **zero** exposure of tenant ID, legal/display name, status, owner, or member count), enforces multi-tier rate limits (`15 req/60s` per `userId`, `20 req/60s` per IP, `100 req/hr` per `userId` with `15-min` lockout + `AUTH_RATE_LIMIT_EXCEEDED` audit log), and **fails closed (`503 SERVICE_TEMPORARILY_UNAVAILABLE`)** if Redis is offline.
  2. `#26 GET /api/v1/invitations/preview` requires possession of a valid `256-bit` token (IP rate-limited `20/min`) and returns a **masked** email (`a***@corp.com`).
  3. **Default-Restricted Member Directory (`D4`) & Unweakened `users_select` RLS:** `tenant_settings.allow_member_directory_view` defaults to **`FALSE`** (confirmed `D4`), blocking `#15 GET /api/v1/workspace/members` (`403 MEMBER_DIRECTORY_RESTRICTED`) for ordinary members unless enabled by a Tenant Admin. Existing `users_select` RLS (`tm.status = 'ACTIVE'`) remains untouched; non-active member rows in `#15` are returned exclusively to verified `tenant:members:manage` holders via narrow `SECURITY DEFINER` `fn_tenant_list_workspace_members`.
- **Negative Tests:** `SEC-P4-07`, `SEC-P4-18`.

### T-06: Membership Escalation & Cross-Tenant Role Injection
- **Attack Vector:** Caller injects a `roleId` belonging to Tenant B when calling `#19 PUT /api/v1/workspace/members/:membershipId/roles` or `#23 POST /api/v1/workspace/invitations` in Tenant A, attempts to modify their own roles/status, or attempts to access `/workspace/*` with an `INVITED`, `SUSPENDED`, or `REVOKED` membership.
- **Security Controls:**
  1. Composite FKs `fk_ura_tenant_membership`, `fk_ura_tenant_role`, and `fk_ti_target_role` reject cross-tenant `(tenant_id, role_id)` pairs with PostgreSQL `23503`.
  2. `TenantMembershipGuard` re-verifies `membership.status === 'ACTIVE'` via PostgreSQL `fn_verify_tenant_membership` on every workspace request (`403 TENANT_MEMBERSHIP_INACTIVE` otherwise).
  3. Service + SQL guards block self-role-escalation, self-suspension/reactivation, and non-owner modification of `is_primary_owner`.
- **Negative Tests:** `SEC-P4-08`.

### T-07: Suspended, Deactivated, or Cancelled Tenant Access & 4-Layer PostgreSQL Lifecycle Validation During Redis Outage
- **Attack Vector:** Platform Super Admin suspends, deactivates, or cancels Tenant A (`#33`), and Tenant A members attempt to continue calling `/api/v1/workspace/*`, accepting invitations, receiving queued invitation emails, or running BullMQ jobs—including **during a total Redis outage** when cache invalidation calls fail; or an operator attempts a direct `ACTIVE -> CANCELLED` jump without prior suspension/deactivation.
- **Security Controls:**
  1. **Synchronous PostgreSQL Transition & Session Unbinding (`T = 0ms` at `COMMIT`):** `fn_platform_transition_tenant_status` locks `public.tenants` `FOR UPDATE`, enforces the 6-state matrix + confirmed `OD-P1` (`TRIAL`/`ACTIVE` must transition to `SUSPENDED` or `DEACTIVATED` before terminal `CANCELLED`) and `10–500` char `reason`, and atomically clears `active_tenant_id = NULL, active_membership_id = NULL` on all non-revoked `public.auth_sessions` bound to that tenant in the **same PostgreSQL transaction**.
  2. **4-Layer PostgreSQL Lifecycle Validation When Redis Is Unavailable:** (a) Fail-safe `try/catch` in `RedisSessionCacheService` and tenant caches (`REDIS_UNAVAILABLE_FALLBACK_PG`) prevents `500` crashes on control-plane suspension calls while never granting cached authorization; (b) `fn_auth_validate_session` joins `public.tenants` in PostgreSQL to verify operational status of `active_tenant_id`; (c) `TenantMembershipGuard` queries PostgreSQL `fn_verify_tenant_membership` (`INNER JOIN public.tenants`, `0` Redis calls) on every workspace request (`403 TENANT_SUSPENDED_OR_INACTIVE`); and (d) `withVerifiedMemberTransaction`, `fn_assert_tenant_operational(v_tenant_id)`, and write RLS `fn_is_current_tenant_operational()` block mutations inside PostgreSQL itself (`< 200ms` HTTP denial assertion, `< 1,000ms` SLA).
  3. **Invitation, Outbox & Worker Gates:** `#26`–`#28` (`preview`/`accept*`), `fn_auth_claim_email_outbox_*` (mail worker claim), and BullMQ `verifyTenantJobOperationalStatus` all verify `tenants.status IN ('ACTIVE', 'TRIAL')` in PostgreSQL before executing. On `CANCELLED`, all `PENDING` invitations are atomically marked `REVOKED` and unsent outbox ciphertexts are wiped.
- **Negative Tests:** `SEC-P4-09`, `SEC-P4-14`, `SEC-P4-18`.

### T-08: Surgical Multi-Tenant Session Handling on Member Suspension, Revocation & Role Change
- **Attack Vector:** Suspending/revoking a member (`#17`) or demoting an admin (`#19`) in **Tenant Alpha** leaves stale admin access active in Tenant Alpha—or conversely destroys the user's global identity or active session in **Tenant Beta**.
- **Security Controls:**
  1. `fn_tenant_evict_member_sessions` unbinds **only** `auth_sessions` rows where `active_tenant_id = tenantAlphaId AND active_membership_id = membershipAlphaId` (and evicts their `auth:sess:{sid}` cache entries), leaving `public.users.status = 'ACTIVE'` and all sessions bound to **Tenant Beta** completely untouched.
  2. `TenantAdminGuard` and `TenantPermissionGuard` evaluate live effective permissions inside PostgreSQL on workspace requests, so role demotions take effect immediately (`0ms` DB staleness).
- **Negative Tests:** `SEC-P4-10`.

### T-09: Branding Upload Abuse (SVG XSS, Decompression Bombs, Corrupt Streams, Metadata Leaks & Path Traversal)
- **Attack Vector:** Malicious admin uploads an `.svg` containing `<script>`, an HTML/polyglot file renamed `.png`, a small PNG header claiming `65000x65000` pixels (`16 GiB` decompression bomb), a truncated/corrupt pixel stream, a photo containing sensitive GPS/EXIF metadata, or a filename `../../etc/passwd`.
- **Security Controls:**
  1. **Unconditional SVG & Markup Rejection:** `.svg`, `.svgz`, `image/svg+xml`, HTML, XML, PDF, and animated GIFs are **unconditionally rejected (`415 UNSUPPORTED_BRANDING_ASSET_TYPE`)** unless separately reviewed and explicitly approved; enforced in code and DB check `chk_tba_mime_allowlist` (`image/png`, `image/jpeg`, `image/webp`).
  2. **Byte Size, Magic-Byte & Pixel-Count Bomb Limits:** Enforces `<= 2 MiB` (`LOGO_LIGHT`/`LOGO_DARK`) and `<= 256 KiB` (`FAVICON`) (`413`), verifies binary magic headers (`PNG`/`JPEG`/`WebP` for logos; `PNG`/`WebP` for favicons), and caps dimensions & pixel counts (`16..2048` & `<= 4,194,304` pixels [`4.19 MP`] for logos; `16..512` square & `<= 262,144` pixels [`0.26 MP`] for favicons -> `422 INVALID_IMAGE_DIMENSIONS`).
  3. **Actual Full Image Decoding & Metadata Stripping (`OD-T1: sharp`):** Fully decodes the pixel stream via `sharp(..., { limitInputPixels, failOn: 'error' })` (rejecting corrupt/truncated/polyglot payloads with `422 CORRUPT_IMAGE_PAYLOAD`), strips **all** `EXIF`, `GPS`, `XMP`, `IPTC`, PNG text chunks (`tEXt`/`zTXt`/`iTXt`), and trailing bytes, and re-encodes a clean raster buffer before hashing and storing.
  4. **Storage & Delivery Isolation (`D5` + `OD-T2: @aws-sdk/client-s3`):** Original filenames are never used in paths; keys are server-generated `tenants/{tenantId}/branding/{assetKind}/{uuidv7}.{ext}` (`chk_tba_storage_prefix`), stored outside web root locally in dev/CI or in private S3-compatible storage via `@aws-sdk/client-s3` in staging/production, and streamed via `#13` with `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, and `Cross-Origin-Resource-Policy: same-origin`.
- **Negative Tests:** `SEC-P4-11`.

### T-10: SQL Injection & Unwhitelisted Property Injection
- **Attack Vector:** Crafted SQL payloads in `slug`, `displayName`, member `search`, cursor tokens, or JSONB states; or mass-assignment of `status` / `isPrimaryOwner` in DTOs.
- **Security Controls:**
  1. 100% parameterized `$1, $2, ...` queries via native `pg` (`0` string interpolation of values; static column whitelists for `ORDER BY`).
  2. Global `ValidationPipe` (`whitelist: true, forbidNonWhitelisted: true, transform: true`).
- **Negative Tests:** `SEC-P4-12`.

### T-11: PostgreSQL RLS, Column Privilege & `SECURITY DEFINER` Bypass
- **Attack Vector:** Direct `ft360_app` query without GUC context, table-owner RLS bypass, `search_path` hijacking on `SECURITY DEFINER` routines, reading `tenant_invitations.token_hash`, mutating `auth_sessions.active_tenant_id` directly, or calling `fn_tenant_*` with forged actor/tenant IDs.
- **Security Controls:**
  1. All `22` public tables owned by `ft360_migrator` with `ENABLE` + `FORCE ROW LEVEL SECURITY`; `ft360_app` is `NOSUPERUSER NOBYPASSRLS`; zero existing RLS policies (`users_select`, `auth_sessions`, `auth_audit_logs`) or column grants are weakened.
  2. Every new `SECURITY DEFINER` function pins `SET search_path = pg_catalog, public, pg_temp`, revokes `PUBLIC` execute, and verifies live GUC context (`app_current_user_id()`, `app_current_tenant_id()`, `app_is_super_admin()`) at entry (`42501` on mismatch).
  3. `TenantTransactionManager` scopes all GUCs via `set_config(..., true)` (`SET LOCAL`) and destroys pooled connections on rollback failure.
- **Negative Tests:** `SEC-P4-13`.

### T-12: Background Worker Tenant Spoofing or Post-Suspension Execution
- **Attack Vector:** BullMQ job executes with forged tenant envelope or mutates data/sends invitation mail after a tenant is `SUSPENDED`, `DEACTIVATED`, or `CANCELLED`.
- **Security Controls:**
  1. Tenant jobs enforce `verifyTenantJobEnvelope` (`tenantId`, `actorUserId`, `correlationId`) and re-verify live `tenants.status IN ('ACTIVE', 'TRIAL')` in PostgreSQL before opening a tenant transaction (`ABORTED_TENANT_INACTIVE` without retry when non-operational).
  2. Outbox jobs carry `{ outboxId, correlationId }` only; `fn_auth_claim_email_outbox_*` checks underlying invitation `PENDING` status and operational tenant status before releasing sealed token material.
- **Negative Tests:** `SEC-P4-14`.

### T-13: Redis Key Traversal & Notification Token Leakage
- **Attack Vector:** Crafted input causes Redis key collision across tenants, or mail worker failure/retry logs leak raw invitation tokens or `/invitations/accept?token=...` URLs.
- **Security Controls:**
  1. All tenant Redis keys constructed via `RedisService.buildTenantKey(tenantId, ns, key)` (`assertValidUuid` + `SAFE_TOKEN_REGEX` -> `t:{tenantId}:{ns}:{key}`).
  2. `redactMailLogText()` in `auth-mail-outbox.service.ts` scrubs raw tokens and `/invitations/accept` URLs across all log levels.
- **Negative Tests:** `SEC-P4-15`.

### T-14: Audit Ledger Misrouting, Tampering, Forgery & Secret Persistence
- **Attack Vector:** Events routed to the wrong audit table, missing `correlation_id`, `UPDATE`/`DELETE` tampering on `tenant_audit_logs`, cross-tenant audit forgery, or nested secrets (`password`, `token`, `cookie`, `authorization`) persisted in `before_state`/`after_state`/`metadata`.
- **Security Controls:**
  1. Explicit dual-ledger contract: auth/session/rate-limit/guard-denial events -> `auth_audit_logs`; tenant domain state diffs -> `tenant_audit_logs`; `5` cross-plane bridge events (`TENANT_REGISTERED`, `PLATFORM_TENANT_PROVISIONED`, `PLATFORM_TENANT_STATUS_CHANGED`, `PLATFORM_TENANT_OWNER_RECOVERED`, `TENANT_INVITATION_ACCEPTED`) written atomically to **both** ledgers sharing `correlation_id`.
  2. `trigger_protect_tenant_audit_immutability()` blocks all `UPDATE` and `DELETE` (`42501`), `fk_tal_tenant` uses `ON DELETE RESTRICT` (`365`-day hot retention baseline `OD-P2` with zero runtime deletes), `fn_record_tenant_audit_log` verifies caller GUC plane, and `chk_tal_no_secret_keys` (`fn_jsonb_has_forbidden_secret_key`) rejects nested secret keys (`23514`).
- **Negative Tests:** `SEC-P4-16`.

---

## 2. Mandatory Negative Security Test Matrix (`SEC-P4-01` – `SEC-P4-20`, All `PLANNED — NOT EXECUTED`)

| Test ID | Target Boundary | Attack / Unauthorized Scenario | Expected Deterministic Result |
|---|---|---|---|
| **`SEC-P4-01`** | Cross-Tenant API & Asset Stream | Tenant A Admin sends forged `x-tenant-id: TenantB` or body `tenantId`, or calls `#13 GET /workspace/branding/assets/{tenantBAssetId}/content` | `400 UNTRUSTED_TENANT_INPUT_REJECTED` on spoofed input; `404 BRANDING_ASSET_NOT_FOUND` on Tenant B `assetId` |
| **`SEC-P4-02`** | Self-Service Registration Abuse | Unverified (`PENDING`) user, `SUSPENDED` user, Platform Super Admin, or user exceeding `D2` quota (`5`) calls `#2 POST /tenants/register`; duplicate/reserved slug submitted | `403`, `422 TENANT_CREATION_QUOTA_EXCEEDED`, `409 TENANT_SLUG_UNAVAILABLE` (zero metadata leaked) |
| **`SEC-P4-03`** | Unauthorized Admin & Permission Escalation | Ordinary member calls admin endpoints (`#4`, `#7`, `#9`, `#11`, `#12`, `#16`–`#25`, `#29`); operator with `tenant:roles:assign` (without `tenant:admins:manage`) attempts to grant `tenant_admin`; admin attempts to grant `tenant_admin` to `CLIENT_PORTAL` member | `403` + `AUTH_TENANT_ADMIN_BOUNDARY_DENIED` / `AUTH_TENANT_PERMISSION_DENIED`; `422` (`42501` in SQL) on `CLIENT_PORTAL` |
| **`SEC-P4-04`** | Primary Owner Hijack & Sole-Admin Self-Removal | Secondary admin calls `#21 POST /workspace/admins/transfer-ownership`; sole `tenant_admin` attempts self-demotion (`#19`), self-revocation (`#17`), or direct SQL `DELETE FROM user_role_assignments` | `403 PRIMARY_OWNER_REQUIRED`; `409 LAST_TENANT_ADMIN_PROTECTED` (`42501` in SQL) |
| **`SEC-P4-05`** | Invitation Replay, Expiry & Resend Rotation | Replay an `ACCEPTED` token; use an `EXPIRED` or `REVOKED` token; use older token `T1` after `#24 resend` issued `T2`; fire two concurrent `Promise.all` accepts on valid token `T2` | `400 INVITATION_INVALID_OR_EXPIRED`; exactly `1` concurrent request succeeds (`FOR UPDATE`) |
| **`SEC-P4-06`** | Cross-Email Hijack & Duplicate Global User | Invite sent to `alice@corp.com`: session for `mallory@evil.com` calls `#27 accept`; unverified `alice@corp.com` calls `#27 accept`; attacker calls `#28 accept-register` when `alice@corp.com` already exists in `public.users` | `403 INVITATION_EMAIL_MISMATCH` (token unburned); `403 EMAIL_NOT_VERIFIED`; `409 USER_ALREADY_REGISTERED_SIGN_IN_TO_ACCEPT` (`1` `users` row preserved) |
| **`SEC-P4-07`** | Slug Throttling, Email Masking & `D4` Directory Privacy | Unauthenticated/unverified caller probes `#1 slug-availability` (`401`/`403`); verified user exceeds `15/min` burst (`429`); `#1` checked on reserved vs existing slug (identical `{ slug, available: false }`); `#26 preview` masks email; ordinary member calls `#15 GET /workspace/members` under default `allow_member_directory_view = false` | `401`/`403`/`429`; uniform `{ slug, available: false }`; masked `a***@corp.com`; `403 MEMBER_DIRECTORY_RESTRICTED` |
| **`SEC-P4-08`** | Cross-Tenant Composite FK Role Injection | Inside Tenant A transaction, attempt `INSERT` into `user_role_assignments` or `tenant_invitations` referencing a `role_id` belonging to Tenant B | Rejected by PostgreSQL composite FK (`23503`) |
| **`SEC-P4-09`** | Lifecycle Matrix & `< 200ms` Suspension Kill-Switch | Platform Super Admin suspends Tenant A (`#33`) -> active Tenant A session immediately calls `/workspace/context`, `/auth/select-organization`, and `#27 /invitations/accept`; attempt outbound transition from `CANCELLED` or missing `reason` | Tenant A calls denied in `< 200ms` (`401`/`403 TENANT_SUSPENDED_OR_INACTIVE`); `CANCELLED -> *` fails `409`; missing `reason` fails `400` |
| **`SEC-P4-10`** | Surgical Multi-Tenant Session Unbinding | User belongs to Tenant A (active) & Tenant B; Tenant A Admin suspends user's Tenant A membership (`#17`) -> test Tenant A call vs global `/auth/me` & Tenant B `/auth/select-organization` | Tenant A fails immediately (`401`/`403`); `users.status` remains `'ACTIVE'`; Tenant B selection succeeds `200` |
| **`SEC-P4-11`** | Malicious Branding Uploads (SVG, Bomb, Corrupt, EXIF, Traversal) | Upload `<script>` `.svg` (and `.svg` renamed `.png`), HTML polyglot, `3 MiB` logo, `10000x10000` pixel-bomb header, corrupt/truncated PNG stream, JPEG with GPS EXIF tags, and `../../evil.png` | `.svg`/HTML `415`; `3 MiB` `413`; pixel-bomb `422`; corrupt stream `422`; valid JPEG stripped of GPS EXIF; server UUID storage key enforced |
| **`SEC-P4-12`** | SQL Injection & Mass Assignment | Inject `' OR 1=1 --` and `"; DROP TABLE tenants; --` into slug check, profile, member search, and audit cursors; send `{ "status": "ACTIVE" }` in `#7 PUT /workspace/organization/profile` | Safely parameterized (`0` SQL errors/leaks); mass-assignment rejected `400` |
| **`SEC-P4-13`** | Direct SQL RLS, Column Grant & `SECURITY DEFINER` Bypass | Under `ft360_app`: unscoped `SELECT` on all `7` new tables (`0` rows); `SELECT token_hash FROM tenant_invitations` (`42501`); direct `UPDATE auth_sessions SET active_tenant_id = ...` (`42501`); call `fn_tenant_*` with mismatched GUC (`42501`) | All blocked by PostgreSQL (`0` rows / `42501`) |
| **`SEC-P4-14`** | Worker & Outbox Suspended-Tenant Gate | Enqueue invitation outbox item and tenant BullMQ job for Tenant A, then suspend Tenant A before worker claims/processes | Outbox claim skips/holds non-operational tenant; BullMQ worker aborts before tx (`ABORTED_TENANT_INACTIVE`) |
| **`SEC-P4-15`** | Redis Namespace & Mail Redaction | Attempt `buildTenantKey` with malformed `tenantId`; capture stdout/stderr across invitation enqueue, retry, and failure | Invalid UUID throws; `0` raw tokens or `/invitations/accept?token=...` URLs in logs |
| **`SEC-P4-16`** | Audit Immutability, Plane Forgery & Secret Keys | Attempt `UPDATE`/`DELETE` on `tenant_audit_logs` (`42501`); cross-tenant `fn_record_tenant_audit_log` (`42501`); nested `{ "items": [{ "token": "x" }] }` in `after_state` (`23514`); verify shared `correlation_id` on dual-written bridge events | All tampering/secret writes blocked; bridge events share exact `correlation_id` |
| **`SEC-P4-17`** | Concurrent 2-Admin Mutual Demotion / Suspension Race | Tenant has exactly 2 `ACTIVE` `INTERNAL` `tenant_admin` members (`Admin 1`, `Admin 2`); fire parallel transactions where `Admin 1` demotes `Admin 2` (`#19`) at the exact instant `Admin 2` suspends `Admin 1` (`#17`) | `SELECT ... FROM public.tenants FOR UPDATE` serializes both transactions; first commits (`1` admin left), second deterministically aborts (`409 LAST_TENANT_ADMIN_PROTECTED` / `42501`) |
| **`SEC-P4-18`** | PostgreSQL Lifecycle Validation During Redis Outage | Simulate total Redis outage (`RedisService` offline): (a) Super Admin suspends Tenant A (`#33`) and Tenant A session immediately calls `/workspace/*` and attempts direct `withTenantTransaction` write; (b) Super Admin attempts direct `ACTIVE -> CANCELLED` (`OD-P1`); (c) verified user calls `#1 slug-availability` | (a) Suspension succeeds in PG (`200`) and both HTTP `/workspace/*` (`401`/`403`) and raw tenant SQL writes (`42501` `fn_is_current_tenant_operational`) fail immediately in `< 200ms`; (b) direct `ACTIVE -> CANCELLED` rejected `409`; (c) `#1` fails closed (`503`) |
| **`SEC-P4-19`** | Concurrent Duplicate Global Email Registration Race | Fire parallel `Promise.all` across (a) two concurrent `#28 POST /invitations/accept-register` calls on Tenant A and Tenant B invitations for `Alice@Corp.com` and `alice@corp.com`, and (b) concurrent `/auth/register` + `#28 accept-register` for the same email | `pg_advisory_xact_lock` + `uq_users_email` / `uq_users_email_normalized` (`23505`) guarantee `COUNT(*) = 1` in `public.users`; winner commits (`201`), loser returns `409 USER_ALREADY_REGISTERED_SIGN_IN_TO_ACCEPT` with its `PENDING` invitation token unburned |
| **`SEC-P4-20`** | Invitation Initiator vs. Recipient Identity Separation | (a) Admin attempts self-invitation (`#23`); (b) SQL attempt to insert `auth_email_outbox` row for `TENANT_INVITATION` with non-null `user_id` (`initiator`); (c) SQL attempt to set `accepted_by_user_id = invited_by_user_id`; (d) initiating admin clicks emailed invite link while signed in as admin (`#27`) | (a) `422 CANNOT_INVITE_SELF`; (b) `23514 chk_auth_email_outbox_anchor`; (c) `23514 chk_ti_initiator_recipient_distinct`; (d) `403 INVITATION_EMAIL_MISMATCH` without consuming token or altering admin membership |
