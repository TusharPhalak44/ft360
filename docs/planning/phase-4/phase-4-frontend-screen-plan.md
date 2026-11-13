# FunnelTrack360 — Phase 4 Frontend Screen Plan (`14` Route-Views)

**Phase:** Phase 4 — Tenant Onboarding & Management  
**Framework:** Next.js 15 App Router (`apps/web/src/app/**/page.tsx`), React 19, TypeScript, Tailwind CSS  
**Total Planned Frontend Route-Views:** **`14` Route-Views** (`RV-01`–`RV-14`: **`11` New `page.tsx` Routes** + **`3` Updated Existing Phase 3 `page.tsx` Routes**, plus a header navigation link in existing `/platform` `src/app/platform/page.tsx`)  
**Design System Alignment:** Preserves FunnelTrack360 tokens (`bg-slate-50` canvas, `bg-white border-slate-200 rounded-2xl shadow-sm` cards, `slate-900` typography, CSS variables `--brand-primary` & `--brand-accent`, `X-Correlation-Id` error banners, and CSRF handshake in `apps/web/src/lib/api/client.ts`).  
**Zero Backend Logic in Next.js:** All validation, authorization, and persistence execute in NestJS (`apps/api`).  
**Document Status:** `PLANNING BASELINE — PRODUCT & TECHNICAL DECISIONS CONFIRMED (AWAITING PR REVIEW)`  
**Last Updated:** 2026-11-14

---

## 1. Route-View Inventory & Shared `WorkspaceAdminLayout`

| ID | Route Path | App Router File (`apps/web/src/app/...`) | Change Type | Plane |
|---|---|---|---|---|
| **`RV-01`** | `/organizations/new` | `organizations/new/page.tsx` | **New** | User Onboarding |
| **`RV-02`** | `/select-organization` | `select-organization/page.tsx` | **Updated (Phase 3)** | User Onboarding |
| **`RV-03`** | `/workspace/onboarding` | `workspace/onboarding/page.tsx` | **New** | Single Tenant |
| **`RV-04`** | `/workspace` | `workspace/page.tsx` | **Updated (Phase 3)** | Single Tenant |
| **`RV-05`** | `/workspace/organization/profile` | `workspace/organization/profile/page.tsx` | **New** | Single Tenant |
| **`RV-06`** | `/workspace/organization/settings` | `workspace/organization/settings/page.tsx` | **New** | Single Tenant |
| **`RV-07`** | `/workspace/organization/branding` | `workspace/organization/branding/page.tsx` | **New** | Single Tenant |
| **`RV-08`** | `/workspace/admins` | `workspace/admins/page.tsx` | **New** | Single Tenant |
| **`RV-09`** | `/workspace/members` | `workspace/members/page.tsx` | **New** | Single Tenant |
| **`RV-10`** | `/workspace/invitations` | `workspace/invitations/page.tsx` | **New** | Single Tenant |
| **`RV-11`** | `/workspace/admin` | `workspace/admin/page.tsx` | **Updated (Phase 3)** | Single Tenant |
| **`RV-12`** | `/invitations/accept` | `invitations/accept/page.tsx` | **New** | Public / User Onboarding |
| **`RV-13`** | `/platform/tenants` | `platform/tenants/page.tsx` | **New** | Platform Global |
| **`RV-14`** | `/platform/tenants/[tenantId]` | `platform/tenants/[tenantId]/page.tsx` | **New** | Platform Global |

### Shared Primitives (`apps/web/src/components/`)
- **`WorkspaceAdminLayout.tsx`:** Top bar (authenticated tenant logo via `#13`, organization display name + `TRIAL`/`ACTIVE` pill, `Switch Organization` -> `/select-organization`, user menu) + permission-filtered left navigation (`Overview`, `Onboarding Setup` [while `IN_PROGRESS` & `tenant:organization:manage`], `Organization Profile`, `Preferences & Settings`, `Brand Identity`, `Team Members` [hidden for ordinary members when `allowMemberDirectoryView === false` per `D4`], `Invitations`, `Administrators`, `Security & Audit Logs`).
- **`SectionSkeleton`, `EmptyStateCard`, `ApiCorrelationErrorBanner`, `ConfirmReasonModal`** (`10–500` char `reason` + optional `confirmationSlug`), and **`ToastBanner`**.

---

## 2. Page-by-Page Route-View Specifications (`RV-01` – `RV-14`)

### RV-01: Self-Service Tenant Registration (`/organizations/new` — *New*)
- **Purpose:** Allows an authenticated, verified non-Super-Admin user to create a new organization (`Module 4.1`).
- **Layout:** Centered `AuthShell` (`wide`) card with 2-column desktop form grid and live URL slug preview.
- **Components:** `SlugAvailabilityField` (`400ms` debounced check against `#1`), `IndustrySelect`, `CountryTimezoneCurrencyGroup`, `PrimarySubmitButton`.
- **Form Fields:** `displayName`, `legalName`, `slug`, `organizationType`, `industry`, `countryCode`, `defaultTimezone` (auto-detected IANA), `defaultCurrency`.
- **Validation:** `displayName` (`2–160`), `legalName` (`2–200`), `slug` `^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$`.
- **Loading / Empty / Error / Success States:** `GET /auth/me` guard skeleton & inline slug spinner; pre-populated browser timezone; inline field errors, `"Slug unavailable"` notice on `available: false` or `409`, and correlation banner on `422` quota / `429` / `503`; toast + immediate redirect to `/workspace/onboarding` on `201`.
- **Permission Visibility:** Verified non-Super-Admin users (`unverified -> /verify-email`, `Super Admin -> /platform/tenants`).
- **API Integration:** `GET /auth/me`, `#1 GET /tenants/slug-availability`, `#2 POST /tenants/register`.
- **Responsive Behavior:** 2-column grid on `md+`, stacked single column on `<768px`.

### RV-02: Organization Switcher & Creation Entry (`/select-organization` — *Updated Phase 3*)
- **Purpose:** Lets multi-org users switch active organizations or launch `/organizations/new` when creating their first or additional workspace.
- **Layout:** Existing `AuthShell` card enhanced with header `Create New Organization` button and footer invitation notice.
- **Components:** `OrganizationSelectorList`, `CreateOrganizationCtaCard` (links to `/organizations/new`), `SignOutButton`.
- **Form Fields:** Selected organization radio/action card (`POST /auth/select-organization`).
- **Validation:** Valid UUID selection.
- **Loading / Empty / Error / Success States:** Organization list skeleton; when `organizations.length === 0`, prominent `"You don't belong to an organization yet"` empty state with primary `Create Organization` button; `403 TENANT_SUSPENDED_OR_INACTIVE` inline alert if an org was suspended since page load; redirects to `/workspace` (or `/workspace/onboarding` if `IN_PROGRESS` admin) on selection.
- **Permission Visibility:** Authenticated non-Super-Admin users (`email_verified === true`).
- **API Integration:** `GET /auth/me`, `POST /auth/select-organization`.
- **Responsive Behavior:** Centered single-column list (`max-w-lg`) across mobile and desktop.

### RV-03: Organization Onboarding Wizard (`/workspace/onboarding` — *New*)
- **Purpose:** Guides Tenant Admins through the resumable 4-step initial setup (`Module 4.2`).
- **Layout:** `WorkspaceAdminLayout` with 4-step horizontal stepper (`1. Profile -> 2. Settings -> 3. Branding [Optional] -> 4. Invite Team [Optional]`).
- **Components:** `OnboardingStepper`, `StepProfileForm`, `StepSettingsForm`, `StepBrandingForm`, `StepBatchInvitesForm`, `OnboardingCompleteSummary`.
- **Form Fields:** Step 1 (`organizationType`, `industry`, `companySizeBand`, `websiteUrl`, contacts, HQ address); Step 2 (`timezone`, `locale`, `dateFormat`, `timeFormat`, `defaultCurrency`, `weekStartDay`, `fiscalYearStartMonth`, `invitationExpiryHours`, `allowMemberDirectoryView`); Step 3 (`brandDisplayName`, `primaryColorHex`, `accentColorHex`, `logoLight` file); Step 4 (up to `5` `{ email, membershipType, targetRoleId, jobTitle }` rows).
- **Validation:** Per-step DTO validation before enabling `Save & Continue`; Steps 1 & 2 required before final completion.
- **Loading / Empty / Error / Success States:** Stepper skeleton on initial load; pre-hydrated from registration defaults; `409 ONBOARDING_VERSION_CONFLICT` reload banner; completion summary card with `Go to Workspace Overview` (`/workspace`).
- **Permission Visibility:** Requires `tenant:organization:manage` (ordinary members visiting `/workspace/onboarding` redirect to `/workspace`).
- **API Integration:** `#3 GET /workspace/onboarding`, `#4 PATCH /workspace/onboarding/steps/:step`, `#12 POST /workspace/branding/assets`, `#18 GET /workspace/roles`, `#5 POST /workspace/onboarding/complete`.
- **Responsive Behavior:** Full step labels on `md+`, compact numbered step pills (`Step 2 of 4`) on mobile.

### RV-04: Organization Dashboard Overview (`/workspace` — *Updated Phase 3*)
- **Purpose:** Main tenant workspace landing view displaying active tenant posture, incomplete-onboarding banner, branding theme, and active sessions.
- **Layout:** `WorkspaceAdminLayout` with top alert slot, 4-card KPI grid, and active session security panel.
- **Components:** `OnboardingIncompleteBanner` (admin-only when `IN_PROGRESS`), `WorkspaceOverviewCards`, `SuspendedWorkspaceModal` (if `403 TENANT_SUSPENDED_OR_INACTIVE` occurs mid-session), `ActiveSessionsTable` (existing Phase 3 component).
- **Form Fields:** Session revocation controls (`Sign Out`, `Sign Out All Devices`).
- **Validation:** N/A (read/action view).
- **Loading / Empty / Error / Success States:** 4 shimmer KPI cards; if `activeOrganization === null`, redirects/prompts `/select-organization` or `/organizations/new`; non-dismissible suspended-organization card with `Switch Organization` CTA on `403 TENANT_SUSPENDED_OR_INACTIVE`; live `--brand-primary` styling on load.
- **Permission Visibility:** All active tenant members; admin quick-actions gated by `tenant:organization:manage` / `tenant:invitations:manage`.
- **API Integration:** `GET /auth/me`, `GET /workspace/context`, `#3 GET /workspace/onboarding`, `#10 GET /workspace/branding`.
- **Responsive Behavior:** `grid-cols-1 sm:grid-cols-2 xl:grid-cols-4`.

### RV-05: Organization Profile Page (`/workspace/organization/profile` — *New*)
- **Purpose:** View and edit organization legal, industry, contact, and HQ address information (`Module 4.3`).
- **Layout:** `WorkspaceAdminLayout` with sectioned cards (`Core Identity`, `Classification`, `Contacts`, `Headquarters Address`) and sticky dirty-state save bar.
- **Components:** `ReadOnlySlugBadge`, `OrganizationProfileForm`.
- **Form Fields:** `displayName`, `legalName`, `organizationType`, `industry`, `companySizeBand`, `registrationNumber`, `taxId`, `websiteUrl`, `primaryContactName`, `primaryContactEmail`, `primaryContactPhoneE164`, `supportEmail`, `addressLine1`, `addressLine2`, `city`, `stateProvince`, `postalCode`, `countryCode`, `aboutDescription`.
- **Validation:** Required `displayName`, `legalName`, `organizationType`, `industry`, `countryCode`; E.164 phone; `http(s)://` URL; `<= 1000` chars description.
- **Loading / Empty / Error / Success States:** Form skeleton; `"Not configured"` placeholders in read-only mode; `409 PROFILE_VERSION_CONFLICT` alert; `"Organization profile saved"` toast + updated `version`.
- **Permission Visibility:** Read-only for `tenant:organization:read`; editable for `tenant:organization:manage`.
- **API Integration:** `#6 GET /workspace/organization/profile`, `#7 PUT /workspace/organization/profile`.
- **Responsive Behavior:** 2-column form sections on `md+`, stacked mobile layout.

### RV-06: Tenant Preferences & Settings Page (`/workspace/organization/settings` — *New*)
- **Purpose:** Configure timezone, locale, date/time/currency formatting, invitation TTL, and member directory privacy (`Module 4.8`).
- **Layout:** `WorkspaceAdminLayout` with `Regional & Formatting`, `Calendar & Fiscal Year`, and `Invitation & Directory Privacy` cards + live preview box.
- **Components:** `TimezoneCombobox`, `LocaleSelect`, `FormatLivePreview`, `DirectoryPrivacyToggle` (defaults `false` per `D4`).
- **Form Fields:** `timezone`, `locale`, `dateFormat`, `timeFormat`, `defaultCurrency`, `weekStartDay`, `fiscalYearStartMonth`, `invitationExpiryHours` (`1–720`), `allowMemberDirectoryView`.
- **Validation:** Valid IANA timezone, ISO-4217 currency, integer `1..720` on `invitationExpiryHours`.
- **Loading / Empty / Error / Success States:** Card skeletons; populated from `1:1` defaults; `409 SETTINGS_VERSION_CONFLICT` banner; save toast.
- **Permission Visibility:** Read-only for `tenant:settings:read`; editable for `tenant:settings:manage`.
- **API Integration:** `#8 GET /workspace/organization/settings`, `#9 PUT /workspace/organization/settings`.
- **Responsive Behavior:** Preview panel stacks above sticky save bar on `<1024px`.

### RV-07: Organization Branding Settings Page (`/workspace/organization/branding` — *New*)
- **Purpose:** Configure brand colors, theme mode, and upload decoded raster logos/favicons (`Module 4.9`).
- **Layout:** `WorkspaceAdminLayout` 60/40 desktop split (form + asset dropzones on left, live workspace header/button preview on right).
- **Components:** `ColorHexPickerInput` (WCAG contrast badge), `SecureAssetDropzone` (`LOGO_LIGHT`, `LOGO_DARK`, `FAVICON`), `LiveBrandPreviewPanel`.
- **Form Fields:** `brandDisplayName`, `tagline`, `primaryColorHex`, `accentColorHex`, `themeMode`, `supportEmail`, `supportUrl`, `emailFooterText`, plus raster file inputs.
- **Validation:** Client pre-check rejecting `.svg`/`.html`, files `> 2 MiB` (`> 256 KiB` favicon), and invalid hex strings before upload.
- **Loading / Empty / Error / Success States:** Per-slot upload spinner; platform fallback badge when unset; clear error banners on `413` size, `415` unsupported SVG/format, or `422` dimension/corrupt image; live CSS custom property update on save.
- **Permission Visibility:** Read-only preview for `tenant:branding:read`; upload/save/delete enabled for `tenant:branding:manage`.
- **API Integration:** `#10 GET /workspace/branding`, `#11 PUT /workspace/branding`, `#12 POST /workspace/branding/assets`, `#13 GET /workspace/branding/assets/:assetId/content`, `#14 DELETE /workspace/branding/assets/:assetId`.
- **Responsive Behavior:** Preview stacks below controls on `<1024px`.

### RV-08: Tenant Administrator Management Page (`/workspace/admins` — *New*)
- **Purpose:** View `tenant_admin` holders, promote `INTERNAL` members, demote secondary admins, and transfer `Primary Owner` (`Module 4.5`).
- **Layout:** `WorkspaceAdminLayout` with `Primary Owner` card, `Administrator Roster` table, `PromoteAdminModal`, and `TransferOwnershipModal`.
- **Components:** `PrimaryOwnerCard`, `AdminRosterTable`, `PromoteAdminModal`, `TransferOwnershipModal`.
- **Form Fields:** Promote (`membershipId`, `reason`); Transfer Ownership (`targetMembershipId`, `confirmationSlug`, `reason`).
- **Validation:** `confirmationSlug` exact match; `reason` `10–500` chars; demote disabled when `activeInternalAdminCount <= 1` or target `isPrimaryOwner === true`.
- **Loading / Empty / Error / Success States:** Table skeleton; never empty (`>= 1` admin invariant); `409 LAST_TENANT_ADMIN_PROTECTED` banner on concurrent race; toast + immediate badge update on transfer.
- **Permission Visibility:** Visible to `tenant:admins:read`; promote/demote requires `tenant:admins:manage`; ownership transfer requires `tenant:admins:manage` **and** `isPrimaryOwner === true`.
- **API Integration:** `#20 GET /workspace/admins`, `#15 GET /workspace/members`, `#18 GET /workspace/roles`, `#19 PUT /workspace/members/:id/roles`, `#21 POST /workspace/admins/transfer-ownership`.
- **Responsive Behavior:** Table collapses to stacked cards below `sm`.

### RV-09: Tenant Member Directory & Role Management Page (`/workspace/members` — *New*)
- **Purpose:** Searchable member directory, metadata editing, role assignment, and membership suspension/reactivation/revocation (`Module 4.7`).
- **Layout:** `WorkspaceAdminLayout` with filter bar (`search`, `status`, `roleId`, `membershipType`, `Invite Member` button) and paginated table.
- **Components:** `MemberFilterBar`, `MemberDirectoryTable`, `EditMemberDrawer`, `ConfirmReasonModal`.
- **Form Fields:** Search/filter inputs; drawer (`jobTitle`, `employeeCode`, `membershipType`, `roleIds[]`); status modal (`action`, `reason`).
- **Validation:** `>= 1` role selected; `reason` (`10–500` chars) required for `SUSPEND` & `REVOKE`.
- **Loading / Empty / Error / Success States:** Row skeletons; `"No members match current filters"` empty state; dedicated `403 MEMBER_DIRECTORY_RESTRICTED` state if accessed directly by an ordinary member while `allowMemberDirectoryView === false` (`D4`); confirmation toast on update.
- **Permission Visibility:** Nav link hidden for ordinary members when `allowMemberDirectoryView === false`; read-only `ACTIVE` view when `true` (`tenant:members:read`); status filters & edit/role/suspend actions visible only to `tenant:members:manage` / `tenant:roles:assign`.
- **API Integration:** `#15 GET /workspace/members`, `#16 PATCH /workspace/members/:id`, `#17 POST /workspace/members/:id/status`, `#18 GET /workspace/roles`, `#19 PUT /workspace/members/:id/roles`.
- **Responsive Behavior:** Horizontal table scroll on tablet, stacked cards on mobile.

### RV-10: Invitation Management Page (`/workspace/invitations` — *New*)
- **Purpose:** Send invitations, monitor status (`PENDING`, `ACCEPTED`, `EXPIRED`, `REVOKED`), resend rotated links, and revoke pending invites (`Module 4.6`).
- **Layout:** `WorkspaceAdminLayout` with status filter tabs, `Invite New Member` modal, and paginated invitations table.
- **Components:** `CreateInvitationModal`, `InvitationsTable`, `ResendCooldownButton`, `RevokeInvitationModal`.
- **Form Fields:** `email`, `membershipType`, `targetRoleId` (`tenant_admin` option shown only if `membershipType === 'INTERNAL'` and caller holds `tenant:admins:manage`), `jobTitle`; revoke `reason` (optional).
- **Validation:** Email format; required `targetRoleId`.
- **Loading / Empty / Error / Success States:** Skeleton rows; `"No pending invitations"` empty card with `Invite Member` CTA; `409 INVITATION_ALREADY_PENDING` inline `Resend` shortcut; toast on send/resend/revoke.
- **Permission Visibility:** Read view for `tenant:invitations:read`; issue/resend/revoke buttons gated by `tenant:invitations:manage`.
- **API Integration:** `#22 GET /workspace/invitations`, `#18 GET /workspace/roles`, `#23 POST /workspace/invitations`, `#24 POST /workspace/invitations/:id/resend`, `#25 POST /workspace/invitations/:id/revoke`.
- **Responsive Behavior:** Full-screen sheet modal on mobile; responsive table columns.

### RV-11: Unified Tenant Security & Audit Logs Page (`/workspace/admin` — *Updated Phase 3*)
- **Purpose:** Provides Tenant Admins a unified, filterable view of **Tenant Domain Audit Logs** (`tenant_audit_logs` with `before_state`/`after_state` diff drawer) alongside Phase 3 **Authentication & Boundary Audit Logs** (`auth_audit_logs`) (`Module 4.10`).
- **Layout:** `WorkspaceAdminLayout` with two top tabs (`Organization Domain Audit` | `Authentication & Access Audit`), filter bar (`eventType`, `resourceType`, date range), and cursor-paginated table + slide-over JSON diff inspector.
- **Components:** `AuditLedgerTabs`, `TenantAuditFilterBar`, `TenantAuditTable`, `AuditDiffInspectorDrawer`, existing Phase 3 `AuthLogsTable`.
- **Form Fields:** Filter controls (`eventType`, `resourceType`, `from`, `to`).
- **Validation:** ISO date range `from <= to`.
- **Loading / Empty / Error / Success States:** Table skeleton; `"No audit events match current filters"` empty state; correlation banner on `403`/`500`; copyable `correlationId` badge per row.
- **Permission Visibility:** Domain tab requires `audit:tenant:read`; Auth tab requires `audit:auth:read`.
- **API Integration:** `#29 GET /workspace/audit-logs`, existing `GET /workspace/admin/auth-logs`.
- **Responsive Behavior:** Compact expandable rows on mobile; slide-over diff drawer.

### RV-12: Invitation Preview & Dual-Path Acceptance Page (`/invitations/accept` — *New*)
- **Purpose:** Single entry screen (`?token=...`) handling masked invitation preview and branching cleanly into **Existing User Sign-In & Accept** vs. **New Global User Registration & Accept** (`Module 4.6`).
- **Layout:** Centered `AuthShell` card displaying organization name, assigned role badge, and masked invited email (`a***@acme.com`).
- **Components:** `InvitationPreviewHeader`, `ExistingUserAcceptPanel` (one-click accept when signed in as matching verified email, or `Switch Account` / `Sign In` prompt), `NewInviteeRegistrationForm` (`fullName`, `password`, `confirmPassword`, `phoneE164`).
- **Form Fields:** Registration path: `fullName`, `password`, `confirmPassword`, `phoneE164` (optional).
- **Validation:** Phase 3 password policy (`12–128` chars, upper, lower, digit, symbol); non-empty token.
- **Loading / Empty / Error / Success States:** Token preview skeleton; dedicated **Initiator / Wrong-Account Session Guard** whenever `GET /auth/me` detects a signed-in user (such as the initiating admin who issued the invitation) whose identity/email does not match the invitation recipient (`"Signed in as <currentEmail> — this invitation belongs to <invitedEmailMasked>. Sign out to continue as the invited recipient"`, preventing accidental initiator acceptance); dedicated error states for missing token, `400 INVITATION_INVALID_OR_EXPIRED`, `403 TENANT_SUSPENDED_OR_INACTIVE`, `403 INVITATION_EMAIL_MISMATCH`, and `409 USER_ALREADY_REGISTERED_SIGN_IN_TO_ACCEPT` (auto-switches to Sign-In prompt); redirects into `/workspace` upon acceptance.
- **Permission Visibility:** Public entry gated by `256-bit` token; `#27` requires matching verified user session.
- **API Integration:** `#26 GET /invitations/preview`, `GET /auth/me`, `#27 POST /invitations/accept`, `#28 POST /invitations/accept-register`.
- **Responsive Behavior:** Compact mobile-first `max-w-md` card.

### RV-13: Platform Super Admin Tenant Directory & Provisioning Page (`/platform/tenants` — *New*)
- **Purpose:** Global control-plane directory allowing Platform Super Admins to search/filter all organizations and provision enterprise tenants (`Modules 4.1, 4.4`).
- **Layout:** Platform control-plane header (`Overview & Auth Logs` [`/platform`] | `Tenants & Lifecycle` [`/platform/tenants`]) + status filter pills, search input, `Provision Tenant` button, and cursor-paginated global tenants table linking each row to `/platform/tenants/[tenantId]`.
- **Components:** `PlatformNavHeader`, `PlatformTenantFilterBar`, `PlatformTenantsTable`, `ProvisionTenantModal`.
- **Form Fields:** Filter (`status`, `search`); Provision modal (`displayName`, `legalName`, `slug`, `initialStatus`, `initialAdminEmail`, `organizationType`, `industry`, `countryCode`, `defaultTimezone`, `defaultCurrency`, `reason`).
- **Validation:** Slug regex; email format; mandatory `reason` (`10–500` chars).
- **Loading / Empty / Error / Success States:** Table skeleton; `"No tenant organizations provisioned yet"` empty state; `403` plane denial banner if non-Super-Admin; toast + link to newly provisioned tenant detail on `201`.
- **Permission Visibility:** Strictly `PlatformSuperAdminGuard` (`isPlatformSuperAdmin === true`, `activeTenantId === null`, `platform:tenants:read` / `platform:tenants:manage`).
- **API Integration:** `#30 GET /platform/tenants`, `#31 POST /platform/tenants`.
- **Responsive Behavior:** Responsive filter toolbar + horizontal scroll table on tablet/mobile.

### RV-14: Platform Super Admin Tenant Detail, Lifecycle & Audit Page (`/platform/tenants/[tenantId]` — *New*)
- **Purpose:** Dedicated control-plane view for inspecting a single tenant's metadata/onboarding/admins, executing lifecycle transitions (`Activate`, `Suspend`, `Reactivate`, `Deactivate`, `Cancel`), performing break-glass primary-owner recovery, and reviewing tenant audit history (`Modules 4.4, 4.5, 4.10`).
- **Layout:** Platform control-plane shell with breadcrumb (`/platform/tenants` -> `Tenant Slug`), status & onboarding summary header, `Lifecycle Controls` card, `Primary Owner & Break-Glass Recovery` card, and `Tenant Audit Log Timeline` card.
- **Components:** `PlatformTenantSummaryCard`, `TenantLifecycleActionModal` (validates only legal outbound actions from Section 4.4.A; disabled when `CANCELLED`), `BreakGlassOwnerRecoveryModal`, `PlatformTenantAuditTable`.
- **Form Fields:** Lifecycle modal (`action`, `targetStatus`, `confirmationSlug`, `reason`); Break-glass modal (`targetMembershipId`, `confirmationSlug`, `reason`).
- **Validation:** Exact `confirmationSlug` match + mandatory `reason` (`10–500` chars).
- **Loading / Empty / Error / Success States:** Detail skeleton; `404 TENANT_NOT_FOUND` card; `409 INVALID_TENANT_STATUS_TRANSITION` banner; success toast displaying `evictedActiveSessionsCount`.
- **Permission Visibility:** `PlatformSuperAdminGuard` (`platform:tenants:read`, `platform:tenants:manage`, `platform:audit:read`).
- **API Integration:** `#32 GET /platform/tenants/:tenantId`, `#33 POST /platform/tenants/:tenantId/lifecycle`, `#34 POST /platform/tenants/:tenantId/recover-owner`, `#35 GET /platform/tenants/:tenantId/audit-logs`.
- **Responsive Behavior:** 2-column summary + lifecycle grid on `lg+`, single-column stack on mobile/tablet.
