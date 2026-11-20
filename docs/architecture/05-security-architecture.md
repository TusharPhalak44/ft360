# Security Architecture

**Last Updated:** 2026-11-17  
**Status:** Phase 4B Database Prerequisite Active Security Specification (`migrations 0001–0009`)  
**Version:** 0.4.1

---

## 1. Defense-in-Depth Security Model

Security is enforced across seven concentric layers:

1. **Edge & Transport:** Strict CORS allowlist, `helmet` security headers, global `CsrfProtectionGuard` (`Origin`/`Referer`/`Sec-Fetch-Site` + constant-time `X-CSRF-Token` double-submit validation), and Redis rate limiting (`AuthRateLimitService`).
2. **Authentication (AuthN):** Argon2id password hashing (`64 MiB`) + short-lived signed Access JWTs (`15m`) + rotating 256-bit opaque Refresh Sessions with multi-generation `family_id` replay detection (`auth_refresh_token_history`) and AES-256-GCM durable email outbox (`auth_email_outbox`).
3. **Tenant Context & Fail-Safe Lifecycle Verification:** Server-side verification of `user.status = 'ACTIVE'`, `tenant_membership.status = 'ACTIVE'`, and `tenant.status IN ('ACTIVE', 'TRIAL')` on every protected request; client-supplied `tenant_id` (`x-tenant-id`, `?tenant_id`, body `tenantId`) is actively rejected (`400 UNTRUSTED_TENANT_INPUT_REJECTED`). When Redis is unavailable, `RedisSessionCacheService` degrades safely to PostgreSQL's 4-layer lifecycle checks (`fn_auth_validate_session`, `fn_verify_tenant_membership`, `withVerifiedMemberTransaction`, `fn_is_current_tenant_operational()`).
4. **Authorization (AuthZ – Plane & RBAC Guards):**
   - `PlatformSuperAdminGuard` enforces `is_platform_super_admin = TRUE`, `status = 'ACTIVE'`, and `tid === null` on `/api/v1/platform/*`.
   - `TenantMembershipGuard` + `TenantPermissionGuard` (`@RequirePermissions(...)`) and `TenantAdminGuard` enforce fine-grained `module:resource:action` capabilities across the `24` canonical permissions seeded in `public.permissions` (`5` `PLATFORM` + `1` `PORTAL` + `18` `TENANT`).
5. **Database Isolation (`FORCE RLS` + Composite FKs + Column Omission):** All `22` public tables enforce `ENABLE` + `FORCE ROW LEVEL SECURITY` under `ft360_app` (`NOSUPERUSER NOBYPASSRLS NOINHERIT`), composite `(tenant_id, ...)` foreign keys, and column-level `SELECT` exclusion on all password/token/refresh/CSRF/outbox secret columns (`42501`).
6. **Input & Query Safety:** Strict DTO whitelist validation (`forbidNonWhitelisted: true`) + 100% parameterized native `pg` SQL (`$1, $2...`, zero ORM).
7. **Immutable Dual-Ledger Audit Trail:** Append-only `auth_audit_logs` (`0005`–`0006`) and `tenant_audit_logs` (`0007`, `TenantAuditModule`) enforce `42501` immutability triggers, `ON DELETE RESTRICT` tenant retention, mandatory `correlation_id`, field-level `before_state`/`after_state` diffs, and recursive secret-key rejection (`fn_jsonb_has_forbidden_secret_key` -> `23514`).

---

## 2. Tenant Provisioning, Lifecycle, Ownership & Invitation Security Invariants (`0007`–`0009`)

- **Self-Service Provisioning & Permission Matrix Enforcement (`0009`):**
  - `fn_check_tenant_slug_available` and `fn_tenant_provision_organization` are owned by `ft360_migrator` (`SECURITY DEFINER`, `SET search_path = pg_catalog, public, pg_temp`, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO ft360_app`).
  - Customer provisioning never sets `app.is_super_admin = 'true'`, rejects existing active tenant GUC contexts (`42501`), rejects Platform Super Admin accounts (`42501`), requires an `ACTIVE` email-verified global user matching `app_current_user_id()`, locks and binds only the caller's verified active `auth_sessions` row, and serializes per-user ownership quota (`<= 5` `ACTIVE`/`TRIAL` owned organizations per `D2`, counting `PROVISIONING`/`SUSPENDED` self-created tenants against quota bypass) via `pg_advisory_xact_lock`.
  - **Canonical `24`-Permission Reconciliation:** Out of `24` canonical permissions (`5` `PLATFORM`, `1` `PORTAL`, `18` `TENANT` [`8` from `0004`–`0005` + `10` added in `0007`]), `fn_tenant_provision_organization` grants `tenant_admin` (`TENANT` scope) all `18` approved `TENANT` permissions and grants `member` (`OWN` scope) strictly the `4` approved baseline read permissions (`tenant:organization:read`, `tenant:settings:read`, `tenant:branding:read`, `tenant:members:read`).
- **6-State Tenant Lifecycle & `OD-P1` Cancellation Guard (`0007`–`0008`):** Tenants progress across `PROVISIONING`, `TRIAL`, `ACTIVE`, `SUSPENDED`, `DEACTIVATED`, and terminal `CANCELLED`. Direct `TRIAL -> CANCELLED` and `ACTIVE -> CANCELLED` transitions are blocked (`OD-P1`), requiring prior `SUSPENDED` or `DEACTIVATED` status and a `10..500` character reason.
- **Serialized Last-Admin & Primary-Owner Integrity (`0007`–`0008`):** `uq_tenant_memberships_primary_owner` guarantees at most one active primary owner per tenant; `trigger_enforce_admin_membership_type()` restricts `tenant_admin` to `INTERNAL` memberships; and `trigger_prevent_last_tenant_admin_removal()` locks `public.tenants FOR UPDATE` to prevent concurrent removal of the last active administrator.
- **Initiator vs. Recipient Invitation Separation (`0008`):** `tenant_invitations` and `auth_email_outbox` strictly separate `invited_by_user_id` / `initiated_by_user_id` from `accepted_by_user_id` (`chk_auth_email_outbox_anchor` requires `user_id IS NULL` for `'TENANT_INVITATION'`; `chk_ti_initiator_recipient_distinct` prevents self-acceptance; raw `/invitations/accept?token=...` URLs are scrubbed from logs).
- **Branding Asset Database Guardrails (`0007`):** `tenant_branding_assets` blocks `image/svg+xml` and enforces raster dimension and pixel-count caps (`<= 4.19 MP` logos, square `<= 0.26 MP` favicons) ahead of Stage 4C `sharp` pixel-stream decoding.
