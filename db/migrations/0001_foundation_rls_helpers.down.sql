-- =============================================================================
-- Migration: 0001_foundation_rls_helpers (DOWN)
-- =============================================================================

REVOKE EXECUTE ON FUNCTION app_current_tenant_id() FROM ft360_app;
REVOKE EXECUTE ON FUNCTION app_current_user_id() FROM ft360_app;
REVOKE EXECUTE ON FUNCTION app_is_super_admin() FROM ft360_app;

DROP FUNCTION IF EXISTS trigger_set_updated_at();
DROP FUNCTION IF EXISTS app_is_super_admin();
DROP FUNCTION IF EXISTS app_current_user_id();
DROP FUNCTION IF EXISTS app_current_tenant_id();

