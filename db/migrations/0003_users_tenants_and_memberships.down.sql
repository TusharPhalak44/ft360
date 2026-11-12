-- =============================================================================
-- Migration: 0003_users_tenants_and_memberships (DOWN)
-- Owner Role: ft360_migrator
-- Purpose: Deterministic, idempotent reverse teardown of 0003 objects
-- =============================================================================

DROP FUNCTION IF EXISTS public.fn_list_user_tenants(UUID);
DROP FUNCTION IF EXISTS public.fn_verify_tenant_membership(UUID, UUID);

-- Drop cross-table RLS policy on users before dropping tenant_memberships
DROP POLICY IF EXISTS users_select ON public.users;

DROP TABLE IF EXISTS public.tenant_memberships;
DROP FUNCTION IF EXISTS public.trigger_protect_membership_immutability();

DROP TABLE IF EXISTS public.tenants;
DROP FUNCTION IF EXISTS public.trigger_protect_tenant_lifecycle();

DROP TABLE IF EXISTS public.users;
DROP FUNCTION IF EXISTS public.trigger_protect_user_privileged_fields();
