-- =============================================================================
-- Migration: 0009_phase4b_tenant_registration_routines (UP)
-- Owner Role: ft360_migrator (ft360_app NEVER owns tables or SECURITY DEFINER routines)
-- Scope: Strictly introduces the two approved Phase 4B database routines:
--   1. `public.fn_check_tenant_slug_available(p_slug CITEXT) RETURNS BOOLEAN`
--   2. `public.fn_tenant_provision_organization(...)`
-- Zero tables, columns, permissions, indexes, or triggers are added or altered.
-- Existing RLS policies, table grants, and database triggers remain unweakened.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. FUNCTION 1: SLUG AVAILABILITY CHECK (ZERO METADATA DISCLOSURE)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_check_tenant_slug_available(
  p_slug CITEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_current_uid UUID := public.app_current_user_id();
  v_current_tid UUID := public.app_current_tenant_id();
  v_is_super BOOLEAN := public.app_is_super_admin();
  v_user RECORD;
  v_raw_slug TEXT;
  v_reserved_slugs CONSTANT TEXT[] := ARRAY[
    'admin',
    'admins',
    'api',
    'app',
    'assets',
    'audit',
    'auth',
    'billing',
    'branding',
    'default',
    'docs',
    'health',
    'internal',
    'invitations',
    'login',
    'logout',
    'mail',
    'members',
    'null',
    'onboarding',
    'organizations',
    'owner',
    'platform',
    'portal',
    'profile',
    'public',
    'register',
    'roles',
    'root',
    'security',
    'select-organization',
    'settings',
    'static',
    'status',
    'superadmin',
    'support',
    'system',
    'undefined',
    'webhooks',
    'workspace',
    'www'
  ];
BEGIN
  -- 1. Enforce plane boundary: slug availability runs strictly outside a tenant GUC context
  IF v_current_tid IS NOT NULL THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_FORBIDDEN: fn_check_tenant_slug_available cannot execute inside a tenant-scoped transaction'
      USING ERRCODE = '42501';
  END IF;

  -- 2. Require an authenticated, ACTIVE, email-verified user in PostgreSQL
  IF v_current_uid IS NULL THEN
    RAISE EXCEPTION 'AUTHENTICATION_REQUIRED: fn_check_tenant_slug_available requires verified app.current_user_id context'
      USING ERRCODE = '42501';
  END IF;

  SELECT u.id, u.status, u.email_verified, u.is_platform_super_admin
    INTO v_user
    FROM public.users u
   WHERE u.id = v_current_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTHENTICATION_REQUIRED: caller identity does not exist'
      USING ERRCODE = '42501';
  END IF;

  IF v_user.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'USER_ACCOUNT_INACTIVE: active user account is required to check slug availability'
      USING ERRCODE = '42501';
  END IF;

  IF v_user.email_verified IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'EMAIL_NOT_VERIFIED: verified email address is required to check slug availability'
      USING ERRCODE = '42501';
  END IF;

  -- Preserve Platform Super Admin boundary: if app.is_super_admin is true, verify DB Super Admin status
  IF v_is_super AND v_user.is_platform_super_admin IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'PLATFORM_SUPER_ADMIN_VERIFICATION_FAILED: caller is not an active Platform Super Admin'
      USING ERRCODE = '42501';
  END IF;

  -- 3. Uniformly reject NULL, untrimmed, uppercase, malformed, or out-of-range slugs as FALSE
  IF p_slug IS NULL THEN
    RETURN FALSE;
  END IF;

  v_raw_slug := p_slug::text;

  IF v_raw_slug <> lower(btrim(v_raw_slug)) THEN
    RETURN FALSE;
  END IF;

  IF v_raw_slug !~ '^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$' THEN
    RETURN FALSE;
  END IF;

  -- 4. Uniformly reject reserved system/routing slugs with the exact same FALSE boolean as occupied slugs
  IF v_raw_slug = ANY(v_reserved_slugs) THEN
    RETURN FALSE;
  END IF;

  -- 5. Return boolean availability only (zero tenant IDs, names, status, or ownership metadata exposed)
  RETURN NOT EXISTS (
    SELECT 1
      FROM public.tenants t
     WHERE t.slug = v_raw_slug::citext
  );
END;
$$;

ALTER FUNCTION public.fn_check_tenant_slug_available(CITEXT) OWNER TO ft360_migrator;
REVOKE ALL ON FUNCTION public.fn_check_tenant_slug_available(CITEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_check_tenant_slug_available(CITEXT) TO ft360_app;

-- -----------------------------------------------------------------------------
-- 2. FUNCTION 2: ATOMIC SELF-SERVICE TENANT PROVISIONING ROUTINE
-- -----------------------------------------------------------------------------
-- Permission Catalog Reconciliation (24 Total Canonical Permissions):
--   - 5 PLATFORM permissions (`platform:*`) — NEVER granted to tenant roles
--   - 1 PORTAL permission (`portal:workspace:read`) — NEVER granted to default internal roles
--   - 18 TENANT permissions (`8` from 0004–0005 + `10` added in 0007):
--       * `tenant_admin` (`TENANT` scope) receives all 18 approved `TENANT` permissions.
--       * `member` (`OWN` scope) receives the 4 approved baseline `TENANT` read permissions:
--           1. `tenant:organization:read`
--           2. `tenant:settings:read`
--           3. `tenant:branding:read`
--           4. `tenant:members:read` (gated at runtime by `allow_member_directory_view = FALSE` default)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_tenant_provision_organization(
  p_actor_user_id UUID,
  p_session_id UUID,
  p_slug CITEXT,
  p_display_name VARCHAR(160),
  p_legal_name VARCHAR(200),
  p_organization_type VARCHAR(32),
  p_industry VARCHAR(48),
  p_country_code CHAR(2),
  p_default_timezone VARCHAR(64),
  p_default_currency CHAR(3),
  p_correlation_id UUID,
  p_ip_address INET DEFAULT NULL,
  p_user_agent VARCHAR(512) DEFAULT NULL
)
RETURNS TABLE (
  tenant_id UUID,
  tenant_slug TEXT,
  legal_name VARCHAR(200),
  display_name VARCHAR(160),
  tenant_status VARCHAR(24),
  default_timezone VARCHAR(64),
  default_currency CHAR(3),
  created_by_user_id UUID,
  tenant_created_at TIMESTAMPTZ,
  tenant_updated_at TIMESTAMPTZ,
  membership_id UUID,
  membership_type VARCHAR(24),
  membership_status VARCHAR(24),
  is_primary_owner BOOLEAN,
  admin_role_id UUID,
  member_role_id UUID,
  onboarding_status VARCHAR(24),
  onboarding_current_step VARCHAR(32),
  onboarding_version INTEGER,
  bound_session_id UUID,
  tenant_audit_log_id UUID,
  auth_audit_log_id UUID,
  effective_permissions TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_current_uid UUID := public.app_current_user_id();
  v_current_tid UUID := public.app_current_tenant_id();
  v_is_super BOOLEAN := public.app_is_super_admin();
  v_user public.users%ROWTYPE;
  v_session public.auth_sessions%ROWTYPE;
  v_raw_slug TEXT;
  v_display_name VARCHAR(160);
  v_legal_name VARCHAR(200);
  v_org_type VARCHAR(32);
  v_industry VARCHAR(48);
  v_country_code CHAR(2);
  v_timezone VARCHAR(64);
  v_currency CHAR(3);
  v_user_agent VARCHAR(512);
  v_owned_count BIGINT;
  v_tenant public.tenants%ROWTYPE;
  v_admin_role public.roles%ROWTYPE;
  v_member_role public.roles%ROWTYPE;
  v_membership public.tenant_memberships%ROWTYPE;
  v_onboarding public.tenant_onboarding_states%ROWTYPE;
  v_admin_perm_count INTEGER;
  v_member_perm_count INTEGER;
  v_tenant_audit_id UUID;
  v_auth_audit_id UUID;
  v_effective_perms TEXT[];
  v_reserved_slugs CONSTANT TEXT[] := ARRAY[
    'admin',
    'admins',
    'api',
    'app',
    'assets',
    'audit',
    'auth',
    'billing',
    'branding',
    'default',
    'docs',
    'health',
    'internal',
    'invitations',
    'login',
    'logout',
    'mail',
    'members',
    'null',
    'onboarding',
    'organizations',
    'owner',
    'platform',
    'portal',
    'profile',
    'public',
    'register',
    'roles',
    'root',
    'security',
    'select-organization',
    'settings',
    'static',
    'status',
    'superadmin',
    'support',
    'system',
    'undefined',
    'webhooks',
    'workspace',
    'www'
  ];
  v_approved_admin_permissions CONSTANT TEXT[] := ARRAY[
    'audit:auth:read',
    'audit:tenant:read',
    'auth:sessions:manage',
    'rbac:roles:manage',
    'rbac:roles:read',
    'tenant:admins:manage',
    'tenant:admins:read',
    'tenant:branding:manage',
    'tenant:branding:read',
    'tenant:invitations:manage',
    'tenant:invitations:read',
    'tenant:members:manage',
    'tenant:members:read',
    'tenant:organization:manage',
    'tenant:organization:read',
    'tenant:roles:assign',
    'tenant:settings:manage',
    'tenant:settings:read'
  ];
  v_approved_member_permissions CONSTANT TEXT[] := ARRAY[
    'tenant:branding:read',
    'tenant:members:read',
    'tenant:organization:read',
    'tenant:settings:read'
  ];
BEGIN
  -- 1. Enforce plane isolation: require no active tenant context and never allow app.is_super_admin elevation
  IF v_current_tid IS NOT NULL THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_FORBIDDEN: fn_tenant_provision_organization requires no active tenant context'
      USING ERRCODE = '42501';
  END IF;

  IF v_is_super THEN
    RAISE EXCEPTION 'PLATFORM_ADMIN_CANNOT_OWN_TENANT: self-service provisioning cannot execute with app.is_super_admin enabled'
      USING ERRCODE = '42501';
  END IF;

  -- 2. Verify authenticated caller matches requested actor
  IF v_current_uid IS NULL THEN
    RAISE EXCEPTION 'AUTHENTICATION_REQUIRED: fn_tenant_provision_organization requires verified app.current_user_id context'
      USING ERRCODE = '42501';
  END IF;

  IF p_actor_user_id IS NULL OR p_actor_user_id <> v_current_uid THEN
    RAISE EXCEPTION 'ACTOR_IDENTITY_MISMATCH: p_actor_user_id must match verified app.current_user_id'
      USING ERRCODE = '42501';
  END IF;

  -- 3. Verify global user is ACTIVE, email-verified, and NOT a Platform Super Admin
  SELECT *
    INTO v_user
    FROM public.users u
   WHERE u.id = v_current_uid
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTHENTICATION_REQUIRED: authenticated user record does not exist'
      USING ERRCODE = '42501';
  END IF;

  IF v_user.is_platform_super_admin = TRUE THEN
    RAISE EXCEPTION 'PLATFORM_ADMIN_CANNOT_OWN_TENANT: Platform Super Admin identities cannot self-register customer tenants'
      USING ERRCODE = '42501';
  END IF;

  IF v_user.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'USER_ACCOUNT_INACTIVE: user account must be ACTIVE to register an organization'
      USING ERRCODE = '42501';
  END IF;

  IF v_user.email_verified IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'EMAIL_NOT_VERIFIED: email verification is required before registering an organization'
      USING ERRCODE = '42501';
  END IF;

  -- 4. Lock and verify caller's active authentication session prior to provisioning
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'SESSION_ID_REQUIRED: active authentication session_id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_session
    FROM public.auth_sessions s
   WHERE s.id = p_session_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_INVALID: referenced authentication session does not exist'
      USING ERRCODE = '42501';
  END IF;

  IF v_session.user_id <> v_current_uid THEN
    RAISE EXCEPTION 'CROSS_USER_SESSION_BIND_FORBIDDEN: authentication session does not belong to the verified actor'
      USING ERRCODE = '42501';
  END IF;

  IF v_session.revoked_at IS NOT NULL
     OR v_session.expires_at <= NOW()
     OR v_session.idle_expires_at <= NOW() THEN
    RAISE EXCEPTION 'SESSION_EXPIRED_OR_REVOKED: authentication session is revoked or expired'
      USING ERRCODE = '42501';
  END IF;

  -- 5. Validate required inputs and canonical slug format
  IF p_correlation_id IS NULL THEN
    RAISE EXCEPTION 'CORRELATION_ID_REQUIRED: correlation_id is required for atomic audit attribution'
      USING ERRCODE = '22023';
  END IF;

  IF p_slug IS NULL THEN
    RAISE EXCEPTION 'INVALID_TENANT_SLUG: slug is required'
      USING ERRCODE = '22023';
  END IF;

  v_raw_slug := p_slug::text;

  IF v_raw_slug <> lower(btrim(v_raw_slug))
     OR v_raw_slug !~ '^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$' THEN
    RAISE EXCEPTION 'INVALID_TENANT_SLUG: slug must be 3 to 63 lowercase alphanumeric or hyphen characters without leading or trailing hyphens'
      USING ERRCODE = '22023';
  END IF;

  v_display_name := btrim(COALESCE(p_display_name, ''));
  IF length(v_display_name) < 2 OR length(v_display_name) > 160 THEN
    RAISE EXCEPTION 'INVALID_DISPLAY_NAME: display_name must be between 2 and 160 characters'
      USING ERRCODE = '22023';
  END IF;

  v_legal_name := btrim(COALESCE(p_legal_name, ''));
  IF length(v_legal_name) < 2 OR length(v_legal_name) > 200 THEN
    RAISE EXCEPTION 'INVALID_LEGAL_NAME: legal_name must be between 2 and 200 characters'
      USING ERRCODE = '22023';
  END IF;

  v_org_type := upper(btrim(COALESCE(p_organization_type, '')));
  IF v_org_type NOT IN (
    'COMPANY',
    'AGENCY',
    'ENTERPRISE',
    'NONPROFIT',
    'GOVERNMENT',
    'SOLE_PROPRIETORSHIP',
    'PARTNERSHIP',
    'OTHER'
  ) THEN
    RAISE EXCEPTION 'INVALID_ORGANIZATION_TYPE: unsupported organization_type (%)' , v_org_type
      USING ERRCODE = '22023';
  END IF;

  v_industry := upper(btrim(COALESCE(p_industry, '')));
  IF v_industry NOT IN (
    'SAAS_TECHNOLOGY',
    'MARKETING_AGENCY',
    'FINANCE_FINTECH',
    'HEALTHCARE',
    'ECOMMERCE_RETAIL',
    'REAL_ESTATE',
    'EDUCATION',
    'MANUFACTURING',
    'CONSULTING',
    'LOGISTICS',
    'OTHER'
  ) THEN
    RAISE EXCEPTION 'INVALID_INDUSTRY: unsupported industry (%)' , v_industry
      USING ERRCODE = '22023';
  END IF;

  v_country_code := upper(btrim(COALESCE(p_country_code, '')));
  IF v_country_code !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'INVALID_COUNTRY_CODE: country_code must be an ISO 3166-1 alpha-2 code'
      USING ERRCODE = '22023';
  END IF;

  v_timezone := btrim(COALESCE(p_default_timezone, ''));
  IF v_timezone = '' OR length(v_timezone) > 64 OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_timezone_names tz
     WHERE tz.name = v_timezone
  ) THEN
    RAISE EXCEPTION 'INVALID_TIMEZONE: default_timezone must be a valid IANA timezone identifier'
      USING ERRCODE = '22023';
  END IF;

  v_currency := upper(btrim(COALESCE(p_default_currency, '')));
  IF v_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'INVALID_CURRENCY: default_currency must be a 3-letter ISO-4217 code'
      USING ERRCODE = '22023';
  END IF;

  v_user_agent := NULLIF(LEFT(btrim(COALESCE(p_user_agent, '')), 512), '');

  -- 6. Serialize concurrent per-user ownership-limit checks (`D2`: max 5 ACTIVE/TRIAL owned tenants)
  PERFORM pg_advisory_xact_lock(hashtext('tenant_reg:' || v_current_uid::text));

  SELECT COUNT(DISTINCT t.id)
    INTO v_owned_count
    FROM public.tenants t
    LEFT JOIN public.tenant_memberships tm
      ON tm.tenant_id = t.id
     AND tm.user_id = v_current_uid
     AND tm.is_primary_owner = TRUE
     AND tm.status = 'ACTIVE'
   WHERE (
           t.status IN ('ACTIVE', 'TRIAL')
           AND (t.created_by_user_id = v_current_uid OR tm.id IS NOT NULL)
         )
      OR (
           t.created_by_user_id = v_current_uid
           AND t.status IN ('PROVISIONING', 'SUSPENDED')
         );

  IF v_owned_count >= 5 THEN
    RAISE EXCEPTION 'TENANT_CREATION_QUOTA_EXCEEDED: user has reached the maximum of 5 owned organizations'
      USING ERRCODE = '23514';
  END IF;

  -- 7. Reject reserved or already-occupied slugs uniformly without leaking tenant metadata
  IF v_raw_slug = ANY(v_reserved_slugs) THEN
    RAISE EXCEPTION 'TENANT_SLUG_UNAVAILABLE: requested slug is unavailable'
      USING ERRCODE = '23505';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tenant_slug:' || v_raw_slug));

  IF EXISTS (
    SELECT 1
      FROM public.tenants t
     WHERE t.slug = v_raw_slug::citext
  ) THEN
    RAISE EXCEPTION 'TENANT_SLUG_UNAVAILABLE: requested slug is unavailable'
      USING ERRCODE = '23505';
  END IF;

  -- 8. Create tenant in TRIAL status (`D1`)
  INSERT INTO public.tenants (
    slug,
    legal_name,
    display_name,
    status,
    default_timezone,
    default_currency,
    created_by_user_id
  )
  VALUES (
    v_raw_slug::citext,
    v_legal_name,
    v_display_name,
    'TRIAL',
    v_timezone,
    v_currency,
    v_current_uid
  )
  RETURNING * INTO v_tenant;

  -- 9. Create protected system roles (`tenant_admin` & `member`)
  INSERT INTO public.roles (
    tenant_id,
    slug,
    name,
    description,
    is_system_role,
    data_access_scope
  )
  VALUES (
    v_tenant.id,
    'tenant_admin'::citext,
    'Tenant Administrator',
    'Full administrative governance within this organization workspace',
    TRUE,
    'TENANT'
  )
  RETURNING * INTO v_admin_role;

  INSERT INTO public.roles (
    tenant_id,
    slug,
    name,
    description,
    is_system_role,
    data_access_scope
  )
  VALUES (
    v_tenant.id,
    'member'::citext,
    'Workspace Member',
    'Standard workspace member with baseline organization read access',
    TRUE,
    'OWN'
  )
  RETURNING * INTO v_member_role;

  -- 10. Grant exact approved permission sets from the canonical `TENANT` catalog
  INSERT INTO public.role_permissions (tenant_id, role_id, permission_id)
  SELECT v_tenant.id, v_admin_role.id, p.id
    FROM public.permissions p
   WHERE p.scope_plane = 'TENANT'
     AND p.code = ANY(v_approved_admin_permissions);

  GET DIAGNOSTICS v_admin_perm_count = ROW_COUNT;
  IF v_admin_perm_count <> array_length(v_approved_admin_permissions, 1) THEN
    RAISE EXCEPTION 'PERMISSION_CATALOG_MISMATCH: expected % approved TENANT permissions for tenant_admin, found %',
      array_length(v_approved_admin_permissions, 1), v_admin_perm_count
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.role_permissions (tenant_id, role_id, permission_id)
  SELECT v_tenant.id, v_member_role.id, p.id
    FROM public.permissions p
   WHERE p.scope_plane = 'TENANT'
     AND p.code = ANY(v_approved_member_permissions);

  GET DIAGNOSTICS v_member_perm_count = ROW_COUNT;
  IF v_member_perm_count <> array_length(v_approved_member_permissions, 1) THEN
    RAISE EXCEPTION 'PERMISSION_CATALOG_MISMATCH: expected % approved TENANT permissions for member, found %',
      array_length(v_approved_member_permissions, 1), v_member_perm_count
      USING ERRCODE = 'P0002';
  END IF;

  -- 11. Create creator's ACTIVE INTERNAL Primary Owner membership and assign `tenant_admin`
  INSERT INTO public.tenant_memberships (
    tenant_id,
    user_id,
    membership_type,
    status,
    is_primary_owner,
    invited_by_user_id,
    joined_at
  )
  VALUES (
    v_tenant.id,
    v_current_uid,
    'INTERNAL',
    'ACTIVE',
    TRUE,
    NULL,
    NOW()
  )
  RETURNING * INTO v_membership;

  INSERT INTO public.user_role_assignments (
    tenant_id,
    membership_id,
    role_id,
    assigned_by_membership_id
  )
  VALUES (
    v_tenant.id,
    v_membership.id,
    v_admin_role.id,
    v_membership.id
  );

  -- 12. Create 1:1 companion rows (`tenant_profiles`, `tenant_settings`, `tenant_branding_settings`, `tenant_onboarding_states`)
  INSERT INTO public.tenant_profiles (
    tenant_id,
    organization_type,
    industry,
    country_code,
    updated_by_membership_id,
    version
  )
  VALUES (
    v_tenant.id,
    v_org_type,
    v_industry,
    v_country_code,
    v_membership.id,
    1
  );

  INSERT INTO public.tenant_settings (
    tenant_id,
    timezone,
    locale,
    date_format,
    time_format,
    default_currency,
    week_start_day,
    fiscal_year_start_month,
    invitation_expiry_hours,
    allow_member_directory_view,
    updated_by_membership_id,
    version
  )
  VALUES (
    v_tenant.id,
    v_timezone,
    'en-US',
    'YYYY-MM-DD',
    '24H',
    v_currency,
    1,
    1,
    168,
    FALSE,
    v_membership.id,
    1
  );

  INSERT INTO public.tenant_branding_settings (
    tenant_id,
    brand_display_name,
    primary_color_hex,
    accent_color_hex,
    theme_mode,
    updated_by_membership_id,
    version
  )
  VALUES (
    v_tenant.id,
    NULL,
    '#2563EB',
    '#0F172A',
    'LIGHT',
    v_membership.id,
    1
  );

  INSERT INTO public.tenant_onboarding_states (
    tenant_id,
    onboarding_status,
    current_step,
    version
  )
  VALUES (
    v_tenant.id,
    'IN_PROGRESS',
    'ORG_PROFILE',
    1
  )
  RETURNING * INTO v_onboarding;

  -- 13. Bind ONLY the verified caller's locked active authentication session
  UPDATE public.auth_sessions s
     SET active_tenant_id = v_tenant.id,
         active_membership_id = v_membership.id,
         last_active_at = NOW()
   WHERE s.id = v_session.id
     AND s.user_id = v_current_uid
     AND s.revoked_at IS NULL;

  -- 14. Record atomic dual-ledger `TENANT_REGISTERED` audit events sharing `p_correlation_id`
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
    v_tenant.id,
    'TENANT_REGISTERED',
    'TENANT',
    v_tenant.id,
    'SUCCESS',
    'USER_ONBOARDING',
    v_current_uid,
    v_membership.id,
    NULL,
    NULL,
    jsonb_build_object(
      'slug', v_tenant.slug::text,
      'displayName', v_tenant.display_name,
      'legalName', v_tenant.legal_name,
      'status', v_tenant.status,
      'organizationType', v_org_type,
      'industry', v_industry,
      'countryCode', v_country_code,
      'defaultTimezone', v_timezone,
      'defaultCurrency', v_currency,
      'isPrimaryOwner', TRUE,
      'onboardingStatus', v_onboarding.onboarding_status
    ),
    jsonb_build_object(
      'sessionId', v_session.id,
      'adminRoleId', v_admin_role.id,
      'memberRoleId', v_member_role.id
    ),
    p_correlation_id,
    p_ip_address,
    v_user_agent
  )
  RETURNING id INTO v_tenant_audit_id;

  INSERT INTO public.auth_audit_logs (
    event_type,
    outcome,
    actor_user_id,
    target_user_id,
    tenant_id,
    session_id,
    correlation_id,
    ip_address,
    user_agent,
    metadata
  )
  VALUES (
    'TENANT_REGISTERED',
    'SUCCESS',
    v_current_uid,
    v_current_uid,
    v_tenant.id,
    v_session.id,
    p_correlation_id,
    p_ip_address,
    v_user_agent,
    jsonb_build_object(
      'slug', v_tenant.slug::text,
      'tenantStatus', v_tenant.status,
      'membershipId', v_membership.id,
      'isPrimaryOwner', TRUE
    )
  )
  RETURNING id INTO v_auth_audit_id;

  SELECT COALESCE(array_agg(p.code::text ORDER BY p.code ASC), ARRAY[]::TEXT[])
    INTO v_effective_perms
    FROM public.role_permissions rp
    INNER JOIN public.permissions p ON p.id = rp.permission_id
   WHERE rp.tenant_id = v_tenant.id
     AND rp.role_id = v_admin_role.id;

  RETURN QUERY
  SELECT
    v_tenant.id,
    v_tenant.slug::text,
    v_tenant.legal_name,
    v_tenant.display_name,
    v_tenant.status,
    v_tenant.default_timezone,
    v_tenant.default_currency,
    v_tenant.created_by_user_id,
    v_tenant.created_at,
    v_tenant.updated_at,
    v_membership.id,
    v_membership.membership_type,
    v_membership.status,
    v_membership.is_primary_owner,
    v_admin_role.id,
    v_member_role.id,
    v_onboarding.onboarding_status,
    v_onboarding.current_step,
    v_onboarding.version,
    v_session.id,
    v_tenant_audit_id,
    v_auth_audit_id,
    v_effective_perms;
END;
$$;

ALTER FUNCTION public.fn_tenant_provision_organization(
  UUID, UUID, CITEXT, VARCHAR, VARCHAR, VARCHAR, VARCHAR, CHAR, VARCHAR, CHAR, UUID, INET, VARCHAR
) OWNER TO ft360_migrator;

REVOKE ALL ON FUNCTION public.fn_tenant_provision_organization(
  UUID, UUID, CITEXT, VARCHAR, VARCHAR, VARCHAR, VARCHAR, CHAR, VARCHAR, CHAR, UUID, INET, VARCHAR
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.fn_tenant_provision_organization(
  UUID, UUID, CITEXT, VARCHAR, VARCHAR, VARCHAR, VARCHAR, CHAR, VARCHAR, CHAR, UUID, INET, VARCHAR
) TO ft360_app;
