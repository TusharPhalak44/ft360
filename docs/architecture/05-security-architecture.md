# Security Architecture

**Last Updated:** 2026-11-12  
**Status:** Phase 0 Security Specification  
**Version:** 0.1.0

---

## 1. Defense-in-Depth Security Model

Security is enforced across seven concentric layers:

1. **Edge & Transport:** TLS 1.3 everywhere, strict CORS allowlist, `helmet` security headers, CSP, HSTS, rate limiting via Redis (`@nestjs/throttler` keyed by IP + User + Tenant).
2. **Authentication (AuthN):** Argon2id password hashing + short-lived JWT Access Tokens + rotating opaque Refresh Sessions stored in PostgreSQL/Redis via `HttpOnly`, `Secure`, `SameSite=Lax/Strict` cookies.
3. **Tenant Context Verification:** Server-side verification of `user.status`, `tenant.status`, and `tenant_membership.status` on every protected request; client-supplied `tenant_id` ignored.
4. **Authorization (AuthZ – RBAC):** Fine-grained permission codes (`module:resource:action`, e.g., `crm:leads:create`, `hr:payroll:read`) evaluated by `PermissionsGuard` plus record-ownership scopes (`OWN`, `TEAM`, `TENANT`) inside domain services.
5. **Database Isolation (RLS + Composite FKs):** PostgreSQL RLS with `FORCE ROW LEVEL SECURITY` under `NOBYPASSRLS` application role (`ft360_app`).
6. **Input & Query Safety:** Strict DTO whitelist validation (`forbidNonWhitelisted: true`) + 100% parameterized SQL via `pg` (`$1, $2...`).
7. **Immutable Audit Trail:** Append-only `platform_audit_logs` and `tenant_audit_logs` capturing actor, IP, user-agent, correlation ID, before/after state diff (redacting secrets/PII where mandated).

---

## 2. Authentication & Session Architecture

- **Password Storage:** `Argon2id` (memory cost >= 64 MiB, iterations >= 3, parallelism = 4). Plaintext passwords never logged.
- **Token Pair Strategy:**
  - **Access Token (JWT, 10–15 min TTL):** Signed with asymmetric `RS256`/`EdDSA` keypair. Claims: `sub` (userId), `sid` (sessionId), `tid` (activeTenantId or `null` pre-selection), `padmin` (boolean platform admin flag, verified server-side), `iat`, `exp`.
  - **Refresh Token (Opaque 256-bit random token, 7–30 day sliding/absolute TTL):** Stored as SHA-256 hash in `auth_sessions` table; rotated on every refresh with **reuse detection** (if a rotated token is replayed, the entire session family is immediately revoked).
- **Immediate Revocation:** Suspending a user, revoking a tenant membership, or suspending a tenant immediately invalidates Redis session/membership cache entries (`session:{sid}`, `t:{tid}:member:{uid}`), blocking access within milliseconds without waiting for JWT expiration.
- **Future Enterprise Readiness:** Schema reserves hooks for TOTP/MFA (`user_mfa_factors`) and SSO/OIDC (`tenant_identity_providers`) required by Module 32 (Enterprise Administration).

---

## 3. Role-Based Access Control (RBAC) Model

### 3.1 Two Distinct Authorization Planes
1. **Platform Plane (`platform_*` permissions):** Assigned only to Platform Super Admin staff (e.g., `platform:tenants:suspend`, `platform:plans:manage`, `platform:branding:update`). Platform Super Admins **do not** silently read tenant business data during normal browsing; any support impersonation ("break-glass") feature requires explicit tenant approval setting, mandatory reason ticket, time-boxed session, and high-severity entries in **both** platform and tenant audit logs.
2. **Tenant Plane (`<module>:<resource>:<action>` permissions):**
   - Global `permissions` catalog defines canonical capabilities seeded via SQL migrations.
   - Each tenant receives default system roles on provisioning (`Tenant Owner`, `Tenant Admin`, `Sales Manager`, `Sales Rep`, `Operations Executive`, `QA Analyst`, `Marketing Specialist`, `HR Manager`, `Finance Manager`, `Employee`, `Client Portal User`) and can create custom tenant-specific roles in `roles`.
   - `user_role_assignments` binds one or more `roles` to a `tenant_membership`.

---

## 4. Secrets, PII, and File Security

- **Secrets Management:** `.env` files are git-ignored; `.env.example` contains placeholder keys only. Production secrets reside in encrypted secret managers (GitHub Encrypted Secrets / AWS Secrets Manager / Vault). Tenant-owned third-party API keys (VoIP, SMTP, Webhooks) are encrypted at rest using envelope encryption (`AES-256-GCM`) before storing in PostgreSQL.
- **File Upload Hardening:** Validate MIME magic bytes (not file extensions alone), enforce size limits per subscription plan, scan/quarantine untrusted uploads where applicable, and serve downloads with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` via short-lived tenant-scoped pre-signed S3 URLs.

