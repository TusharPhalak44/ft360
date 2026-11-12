-- =============================================================================
-- Migration: 0003_users_tenants_and_memberships (DOWN)
-- Owner Role: ft360_migrator
-- Purpose: Deterministic reverse teardown of 0003 objects
-- =============================================================================

REVOKE ALL ON FUNCTION public.fn_list_user_tenants(UUID) FROM ft360_app;
DROP FUNCTION IF EXISTS public.fn_list_user_tenants(UUID);

REVOKE ALL ON FUNCTION public.fn_verify_tenant_membership(UUID, UUID) FROM ft360_app;
DROP FUNCTION IF EXISTS public.fn_verify_tenant_membership(UUID, UUID);

-- Drop cross-table RLS policy on users before dropping tenant_memberships
DROP POLICY IF EXISTS users_select ON public.users;

REVOKE ALL ON TABLE public.tenant_memberships FROM ft360_app;
DROP TABLE IF EXISTS public.tenant_memberships;

REVOKE ALL ON TABLE public.tenants FROM ft360_app;
DROP TABLE IF EXISTS public.tenants;
DROP FUNCTION IF EXISTS public.trigger_protect_tenant_lifecycle();

REVOKE ALL ON TABLE public.users FROM ft360_app;
DROP TABLE IF EXISTS public.users;
DROP FUNCTION IF EXISTS public.trigger_protect_user_privileged_fields();
