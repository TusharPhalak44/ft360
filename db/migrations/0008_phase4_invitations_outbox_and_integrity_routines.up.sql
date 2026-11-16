-- =============================================================================
-- Migration: 0008_phase4_invitations_outbox_and_integrity_routines (UP)
-- Owner Role: ft360_migrator (ft360_app NEVER owns tables)
-- Purpose:
--   1. Table #7: `public.tenant_invitations` with `FORCE RLS`, composite FKs,
--      column-level `SELECT` omitting `token_hash`, and strict initiator vs.
--      recipient identity check constraints.
--   2. Durable `public.auth_email_outbox` compatibility extension (`kind = 'TENANT_INVITATION'`,
--      `user_id IS NULL` + `initiated_by_user_id`, composite FK `(tenant_id, invitation_id)`,
--      and operational tenant lifecycle verification in `fn_auth_claim_email_outbox_*`).
--   3. Tenant administrator & concurrency protection triggers:
--        - `trigger_enforce_admin_membership_type()` (`INTERNAL`-only `tenant_admin`)
--        - `trigger_prevent_last_tenant_admin_removal()` (`SELECT ... FROM tenants FOR UPDATE`
--          parent-row serialization preventing concurrent last-admin removal)
--   4. Hardened `SECURITY DEFINER` integrity, concurrency & lifecycle routines:
--        - `fn_auth_register_user` (serialized duplicate global email race protection)
--        - `fn_tenant_enqueue_invitation_email_outbox`
--        - `fn_tenant_evict_member_sessions`
--        - `fn_tenant_transfer_primary_owner` (serialized `FOR UPDATE` ownership transfer & recovery)
--        - `fn_platform_transition_tenant_status` (6-state matrix + `OD-P1` + session unbinding)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. TABLE #7: PUBLIC.TENANT_INVITATIONS (Single-Use Cryptographic Invitations)
-- -----------------------------------------------------------------------------
CREATE TABLE public.tenant_invitations (
  id UUID NOT NULL DEFAULT uuidv7(),
  tenant_id UUID NOT NULL,
  invited_email CITEXT NOT NULL,
  membership_type VARCHAR(24) NOT NULL DEFAULT 'INTERNAL',
  target_role_id UUID NOT NULL,
  job_title VARCHAR(120) NULL,
  token_hash CHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  expires_at TIMESTAMPTZ NOT NULL,
  resend_count INTEGER NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invited_by_user_id UUID NULL,
  invited_by_membership_id UUID NULL,
  accepted_at TIMESTAMPTZ NULL,
  accepted_by_user_id UUID NULL,
  accepted_membership_id UUID NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoked_by_user_id UUID NULL,
  revoked_reason VARCHAR(500) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_tenant_invitations PRIMARY KEY (id),
  CONSTRAINT uq_ti_token_hash UNIQUE (token_hash),
  CONSTRAINT uq_ti_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT fk_ti_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_ti_target_role
    FOREIGN KEY (tenant_id, target_role_id)
    REFERENCES public.roles(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_ti_invited_by_user
    FOREIGN KEY (invited_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT fk_ti_invited_by_membership
    FOREIGN KEY (tenant_id, invited_by_membership_id)
    REFERENCES public.tenant_memberships(tenant_id, id)
    ON DELETE SET NULL (invited_by_membership_id),
  CONSTRAINT fk_ti_accepted_by_user
    FOREIGN KEY (accepted_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT fk_ti_accepted_membership
    FOREIGN KEY (tenant_id, accepted_membership_id)
    REFERENCES public.tenant_memberships(tenant_id, id)
    ON DELETE SET NULL (accepted_membership_id),
  CONSTRAINT fk_ti_revoked_by_user
    FOREIGN KEY (revoked_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT chk_ti_email_format CHECK (
    invited_email::text ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  ),
  CONSTRAINT chk_ti_email_canonical_trimmed CHECK (
    invited_email::text = lower(btrim(invited_email::text))
  ),
  CONSTRAINT chk_ti_membership_type CHECK (
    membership_type IN ('INTERNAL', 'CLIENT_PORTAL', 'PARTNER')
  ),
  CONSTRAINT chk_ti_status CHECK (
    status IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED')
  ),
  CONSTRAINT chk_ti_token_hash_hex CHECK (
    token_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_ti_resend_bounds CHECK (
    resend_count BETWEEN 0 AND 10
  ),
  CONSTRAINT chk_ti_expiry_order CHECK (
    expires_at > created_at
  ),
  -- Strict separation between initiator and recipient identity:
  -- 1. While PENDING, recipient user/membership columns MUST remain unbound (NULL).
  CONSTRAINT chk_ti_pending_recipient_unbound CHECK (
    status <> 'PENDING'
    OR (
      accepted_by_user_id IS NULL
      AND accepted_membership_id IS NULL
      AND accepted_at IS NULL
    )
  ),
  -- 2. When ACCEPTED, recipient user, membership, and timestamp MUST all be bound.
  CONSTRAINT chk_ti_accepted_integrity CHECK (
    status <> 'ACCEPTED'
    OR (
      accepted_by_user_id IS NOT NULL
      AND accepted_membership_id IS NOT NULL
      AND accepted_at IS NOT NULL
    )
  ),
  -- 3. Accepting recipient user can NEVER be the user who initiated the invitation.
  CONSTRAINT chk_ti_initiator_recipient_distinct CHECK (
    accepted_by_user_id IS NULL
    OR invited_by_user_id IS NULL
    OR accepted_by_user_id <> invited_by_user_id
  )
);

CREATE UNIQUE INDEX uq_ti_pending_tenant_email
  ON public.tenant_invitations (tenant_id, invited_email)
  WHERE status = 'PENDING';

CREATE INDEX idx_ti_tenant_status_created
  ON public.tenant_invitations (tenant_id, status, created_at DESC);

CREATE INDEX idx_ti_invited_email
  ON public.tenant_invitations (invited_email, status);

CREATE TRIGGER trg_tenant_invitations_updated_at
  BEFORE UPDATE ON public.tenant_invitations
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.tenant_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_invitations FORCE ROW LEVEL SECURITY;

CREATE POLICY migrator_all_tenant_invitations ON public.tenant_invitations
  FOR ALL
  TO ft360_migrator
  USING (true)
  WITH CHECK (true);

CREATE POLICY tenant_invitations_select ON public.tenant_invitations
  FOR SELECT
  TO ft360_app
  USING (
    tenant_id = public.app_current_tenant_id()
    OR public.app_is_super_admin()
  );

-- Column-level SELECT explicitly omits `token_hash` (ft360_app receives 42501 on token_hash)
GRANT SELECT (
  id,
  tenant_id,
  invited_email,
  membership_type,
  target_role_id,
  job_title,
  status,
  expires_at,
  resend_count,
  last_sent_at,
  invited_by_user_id,
  invited_by_membership_id,
  accepted_at,
  accepted_by_user_id,
  accepted_membership_id,
  revoked_at,
  revoked_by_user_id,
  revoked_reason,
  created_at,
  updated_at
) ON public.tenant_invitations TO ft360_app;

-- -----------------------------------------------------------------------------
-- 2. AUTH_EMAIL_OUTBOX EXTENSION FOR TENANT INVITATIONS (INITIATOR != RECIPIENT)
-- -----------------------------------------------------------------------------
ALTER TABLE public.auth_email_outbox
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.auth_email_outbox
  ADD COLUMN initiated_by_user_id UUID NULL,
  ADD COLUMN tenant_id UUID NULL,
  ADD COLUMN invitation_id UUID NULL;

ALTER TABLE public.auth_email_outbox
  DROP CONSTRAINT chk_auth_email_outbox_kind;

ALTER TABLE public.auth_email_outbox
  ADD CONSTRAINT fk_auth_email_outbox_initiated_by
    FOREIGN KEY (initiated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_auth_email_outbox_invitation
    FOREIGN KEY (tenant_id, invitation_id)
    REFERENCES public.tenant_invitations(tenant_id, id)
    ON DELETE CASCADE,
  ADD CONSTRAINT chk_auth_email_outbox_kind CHECK (
    kind IN ('EMAIL_VERIFICATION', 'PASSWORD_RESET', 'TENANT_INVITATION')
  ),
  -- Enforces that `user_id` strictly represents an auth recipient (never the initiating admin):
  -- For TENANT_INVITATION, `user_id` MUST be NULL and `(tenant_id, invitation_id)` MUST be populated.
  ADD CONSTRAINT chk_auth_email_outbox_anchor CHECK (
    (
      kind IN ('EMAIL_VERIFICATION', 'PASSWORD_RESET')
      AND user_id IS NOT NULL
      AND initiated_by_user_id IS NULL
      AND tenant_id IS NULL
      AND invitation_id IS NULL
    )
    OR (
      kind = 'TENANT_INVITATION'
      AND user_id IS NULL
      AND tenant_id IS NOT NULL
      AND invitation_id IS NOT NULL
    )
  );

CREATE INDEX idx_auth_email_outbox_invitation
  ON public.auth_email_outbox (tenant_id, invitation_id, created_at DESC)
  WHERE invitation_id IS NOT NULL;

GRANT SELECT (
  initiated_by_user_id,
  tenant_id,
  invitation_id
) ON public.auth_email_outbox TO ft360_app;

-- 2A. Tenant-scoped durable outbox enqueue for TENANT_INVITATION
CREATE OR REPLACE FUNCTION public.fn_tenant_enqueue_invitation_email_outbox(
  p_tenant_id UUID,
  p_invitation_id UUID,
  p_recipient_email CITEXT,
  p_recipient_display_name VARCHAR(160),
  p_encrypted_action_token TEXT,
  p_max_attempts INTEGER,
  p_correlation_id UUID
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
  v_inv public.tenant_invitations%ROWTYPE;
  v_member RECORD;
  v_outbox_id UUID;
BEGIN
  IF p_encrypted_action_token IS NULL OR btrim(p_encrypted_action_token) = '' THEN
    RAISE EXCEPTION 'Encrypted invitation action token payload is required'
      USING ERRCODE = '22023';
  END IF;

  IF p_correlation_id IS NULL THEN
    RAISE EXCEPTION 'Outbox correlation_id is required'
      USING ERRCODE = '22023';
  END IF;

  IF v_is_super THEN
    IF v_current_tid IS NOT NULL OR v_current_uid IS NULL THEN
      RAISE EXCEPTION 'Invalid Platform Super Admin context for invitation outbox enqueue'
        USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.users u
       WHERE u.id = v_current_uid
         AND u.is_platform_super_admin = TRUE
         AND u.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'Platform Super Admin status could not be verified'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    IF v_current_tid IS NULL OR v_current_tid <> p_tenant_id OR v_current_uid IS NULL THEN
      RAISE EXCEPTION 'fn_tenant_enqueue_invitation_email_outbox requires verified active tenant context'
        USING ERRCODE = '42501';
    END IF;

    SELECT *
      INTO v_member
      FROM public.fn_verify_tenant_membership(v_current_uid, v_current_tid);

    IF NOT FOUND
       OR v_member.user_status <> 'ACTIVE'
       OR v_member.membership_status <> 'ACTIVE'
       OR v_member.tenant_status NOT IN ('ACTIVE', 'TRIAL') THEN
      RAISE EXCEPTION 'Caller does not hold an active membership in an operational tenant'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  PERFORM public.fn_assert_tenant_operational(p_tenant_id);

  SELECT *
    INTO v_inv
    FROM public.tenant_invitations ti
   WHERE ti.tenant_id = p_tenant_id
     AND ti.id = p_invitation_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced tenant invitation does not exist'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_inv.status <> 'PENDING' OR v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Cannot enqueue email outbox for non-pending or expired invitation'
      USING ERRCODE = '22023';
  END IF;

  IF lower(btrim(p_recipient_email::text)) <> lower(btrim(v_inv.invited_email::text)) THEN
    RAISE EXCEPTION 'Outbox recipient_email must match tenant_invitations.invited_email'
      USING ERRCODE = '42501';
  END IF;

  IF v_inv.invited_by_user_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
        FROM public.users inv_u
       WHERE inv_u.id = v_inv.invited_by_user_id
         AND lower(btrim(inv_u.email::text)) = lower(btrim(v_inv.invited_email::text))
    ) THEN
      RAISE EXCEPTION 'CANNOT_INVITE_SELF: invitation recipient email cannot match initiating user'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Supersede any prior unsent outbox entries for this exact invitation (wiping old ciphertext)
  UPDATE public.auth_email_outbox o
     SET status = 'EXPIRED',
         encrypted_action_token = NULL,
         last_error_code = 'SUPERSEDED_BY_NEWER_INVITATION_TOKEN',
         last_error_redacted = 'Prior invitation outbox item superseded by token rotation.'
   WHERE o.tenant_id = p_tenant_id
     AND o.invitation_id = p_invitation_id
     AND o.status IN ('PENDING', 'FAILED_RETRYABLE');

  INSERT INTO public.auth_email_outbox (
    kind,
    user_id,
    initiated_by_user_id,
    tenant_id,
    invitation_id,
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
    'TENANT_INVITATION',
    NULL,
    v_current_uid,
    p_tenant_id,
    p_invitation_id,
    lower(btrim(v_inv.invited_email::text))::citext,
    COALESCE(NULLIF(btrim(COALESCE(p_recipient_display_name, '')), ''), lower(btrim(v_inv.invited_email::text))),
    btrim(p_encrypted_action_token),
    v_inv.expires_at,
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

REVOKE ALL ON FUNCTION public.fn_tenant_enqueue_invitation_email_outbox(
  UUID, UUID, CITEXT, VARCHAR, TEXT, INTEGER, UUID
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_tenant_enqueue_invitation_email_outbox(
  UUID, UUID, CITEXT, VARCHAR, TEXT, INTEGER, UUID
) TO ft360_app;

-- 2B. Update outbox claim routines to enforce live PostgreSQL tenant & invitation lifecycle status
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
  v_tenant_status VARCHAR(24);
  v_inv_status VARCHAR(24);
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
           last_error_redacted = 'Underlying verification, reset, or invitation token expired prior to delivery.'
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

  -- PostgreSQL lifecycle validation for TENANT_INVITATION outbox items
  IF v_row.kind = 'TENANT_INVITATION' THEN
    SELECT t.status
      INTO v_tenant_status
      FROM public.tenants t
     WHERE t.id = v_row.tenant_id;

    SELECT ti.status
      INTO v_inv_status
      FROM public.tenant_invitations ti
     WHERE ti.tenant_id = v_row.tenant_id
       AND ti.id = v_row.invitation_id;

    IF v_inv_status IS DISTINCT FROM 'PENDING' OR v_tenant_status = 'CANCELLED' THEN
      UPDATE public.auth_email_outbox o
         SET status = 'EXPIRED',
             encrypted_action_token = NULL,
             last_error_code = CASE
               WHEN v_tenant_status = 'CANCELLED' THEN 'TENANT_CANCELLED'
               ELSE 'INVITATION_NO_LONGER_PENDING'
             END,
             last_error_redacted = 'Invitation or tenant was cancelled/revoked prior to email dispatch.'
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

    -- Hold without releasing sealed token if tenant is SUSPENDED, DEACTIVATED, or PROVISIONING
    IF v_tenant_status IS NULL OR v_tenant_status NOT IN ('ACTIVE', 'TRIAL') THEN
      RETURN;
    END IF;
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

  -- Expire rows whose token TTL elapsed OR whose invitation/tenant was revoked/cancelled
  UPDATE public.auth_email_outbox o
     SET status = 'EXPIRED',
         encrypted_action_token = NULL,
         last_error_code = 'TOKEN_OR_INVITATION_EXPIRED_BEFORE_SEND',
         last_error_redacted = 'Underlying token expired or invitation/tenant was cancelled prior to delivery.'
   WHERE o.status IN ('PENDING', 'FAILED_RETRYABLE')
     AND (
       o.token_expires_at <= NOW()
       OR (
         o.kind = 'TENANT_INVITATION'
         AND NOT EXISTS (
           SELECT 1
             FROM public.tenant_invitations ti
             INNER JOIN public.tenants t ON t.id = ti.tenant_id
            WHERE ti.tenant_id = o.tenant_id
              AND ti.id = o.invitation_id
              AND ti.status = 'PENDING'
              AND t.status <> 'CANCELLED'
         )
       )
     );

  RETURN QUERY
  WITH candidate_ids AS (
    SELECT o.id
      FROM public.auth_email_outbox o
     WHERE o.status IN ('PENDING', 'FAILED_RETRYABLE')
       AND o.next_attempt_at <= NOW()
       AND o.token_expires_at > NOW()
       AND (
         o.kind <> 'TENANT_INVITATION'
         OR EXISTS (
           SELECT 1
             FROM public.tenants t
             INNER JOIN public.tenant_invitations ti
               ON ti.tenant_id = t.id AND ti.id = o.invitation_id
            WHERE t.id = o.tenant_id
              AND t.status IN ('ACTIVE', 'TRIAL')
              AND ti.status = 'PENDING'
         )
       )
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

-- -----------------------------------------------------------------------------
-- 3. TENANT ADMINISTRATOR INTEGRITY & CONCURRENCY TRIGGERS
-- -----------------------------------------------------------------------------

-- 3A. Enforce that only INTERNAL memberships can hold the `tenant_admin` system role
CREATE OR REPLACE FUNCTION public.trigger_enforce_admin_membership_type()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_is_admin_role BOOLEAN;
  v_member_type VARCHAR(24);
BEGIN
  IF TG_TABLE_NAME = 'user_role_assignments' THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.roles r
       WHERE r.tenant_id = NEW.tenant_id
         AND r.id = NEW.role_id
         AND r.slug = 'tenant_admin'::citext
    )
    INTO v_is_admin_role;

    IF v_is_admin_role THEN
      SELECT tm.membership_type
        INTO v_member_type
        FROM public.tenant_memberships tm
       WHERE tm.tenant_id = NEW.tenant_id
         AND tm.id = NEW.membership_id;

      -- Defer missing/cross-tenant `(tenant_id, membership_id)` pairs to composite FK `fk_ura_tenant_membership` (23503)
      IF NOT FOUND THEN
        RETURN NEW;
      END IF;

      IF v_member_type <> 'INTERNAL' THEN
        RAISE EXCEPTION 'INTERNAL_MEMBERSHIP_REQUIRED_FOR_ADMIN: external (%) memberships cannot hold tenant_admin', v_member_type
          USING ERRCODE = '42501';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'tenant_memberships' THEN
    IF NEW.membership_type <> 'INTERNAL' THEN
      IF EXISTS (
        SELECT 1
          FROM public.user_role_assignments ura
          INNER JOIN public.roles r
            ON r.tenant_id = ura.tenant_id AND r.id = ura.role_id
         WHERE ura.tenant_id = NEW.tenant_id
           AND ura.membership_id = NEW.id
           AND r.slug = 'tenant_admin'::citext
      ) THEN
        RAISE EXCEPTION 'INTERNAL_MEMBERSHIP_REQUIRED_FOR_ADMIN: cannot change a tenant_admin holder to %', NEW.membership_type
          USING ERRCODE = '42501';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_enforce_admin_membership_type() FROM PUBLIC;

CREATE TRIGGER trg_ura_enforce_admin_membership_type
  AFTER INSERT OR UPDATE ON public.user_role_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_enforce_admin_membership_type();

CREATE TRIGGER trg_tm_enforce_admin_membership_type
  AFTER UPDATE OF membership_type ON public.tenant_memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_enforce_admin_membership_type();

-- 3B. Serialized Last Active Administrator Anti-Lockout Trigger
-- Acquires `SELECT id, status FROM public.tenants WHERE id = v_tenant_id FOR UPDATE`
-- so concurrent READ COMMITTED admin demotions/suspensions across separate connections
-- serialize deterministically and can NEVER leave 0 active INTERNAL tenant_admin members
-- in an operational (`TRIAL` or `ACTIVE`) organization.
CREATE OR REPLACE FUNCTION public.trigger_prevent_last_tenant_admin_removal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant_id UUID := OLD.tenant_id;
  v_locked_tid UUID;
  v_tenant_status VARCHAR(24);
  v_affects_admin BOOLEAN := FALSE;
  v_remaining_admins BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'user_role_assignments' THEN
    IF TG_OP = 'UPDATE'
       AND NEW.tenant_id = OLD.tenant_id
       AND NEW.membership_id = OLD.membership_id
       AND NEW.role_id = OLD.role_id THEN
      RETURN NEW;
    END IF;

    SELECT EXISTS (
      SELECT 1
        FROM public.roles r
       WHERE r.tenant_id = OLD.tenant_id
         AND r.id = OLD.role_id
         AND r.slug = 'tenant_admin'::citext
    )
    INTO v_affects_admin;

  ELSIF TG_TABLE_NAME = 'tenant_memberships' THEN
    IF OLD.status <> 'ACTIVE' OR OLD.membership_type <> 'INTERNAL' THEN
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.status = 'ACTIVE' AND NEW.membership_type = 'INTERNAL' THEN
      RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
      -- Note: if membership was deleted, ON DELETE CASCADE may have already removed its
      -- user_role_assignments rows before this AFTER DELETE trigger fired; always lock & recount
      -- when an ACTIVE INTERNAL membership is deleted from an operational tenant that already had >=1 role!
      v_affects_admin := EXISTS (
        SELECT 1
          FROM public.roles r
         WHERE r.tenant_id = OLD.tenant_id
           AND r.slug = 'tenant_admin'::citext
      );
    ELSE
      SELECT EXISTS (
        SELECT 1
          FROM public.user_role_assignments ura
          INNER JOIN public.roles r
            ON r.tenant_id = ura.tenant_id AND r.id = ura.role_id
         WHERE ura.tenant_id = OLD.tenant_id
           AND ura.membership_id = OLD.id
           AND r.slug = 'tenant_admin'::citext
      )
      INTO v_affects_admin;
    END IF;
  END IF;

  IF NOT v_affects_admin THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- Serialize concurrent membership/role modifications on the parent tenant row!
  SELECT t.id, t.status
    INTO v_locked_tid, v_tenant_status
    FROM public.tenants t
   WHERE t.id = v_tenant_id
   FOR UPDATE;

  -- If parent tenant row itself is being deleted (migrator test cleanup cascade) or is non-operational, allow
  IF NOT FOUND OR v_tenant_status NOT IN ('TRIAL', 'ACTIVE') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  SELECT COUNT(*)
    INTO v_remaining_admins
    FROM public.user_role_assignments ura
    INNER JOIN public.roles r
      ON r.tenant_id = ura.tenant_id AND r.id = ura.role_id
    INNER JOIN public.tenant_memberships tm
      ON tm.tenant_id = ura.tenant_id AND tm.id = ura.membership_id
   WHERE ura.tenant_id = v_tenant_id
     AND r.slug = 'tenant_admin'::citext
     AND tm.status = 'ACTIVE'
     AND tm.membership_type = 'INTERNAL';

  IF v_remaining_admins < 1 THEN
    RAISE EXCEPTION 'LAST_TENANT_ADMIN_PROTECTED: operational tenant (%) must retain at least one active INTERNAL tenant_admin', v_tenant_id
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_prevent_last_tenant_admin_removal() FROM PUBLIC;

CREATE TRIGGER trg_ura_prevent_last_admin_removal
  AFTER UPDATE OR DELETE ON public.user_role_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_prevent_last_tenant_admin_removal();

CREATE TRIGGER trg_tm_prevent_last_admin_removal
  AFTER UPDATE OR DELETE ON public.tenant_memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_prevent_last_tenant_admin_removal();

-- -----------------------------------------------------------------------------
-- 4. CONCURRENCY-SERIALIZED GLOBAL EMAIL REGISTRATION & TENANT INTEGRITY ROUTINES
-- -----------------------------------------------------------------------------

-- 4A. Enhance `fn_auth_register_user` with transaction-scoped advisory lock on normalized email
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
  v_normalized_email TEXT;
  v_user public.users%ROWTYPE;
BEGIN
  IF public.app_current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'fn_auth_register_user cannot be invoked inside a tenant transaction'
      USING ERRCODE = '42501';
  END IF;

  IF p_email IS NULL OR btrim(p_email::text) = '' THEN
    RAISE EXCEPTION 'Email address is required for user registration'
      USING ERRCODE = '22023';
  END IF;

  IF p_password_hash IS NULL OR btrim(p_password_hash) = '' THEN
    RAISE EXCEPTION 'Password hash is required for user registration'
      USING ERRCODE = '22023';
  END IF;

  IF p_verify_ttl_seconds IS NULL OR p_verify_ttl_seconds < 60 THEN
    RAISE EXCEPTION 'Verification token TTL must be at least 60 seconds'
      USING ERRCODE = '22023';
  END IF;

  v_normalized_email := lower(btrim(p_email::text));

  -- Serialize concurrent global email registrations across `/auth/register` and invitation acceptance
  PERFORM pg_advisory_xact_lock(hashtext('global_user_email:' || v_normalized_email));

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
    v_normalized_email::citext,
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

-- 4B. Surgical Single-Tenant Membership Session Eviction (preserves sessions in other tenants)
CREATE OR REPLACE FUNCTION public.fn_tenant_evict_member_sessions(
  p_tenant_id UUID,
  p_membership_id UUID
)
RETURNS UUID[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_current_tid UUID := public.app_current_tenant_id();
  v_current_uid UUID := public.app_current_user_id();
  v_is_super BOOLEAN := public.app_is_super_admin();
  v_caller_member RECORD;
  v_evicted_ids UUID[];
BEGIN
  IF p_tenant_id IS NULL OR p_membership_id IS NULL THEN
    RAISE EXCEPTION 'p_tenant_id and p_membership_id are required'
      USING ERRCODE = '22023';
  END IF;

  IF v_is_super THEN
    IF v_current_tid IS NOT NULL OR v_current_uid IS NULL THEN
      RAISE EXCEPTION 'Invalid Platform Super Admin context for session eviction'
        USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.users u
       WHERE u.id = v_current_uid
         AND u.is_platform_super_admin = TRUE
         AND u.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'Platform Super Admin status could not be verified'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    IF v_current_tid IS NULL OR v_current_tid <> p_tenant_id OR v_current_uid IS NULL THEN
      RAISE EXCEPTION 'fn_tenant_evict_member_sessions requires verified active tenant context'
        USING ERRCODE = '42501';
    END IF;

    SELECT *
      INTO v_caller_member
      FROM public.fn_verify_tenant_membership(v_current_uid, v_current_tid);

    IF NOT FOUND
       OR v_caller_member.user_status <> 'ACTIVE'
       OR v_caller_member.membership_status <> 'ACTIVE'
       OR v_caller_member.tenant_status NOT IN ('ACTIVE', 'TRIAL') THEN
      RAISE EXCEPTION 'Caller does not hold an active verified membership in the target tenant'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  WITH evicted AS (
    UPDATE public.auth_sessions s
       SET active_tenant_id = NULL,
           active_membership_id = NULL
     WHERE s.active_tenant_id = p_tenant_id
       AND s.active_membership_id = p_membership_id
       AND s.revoked_at IS NULL
     RETURNING s.id
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::UUID[])
    INTO v_evicted_ids
    FROM evicted;

  RETURN v_evicted_ids;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_tenant_evict_member_sessions(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_tenant_evict_member_sessions(UUID, UUID) TO ft360_app;

-- 4C. Serialized Atomic Primary Ownership Transfer & Platform Break-Glass Owner Recovery
CREATE OR REPLACE FUNCTION public.fn_tenant_transfer_primary_owner(
  p_tenant_id UUID,
  p_target_membership_id UUID,
  p_reason VARCHAR(500),
  p_correlation_id UUID,
  p_ip_address INET DEFAULT NULL,
  p_user_agent VARCHAR(512) DEFAULT NULL
)
RETURNS TABLE (
  previous_owner_membership_id UUID,
  new_owner_membership_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_current_tid UUID := public.app_current_tenant_id();
  v_current_uid UUID := public.app_current_user_id();
  v_is_super BOOLEAN := public.app_is_super_admin();
  v_trimmed_reason VARCHAR(500) := btrim(COALESCE(p_reason, ''));
  v_tenant public.tenants%ROWTYPE;
  v_caller_member public.tenant_memberships%ROWTYPE;
  v_target_member public.tenant_memberships%ROWTYPE;
  v_prev_owner_id UUID;
  v_admin_role_id UUID;
  v_target_is_admin BOOLEAN;
BEGIN
  IF p_tenant_id IS NULL OR p_target_membership_id IS NULL OR p_correlation_id IS NULL THEN
    RAISE EXCEPTION 'p_tenant_id, p_target_membership_id, and p_correlation_id are required'
      USING ERRCODE = '22023';
  END IF;

  IF length(v_trimmed_reason) < 10 OR length(v_trimmed_reason) > 500 THEN
    RAISE EXCEPTION 'Ownership transfer reason must be between 10 and 500 characters'
      USING ERRCODE = '22023';
  END IF;

  IF v_is_super THEN
    IF v_current_tid IS NOT NULL OR v_current_uid IS NULL THEN
      RAISE EXCEPTION 'Platform break-glass owner recovery requires an unscoped Super Admin transaction'
        USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.users u
       WHERE u.id = v_current_uid
         AND u.is_platform_super_admin = TRUE
         AND u.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'Platform Super Admin status could not be verified'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    IF v_current_tid IS NULL OR v_current_tid <> p_tenant_id OR v_current_uid IS NULL THEN
      RAISE EXCEPTION 'Primary ownership transfer requires verified active tenant context'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Serialize concurrent ownership transfers and concurrent admin/membership mutations!
  SELECT *
    INTO v_tenant
    FROM public.tenants t
   WHERE t.id = p_tenant_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target tenant organization does not exist'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_tenant.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Cannot transfer ownership of a CANCELLED tenant'
      USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_super AND v_tenant.status NOT IN ('ACTIVE', 'TRIAL') THEN
    RAISE EXCEPTION 'TENANT_SUSPENDED_OR_INACTIVE: organization status is %', v_tenant.status
      USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_super THEN
    SELECT *
      INTO v_caller_member
      FROM public.tenant_memberships tm
     WHERE tm.tenant_id = p_tenant_id
       AND tm.user_id = v_current_uid
     FOR UPDATE;

    IF NOT FOUND
       OR v_caller_member.status <> 'ACTIVE'
       OR v_caller_member.membership_type <> 'INTERNAL'
       OR v_caller_member.is_primary_owner IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'PRIMARY_OWNER_REQUIRED: only the active Primary Owner may transfer ownership'
        USING ERRCODE = '42501';
    END IF;

    IF v_caller_member.id = p_target_membership_id THEN
      RAISE EXCEPTION 'Target membership is already the Primary Owner'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT *
    INTO v_target_member
    FROM public.tenant_memberships tm
   WHERE tm.tenant_id = p_tenant_id
     AND tm.id = p_target_membership_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_target_member.status <> 'ACTIVE'
     OR v_target_member.membership_type <> 'INTERNAL' THEN
    RAISE EXCEPTION 'TARGET_MUST_BE_ACTIVE_INTERNAL_MEMBER: target membership must be ACTIVE and INTERNAL'
      USING ERRCODE = '22023';
  END IF;

  SELECT r.id
    INTO v_admin_role_id
    FROM public.roles r
   WHERE r.tenant_id = p_tenant_id
     AND r.slug = 'tenant_admin'::citext;

  IF v_admin_role_id IS NULL THEN
    RAISE EXCEPTION 'System role tenant_admin does not exist for tenant %', p_tenant_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.user_role_assignments ura
     WHERE ura.tenant_id = p_tenant_id
       AND ura.membership_id = p_target_membership_id
       AND ura.role_id = v_admin_role_id
  )
  INTO v_target_is_admin;

  IF NOT v_target_is_admin THEN
    IF v_is_super THEN
      INSERT INTO public.user_role_assignments (tenant_id, membership_id, role_id)
      VALUES (p_tenant_id, p_target_membership_id, v_admin_role_id)
      ON CONFLICT (tenant_id, membership_id, role_id) DO NOTHING;
    ELSE
      RAISE EXCEPTION 'TARGET_MUST_BE_ACTIVE_INTERNAL_ADMIN: target member must hold tenant_admin before ownership transfer'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT tm.id
    INTO v_prev_owner_id
    FROM public.tenant_memberships tm
   WHERE tm.tenant_id = p_tenant_id
     AND tm.is_primary_owner = TRUE
   FOR UPDATE;

  -- Clear prior primary owner first, then set new primary owner under the parent `tenants FOR UPDATE` lock
  UPDATE public.tenant_memberships tm
     SET is_primary_owner = FALSE
   WHERE tm.tenant_id = p_tenant_id
     AND tm.is_primary_owner = TRUE;

  UPDATE public.tenant_memberships tm
     SET is_primary_owner = TRUE
   WHERE tm.tenant_id = p_tenant_id
     AND tm.id = p_target_membership_id;

  IF v_is_super THEN
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
      'PLATFORM_TENANT_OWNER_RECOVERED',
      'MEMBERSHIP',
      p_target_membership_id,
      'SUCCESS',
      'PLATFORM',
      v_current_uid,
      NULL,
      v_trimmed_reason,
      jsonb_build_object('primaryOwnerMembershipId', v_prev_owner_id),
      jsonb_build_object('primaryOwnerMembershipId', p_target_membership_id),
      jsonb_build_object('grantedAdminRoleDuringRecovery', NOT v_target_is_admin),
      p_correlation_id,
      p_ip_address,
      p_user_agent
    );

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
      'PLATFORM_TENANT_OWNER_RECOVERED',
      'SUCCESS',
      v_current_uid,
      v_target_member.user_id,
      p_tenant_id,
      NULL,
      p_correlation_id,
      p_ip_address,
      p_user_agent,
      jsonb_build_object(
        'previousOwnerMembershipId', v_prev_owner_id,
        'newOwnerMembershipId', p_target_membership_id,
        'reason', v_trimmed_reason
      )
    );
  ELSE
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
      'TENANT_PRIMARY_OWNER_TRANSFERRED',
      'MEMBERSHIP',
      p_target_membership_id,
      'SUCCESS',
      'TENANT',
      v_current_uid,
      v_caller_member.id,
      v_trimmed_reason,
      jsonb_build_object('primaryOwnerMembershipId', v_prev_owner_id),
      jsonb_build_object('primaryOwnerMembershipId', p_target_membership_id),
      jsonb_build_object('targetUserId', v_target_member.user_id),
      p_correlation_id,
      p_ip_address,
      p_user_agent
    );
  END IF;

  RETURN QUERY
  SELECT v_prev_owner_id, p_target_membership_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_tenant_transfer_primary_owner(
  UUID, UUID, VARCHAR, UUID, INET, VARCHAR
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_tenant_transfer_primary_owner(
  UUID, UUID, VARCHAR, UUID, INET, VARCHAR
) TO ft360_app;

-- 4D. Platform Lifecycle State-Machine Transition Routine (6 States + OD-P1 + Synchronous Session Unbinding)
CREATE OR REPLACE FUNCTION public.fn_platform_transition_tenant_status(
  p_tenant_id UUID,
  p_action VARCHAR(24),
  p_target_status VARCHAR(24),
  p_reason VARCHAR(500),
  p_correlation_id UUID,
  p_ip_address INET DEFAULT NULL,
  p_user_agent VARCHAR(512) DEFAULT NULL
)
RETURNS TABLE (
  tenant_id UUID,
  previous_status VARCHAR(24),
  current_status VARCHAR(24),
  evicted_session_ids UUID[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_current_tid UUID := public.app_current_tenant_id();
  v_current_uid UUID := public.app_current_user_id();
  v_is_super BOOLEAN := public.app_is_super_admin();
  v_action VARCHAR(24) := upper(btrim(COALESCE(p_action, '')));
  v_req_target VARCHAR(24) := NULLIF(upper(btrim(COALESCE(p_target_status, ''))), '');
  v_trimmed_reason VARCHAR(500) := btrim(COALESCE(p_reason, ''));
  v_tenant public.tenants%ROWTYPE;
  v_next_status VARCHAR(24);
  v_evicted UUID[] := ARRAY[]::UUID[];
BEGIN
  IF NOT v_is_super OR v_current_tid IS NOT NULL OR v_current_uid IS NULL THEN
    RAISE EXCEPTION 'fn_platform_transition_tenant_status requires an unscoped Platform Super Admin transaction'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.users u
     WHERE u.id = v_current_uid
       AND u.is_platform_super_admin = TRUE
       AND u.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Platform Super Admin status could not be verified'
      USING ERRCODE = '42501';
  END IF;

  IF p_tenant_id IS NULL OR p_correlation_id IS NULL THEN
    RAISE EXCEPTION 'p_tenant_id and p_correlation_id are required'
      USING ERRCODE = '22023';
  END IF;

  IF length(v_trimmed_reason) < 10 OR length(v_trimmed_reason) > 500 THEN
    RAISE EXCEPTION 'Lifecycle transition reason must be between 10 and 500 characters'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_tenant
    FROM public.tenants t
   WHERE t.id = p_tenant_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target tenant organization does not exist'
      USING ERRCODE = 'P0002';
  END IF;

  -- Evaluate complete 6-state matrix + confirmed OD-P1 (require SUSPENDED or DEACTIVATED before CANCELLED)
  IF v_tenant.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'INVALID_TENANT_STATUS_TRANSITION: CANCELLED is a terminal state'
      USING ERRCODE = '23514';
  ELSIF v_tenant.status = 'PROVISIONING' THEN
    IF v_action = 'ACTIVATE' AND COALESCE(v_req_target, 'ACTIVE') IN ('TRIAL', 'ACTIVE') THEN
      v_next_status := COALESCE(v_req_target, 'ACTIVE');
    ELSIF v_action = 'CANCEL' AND COALESCE(v_req_target, 'CANCELLED') = 'CANCELLED' THEN
      v_next_status := 'CANCELLED';
    ELSE
      RAISE EXCEPTION 'INVALID_TENANT_STATUS_TRANSITION: illegal transition from PROVISIONING via action %', v_action
        USING ERRCODE = '23514';
    END IF;
  ELSIF v_tenant.status = 'TRIAL' THEN
    IF v_action = 'ACTIVATE' AND COALESCE(v_req_target, 'ACTIVE') = 'ACTIVE' THEN
      v_next_status := 'ACTIVE';
    ELSIF v_action = 'SUSPEND' AND COALESCE(v_req_target, 'SUSPENDED') = 'SUSPENDED' THEN
      v_next_status := 'SUSPENDED';
    ELSIF v_action = 'DEACTIVATE' AND COALESCE(v_req_target, 'DEACTIVATED') = 'DEACTIVATED' THEN
      v_next_status := 'DEACTIVATED';
    ELSE
      RAISE EXCEPTION 'INVALID_TENANT_STATUS_TRANSITION: illegal transition from TRIAL via action % (OD-P1 requires SUSPENDED/DEACTIVATED before CANCELLED)', v_action
        USING ERRCODE = '23514';
    END IF;
  ELSIF v_tenant.status = 'ACTIVE' THEN
    IF v_action = 'SUSPEND' AND COALESCE(v_req_target, 'SUSPENDED') = 'SUSPENDED' THEN
      v_next_status := 'SUSPENDED';
    ELSIF v_action = 'DEACTIVATE' AND COALESCE(v_req_target, 'DEACTIVATED') = 'DEACTIVATED' THEN
      v_next_status := 'DEACTIVATED';
    ELSE
      RAISE EXCEPTION 'INVALID_TENANT_STATUS_TRANSITION: illegal transition from ACTIVE via action % (OD-P1 requires SUSPENDED/DEACTIVATED before CANCELLED)', v_action
        USING ERRCODE = '23514';
    END IF;
  ELSIF v_tenant.status = 'SUSPENDED' THEN
    IF v_action = 'REACTIVATE' THEN
      IF COALESCE(v_req_target, 'ACTIVE') = 'ACTIVE' THEN
        v_next_status := 'ACTIVE';
      ELSIF v_req_target = 'TRIAL' AND v_tenant.activated_at IS NULL THEN
        v_next_status := 'TRIAL';
      ELSE
        RAISE EXCEPTION 'INVALID_TENANT_STATUS_TRANSITION: previously activated tenant cannot reactivate to TRIAL'
          USING ERRCODE = '23514';
      END IF;
    ELSIF v_action = 'DEACTIVATE' AND COALESCE(v_req_target, 'DEACTIVATED') = 'DEACTIVATED' THEN
      v_next_status := 'DEACTIVATED';
    ELSIF v_action = 'CANCEL' AND COALESCE(v_req_target, 'CANCELLED') = 'CANCELLED' THEN
      v_next_status := 'CANCELLED';
    ELSE
      RAISE EXCEPTION 'INVALID_TENANT_STATUS_TRANSITION: illegal transition from SUSPENDED via action %', v_action
        USING ERRCODE = '23514';
    END IF;
  ELSIF v_tenant.status = 'DEACTIVATED' THEN
    IF v_action = 'REACTIVATE' AND COALESCE(v_req_target, 'ACTIVE') = 'ACTIVE' THEN
      v_next_status := 'ACTIVE';
    ELSIF v_action = 'CANCEL' AND COALESCE(v_req_target, 'CANCELLED') = 'CANCELLED' THEN
      v_next_status := 'CANCELLED';
    ELSE
      RAISE EXCEPTION 'INVALID_TENANT_STATUS_TRANSITION: illegal transition from DEACTIVATED via action %', v_action
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'INVALID_TENANT_STATUS_TRANSITION: unrecognized current status %', v_tenant.status
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.tenants t
     SET status = v_next_status,
         status_reason = v_trimmed_reason,
         activated_at = CASE
           WHEN v_next_status = 'ACTIVE' THEN COALESCE(t.activated_at, NOW())
           ELSE t.activated_at
         END,
         suspended_at = CASE
           WHEN v_next_status = 'SUSPENDED' THEN NOW()
           WHEN v_next_status IN ('ACTIVE', 'TRIAL') THEN NULL
           ELSE t.suspended_at
         END,
         deactivated_at = CASE
           WHEN v_next_status = 'DEACTIVATED' THEN NOW()
           WHEN v_next_status = 'ACTIVE' THEN NULL
           ELSE t.deactivated_at
         END,
         cancelled_at = CASE
           WHEN v_next_status = 'CANCELLED' THEN NOW()
           ELSE t.cancelled_at
         END
   WHERE t.id = p_tenant_id;

  IF v_next_status IN ('SUSPENDED', 'DEACTIVATED', 'CANCELLED') THEN
    WITH evicted AS (
      UPDATE public.auth_sessions s
         SET active_tenant_id = NULL,
             active_membership_id = NULL
       WHERE s.active_tenant_id = p_tenant_id
         AND s.revoked_at IS NULL
       RETURNING s.id
    )
    SELECT COALESCE(array_agg(id), ARRAY[]::UUID[])
      INTO v_evicted
      FROM evicted;
  END IF;

  IF v_next_status = 'CANCELLED' THEN
    UPDATE public.tenant_invitations ti
       SET status = 'REVOKED',
           revoked_at = NOW(),
           revoked_by_user_id = v_current_uid,
           revoked_reason = 'TENANT_CANCELLED'
     WHERE ti.tenant_id = p_tenant_id
       AND ti.status = 'PENDING';

    UPDATE public.auth_email_outbox o
       SET status = 'EXPIRED',
           encrypted_action_token = NULL,
           last_error_code = 'TENANT_CANCELLED',
           last_error_redacted = 'Organization cancelled prior to invitation dispatch.'
     WHERE o.tenant_id = p_tenant_id
       AND o.status IN ('PENDING', 'FAILED_RETRYABLE');
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
    'PLATFORM_TENANT_STATUS_CHANGED',
    'TENANT',
    p_tenant_id,
    'SUCCESS',
    'PLATFORM',
    v_current_uid,
    NULL,
    v_trimmed_reason,
    jsonb_build_object('status', v_tenant.status),
    jsonb_build_object('status', v_next_status),
    jsonb_build_object(
      'action', v_action,
      'evictedSessionCount', COALESCE(array_length(v_evicted, 1), 0)
    ),
    p_correlation_id,
    p_ip_address,
    p_user_agent
  );

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
    'PLATFORM_TENANT_STATUS_CHANGED',
    'SUCCESS',
    v_current_uid,
    NULL,
    p_tenant_id,
    NULL,
    p_correlation_id,
    p_ip_address,
    p_user_agent,
    jsonb_build_object(
      'action', v_action,
      'previousStatus', v_tenant.status,
      'currentStatus', v_next_status,
      'reason', v_trimmed_reason,
      'evictedSessionCount', COALESCE(array_length(v_evicted, 1), 0)
    )
  );

  RETURN QUERY
  SELECT p_tenant_id, v_tenant.status, v_next_status, v_evicted;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_platform_transition_tenant_status(
  UUID, VARCHAR, VARCHAR, VARCHAR, UUID, INET, VARCHAR
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_platform_transition_tenant_status(
  UUID, VARCHAR, VARCHAR, VARCHAR, UUID, INET, VARCHAR
) TO ft360_app;
