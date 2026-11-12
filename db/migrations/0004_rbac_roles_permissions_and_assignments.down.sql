-- =============================================================================
-- Migration: 0004_rbac_roles_permissions_and_assignments (DOWN)
-- Owner Role: ft360_migrator
-- Purpose: Deterministic, idempotent reverse teardown of 0004 RBAC & permissions
-- =============================================================================

DROP TRIGGER IF EXISTS trg_permissions_prevent_plane_escalation ON public.permissions;
DROP FUNCTION IF EXISTS public.trigger_prevent_permission_plane_escalation();

DROP TABLE IF EXISTS public.user_role_assignments;

DROP TABLE IF EXISTS public.role_permissions;
DROP FUNCTION IF EXISTS public.trigger_enforce_tenant_permission_scope();

DROP TABLE IF EXISTS public.roles;
DROP FUNCTION IF EXISTS public.trigger_protect_system_roles();

DROP TABLE IF EXISTS public.permissions;
