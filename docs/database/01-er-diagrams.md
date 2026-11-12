# Database Entity-Relationship (ER) Diagrams

**Last Updated:** 2026-11-13  
**Status:** Phase 2 Implemented Baseline (`migrations 0001–0004`) + Phases 3–7 Planned Extensions  
**Version:** 0.2.0

---

## 1. Implemented Foundation ER Diagram (Phases 1–2: Migrations `0001`–`0004`)

All entities below are live in PostgreSQL 18, owned by `ft360_migrator`, and protected by `ENABLE` + `FORCE ROW LEVEL SECURITY` and composite foreign keys:

```mermaid
erDiagram
    PLATFORM_BRANDING_SETTINGS {
        boolean singleton_key PK
        varchar product_name
        varchar tagline
        varchar support_email
        varchar website_url
        text logo_light_url
        text logo_dark_url
        text favicon_url
        char primary_color_hex
        char accent_color_hex
        timestamptz created_at
        timestamptz updated_at
    }

    RLS_ISOLATION_CANARY {
        uuid id PK
        uuid tenant_id
        varchar probe_label
        uuid created_by_user_id
        timestamptz created_at
    }

    USERS {
        uuid id PK
        citext email UK
        text password_hash
        varchar full_name
        varchar phone_e164
        varchar status "PENDING | ACTIVE | SUSPENDED | ARCHIVED"
        boolean is_platform_super_admin
        boolean email_verified
        timestamptz last_login_at
        timestamptz created_at
        timestamptz updated_at
    }

    TENANTS {
        uuid id PK
        citext slug UK
        varchar legal_name
        varchar display_name
        varchar status "PROVISIONING | TRIAL | ACTIVE | SUSPENDED | CANCELLED"
        varchar default_timezone
        char default_currency "ISO-4217"
        timestamptz activated_at
        timestamptz suspended_at
        timestamptz created_at
        timestamptz updated_at
    }

    TENANT_MEMBERSHIPS {
        uuid id PK
        uuid tenant_id FK "UK(tenant_id, user_id), UK(tenant_id, id)"
        uuid user_id FK
        varchar membership_type "INTERNAL | CLIENT_PORTAL | PARTNER"
        varchar status "INVITED | ACTIVE | SUSPENDED | REVOKED"
        varchar job_title
        varchar employee_code
        uuid invited_by_user_id FK
        timestamptz joined_at
        timestamptz created_at
        timestamptz updated_at
    }

    PERMISSIONS {
        uuid id PK
        varchar code UK "module:resource:action"
        varchar scope_plane "PLATFORM | TENANT | PORTAL"
        varchar module_code
        text description
        timestamptz created_at
        timestamptz updated_at
    }

    ROLES {
        uuid id PK
        uuid tenant_id FK "UK(tenant_id, slug), UK(tenant_id, id)"
        citext slug
        varchar name
        text description
        boolean is_system_role
        varchar data_access_scope "OWN | TEAM | TENANT"
        timestamptz created_at
        timestamptz updated_at
    }

    ROLE_PERMISSIONS {
        uuid id PK
        uuid tenant_id FK
        uuid role_id FK "Composite FK (tenant_id, role_id) -> roles(tenant_id, id)"
        uuid permission_id FK
        timestamptz created_at
        timestamptz updated_at
    }

    USER_ROLE_ASSIGNMENTS {
        uuid id PK
        uuid tenant_id FK
        uuid membership_id FK "Composite FK (tenant_id, membership_id)"
        uuid role_id FK "Composite FK (tenant_id, role_id)"
        uuid assigned_by_membership_id FK "Composite FK (tenant_id, assigned_by_membership_id)"
        timestamptz created_at
        timestamptz updated_at
    }

    USERS ||--o{ TENANT_MEMBERSHIPS : "joins (0..N orgs)"
    TENANTS ||--o{ TENANT_MEMBERSHIPS : "contains members"
    USERS ||--o{ TENANT_MEMBERSHIPS : "invited_by_user_id"
    TENANTS ||--o{ ROLES : "defines roles"
    ROLES ||--o{ ROLE_PERMISSIONS : "(tenant_id, id) -> (tenant_id, role_id)"
    PERMISSIONS ||--o{ ROLE_PERMISSIONS : "permission_id -> id"
    TENANT_MEMBERSHIPS ||--o{ USER_ROLE_ASSIGNMENTS : "(tenant_id, id) -> (tenant_id, membership_id)"
    ROLES ||--o{ USER_ROLE_ASSIGNMENTS : "(tenant_id, id) -> (tenant_id, role_id)"
    TENANT_MEMBERSHIPS ||--o{ USER_ROLE_ASSIGNMENTS : "assigned_by_membership_id"
```

---

## 2. Upcoming Foundation Entities (Planned for Phases 3–7)

The following tables attach to `users(id)`, `tenants(id)`, and `tenant_memberships(tenant_id, id)` in subsequent authorized foundation phases:
- **Phase 3 (Authentication):** `auth_sessions`, `password_reset_tokens`
- **Phase 4 (Tenant Onboarding & Settings):** `tenant_invitations`, `tenant_settings`, `tenant_branding_settings`
- **Phase 6 (Audit & Compliance Core):** `platform_audit_logs`, `tenant_audit_logs`
- **Phase 7 (Subscription Foundation):** `subscription_plans`, `tenant_subscriptions`, `tenant_usage_counters`
