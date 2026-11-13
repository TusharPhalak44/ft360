-- =============================================================================
-- Migration: 0005_authentication_sessions_tokens_and_audit (DOWN)
-- Owner Role: ft360_migrator
-- Purpose: Cleanly reverses Phase 3 authentication, session, token, and audit
--          schema objects back to the exact Phase 2 (0004) state.
-- =============================================================================

-- 1. Drop narrow SECURITY DEFINER authentication & session functions
DROP FUNCTION IF EXISTS public.fn_record_auth_audit_log(VARCHAR, VARCHAR, UUID, UUID, UUID, UUID, UUID, INET, VARCHAR, JSONB);
DROP FUNCTION IF EXISTS public.fn_auth_revoke_all_user_sessions(UUID, VARCHAR);
DROP FUNCTION IF EXISTS public.fn_auth_revoke_session_by_refresh_hash(CHAR, VARCHAR);
DROP FUNCTION IF EXISTS public.fn_auth_revoke_session(UUID, UUID, VARCHAR);
DROP FUNCTION IF EXISTS public.fn_auth_bind_session_organization(UUID, UUID, UUID);
DROP FUNCTION IF EXISTS public.fn_auth_rotate_refresh_session(CHAR, CHAR, CHAR, INTEGER, CHAR, BOOLEAN, INET, VARCHAR);
DROP FUNCTION IF EXISTS public.fn_auth_validate_session(UUID, CHAR);
DROP FUNCTION IF EXISTS public.fn_auth_create_session(UUID, CHAR, CHAR, INTEGER, INTEGER, INET, VARCHAR);
DROP FUNCTION IF EXISTS public.fn_auth_reset_password(CHAR, TEXT, INET);
DROP FUNCTION IF EXISTS public.fn_auth_issue_password_reset_token(CITEXT, CHAR, INTEGER, INET);
DROP FUNCTION IF EXISTS public.fn_auth_issue_email_verification_token(CITEXT, CHAR, INTEGER, INET);
DROP FUNCTION IF EXISTS public.fn_auth_verify_email_token(CHAR);
DROP FUNCTION IF EXISTS public.fn_auth_get_login_candidate(CITEXT);
DROP FUNCTION IF EXISTS public.fn_auth_register_user(CITEXT, TEXT, VARCHAR, VARCHAR, CHAR, INTEGER, INET);

-- 2. Drop Phase 3 tables in reverse FK dependency order
DROP TABLE IF EXISTS public.auth_audit_logs;
DROP FUNCTION IF EXISTS public.trigger_protect_auth_audit_immutability();

DROP TABLE IF EXISTS public.password_reset_tokens;
DROP TABLE IF EXISTS public.email_verification_tokens;

DROP TABLE IF EXISTS public.auth_sessions;
DROP FUNCTION IF EXISTS public.trigger_protect_auth_session_immutability();

-- 3. Remove Phase 3 seeded canonical permissions (and any role mappings referencing them)
DELETE FROM public.role_permissions
WHERE permission_id IN (
  SELECT id
  FROM public.permissions
  WHERE code IN (
    'platform:users:read',
    'platform:users:manage',
    'platform:audit:read',
    'auth:sessions:manage',
    'audit:auth:read'
  )
);

DELETE FROM public.permissions
WHERE code IN (
  'platform:users:read',
  'platform:users:manage',
  'platform:audit:read',
  'auth:sessions:manage',
  'audit:auth:read'
);
