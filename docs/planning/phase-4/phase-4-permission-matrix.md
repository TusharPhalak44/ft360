# FunnelTrack360 — Phase 4 API & RBAC Permission Matrix

**Phase:** Phase 4 — Tenant Onboarding & Management  
**Canonical Permission Footprint:** `24` Total Permissions (`14` Existing in `0004`–`0005` + `10` New `TENANT` Permissions Planned in `0007`)  
**Total Mapped Phase 4 REST Endpoints:** **`35` Endpoints** (`5` User Onboarding / Public Token, `24` Single-Tenant Workspace, `6` Platform Control Plane)  
**Document Status:** `PLANNING BASELINE — PRODUCT & TECHNICAL DECISIONS CONFIRMED (AWAITING PR REVIEW)`  
**Last Updated:** 2026-11-14

---

## 1. Canonical Permission Catalog (`public.permissions`)

Every permission code conforms to `chk_permissions_code_format` (`^[a-z0-9_]+:[a-z0-9_]+:[a-z0-9_]+$`) and `chk_permissions_scope_plane IN ('PLATFORM', 'TENANT', 'PORTAL')`. Database trigger `trigger_enforce_tenant_permission_scope()` guarantees a `PLATFORM`-plane permission can **never** be granted to any tenant role (`42501`).

### 1.1 Platform Control-Plane Permissions (`scope_plane = 'PLATFORM'`)
*(Enforced via `PlatformSuperAdminGuard` + `@RequirePlatformPermissions(...)` — requires `activeTenantId === null` and live PostgreSQL `users.is_platform_super_admin = TRUE AND status = 'ACTIVE'`)*

| Permission Code | Origin | Mapped Phase 4 Endpoints & Actions |
|---|---|---|
| `platform:tenants:read` | Existing (`0004`) | `#30` `GET /platform/tenants`, `#32` `GET /platform/tenants/:tenantId` |
| `platform:tenants:manage` | Existing (`0004`) | `#31` `POST /platform/tenants`, `#33` `POST /platform/tenants/:tenantId/lifecycle`, `#34` `POST /platform/tenants/:tenantId/recover-owner` |
| `platform:users:read` | Existing (`0005`) | Existing `/platform/auth/overview` + initial-admin lookup inside `#31` |
| `platform:users:manage` | Existing (`0005`) | Reserved for global platform account lifecycle |
| `platform:audit:read` | Existing (`0005`) | `#35` `GET /platform/tenants/:tenantId/audit-logs` (+ existing `/platform/audit/auth-logs`) |

### 1.2 Tenant-Plane Permissions (`scope_plane = 'TENANT'`)
*(Enforced inside `req.tenantContext.tenantId` via `TenantMembershipGuard` + `TenantPermissionGuard` [read endpoints] or `TenantAdminGuard` [admin/mutating endpoints] + `@RequirePermissions(...)` — **zero endpoints rely on implicit guard fallbacks**)*

| Permission Code | Origin | Default `tenant_admin` | Default `member` | Mapped Phase 4 Capabilities & Endpoints |
|---|---|:---:|:---:|---|
| `tenant:organization:read` | Existing (`0004`) | Yes | Yes | Read onboarding state (`#3`) and organization profile (`#6`) |
| `tenant:organization:manage` | Existing (`0004`) | Yes | No | Advance/complete onboarding (`#4`, `#5`) and update organization profile (`#7`) |
| `tenant:settings:read` | **New (`0007`)** | Yes | Yes | Read organization regional & workspace preferences (`#8`) |
| `tenant:settings:manage` | **New (`0007`)** | Yes | No | Update organization preferences, invitation TTL, and directory privacy (`#9`, `#4` step `org-settings`) |
| `tenant:branding:read` | **New (`0007`)** | Yes | Yes | Read resolved tenant branding (`#10`) and stream branding assets (`#13`) |
| `tenant:branding:manage` | **New (`0007`)** | Yes | No | Update branding theme (`#11`), upload decoded raster assets (`#12`), delete assets (`#14`), onboarding step `org-branding` (`#4`) |
| `tenant:members:read` | Existing (`0004`) | Yes | Yes* | View member directory (`#15`; *for callers without `tenant:members:manage`, blocked by default unless `allow_member_directory_view = TRUE` per confirmed `D4`) |
| `tenant:members:manage` | Existing (`0004`) | Yes | No | View full member directory regardless of `allow_member_directory_view` (`#15`), update member metadata (`#16`), suspend/reactivate/revoke non-admin memberships (`#17`) |
| `rbac:roles:read` | Existing (`0004`) | Yes | No | List available tenant roles (`#18` `GET /workspace/roles`) for invitation & role-assignment selectors |
| `tenant:roles:assign` | **New (`0007`)** | Yes | No | Assign or replace non-admin member roles (`#19` `PUT /workspace/members/:membershipId/roles`) |
| `rbac:roles:manage` | Existing (`0004`) | Yes | No | Existing `/workspace/admin/rbac-posture` + custom role definition CRUD (Phase 5) |
| `tenant:admins:read` | **New (`0007`)** | Yes | No | View tenant administrator roster & primary owner status (`#20`) |
| `tenant:admins:manage` | **New (`0007`)** | Yes | No | Required whenever promoting/demoting `tenant_admin` (`#19`), suspending/revoking an admin (`#17`), inviting for `tenant_admin` (`#23`–`#25`), or transferring primary ownership (`#21`, which also requires `is_primary_owner = TRUE`) |
| `tenant:invitations:read` | **New (`0007`)** | Yes | No | List pending, accepted, expired, and revoked invitations (`#22`) |
| `tenant:invitations:manage` | **New (`0007`)** | Yes | No | Issue (`#23`), resend (`#24`), and revoke (`#25`) invitations (+ onboarding step `team-invites` `#4`) |
| `audit:tenant:read` | **New (`0007`)** | Yes | No | Query tenant domain governance & state-diff audit logs (`#29`) |
| `audit:auth:read` | Existing (`0005`) | Yes | No | Query tenant authentication & guard denial audit logs (existing `/workspace/admin/auth-logs`) |
| `auth:sessions:manage` | Existing (`0005`) | Yes | No | Tenant session posture inspection (Phase 3) |

*(Note: `portal:workspace:read` [`PORTAL`, `0004`] remains seeded and unchanged (`1` `PORTAL` + `5` `PLATFORM` + `18` `TENANT` = `24` total permissions).)*

---

## 2. Explicit 35-Endpoint Authorization & Plane Matrix

| # | Method & Endpoint | Plane | Explicit Permission / Identity Gate | Anonymous / Invitee | Auth User (Unscoped) | Ordinary Member | Tenant Admin (Secondary) | Tenant Admin (Primary Owner) | Platform Super Admin (`activeTenantId=NULL`) |
|---|---|---|---|---|---|---|---|---|---|
| **1** | `GET /api/v1/tenants/slug-availability` | User Onboarding | Verified Identity (`JwtAuthGuard`, `email_verified=TRUE`) | DENY (`401`) | **ALLOW** *(rate-limited)* | **ALLOW** | **ALLOW** | **ALLOW** | **ALLOW** |
| **2** | `POST /api/v1/tenants/register` | User Onboarding | Verified Non-Super-Admin (`email_verified=TRUE`, `quota<=5`) | DENY (`401`) | **ALLOW** | **ALLOW** *(new org)* | **ALLOW** *(new org)* | **ALLOW** *(new org)* | DENY (`403` — uses `#31`) |
| **3** | `GET /api/v1/workspace/onboarding` | Single Tenant | `tenant:organization:read` | DENY (`401`) | DENY (`401`) | **ALLOW** | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **4** | `PATCH /api/v1/workspace/onboarding/steps/:step` | Single Tenant | `tenant:organization:manage` *(+ step-specific `:manage`)* | DENY (`401`) | DENY (`401`) | DENY (`403`) | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **5** | `POST /api/v1/workspace/onboarding/complete` | Single Tenant | `tenant:organization:manage` | DENY (`401`) | DENY (`401`) | DENY (`403`) | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **6** | `GET /api/v1/workspace/organization/profile` | Single Tenant | `tenant:organization:read` | DENY (`401`) | DENY (`401`) | **ALLOW** | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **7** | `PUT /api/v1/workspace/organization/profile` | Single Tenant | `tenant:organization:manage` | DENY (`401`) | DENY (`401`) | DENY (`403`) | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **8** | `GET /api/v1/workspace/organization/settings` | Single Tenant | `tenant:settings:read` | DENY (`401`) | DENY (`401`) | **ALLOW** | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **9** | `PUT /api/v1/workspace/organization/settings` | Single Tenant | `tenant:settings:manage` | DENY (`401`) | DENY (`401`) | DENY (`403`) | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **10** | `GET /api/v1/workspace/branding` | Single Tenant | `tenant:branding:read` | DENY (`401`) | DENY (`401`) | **ALLOW** | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **11** | `PUT /api/v1/workspace/branding` | Single Tenant | `tenant:branding:manage` | DENY (`401`) | DENY (`401`) | DENY (`403`) | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **12** | `POST /api/v1/workspace/branding/assets` | Single Tenant | `tenant:branding:manage` | DENY (`401`) | DENY (`401`) | DENY (`403`) | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **13** | `GET /api/v1/workspace/branding/assets/:assetId/content` | Single Tenant | `tenant:branding:read` | DENY (`401`) | DENY (`401`) | **ALLOW** *(own tenant)* | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **14** | `DELETE /api/v1/workspace/branding/assets/:assetId` | Single Tenant | `tenant:branding:manage` | DENY (`401`) | DENY (`401`) | DENY (`403`) | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **15** | `GET /api/v1/workspace/members` | Single Tenant | `tenant:members:read` *(+ `allow_member_directory_view` or `tenant:members:manage`)* | DENY (`401`) | DENY (`401`) | **DENY (`403`) by default (`D4`)**; ALLOW `ACTIVE` list if setting enabled | **ALLOW** *(all statuses)* | **ALLOW** *(all statuses)* | DENY (`403` wrong plane) |
| **16** | `PATCH /api/v1/workspace/members/:membershipId` | Single Tenant | `tenant:members:manage` | DENY (`401`) | DENY (`401`) | DENY (`403`) | **ALLOW (Scoped)** | **ALLOW** | DENY (`403` wrong plane) |
| **17** | `POST /api/v1/workspace/members/:membershipId/status` | Single Tenant | `tenant:members:manage` *(+ `tenant:admins:manage` if target is admin)* | DENY (`401`) | DENY (`401`) | DENY (`403`) | **ALLOW (Scoped)** *(non-owner, non-last-admin)* | **ALLOW (Scoped)** *(non-self, non-last-admin)* | DENY (`403` wrong plane) |
| **18** | `GET /api/v1/workspace/roles` | Single Tenant | `rbac:roles:read` | DENY (`401`) | DENY (`401`) | DENY (`403`) | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **19** | `PUT /api/v1/workspace/members/:membershipId/roles` | Single Tenant | `tenant:roles:assign` *(+ `tenant:admins:manage` if touching `tenant_admin`)* | DENY (`401`) | DENY (`401`) | DENY (`403`) | **ALLOW (Scoped)** | **ALLOW (Scoped)** *(never removes last admin)* | DENY (`403` wrong plane) |
| **20** | `GET /api/v1/workspace/admins` | Single Tenant | `tenant:admins:read` | DENY (`401`) | DENY (`401`) | DENY (`403`) | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **21** | `POST /api/v1/workspace/admins/transfer-ownership` | Single Tenant | `tenant:admins:manage` **AND** `is_primary_owner=TRUE` | DENY (`401`) | DENY (`401`) | DENY (`403`) | DENY (`403` `PRIMARY_OWNER_REQUIRED`) | **ALLOW** | DENY (`403` — uses `#34`) |
| **22** | `GET /api/v1/workspace/invitations` | Single Tenant | `tenant:invitations:read` | DENY (`401`) | DENY (`401`) | DENY (`403`) | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **23** | `POST /api/v1/workspace/invitations` | Single Tenant | `tenant:invitations:manage` *(+ `tenant:admins:manage` if `tenant_admin`)* | DENY (`401`) | DENY (`401`) | DENY (`403`) | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **24** | `POST /api/v1/workspace/invitations/:invitationId/resend` | Single Tenant | `tenant:invitations:manage` *(+ `tenant:admins:manage` if `tenant_admin`)* | DENY (`401`) | DENY (`401`) | DENY (`403`) | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **25** | `POST /api/v1/workspace/invitations/:invitationId/revoke` | Single Tenant | `tenant:invitations:manage` *(+ `tenant:admins:manage` if `tenant_admin`)* | DENY (`401`) | DENY (`401`) | DENY (`403`) | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **26** | `GET /api/v1/invitations/preview` | Public Token | Valid `256-bit` CSPRNG Invitation Token (`@Public()`, rate-limited) | **ALLOW** *(masked email)* | **ALLOW** | **ALLOW** | **ALLOW** | **ALLOW** | **ALLOW** |
| **27** | `POST /api/v1/invitations/accept` | User Onboarding | Verified User (`email_verified=TRUE`, `email == invited_email`, non-Super-Admin) | DENY (`401`) | **ALLOW (Own)** | **ALLOW (Own)** | **ALLOW (Own)** | **ALLOW (Own)** | DENY (`403` plane separation) |
| **28** | `POST /api/v1/invitations/accept-register` | Public Token | Valid `256-bit` Token + Unregistered `invited_email` (`@Public()`, CSRF) | **ALLOW** | DENY (`409` — use `#27`) | DENY (`409`) | DENY (`409`) | DENY (`409`) | DENY (`403`) |
| **29** | `GET /api/v1/workspace/audit-logs` | Single Tenant | `audit:tenant:read` | DENY (`401`) | DENY (`401`) | DENY (`403`) | **ALLOW** | **ALLOW** | DENY (`403` wrong plane) |
| **30** | `GET /api/v1/platform/tenants` | Platform Global | `platform:tenants:read` | DENY (`401`) | DENY (`403`) | DENY (`403`) | DENY (`403`) | DENY (`403`) | **ALLOW** |
| **31** | `POST /api/v1/platform/tenants` | Platform Global | `platform:tenants:manage` | DENY (`401`) | DENY (`403`) | DENY (`403`) | DENY (`403`) | DENY (`403`) | **ALLOW** *(requires `reason`)* |
| **32** | `GET /api/v1/platform/tenants/:tenantId` | Platform Global | `platform:tenants:read` | DENY (`401`) | DENY (`403`) | DENY (`403`) | DENY (`403`) | DENY (`403`) | **ALLOW** |
| **33** | `POST /api/v1/platform/tenants/:tenantId/lifecycle` | Platform Global | `platform:tenants:manage` | DENY (`401`) | DENY (`403`) | DENY (`403`) | DENY (`403`) | DENY (`403`) | **ALLOW** *(requires `reason`)* |
| **34** | `POST /api/v1/platform/tenants/:tenantId/recover-owner` | Platform Global | `platform:tenants:manage` | DENY (`401`) | DENY (`403`) | DENY (`403`) | DENY (`403`) | DENY (`403`) | **ALLOW** *(requires `reason`)* |
| **35** | `GET /api/v1/platform/tenants/:tenantId/audit-logs` | Platform Global | `platform:audit:read` | DENY (`401`) | DENY (`403`) | DENY (`403`) | DENY (`403`) | DENY (`403`) | **ALLOW** |

---

## 3. Enforcement Boundary Summary

1. **Explicit Coverage Verification:**
   - **Member Read:** `tenant:members:read` (`#15`, gated for non-admins by `allow_member_directory_view`, default `FALSE` per `D4`).
   - **Member Management:** `tenant:members:manage` (`#15` full status view, `#16` metadata update, `#17` status transition).
   - **Role Lookup & Role Assignment:** `rbac:roles:read` (`#18`) and `tenant:roles:assign` (`#19`).
   - **Invitation Management:** `tenant:invitations:read` (`#22`) and `tenant:invitations:manage` (`#23`, `#24`, `#25`).
   - **Administrator Management:** `tenant:admins:read` (`#20`) and `tenant:admins:manage` (`#17`/`#19`/`#23`–`#25` when target/role is `tenant_admin`, plus `#21` ownership transfer).
2. **Guard Separation:** Read endpoints open to ordinary members (`#3`, `#6`, `#8`, `#10`, `#13`, `#15`) use `TenantMembershipGuard` + `TenantPermissionGuard` (`@RequirePermissions(...)`), logging `AUTH_TENANT_PERMISSION_DENIED` on `403`. Administrative endpoints (`#4`, `#5`, `#7`, `#9`, `#11`, `#12`, `#14`, `#16`–`#25`, `#29`) use `TenantMembershipGuard` + `TenantAdminGuard` + `@RequirePermissions(...)`, logging `AUTH_TENANT_ADMIN_BOUNDARY_DENIED` on `403`.
