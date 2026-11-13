# FunnelTrack360 — Phase 4 Backend REST API Specification (`35` Endpoints)

**Phase:** Phase 4 — Tenant Onboarding & Management  
**Base Prefix:** `/api/v1` (Swagger/OpenAPI at `/api/docs` when `SWAGGER_ENABLED=true`)  
**Total Planned Phase 4 Endpoints:** **`35` REST Endpoints** (`#1`–`#35`: `5` User Onboarding / Public Token, `24` Single-Tenant Workspace, `6` Platform Control Plane)  
**Standard Envelope:** `ApiSuccessResponse<T>` (`{ success: true, data: T, meta: { correlationId, timestamp } }`) and `ApiErrorResponse` (`{ success: false, error: { code, message, details? }, meta: { correlationId, timestamp } }`).  
**Global Guard Chain:** `JwtAuthGuard -> CsrfProtectionGuard -> UntrustedTenantInputGuard` (+ route-level `TenantMembershipGuard` + `TenantPermissionGuard` / `TenantAdminGuard` or `PlatformSuperAdminGuard` — with 4-layer PostgreSQL lifecycle validation when Redis is unavailable).  
**Document Status:** `PLANNING BASELINE — PRODUCT & TECHNICAL DECISIONS CONFIRMED (AWAITING PR REVIEW)`  
**Last Updated:** 2026-11-14

---

## Module 4.1 — Tenant Registration (`2` Endpoints)

### Endpoint #1 — `GET /api/v1/tenants/slug-availability`
- **Method & Path:** `GET /api/v1/tenants/slug-availability?slug=<slug>`
- **Purpose:** Checks whether a syntactically valid slug is available for registration while enforcing anti-scraping throttling and zero tenant metadata disclosure *(discloses binary slug occupancy only — does not claim strict slug non-enumeration)*.
- **Auth & Permission:** `JwtAuthGuard` (`users.status = 'ACTIVE'`, `email_verified = TRUE` required); no `tenant:*` permission (pre-tenant User Onboarding Plane).
- **Request Query:** `{ slug: string }`
- **Response (`200 OK`):** `{ slug: string; available: boolean }` *(reserved words and existing tenant slugs return identical `{ slug, available: false }` with zero reason or metadata breakdown).*
- **Validation & Rate Limits:** Lowercase ASCII `3–63` chars matching `^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$` (`400 VALIDATION_ERROR` if malformed); rate-limited `15 req / 60s` per `userId`, `20 req / 60s` per IP, and `100 req / hr` per `userId` (`15-min` lockout on breach); **fails closed (`503 SERVICE_TEMPORARILY_UNAVAILABLE`)** if Redis rate-limit backend is offline.
- **Errors:** `400 VALIDATION_ERROR`, `401 AUTHENTICATION_REQUIRED`, `403 EMAIL_NOT_VERIFIED`, `429 RATE_LIMIT_EXCEEDED`, `503 SERVICE_TEMPORARILY_UNAVAILABLE`.
- **Audit Events:** Rate-limit lockouts write `AUTH_RATE_LIMIT_EXCEEDED` to `auth_audit_logs`.
- **Transaction Boundary:** `withAuthenticatedUserTransaction` calling `fn_check_tenant_slug_available($1)`.

### Endpoint #2 — `POST /api/v1/tenants/register`
- **Method & Path:** `POST /api/v1/tenants/register`
- **Purpose:** Atomically provisions a new organization (`status = 'TRIAL'` per confirmed `D1`), seeds `tenant_admin` & `member` system roles, assigns the caller as `is_primary_owner = TRUE` `tenant_admin`, initializes `1:1` profile/settings/branding/onboarding rows, and binds the caller's session.
- **Auth & Permission:** `JwtAuthGuard` + `CsrfProtectionGuard`; caller must have `status = 'ACTIVE'`, `email_verified = TRUE`, `is_platform_super_admin = FALSE`; User Onboarding Plane.
- **Request Body:** `{ displayName: string; legalName: string; slug: string; organizationType: OrgType; industry: IndustryCode; countryCode: string; defaultTimezone: string; defaultCurrency: string }`
- **Response (`201 Created`):** `{ tenant: TenantEntity; membership: { id: string; membershipType: 'INTERNAL'; status: 'ACTIVE'; isPrimaryOwner: true }; onboarding: { onboardingStatus: 'IN_PROGRESS'; currentStep: 'ORG_PROFILE' }; activeSessionBound: true; effectiveTenantPermissions: string[] }`
- **Validation:** `displayName` (`2–160`), `legalName` (`2–200`), `slug` (`3–63`, non-reserved), `countryCode` (`ISO 3166-1 alpha-2`), `defaultTimezone` (IANA), `defaultCurrency` (`ISO 4217`); quota `<= 5` owned `ACTIVE`/`TRIAL` tenants (`D2`); rate-limited `5 / hr` per user & IP.
- **Errors:** `400 VALIDATION_ERROR`, `403 EMAIL_NOT_VERIFIED` / `SELF_REGISTRATION_DISABLED` / `PLATFORM_ADMIN_CANNOT_OWN_TENANT`, `409 TENANT_SLUG_UNAVAILABLE`, `422 TENANT_CREATION_QUOTA_EXCEEDED`, `429 RATE_LIMIT_EXCEEDED`.
- **Audit Events:** Dual-ledger `TENANT_REGISTERED` (`tenant_audit_logs` + `auth_audit_logs`, shared `correlation_id`).
- **Transaction Boundary:** Single `withAuthenticatedUserTransaction` calling `fn_tenant_provision_organization` (serialized via `pg_advisory_xact_lock`), followed by Redis session cache update and rotated `ft360_at` / `ft360_csrf` cookies.

---

## Module 4.2 — Tenant Onboarding (`3` Endpoints)

### Endpoint #3 — `GET /api/v1/workspace/onboarding`
- **Method & Path:** `GET /api/v1/workspace/onboarding`
- **Purpose:** Retrieves 4-step onboarding status, step completion timestamps, and optimistic lock `version` for the active tenant.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantPermissionGuard` + `@RequirePermissions('tenant:organization:read')`; Single-Tenant (`req.tenantContext`).
- **Response (`200 OK`):** `{ tenantId: string; onboardingStatus: 'IN_PROGRESS' | 'COMPLETED'; currentStep: OnboardingStep; steps: { orgProfile: StepState; orgSettings: StepState; orgBranding: StepState; teamInvites: StepState }; completedAt: string | null; version: number }`
- **Errors:** `401`, `403 TENANT_SUSPENDED_OR_INACTIVE` / `INSUFFICIENT_TENANT_PERMISSIONS`.
- **Audit Events:** Denials write `AUTH_TENANT_PERMISSION_DENIED` to `auth_audit_logs`.
- **Transaction Boundary:** `withVerifiedMemberTransaction`.

### Endpoint #4 — `PATCH /api/v1/workspace/onboarding/steps/:step`
- **Method & Path:** `PATCH /api/v1/workspace/onboarding/steps/:step` (`:step` in `org-profile | org-settings | org-branding | team-invites`)
- **Purpose:** Saves step payload (or marks optional step `skipped: true`) and advances `current_step`.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions('tenant:organization:manage')` (plus `tenant:settings:manage`, `tenant:branding:manage`, or `tenant:invitations:manage` when saving non-skipped data for Steps 2, 3, or 4); Single-Tenant.
- **Request Body:** `{ skipped?: boolean; payload?: OrgProfileDto | OrgSettingsDto | OrgBrandingDto | BatchInviteDto; expectedVersion: number }`
- **Response (`200 OK`):** Updated `TenantOnboardingStatePayload`.
- **Validation & Errors:** `skipped: true` rejected on `org-profile` & `org-settings` (`422 REQUIRED_ONBOARDING_STEP`); stale `expectedVersion` returns `409 ONBOARDING_VERSION_CONFLICT`.
- **Audit Events:** `TENANT_ONBOARDING_STEP_SAVED` (`tenant_audit_logs`, plus underlying profile/settings/branding/invitation audit event).
- **Transaction Boundary:** Single `withVerifiedMemberTransaction`.

### Endpoint #5 — `POST /api/v1/workspace/onboarding/complete`
- **Method & Path:** `POST /api/v1/workspace/onboarding/complete`
- **Purpose:** Validates required steps (`org-profile`, `org-settings`) are complete and finalizes `onboarding_status = 'COMPLETED'`.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions('tenant:organization:manage')`; Single-Tenant.
- **Request Body:** `{ expectedVersion: number }`
- **Response (`200 OK`):** `{ onboardingStatus: 'COMPLETED'; completedAt: string; version: number }`
- **Errors:** `403`, `409 ONBOARDING_VERSION_CONFLICT`, `422 ONBOARDING_PREREQUISITES_INCOMPLETE`.
- **Audit Events:** `TENANT_ONBOARDING_COMPLETED` (`tenant_audit_logs`).
- **Transaction Boundary:** `withVerifiedMemberTransaction` updating `tenant_onboarding_states` and `tenants.onboarding_completed_at`.

---

## Module 4.3 — Organization Profile (`2` Endpoints)

### Endpoint #6 — `GET /api/v1/workspace/organization/profile`
- **Method & Path:** `GET /api/v1/workspace/organization/profile`
- **Purpose:** Reads active organization identity and extended `tenant_profiles` details.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantPermissionGuard` + `@RequirePermissions('tenant:organization:read')`; Single-Tenant.
- **Response (`200 OK`):** `OrganizationProfilePayload` (`slug`, `status`, `displayName`, `legalName`, business/contact/HQ address fields, `version`, `updatedAt`).
- **Errors / Audit / Tx:** `401`, `403`; read-only `withVerifiedMemberTransaction`.

### Endpoint #7 — `PUT /api/v1/workspace/organization/profile`
- **Method & Path:** `PUT /api/v1/workspace/organization/profile`
- **Purpose:** Updates editable organization profile fields with optimistic locking and field-diff auditing.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions('tenant:organization:manage')`; Single-Tenant.
- **Request Body:** `{ displayName, legalName, organizationType, industry, companySizeBand?, registrationNumber?, taxId?, websiteUrl?, primaryContactName?, primaryContactEmail?, primaryContactPhoneE164?, supportEmail?, addressLine1?, addressLine2?, city?, stateProvince?, postalCode?, countryCode, aboutDescription?, expectedVersion }`
- **Response (`200 OK`):** Updated `OrganizationProfilePayload`.
- **Validation & Errors:** `forbidNonWhitelisted: true` (blocks `slug`/`status`); E.164 phone, URL, ISO-2 country; `400`, `403`, `409 PROFILE_VERSION_CONFLICT`.
- **Audit Events:** `TENANT_PROFILE_UPDATED` (`tenant_audit_logs` `before_state` / `after_state` diff).
- **Transaction Boundary:** `withVerifiedMemberTransaction` updating `tenants` (`display_name`, `legal_name`) + `tenant_profiles` + `tenant_audit_logs`.

---

## Module 4.8 — Organization Settings (`2` Endpoints)

### Endpoint #8 — `GET /api/v1/workspace/organization/settings`
- **Method & Path:** `GET /api/v1/workspace/organization/settings`
- **Purpose:** Reads regional, calendar, invitation TTL, and member-directory privacy settings (accelerated via Redis `t:{tenantId}:settings:active` with resilient PostgreSQL fallback on Redis outage).
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantPermissionGuard` + `@RequirePermissions('tenant:settings:read')`; Single-Tenant.
- **Response (`200 OK`):** `TenantSettingsPayload`.
- **Errors / Tx:** `401`, `403`; `withVerifiedMemberTransaction` on cache miss.

### Endpoint #9 — `PUT /api/v1/workspace/organization/settings`
- **Method & Path:** `PUT /api/v1/workspace/organization/settings`
- **Purpose:** Updates `tenant_settings` and synchronizes `tenants.default_timezone` and `tenants.default_currency`.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions('tenant:settings:manage')`; Single-Tenant.
- **Request Body:** `{ timezone, locale, dateFormat, timeFormat, defaultCurrency, weekStartDay, fiscalYearStartMonth, invitationExpiryHours, allowMemberDirectoryView, expectedVersion }`
- **Response (`200 OK`):** Updated `TenantSettingsPayload`.
- **Validation & Errors:** IANA timezone, BCP-47 locale, ISO-4217 currency, `invitationExpiryHours` (`1..720`); `400`, `403`, `409 SETTINGS_VERSION_CONFLICT`.
- **Audit Events:** `TENANT_SETTINGS_UPDATED` (`tenant_audit_logs`).
- **Transaction Boundary:** `withVerifiedMemberTransaction` + post-commit `deleteTenantKey(tenantId, 'settings', 'active')`.

---

## Module 4.9 — Organization Branding (`5` Endpoints)

### Endpoint #10 — `GET /api/v1/workspace/branding`
- **Method & Path:** `GET /api/v1/workspace/branding`
- **Purpose:** Resolves effective branding (`tenant_branding_settings -> platform_branding_settings -> bootstrap defaults`), cached in `t:{tenantId}:branding:resolved` (`TTL 300s`).
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantPermissionGuard` + `@RequirePermissions('tenant:branding:read')`; Single-Tenant.
- **Response (`200 OK`):** `TenantBrandingPayload` (`source: 'TENANT'`).
- **Errors / Tx:** `401`, `403`; `withVerifiedMemberTransaction` on cache miss.

### Endpoint #11 — `PUT /api/v1/workspace/branding`
- **Method & Path:** `PUT /api/v1/workspace/branding`
- **Purpose:** Updates brand identity strings, hex colors, theme mode, and active asset references.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions('tenant:branding:manage')`; Single-Tenant.
- **Request Body:** `{ brandDisplayName?, tagline?, primaryColorHex, accentColorHex, themeMode, logoLightAssetId?, logoDarkAssetId?, faviconAssetId?, supportEmail?, supportUrl?, emailFooterText?, expectedVersion }`
- **Response (`200 OK`):** Updated `TenantBrandingPayload`.
- **Validation & Errors:** `^#[0-9A-Fa-f]{6}$`; composite FK `(tenant_id, *_asset_id)` + matching `asset_kind` & `status = 'ACTIVE'`; `400`, `403`, `409 BRANDING_VERSION_CONFLICT`, `422 INVALID_BRANDING_ASSET_REFERENCE`.
- **Audit Events:** `TENANT_BRANDING_UPDATED` (`tenant_audit_logs`).
- **Transaction Boundary:** `withVerifiedMemberTransaction` + Redis `t:{tenantId}:branding:resolved` invalidation.

### Endpoint #12 — `POST /api/v1/workspace/branding/assets`
- **Method & Path:** `POST /api/v1/workspace/branding/assets` (`multipart/form-data`: `assetKind`, `file`)
- **Purpose:** Validates, decodes, strips metadata, re-encodes, and stores a tenant raster logo or favicon.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions('tenant:branding:manage')`; Single-Tenant.
- **Response (`201 Created`):** `{ assetId, assetKind, mimeType, byteSize, widthPx, heightPx, sha256Checksum, contentUrl }`
- **Validation Pipeline (`OD-T1: sharp` + `OD-T2: @aws-sdk/client-s3`):** (1) `<= 2 MiB` logo / `<= 256 KiB` favicon (`413 PAYLOAD_TOO_LARGE`); (2) `.svg`/HTML/XML unconditionally rejected (`415 UNSUPPORTED_BRANDING_ASSET_TYPE`); (3) magic-byte verify (`PNG`/`JPEG`/`WebP` logos, `PNG`/`WebP` favicons); (4) dimensions & pixel count (`<= 2048x2048` / `<= 4.19 MP` logos; `16..512` square / `<= 0.26 MP` favicons -> `422 INVALID_IMAGE_DIMENSIONS`); (5) full pixel-stream decode via `sharp(..., { limitInputPixels, failOn: 'error' })` (`422 CORRUPT_IMAGE_PAYLOAD`); (6) strip all EXIF/XMP/IPTC/text metadata and re-encode clean buffer via `sharp`; (7) write to `tenants/{tenantId}/branding/{assetKind}/{uuidv7}.{ext}` (local outside web root in dev/CI; private S3 via `@aws-sdk/client-s3` in staging/prod per confirmed `D5`).
- **Audit Events:** `TENANT_BRANDING_ASSET_UPLOADED` (`tenant_audit_logs` — metadata only, never binary bytes).
- **Transaction Boundary:** Object write -> `withVerifiedMemberTransaction` inserting `tenant_branding_assets` + audit row (compensating object delete if DB commit fails).

### Endpoint #13 — `GET /api/v1/workspace/branding/assets/:assetId/content`
- **Method & Path:** `GET /api/v1/workspace/branding/assets/:assetId/content`
- **Purpose:** Streams a tenant's active branding image exclusively to verified members of that tenant.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantPermissionGuard` + `@RequirePermissions('tenant:branding:read')`; Single-Tenant.
- **Response (`200 OK` binary stream):** Headers `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: private, max-age=3600`, `Content-Disposition: inline; filename="brand-asset.{ext}"`.
- **Errors:** `401`, `403`, `404 BRANDING_ASSET_NOT_FOUND` (including any cross-tenant `assetId`!).
- **Transaction Boundary:** `withVerifiedMemberTransaction` resolving `storage_key` under `FORCE RLS` prior to storage stream.

### Endpoint #14 — `DELETE /api/v1/workspace/branding/assets/:assetId`
- **Method & Path:** `DELETE /api/v1/workspace/branding/assets/:assetId`
- **Purpose:** Detaches and deletes a tenant branding asset.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions('tenant:branding:manage')`; Single-Tenant.
- **Response (`200 OK`):** `{ assetId: string; status: 'DELETED' }`
- **Errors / Audit / Tx:** `403`, `404`; writes `TENANT_BRANDING_ASSET_REMOVED` inside `withVerifiedMemberTransaction`, deletes storage object post-commit, and invalidates `t:{tenantId}:branding:resolved`.

---

## Module 4.5 & 4.7 — Tenant Membership, Roles & Administrator Management (`7` Endpoints)

### Endpoint #15 — `GET /api/v1/workspace/members`
- **Method & Path:** `GET /api/v1/workspace/members?status=&roleId=&membershipType=&search=&cursor=&limit=25`
- **Purpose:** Paginated member directory for the active organization.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantPermissionGuard` + `@RequirePermissions('tenant:members:read')`; Single-Tenant.
- **Directory Privacy Enforcement (`D4`):** If caller lacks `tenant:members:manage` and `tenant_settings.allow_member_directory_view === false` (default), returns `403 MEMBER_DIRECTORY_RESTRICTED`. When `true`, ordinary members receive `ACTIVE` members only; callers holding `tenant:members:manage` view all statuses via `fn_tenant_list_workspace_members`.
- **Response (`200 OK`):** `{ items: TenantMemberDirectoryItem[]; nextCursor: string | null }`
- **Errors / Tx:** `401`, `403 MEMBER_DIRECTORY_RESTRICTED`; `withVerifiedMemberTransaction`.

### Endpoint #16 — `PATCH /api/v1/workspace/members/:membershipId`
- **Method & Path:** `PATCH /api/v1/workspace/members/:membershipId`
- **Purpose:** Updates member `jobTitle`, `employeeCode`, or `membershipType`.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions('tenant:members:manage')`; Single-Tenant.
- **Request Body:** `{ jobTitle?: string | null; employeeCode?: string | null; membershipType?: 'INTERNAL' | 'CLIENT_PORTAL' | 'PARTNER' }`
- **Response (`200 OK`):** Updated `TenantMembershipEntity`.
- **Validation & Errors:** Secondary admin cannot modify `is_primary_owner` (`403`); `tenant_admin` holder cannot be changed from `INTERNAL` (`422`); duplicate `employeeCode` returns `409`.
- **Audit / Tx:** `TENANT_MEMBER_UPDATED` (`tenant_audit_logs`); `withVerifiedMemberTransaction`.

### Endpoint #17 — `POST /api/v1/workspace/members/:membershipId/status`
- **Method & Path:** `POST /api/v1/workspace/members/:membershipId/status`
- **Purpose:** Transitions membership status (`SUSPEND`, `REACTIVATE`, `REVOKE`) within the active tenant without affecting `public.users` or other tenants.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions('tenant:members:manage')` (plus `tenant:admins:manage` if target holds `tenant_admin`); Single-Tenant.
- **Request Body:** `{ action: 'SUSPEND' | 'REACTIVATE' | 'REVOKE'; reason: string }`
- **Response (`200 OK`):** `{ membership: TenantMembershipEntity; evictedTenantSessionsCount: number }`
- **Validation & Concurrency:** `reason` `10–500` chars required on `SUSPEND`/`REVOKE`; rejects self-suspend/revoke (`422`), `is_primary_owner` (`409 PRIMARY_OWNER_TRANSFER_REQUIRED`), and last active `tenant_admin` (`409 LAST_TENANT_ADMIN_PROTECTED`, serialized via `SELECT ... FROM tenants FOR UPDATE`).
- **Audit / Tx:** `TENANT_MEMBER_SUSPENDED` / `TENANT_MEMBER_REACTIVATED` / `TENANT_MEMBER_REVOKED` (`tenant_audit_logs`); `withVerifiedMemberTransaction` calling `fn_tenant_evict_member_sessions` + Redis session eviction.

### Endpoint #18 — `GET /api/v1/workspace/roles`
- **Method & Path:** `GET /api/v1/workspace/roles`
- **Purpose:** Lists tenant-scoped roles (`id`, `slug`, `name`, `isSystemRole`, `dataAccessScope`) for invitation and role-assignment dropdowns.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions('rbac:roles:read')`; Single-Tenant.
- **Response (`200 OK`):** `{ roles: RoleSummary[] }`
- **Errors / Tx:** `401`, `403`; `withVerifiedMemberTransaction`.

### Endpoint #19 — `PUT /api/v1/workspace/members/:membershipId/roles`
- **Method & Path:** `PUT /api/v1/workspace/members/:membershipId/roles`
- **Purpose:** Atomically assigns/replaces a member's tenant roles (`1..N`).
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions('tenant:roles:assign')` (plus `tenant:admins:manage` whenever adding or removing `tenant_admin`); Single-Tenant.
- **Request Body:** `{ roleIds: string[]; reason?: string }`
- **Response (`200 OK`):** `{ membershipId: string; roles: RoleEntity[] }`
- **Validation & Concurrency:** Non-empty `roleIds` belonging to active tenant (composite FK `fk_ura_tenant_role`); `CLIENT_PORTAL`/`PARTNER` blocked from `tenant_admin` (`422`); serialized last-admin anti-lockout (`409 LAST_TENANT_ADMIN_PROTECTED`).
- **Audit / Tx:** `TENANT_MEMBER_ROLES_UPDATED` (`tenant_audit_logs`); `withVerifiedMemberTransaction`.

### Endpoint #20 — `GET /api/v1/workspace/admins`
- **Method & Path:** `GET /api/v1/workspace/admins`
- **Purpose:** Lists all members holding `tenant_admin` in the active tenant with `isPrimaryOwner` status.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions('tenant:admins:read')`; Single-Tenant.
- **Response (`200 OK`):** `{ items: TenantAdminRosterItem[]; activeInternalAdminCount: number }`
- **Errors / Tx:** `401`, `403`; `withVerifiedMemberTransaction`.

### Endpoint #21 — `POST /api/v1/workspace/admins/transfer-ownership`
- **Method & Path:** `POST /api/v1/workspace/admins/transfer-ownership`
- **Purpose:** Atomically transfers `is_primary_owner = TRUE` from the caller to another `ACTIVE` `INTERNAL` `tenant_admin` in the same tenant.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions('tenant:admins:manage')` + `caller.isPrimaryOwner === true`; Single-Tenant.
- **Request Body:** `{ targetMembershipId: string; confirmationSlug: string; reason: string }`
- **Response (`200 OK`):** `{ previousOwnerMembershipId: string; newOwnerMembershipId: string }`
- **Errors:** `400`, `403 PRIMARY_OWNER_REQUIRED`, `409`, `422 TARGET_MUST_BE_ACTIVE_INTERNAL_ADMIN`.
- **Audit / Tx:** `TENANT_PRIMARY_OWNER_TRANSFERRED` (`tenant_audit_logs`); `withVerifiedMemberTransaction` calling `fn_tenant_transfer_primary_owner` (`FOR UPDATE` on `tenants`).

---

## Module 4.6 — User Invitations (`7` Endpoints)

### Endpoint #22 — `GET /api/v1/workspace/invitations`
- **Method & Path:** `GET /api/v1/workspace/invitations?status=&search=&cursor=&limit=25`
- **Purpose:** Lists tenant invitations without exposing `token_hash`.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions('tenant:invitations:read')`; Single-Tenant.
- **Response (`200 OK`):** `{ items: TenantInvitationSummary[]; nextCursor: string | null }`
- **Errors / Tx:** `401`, `403`; `withVerifiedMemberTransaction`.

### Endpoint #23 — `POST /api/v1/workspace/invitations`
- **Method & Path:** `POST /api/v1/workspace/invitations`
- **Purpose:** Issues a cryptographic single-use email invitation and enqueues sealed outbox delivery, strictly separating the **initiating admin identity** (`invited_by_user_id` / `invited_by_membership_id` from server GUC, `auth_email_outbox.user_id = NULL` & `initiated_by_user_id = actorUserId`) from the **invitation recipient identity** (`invited_email`, `accepted_by_user_id = NULL` while `PENDING`).
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions('tenant:invitations:manage')` (plus `tenant:admins:manage` if `targetRoleId` is `tenant_admin`); Single-Tenant.
- **Request Body:** `{ email: string; membershipType: 'INTERNAL' | 'CLIENT_PORTAL' | 'PARTNER'; targetRoleId: string; jobTitle?: string }`
- **Response (`201 Created`):** `TenantInvitationSummary`.
- **Errors:** `400`, `403`, `409 MEMBER_ALREADY_EXISTS_IN_TENANT` / `INVITATION_ALREADY_PENDING`, `422 CANNOT_INVITE_SELF` / `INVALID_ROLE_FOR_MEMBERSHIP_TYPE`, `429`.
- **Audit / Tx:** `TENANT_INVITATION_CREATED` (`tenant_audit_logs`, `actor_user_id = inviterUserId`); `withVerifiedMemberTransaction` calling `fn_tenant_issue_or_resend_invitation` + `fn_tenant_enqueue_invitation_email_outbox` (`kind = 'TENANT_INVITATION'`, `user_id = NULL`), followed by BullMQ `{ outboxId, correlationId }` enqueue.

### Endpoint #24 — `POST /api/v1/workspace/invitations/:invitationId/resend`
- **Method & Path:** `POST /api/v1/workspace/invitations/:invitationId/resend`
- **Purpose:** Rotates CSPRNG `token_hash` (invalidating old link), extends `expires_at`, supersedes unsent outbox rows, and dispatches a fresh email.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions('tenant:invitations:manage')` (+ `tenant:admins:manage` if `tenant_admin`); Single-Tenant.
- **Response (`200 OK`):** Updated `TenantInvitationSummary`.
- **Errors:** `403`, `404`, `409 INVITATION_NOT_PENDING`, `422 RESEND_LIMIT_EXCEEDED`, `429 RESEND_COOLDOWN_ACTIVE`.
- **Audit / Tx:** `TENANT_INVITATION_RESENT` (`tenant_audit_logs`); `withVerifiedMemberTransaction` + BullMQ enqueue.

### Endpoint #25 — `POST /api/v1/workspace/invitations/:invitationId/revoke`
- **Method & Path:** `POST /api/v1/workspace/invitations/:invitationId/revoke`
- **Purpose:** Immediately revokes a `PENDING` invitation and wipes any unsent outbox ciphertext.
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions('tenant:invitations:manage')` (+ `tenant:admins:manage` if `tenant_admin`); Single-Tenant.
- **Request Body:** `{ reason?: string }`
- **Response (`200 OK`):** `{ id: string; status: 'REVOKED'; revokedAt: string }`
- **Errors / Audit / Tx:** `403`, `404`, `409 INVITATION_NOT_PENDING`; `TENANT_INVITATION_REVOKED`; `withVerifiedMemberTransaction`.

### Endpoint #26 — `GET /api/v1/invitations/preview`
- **Method & Path:** `GET /api/v1/invitations/preview?token=<rawToken>`
- **Purpose:** Validates an emailed `256-bit` CSPRNG invitation token and returns masked invitation summary metadata.
- **Auth & Rate Limit:** `@Public()`, IP rate-limited `20 req / 60s`.
- **Response (`200 OK`):** `{ valid: true; tenantDisplayName: string; roleName: string; membershipType: MembershipType; invitedEmailMasked: string; expiresAt: string; existingAccountDetected: boolean }`
- **Errors:** `400 INVITATION_INVALID_OR_EXPIRED`, `403 TENANT_SUSPENDED_OR_INACTIVE`, `429`.
- **Audit / Tx:** Read-only unscoped call to `fn_invitation_preview_by_token(tokenHash)`.

### Endpoint #27 — `POST /api/v1/invitations/accept`
- **Method & Path:** `POST /api/v1/invitations/accept`
- **Purpose:** Atomically accepts a `PENDING` invitation for an already-authenticated, verified global user whose identity is distinct from `invited_by_user_id` and whose normalized email matches `invited_email`.
- **Auth & Gate:** `JwtAuthGuard` + `CsrfProtectionGuard`; `users.status = 'ACTIVE'`, `email_verified = TRUE`, `is_platform_super_admin = FALSE`, `users.id <> invitation.invited_by_user_id`, `LOWER(btrim(users.email)) === LOWER(btrim(invitation.invited_email))`.
- **Request Body:** `{ token: string }`
- **Response (`200 OK`):** `SelectOrganizationResponsePayload` (with active session bound to the invited tenant + rotated cookies).
- **Errors:** `400 INVITATION_INVALID_OR_EXPIRED`, `401`, `403 EMAIL_NOT_VERIFIED` / `INVITATION_EMAIL_MISMATCH` / `TENANT_SUSPENDED_OR_INACTIVE` / `PLATFORM_ADMIN_CANNOT_JOIN_TENANT`, `409 MEMBER_ALREADY_EXISTS_IN_TENANT`.
- **Audit / Tx:** Dual-ledger `TENANT_INVITATION_ACCEPTED` (`actor_user_id = recipientUserId`, `metadata.invitedByUserId = inviterUserId` in `tenant_audit_logs` + `auth_audit_logs`); atomic `withAuthenticatedUserTransaction` calling `fn_invitation_accept_existing_user` (`FOR UPDATE` on `tenant_invitations` + `fn_assert_tenant_operational`).

### Endpoint #28 — `POST /api/v1/invitations/accept-register`
- **Method & Path:** `POST /api/v1/invitations/accept-register`
- **Purpose:** Atomically creates a verified global `users` account, accepts the single-use invitation, creates `ACTIVE` membership + role assignment, and issues an authenticated tenant-bound session for a brand-new invitee—enforcing strict database email uniqueness under concurrent registration races.
- **Auth & Gate:** `@Public()` + pre-auth `CsrfProtectionGuard` + IP rate-limit (`10 req / 60s`).
- **Request Body:** `{ token: string; fullName: string; password: string; phoneE164?: string }`
- **Response (`201 Created`):** `LoginResponsePayload` (with `HttpOnly` session cookies bound to the invited tenant).
- **Errors:** `400 INVITATION_INVALID_OR_EXPIRED` / `VALIDATION_ERROR`, `403 TENANT_SUSPENDED_OR_INACTIVE`, `409 USER_ALREADY_REGISTERED_SIGN_IN_TO_ACCEPT` (mapped from `pg_advisory_xact_lock` check and PostgreSQL `SQLSTATE 23505` on `uq_users_email` / `uq_users_email_normalized`, preserving the losing `PENDING` invitation unburned), `429`.
- **Audit / Tx:** Dual-ledger `AUTH_USER_REGISTERED_VIA_INVITATION` (`auth_audit_logs`) + `TENANT_INVITATION_ACCEPTED` (`tenant_audit_logs`, `actor_user_id = recipientUserId`, `metadata.invitedByUserId = inviterUserId`); Argon2id hash followed by single atomic transaction calling `fn_invitation_accept_new_user` (`FOR UPDATE` on `tenant_invitations`, `fn_assert_tenant_operational`, and `pg_advisory_xact_lock` + `uq_users_email`).

---

## Module 4.10 — Tenant Workspace Audit Logs (`1` Workspace Endpoint)

### Endpoint #29 — `GET /api/v1/workspace/audit-logs`
- **Method & Path:** `GET /api/v1/workspace/audit-logs?eventType=&resourceType=&actorUserId=&from=&to=&cursor=&limit=50`
- **Purpose:** Queries append-only `tenant_audit_logs` within the active tenant (`FORCE RLS`).
- **Auth, Permission & Context:** `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions('audit:tenant:read')`; Single-Tenant.
- **Response (`200 OK`):** `{ items: TenantAuditLogEntry[]; nextCursor: string | null }`
- **Errors / Tx:** `401`, `403`; `withVerifiedMemberTransaction`.

---

## Module 4.1, 4.4, 4.5 & 4.10 — Platform Control Plane (`6` Endpoints)

### Endpoint #30 — `GET /api/v1/platform/tenants`
- **Method & Path:** `GET /api/v1/platform/tenants?status=&search=&cursor=&limit=25`
- **Purpose:** Global tenant directory with status, onboarding progress, member counts, and timestamps.
- **Auth, Permission & Context:** `PlatformSuperAdminGuard` + `@RequirePlatformPermissions('platform:tenants:read')` (`activeTenantId === null`).
- **Response (`200 OK`):** `{ items: PlatformTenantSummary[]; nextCursor: string | null }`
- **Errors / Tx:** `401`, `403`; `withPlatformAdminTransaction`.

### Endpoint #31 — `POST /api/v1/platform/tenants`
- **Method & Path:** `POST /api/v1/platform/tenants`
- **Purpose:** Platform-assisted tenant provisioning with mandatory `reason` and initial customer administrator assignment/invitation.
- **Auth, Permission & Context:** `PlatformSuperAdminGuard` + `CsrfProtectionGuard` + `@RequirePlatformPermissions('platform:tenants:manage')`.
- **Request Body:** `{ displayName, legalName, slug, initialStatus: 'PROVISIONING' | 'TRIAL' | 'ACTIVE', initialAdminEmail, organizationType, industry, countryCode, defaultTimezone, defaultCurrency, reason }`
- **Response (`201 Created`):** `{ tenant: TenantEntity; initialAdminMode: 'BOUND_EXISTING_USER' | 'INVITATION_DISPATCHED'; invitationId?: string }`
- **Errors / Audit / Tx:** `400`, `403`, `409 TENANT_SLUG_UNAVAILABLE`; dual-ledger `PLATFORM_TENANT_PROVISIONED`; `withPlatformAdminTransaction`.

### Endpoint #32 — `GET /api/v1/platform/tenants/:tenantId`
- **Method & Path:** `GET /api/v1/platform/tenants/:tenantId` (`@AllowExplicitTenantTarget()`)
- **Purpose:** Inspects full tenant metadata, profile summary, lifecycle status/reason, onboarding state, and admin summary from the control plane.
- **Auth, Permission & Context:** `PlatformSuperAdminGuard` + `@RequirePlatformPermissions('platform:tenants:read')`.
- **Response (`200 OK`):** `PlatformTenantDetailPayload`.
- **Errors / Tx:** `401`, `403`, `404 TENANT_NOT_FOUND`; `withPlatformAdminTransaction`.

### Endpoint #33 — `POST /api/v1/platform/tenants/:tenantId/lifecycle`
- **Method & Path:** `POST /api/v1/platform/tenants/:tenantId/lifecycle` (`@AllowExplicitTenantTarget()`)
- **Purpose:** Executes state-machine transitions (`ACTIVATE`, `SUSPEND`, `REACTIVATE`, `DEACTIVATE`, `CANCEL`) with mandatory `reason`, synchronous PostgreSQL active-session unbinding, and bounded Redis cache invalidation.
- **Auth, Permission & Context:** `PlatformSuperAdminGuard` + `CsrfProtectionGuard` + `@RequirePlatformPermissions('platform:tenants:manage')`.
- **Request Body:** `{ action: 'ACTIVATE' | 'SUSPEND' | 'REACTIVATE' | 'DEACTIVATE' | 'CANCEL'; targetStatus?: 'TRIAL' | 'ACTIVE'; confirmationSlug: string; reason: string }`
- **Response (`200 OK`):** `{ tenant: TenantEntity; previousStatus: TenantStatus; evictedActiveSessionsCount: number }`
- **Validation & Errors:** `reason` `10–500` chars; `confirmationSlug` must match tenant slug; transition validated against Section 4.4.A matrix (**including confirmed `OD-P1`: operational `TRIAL`/`ACTIVE` tenants must transition to `SUSPENDED` or `DEACTIVATED` before `CANCELLED`**; `CANCELLED` terminal -> `409 INVALID_TENANT_STATUS_TRANSITION`).
- **Audit / Tx:** Dual-ledger `PLATFORM_TENANT_STATUS_CHANGED`; `withPlatformAdminTransaction` calling `fn_platform_transition_tenant_status` + resilient post-commit Redis invalidation (`0ms` DB staleness enforced via 4-layer PostgreSQL lifecycle validation even when Redis is unavailable).

### Endpoint #34 — `POST /api/v1/platform/tenants/:tenantId/recover-owner`
- **Method & Path:** `POST /api/v1/platform/tenants/:tenantId/recover-owner` (`@AllowExplicitTenantTarget()`)
- **Purpose:** Break-glass reassignment of `is_primary_owner` when a customer's primary owner is unavailable.
- **Auth, Permission & Context:** `PlatformSuperAdminGuard` + `CsrfProtectionGuard` + `@RequirePlatformPermissions('platform:tenants:manage')`.
- **Request Body:** `{ targetMembershipId: string; confirmationSlug: string; reason: string }`
- **Response (`200 OK`):** `{ tenantId: string; newOwnerMembershipId: string }`
- **Errors / Audit / Tx:** `400`, `403`, `404`, `422`; dual-ledger `PLATFORM_TENANT_OWNER_RECOVERED`; `withPlatformAdminTransaction` calling `fn_tenant_transfer_primary_owner` (`FOR UPDATE` on `tenants`).

### Endpoint #35 — `GET /api/v1/platform/tenants/:tenantId/audit-logs`
- **Method & Path:** `GET /api/v1/platform/tenants/:tenantId/audit-logs?eventType=&resourceType=&cursor=&limit=50` (`@AllowExplicitTenantTarget()`)
- **Purpose:** Inspects append-only `tenant_audit_logs` for a specific tenant from the Platform Control Plane.
- **Auth, Permission & Context:** `PlatformSuperAdminGuard` + `@RequirePlatformPermissions('platform:audit:read')`.
- **Response (`200 OK`):** `{ items: TenantAuditLogEntry[]; nextCursor: string | null }`
- **Errors / Tx:** `401`, `403`, `404`; `withPlatformAdminTransaction`.
