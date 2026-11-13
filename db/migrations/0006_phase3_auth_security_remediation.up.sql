-- =============================================================================
-- Migration: 0006_phase3_auth_security_remediation (UP)
-- Owner Role: ft360_migrator (ft360_app NEVER owns tables)
-- Purpose:
--   1. Full refresh-token generation history (`auth_refresh_token_history`) linked
--      to session family so replaying ANY older generation (RT1 after RT2->RT3)
--      or racing concurrent refreshes revokes the entire session family.
--   2. Durable transactional email outbox (`auth_email_outbox`) with AES-256-GCM
--      sealed token column omitted from `ft360_app` SELECT, bounded exponential
--      backoff state, and narrow `SECURITY DEFINER` claim/complete/fail routines.
--   3. Controlled one-time Super Admin bootstrap function
--      (`fn_auth_bootstrap_initial_super_admin`) refusing email conflicts and
--      refusing execution once any active Platform Super Admin exists.
--   4. Recursive JSONB secret-key validator (`fn_jsonb_has_forbidden_secret_key`)
--      enforced by `chk_auth_audit_logs_no_secret_keys` across nested objects & arrays.
--   5. Hardened `SECURITY DEFINER` authorization on `fn_record_auth_audit_log`,
--      `fn_auth_create_session`, `fn_auth_validate_session`,
--      `fn_auth_rotate_refresh_session`, `fn_auth_bind_session_organization`,
--      `fn_auth_revoke_session`, and `fn_auth_revoke_all_user_sessions`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. AUTH_REFRESH_TOKEN_HISTORY (Full Family Generation Ledger)
-- -----------------------------------------------------------------------------
CREATE TABLE public.auth_refresh_token_history (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  session_id UUID NOT NULL,
  family_id UUID NOT NULL,
  user_id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL,
  generation INTEGER NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ NULL,
  replaced_by_token_hash CHAR(64) NULL,
  CONSTRAINT uq_auth_refresh_token_history_hash UNIQUE (token_hash),
  CONSTRAINT uq_auth_refresh_token_history_session_gen UNIQUE (session_id, generation),
  CONSTRAINT fk_auth_rt_history_session
    FOREIGN KEY (session_id) REFERENCES public.auth_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_auth_rt_history_user
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT chk_auth_rt_history_hash_hex CHECK (
    token_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_auth_rt_history_replaced_hex CHECK (
    replaced_by_token_hash IS NULL OR replaced_by_token_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_auth_rt_history_generation_pos CHECK (
    generation >= 1
  ),
  CONSTRAINT chk_auth_rt_history_consumed_pair CHECK (
    (consumed_at IS NULL AND replaced_by_token_hash IS NULL)
    OR (consumed_at IS NOT NULL)
  )
);

CREATE INDEX idx_auth_rt_history_family_id
  ON public.auth_refresh_token_history (family_id, generation DESC);

CREATE INDEX idx_auth_rt_history_session_active
  ON public.auth_refresh_token_history (session_id)
  WHERE consumed_at IS NULL;

ALTER TABLE public.auth_refresh_token_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_refresh_token_history FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_auth_refresh_token_history ON public.auth_refresh_token_history
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY auth_rt_history_super_select ON public.auth_refresh_token_history
  FOR SELECT
  TO ft360_app
  USING (public.app_is_super_admin());

-- Column-level SELECT omits token_hash and replaced_by_token_hash
GRANT SELECT (
  id,
  session_id,
  family_id,
  user_id,
  generation,
  issued_at,
  consumed_at
) ON public.auth_refresh_token_history TO ft360_app;

-- Backfill any pre-existing sessions from 0005 into generation history
INSERT INTO public.auth_refresh_token_history (
  session_id,
  family_id,
  user_id,
  token_hash,
  generation,
  issued_at,
  consumed_at,
  replaced_by_token_hash
)
SELECT
  s.id,
  s.family_id,
  s.user_id,
  s.previous_refresh_token_hash,
  1,
  s.created_at,
  s.updated_at,
  s.refresh_token_hash
FROM public.auth_sessions s
WHERE s.previous_refresh_token_hash IS NOT NULL
ON CONFLICT (token_hash) DO NOTHING;

INSERT INTO public.auth_refresh_token_history (
  session_id,
  family_id,
  user_id,
  token_hash,
  generation,
  issued_at,
  consumed_at,
  replaced_by_token_hash
)
SELECT
  s.id,
  s.family_id,
  s.user_id,
  s.refresh_token_hash,
  CASE WHEN s.previous_refresh_token_hash IS NOT NULL THEN 2 ELSE 1 END,
  s.updated_at,
  NULL,
  NULL
FROM public.auth_sessions s
ON CONFLICT (token_hash) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. AUTH_EMAIL_OUTBOX (Durable Transactional Auth Mail Outbox)
-- -----------------------------------------------------------------------------
CREATE TABLE public.auth_email_outbox (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  kind VARCHAR(32) NOT NULL,
  user_id UUID NOT NULL,
  recipient_email CITEXT NOT NULL,
  recipient_full_name VARCHAR(160) NOT NULL,
  encrypted_action_token TEXT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provider_name VARCHAR(64) NULL,
  provider_message_id VARCHAR(255) NULL,
  last_error_code VARCHAR(64) NULL,
  last_error_redacted VARCHAR(512) NULL,
  correlation_id UUID NOT NULL,
  sent_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_auth_email_outbox_user
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT chk_auth_email_outbox_kind CHECK (
    kind IN ('EMAIL_VERIFICATION', 'PASSWORD_RESET')
  ),
  CONSTRAINT chk_auth_email_outbox_status CHECK (
    status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED_RETRYABLE', 'DEAD_LETTER', 'EXPIRED')
  ),
  CONSTRAINT chk_auth_email_outbox_attempts CHECK (
    attempt_count >= 0 AND max_attempts >= 1
  ),
  CONSTRAINT chk_auth_email_outbox_cipher_wiped_on_terminal CHECK (
    status NOT IN ('SENT', 'DEAD_LETTER', 'EXPIRED') OR encrypted_action_token IS NULL
  )
);

CREATE INDEX idx_auth_email_outbox_due
  ON public.auth_email_outbox (next_attempt_at ASC, created_at ASC)
  WHERE status IN ('PENDING', 'FAILED_RETRYABLE');

CREATE INDEX idx_auth_email_outbox_user_created
  ON public.auth_email_outbox (user_id, created_at DESC);

CREATE TRIGGER trg_auth_email_outbox_updated_at
  BEFORE UPDATE ON public.auth_email_outbox
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.auth_email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_email_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_auth_email_outbox ON public.auth_email_outbox
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY auth_email_outbox_super_select ON public.auth_email_outbox
  FOR SELECT
  TO ft360_app
  USING (public.app_is_super_admin());

-- Column-level SELECT omits encrypted_action_token
GRANT SELECT (
  id,
  kind,
  user_id,
  recipient_email,
  recipient_full_name,
  token_expires_at,
  status,
  attempt_count,
  max_attempts,
  next_attempt_at,
  provider_name,
  provider_message_id,
  last_error_code,
  last_error_redacted,
  correlation_id,
  sent_at,
  created_at,
  updated_at
) ON public.auth_email_outbox TO ft360_app;

-- 2A. Enqueue durable transactional auth email outbox item
CREATE OR REPLACE FUNCTION public.fn_auth_enqueue_email_outbox(
  p_kind VARCHAR(32),
  p_user_id UUID,
  p_recipient_email CITEXT,
  p_recipient_full_name VARCHAR(160),
  p_encrypted_action_token TEXT,
  p_token_ttl_seconds INTEGER,
  p_max_attempts INTEGER,
  p_correlation_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_user public.users%ROWTYPE;
  v_outbox_id UUID;
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_enqueue_email_outbox cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  IF p_encrypted_action_token IS NULL OR btrim(p_encrypted_action_token) = '' THEN
    RAISE EXCEPTION 'Encrypted action token payload is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_user
    FROM public.users u
   WHERE u.id = p_user_id
   FOR SHARE;

  IF NOT FOUND OR v_user.email <> btrim(p_recipient_email::text)::citext THEN
    RAISE EXCEPTION 'Outbox recipient email does not match target user account'
      USING ERRCODE = '42501';
  END IF;

  IF btrim(p_kind) = 'EMAIL_VERIFICATION' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.email_verification_tokens evt
       WHERE evt.user_id = p_user_id
         AND evt.consumed_at IS NULL
         AND evt.expires_at > NOW()
    ) THEN
      RAISE EXCEPTION 'Cannot enqueue verification email without an active unconsumed verification token'
        USING ERRCODE = '42501';
    END IF;
  ELSIF btrim(p_kind) = 'PASSWORD_RESET' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.password_reset_tokens prt
       WHERE prt.user_id = p_user_id
         AND prt.consumed_at IS NULL
         AND prt.expires_at > NOW()
    ) THEN
      RAISE EXCEPTION 'Cannot enqueue password reset email without an active unconsumed reset token'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported outbox email kind'
      USING ERRCODE = '22023';
  END IF;

  -- Supersede any prior unsent outbox rows of the same kind for this user so stale emails are not sent
  UPDATE public.auth_email_outbox o
     SET status = 'EXPIRED',
         encrypted_action_token = NULL,
         last_error_code = 'SUPERSEDED_BY_NEWER_TOKEN',
         last_error_redacted = 'Superseded by a newer token issuance.'
   WHERE o.user_id = p_user_id
     AND o.kind = btrim(p_kind)
     AND o.status IN ('PENDING', 'FAILED_RETRYABLE');

  INSERT INTO public.auth_email_outbox (
    kind,
    user_id,
    recipient_email,
    recipient_full_name,
    encrypted_action_token,
    token_expires_at,
    status,
    attempt_count,
    max_attempts,
    next_attempt_at,
    correlation_id
  )
  VALUES (
    btrim(p_kind),
    p_user_id,
    btrim(p_recipient_email::text)::citext,
    btrim(p_recipient_full_name),
    p_encrypted_action_token,
    NOW() + make_interval(secs => GREATEST(60, p_token_ttl_seconds)),
    'PENDING',
    0,
    GREATEST(1, COALESCE(p_max_attempts, 5)),
    NOW(),
    p_correlation_id
  )
  RETURNING id INTO v_outbox_id;

  RETURN v_outbox_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_enqueue_email_outbox(VARCHAR, UUID, CITEXT, VARCHAR, TEXT, INTEGER, INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_enqueue_email_outbox(VARCHAR, UUID, CITEXT, VARCHAR, TEXT, INTEGER, INTEGER, UUID) TO ft360_app;

-- 2B. Claim a specific outbox item by ID (BullMQ worker push path)
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

-- 2C. Claim due outbox batch (fallback recovery sweeper when Redis/BullMQ was unavailable or retry due)
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

  -- First expire any due rows whose underlying token TTL has already elapsed
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

-- 2D. Mark outbox item SENT and wipe encrypted token ciphertext
CREATE OR REPLACE FUNCTION public.fn_auth_complete_email_outbox_delivery(
  p_outbox_id UUID,
  p_provider_name VARCHAR(64),
  p_provider_message_id VARCHAR(255)
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
    RAISE EXCEPTION 'fn_auth_complete_email_outbox_delivery cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  IF p_provider_name IS NULL OR btrim(p_provider_name) = ''
     OR p_provider_message_id IS NULL OR btrim(p_provider_message_id) = '' THEN
    RAISE EXCEPTION 'Provider name and provider message ID are required to mark email SENT'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.auth_email_outbox o
     SET status = 'SENT',
         sent_at = NOW(),
         encrypted_action_token = NULL,
         provider_name = btrim(p_provider_name),
         provider_message_id = btrim(p_provider_message_id),
         last_error_code = NULL,
         last_error_redacted = NULL
   WHERE o.id = p_outbox_id
     AND o.status = 'PROCESSING';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_complete_email_outbox_delivery(UUID, VARCHAR, VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_complete_email_outbox_delivery(UUID, VARCHAR, VARCHAR) TO ft360_app;

-- 2E. Record delivery failure with bounded backoff or transition to DEAD_LETTER
CREATE OR REPLACE FUNCTION public.fn_auth_fail_email_outbox_delivery(
  p_outbox_id UUID,
  p_backoff_seconds INTEGER,
  p_error_code VARCHAR(64),
  p_error_redacted VARCHAR(512),
  p_force_dead_letter BOOLEAN DEFAULT FALSE
)
RETURNS VARCHAR(24)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_next_status VARCHAR(24);
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_fail_email_outbox_delivery cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.auth_email_outbox o
     SET status = CASE
           WHEN p_force_dead_letter OR o.attempt_count >= o.max_attempts OR o.token_expires_at <= NOW()
             THEN 'DEAD_LETTER'
           ELSE 'FAILED_RETRYABLE'
         END,
         encrypted_action_token = CASE
           WHEN p_force_dead_letter OR o.attempt_count >= o.max_attempts OR o.token_expires_at <= NOW()
             THEN NULL
           ELSE o.encrypted_action_token
         END,
         next_attempt_at = NOW() + make_interval(secs => GREATEST(1, COALESCE(p_backoff_seconds, 5))),
         last_error_code = COALESCE(NULLIF(btrim(p_error_code), ''), 'DELIVERY_FAILED'),
         last_error_redacted = LEFT(COALESCE(NULLIF(btrim(p_error_redacted), ''), 'Provider delivery failed.'), 512)
   WHERE o.id = p_outbox_id
   RETURNING o.status INTO v_next_status;

  RETURN COALESCE(v_next_status, 'DEAD_LETTER');
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_fail_email_outbox_delivery(UUID, INTEGER, VARCHAR, VARCHAR, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_fail_email_outbox_delivery(UUID, INTEGER, VARCHAR, VARCHAR, BOOLEAN) TO ft360_app;

-- 2F. Read sanitized outbox status for testing & operational diagnostics (never returns ciphertext)
CREATE OR REPLACE FUNCTION public.fn_auth_get_email_outbox_status(
  p_outbox_id UUID
)
RETURNS TABLE (
  outbox_id UUID,
  kind VARCHAR(32),
  user_id UUID,
  recipient_email TEXT,
  status VARCHAR(24),
  attempt_count INTEGER,
  max_attempts INTEGER,
  next_attempt_at TIMESTAMPTZ,
  provider_name VARCHAR(64),
  provider_message_id VARCHAR(255),
  last_error_code VARCHAR(64),
  last_error_redacted VARCHAR(512),
  has_ciphertext BOOLEAN,
  sent_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_get_email_outbox_status cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    o.id,
    o.kind,
    o.user_id,
    o.recipient_email::text,
    o.status,
    o.attempt_count,
    o.max_attempts,
    o.next_attempt_at,
    o.provider_name,
    o.provider_message_id,
    o.last_error_code,
    o.last_error_redacted,
    (o.encrypted_action_token IS NOT NULL),
    o.sent_at
  FROM public.auth_email_outbox o
  WHERE o.id = p_outbox_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_get_email_outbox_status(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_get_email_outbox_status(UUID) TO ft360_app;

-- -----------------------------------------------------------------------------
-- 3. CONTROLLED ONE-TIME PLATFORM SUPER ADMIN BOOTSTRAP FUNCTION
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_auth_bootstrap_initial_super_admin(
  p_email CITEXT,
  p_password_hash TEXT,
  p_full_name VARCHAR(160)
)
RETURNS TABLE (
  outcome VARCHAR(48),
  user_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_existing_admin_id UUID;
  v_conflict_user_id UUID;
  v_created public.users%ROWTYPE;
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL OR NOT public.app_is_super_admin() THEN
    RAISE EXCEPTION 'fn_auth_bootstrap_initial_super_admin requires an unscoped system bootstrap transaction'
      USING ERRCODE = '42501';
  END IF;

  IF p_password_hash IS NULL OR btrim(p_password_hash) = '' THEN
    RAISE EXCEPTION 'Password hash is required for initial Super Admin bootstrap'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize concurrent bootstrap attempts across cluster nodes
  PERFORM pg_advisory_xact_lock(360003);

  -- 1. Refuse bootstrap if ANY active Platform Super Admin already exists
  SELECT u.id
    INTO v_existing_admin_id
    FROM public.users u
   WHERE u.is_platform_super_admin = TRUE
     AND u.status = 'ACTIVE'
   ORDER BY u.created_at ASC
   LIMIT 1;

  IF v_existing_admin_id IS NOT NULL THEN
    RETURN QUERY
    SELECT 'SUPER_ADMIN_ALREADY_EXISTS'::VARCHAR(48), v_existing_admin_id;
    RETURN;
  END IF;

  -- 2. Refuse unsafe email conflict: NEVER promote an existing account or overwrite its password
  SELECT u.id
    INTO v_conflict_user_id
    FROM public.users u
   WHERE u.email = btrim(p_email::text)::citext
   LIMIT 1;

  IF v_conflict_user_id IS NOT NULL THEN
    RETURN QUERY
    SELECT 'EMAIL_CONFLICT_EXISTING_USER'::VARCHAR(48), v_conflict_user_id;
    RETURN;
  END IF;

  -- 3. Create initial Platform Super Admin (strictly when 0 active Super Admins & 0 matching emails exist)
  INSERT INTO public.users (
    email,
    password_hash,
    full_name,
    status,
    is_platform_super_admin,
    email_verified
  )
  VALUES (
    btrim(p_email::text)::citext,
    p_password_hash,
    btrim(p_full_name),
    'ACTIVE',
    TRUE,
    TRUE
  )
  RETURNING * INTO v_created;

  RETURN QUERY
  SELECT 'CREATED'::VARCHAR(48), v_created.id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_bootstrap_initial_super_admin(CITEXT, TEXT, VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_bootstrap_initial_super_admin(CITEXT, TEXT, VARCHAR) TO ft360_app;

-- -----------------------------------------------------------------------------
-- 4. RECURSIVE JSONB SECRET KEY VALIDATION ON AUTH_AUDIT_LOGS
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_jsonb_has_forbidden_secret_key(
  p_data JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_type TEXT;
  v_key TEXT;
  v_val JSONB;
  v_elem JSONB;
  v_normalized_key TEXT;
BEGIN
  IF p_data IS NULL THEN
    RETURN FALSE;
  END IF;

  v_type := jsonb_typeof(p_data);

  IF v_type = 'object' THEN
    FOR v_key, v_val IN SELECT * FROM jsonb_each(p_data) LOOP
      v_normalized_key := regexp_replace(lower(v_key), '[\s_-]+', '', 'g');
      IF v_normalized_key = ANY (ARRAY[
        'password',
        'passwd',
        'pwd',
        'passwordhash',
        'newpassword',
        'oldpassword',
        'currentpassword',
        'accesstoken',
        'refreshtoken',
        'refreshtokenhash',
        'previousrefreshtokenhash',
        'csrfsecret',
        'csrfsecrethash',
        'csrftoken',
        'rawtoken',
        'token',
        'tokenhash',
        'verifytoken',
        'verificationtoken',
        'resettoken',
        'encryptedactiontoken',
        'actionurl',
        'secret',
        'clientsecret',
        'apikey',
        'privatekey',
        'authorization',
        'cookie',
        'setcookie'
      ]) THEN
        RETURN TRUE;
      END IF;

      IF public.fn_jsonb_has_forbidden_secret_key(v_val) THEN
        RETURN TRUE;
      END IF;
    END LOOP;
    RETURN FALSE;
  ELSIF v_type = 'array' THEN
    FOR v_elem IN SELECT * FROM jsonb_array_elements(p_data) LOOP
      IF public.fn_jsonb_has_forbidden_secret_key(v_elem) THEN
        RETURN TRUE;
      END IF;
    END LOOP;
    RETURN FALSE;
  END IF;

  RETURN FALSE;
END;
$$;

ALTER TABLE public.auth_audit_logs
  DROP CONSTRAINT chk_auth_audit_logs_no_secret_keys;

ALTER TABLE public.auth_audit_logs
  ADD CONSTRAINT chk_auth_audit_logs_no_secret_keys CHECK (
    NOT public.fn_jsonb_has_forbidden_secret_key(metadata)
  );

-- -----------------------------------------------------------------------------
-- 5. HARDENED SECURITY DEFINER AUTHENTICATION & AUDIT ROUTINES
-- -----------------------------------------------------------------------------

-- 5A. Create new authenticated session (requires authenticated user tx + records generation 1 history)
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
  v_current_uid UUID := public.app_current_user_id();
  v_user public.users%ROWTYPE;
  v_sess public.auth_sessions%ROWTYPE;
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL OR public.app_is_super_admin() THEN
    RAISE EXCEPTION 'fn_auth_create_session must execute inside a user-plane transaction'
      USING ERRCODE = '42501';
  END IF;

  IF v_current_uid IS NULL OR v_current_uid <> p_user_id THEN
    RAISE EXCEPTION 'fn_auth_create_session requires verified app.current_user_id matching p_user_id'
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

  UPDATE public.users u
     SET last_login_at = NOW()
   WHERE u.id = v_user.id;

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

  INSERT INTO public.auth_refresh_token_history (
    session_id,
    family_id,
    user_id,
    token_hash,
    generation,
    issued_at,
    consumed_at,
    replaced_by_token_hash
  )
  VALUES (
    v_sess.id,
    v_sess.family_id,
    v_sess.user_id,
    p_refresh_token_hash,
    1,
    v_sess.created_at,
    NULL,
    NULL
  );

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

-- 5B. Validate live session (requires verified user context matching session owner, or verified Super Admin)
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
DECLARE
  v_current_uid UUID := public.app_current_user_id();
  v_is_super BOOLEAN := public.app_is_super_admin();
  v_owner_uid UUID;
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_validate_session cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  IF v_current_uid IS NULL THEN
    RAISE EXCEPTION 'fn_auth_validate_session requires verified app.current_user_id context'
      USING ERRCODE = '42501';
  END IF;

  IF v_is_super THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.users admin_u
       WHERE admin_u.id = v_current_uid
         AND admin_u.is_platform_super_admin = TRUE
         AND admin_u.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'Platform Super Admin context could not be verified'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    SELECT s_chk.user_id
      INTO v_owner_uid
      FROM public.auth_sessions s_chk
     WHERE s_chk.id = p_session_id;

    IF v_owner_uid IS NOT NULL AND v_owner_uid <> v_current_uid THEN
      RAISE EXCEPTION 'Cross-user session validation is forbidden'
        USING ERRCODE = '42501';
    END IF;
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
  WHERE s.id = p_session_id
    AND (v_is_super OR s.user_id = v_current_uid);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_validate_session(UUID, CHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_validate_session(UUID, CHAR) TO ft360_app;

-- 5C. Single-use refresh rotation backed by full family generation history & row-lock concurrency protection
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
  v_hist public.auth_refresh_token_history%ROWTYPE;
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

  -- Locate token in full family generation history first
  SELECT *
    INTO v_hist
    FROM public.auth_refresh_token_history h
   WHERE h.token_hash = p_presented_refresh_hash;

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

  -- Serialize concurrent refresh attempts on the parent session row BEFORE re-reading history state
  SELECT *
    INTO v_sess
    FROM public.auth_sessions s
   WHERE s.id = v_hist.session_id
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

  -- Re-read locked history row so a racing concurrent refresh sees consumed_at set by the winner
  SELECT *
    INTO v_hist
    FROM public.auth_refresh_token_history h
   WHERE h.id = v_hist.id
   FOR UPDATE;

  -- Replay / theft detection across ANY previously consumed generation in the session family
  IF v_hist.consumed_at IS NOT NULL
     OR v_sess.refresh_token_hash <> p_presented_refresh_hash
     OR v_sess.revoked_reason = 'REPLAY_COMPROMISE' THEN
    WITH family_revoked AS (
      UPDATE public.auth_sessions fam_s
         SET revoked_at = COALESCE(fam_s.revoked_at, NOW()),
             revoked_reason = 'REPLAY_COMPROMISE'
       WHERE fam_s.family_id = v_sess.family_id
       RETURNING fam_s.id
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
    UPDATE public.auth_sessions s
       SET revoked_at = NOW(),
           revoked_reason = 'EXPIRED'
     WHERE s.id = v_sess.id;

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
    UPDATE public.auth_sessions s
       SET revoked_at = NOW(),
           revoked_reason = 'USER_INACTIVE'
     WHERE s.id = v_sess.id;

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

  -- Mark current generation consumed and record next generation atomically
  UPDATE public.auth_refresh_token_history h
     SET consumed_at = NOW(),
         replaced_by_token_hash = p_new_refresh_hash
   WHERE h.id = v_hist.id;

  INSERT INTO public.auth_refresh_token_history (
    session_id,
    family_id,
    user_id,
    token_hash,
    generation,
    issued_at,
    consumed_at,
    replaced_by_token_hash
  )
  VALUES (
    v_sess.id,
    v_sess.family_id,
    v_sess.user_id,
    p_new_refresh_hash,
    v_hist.generation + 1,
    NOW(),
    NULL,
    NULL
  );

  UPDATE public.auth_sessions s
     SET previous_refresh_token_hash = v_sess.refresh_token_hash,
         refresh_token_hash = p_new_refresh_hash,
         csrf_secret_hash = p_new_csrf_hash,
         active_tenant_id = v_next_tid,
         active_membership_id = v_next_mid,
         last_active_at = NOW(),
         idle_expires_at = LEAST(v_sess.expires_at, NOW() + make_interval(secs => p_idle_ttl_seconds)),
         ip_address = COALESCE(p_ip_address, v_sess.ip_address),
         user_agent = COALESCE(p_user_agent, v_sess.user_agent)
   WHERE s.id = v_sess.id
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

-- 5D. Bind or clear active organization (requires verified user context matching session owner)
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
  v_current_uid UUID := public.app_current_user_id();
  v_owner_uid UUID;
  v_sess public.auth_sessions%ROWTYPE;
  v_member RECORD;
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL OR public.app_is_super_admin() THEN
    RAISE EXCEPTION 'fn_auth_bind_session_organization must execute inside a user-plane transaction'
      USING ERRCODE = '42501';
  END IF;

  IF v_current_uid IS NULL OR v_current_uid <> p_user_id THEN
    RAISE EXCEPTION 'fn_auth_bind_session_organization requires verified app.current_user_id matching p_user_id'
      USING ERRCODE = '42501';
  END IF;

  SELECT s_chk.user_id
    INTO v_owner_uid
    FROM public.auth_sessions s_chk
   WHERE s_chk.id = p_session_id;

  IF v_owner_uid IS NOT NULL AND v_owner_uid <> v_current_uid THEN
    RAISE EXCEPTION 'Cross-user session organization binding is forbidden'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_sess
    FROM public.auth_sessions s
   WHERE s.id = p_session_id
     AND s.user_id = v_current_uid
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
    UPDATE public.auth_sessions s
       SET active_tenant_id = NULL,
           active_membership_id = NULL,
           last_active_at = NOW()
     WHERE s.id = v_sess.id;

    RETURN QUERY
    SELECT 'CLEARED'::VARCHAR(40), v_sess.id, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  SELECT *
    INTO v_member
    FROM public.fn_verify_tenant_membership(v_current_uid, p_target_tenant_id);

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

  UPDATE public.auth_sessions s
     SET active_tenant_id = p_target_tenant_id,
         active_membership_id = v_member.membership_id,
         last_active_at = NOW()
   WHERE s.id = v_sess.id;

  RETURN QUERY
  SELECT 'BOUND'::VARCHAR(40), v_sess.id, p_target_tenant_id, v_member.membership_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_bind_session_organization(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_bind_session_organization(UUID, UUID, UUID) TO ft360_app;

-- 5E. Revoke single session (self-service requires verified user context; cross-user requires verified Super Admin)
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
  v_current_uid UUID := public.app_current_user_id();
  v_is_super BOOLEAN := public.app_is_super_admin();
  v_owner_uid UUID;
  v_updated INTEGER;
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_revoke_session cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  IF v_current_uid IS NULL THEN
    RAISE EXCEPTION 'fn_auth_revoke_session requires verified app.current_user_id context'
      USING ERRCODE = '42501';
  END IF;

  IF v_is_super THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.users admin_u
       WHERE admin_u.id = v_current_uid
         AND admin_u.is_platform_super_admin = TRUE
         AND admin_u.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'Platform Super Admin authorization could not be verified'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    IF v_current_uid <> p_user_id THEN
      RAISE EXCEPTION 'Self-service session revocation requires app.current_user_id matching p_user_id'
        USING ERRCODE = '42501';
    END IF;

    SELECT s_chk.user_id
      INTO v_owner_uid
      FROM public.auth_sessions s_chk
     WHERE s_chk.id = p_session_id;

    IF v_owner_uid IS NOT NULL AND v_owner_uid <> v_current_uid THEN
      RAISE EXCEPTION 'Cannot revoke a session belonging to another user without Platform Super Admin authorization'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE public.auth_sessions s
     SET revoked_at = COALESCE(s.revoked_at, NOW()),
         revoked_reason = COALESCE(s.revoked_reason, btrim(p_reason))
   WHERE s.id = p_session_id
     AND s.user_id = p_user_id
     AND s.revoked_at IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_revoke_session(UUID, UUID, VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_revoke_session(UUID, UUID, VARCHAR) TO ft360_app;

-- 5F. Revoke all active user sessions (self-service requires verified user context; cross-user requires verified Super Admin)
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
  v_current_uid UUID := public.app_current_user_id();
  v_is_super BOOLEAN := public.app_is_super_admin();
  v_ids UUID[];
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_revoke_all_user_sessions cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  IF v_current_uid IS NULL THEN
    RAISE EXCEPTION 'fn_auth_revoke_all_user_sessions requires verified app.current_user_id context'
      USING ERRCODE = '42501';
  END IF;

  IF v_is_super THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.users admin_u
       WHERE admin_u.id = v_current_uid
         AND admin_u.is_platform_super_admin = TRUE
         AND admin_u.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'Platform Super Admin authorization could not be verified'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_current_uid <> p_user_id THEN
    RAISE EXCEPTION 'Cross-user bulk session revocation requires Platform Super Admin authorization'
      USING ERRCODE = '42501';
  END IF;

  WITH revoked AS (
    UPDATE public.auth_sessions s
       SET revoked_at = NOW(),
           revoked_reason = btrim(p_reason)
     WHERE s.user_id = p_user_id
       AND s.revoked_at IS NULL
     RETURNING s.id
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::UUID[])
    INTO v_ids
    FROM revoked;

  RETURN v_ids;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_auth_revoke_all_user_sessions(UUID, VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_auth_revoke_all_user_sessions(UUID, VARCHAR) TO ft360_app;

-- 5G. Plane-isolated, membership-verified append-only audit writer
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
  v_current_uid UUID := public.app_current_user_id();
  v_is_super BOOLEAN := public.app_is_super_admin();
  v_trimmed_event VARCHAR(64) := btrim(p_event_type);
  v_member RECORD;
  v_sess RECORD;
  v_audit_id UUID;
BEGIN
  IF v_trimmed_event IS NULL OR v_trimmed_event = '' THEN
    RAISE EXCEPTION 'Audit event_type is required'
      USING ERRCODE = '22023';
  END IF;

  -- 1. Plane isolation & caller verification
  IF v_is_super THEN
    IF v_current_tid IS NOT NULL THEN
      RAISE EXCEPTION 'Platform Super Admin transaction cannot carry a tenant context'
        USING ERRCODE = '42501';
    END IF;

    IF v_current_uid IS NULL THEN
      IF v_trimmed_event NOT IN ('AUTH_SUPER_ADMIN_BOOTSTRAPPED', 'AUTH_SUPER_ADMIN_BOOTSTRAP_REFUSED') THEN
        RAISE EXCEPTION 'Platform Super Admin audit events require verified actor user context'
          USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1
          FROM public.users admin_u
         WHERE admin_u.id = v_current_uid
           AND admin_u.is_platform_super_admin = TRUE
           AND admin_u.status = 'ACTIVE'
      ) THEN
        RAISE EXCEPTION 'Platform Super Admin status could not be verified in database'
          USING ERRCODE = '42501';
      END IF;

      IF p_actor_user_id IS NOT NULL AND p_actor_user_id <> v_current_uid THEN
        RAISE EXCEPTION 'Audit actor_user_id must match verified Platform Super Admin user'
          USING ERRCODE = '42501';
      END IF;
    END IF;

  ELSIF v_current_tid IS NOT NULL THEN
    -- Tenant-scoped operation: must strictly target v_current_tid with verified active membership
    IF v_trimmed_event LIKE 'PLATFORM_%' THEN
      RAISE EXCEPTION 'Platform control-plane audit events cannot be recorded from a tenant transaction'
        USING ERRCODE = '42501';
    END IF;

    IF p_tenant_id IS NULL OR p_tenant_id <> v_current_tid THEN
      RAISE EXCEPTION 'Tenant-scoped audit events must strictly match the active verified tenant context'
        USING ERRCODE = '42501';
    END IF;

    IF v_current_uid IS NULL THEN
      RAISE EXCEPTION 'Tenant-scoped audit events require verified app.current_user_id context'
        USING ERRCODE = '42501';
    END IF;

    IF p_actor_user_id IS NOT NULL AND p_actor_user_id <> v_current_uid THEN
      RAISE EXCEPTION 'Tenant-scoped audit actor_user_id must match app.current_user_id'
        USING ERRCODE = '42501';
    END IF;

    SELECT *
      INTO v_member
      FROM public.fn_verify_tenant_membership(v_current_uid, v_current_tid);

    IF NOT FOUND
       OR v_member.user_status <> 'ACTIVE'
       OR v_member.membership_status <> 'ACTIVE'
       OR v_member.tenant_status NOT IN ('ACTIVE', 'TRIAL') THEN
      RAISE EXCEPTION 'Actor does not hold an active verified membership in the target tenant'
        USING ERRCODE = '42501';
    END IF;

  ELSE
    -- Unscoped / user-plane operation: strictly forbidden from writing tenant or platform control-plane events
    IF p_tenant_id IS NOT NULL THEN
      RAISE EXCEPTION 'Unscoped non-platform operations cannot record tenant-scoped audit events'
        USING ERRCODE = '42501';
    END IF;

    IF v_trimmed_event LIKE 'PLATFORM_%' THEN
      RAISE EXCEPTION 'Platform control-plane audit events require an independently verified Platform Super Admin transaction'
        USING ERRCODE = '42501';
    END IF;

    IF v_current_uid IS NOT NULL AND p_actor_user_id IS NOT NULL AND p_actor_user_id <> v_current_uid THEN
      RAISE EXCEPTION 'Audit actor_user_id must match app.current_user_id'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 2. Session-linked integrity: session must exist, belong to actor, and never claim an unrelated tenant
  IF p_session_id IS NOT NULL THEN
    SELECT s.user_id, s.active_tenant_id
      INTO v_sess
      FROM public.auth_sessions s
     WHERE s.id = p_session_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Referenced session_id does not exist'
        USING ERRCODE = '42501';
    END IF;

    IF p_actor_user_id IS NOT NULL AND v_sess.user_id <> p_actor_user_id THEN
      RAISE EXCEPTION 'Session-linked audit event actor_user_id does not match session owner'
        USING ERRCODE = '42501';
    END IF;

    IF p_tenant_id IS NOT NULL AND NOT v_is_super AND v_sess.active_tenant_id IS DISTINCT FROM p_tenant_id THEN
      RAISE EXCEPTION 'Session-linked audit event cannot claim an unrelated tenant'
        USING ERRCODE = '42501';
    END IF;
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
    v_trimmed_event,
    btrim(p_outcome),
    COALESCE(p_actor_user_id, v_current_uid),
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
