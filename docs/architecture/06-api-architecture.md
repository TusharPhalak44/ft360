# REST API Architecture

**Last Updated:** 2026-11-16  
**Status:** Phase 4 Stage 4A Active API Specification  
**Version:** 0.4.0

---

## 1. API Design Principles

- **Authoritative Backend:** All business operations are exposed exclusively through NestJS REST endpoints under `/api/v1/...`.
- **OpenAPI Documentation:** Auto-generated via `@nestjs/swagger` at `/api/docs` (disabled or auth-gated in production), keeping request/response schemas synchronized with TypeScript DTOs.
- **Correlation Tracking:** Every request receives or propagates an `X-Correlation-Id` UUID header returned in all responses and attached to application logs, SQL transactions, BullMQ jobs, and `auth_audit_logs` / `tenant_audit_logs` entries.

---

## 2. URL Namespace Partitioning & Guard Matrix

Separating URL prefixes prevents accidental guard misconfiguration between platform-level, tenant-level, and client-portal routes:

| Route Prefix | Target Persona | Required Guards |
|---|---|---|
| `/api/v1/public/*`, `/api/v1/health/*` | Unauthenticated visitors (branding bootstrap, liveness/readiness) | `@Public()` |
| `/api/v1/auth/*` | CSRF bootstrap, register, verify-email, login, refresh, logout, forgot/reset password, org switch | Global `CsrfProtectionGuard` + `AuthRateLimitService` (+ `JwtAuthGuard` on session-authenticated routes) |
| `/api/v1/platform/*` | Platform Super Admin (`tid === null`) | `JwtAuthGuard` + `PlatformSuperAdminGuard` |
| `/api/v1/workspace/*` | Authenticated Active Tenant Members (`tid !== null`) | `JwtAuthGuard` + `TenantMembershipGuard` + `TenantPermissionGuard` (`@RequirePermissions(...)`) / `TenantAdminGuard` |
| `/api/v1/portal/*` | External Client Portal Users *(Planned)* | `JwtAuthGuard` + `TenantMembershipGuard` + `PortalScopeGuard` |
| `/api/v1/webhooks/*` | External Providers *(Planned)* | `WebhookSignatureGuard` + idempotency key check |

### Implemented Stage 4A Workspace Domain Endpoint (`1 / 35` Phase 4 Endpoints Live)
- **Endpoint `#29` — `GET /api/v1/workspace/audit-logs` (`TenantAuditController`):**
  - **Guards:** `JwtAuthGuard` + `TenantMembershipGuard` + `TenantPermissionGuard` (`@RequirePermissions('audit:tenant:read')`).
  - **Query Parameters (`ListTenantAuditLogsQueryDto`):** `cursor` (base64url `{ createdAt, id }` composite keyset cursor), `limit` (`1..100`, default `25`), `eventType`, `resourceType`, `resourceId`, `actorUserId`, `outcome` (`SUCCESS | FAILURE | DENIED`), `from`, `to`.
  - **Isolation:** Executes strictly inside `TenantTransactionManager.withVerifiedMemberTransaction(ctx, ...)` against `public.tenant_audit_logs` (`FORCE RLS`).

---

## 3. Standard Request & Response Envelopes

### 3.1 Success Response (Single Resource)
```json
{
  "success": true,
  "data": {
    "id": "0195f3a2-7c40-7b12-9a10-4e8d21b90001",
    "name": "Acme Global"
  },
  "meta": {
    "correlationId": "0195f3a2-7c3f-7000-8000-112233445566",
    "timestamp": "2026-11-16T15:30:00.000Z"
  }
}
```

### 3.2 Cursor-Paginated Collection Response (e.g., `GET /api/v1/workspace/audit-logs`)
```json
{
  "success": true,
  "data": {
    "items": [],
    "pagination": {
      "limit": 25,
      "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTExLTE2VDE1OjMwOjAwLjAwMFoiLCJpZCI6IjAxOTVmM2EyLTdjNDAtN2IxMi05YTEwLTRlOGQyMWI5MDAwMSJ9",
      "hasMore": true
    }
  },
  "meta": {
    "correlationId": "0195f3a2-7c3f-7000-8000-112233445566",
    "timestamp": "2026-11-16T15:30:00.000Z"
  }
}
```

### 3.3 Standard Error Envelope
Database error internals (table names, constraint names, SQL stack traces) are never leaked to clients; `GlobalExceptionFilter` maps errors to structured error envelopes carrying `meta.correlationId`.
