-- =============================================================================
-- Migration: 0003_users_tenants_and_memberships (UP)
-- Owner Role: ft360_migrator (ft360_app NEVER owns tables)
-- Purpose:
--   1. Global platform identity directory (`users`) protected separately from tenants
--   2. Root multi-tenant organization table (`tenants`) with lifecycle status guards
--   3. Tenant membership bridge (`tenant_memberships`) with composite FK anchors
--   4. Narrow SECURITY DEFINER membership verification functions for pre-tx guards
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. USERS (Global Platform Identity Plane)
-- -----------------------------------------------------------------------------
CREATE TABLE public.users (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  email CITEXT NOT NULL,
  password_hash TEXT NULL,
  full_name VARCHAR(160) NOT NULL,
  phone_e164 VARCHAR(24) NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  is_platform_super_admin BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_users_email UNIQUE (email),
  CONSTRAINT chk_users_email_format CHECK (position('@' in email) > 1),
  CONSTRAINT chk_users_full_name_nonempty CHECK (btrim(full_name) <> ''),
  CONSTRAINT chk_users_phone_e164 CHECK (
    phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'
  ),
  CONSTRAINT chk_users_status CHECK (
    status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED')
  )
);

CREATE INDEX idx_users_status_created
  ON public.users (status, created_at DESC);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

CREATE OR REPLACE FUNCTION public.trigger_protect_user_privileged_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user = 'ft360_app' AND NOT public.app_is_super_admin() THEN
    IF NEW.is_platform_super_admin IS DISTINCT FROM OLD.is_platform_super_admin
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.email IS DISTINCT FROM OLD.email THEN
      RAISE EXCEPTION 'Insufficient privileges to modify protected global user identity fields'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_users_protect_privileged_fields
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_protect_user_privileged_fields();

-- -----------------------------------------------------------------------------
-- 2. TENANTS (Root Organization & Lifecycle Plane)
-- -----------------------------------------------------------------------------
CREATE TABLE public.tenants (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  slug CITEXT NOT NULL,
  legal_name VARCHAR(200) NOT NULL,
  display_name VARCHAR(160) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PROVISIONING',
  default_timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
  default_currency CHAR(3) NOT NULL DEFAULT 'USD',
  activated_at TIMESTAMPTZ NULL,
  suspended_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tenants_slug UNIQUE (slug),
  CONSTRAINT chk_tenants_slug_format CHECK (
    slug ~ '^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$'
  ),
  CONSTRAINT chk_tenants_legal_name_nonempty CHECK (btrim(legal_name) <> ''),
  CONSTRAINT chk_tenants_display_name_nonempty CHECK (btrim(display_name) <> ''),
  CONSTRAINT chk_tenants_status CHECK (
    status IN ('PROVISIONING', 'TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED')
  ),
  CONSTRAINT chk_tenants_currency_iso CHECK (default_currency ~ '^[A-Z]{3}$')
);

CREATE INDEX idx_tenants_status_created
  ON public.tenants (status, created_at DESC);

CREATE TRIGGER trg_tenants_updated_at
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

CREATE OR REPLACE FUNCTION public.trigger_protect_tenant_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user = 'ft360_app' AND NOT public.app_is_super_admin() THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.slug IS DISTINCT FROM OLD.slug
       OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
       OR NEW.suspended_at IS DISTINCT FROM OLD.suspended_at THEN
      RAISE EXCEPTION 'Insufficient privileges to modify platform-controlled tenant lifecycle fields'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tenants_protect_lifecycle
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_protect_tenant_lifecycle();

-- -----------------------------------------------------------------------------
-- 3. TENANT_MEMBERSHIPS (Multi-Tenant User <-> Organization Bridge)
-- -----------------------------------------------------------------------------
CREATE TABLE public.tenant_memberships (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  membership_type VARCHAR(24) NOT NULL DEFAULT 'INTERNAL',
  status VARCHAR(24) NOT NULL DEFAULT 'INVITED',
  job_title VARCHAR(120) NULL,
  employee_code VARCHAR(64) NULL,
  invited_by_user_id UUID NULL,
  joined_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One membership record per user per tenant
  CONSTRAINT uq_tenant_memberships_tenant_user UNIQUE (tenant_id, user_id),
  -- Composite foreign key target anchor for all downstream tenant child tables
  CONSTRAINT uq_tenant_memberships_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT fk_tenant_memberships_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_tenant_memberships_user
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_tenant_memberships_invited_by
    FOREIGN KEY (invited_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT chk_tenant_memberships_type CHECK (
    membership_type IN ('INTERNAL', 'CLIENT_PORTAL', 'PARTNER')
  ),
  CONSTRAINT chk_tenant_memberships_status CHECK (
    status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED')
  )
);

CREATE UNIQUE INDEX uq_tenant_memberships_employee_code
  ON public.tenant_memberships (tenant_id, employee_code)
  WHERE employee_code IS NOT NULL;

CREATE INDEX idx_tenant_memberships_tenant_status
  ON public.tenant_memberships (tenant_id, status, membership_type);

CREATE INDEX idx_tenant_memberships_user_status
  ON public.tenant_memberships (user_id, status);

CREATE TRIGGER trg_tenant_memberships_updated_at
  BEFORE UPDATE ON public.tenant_memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. ROW-LEVEL SECURITY POLICIES (FAIL-CLOSED + FORCE RLS)
-- -----------------------------------------------------------------------------

-- 4A. tenant_memberships (Strict Tenant Isolation + Controlled Super Admin View)
ALTER TABLE public.tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_tenant_memberships ON public.tenant_memberships
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY tenant_memberships_select ON public.tenant_memberships
  FOR SELECT
  TO ft360_app
  USING (
    tenant_id = public.app_current_tenant_id()
    OR public.app_is_super_admin()
  );

CREATE POLICY tenant_memberships_insert ON public.tenant_memberships
  FOR INSERT
  TO ft360_app
  WITH CHECK (
    tenant_id = public.app_current_tenant_id()
    OR public.app_is_super_admin()
  );

CREATE POLICY tenant_memberships_update ON public.tenant_memberships
  FOR UPDATE
  TO ft360_app
  USING (
    tenant_id = public.app_current_tenant_id()
    OR public.app_is_super_admin()
  )
  WITH CHECK (
    tenant_id = public.app_current_tenant_id()
    OR public.app_is_super_admin()
  );

CREATE POLICY tenant_memberships_delete ON public.tenant_memberships
  FOR DELETE
  TO ft360_app
  USING (
    tenant_id = public.app_current_tenant_id()
    OR public.app_is_super_admin()
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_memberships TO ft360_app;

-- 4B. users (Global Platform Identity Protected Separately from Tenants)
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_users ON public.users
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY users_select ON public.users
  FOR SELECT
  TO ft360_app
  USING (
    public.app_is_super_admin()
    OR id = public.app_current_user_id()
    OR (
      public.app_current_tenant_id() IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.tenant_memberships tm
        WHERE tm.user_id = users.id
          AND tm.tenant_id = public.app_current_tenant_id()
      )
    )
  );

CREATE POLICY users_insert_platform ON public.users
  FOR INSERT
  TO ft360_app
  WITH CHECK (public.app_is_super_admin());

CREATE POLICY users_update_self_or_platform ON public.users
  FOR UPDATE
  TO ft360_app
  USING (
    public.app_is_super_admin()
    OR id = public.app_current_user_id()
  )
  WITH CHECK (
    public.app_is_super_admin()
    OR id = public.app_current_user_id()
  );

GRANT SELECT, INSERT, UPDATE ON public.users TO ft360_app;

-- 4C. tenants (Root Organization Isolation + Platform Lifecycle Control)
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_tenants ON public.tenants
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY tenants_select ON public.tenants
  FOR SELECT
  TO ft360_app
  USING (
    public.app_is_super_admin()
    OR id = public.app_current_tenant_id()
  );

CREATE POLICY tenants_insert_platform ON public.tenants
  FOR INSERT
  TO ft360_app
  WITH CHECK (public.app_is_super_admin());

CREATE POLICY tenants_update_own_or_platform ON public.tenants
  FOR UPDATE
  TO ft360_app
  USING (
    public.app_is_super_admin()
    OR id = public.app_current_tenant_id()
  )
  WITH CHECK (
    public.app_is_super_admin()
    OR id = public.app_current_tenant_id()
  );

GRANT SELECT, INSERT, UPDATE ON public.tenants TO ft360_app;

-- -----------------------------------------------------------------------------
-- 5. NARROW SECURITY DEFINER MEMBERSHIP VERIFICATION FUNCTIONS
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_verify_tenant_membership(
  p_user_id UUID,
  p_tenant_id UUID
)
RETURNS TABLE (
  membership_id UUID,
  tenant_id UUID,
  user_id UUID,
  membership_type VARCHAR(24),
  membership_status VARCHAR(24),
  tenant_status VARCHAR(24),
  user_status VARCHAR(24)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    tm.id AS membership_id,
    tm.tenant_id,
    tm.user_id,
    tm.membership_type,
    tm.status AS membership_status,
    t.status AS tenant_status,
    u.status AS user_status
  FROM public.tenant_memberships tm
  INNER JOIN public.tenants t ON t.id = tm.tenant_id
  INNER JOIN public.users u ON u.id = tm.user_id
  WHERE tm.user_id = p_user_id
    AND tm.tenant_id = p_tenant_id
    AND p_user_id IS NOT NULL
    AND p_tenant_id IS NOT NULL
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.fn_verify_tenant_membership(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_verify_tenant_membership(UUID, UUID) TO ft360_app;

CREATE OR REPLACE FUNCTION public.fn_list_user_tenants(
  p_user_id UUID
)
RETURNS TABLE (
  membership_id UUID,
  tenant_id UUID,
  tenant_slug CITEXT,
  tenant_display_name VARCHAR(160),
  tenant_status VARCHAR(24),
  membership_type VARCHAR(24),
  membership_status VARCHAR(24)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    tm.id AS membership_id,
    t.id AS tenant_id,
    t.slug AS tenant_slug,
    t.display_name AS tenant_display_name,
    t.status AS tenant_status,
    tm.membership_type,
    tm.status AS membership_status
  FROM public.tenant_memberships tm
  INNER JOIN public.tenants t ON t.id = tm.tenant_id
  INNER JOIN public.users u ON u.id = tm.user_id
  WHERE tm.user_id = p_user_id
    AND u.status = 'ACTIVE'
    AND tm.status IN ('ACTIVE', 'INVITED')
    AND t.status IN ('ACTIVE', 'TRIAL')
  ORDER BY t.display_name ASC;
$$;

REVOKE ALL ON FUNCTION public.fn_list_user_tenants(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_list_user_tenants(UUID) TO ft360_app;
