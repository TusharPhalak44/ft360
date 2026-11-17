-- =============================================================================
-- Migration: 0009_phase4b_tenant_registration_routines (DOWN)
-- Purpose: Removes ONLY the two Phase 4B registration routines introduced in 0009.
-- Zero existing tenant, membership, role, session, audit, or user data is deleted.
-- =============================================================================

DROP FUNCTION IF EXISTS public.fn_tenant_provision_organization(
  UUID, UUID, CITEXT, VARCHAR, VARCHAR, VARCHAR, VARCHAR, CHAR, VARCHAR, CHAR, UUID, INET, VARCHAR
);

DROP FUNCTION IF EXISTS public.fn_check_tenant_slug_available(CITEXT);
