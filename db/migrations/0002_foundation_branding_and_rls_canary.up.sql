-- =============================================================================
-- Migration: 0002_foundation_branding_and_rls_canary (UP)
-- Owner Role: ft360_migrator (ft360_app NEVER owns tables)
-- Purpose:
--   1. Configurable global platform branding store (no hardcoded product names)
--   2. RLS-enforced tenant isolation verification table (`rls_isolation_canary`)
--      proving fail-closed RLS, non-owner app role, FORCE RLS, and pool safety
-- =============================================================================

CREATE TABLE platform_branding_settings (
  singleton_key BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton_key = TRUE),
  product_name VARCHAR(120) NOT NULL,
  tagline VARCHAR(255) NOT NULL,
  support_email VARCHAR(255) NOT NULL,
  website_url VARCHAR(512) NOT NULL,
  logo_light_url TEXT NULL,
  logo_dark_url TEXT NULL,
  favicon_url TEXT NULL,
  primary_color_hex CHAR(7) NOT NULL CHECK (primary_color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  accent_color_hex CHAR(7) NOT NULL CHECK (accent_color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_platform_branding_updated_at
  BEFORE UPDATE ON platform_branding_settings
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- Runtime app role can read global branding; mutations require Platform Admin transaction
ALTER TABLE platform_branding_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_branding_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY platform_branding_select_all ON platform_branding_settings
  FOR SELECT
  TO ft360_app
  USING (true);

CREATE POLICY platform_branding_write_super_admin ON platform_branding_settings
  FOR ALL
  TO ft360_app
  USING (app_is_super_admin())
  WITH CHECK (app_is_super_admin());

GRANT SELECT, INSERT, UPDATE ON platform_branding_settings TO ft360_app;

-- Foundation Tenant Isolation Verification Table (Protected by FORCE RLS)
CREATE TABLE rls_isolation_canary (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id UUID NOT NULL,
  probe_label VARCHAR(160) NOT NULL,
  created_by_user_id UUID NULL DEFAULT app_current_user_id(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_rls_canary_tenant_id_id UNIQUE (tenant_id, id)
);

CREATE INDEX idx_rls_canary_tenant_created
  ON rls_isolation_canary (tenant_id, created_at DESC);

ALTER TABLE rls_isolation_canary ENABLE ROW LEVEL SECURITY;
ALTER TABLE rls_isolation_canary FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON rls_isolation_canary
  FOR SELECT
  TO ft360_app
  USING (tenant_id = app_current_tenant_id());

CREATE POLICY tenant_isolation_insert ON rls_isolation_canary
  FOR INSERT
  TO ft360_app
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY tenant_isolation_update ON rls_isolation_canary
  FOR UPDATE
  TO ft360_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY tenant_isolation_delete ON rls_isolation_canary
  FOR DELETE
  TO ft360_app
  USING (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON rls_isolation_canary TO ft360_app;

