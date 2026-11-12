-- =============================================================================
-- Migration: 0001_foundation_rls_helpers (UP)
-- Owner Role: ft360_migrator
-- Purpose: Fail-closed tenant context helper functions & timestamp trigger
-- =============================================================================

CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_raw TEXT;
BEGIN
  v_raw := NULLIF(btrim(current_setting('app.current_tenant_id', true)), '');
  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;

  -- Fail closed (NULL) if tenant context is malformed or non-UUID
  IF v_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;

  RETURN v_raw::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_raw TEXT;
BEGIN
  v_raw := NULLIF(btrim(current_setting('app.current_user_id', true)), '');
  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;

  RETURN v_raw::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION app_is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(current_setting('app.is_super_admin', true) = 'true', false);
$$;

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO ft360_app;
GRANT EXECUTE ON FUNCTION app_current_user_id() TO ft360_app;
GRANT EXECUTE ON FUNCTION app_is_super_admin() TO ft360_app;

