-- =============================================================================
-- Migration: 0008_phase4_invitations_outbox_and_integrity_routines (DOWN)
-- Purpose:
--   Cleanly rolls back Migration 0008 routines, triggers, outbox extensions,
--   and `public.tenant_invitations`, restoring Migration 0005 / 0006 definitions.
-- =============================================================================

-- 1. Drop Phase 4 lifecycle, ownership, and session-eviction routines
DROP FUNCTION IF EXISTS public.fn_platform_transition_tenant_status(
  UUID, VARCHAR, VARCHAR, VARCHAR, UUID, INET, VARCHAR
);
DROP FUNCTION IF EXISTS public.fn_tenant_transfer_primary_owner(
  UUID, UUID, VARCHAR, UUID, INET, VARCHAR
);
DROP FUNCTION IF EXISTS public.fn_tenant_evict_member_sessions(UUID, UUID);

-- 2. Restore `fn_auth_register_user` to Migration 0005 definition
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

-- 3. Drop administrator integrity & anti-lockout triggers
DROP TRIGGER IF EXISTS trg_tm_prevent_last_admin_removal ON public.tenant_memberships;
DROP TRIGGER IF EXISTS trg_ura_prevent_last_admin_removal ON public.user_role_assignments;
DROP FUNCTION IF EXISTS public.trigger_prevent_last_tenant_admin_removal();

DROP TRIGGER IF EXISTS trg_tm_enforce_admin_membership_type ON public.tenant_memberships;
DROP TRIGGER IF EXISTS trg_ura_enforce_admin_membership_type ON public.user_role_assignments;
DROP FUNCTION IF EXISTS public.trigger_enforce_admin_membership_type();

-- 4. Restore `fn_auth_claim_email_outbox_*` and `auth_email_outbox` to Migration 0006 definition
DROP FUNCTION IF EXISTS public.fn_tenant_enqueue_invitation_email_outbox(
  UUID, UUID, CITEXT, VARCHAR, TEXT, INTEGER, UUID
);

CREATE OR REPLACE FUNCTION public.fn_auth_claim_email_outbox_by_id(
  p_outbox_id UUID
)
RETURNS TABLE (
  outbox_id UUID,
  kind VARCHAR(32),
  user_id UUID,
  recipient_email TEXT,
  recipient_full_name VARCHAR(160),
  encrypted_action_token TEXT,
  token_expires_at TIMESTAMPTZ,
  status VARCHAR(24),
  attempt_count INTEGER,
  max_attempts INTEGER,
  correlation_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_row public.auth_email_outbox%ROWTYPE;
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_claim_email_outbox_by_id cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_row
    FROM public.auth_email_outbox o
   WHERE o.id = p_outbox_id
   FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_row.status NOT IN ('PENDING', 'FAILED_RETRYABLE') THEN
    RETURN;
  END IF;

  IF v_row.token_expires_at <= NOW() THEN
    UPDATE public.auth_email_outbox o
       SET status = 'EXPIRED',
           encrypted_action_token = NULL,
           last_error_code = 'TOKEN_EXPIRED_BEFORE_SEND',
           last_error_redacted = 'Underlying verification or reset token expired prior to delivery.'
     WHERE o.id = v_row.id
     RETURNING * INTO v_row;

    RETURN QUERY
    SELECT
      v_row.id,
      v_row.kind,
      v_row.user_id,
      v_row.recipient_email::text,
      v_row.recipient_full_name,
      v_row.encrypted_action_token,
      v_row.token_expires_at,
      v_row.status,
      v_row.attempt_count,
      v_row.max_attempts,
      v_row.correlation_id;
    RETURN;
  END IF;

  UPDATE public.auth_email_outbox o
     SET status = 'PROCESSING',
         attempt_count = o.attempt_count + 1
   WHERE o.id = v_row.id
   RETURNING * INTO v_row;

  RETURN QUERY
  SELECT
    v_row.id,
    v_row.kind,
    v_row.user_id,
    v_row.recipient_email::text,
    v_row.recipient_full_name,
    v_row.encrypted_action_token,
    v_row.token_expires_at,
    v_row.status,
    v_row.attempt_count,
    v_row.max_attempts,
    v_row.correlation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_claim_email_outbox_by_id(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_claim_email_outbox_by_id(UUID) TO ft360_app;

CREATE OR REPLACE FUNCTION public.fn_auth_claim_email_outbox_batch(
  p_batch_size INTEGER DEFAULT 10
)
RETURNS TABLE (
  outbox_id UUID,
  kind VARCHAR(32),
  user_id UUID,
  recipient_email TEXT,
  recipient_full_name VARCHAR(160),
  encrypted_action_token TEXT,
  token_expires_at TIMESTAMPTZ,
  status VARCHAR(24),
  attempt_count INTEGER,
  max_attempts INTEGER,
  correlation_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_limit INTEGER := LEAST(50, GREATEST(1, COALESCE(p_batch_size, 10)));
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_claim_email_outbox_batch cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.auth_email_outbox o
     SET status = 'EXPIRED',
         encrypted_action_token = NULL,
         last_error_code = 'TOKEN_EXPIRED_BEFORE_SEND',
         last_error_redacted = 'Underlying verification or reset token expired prior to delivery.'
   WHERE o.status IN ('PENDING', 'FAILED_RETRYABLE')
     AND o.token_expires_at <= NOW();

  RETURN QUERY
  WITH candidate_ids AS (
    SELECT o.id
      FROM public.auth_email_outbox o
     WHERE o.status IN ('PENDING', 'FAILED_RETRYABLE')
       AND o.next_attempt_at <= NOW()
       AND o.token_expires_at > NOW()
     ORDER BY o.next_attempt_at ASC, o.created_at ASC
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.auth_email_outbox target
       SET status = 'PROCESSING',
           attempt_count = target.attempt_count + 1
      FROM candidate_ids c
     WHERE target.id = c.id
     RETURNING target.*
  )
  SELECT
    claimed.id,
    claimed.kind,
    claimed.user_id,
    claimed.recipient_email::text,
    claimed.recipient_full_name,
    claimed.encrypted_action_token,
    claimed.token_expires_at,
    claimed.status,
    claimed.attempt_count,
    claimed.max_attempts,
    claimed.correlation_id
  FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_claim_email_outbox_batch(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_claim_email_outbox_batch(INTEGER) TO ft360_app;

DELETE FROM public.auth_email_outbox
 WHERE kind = 'TENANT_INVITATION'
    OR user_id IS NULL;

DROP INDEX IF EXISTS public.idx_auth_email_outbox_invitation;

ALTER TABLE public.auth_email_outbox
  DROP CONSTRAINT IF EXISTS chk_auth_email_outbox_anchor,
  DROP CONSTRAINT IF EXISTS chk_auth_email_outbox_kind,
  DROP CONSTRAINT IF EXISTS fk_auth_email_outbox_invitation,
  DROP CONSTRAINT IF EXISTS fk_auth_email_outbox_initiated_by,
  DROP COLUMN IF EXISTS invitation_id,
  DROP COLUMN IF EXISTS tenant_id,
  DROP COLUMN IF EXISTS initiated_by_user_id;

ALTER TABLE public.auth_email_outbox
  ALTER COLUMN user_id SET NOT NULL,
  ADD CONSTRAINT chk_auth_email_outbox_kind CHECK (
    kind IN ('EMAIL_VERIFICATION', 'PASSWORD_RESET')
  );

-- 5. Drop `public.tenant_invitations`
DROP TABLE IF EXISTS public.tenant_invitations;
