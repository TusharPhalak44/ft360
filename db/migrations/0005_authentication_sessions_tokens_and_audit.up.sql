-- =============================================================================
-- Migration: 0005_authentication_sessions_tokens_and_audit (UP)
-- Owner Role: ft360_migrator (ft360_app NEVER owns tables)
-- Purpose:
--   1. Seed Phase 3 canonical PLATFORM and TENANT authentication/audit permissions
--   2. Server-side session ledger (`auth_sessions`) with composite FK to
--      `tenant_memberships(tenant_id, id)` and refresh-family replay detection
--   3. Single-use SHA-256 `email_verification_tokens` and `password_reset_tokens`
--   4. Append-only `auth_audit_logs` with immutability trigger and plane-aware RLS
--   5. Narrow SECURITY DEFINER auth routines preserving zero `SELECT(password_hash)`
--      and zero `SELECT(refresh_token_hash, csrf_secret_hash)` table exposure
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. SEED PHASE 3 CANONICAL PERMISSIONS
-- -----------------------------------------------------------------------------
INSERT INTO public.permissions (code, scope_plane, module_code, description)
VALUES
  ('platform:users:read', 'PLATFORM', 'M01', 'View global platform user directory and account status'),
  ('platform:users:manage', 'PLATFORM', 'M01', 'Manage global platform user lifecycle and super-admin status'),
  ('platform:audit:read', 'PLATFORM', 'M01', 'View global platform and cross-plane authentication audit logs'),
  ('auth:sessions:manage', 'TENANT', 'M03', 'Inspect and manage member authentication posture within the active tenant'),
  ('audit:auth:read', 'TENANT', 'M31', 'View authentication and authorization audit logs within the active tenant')
ON CONFLICT (code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. AUTH_SESSIONS (Hybrid JWT + Rotating Opaque Refresh Session Ledger)
-- -----------------------------------------------------------------------------
CREATE TABLE public.auth_sessions (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  family_id UUID NOT NULL DEFAULT uuidv7(),
  user_id UUID NOT NULL,
  active_tenant_id UUID NULL,
  active_membership_id UUID NULL,
  refresh_token_hash CHAR(64) NOT NULL,
  previous_refresh_token_hash CHAR(64) NULL,
  csrf_secret_hash CHAR(64) NOT NULL,
  ip_address INET NULL,
  user_agent VARCHAR(512) NULL,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  idle_expires_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoked_reason VARCHAR(64) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_auth_sessions_refresh_token_hash UNIQUE (refresh_token_hash),
  CONSTRAINT fk_auth_sessions_user
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  -- Composite FK guarantees active_membership_id belongs to active_tenant_id (and transitively tenants.id);
  -- ON DELETE SET NULL clears both columns atomically when a membership or tenant is deleted.
  CONSTRAINT fk_auth_sessions_active_membership
    FOREIGN KEY (active_tenant_id, active_membership_id)
    REFERENCES public.tenant_memberships(tenant_id, id)
    ON DELETE SET NULL,
  CONSTRAINT chk_auth_sessions_tenant_member_pair CHECK (
    (active_tenant_id IS NULL AND active_membership_id IS NULL)
    OR (active_tenant_id IS NOT NULL AND active_membership_id IS NOT NULL)
  ),
  CONSTRAINT chk_auth_sessions_refresh_hash_hex CHECK (
    refresh_token_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_auth_sessions_prev_refresh_hash_hex CHECK (
    previous_refresh_token_hash IS NULL OR previous_refresh_token_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_auth_sessions_csrf_hash_hex CHECK (
    csrf_secret_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_auth_sessions_expiry_order CHECK (
    expires_at > created_at AND idle_expires_at > created_at
  ),
  CONSTRAINT chk_auth_sessions_revoked_pair CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL AND btrim(revoked_reason) <> '')
  )
);

CREATE INDEX idx_auth_sessions_user_active
  ON public.auth_sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_auth_sessions_family_id
  ON public.auth_sessions (family_id);

CREATE INDEX idx_auth_sessions_prev_refresh_hash
  ON public.auth_sessions (previous_refresh_token_hash)
  WHERE previous_refresh_token_hash IS NOT NULL;

CREATE INDEX idx_auth_sessions_active_tenant_member
  ON public.auth_sessions (active_tenant_id, active_membership_id)
  WHERE active_tenant_id IS NOT NULL;

CREATE TRIGGER trg_auth_sessions_updated_at
  BEFORE UPDATE ON public.auth_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

CREATE OR REPLACE FUNCTION public.trigger_protect_auth_session_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.family_id IS DISTINCT FROM OLD.family_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Session id, family_id, user_id, and created_at are immutable'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auth_sessions_immutability
  BEFORE UPDATE ON public.auth_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_protect_auth_session_immutability();

ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_auth_sessions ON public.auth_sessions
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY auth_sessions_select ON public.auth_sessions
  FOR SELECT
  TO ft360_app
  USING (
    public.app_is_super_admin()
    OR (
      public.app_current_tenant_id() IS NULL
      AND user_id = public.app_current_user_id()
    )
  );

CREATE POLICY auth_sessions_update ON public.auth_sessions
  FOR UPDATE
  TO ft360_app
  USING (
    public.app_is_super_admin()
    OR (
      public.app_current_tenant_id() IS NULL
      AND user_id = public.app_current_user_id()
    )
  )
  WITH CHECK (
    public.app_is_super_admin()
    OR (
      public.app_current_tenant_id() IS NULL
      AND user_id = public.app_current_user_id()
    )
  );

-- Column-level SELECT omits refresh_token_hash, previous_refresh_token_hash, and csrf_secret_hash
-- so session secrets can NEVER be read directly into API DTOs.
GRANT SELECT (
  id,
  family_id,
  user_id,
  active_tenant_id,
  active_membership_id,
  ip_address,
  user_agent,
  last_active_at,
  idle_expires_at,
  expires_at,
  revoked_at,
  revoked_reason,
  created_at,
  updated_at
) ON public.auth_sessions TO ft360_app;

GRANT UPDATE (
  revoked_at,
  revoked_reason,
  updated_at
) ON public.auth_sessions TO ft360_app;

-- -----------------------------------------------------------------------------
-- 3. EMAIL_VERIFICATION_TOKENS (Single-Use SHA-256 Verification Tokens)
-- -----------------------------------------------------------------------------
CREATE TABLE public.email_verification_tokens (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  requested_ip INET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_email_verification_tokens_hash UNIQUE (token_hash),
  CONSTRAINT fk_email_verification_tokens_user
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT chk_email_verification_tokens_hash_hex CHECK (
    token_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_email_verification_tokens_expiry CHECK (
    expires_at > created_at
  )
);

CREATE INDEX idx_email_verification_tokens_user_active
  ON public.email_verification_tokens (user_id, expires_at DESC)
  WHERE consumed_at IS NULL;

ALTER TABLE public.email_verification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_verification_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_email_verification_tokens ON public.email_verification_tokens
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY email_verification_tokens_super_select ON public.email_verification_tokens
  FOR SELECT
  TO ft360_app
  USING (public.app_is_super_admin());

GRANT SELECT (
  id,
  user_id,
  expires_at,
  consumed_at,
  requested_ip,
  created_at
) ON public.email_verification_tokens TO ft360_app;

-- -----------------------------------------------------------------------------
-- 4. PASSWORD_RESET_TOKENS (Single-Use SHA-256 Recovery Tokens)
-- -----------------------------------------------------------------------------
CREATE TABLE public.password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  requested_ip INET NULL,
  consumed_ip INET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_password_reset_tokens_hash UNIQUE (token_hash),
  CONSTRAINT fk_password_reset_tokens_user
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT chk_password_reset_tokens_hash_hex CHECK (
    token_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_password_reset_tokens_expiry CHECK (
    expires_at > created_at
  )
);

CREATE INDEX idx_password_reset_tokens_user_active
  ON public.password_reset_tokens (user_id, expires_at DESC)
  WHERE consumed_at IS NULL;

ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_reset_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_password_reset_tokens ON public.password_reset_tokens
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY password_reset_tokens_super_select ON public.password_reset_tokens
  FOR SELECT
  TO ft360_app
  USING (public.app_is_super_admin());

GRANT SELECT (
  id,
  user_id,
  expires_at,
  consumed_at,
  requested_ip,
  consumed_ip,
  created_at
) ON public.password_reset_tokens TO ft360_app;

-- -----------------------------------------------------------------------------
-- 5. AUTH_AUDIT_LOGS (Append-Only Authentication & Authorization Security Ledger)
-- -----------------------------------------------------------------------------
CREATE TABLE public.auth_audit_logs (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  event_type VARCHAR(64) NOT NULL,
  outcome VARCHAR(16) NOT NULL,
  actor_user_id UUID NULL,
  target_user_id UUID NULL,
  tenant_id UUID NULL,
  session_id UUID NULL,
  correlation_id UUID NOT NULL,
  ip_address INET NULL,
  user_agent VARCHAR(512) NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_auth_audit_logs_actor_user
    FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT fk_auth_audit_logs_target_user
    FOREIGN KEY (target_user_id) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT fk_auth_audit_logs_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE SET NULL,
  CONSTRAINT fk_auth_audit_logs_session
    FOREIGN KEY (session_id) REFERENCES public.auth_sessions(id) ON DELETE SET NULL,
  CONSTRAINT chk_auth_audit_logs_event_type CHECK (btrim(event_type) <> ''),
  CONSTRAINT chk_auth_audit_logs_outcome CHECK (
    outcome IN ('SUCCESS', 'FAILURE', 'DENIED')
  ),
  CONSTRAINT chk_auth_audit_logs_metadata_object CHECK (
    jsonb_typeof(metadata) = 'object'
  ),
  CONSTRAINT chk_auth_audit_logs_no_secret_keys CHECK (
    NOT (
      metadata ?| ARRAY[
        'password',
        'passwordHash',
        'password_hash',
        'refreshToken',
        'refresh_token',
        'refreshTokenHash',
        'refresh_token_hash',
        'accessToken',
        'access_token',
        'csrfSecret',
        'csrf_secret',
        'csrfSecretHash',
        'csrf_secret_hash',
        'rawToken',
        'token'
      ]
    )
  )
);

CREATE INDEX idx_auth_audit_logs_tenant_created
  ON public.auth_audit_logs (tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX idx_auth_audit_logs_actor_created
  ON public.auth_audit_logs (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE INDEX idx_auth_audit_logs_event_created
  ON public.auth_audit_logs (event_type, outcome, created_at DESC);

CREATE OR REPLACE FUNCTION public.trigger_protect_auth_audit_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only ft360_migrator (schema migrations / test fixture FK cascades) can ever mutate/delete audit rows.
  -- Runtime role ft360_app (even in Super Admin mode) is strictly blocked.
  IF current_user <> 'ft360_migrator' THEN
    RAISE EXCEPTION 'Authentication audit logs are strictly append-only and immutable'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auth_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON public.auth_audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_protect_auth_audit_immutability();

ALTER TABLE public.auth_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_audit_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_auth_audit_logs ON public.auth_audit_logs
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY auth_audit_logs_select ON public.auth_audit_logs
  FOR SELECT
  TO ft360_app
  USING (
    public.app_is_super_admin()
    OR (
      public.app_current_tenant_id() IS NOT NULL
      AND tenant_id = public.app_current_tenant_id()
    )
  );

CREATE POLICY auth_audit_logs_insert ON public.auth_audit_logs
  FOR INSERT
  TO ft360_app
  WITH CHECK (
    public.app_is_super_admin()
    OR (
      public.app_current_tenant_id() IS NOT NULL
      AND tenant_id = public.app_current_tenant_id()
    )
  );

-- UPDATE and DELETE privileges intentionally omitted (append-only security ledger)
GRANT SELECT, INSERT ON public.auth_audit_logs TO ft360_app;

-- -----------------------------------------------------------------------------
-- 6. NARROW SECURITY DEFINER AUTHENTICATION & SESSION ROUTINES
-- -----------------------------------------------------------------------------

-- 6A. Self-service registration (inserts PENDING user + verification token atomically)
CREATE OR REPLACE FUNCTION public.fn_auth_register_user(
  p_email CITEXT,
  p_password_hash TEXT,
  p_full_name VARCHAR(160),
  p_phone_e164 VARCHAR(24),
  p_verify_token_hash CHAR(64),
  p_verify_ttl_seconds INTEGER,
  p_requested_ip INET DEFAULT NULL
)
RETURNS TABLE (
  user_id UUID,
  email TEXT,
  full_name VARCHAR(160),
  phone_e164 VARCHAR(24),
  status VARCHAR(24),
  is_platform_super_admin BOOLEAN,
  email_verified BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_user public.users%ROWTYPE;
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_register_user cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  IF p_password_hash IS NULL OR btrim(p_password_hash) = '' THEN
    RAISE EXCEPTION 'Password hash is required for user registration'
      USING ERRCODE = '22023';
  END IF;

  IF p_verify_ttl_seconds IS NULL OR p_verify_ttl_seconds < 60 THEN
    RAISE EXCEPTION 'Verification token TTL must be at least 60 seconds'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.users (
    email,
    password_hash,
    full_name,
    phone_e164,
    status,
    is_platform_super_admin,
    email_verified
  )
  VALUES (
    btrim(p_email::text)::citext,
    p_password_hash,
    btrim(p_full_name),
    NULLIF(btrim(COALESCE(p_phone_e164, '')), ''),
    'PENDING',
    FALSE,
    FALSE
  )
  RETURNING * INTO v_user;

  INSERT INTO public.email_verification_tokens (
    user_id,
    token_hash,
    expires_at,
    requested_ip
  )
  VALUES (
    v_user.id,
    p_verify_token_hash,
    NOW() + make_interval(secs => p_verify_ttl_seconds),
    p_requested_ip
  );

  RETURN QUERY
  SELECT
    v_user.id,
    v_user.email::text,
    v_user.full_name,
    v_user.phone_e164,
    v_user.status,
    v_user.is_platform_super_admin,
    v_user.email_verified,
    v_user.created_at,
    v_user.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_register_user(CITEXT, TEXT, VARCHAR, VARCHAR, CHAR, INTEGER, INET) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_register_user(CITEXT, TEXT, VARCHAR, VARCHAR, CHAR, INTEGER, INET) TO ft360_app;

-- 6B. Pre-tenant login candidate lookup (sole narrow reader of users.password_hash)
CREATE OR REPLACE FUNCTION public.fn_auth_get_login_candidate(
  p_email CITEXT
)
RETURNS TABLE (
  user_id UUID,
  email TEXT,
  full_name VARCHAR(160),
  phone_e164 VARCHAR(24),
  password_hash TEXT,
  status VARCHAR(24),
  is_platform_super_admin BOOLEAN,
  email_verified BOOLEAN,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_get_login_candidate cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    u.id AS user_id,
    u.email::text AS email,
    u.full_name,
    u.phone_e164,
    u.password_hash,
    u.status,
    u.is_platform_super_admin,
    u.email_verified,
    u.last_login_at,
    u.created_at,
    u.updated_at
  FROM public.users u
  WHERE u.email = btrim(p_email::text)::citext;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_get_login_candidate(CITEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_get_login_candidate(CITEXT) TO ft360_app;

-- 6C. Consume single-use email verification token
CREATE OR REPLACE FUNCTION public.fn_auth_verify_email_token(
  p_token_hash CHAR(64)
)
RETURNS TABLE (
  user_id UUID,
  email TEXT,
  status VARCHAR(24),
  email_verified BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_tok public.email_verification_tokens%ROWTYPE;
  v_user public.users%ROWTYPE;
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_verify_email_token cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_tok
    FROM public.email_verification_tokens evt
   WHERE evt.token_hash = p_token_hash
     AND evt.consumed_at IS NULL
     AND evt.expires_at > NOW()
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT *
    INTO v_user
    FROM public.users u
   WHERE u.id = v_tok.user_id
   FOR UPDATE;

  IF NOT FOUND OR v_user.status NOT IN ('PENDING', 'ACTIVE') THEN
    RETURN;
  END IF;

  UPDATE public.email_verification_tokens evt
     SET consumed_at = NOW()
   WHERE evt.user_id = v_user.id
     AND evt.consumed_at IS NULL;

  UPDATE public.users u
     SET email_verified = TRUE,
         status = CASE WHEN u.status = 'PENDING' THEN 'ACTIVE' ELSE u.status END
   WHERE u.id = v_user.id
   RETURNING * INTO v_user;

  RETURN QUERY
  SELECT v_user.id, v_user.email::text, v_user.status, v_user.email_verified;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_verify_email_token(CHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_verify_email_token(CHAR) TO ft360_app;

-- 6D. Re-issue email verification token (anti-enumeration: empty set if unknown or already verified)
CREATE OR REPLACE FUNCTION public.fn_auth_issue_email_verification_token(
  p_email CITEXT,
  p_token_hash CHAR(64),
  p_ttl_seconds INTEGER,
  p_requested_ip INET DEFAULT NULL
)
RETURNS TABLE (
  user_id UUID,
  email TEXT,
  full_name VARCHAR(160)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_user public.users%ROWTYPE;
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_issue_email_verification_token cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_user
    FROM public.users u
   WHERE u.email = btrim(p_email::text)::citext
     AND u.email_verified = FALSE
     AND u.status IN ('PENDING', 'ACTIVE')
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.email_verification_tokens
     SET consumed_at = NOW()
   WHERE email_verification_tokens.user_id = v_user.id
     AND consumed_at IS NULL;

  INSERT INTO public.email_verification_tokens (
    user_id,
    token_hash,
    expires_at,
    requested_ip
  )
  VALUES (
    v_user.id,
    p_token_hash,
    NOW() + make_interval(secs => p_ttl_seconds),
    p_requested_ip
  );

  RETURN QUERY
  SELECT v_user.id, v_user.email::text, v_user.full_name;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_issue_email_verification_token(CITEXT, CHAR, INTEGER, INET) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_issue_email_verification_token(CITEXT, CHAR, INTEGER, INET) TO ft360_app;

-- 6E. Issue single-use password reset token (anti-enumeration: empty set if unknown or inactive)
CREATE OR REPLACE FUNCTION public.fn_auth_issue_password_reset_token(
  p_email CITEXT,
  p_token_hash CHAR(64),
  p_ttl_seconds INTEGER,
  p_requested_ip INET DEFAULT NULL
)
RETURNS TABLE (
  user_id UUID,
  email TEXT,
  full_name VARCHAR(160)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_user public.users%ROWTYPE;
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_issue_password_reset_token cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_user
    FROM public.users u
   WHERE u.email = btrim(p_email::text)::citext
     AND u.status = 'ACTIVE'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.password_reset_tokens
     SET consumed_at = NOW()
   WHERE password_reset_tokens.user_id = v_user.id
     AND consumed_at IS NULL;

  INSERT INTO public.password_reset_tokens (
    user_id,
    token_hash,
    expires_at,
    requested_ip
  )
  VALUES (
    v_user.id,
    p_token_hash,
    NOW() + make_interval(secs => p_ttl_seconds),
    p_requested_ip
  );

  RETURN QUERY
  SELECT v_user.id, v_user.email::text, v_user.full_name;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_issue_password_reset_token(CITEXT, CHAR, INTEGER, INET) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_issue_password_reset_token(CITEXT, CHAR, INTEGER, INET) TO ft360_app;

-- 6F. Consume single-use password reset token, update Argon2id hash, and revoke ALL active sessions
CREATE OR REPLACE FUNCTION public.fn_auth_reset_password(
  p_token_hash CHAR(64),
  p_new_password_hash TEXT,
  p_consumed_ip INET DEFAULT NULL
)
RETURNS TABLE (
  user_id UUID,
  email TEXT,
  revoked_session_ids UUID[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_tok public.password_reset_tokens%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_revoked_ids UUID[];
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_reset_password cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  IF p_new_password_hash IS NULL OR btrim(p_new_password_hash) = '' THEN
    RAISE EXCEPTION 'New password hash is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_tok
    FROM public.password_reset_tokens prt
   WHERE prt.token_hash = p_token_hash
     AND prt.consumed_at IS NULL
     AND prt.expires_at > NOW()
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT *
    INTO v_user
    FROM public.users u
   WHERE u.id = v_tok.user_id
   FOR UPDATE;

  IF NOT FOUND OR v_user.status <> 'ACTIVE' THEN
    RETURN;
  END IF;

  UPDATE public.password_reset_tokens prt
     SET consumed_at = NOW(),
         consumed_ip = CASE WHEN prt.id = v_tok.id THEN p_consumed_ip ELSE prt.consumed_ip END
   WHERE prt.user_id = v_user.id
     AND prt.consumed_at IS NULL;

  UPDATE public.users u
     SET password_hash = p_new_password_hash
   WHERE u.id = v_user.id;

  WITH revoked AS (
    UPDATE public.auth_sessions s
       SET revoked_at = NOW(),
           revoked_reason = 'PASSWORD_RESET'
     WHERE s.user_id = v_user.id
       AND s.revoked_at IS NULL
     RETURNING s.id
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::UUID[])
    INTO v_revoked_ids
    FROM revoked;

  RETURN QUERY
  SELECT v_user.id, v_user.email::text, v_revoked_ids;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_reset_password(CHAR, TEXT, INET) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_reset_password(CHAR, TEXT, INET) TO ft360_app;

-- 6G. Create new authenticated session on verified login
CREATE OR REPLACE FUNCTION public.fn_auth_create_session(
  p_user_id UUID,
  p_refresh_token_hash CHAR(64),
  p_csrf_secret_hash CHAR(64),
  p_idle_ttl_seconds INTEGER,
  p_absolute_ttl_seconds INTEGER,
  p_ip_address INET DEFAULT NULL,
  p_user_agent VARCHAR(512) DEFAULT NULL
)
RETURNS TABLE (
  session_id UUID,
  family_id UUID,
  user_id UUID,
  idle_expires_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_user public.users%ROWTYPE;
  v_sess public.auth_sessions%ROWTYPE;
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_create_session cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_user
    FROM public.users u
   WHERE u.id = p_user_id
   FOR UPDATE;

  IF NOT FOUND OR v_user.status <> 'ACTIVE' OR v_user.email_verified IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Cannot create session for inactive or unverified user'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.users
     SET last_login_at = NOW()
   WHERE id = v_user.id;

  INSERT INTO public.auth_sessions (
    user_id,
    active_tenant_id,
    active_membership_id,
    refresh_token_hash,
    csrf_secret_hash,
    ip_address,
    user_agent,
    idle_expires_at,
    expires_at
  )
  VALUES (
    v_user.id,
    NULL,
    NULL,
    p_refresh_token_hash,
    p_csrf_secret_hash,
    p_ip_address,
    p_user_agent,
    NOW() + make_interval(secs => p_idle_ttl_seconds),
    NOW() + make_interval(secs => p_absolute_ttl_seconds)
  )
  RETURNING * INTO v_sess;

  RETURN QUERY
  SELECT
    v_sess.id,
    v_sess.family_id,
    v_sess.user_id,
    v_sess.idle_expires_at,
    v_sess.expires_at,
    v_sess.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_create_session(UUID, CHAR, CHAR, INTEGER, INTEGER, INET, VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_create_session(UUID, CHAR, CHAR, INTEGER, INTEGER, INET, VARCHAR) TO ft360_app;

-- 6H. Validate live session & optional CSRF hash without exposing csrf_secret_hash or refresh_token_hash
CREATE OR REPLACE FUNCTION public.fn_auth_validate_session(
  p_session_id UUID,
  p_candidate_csrf_hash CHAR(64) DEFAULT NULL
)
RETURNS TABLE (
  session_id UUID,
  family_id UUID,
  user_id UUID,
  active_tenant_id UUID,
  active_membership_id UUID,
  idle_expires_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  user_status VARCHAR(24),
  user_email_verified BOOLEAN,
  is_platform_super_admin BOOLEAN,
  csrf_valid BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_validate_session cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    s.id AS session_id,
    s.family_id,
    s.user_id,
    s.active_tenant_id,
    s.active_membership_id,
    s.idle_expires_at,
    s.expires_at,
    s.revoked_at,
    u.status AS user_status,
    u.email_verified AS user_email_verified,
    u.is_platform_super_admin,
    (p_candidate_csrf_hash IS NOT NULL AND s.csrf_secret_hash = p_candidate_csrf_hash) AS csrf_valid
  FROM public.auth_sessions s
  INNER JOIN public.users u ON u.id = s.user_id
  WHERE s.id = p_session_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_validate_session(UUID, CHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_validate_session(UUID, CHAR) TO ft360_app;

-- 6I. Single-use refresh token rotation with family-wide replay/theft revocation
CREATE OR REPLACE FUNCTION public.fn_auth_rotate_refresh_session(
  p_presented_refresh_hash CHAR(64),
  p_new_refresh_hash CHAR(64),
  p_new_csrf_hash CHAR(64),
  p_idle_ttl_seconds INTEGER,
  p_candidate_csrf_hash CHAR(64) DEFAULT NULL,
  p_require_csrf BOOLEAN DEFAULT TRUE,
  p_ip_address INET DEFAULT NULL,
  p_user_agent VARCHAR(512) DEFAULT NULL
)
RETURNS TABLE (
  outcome VARCHAR(32),
  session_id UUID,
  family_id UUID,
  user_id UUID,
  active_tenant_id UUID,
  active_membership_id UUID,
  is_platform_super_admin BOOLEAN,
  idle_expires_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_family_session_ids UUID[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_sess public.auth_sessions%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_family_ids UUID[] := ARRAY[]::UUID[];
  v_member RECORD;
  v_next_tid UUID;
  v_next_mid UUID;
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_rotate_refresh_session cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_sess
    FROM public.auth_sessions s
   WHERE s.refresh_token_hash = p_presented_refresh_hash
      OR s.previous_refresh_token_hash = p_presented_refresh_hash
   ORDER BY (s.refresh_token_hash = p_presented_refresh_hash) DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY
    SELECT
      'NOT_FOUND'::VARCHAR(32),
      NULL::UUID,
      NULL::UUID,
      NULL::UUID,
      NULL::UUID,
      NULL::UUID,
      FALSE,
      NULL::TIMESTAMPTZ,
      NULL::TIMESTAMPTZ,
      ARRAY[]::UUID[];
    RETURN;
  END IF;

  -- Replay / theft detection: presented hash matches already-rotated previous_refresh_token_hash
  IF v_sess.previous_refresh_token_hash = p_presented_refresh_hash
     OR v_sess.revoked_reason = 'REPLAY_COMPROMISE' THEN
    WITH family_revoked AS (
      UPDATE public.auth_sessions
         SET revoked_at = COALESCE(revoked_at, NOW()),
             revoked_reason = 'REPLAY_COMPROMISE'
       WHERE auth_sessions.family_id = v_sess.family_id
       RETURNING id
    )
    SELECT COALESCE(array_agg(id), ARRAY[]::UUID[])
      INTO v_family_ids
      FROM family_revoked;

    RETURN QUERY
    SELECT
      'REPLAY_DETECTED'::VARCHAR(32),
      v_sess.id,
      v_sess.family_id,
      v_sess.user_id,
      v_sess.active_tenant_id,
      v_sess.active_membership_id,
      FALSE,
      v_sess.idle_expires_at,
      v_sess.expires_at,
      v_family_ids;
    RETURN;
  END IF;

  IF v_sess.revoked_at IS NOT NULL THEN
    RETURN QUERY
    SELECT
      'REVOKED'::VARCHAR(32),
      v_sess.id,
      v_sess.family_id,
      v_sess.user_id,
      v_sess.active_tenant_id,
      v_sess.active_membership_id,
      FALSE,
      v_sess.idle_expires_at,
      v_sess.expires_at,
      ARRAY[v_sess.id];
    RETURN;
  END IF;

  IF v_sess.expires_at <= NOW() OR v_sess.idle_expires_at <= NOW() THEN
    UPDATE public.auth_sessions
       SET revoked_at = NOW(),
           revoked_reason = 'EXPIRED'
     WHERE id = v_sess.id;

    RETURN QUERY
    SELECT
      'EXPIRED'::VARCHAR(32),
      v_sess.id,
      v_sess.family_id,
      v_sess.user_id,
      v_sess.active_tenant_id,
      v_sess.active_membership_id,
      FALSE,
      v_sess.idle_expires_at,
      v_sess.expires_at,
      ARRAY[v_sess.id];
    RETURN;
  END IF;

  IF p_require_csrf AND (p_candidate_csrf_hash IS NULL OR v_sess.csrf_secret_hash <> p_candidate_csrf_hash) THEN
    RETURN QUERY
    SELECT
      'CSRF_INVALID'::VARCHAR(32),
      v_sess.id,
      v_sess.family_id,
      v_sess.user_id,
      v_sess.active_tenant_id,
      v_sess.active_membership_id,
      FALSE,
      v_sess.idle_expires_at,
      v_sess.expires_at,
      ARRAY[]::UUID[];
    RETURN;
  END IF;

  SELECT *
    INTO v_user
    FROM public.users u
   WHERE u.id = v_sess.user_id
   FOR SHARE;

  IF NOT FOUND OR v_user.status <> 'ACTIVE' OR v_user.email_verified IS DISTINCT FROM TRUE THEN
    UPDATE public.auth_sessions
       SET revoked_at = NOW(),
           revoked_reason = 'USER_INACTIVE'
     WHERE id = v_sess.id;

    RETURN QUERY
    SELECT
      'USER_INACTIVE'::VARCHAR(32),
      v_sess.id,
      v_sess.family_id,
      v_sess.user_id,
      v_sess.active_tenant_id,
      v_sess.active_membership_id,
      FALSE,
      v_sess.idle_expires_at,
      v_sess.expires_at,
      ARRAY[v_sess.id];
    RETURN;
  END IF;

  -- Re-verify bound organization if session currently has an active tenant
  v_next_tid := v_sess.active_tenant_id;
  v_next_mid := v_sess.active_membership_id;
  IF v_next_tid IS NOT NULL THEN
    SELECT *
      INTO v_member
      FROM public.fn_verify_tenant_membership(v_user.id, v_next_tid);

    IF NOT FOUND
       OR v_member.membership_status <> 'ACTIVE'
       OR v_member.tenant_status NOT IN ('ACTIVE', 'TRIAL') THEN
      v_next_tid := NULL;
      v_next_mid := NULL;
    ELSE
      v_next_mid := v_member.membership_id;
    END IF;
  END IF;

  UPDATE public.auth_sessions
     SET previous_refresh_token_hash = v_sess.refresh_token_hash,
         refresh_token_hash = p_new_refresh_hash,
         csrf_secret_hash = p_new_csrf_hash,
         active_tenant_id = v_next_tid,
         active_membership_id = v_next_mid,
         last_active_at = NOW(),
         idle_expires_at = LEAST(v_sess.expires_at, NOW() + make_interval(secs => p_idle_ttl_seconds)),
         ip_address = COALESCE(p_ip_address, v_sess.ip_address),
         user_agent = COALESCE(p_user_agent, v_sess.user_agent)
   WHERE id = v_sess.id
   RETURNING * INTO v_sess;

  RETURN QUERY
  SELECT
    'ROTATED'::VARCHAR(32),
    v_sess.id,
    v_sess.family_id,
    v_sess.user_id,
    v_sess.active_tenant_id,
    v_sess.active_membership_id,
    v_user.is_platform_super_admin,
    v_sess.idle_expires_at,
    v_sess.expires_at,
    ARRAY[]::UUID[];
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_rotate_refresh_session(CHAR, CHAR, CHAR, INTEGER, CHAR, BOOLEAN, INET, VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_rotate_refresh_session(CHAR, CHAR, CHAR, INTEGER, CHAR, BOOLEAN, INET, VARCHAR) TO ft360_app;

-- 6J. Bind or clear active organization on a verified server-side session
CREATE OR REPLACE FUNCTION public.fn_auth_bind_session_organization(
  p_session_id UUID,
  p_user_id UUID,
  p_target_tenant_id UUID DEFAULT NULL
)
RETURNS TABLE (
  outcome VARCHAR(40),
  session_id UUID,
  active_tenant_id UUID,
  active_membership_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_sess public.auth_sessions%ROWTYPE;
  v_member RECORD;
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_bind_session_organization cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_sess
    FROM public.auth_sessions s
   WHERE s.id = p_session_id
     AND s.user_id = p_user_id
     AND s.revoked_at IS NULL
     AND s.expires_at > NOW()
     AND s.idle_expires_at > NOW()
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY
    SELECT 'SESSION_INVALID'::VARCHAR(40), NULL::UUID, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  IF p_target_tenant_id IS NULL THEN
    UPDATE public.auth_sessions
       SET active_tenant_id = NULL,
           active_membership_id = NULL,
           last_active_at = NOW()
     WHERE id = v_sess.id;

    RETURN QUERY
    SELECT 'CLEARED'::VARCHAR(40), v_sess.id, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  SELECT *
    INTO v_member
    FROM public.fn_verify_tenant_membership(p_user_id, p_target_tenant_id);

  IF NOT FOUND THEN
    RETURN QUERY
    SELECT 'TENANT_MEMBERSHIP_DENIED'::VARCHAR(40), v_sess.id, v_sess.active_tenant_id, v_sess.active_membership_id;
    RETURN;
  END IF;

  IF v_member.user_status <> 'ACTIVE' THEN
    RETURN QUERY
    SELECT 'USER_ACCOUNT_INACTIVE'::VARCHAR(40), v_sess.id, v_sess.active_tenant_id, v_sess.active_membership_id;
    RETURN;
  END IF;

  IF v_member.membership_status <> 'ACTIVE' THEN
    RETURN QUERY
    SELECT 'TENANT_MEMBERSHIP_INACTIVE'::VARCHAR(40), v_sess.id, v_sess.active_tenant_id, v_sess.active_membership_id;
    RETURN;
  END IF;

  IF v_member.tenant_status NOT IN ('ACTIVE', 'TRIAL') THEN
    RETURN QUERY
    SELECT 'TENANT_SUSPENDED_OR_INACTIVE'::VARCHAR(40), v_sess.id, v_sess.active_tenant_id, v_sess.active_membership_id;
    RETURN;
  END IF;

  UPDATE public.auth_sessions
     SET active_tenant_id = p_target_tenant_id,
         active_membership_id = v_member.membership_id,
         last_active_at = NOW()
   WHERE id = v_sess.id;

  RETURN QUERY
  SELECT 'BOUND'::VARCHAR(40), v_sess.id, p_target_tenant_id, v_member.membership_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_bind_session_organization(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_bind_session_organization(UUID, UUID, UUID) TO ft360_app;

-- 6K. Revoke single session (by session_id + owner user_id, or by presented refresh hash on logout)
CREATE OR REPLACE FUNCTION public.fn_auth_revoke_session(
  p_session_id UUID,
  p_user_id UUID,
  p_reason VARCHAR(64) DEFAULT 'USER_LOGOUT'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_revoke_session cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.auth_sessions
     SET revoked_at = COALESCE(revoked_at, NOW()),
         revoked_reason = COALESCE(revoked_reason, btrim(p_reason))
   WHERE id = p_session_id
     AND user_id = p_user_id
     AND revoked_at IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_revoke_session(UUID, UUID, VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_revoke_session(UUID, UUID, VARCHAR) TO ft360_app;

-- 6K-2. Revoke single session by refresh token hash (supports logout when access JWT has expired)
CREATE OR REPLACE FUNCTION public.fn_auth_revoke_session_by_refresh_hash(
  p_refresh_token_hash CHAR(64),
  p_reason VARCHAR(64) DEFAULT 'USER_LOGOUT'
)
RETURNS TABLE (
  session_id UUID,
  user_id UUID,
  active_tenant_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_sess public.auth_sessions%ROWTYPE;
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_revoke_session_by_refresh_hash cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.auth_sessions s
     SET revoked_at = COALESCE(s.revoked_at, NOW()),
         revoked_reason = COALESCE(s.revoked_reason, btrim(p_reason))
   WHERE s.refresh_token_hash = p_refresh_token_hash
   RETURNING * INTO v_sess;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT v_sess.id, v_sess.user_id, v_sess.active_tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_revoke_session_by_refresh_hash(CHAR, VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_revoke_session_by_refresh_hash(CHAR, VARCHAR) TO ft360_app;

-- 6L. Revoke all active sessions for a user across all devices
CREATE OR REPLACE FUNCTION public.fn_auth_revoke_all_user_sessions(
  p_user_id UUID,
  p_reason VARCHAR(64) DEFAULT 'USER_LOGOUT_ALL'
)
RETURNS UUID[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ids UUID[];
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_revoke_all_user_sessions cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  WITH revoked AS (
    UPDATE public.auth_sessions
       SET revoked_at = NOW(),
           revoked_reason = btrim(p_reason)
     WHERE user_id = p_user_id
       AND revoked_at IS NULL
     RETURNING id
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::UUID[])
    INTO v_ids
    FROM revoked;

  RETURN v_ids;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_revoke_all_user_sessions(UUID, VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_revoke_all_user_sessions(UUID, VARCHAR) TO ft360_app;

-- 6M. Append-only authentication & authorization audit writer
CREATE OR REPLACE FUNCTION public.fn_record_auth_audit_log(
  p_event_type VARCHAR(64),
  p_outcome VARCHAR(16),
  p_correlation_id UUID,
  p_actor_user_id UUID DEFAULT NULL,
  p_target_user_id UUID DEFAULT NULL,
  p_tenant_id UUID DEFAULT NULL,
  p_session_id UUID DEFAULT NULL,
  p_ip_address INET DEFAULT NULL,
  p_user_agent VARCHAR(512) DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_current_tid UUID := public.app_current_tenant_id();
  v_audit_id UUID;
BEGIN
  -- Prevent cross-tenant audit forgery if called inside a tenant transaction
  IF v_current_tid IS NOT NULL AND p_tenant_id IS DISTINCT FROM v_current_tid THEN
    RAISE EXCEPTION 'Cannot record auth audit event for a different tenant than active transaction scope'
      USING ERRCODE = '42501';
  END IF;

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
    btrim(p_event_type),
    btrim(p_outcome),
    p_actor_user_id,
    p_target_user_id,
    p_tenant_id,
    p_session_id,
    p_correlation_id,
    p_ip_address,
    p_user_agent,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_audit_id;

  RETURN v_audit_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_record_auth_audit_log(VARCHAR, VARCHAR, UUID, UUID, UUID, UUID, UUID, INET, VARCHAR, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_record_auth_audit_log(VARCHAR, VARCHAR, UUID, UUID, UUID, UUID, UUID, INET, VARCHAR, JSONB) TO ft360_app;
