-- =============================================================================
-- Migration: 0004_rbac_roles_permissions_and_assignments (UP)
-- Owner Role: ft360_migrator (ft360_app NEVER owns tables)
-- Purpose:
--   1. Global canonical permission catalog (`permissions`) protected from tenant writes
--   2. Tenant-scoped RBAC roles (`roles`) with composite FK anchor `(tenant_id, id)`
--   3. Tenant role-permission mapping (`role_permissions`) with composite FK & plane guard
--   4. Tenant member-role assignments (`user_role_assignments`) with composite FKs
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. PERMISSIONS (Global Canonical Permission Catalog)
-- -----------------------------------------------------------------------------
CREATE TABLE public.permissions (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  code VARCHAR(120) NOT NULL,
  scope_plane VARCHAR(24) NOT NULL,
  module_code VARCHAR(32) NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_permissions_code UNIQUE (code),
  CONSTRAINT chk_permissions_code_format CHECK (
    code ~ '^[a-z0-9_]+:[a-z0-9_]+:[a-z0-9_]+$'
  ),
  CONSTRAINT chk_permissions_scope_plane CHECK (
    scope_plane IN ('PLATFORM', 'TENANT', 'PORTAL')
  ),
  CONSTRAINT chk_permissions_module_code_nonempty CHECK (btrim(module_code) <> ''),
  CONSTRAINT chk_permissions_description_nonempty CHECK (btrim(description) <> '')
);

CREATE INDEX idx_permissions_scope_module
  ON public.permissions (scope_plane, module_code);

CREATE TRIGGER trg_permissions_updated_at
  BEFORE UPDATE ON public.permissions
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_permissions ON public.permissions
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

-- Fail-closed on missing context: requires verified tenant tx or super admin tx to read
CREATE POLICY permissions_select_scoped ON public.permissions
  FOR SELECT
  TO ft360_app
  USING (
    public.app_current_tenant_id() IS NOT NULL
    OR public.app_is_super_admin()
  );

-- Global platform catalog: tenant transactions can NEVER insert or modify permissions
CREATE POLICY permissions_insert_platform ON public.permissions
  FOR INSERT
  TO ft360_app
  WITH CHECK (public.app_is_super_admin());

CREATE POLICY permissions_update_platform ON public.permissions
  FOR UPDATE
  TO ft360_app
  USING (public.app_is_super_admin())
  WITH CHECK (public.app_is_super_admin());

GRANT SELECT, INSERT, UPDATE ON public.permissions TO ft360_app;

-- Seed foundational canonical permissions
INSERT INTO public.permissions (code, scope_plane, module_code, description)
VALUES
  ('platform:tenants:read', 'PLATFORM', 'M01', 'View global tenant directory and lifecycle telemetry'),
  ('platform:tenants:manage', 'PLATFORM', 'M01', 'Provision, activate, suspend, or cancel tenant organizations'),
  ('tenant:organization:read', 'TENANT', 'M04', 'View active organization profile and settings'),
  ('tenant:organization:manage', 'TENANT', 'M04', 'Manage active organization profile, locale, and branding'),
  ('tenant:members:read', 'TENANT', 'M04', 'View members within the active tenant organization'),
  ('tenant:members:manage', 'TENANT', 'M04', 'Invite, activate, suspend, or revoke tenant memberships'),
  ('rbac:roles:read', 'TENANT', 'M05', 'View roles and permission mappings within the active tenant'),
  ('rbac:roles:manage', 'TENANT', 'M05', 'Create, update, delete custom roles and assign member roles'),
  ('portal:workspace:read', 'PORTAL', 'M22', 'Access external client portal views within the active tenant')
ON CONFLICT (code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. ROLES (Tenant-Owned RBAC Roles)
-- -----------------------------------------------------------------------------
CREATE TABLE public.roles (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id UUID NOT NULL,
  slug CITEXT NOT NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT NULL,
  is_system_role BOOLEAN NOT NULL DEFAULT FALSE,
  data_access_scope VARCHAR(16) NOT NULL DEFAULT 'OWN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_roles_tenant_slug UNIQUE (tenant_id, slug),
  -- Composite FK anchor guaranteeing child references belong to the exact same tenant
  CONSTRAINT uq_roles_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT fk_roles_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE,
  CONSTRAINT chk_roles_slug_format CHECK (
    slug ~ '^[a-z0-9]([a-z0-9_-]{1,61}[a-z0-9])?$'
  ),
  CONSTRAINT chk_roles_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT chk_roles_data_access_scope CHECK (
    data_access_scope IN ('OWN', 'TEAM', 'TENANT')
  )
);

CREATE INDEX idx_roles_tenant_system
  ON public.roles (tenant_id, is_system_role);

CREATE TRIGGER trg_roles_updated_at
  BEFORE UPDATE ON public.roles
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_roles ON public.roles
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY tenant_isolation_select ON public.roles
  FOR SELECT
  TO ft360_app
  USING (tenant_id = public.app_current_tenant_id());

CREATE POLICY tenant_isolation_insert ON public.roles
  FOR INSERT
  TO ft360_app
  WITH CHECK (tenant_id = public.app_current_tenant_id());

CREATE POLICY tenant_isolation_update ON public.roles
  FOR UPDATE
  TO ft360_app
  USING (tenant_id = public.app_current_tenant_id())
  WITH CHECK (tenant_id = public.app_current_tenant_id());

CREATE POLICY tenant_isolation_delete ON public.roles
  FOR DELETE
  TO ft360_app
  USING (tenant_id = public.app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.roles TO ft360_app;

-- -----------------------------------------------------------------------------
-- 3. ROLE_PERMISSIONS (Tenant Role <-> Canonical Permission Mapping)
-- -----------------------------------------------------------------------------
CREATE TABLE public.role_permissions (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id UUID NOT NULL,
  role_id UUID NOT NULL,
  permission_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_role_permissions_tenant_role_perm
    UNIQUE (tenant_id, role_id, permission_id),
  CONSTRAINT fk_role_permissions_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE,
  -- Composite FK: prevents linking a Tenant A role_permissions row to a Tenant B role
  CONSTRAINT fk_role_permissions_tenant_role
    FOREIGN KEY (tenant_id, role_id) REFERENCES public.roles(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_role_permissions_permission
    FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE RESTRICT
);

CREATE INDEX idx_role_permissions_tenant_role
  ON public.role_permissions (tenant_id, role_id);

CREATE INDEX idx_role_permissions_permission
  ON public.role_permissions (permission_id);

CREATE TRIGGER trg_role_permissions_updated_at
  BEFORE UPDATE ON public.role_permissions
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- Prevent tenant roles from ever being granted PLATFORM-plane permissions
CREATE OR REPLACE FUNCTION public.trigger_enforce_tenant_permission_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_scope VARCHAR(24);
BEGIN
  SELECT p.scope_plane
    INTO v_scope
    FROM public.permissions p
   WHERE p.id = NEW.permission_id;

  IF v_scope = 'PLATFORM' THEN
    RAISE EXCEPTION 'PLATFORM-scoped permissions cannot be granted to tenant roles'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_enforce_tenant_permission_scope() FROM PUBLIC;

CREATE TRIGGER trg_role_permissions_enforce_scope
  BEFORE INSERT OR UPDATE ON public.role_permissions
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_enforce_tenant_permission_scope();

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_role_permissions ON public.role_permissions
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY tenant_isolation_select ON public.role_permissions
  FOR SELECT
  TO ft360_app
  USING (tenant_id = public.app_current_tenant_id());

CREATE POLICY tenant_isolation_insert ON public.role_permissions
  FOR INSERT
  TO ft360_app
  WITH CHECK (tenant_id = public.app_current_tenant_id());

CREATE POLICY tenant_isolation_update ON public.role_permissions
  FOR UPDATE
  TO ft360_app
  USING (tenant_id = public.app_current_tenant_id())
  WITH CHECK (tenant_id = public.app_current_tenant_id());

CREATE POLICY tenant_isolation_delete ON public.role_permissions
  FOR DELETE
  TO ft360_app
  USING (tenant_id = public.app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.role_permissions TO ft360_app;

-- -----------------------------------------------------------------------------
-- 4. USER_ROLE_ASSIGNMENTS (Tenant Membership <-> Role Assignment)
-- -----------------------------------------------------------------------------
CREATE TABLE public.user_role_assignments (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id UUID NOT NULL,
  membership_id UUID NOT NULL,
  role_id UUID NOT NULL,
  assigned_by_membership_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_role_assignments_member_role
    UNIQUE (tenant_id, membership_id, role_id),
  CONSTRAINT fk_ura_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE,
  -- Composite FK #1: guarantees membership_id belongs to this exact tenant_id
  CONSTRAINT fk_ura_tenant_membership
    FOREIGN KEY (tenant_id, membership_id)
    REFERENCES public.tenant_memberships(tenant_id, id)
    ON DELETE CASCADE,
  -- Composite FK #2: guarantees role_id belongs to this exact tenant_id
  CONSTRAINT fk_ura_tenant_role
    FOREIGN KEY (tenant_id, role_id)
    REFERENCES public.roles(tenant_id, id)
    ON DELETE CASCADE,
  -- Composite FK #3: guarantees assigned_by_membership_id belongs to this exact tenant_id
  CONSTRAINT fk_ura_assigned_by_membership
    FOREIGN KEY (tenant_id, assigned_by_membership_id)
    REFERENCES public.tenant_memberships(tenant_id, id)
    ON DELETE SET NULL (assigned_by_membership_id)
);

CREATE INDEX idx_ura_tenant_membership
  ON public.user_role_assignments (tenant_id, membership_id);

CREATE INDEX idx_ura_tenant_role
  ON public.user_role_assignments (tenant_id, role_id);

CREATE TRIGGER trg_user_role_assignments_updated_at
  BEFORE UPDATE ON public.user_role_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.user_role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_role_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_user_role_assignments ON public.user_role_assignments
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY tenant_isolation_select ON public.user_role_assignments
  FOR SELECT
  TO ft360_app
  USING (tenant_id = public.app_current_tenant_id());

CREATE POLICY tenant_isolation_insert ON public.user_role_assignments
  FOR INSERT
  TO ft360_app
  WITH CHECK (tenant_id = public.app_current_tenant_id());

CREATE POLICY tenant_isolation_update ON public.user_role_assignments
  FOR UPDATE
  TO ft360_app
  USING (tenant_id = public.app_current_tenant_id())
  WITH CHECK (tenant_id = public.app_current_tenant_id());

CREATE POLICY tenant_isolation_delete ON public.user_role_assignments
  FOR DELETE
  TO ft360_app
  USING (tenant_id = public.app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_role_assignments TO ft360_app;
