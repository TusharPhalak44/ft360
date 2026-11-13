-- =============================================================================
-- Migration: 0006_phase3_auth_security_remediation (DOWN)
-- Purpose:
--   Cleanly rolls back Phase 3 security remediation schema additions and
--   restores Migration 0005 function definitions and constraints.
-- =============================================================================

-- 1. Restore Migration 0005 function definitions & grants
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

-- 2. Restore Migration 0005 metadata secret-key constraint & drop recursive validator
ALTER TABLE public.auth_audit_logs
  DROP CONSTRAINT IF EXISTS chk_auth_audit_logs_no_secret_keys;

ALTER TABLE public.auth_audit_logs
  ADD CONSTRAINT chk_auth_audit_logs_no_secret_keys CHECK (
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
  );

DROP FUNCTION IF EXISTS public.fn_jsonb_has_forbidden_secret_key(JSONB);

-- 3. Drop Migration 0006 routines
DROP FUNCTION IF EXISTS public.fn_auth_bootstrap_initial_super_admin(CITEXT, TEXT, VARCHAR);
DROP FUNCTION IF EXISTS public.fn_auth_get_email_outbox_status(UUID);
DROP FUNCTION IF EXISTS public.fn_auth_fail_email_outbox_delivery(UUID, INTEGER, VARCHAR, VARCHAR, BOOLEAN);
DROP FUNCTION IF EXISTS public.fn_auth_complete_email_outbox_delivery(UUID, VARCHAR, VARCHAR);
DROP FUNCTION IF EXISTS public.fn_auth_claim_email_outbox_batch(INTEGER);
DROP FUNCTION IF EXISTS public.fn_auth_claim_email_outbox_by_id(UUID);
DROP FUNCTION IF EXISTS public.fn_auth_enqueue_email_outbox(VARCHAR, UUID, CITEXT, VARCHAR, TEXT, INTEGER, INTEGER, UUID);

-- 4. Drop Migration 0006 tables
DROP TABLE IF EXISTS public.auth_email_outbox;
DROP TABLE IF EXISTS public.auth_refresh_token_history;
