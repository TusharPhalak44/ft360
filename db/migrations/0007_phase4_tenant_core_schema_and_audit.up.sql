-- =============================================================================
-- Migration: 0007_phase4_tenant_core_schema_and_audit (UP)
-- Owner Role: ft360_migrator (ft360_app NEVER owns tables)
-- Purpose:
--   1. PostgreSQL-native tenant operational lifecycle helpers (`fn_is_current_tenant_operational`,
--      `fn_assert_tenant_operational`) enforcing tenant status even when Redis is unavailable.
--   2. Canonical global email uniqueness hardening on `public.users`.
--   3. Core `public.tenants` lifecycle extensions (`DEACTIVATED`, `OD-P1` two-step cancellation
--      safeguard, terminal `CANCELLED` immutability, `created_by_user_id`).
--   4. `public.tenant_memberships` primary ownership & status metadata (`is_primary_owner`,
--      partial unique index `uq_tenant_memberships_primary_owner`).
--   5. Seed `10` new canonical `TENANT` permission codes (`24` total permissions).
--   6. Six Phase 4 `FORCE RLS` tables with composite FKs:
--        - `tenant_onboarding_states`
--        - `tenant_profiles`
--        - `tenant_settings`
--        - `tenant_branding_assets`
--        - `tenant_branding_settings`
--        - `tenant_audit_logs` (append-only + `fn_record_tenant_audit_log`)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. POSTGRESQL TENANT LIFECYCLE VALIDATION HELPERS (ZERO REDIS DEPENDENCY)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_is_current_tenant_operational()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tid UUID := public.app_current_tenant_id();
BEGIN
  IF v_tid IS NULL THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.tenants t
     WHERE t.id = v_tid
       AND t.status IN ('ACTIVE', 'TRIAL')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_is_current_tenant_operational() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_is_current_tenant_operational() TO ft360_app;

CREATE OR REPLACE FUNCTION public.fn_assert_tenant_operational(
  p_tenant_id UUID
)
RETURNS VARCHAR(24)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_status VARCHAR(24);
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Target tenant_id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT t.status
    INTO v_status
    FROM public.tenants t
   WHERE t.id = p_tenant_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target tenant organization does not exist'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_status NOT IN ('ACTIVE', 'TRIAL') THEN
    RAISE EXCEPTION 'TENANT_SUSPENDED_OR_INACTIVE: organization status is %', v_status
      USING ERRCODE = '42501';
  END IF;

  RETURN v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_assert_tenant_operational(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_assert_tenant_operational(UUID) TO ft360_app;

-- -----------------------------------------------------------------------------
-- 2. GLOBAL USERS CANONICAL EMAIL UNIQUENESS HARDENING
-- -----------------------------------------------------------------------------
ALTER TABLE public.users
  ADD CONSTRAINT chk_users_email_canonical_trimmed CHECK (
    email::text = btrim(email::text)
  );

CREATE UNIQUE INDEX uq_users_email_normalized
  ON public.users (lower(btrim(email::text)));

-- -----------------------------------------------------------------------------
-- 3. PUBLIC.TENANTS LIFECYCLE & PROVISIONING EXTENSIONS
-- -----------------------------------------------------------------------------
ALTER TABLE public.tenants
  DROP CONSTRAINT chk_tenants_status;

ALTER TABLE public.tenants
  ADD COLUMN deactivated_at TIMESTAMPTZ NULL,
  ADD COLUMN cancelled_at TIMESTAMPTZ NULL,
  ADD COLUMN status_reason VARCHAR(500) NULL,
  ADD COLUMN onboarding_completed_at TIMESTAMPTZ NULL,
  ADD COLUMN created_by_user_id UUID NULL;

ALTER TABLE public.tenants
  ADD CONSTRAINT fk_tenants_created_by_user
    FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL,
  ADD CONSTRAINT chk_tenants_status CHECK (
    status IN ('PROVISIONING', 'TRIAL', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'CANCELLED')
  ),
  ADD CONSTRAINT chk_tenants_status_reason_nonempty CHECK (
    status_reason IS NULL OR btrim(status_reason) <> ''
  );

CREATE INDEX idx_tenants_created_by_user
  ON public.tenants (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.trigger_protect_tenant_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user <> 'ft360_migrator' THEN
    -- 1. Authorization gate first: non-Super-Admin callers receive 42501 on any lifecycle field mutation
    IF NOT public.app_is_super_admin() THEN
      IF NEW.status IS DISTINCT FROM OLD.status
         OR NEW.slug IS DISTINCT FROM OLD.slug
         OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
         OR NEW.suspended_at IS DISTINCT FROM OLD.suspended_at
         OR NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at
         OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
         OR NEW.status_reason IS DISTINCT FROM OLD.status_reason
         OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Insufficient privileges to modify platform-controlled tenant lifecycle fields'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    -- 2. Terminal state invariant: CANCELLED can never transition outbound
    IF OLD.status = 'CANCELLED' AND (
         NEW.status IS DISTINCT FROM OLD.status
         OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
         OR NEW.suspended_at IS DISTINCT FROM OLD.suspended_at
         OR NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at
         OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       ) THEN
      RAISE EXCEPTION 'INVALID_TENANT_STATUS_TRANSITION: CANCELLED is a terminal lifecycle state'
        USING ERRCODE = '23514';
    END IF;

    -- 3. Confirmed OD-P1 safeguard: operational tenants require SUSPENDED or DEACTIVATED before CANCELLED
    IF NEW.status = 'CANCELLED' AND OLD.status IN ('TRIAL', 'ACTIVE') THEN
      RAISE EXCEPTION 'INVALID_TENANT_STATUS_TRANSITION: operational tenants must be suspended or deactivated before cancellation (OD-P1)'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. PUBLIC.TENANT_MEMBERSHIPS PRIMARY OWNERSHIP & LIFECYCLE EXTENSIONS
-- -----------------------------------------------------------------------------
ALTER TABLE public.tenant_memberships
  ADD COLUMN is_primary_owner BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN suspended_at TIMESTAMPTZ NULL,
  ADD COLUMN revoked_at TIMESTAMPTZ NULL,
  ADD COLUMN status_reason VARCHAR(500) NULL;

ALTER TABLE public.tenant_memberships
  ADD CONSTRAINT chk_tm_primary_owner_internal_active CHECK (
    NOT is_primary_owner OR (membership_type = 'INTERNAL' AND status = 'ACTIVE')
  ),
  ADD CONSTRAINT chk_tm_status_reason_nonempty CHECK (
    status_reason IS NULL OR btrim(status_reason) <> ''
  );

CREATE UNIQUE INDEX uq_tenant_memberships_primary_owner
  ON public.tenant_memberships (tenant_id)
  WHERE is_primary_owner = TRUE AND status = 'ACTIVE';

DROP TRIGGER trg_tenant_memberships_immutability ON public.tenant_memberships;

CREATE OR REPLACE FUNCTION public.trigger_protect_membership_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user <> 'ft360_migrator'
       AND NOT public.app_is_super_admin()
       AND NEW.is_primary_owner = TRUE THEN
      RAISE EXCEPTION 'Primary owner assignment requires verified provisioning or ownership-transfer routine'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Membership tenant_id, user_id, and created_at are immutable'
      USING ERRCODE = '42501';
  END IF;

  IF current_user <> 'ft360_migrator'
     AND NOT public.app_is_super_admin()
     AND NEW.is_primary_owner IS DISTINCT FROM OLD.is_primary_owner THEN
    RAISE EXCEPTION 'Primary owner transfer requires verified ownership-transfer routine'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tenant_memberships_immutability
  BEFORE INSERT OR UPDATE ON public.tenant_memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_protect_membership_immutability();

-- -----------------------------------------------------------------------------
-- 5. SEED 10 CANONICAL PHASE 4 TENANT PERMISSIONS (24 TOTAL)
-- -----------------------------------------------------------------------------
INSERT INTO public.permissions (code, scope_plane, module_code, description)
VALUES
  ('tenant:settings:read', 'TENANT', 'M04', 'Read active organization regional, calendar, and workspace settings'),
  ('tenant:settings:manage', 'TENANT', 'M04', 'Update organization regional preferences, invitation TTL, and directory privacy'),
  ('tenant:branding:read', 'TENANT', 'M04', 'Read resolved organization branding theme and stream tenant brand assets'),
  ('tenant:branding:manage', 'TENANT', 'M04', 'Manage organization branding theme and upload or remove validated raster assets'),
  ('tenant:roles:assign', 'TENANT', 'M05', 'Assign or replace tenant-scoped roles on organization memberships'),
  ('tenant:invitations:read', 'TENANT', 'M04', 'List pending, accepted, expired, and revoked organization invitations'),
  ('tenant:invitations:manage', 'TENANT', 'M04', 'Issue, resend, and revoke cryptographic single-use organization invitations'),
  ('tenant:admins:read', 'TENANT', 'M04', 'View organization administrator roster and primary owner posture'),
  ('tenant:admins:manage', 'TENANT', 'M04', 'Promote or demote tenant administrators and transfer primary ownership'),
  ('audit:tenant:read', 'TENANT', 'M31', 'Query immutable tenant domain governance and state-diff audit logs')
ON CONFLICT (code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 6. TABLE #1: PUBLIC.TENANT_ONBOARDING_STATES (1:1 Tenant Setup State)
-- -----------------------------------------------------------------------------
CREATE TABLE public.tenant_onboarding_states (
  tenant_id UUID NOT NULL,
  onboarding_status VARCHAR(24) NOT NULL DEFAULT 'IN_PROGRESS',
  current_step VARCHAR(32) NOT NULL DEFAULT 'ORG_PROFILE',
  org_profile_completed_at TIMESTAMPTZ NULL,
  org_settings_completed_at TIMESTAMPTZ NULL,
  org_branding_completed_at TIMESTAMPTZ NULL,
  org_branding_skipped BOOLEAN NOT NULL DEFAULT FALSE,
  team_invites_completed_at TIMESTAMPTZ NULL,
  team_invites_skipped BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ NULL,
  completed_by_membership_id UUID NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_tenant_onboarding_states PRIMARY KEY (tenant_id),
  CONSTRAINT fk_tos_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_tos_completed_by_membership
    FOREIGN KEY (tenant_id, completed_by_membership_id)
    REFERENCES public.tenant_memberships(tenant_id, id)
    ON DELETE SET NULL (completed_by_membership_id),
  CONSTRAINT chk_tos_status CHECK (
    onboarding_status IN ('IN_PROGRESS', 'COMPLETED')
  ),
  CONSTRAINT chk_tos_step CHECK (
    current_step IN ('ORG_PROFILE', 'ORG_SETTINGS', 'ORG_BRANDING', 'TEAM_INVITES', 'REVIEW_COMPLETE')
  ),
  CONSTRAINT chk_tos_completion_integrity CHECK (
    (onboarding_status = 'IN_PROGRESS' AND completed_at IS NULL)
    OR (
      onboarding_status = 'COMPLETED'
      AND completed_at IS NOT NULL
      AND org_profile_completed_at IS NOT NULL
      AND org_settings_completed_at IS NOT NULL
    )
  ),
  CONSTRAINT chk_tos_version_positive CHECK (version >= 1)
);

CREATE INDEX idx_tos_incomplete
  ON public.tenant_onboarding_states (onboarding_status, created_at DESC)
  WHERE onboarding_status = 'IN_PROGRESS';

CREATE TRIGGER trg_tenant_onboarding_states_updated_at
  BEFORE UPDATE ON public.tenant_onboarding_states
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.tenant_onboarding_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_onboarding_states FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_tenant_onboarding_states ON public.tenant_onboarding_states
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY tenant_onboarding_states_select ON public.tenant_onboarding_states
  FOR SELECT
  TO ft360_app
  USING (
    tenant_id = public.app_current_tenant_id()
    OR public.app_is_super_admin()
  );

CREATE POLICY tenant_onboarding_states_insert ON public.tenant_onboarding_states
  FOR INSERT
  TO ft360_app
  WITH CHECK (
    (tenant_id = public.app_current_tenant_id() AND public.fn_is_current_tenant_operational())
    OR public.app_is_super_admin()
  );

CREATE POLICY tenant_onboarding_states_update ON public.tenant_onboarding_states
  FOR UPDATE
  TO ft360_app
  USING (
    (tenant_id = public.app_current_tenant_id() AND public.fn_is_current_tenant_operational())
    OR public.app_is_super_admin()
  )
  WITH CHECK (
    (tenant_id = public.app_current_tenant_id() AND public.fn_is_current_tenant_operational())
    OR public.app_is_super_admin()
  );

GRANT SELECT, INSERT, UPDATE ON public.tenant_onboarding_states TO ft360_app;

-- -----------------------------------------------------------------------------
-- 7. TABLE #2: PUBLIC.TENANT_PROFILES (1:1 Organization Profile)
-- -----------------------------------------------------------------------------
CREATE TABLE public.tenant_profiles (
  tenant_id UUID NOT NULL,
  organization_type VARCHAR(32) NOT NULL DEFAULT 'COMPANY',
  industry VARCHAR(48) NOT NULL DEFAULT 'OTHER',
  company_size_band VARCHAR(24) NULL,
  registration_number VARCHAR(80) NULL,
  tax_id VARCHAR(80) NULL,
  website_url VARCHAR(512) NULL,
  primary_contact_name VARCHAR(160) NULL,
  primary_contact_email CITEXT NULL,
  primary_contact_phone_e164 VARCHAR(24) NULL,
  support_email CITEXT NULL,
  address_line1 VARCHAR(200) NULL,
  address_line2 VARCHAR(200) NULL,
  city VARCHAR(120) NULL,
  state_province VARCHAR(120) NULL,
  postal_code VARCHAR(32) NULL,
  country_code CHAR(2) NOT NULL DEFAULT 'US',
  about_description VARCHAR(1000) NULL,
  updated_by_membership_id UUID NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_tenant_profiles PRIMARY KEY (tenant_id),
  CONSTRAINT fk_tenant_profiles_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_tenant_profiles_updated_by
    FOREIGN KEY (tenant_id, updated_by_membership_id)
    REFERENCES public.tenant_memberships(tenant_id, id)
    ON DELETE SET NULL (updated_by_membership_id),
  CONSTRAINT chk_tp_org_type CHECK (
    organization_type IN ('COMPANY', 'AGENCY', 'ENTERPRISE', 'NONPROFIT', 'GOVERNMENT', 'SOLE_PROPRIETORSHIP', 'PARTNERSHIP', 'OTHER')
  ),
  CONSTRAINT chk_tp_industry CHECK (
    industry IN ('SAAS_TECHNOLOGY', 'MARKETING_AGENCY', 'FINANCE_FINTECH', 'HEALTHCARE', 'ECOMMERCE_RETAIL', 'REAL_ESTATE', 'EDUCATION', 'MANUFACTURING', 'CONSULTING', 'LOGISTICS', 'OTHER')
  ),
  CONSTRAINT chk_tp_size_band CHECK (
    company_size_band IS NULL OR company_size_band IN ('1_10', '11_50', '51_200', '201_1000', '1000_PLUS')
  ),
  CONSTRAINT chk_tp_website_url CHECK (
    website_url IS NULL OR website_url ~ '^https?://[^\s/$.?#].[^\s]*$'
  ),
  CONSTRAINT chk_tp_emails CHECK (
    (primary_contact_email IS NULL OR primary_contact_email::text ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
    AND (support_email IS NULL OR support_email::text ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
  ),
  CONSTRAINT chk_tp_phone_e164 CHECK (
    primary_contact_phone_e164 IS NULL OR primary_contact_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'
  ),
  CONSTRAINT chk_tp_country_iso2 CHECK (
    country_code ~ '^[A-Z]{2}$'
  ),
  CONSTRAINT chk_tp_version_positive CHECK (version >= 1)
);

CREATE INDEX idx_tp_industry_country
  ON public.tenant_profiles (industry, country_code);

CREATE TRIGGER trg_tenant_profiles_updated_at
  BEFORE UPDATE ON public.tenant_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.tenant_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_profiles FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_tenant_profiles ON public.tenant_profiles
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY tenant_profiles_select ON public.tenant_profiles
  FOR SELECT
  TO ft360_app
  USING (
    tenant_id = public.app_current_tenant_id()
    OR public.app_is_super_admin()
  );

CREATE POLICY tenant_profiles_insert ON public.tenant_profiles
  FOR INSERT
  TO ft360_app
  WITH CHECK (
    (tenant_id = public.app_current_tenant_id() AND public.fn_is_current_tenant_operational())
    OR public.app_is_super_admin()
  );

CREATE POLICY tenant_profiles_update ON public.tenant_profiles
  FOR UPDATE
  TO ft360_app
  USING (
    (tenant_id = public.app_current_tenant_id() AND public.fn_is_current_tenant_operational())
    OR public.app_is_super_admin()
  )
  WITH CHECK (
    (tenant_id = public.app_current_tenant_id() AND public.fn_is_current_tenant_operational())
    OR public.app_is_super_admin()
  );

GRANT SELECT, INSERT, UPDATE ON public.tenant_profiles TO ft360_app;

-- -----------------------------------------------------------------------------
-- 8. TABLE #3: PUBLIC.TENANT_SETTINGS (1:1 Preferences & Privacy)
-- -----------------------------------------------------------------------------
CREATE TABLE public.tenant_settings (
  tenant_id UUID NOT NULL,
  timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
  locale VARCHAR(16) NOT NULL DEFAULT 'en-US',
  date_format VARCHAR(24) NOT NULL DEFAULT 'YYYY-MM-DD',
  time_format VARCHAR(8) NOT NULL DEFAULT '24H',
  default_currency CHAR(3) NOT NULL DEFAULT 'USD',
  week_start_day SMALLINT NOT NULL DEFAULT 1,
  fiscal_year_start_month SMALLINT NOT NULL DEFAULT 1,
  invitation_expiry_hours INTEGER NOT NULL DEFAULT 168,
  allow_member_directory_view BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by_membership_id UUID NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_tenant_settings PRIMARY KEY (tenant_id),
  CONSTRAINT fk_tenant_settings_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_tenant_settings_updated_by
    FOREIGN KEY (tenant_id, updated_by_membership_id)
    REFERENCES public.tenant_memberships(tenant_id, id)
    ON DELETE SET NULL (updated_by_membership_id),
  CONSTRAINT chk_ts_timezone_nonempty CHECK (btrim(timezone) <> ''),
  CONSTRAINT chk_ts_locale CHECK (
    locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
  ),
  CONSTRAINT chk_ts_date_format CHECK (
    date_format IN ('YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MMM-YYYY')
  ),
  CONSTRAINT chk_ts_time_format CHECK (
    time_format IN ('12H', '24H')
  ),
  CONSTRAINT chk_ts_currency_iso CHECK (
    default_currency ~ '^[A-Z]{3}$'
  ),
  CONSTRAINT chk_ts_week_start CHECK (
    week_start_day BETWEEN 0 AND 6
  ),
  CONSTRAINT chk_ts_fiscal_month CHECK (
    fiscal_year_start_month BETWEEN 1 AND 12
  ),
  CONSTRAINT chk_ts_invite_expiry CHECK (
    invitation_expiry_hours BETWEEN 1 AND 720
  ),
  CONSTRAINT chk_ts_version_positive CHECK (version >= 1)
);

CREATE TRIGGER trg_tenant_settings_updated_at
  BEFORE UPDATE ON public.tenant_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_tenant_settings ON public.tenant_settings
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY tenant_settings_select ON public.tenant_settings
  FOR SELECT
  TO ft360_app
  USING (
    tenant_id = public.app_current_tenant_id()
    OR public.app_is_super_admin()
  );

CREATE POLICY tenant_settings_insert ON public.tenant_settings
  FOR INSERT
  TO ft360_app
  WITH CHECK (
    (tenant_id = public.app_current_tenant_id() AND public.fn_is_current_tenant_operational())
    OR public.app_is_super_admin()
  );

CREATE POLICY tenant_settings_update ON public.tenant_settings
  FOR UPDATE
  TO ft360_app
  USING (
    (tenant_id = public.app_current_tenant_id() AND public.fn_is_current_tenant_operational())
    OR public.app_is_super_admin()
  )
  WITH CHECK (
    (tenant_id = public.app_current_tenant_id() AND public.fn_is_current_tenant_operational())
    OR public.app_is_super_admin()
  );

GRANT SELECT, INSERT, UPDATE ON public.tenant_settings TO ft360_app;

-- -----------------------------------------------------------------------------
-- 9. TABLE #4: PUBLIC.TENANT_BRANDING_ASSETS (Decoded Raster Asset Ledger)
-- -----------------------------------------------------------------------------
CREATE TABLE public.tenant_branding_assets (
  id UUID NOT NULL DEFAULT uuidv7(),
  tenant_id UUID NOT NULL,
  asset_kind VARCHAR(24) NOT NULL,
  storage_key VARCHAR(512) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(64) NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256_checksum CHAR(64) NOT NULL,
  width_px INTEGER NOT NULL,
  height_px INTEGER NOT NULL,
  metadata_stripped BOOLEAN NOT NULL DEFAULT TRUE,
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  uploaded_by_membership_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_tenant_branding_assets PRIMARY KEY (id),
  CONSTRAINT uq_tba_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_tba_storage_key UNIQUE (storage_key),
  CONSTRAINT fk_tba_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_tba_uploaded_by
    FOREIGN KEY (tenant_id, uploaded_by_membership_id)
    REFERENCES public.tenant_memberships(tenant_id, id)
    ON DELETE SET NULL (uploaded_by_membership_id),
  CONSTRAINT chk_tba_kind CHECK (
    asset_kind IN ('LOGO_LIGHT', 'LOGO_DARK', 'FAVICON')
  ),
  CONSTRAINT chk_tba_mime_allowlist CHECK (
    (asset_kind IN ('LOGO_LIGHT', 'LOGO_DARK') AND mime_type IN ('image/png', 'image/jpeg', 'image/webp'))
    OR (asset_kind = 'FAVICON' AND mime_type IN ('image/png', 'image/webp'))
  ),
  CONSTRAINT chk_tba_size_bounds CHECK (
    (asset_kind = 'FAVICON' AND byte_size BETWEEN 1 AND 262144)
    OR (asset_kind IN ('LOGO_LIGHT', 'LOGO_DARK') AND byte_size BETWEEN 1 AND 2097152)
  ),
  CONSTRAINT chk_tba_dimension_and_pixel_bounds CHECK (
    (
      asset_kind IN ('LOGO_LIGHT', 'LOGO_DARK')
      AND width_px BETWEEN 16 AND 2048
      AND height_px BETWEEN 16 AND 2048
      AND (width_px * height_px) <= 4194304
    )
    OR (
      asset_kind = 'FAVICON'
      AND width_px BETWEEN 16 AND 512
      AND height_px = width_px
      AND (width_px * height_px) <= 262144
    )
  ),
  CONSTRAINT chk_tba_metadata_stripped CHECK (metadata_stripped = TRUE),
  CONSTRAINT chk_tba_storage_prefix CHECK (
    storage_key LIKE ('tenants/' || tenant_id::text || '/branding/%')
    AND storage_key !~ '\.\.'
  ),
  CONSTRAINT chk_tba_sha256_hex CHECK (
    sha256_checksum ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_tba_status CHECK (
    status IN ('ACTIVE', 'SUPERSEDED', 'DELETED')
  )
);

CREATE INDEX idx_tba_tenant_kind_status
  ON public.tenant_branding_assets (tenant_id, asset_kind, status);

CREATE TRIGGER trg_tenant_branding_assets_updated_at
  BEFORE UPDATE ON public.tenant_branding_assets
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.tenant_branding_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_branding_assets FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_tenant_branding_assets ON public.tenant_branding_assets
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY tenant_branding_assets_select ON public.tenant_branding_assets
  FOR SELECT
  TO ft360_app
  USING (
    tenant_id = public.app_current_tenant_id()
    OR public.app_is_super_admin()
  );

CREATE POLICY tenant_branding_assets_insert ON public.tenant_branding_assets
  FOR INSERT
  TO ft360_app
  WITH CHECK (
    (tenant_id = public.app_current_tenant_id() AND public.fn_is_current_tenant_operational())
    OR public.app_is_super_admin()
  );

CREATE POLICY tenant_branding_assets_update ON public.tenant_branding_assets
  FOR UPDATE
  TO ft360_app
  USING (
    (tenant_id = public.app_current_tenant_id() AND public.fn_is_current_tenant_operational())
    OR public.app_is_super_admin()
  )
  WITH CHECK (
    (tenant_id = public.app_current_tenant_id() AND public.fn_is_current_tenant_operational())
    OR public.app_is_super_admin()
  );

GRANT SELECT, INSERT, UPDATE ON public.tenant_branding_assets TO ft360_app;

-- -----------------------------------------------------------------------------
-- 10. TABLE #5: PUBLIC.TENANT_BRANDING_SETTINGS (1:1 Brand Theme)
-- -----------------------------------------------------------------------------
CREATE TABLE public.tenant_branding_settings (
  tenant_id UUID NOT NULL,
  brand_display_name VARCHAR(120) NULL,
  tagline VARCHAR(255) NULL,
  primary_color_hex CHAR(7) NOT NULL DEFAULT '#2563EB',
  accent_color_hex CHAR(7) NOT NULL DEFAULT '#0F172A',
  theme_mode VARCHAR(16) NOT NULL DEFAULT 'LIGHT',
  logo_light_asset_id UUID NULL,
  logo_dark_asset_id UUID NULL,
  favicon_asset_id UUID NULL,
  support_email CITEXT NULL,
  support_url VARCHAR(512) NULL,
  email_footer_text VARCHAR(300) NULL,
  updated_by_membership_id UUID NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_tenant_branding_settings PRIMARY KEY (tenant_id),
  CONSTRAINT fk_tbs_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_tbs_logo_light
    FOREIGN KEY (tenant_id, logo_light_asset_id)
    REFERENCES public.tenant_branding_assets(tenant_id, id)
    ON DELETE SET NULL (logo_light_asset_id),
  CONSTRAINT fk_tbs_logo_dark
    FOREIGN KEY (tenant_id, logo_dark_asset_id)
    REFERENCES public.tenant_branding_assets(tenant_id, id)
    ON DELETE SET NULL (logo_dark_asset_id),
  CONSTRAINT fk_tbs_favicon
    FOREIGN KEY (tenant_id, favicon_asset_id)
    REFERENCES public.tenant_branding_assets(tenant_id, id)
    ON DELETE SET NULL (favicon_asset_id),
  CONSTRAINT fk_tbs_updated_by
    FOREIGN KEY (tenant_id, updated_by_membership_id)
    REFERENCES public.tenant_memberships(tenant_id, id)
    ON DELETE SET NULL (updated_by_membership_id),
  CONSTRAINT chk_tbs_primary_hex CHECK (primary_color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT chk_tbs_accent_hex CHECK (accent_color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT chk_tbs_theme_mode CHECK (theme_mode IN ('LIGHT', 'DARK', 'SYSTEM')),
  CONSTRAINT chk_tbs_support_email CHECK (
    support_email IS NULL OR support_email::text ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  ),
  CONSTRAINT chk_tbs_support_url CHECK (
    support_url IS NULL OR support_url ~ '^https?://[^\s/$.?#].[^\s]*$'
  ),
  CONSTRAINT chk_tbs_version_positive CHECK (version >= 1)
);

CREATE TRIGGER trg_tenant_branding_settings_updated_at
  BEFORE UPDATE ON public.tenant_branding_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.tenant_branding_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_branding_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_tenant_branding_settings ON public.tenant_branding_settings
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY tenant_branding_settings_select ON public.tenant_branding_settings
  FOR SELECT
  TO ft360_app
  USING (
    tenant_id = public.app_current_tenant_id()
    OR public.app_is_super_admin()
  );

CREATE POLICY tenant_branding_settings_insert ON public.tenant_branding_settings
  FOR INSERT
  TO ft360_app
  WITH CHECK (
    (tenant_id = public.app_current_tenant_id() AND public.fn_is_current_tenant_operational())
    OR public.app_is_super_admin()
  );

CREATE POLICY tenant_branding_settings_update ON public.tenant_branding_settings
  FOR UPDATE
  TO ft360_app
  USING (
    (tenant_id = public.app_current_tenant_id() AND public.fn_is_current_tenant_operational())
    OR public.app_is_super_admin()
  )
  WITH CHECK (
    (tenant_id = public.app_current_tenant_id() AND public.fn_is_current_tenant_operational())
    OR public.app_is_super_admin()
  );

GRANT SELECT, INSERT, UPDATE ON public.tenant_branding_settings TO ft360_app;

-- -----------------------------------------------------------------------------
-- 11. TABLE #6: PUBLIC.TENANT_AUDIT_LOGS (Immutable Domain State-Diff Ledger)
-- -----------------------------------------------------------------------------
CREATE TABLE public.tenant_audit_logs (
  id UUID NOT NULL DEFAULT uuidv7(),
  tenant_id UUID NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  resource_type VARCHAR(48) NOT NULL,
  resource_id UUID NULL,
  outcome VARCHAR(16) NOT NULL DEFAULT 'SUCCESS',
  actor_plane VARCHAR(24) NOT NULL,
  actor_user_id UUID NULL,
  actor_membership_id UUID NULL,
  reason VARCHAR(500) NULL,
  before_state JSONB NULL,
  after_state JSONB NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id UUID NOT NULL,
  ip_address INET NULL,
  user_agent VARCHAR(512) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_tenant_audit_logs PRIMARY KEY (id),
  CONSTRAINT fk_tal_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_tal_actor_user
    FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT fk_tal_actor_membership
    FOREIGN KEY (tenant_id, actor_membership_id)
    REFERENCES public.tenant_memberships(tenant_id, id)
    ON DELETE SET NULL (actor_membership_id),
  CONSTRAINT chk_tal_event_type_nonempty CHECK (btrim(event_type) <> ''),
  CONSTRAINT chk_tal_resource_type CHECK (
    resource_type IN (
      'TENANT',
      'ONBOARDING',
      'PROFILE',
      'SETTINGS',
      'BRANDING',
      'INVITATION',
      'MEMBERSHIP',
      'ROLE_ASSIGNMENT'
    )
  ),
  CONSTRAINT chk_tal_outcome CHECK (
    outcome IN ('SUCCESS', 'FAILURE', 'DENIED')
  ),
  CONSTRAINT chk_tal_plane CHECK (
    actor_plane IN ('TENANT', 'PLATFORM', 'USER_ONBOARDING')
  ),
  CONSTRAINT chk_tal_reason_nonempty CHECK (
    reason IS NULL OR btrim(reason) <> ''
  ),
  CONSTRAINT chk_tal_metadata_object CHECK (
    jsonb_typeof(metadata) = 'object'
    AND (before_state IS NULL OR jsonb_typeof(before_state) = 'object')
    AND (after_state IS NULL OR jsonb_typeof(after_state) = 'object')
  ),
  CONSTRAINT chk_tal_no_secret_keys CHECK (
    NOT public.fn_jsonb_has_forbidden_secret_key(COALESCE(before_state, '{}'::jsonb))
    AND NOT public.fn_jsonb_has_forbidden_secret_key(COALESCE(after_state, '{}'::jsonb))
    AND NOT public.fn_jsonb_has_forbidden_secret_key(metadata)
  )
);

CREATE INDEX idx_tal_tenant_created
  ON public.tenant_audit_logs (tenant_id, created_at DESC, id DESC);

CREATE INDEX idx_tal_tenant_event
  ON public.tenant_audit_logs (tenant_id, event_type, created_at DESC);

CREATE INDEX idx_tal_tenant_resource
  ON public.tenant_audit_logs (tenant_id, resource_type, resource_id);

CREATE INDEX idx_tal_correlation
  ON public.tenant_audit_logs (correlation_id);

CREATE OR REPLACE FUNCTION public.trigger_protect_tenant_audit_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user <> 'ft360_migrator' THEN
    RAISE EXCEPTION 'Tenant domain audit logs are strictly append-only and immutable'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tenant_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON public.tenant_audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_protect_tenant_audit_immutability();

ALTER TABLE public.tenant_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_audit_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_tenant_audit_logs ON public.tenant_audit_logs
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY tenant_audit_logs_select ON public.tenant_audit_logs
  FOR SELECT
  TO ft360_app
  USING (
    tenant_id = public.app_current_tenant_id()
    OR public.app_is_super_admin()
  );

-- Least-privilege: SELECT only for ft360_app; writes go exclusively via fn_record_tenant_audit_log
GRANT SELECT ON public.tenant_audit_logs TO ft360_app;

-- 11B. Hardened Plane- & Membership-Verified Tenant Domain Audit Writer
CREATE OR REPLACE FUNCTION public.fn_record_tenant_audit_log(
  p_tenant_id UUID,
  p_event_type VARCHAR(80),
  p_resource_type VARCHAR(48),
  p_outcome VARCHAR(16),
  p_actor_plane VARCHAR(24),
  p_correlation_id UUID,
  p_resource_id UUID DEFAULT NULL,
  p_actor_user_id UUID DEFAULT NULL,
  p_actor_membership_id UUID DEFAULT NULL,
  p_reason VARCHAR(500) DEFAULT NULL,
  p_before_state JSONB DEFAULT NULL,
  p_after_state JSONB DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb,
  p_ip_address INET DEFAULT NULL,
  p_user_agent VARCHAR(512) DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_current_tid UUID := public.app_current_tenant_id();
  v_current_uid UUID := public.app_current_user_id();
  v_is_super BOOLEAN := public.app_is_super_admin();
  v_trimmed_event VARCHAR(80) := btrim(p_event_type);
  v_trimmed_plane VARCHAR(24) := btrim(p_actor_plane);
  v_member RECORD;
  v_effective_membership_id UUID;
  v_audit_id UUID;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant audit log requires non-null tenant_id'
      USING ERRCODE = '22023';
  END IF;

  IF p_correlation_id IS NULL THEN
    RAISE EXCEPTION 'Tenant audit log requires non-null correlation_id'
      USING ERRCODE = '22023';
  END IF;

  IF v_trimmed_event IS NULL OR v_trimmed_event = '' THEN
    RAISE EXCEPTION 'Tenant audit event_type is required'
      USING ERRCODE = '22023';
  END IF;

  IF v_trimmed_plane = 'PLATFORM' THEN
    IF NOT v_is_super OR v_current_tid IS NOT NULL THEN
      RAISE EXCEPTION 'PLATFORM plane tenant audit events require an unscoped Platform Super Admin transaction'
        USING ERRCODE = '42501';
    END IF;

    IF v_current_uid IS NULL THEN
      RAISE EXCEPTION 'PLATFORM plane tenant audit events require verified app.current_user_id context'
        USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.users u
       WHERE u.id = v_current_uid
         AND u.is_platform_super_admin = TRUE
         AND u.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'Platform Super Admin status could not be verified in database'
        USING ERRCODE = '42501';
    END IF;

    IF p_actor_user_id IS NOT NULL AND p_actor_user_id <> v_current_uid THEN
      RAISE EXCEPTION 'PLATFORM tenant audit actor_user_id must match verified Super Admin user'
        USING ERRCODE = '42501';
    END IF;

    IF p_actor_membership_id IS NOT NULL THEN
      RAISE EXCEPTION 'PLATFORM plane audit events cannot claim a tenant actor_membership_id'
        USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant_id) THEN
      RAISE EXCEPTION 'Referenced tenant_id does not exist'
        USING ERRCODE = 'P0002';
    END IF;

    v_effective_membership_id := NULL;

  ELSIF v_trimmed_plane = 'TENANT' THEN
    IF v_is_super THEN
      RAISE EXCEPTION 'Platform Super Admin transactions must use PLATFORM actor_plane'
        USING ERRCODE = '42501';
    END IF;

    IF v_trimmed_event LIKE 'PLATFORM_%' THEN
      RAISE EXCEPTION 'PLATFORM_* event codes cannot be recorded from a TENANT plane transaction'
        USING ERRCODE = '42501';
    END IF;

    IF v_current_tid IS NULL OR v_current_tid <> p_tenant_id THEN
      RAISE EXCEPTION 'TENANT plane audit events must strictly match active app.current_tenant_id context'
        USING ERRCODE = '42501';
    END IF;

    IF v_current_uid IS NULL THEN
      RAISE EXCEPTION 'TENANT plane audit events require verified app.current_user_id context'
        USING ERRCODE = '42501';
    END IF;

    IF p_actor_user_id IS NOT NULL AND p_actor_user_id <> v_current_uid THEN
      RAISE EXCEPTION 'TENANT plane audit actor_user_id must match app.current_user_id'
        USING ERRCODE = '42501';
    END IF;

    SELECT *
      INTO v_member
      FROM public.fn_verify_tenant_membership(v_current_uid, v_current_tid);

    IF NOT FOUND
       OR v_member.user_status <> 'ACTIVE'
       OR v_member.membership_status <> 'ACTIVE'
       OR v_member.tenant_status NOT IN ('ACTIVE', 'TRIAL') THEN
      RAISE EXCEPTION 'Actor does not hold an active verified membership in an operational tenant'
        USING ERRCODE = '42501';
    END IF;

    IF p_actor_membership_id IS NOT NULL AND p_actor_membership_id <> v_member.membership_id THEN
      RAISE EXCEPTION 'actor_membership_id does not match verified database membership'
        USING ERRCODE = '42501';
    END IF;

    v_effective_membership_id := v_member.membership_id;

  ELSE
    -- USER_ONBOARDING is reserved strictly for internal atomic provisioning/invitation-acceptance routines
    RAISE EXCEPTION 'Direct invocation of fn_record_tenant_audit_log is restricted to TENANT or PLATFORM planes'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.tenant_audit_logs (
    tenant_id,
    event_type,
    resource_type,
    resource_id,
    outcome,
    actor_plane,
    actor_user_id,
    actor_membership_id,
    reason,
    before_state,
    after_state,
    metadata,
    correlation_id,
    ip_address,
    user_agent
  )
  VALUES (
    p_tenant_id,
    v_trimmed_event,
    btrim(p_resource_type),
    p_resource_id,
    btrim(p_outcome),
    v_trimmed_plane,
    v_current_uid,
    v_effective_membership_id,
    NULLIF(btrim(COALESCE(p_reason, '')), ''),
    p_before_state,
    p_after_state,
    COALESCE(p_metadata, '{}'::jsonb),
    p_correlation_id,
    p_ip_address,
    p_user_agent
  )
  RETURNING id INTO v_audit_id;

  RETURN v_audit_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_record_tenant_audit_log(
  UUID, VARCHAR, VARCHAR, VARCHAR, VARCHAR, UUID, UUID, UUID, UUID, VARCHAR, JSONB, JSONB, JSONB, INET, VARCHAR
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_record_tenant_audit_log(
  UUID, VARCHAR, VARCHAR, VARCHAR, VARCHAR, UUID, UUID, UUID, UUID, VARCHAR, JSONB, JSONB, JSONB, INET, VARCHAR
) TO ft360_app;
