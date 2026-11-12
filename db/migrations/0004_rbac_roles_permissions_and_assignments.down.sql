-- =============================================================================
-- Migration: 0004_rbac_roles_permissions_and_assignments (DOWN)
-- Owner Role: ft360_migrator
-- Purpose: Deterministic reverse teardown of 0004 RBAC & permission catalog
-- =============================================================================

REVOKE ALL ON TABLE public.user_role_assignments FROM ft360_app;
DROP TABLE IF EXISTS public.user_role_assignments;

REVOKE ALL ON TABLE public.role_permissions FROM ft360_app;
DROP TABLE IF EXISTS public.role_permissions;
DROP FUNCTION IF EXISTS public.trigger_enforce_tenant_permission_scope();

REVOKE ALL ON TABLE public.roles FROM ft360_app;
DROP TABLE IF EXISTS public.roles;

REVOKE ALL ON TABLE public.permissions FROM ft360_app;
DROP TABLE IF EXISTS public.permissions;
