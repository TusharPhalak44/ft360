-- =============================================================================
-- Migration: 0007_phase4_tenant_core_schema_and_audit (DOWN)
-- Purpose:
--   Cleanly rolls back Migration 0007 tables, routines, permissions, and
--   restores Migration 0003 trigger/constraint definitions on `tenants`,
--   `tenant_memberships`, and `users`.
-- =============================================================================

-- 1. Drop tenant audit writer & Phase 4 core tables in reverse dependency order
DROP FUNCTION IF EXISTS public.fn_record_tenant_audit_log(
  UUID, VARCHAR, VARCHAR, VARCHAR, VARCHAR, UUID, UUID, UUID, UUID, VARCHAR, JSONB, JSONB, JSONB, INET, VARCHAR
);

DROP TABLE IF EXISTS public.tenant_audit_logs;
DROP FUNCTION IF EXISTS public.trigger_protect_tenant_audit_immutability();

DROP TABLE IF EXISTS public.tenant_branding_settings;
DROP TABLE IF EXISTS public.tenant_branding_assets;
DROP TABLE IF EXISTS public.tenant_settings;
DROP TABLE IF EXISTS public.tenant_profiles;
DROP TABLE IF EXISTS public.tenant_onboarding_states;

-- 2. Remove the 10 Phase 4 seeded permissions (cleaning any role_permissions links first)
DELETE FROM public.role_permissions
 WHERE permission_id IN (
   SELECT id
     FROM public.permissions
    WHERE code IN (
      'tenant:settings:read',
      'tenant:settings:manage',
      'tenant:branding:read',
      'tenant:branding:manage',
      'tenant:roles:assign',
      'tenant:invitations:read',
      'tenant:invitations:manage',
      'tenant:admins:read',
      'tenant:admins:manage',
      'audit:tenant:read'
    )
 );

DELETE FROM public.permissions
 WHERE code IN (
   'tenant:settings:read',
   'tenant:settings:manage',
   'tenant:branding:read',
   'tenant:branding:manage',
   'tenant:roles:assign',
   'tenant:invitations:read',
   'tenant:invitations:manage',
   'tenant:admins:read',
   'tenant:admins:manage',
   'audit:tenant:read'
 );

-- 3. Restore `public.tenant_memberships` to Migration 0003 definition
DROP TRIGGER IF EXISTS trg_tenant_memberships_immutability ON public.tenant_memberships;

CREATE OR REPLACE FUNCTION public.trigger_protect_membership_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Membership tenant_id, user_id, and created_at are immutable'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tenant_memberships_immutability
  BEFORE UPDATE ON public.tenant_memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_protect_membership_immutability();

DROP INDEX IF EXISTS public.uq_tenant_memberships_primary_owner;

ALTER TABLE public.tenant_memberships
  DROP CONSTRAINT IF EXISTS chk_tm_status_reason_nonempty,
  DROP CONSTRAINT IF EXISTS chk_tm_primary_owner_internal_active,
  DROP COLUMN IF EXISTS status_reason,
  DROP COLUMN IF EXISTS revoked_at,
  DROP COLUMN IF EXISTS suspended_at,
  DROP COLUMN IF EXISTS is_primary_owner;

-- 4. Restore `public.tenants` to Migration 0003 definition
CREATE OR REPLACE FUNCTION public.trigger_protect_tenant_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user <> 'ft360_migrator' AND NOT public.app_is_super_admin() THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.slug IS DISTINCT FROM OLD.slug
       OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
       OR NEW.suspended_at IS DISTINCT FROM OLD.suspended_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Insufficient privileges to modify platform-controlled tenant lifecycle fields'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

UPDATE public.tenants
   SET status = 'SUSPENDED',
       suspended_at = COALESCE(suspended_at, NOW())
 WHERE status = 'DEACTIVATED';

DROP INDEX IF EXISTS public.idx_tenants_created_by_user;

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS chk_tenants_status_reason_nonempty,
  DROP CONSTRAINT IF EXISTS chk_tenants_status,
  DROP CONSTRAINT IF EXISTS fk_tenants_created_by_user,
  DROP COLUMN IF EXISTS created_by_user_id,
  DROP COLUMN IF EXISTS onboarding_completed_at,
  DROP COLUMN IF EXISTS status_reason,
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS deactivated_at;

ALTER TABLE public.tenants
  ADD CONSTRAINT chk_tenants_status CHECK (
    status IN ('PROVISIONING', 'TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED')
  );

-- 5. Restore `public.users` email constraints to Migration 0003 definition
DROP INDEX IF EXISTS public.uq_users_email_normalized;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS chk_users_email_canonical_trimmed;

-- 6. Drop PostgreSQL lifecycle helpers
DROP FUNCTION IF EXISTS public.fn_assert_tenant_operational(UUID);
DROP FUNCTION IF EXISTS public.fn_is_current_tenant_operational();
