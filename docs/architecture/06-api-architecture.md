# REST API Architecture

**Last Updated:** 2026-11-12  
**Status:** Phase 0 API Specification  
**Version:** 0.1.0

---

## 1. API Design Principles

- **Authoritative Backend:** All business operations are exposed exclusively through NestJS REST endpoints under `/api/v1/...`.
- **OpenAPI 3.1 Documentation:** Auto-generated via `@nestjs/swagger` at `/api/docs` (disabled or auth-gated in production), keeping request/response schemas synchronized with TypeScript DTOs.
- **Correlation Tracking:** Every request receives or propagates an `X-Correlation-Id` UUID header returned in all responses and attached to application logs, SQL logs, BullMQ jobs, and audit entries.

---

## 2. URL Namespace Partitioning

 Separating URL prefixes prevents accidental guard misconfiguration between platform-level, tenant-level, and client-portal routes:

| Route Prefix | Target Persona | Required Guards |
|---|---|---|
| `/api/v1/public/*` | Unauthenticated visitors (branding bootstrap, health) | `ThrottlerGuard` |
| `/api/v1/auth/*` | Login, logout, refresh, password reset, tenant switch | `ThrottlerGuard` (+ `JwtAuthGuard` on protected auth routes) |
| `/api/v1/platform/*` | Platform Super Admin | `JwtAuthGuard` + `PlatformAdminGuard` + `PermissionsGuard` |
| `/api/v1/workspace/*` | Authenticated Tenant Members (CRM, Ops, HR, Finance, Admin) | `JwtAuthGuard` + `TenantContextGuard` + `PermissionsGuard` |
| `/api/v1/portal/*` | External Client Portal Users | `JwtAuthGuard` + `TenantContextGuard` + `PortalScopeGuard` |
| `/api/v1/webhooks/*` | External Providers (Billing, VoIP/Dialer, Email) | `WebhookSignatureGuard` + idempotency key check |

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
    "timestamp": "2026-11-12T15:30:00.000Z"
  }
}
```

### 3.2 Paginated Collection Response
Cursor pagination (`cursor`, `limit`) is preferred for high-volume tables (Leads, DBMS Contacts, Call Logs, Audit Logs); offset pagination (`page`, `pageSize`) is supported for bounded admin tables (`max pageSize = 100`).

```json
{
  "success": true,
  "data": [],
  "pagination": {
    "limit": 25,
    "nextCursor": "eyJpZCI6IjAxOTVmM2EyIn0=",
    "hasMore": true,
    "totalApprox": 1420
  },
  "meta": {
    "correlationId": "0195f3a2-7c3f-7000-8000-112233445566",
    "timestamp": "2026-11-12T15:30:00.000Z"
  }
}
```

### 3.3 Standard Error Envelope (RFC 7807 Inspired)
Database error internals (table names, constraint names, SQL stack traces) are **never** leaked to clients; a global `AllExceptionsFilter` maps `pg` error codes (`23505` unique violation, `23503` FK violation, `42501` RLS violation) to safe domain error codes. Cross-tenant resource lookups return `404 RESOURCE_NOT_FOUND` rather than `403` where appropriate to prevent UUID enumeration across tenants.

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request validation failed.",
    "details": [
      { "field": "email", "issue": "Must be a valid email address" }
    ]
  },
  "meta": {
    "correlationId": "0195f3a2-7c3f-7000-8000-112233445566",
    "timestamp": "2026-11-12T15:30:00.000Z"
  }
}
```

