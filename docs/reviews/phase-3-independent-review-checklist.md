# FunnelTrack360 — Phase 3 Independent Security & Code Review Checklist

| Metadata Field | Value |
|---|---|
| **Repository** | `TusharPhalak44/ft360` |
| **Pull Request** | [PR #3](https://github.com/TusharPhalak44/ft360/pull/3) (`OPEN` — **unmerged**) |
| **Source Branch -> Target Branch** | `feature/phase-3-authentication` -> `development` |
| **Remediation Implementation Commit** | `6bafd74a942e2f44121596d004d7cf594b373757` (builds on `e3342f1faf1db8b573baf886ec5d9e0ca73128b6`) |
| **Assigned Independent Reviewer** | `@NakshtraSulakhe` |
| **Automated CI Baseline** | **PASSED** ([Run #43468151035](https://github.com/TusharPhalak44/ft360/actions/runs/43468151035) — `18/18` steps green) |
| **Manual Independent Security Review Status** | **`NOT VERIFIED`** *(awaiting independent verification by `@NakshtraSulakhe`)* |
| **Phase 3 Governance Status** | **`READY_FOR_INDEPENDENT_REVIEW`** *(Phase 3 is **not** marked `COMPLETED`)* |

> [!IMPORTANT]
> **Audit Boundary — Automated CI vs. Manual Independent Review:**
> Passing automated unit (`45/45`), integration (`30/30`), and Playwright E2E (`2/2`) gates does **not** substitute for independent human code and SQL security review. Every item in Sections A–F below is initialized to **`NOT VERIFIED`** and must be independently evaluated (`PASS`, `FAIL`, or `NOT VERIFIED`) by `@NakshtraSulakhe` after inspecting the actual diffs and executing any supplemental checks.

---

## A. Authentication

### A.1 Registration and Email Verification
- **Review Requirement:** Self-service registration creates accounts in `PENDING` / `email_verified = FALSE` state without account-enumeration timing or payload leaks, issues CSPRNG SHA-256 single-use verification tokens, and activates the account only upon valid, unexpired token consumption.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/modules/auth/auth.service.ts` (`register` L67–L133, `verifyEmail` L135–L173, `resendVerification` L175–L225)
  - `apps/api/src/modules/auth/auth.repository.ts` (`registerPendingUser` L115–L161, `consumeEmailVerificationToken` L198–L219, `issueEmailVerificationToken` L221–L244)
  - `db/migrations/0005_authentication_sessions_tokens_and_audit.up.sql` (`public.email_verification_tokens` L185–L231, `public.fn_auth_register_user` L410–L501, `public.fn_auth_verify_email_token` L554–L616, `public.fn_auth_issue_email_verification_token` L619–L679)
- **Expected Security Behavior:**
  - Raw verification tokens (`32` CSPRNG bytes base64url) are never persisted in plaintext in `email_verification_tokens`; only `CHAR(64)` SHA-256 hex digests are stored.
  - Duplicate email registration and resend-verification requests return uniform responses or safe conflict handling without exposing existing password hashes or session state.
  - Issuing a new verification token invalidates prior unconsumed verification tokens for that user.
- **Evidence the Reviewer Should Inspect:**
  - Inspect SQL token consumption atomicity (`UPDATE ... WHERE token_hash = p_token_hash AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > NOW()`) in `fn_auth_verify_email_token`.
  - Inspect automated coverage in `apps/api/test/integration/phase3-auth-workflows.int-spec.ts` (`IT-P3-02`) and `apps/web/e2e/phase3-auth-flows.spec.ts`.
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Outbox delivery coupled via Remediation Area #1 (`auth_email_outbox`); Reviewer notes: `[ ]`

### A.2 Login and Logout
- **Review Requirement:** Login enforces verified-email and `ACTIVE` user status gates, constant-time Argon2id credential verification, brute-force lockout via Redis (`AuthRateLimitService`), `HttpOnly` cookie issuance, and clean single-session (`POST /auth/logout`) and global (`POST /auth/logout-all`) session termination.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/modules/auth/auth.service.ts` (`login` L227–L403, `logout` L570–L638, `logoutAll` L640–L672)
  - `apps/api/src/modules/auth/auth-rate-limit.service.ts` (`assertIpEndpointAllowed` L24–L57, `checkLoginLockout` L59–L79, `recordLoginFailure` L81–L112, `clearLoginFailures` L114–L142)
  - `db/migrations/0005_authentication_sessions_tokens_and_audit.up.sql` (`public.fn_auth_get_login_candidate` L504–L551)
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql` (`public.fn_auth_revoke_session` L1424–L1491, `public.fn_auth_revoke_all_user_sessions` L1494–L1551)
- **Expected Security Behavior:**
  - Non-existent emails still execute a dummy Argon2id verification (`verifyPasswordConstantTime`) to prevent timing-based user enumeration.
  - Unverified (`email_verified = FALSE`) or `SUSPENDED`/`ARCHIVED` accounts cannot establish a session.
  - Exceeding `AUTH_RATE_LIMIT_MAX_FAILURES` within `AUTH_RATE_LIMIT_WINDOW_SECONDS` locks out login attempts (`429 AUTH_ACCOUNT_LOCKED`) and records `AUTH_LOGIN_LOCKED`.
  - Logout revokes the PostgreSQL session row, tombstones the session ID in Redis, and clears `ft360_at`, `ft360_rt`, and `ft360_csrf` cookies.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `AuthService.login` and `AuthService.logout` in `apps/api/src/modules/auth/auth.service.ts`.
  - Inspect lockout and unverified-login negative tests in `apps/api/test/integration/phase3-auth-negative-security.int-spec.ts` (`SEC-P3-01`, `SEC-P3-07`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** User-plane logout audit isolation updated in Remediation Area #4; Reviewer notes: `[ ]`

### A.3 Password Hashing and Password Recovery
- **Review Requirement:** Passwords must be hashed exclusively with `argon2id` (`>= 64 MiB` memory cost in production config, strong complexity policy), and forgot/reset-password workflows must prevent account enumeration, enforce single-use short-lived reset tokens, and revoke all existing user sessions on password reset.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/modules/auth/password-hash.service.ts` (`hashPassword` L95–L110, `verifyPasswordConstantTime` L112–L134)
  - `apps/api/src/modules/auth/auth.service.ts` (`forgotPassword` L674–L724, `resetPassword` L726–L778)
  - `db/migrations/0005_authentication_sessions_tokens_and_audit.up.sql` (`public.password_reset_tokens` L234–L282, `public.fn_auth_issue_password_reset_token` L682–L741, `public.fn_auth_reset_password` L744–L824)
- **Expected Security Behavior:**
  - `POST /api/v1/auth/forgot-password` returns `202 Accepted` identically whether or not the email exists.
  - `fn_auth_reset_password` atomically consumes the single-use SHA-256 token hash, updates `users.password_hash`, revokes every active `auth_sessions` row for that user (`revoked_reason = 'PASSWORD_RESET'`), and returns revoked session IDs for immediate Redis tombstoning.
- **Evidence the Reviewer Should Inspect:**
  - Inspect Argon2id parameters in `apps/api/src/config/env.config.ts` and `password-hash.service.ts`.
  - Inspect atomic password update + session revocation in `fn_auth_reset_password` (`0005` L744–L824) and integration test `IT-P3-04` (`phase3-auth-workflows.int-spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Durable reset email delivery covered under Remediation Area #1; Reviewer notes: `[ ]`

### A.4 Session Creation, Expiration, and Revocation
- **Review Requirement:** Sessions must bind actor identity, refresh-token SHA-256 digest, CSRF secret SHA-256 digest, idle expiration (`idle_expires_at`), and absolute expiration (`expires_at`), with immediate revocation enforcement on user/admin revocation and password change.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/modules/auth/auth.service.ts` (`listOwnSessions` L829–L834, `revokeOwnSessionById` L836–L872)
  - `apps/api/src/modules/auth/auth.repository.ts` (`createSession` L294–L346, `validateSessionInDb` L348–L394, `revokeSession` L489–L512)
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql` (`public.fn_auth_create_session` L832–L941, `public.fn_auth_validate_session` L944–L1028, `public.fn_auth_revoke_session` L1424–L1491)
- **Expected Security Behavior:**
  - Expired (`expires_at <= NOW()` or `idle_expires_at <= NOW()`) or revoked (`revoked_at IS NOT NULL`) sessions fail validation immediately (`401 SESSION_EXPIRED` / `SESSION_REVOKED`).
  - Users can list and revoke only their own sessions; revoking another user's session ID fails closed.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `fn_auth_create_session` and `fn_auth_validate_session` in `0006_phase3_auth_security_remediation.up.sql` (L832–L1028).
  - Inspect idle/absolute expiry and revocation tests in `IT-P3-05` (`phase3-auth-workflows.int-spec.ts`) and `REM-P3-08` (`phase3-security-remediation.int-spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Caller GUC authorization hardened in Remediation Area #8 (`0006` L832–L1551); Reviewer notes: `[ ]`

---

## B. Session Security

### B.1 Refresh-Token Rotation
- **Review Requirement:** Every `POST /api/v1/auth/refresh` call must atomically replace the refresh-token hash, rotate the CSRF secret when configured, advance `idle_expires_at` without extending absolute `expires_at`, and issue fresh short-lived access + refresh cookies.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/modules/auth/auth.service.ts` (`refreshSession` L405–L568)
  - `apps/api/src/modules/auth/auth.repository.ts` (`rotateRefreshSession` L396–L456)
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql` (`public.fn_auth_rotate_refresh_session` L1031–L1308)
- **Expected Security Behavior:**
  - Refresh tokens are opaque high-entropy random values (`32` bytes base64url); only SHA-256 hex digests touch PostgreSQL.
  - Refreshing a session preserves verified `active_tenant_id` / `active_membership_id` only if the tenant and membership are still active; otherwise tenant binding is cleared safely.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `fn_auth_rotate_refresh_session` (`0006` L1031–L1308) and `AuthService.refreshSession` (`auth.service.ts` L405–L568).
  - Inspect integration test `IT-P3-03` (`phase3-auth-workflows.int-spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Enhanced in Remediation Area #6; Reviewer notes: `[ ]`

### B.2 Multi-Generation Replay Detection
- **Review Requirement:** Replaying **any** retired refresh token from **any** earlier rotation generation (`RT1` after `RT1 -> RT2 -> RT3`, not merely the single previous token `RT2`) must be detected as token replay and immediately revoke the entire session `family_id`.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql` (`public.auth_refresh_token_history` L25–L130, `public.fn_auth_rotate_refresh_session` L1031–L1308)
  - `apps/api/src/modules/auth/auth.service.ts` (`refreshSession` L440–L505)
- **Expected Security Behavior:**
  - Every consumed refresh-token digest is recorded in `public.auth_refresh_token_history` with `(session_id, family_id, token_hash, replaced_by_token_hash, rotated_at)`.
  - Presenting `RT1` after `RT1 -> RT2 -> RT3` matches `auth_refresh_token_history`, sets `status = 'REPLAY_DETECTED'`, updates all sessions in `family_id` with `revoked_at = NOW()` and `revoked_reason = 'REPLAY_COMPROMISE'`, tombstones affected sessions in Redis, and emits `AUTH_REFRESH_REPLAY_DETECTED`.
  - Subsequent use of `RT3` fails with `401`.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `auth_refresh_token_history` DDL and replay-branch logic inside `fn_auth_rotate_refresh_session` (`0006` L25–L130, L1110–L1195).
  - Inspect integration test `REM-P3-06` (`apps/api/test/integration/phase3-security-remediation.int-spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Remediation Area #6 (`0006_phase3_auth_security_remediation.up.sql`); Reviewer notes: `[ ]`

### B.3 Concurrent Refresh Requests
- **Review Requirement:** Concurrent refresh requests presenting the same refresh token `RT1` must serialize cleanly at the database row level so at most one succeeds while the losing concurrent presentation triggers deterministic replay handling without race corruption.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql` (`public.fn_auth_rotate_refresh_session` L1070–L1240)
- **Expected Security Behavior:**
  - `fn_auth_rotate_refresh_session` acquires `FOR UPDATE` row locks on `public.auth_sessions` (both on active-match and history-match paths) before inspecting state or inserting into `auth_refresh_token_history`.
  - No duplicate history key violations (`uq_auth_refresh_token_history_hash`) or split-brain dual-active tokens can occur under `Promise.all` concurrent refresh calls.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `SELECT ... FROM public.auth_sessions ... FOR UPDATE` locking order in `fn_auth_rotate_refresh_session` (`0006` L1075–L1160).
  - Inspect concurrent `Promise.all` refresh race assertion in `REM-P3-06` (`phase3-security-remediation.int-spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Remediation Area #6; Reviewer notes: `[ ]`

### B.4 Redis Revocation and PostgreSQL Session Consistency
- **Review Requirement:** Redis session cache (`RedisSessionCacheService`) must accelerate active session lookups and instant revocation tombstones while failing safe to authoritative PostgreSQL validation (`fn_auth_validate_session`) whenever cache entries miss or Redis degrades.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/modules/auth/session-cache.service.ts` (`RedisSessionCacheService` L18–L82)
  - `apps/api/src/common/jwt-auth.guard.ts` (`JwtAuthGuard.canActivate` L33–L175)
  - `apps/api/src/modules/auth/auth.repository.ts` (`validateSessionInDb` L348–L394)
- **Expected Security Behavior:**
  - `JwtAuthGuard` checks Redis tombstones first (`isSessionTombstoned`), validates cached session metadata (`userId`, `csrfSecretHash`, `activeTenantId`, `activeMembershipId`, `expiresAt`, `idleExpiresAt`), and falls back to `validateSessionInDb` inside `withAuthenticatedUserTransaction` on cache miss or Redis error.
  - Redis never stores raw JWTs, raw refresh tokens, or raw CSRF tokens — only `csrfSecretHash` and structural session metadata.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `JwtAuthGuard.canActivate` (`jwt-auth.guard.ts` L55–L165) and `RedisSessionCacheService` (`session-cache.service.ts` L18–L82).
  - Inspect revocation propagation tests in `IT-P3-04`, `IT-P3-05`, and `SEC-P3-03`.
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** `validateSessionInDb` wrapped in `withAuthenticatedUserTransaction` under Remediation Area #8; Reviewer notes: `[ ]`

### B.5 CSRF and Login-CSRF Protection
- **Review Requirement:** All cookie-authenticated state-changing endpoints (`POST`/`PUT`/`PATCH`/`DELETE`) and pre-session `@Public()` authentication mutations (especially `POST /api/v1/auth/login`) must be protected globally against CSRF and Login-CSRF while preserving explicit non-browser API clients.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/app.module.ts` (`APP_GUARD` registration of `CsrfProtectionGuard`)
  - `apps/api/src/common/csrf-protection.guard.ts` (`CsrfProtectionGuard` L45–L281)
  - `apps/api/src/modules/auth/auth.controller.ts` (`GET /api/v1/auth/csrf` L53–L64)
  - `apps/web/src/lib/api/client.ts` (automatic browser pre-auth `/auth/csrf` handshake)
- **Expected Security Behavior:**
  - `CsrfProtectionGuard` runs globally as `APP_GUARD` across all controllers (current and future).
  - Rejects `Sec-Fetch-Site: cross-site` (`403`), `Origin: null`, empty `Origin`/`Referer`, malformed URLs, untrusted origins, and HTML form `Content-Type`s (`application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`).
  - Browser `POST /api/v1/auth/login` enforces trusted `Origin`/`Referer` + double-submit `ft360_csrf_pre` cookie & `X-CSRF-Token` constant-time match (`timingSafeEqual`).
  - Cookie-authenticated mutations verify `X-CSRF-Token` SHA-256 digest against the server-side session `csrfSecretHash` and `ft360_csrf` cookie.
  - Explicit `Authorization: Bearer` requests without session cookies and non-browser JSON API clients (no cookies, no `Origin`/`Referer`/`Sec-Fetch-*`) continue to operate cleanly.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `apps/api/src/common/csrf-protection.guard.ts` (L45–L281) and `apps/api/src/app.module.ts`.
  - Inspect `UT-P3-09` (`phase3-auth-and-guards.spec.ts`), `SEC-P3-02` (`phase3-auth-negative-security.int-spec.ts`), and `REM-P3-05` (`phase3-security-remediation.int-spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Remediation Area #5; Reviewer notes: `[ ]`

---

## C. Database Security

### C.1 Migration 0006 Forward & Rollback Integrity
- **Review Requirement:** Forward migration `0006_phase3_auth_security_remediation.up.sql` must apply cleanly over untouched `0001`–`0005` migrations, and `0006_phase3_auth_security_remediation.down.sql` must roll back cleanly to the exact `0005` schema state and re-apply idempotently.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql` (L1–L1722)
  - `db/migrations/0006_phase3_auth_security_remediation.down.sql` (L1–L630)
- **Expected Security Behavior:**
  - Zero edits to historical migrations `0001`–`0005`.
  - Clean `migrateUp` -> `rollbackLatest` -> `migrateUp` execution with all constraints, triggers, RLS policies, and function grants intact.
- **Evidence the Reviewer Should Inspect:**
  - Confirm `git diff development...feature/phase-3-authentication -- db/migrations/0001* db/migrations/0002* db/migrations/0003* db/migrations/0004*` is empty.
  - Inspect `0006` up/down SQL scripts and automated rollback/re-apply test in `IT-P3-01` (`phase3-auth-workflows.int-spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Forward Migration `0006`; Reviewer notes: `[ ]`

### C.2 `FORCE ROW LEVEL SECURITY` Across All Public Application Tables
- **Review Requirement:** Every public application table (`15/15`, excluding `schema_migrations`) must have both `relrowsecurity = TRUE` (`ENABLE ROW LEVEL SECURITY`) and `relforcerowsecurity = TRUE` (`FORCE ROW LEVEL SECURITY`) with fail-closed policies.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `db/migrations/0005_authentication_sessions_tokens_and_audit.up.sql` (`auth_sessions` L119–L120, `email_verification_tokens` L208–L209, `password_reset_tokens` L258–L259, `auth_audit_logs` L371–L372)
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql` (`auth_refresh_token_history` L63–L64, `auth_email_outbox` L185–L186)
- **Expected Security Behavior:**
  - Unscoped queries by `ft360_app` return `0` rows or raise `42501` across all tenant-scoped and internal token/outbox/history tables.
  - `email_verification_tokens`, `password_reset_tokens`, `auth_refresh_token_history`, and `auth_email_outbox` deny direct `INSERT`/`UPDATE`/`DELETE` to `ft360_app` and expose rows only to verified `app_is_super_admin()` or narrow `SECURITY DEFINER` routines.
- **Evidence the Reviewer Should Inspect:**
  - Inspect RLS policy definitions in `0005` and `0006`, plus `docs/database/04-rls-policies.md`.
  - Inspect catalog assertion in `IT-P3-01` (`phase3-auth-workflows.int-spec.ts` L168–L205).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Verified across all `15` tables in `IT-P3-01`; Reviewer notes: `[ ]`

### C.3 Application and Migrator Role Separation
- **Review Requirement:** DDL ownership and schema migrations must execute strictly under `ft360_migrator`, while NestJS runtime connections use `ft360_app` (`NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOBYPASSRLS`, owns `0` application tables).
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/database/database-pool.service.ts`
  - `db/migrations/0001_foundation_rls_helpers.up.sql`
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql`
- **Expected Security Behavior:**
  - Every table in `pg_tables` (`schemaname = 'public'`, excluding `schema_migrations`) has `tableowner = 'ft360_migrator'`.
  - `ft360_app` cannot bypass RLS, alter tables, or drop triggers/constraints.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `DatabasePoolService` startup role assertions and `IT-P3-01` (`tableowner === 'ft360_migrator'` across all `15` tables).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Preserved from Phase 2 & verified on `0005`/`0006` tables; Reviewer notes: `[ ]`

### C.4 `SECURITY DEFINER` Function Caller Authorization
- **Review Requirement:** Every `SECURITY DEFINER` function that mutates or inspects user sessions, bootstrap state, outbox items, or audit logs must verify caller authorization inside PostgreSQL (`app_current_user_id()`, `app_current_tenant_id()`, `app_is_super_admin()`) rather than trusting caller-supplied UUID arguments.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql`:
    - `fn_auth_enqueue_email_outbox` (L222–L330)
    - `fn_auth_bootstrap_initial_super_admin` (L653–L736)
    - `fn_auth_create_session` (L832–L939)
    - `fn_auth_validate_session` (L944–L1026)
    - `fn_auth_bind_session_organization` (L1311–L1419)
    - `fn_auth_revoke_session` (L1424–L1489)
    - `fn_auth_revoke_all_user_sessions` (L1494–L1549)
    - `fn_record_auth_audit_log` (L1554–L1719)
- **Expected Security Behavior:**
  - Calling `fn_auth_revoke_all_user_sessions(victim_id, ...)`, `fn_auth_revoke_session(session_id, victim_id, ...)`, `fn_auth_create_session(victim_id, ...)`, `fn_auth_validate_session(...)`, or `fn_auth_bind_session_organization(...)` without matching `app_current_user_id()` (or verified `app_is_super_admin()`) raises PostgreSQL `42501` (`insufficient_privilege`).
- **Evidence the Reviewer Should Inspect:**
  - Inspect explicit GUC caller checks at the top of each function in `0006_phase3_auth_security_remediation.up.sql`.
  - Inspect negative SQL authorization tests in `REM-P3-08` (`phase3-security-remediation.int-spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Remediation Area #8; Reviewer notes: `[ ]`

### C.5 Function Execution Grants and Hardened Search Paths
- **Review Requirement:** Every `SECURITY DEFINER` function must explicitly declare `SET search_path = pg_catalog, public, pg_temp`, `REVOKE ALL ON FUNCTION ... FROM PUBLIC`, and grant `EXECUTE` solely to `ft360_app`.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `db/migrations/0005_authentication_sessions_tokens_and_audit.up.sql` (L410–L1456)
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql` (L222–L1721)
- **Expected Security Behavior:**
  - `pg_proc.proconfig` contains `search_path=pg_catalog, public, pg_temp` for every `SECURITY DEFINER` routine, preventing object-shadowing attacks.
  - `has_function_privilege('public', oid, 'EXECUTE')` evaluates to `FALSE` for every `fn_auth_*` and `fn_record_auth_audit_log` routine.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `SET search_path` and `REVOKE ALL ... FROM PUBLIC` statements in `0005` and `0006`.
  - Inspect `pg_proc` catalog verification in `REM-P3-08` (`phase3-security-remediation.int-spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Remediation Area #8; Reviewer notes: `[ ]`

### C.6 Credential and Token Column Permissions
- **Review Requirement:** `ft360_app` must be denied direct `SELECT` access (`42501`) to password hashes, refresh-token hashes, CSRF secret hashes, verification/reset token hashes, and encrypted outbox tokens.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `db/migrations/0003_users_tenants_and_memberships.up.sql` (`users.password_hash` omitted from column `SELECT` grant)
  - `db/migrations/0005_authentication_sessions_tokens_and_audit.up.sql` (`auth_sessions` L159–L175, `email_verification_tokens` L222–L231, `password_reset_tokens` L272–L281)
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql` (`auth_refresh_token_history` L78–L87, `auth_email_outbox` L200–L218)
- **Expected Security Behavior:**
  - Direct queries from `ft360_app` on `users.password_hash`, `auth_sessions.refresh_token_hash`, `auth_sessions.previous_refresh_token_hash`, `auth_sessions.csrf_secret_hash`, `email_verification_tokens.token_hash`, `password_reset_tokens.token_hash`, `auth_refresh_token_history.token_hash`, `auth_refresh_token_history.replaced_by_token_hash`, and `auth_email_outbox.encrypted_action_token` immediately fail with `42501`.
- **Evidence the Reviewer Should Inspect:**
  - Inspect column-level `GRANT SELECT (...)` lists in `0003`, `0005`, and `0006`.
  - Inspect negative `SELECT` assertions in `IT-P3-01` (`phase3-auth-workflows.int-spec.ts` L212–L240) and `SEC-P3-08`.
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Extended to `auth_refresh_token_history` & `auth_email_outbox` in `0006`; Reviewer notes: `[ ]`

### C.7 Audit Immutability and Recursive Secret Validation
- **Review Requirement:** `public.auth_audit_logs` must be append-only (blocking `UPDATE`/`DELETE`), enforce strict tenant/actor/plane write isolation in `fn_record_auth_audit_log`, and recursively strip/reject forbidden secret keys across arbitrarily nested objects and arrays in both TypeScript and PostgreSQL.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/modules/auth/auth-audit.service.ts` (`isForbiddenAuditSecretKey` L44–L62, `sanitizeValue` L79–L109)
  - `db/migrations/0005_authentication_sessions_tokens_and_audit.up.sql` (`trigger_protect_auth_audit_immutability` L347–L369)
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql` (`fn_jsonb_has_forbidden_secret_key` + `chk_auth_audit_logs_no_secret_keys` L743–L827, `fn_record_auth_audit_log` L1554–L1721)
- **Expected Security Behavior:**
  - `UPDATE` and `DELETE` on `auth_audit_logs` raise `42501` via trigger.
  - `AuthAuditService` recursively replaces forbidden keys (`password`, `passwordHash`, `refreshToken`, `accessToken`, `csrfSecret`, `rawToken`, `token`, `actionUrl`, `encryptedActionToken`, `authorization`, `cookie`, `secret`, `apiKey`, `privateKey`) with `'[REDACTED]'` inside nested objects, arrays of objects, and nested arrays.
  - Bypassing TypeScript and inserting forbidden keys at any JSONB object/array depth fails in PostgreSQL with `23514` (`chk_auth_audit_logs_no_secret_keys`).
  - `fn_record_auth_audit_log` enforces all 5 tenant/actor/plane/session write rules (`42501`).
- **Evidence the Reviewer Should Inspect:**
  - Inspect `fn_jsonb_has_forbidden_secret_key` and `fn_record_auth_audit_log` in `0006` (L743–L827, L1554–L1721).
  - Inspect `UT-P3-09` (`phase3-auth-and-guards.spec.ts`), `REM-P3-04`, and `REM-P3-07` (`phase3-security-remediation.int-spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Remediation Areas #4 & #7; Reviewer notes: `[ ]`

---

## D. Multi-Tenant Authorization

### D.1 Organization Selection and Exit
- **Review Requirement:** `POST /api/v1/auth/select-organization` must independently verify active membership in an operational (`ACTIVE` or `TRIAL`) tenant before binding `(active_tenant_id, active_membership_id)` onto `auth_sessions` via composite FK `fk_auth_sessions_active_membership`, and `POST /api/v1/auth/exit-organization` must cleanly clear tenant context back to user-plane scope.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/modules/auth/auth.service.ts` (`selectOrganization` L874–L968, `exitOrganization` L970–L1017)
  - `db/migrations/0005_authentication_sessions_tokens_and_audit.up.sql` (`fk_auth_sessions_active_membership` L57–L65)
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql` (`fn_auth_bind_session_organization` L1311–L1421)
- **Expected Security Behavior:**
  - Selecting an organization where the user has no `ACTIVE` membership or where the tenant is `SUSPENDED`/`CANCELLED`/`PROVISIONING` is rejected (`403 TENANT_ACCESS_DENIED`).
  - Composite FK `FOREIGN KEY (active_tenant_id, active_membership_id) REFERENCES public.tenant_memberships (tenant_id, id)` makes cross-tenant session/membership mismatches structurally impossible in PostgreSQL.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `fn_auth_bind_session_organization` (`0006` L1311–L1421) and `AuthService.selectOrganization` (`auth.service.ts` L874–L968).
  - Inspect `IT-P3-06` (`phase3-auth-workflows.int-spec.ts`) and `SEC-P3-05` (`phase3-auth-negative-security.int-spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Caller GUC check added in Remediation Area #8; Reviewer notes: `[ ]`

### D.2 Membership Verification (`TenantMembershipGuard` & `UntrustedTenantInputGuard`)
- **Review Requirement:** Frontend-supplied `tenantId` / `organizationId` headers, query params, or body fields must never be trusted to establish tenant scope (`UntrustedTenantInputGuard`), and `TenantMembershipGuard` must re-verify live `ACTIVE` membership from the server-validated session before allowing tenant-plane access.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/common/untrusted-tenant-input.guard.ts` (`UntrustedTenantInputGuard` L41–L76)
  - `apps/api/src/common/tenant-membership.guard.ts` (`TenantMembershipGuard` L54–L124)
  - `db/migrations/0003_users_tenants_and_memberships.up.sql` (`fn_verify_active_tenant_membership`)
- **Expected Security Behavior:**
  - Unsolicited `x-tenant-id`, `tenantId`, or `organizationId` inputs on non-allowlisted endpoints are rejected (`400 UNTRUSTED_TENANT_INPUT_REJECTED`).
  - Even if a user previously selected an organization, suspending their membership or tenant immediately blocks subsequent requests in `TenantMembershipGuard` (`403`).
- **Evidence the Reviewer Should Inspect:**
  - Inspect `UntrustedTenantInputGuard` (`untrusted-tenant-input.guard.ts`) and `TenantMembershipGuard` (`tenant-membership.guard.ts`).
  - Inspect `SEC-P3-04` and `SEC-P3-05` (`phase3-auth-negative-security.int-spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Core Phase 3 multi-tenant invariant; Reviewer notes: `[ ]`

### D.3 Tenant Admin Authorization (`TenantAdminGuard`)
- **Review Requirement:** Tenant administrative endpoints (`/api/v1/workspace/admin/*`) must enforce verified tenant membership plus effective RBAC permissions inside a tenant-scoped transaction (`TenantAdminGuard` + `@RequirePermissions(...)`).
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/common/tenant-admin.guard.ts` (`TenantAdminGuard` L29–L102)
  - `apps/api/src/modules/workspace-boundary/workspace-boundary.controller.ts` (L94–L128)
- **Expected Security Behavior:**
  - Standard workspace members lacking administrative permission codes (`tenant:organization:manage`, `rbac:roles:manage`, `tenant:members:manage`, `audit:auth:read`) receive `403 TENANT_ADMIN_REQUIRED` or `INSUFFICIENT_PERMISSIONS`, with denial recorded in `auth_audit_logs`.
  - Being a Tenant Admin in Tenant Alpha grants **zero** admin authority when switched into Tenant Beta where the user is only a Standard Member.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `TenantAdminGuard.canActivate` (`tenant-admin.guard.ts` L37–L101).
  - Inspect multi-org role boundary switching in `IT-P3-06` (`phase3-auth-workflows.int-spec.ts` L439–L600).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Verified across Alpha/Beta role switch in `IT-P3-06`; Reviewer notes: `[ ]`

### D.4 Platform Super Admin Authorization (`PlatformSuperAdminGuard`)
- **Review Requirement:** Platform control-plane routes (`/api/v1/platform/*`) must independently re-verify live `users.is_platform_super_admin = TRUE AND status = 'ACTIVE'` in PostgreSQL (`PlatformSuperAdminGuard`) and reject Tenant Admins and standard users (`403`).
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/common/platform-super-admin.guard.ts` (`PlatformSuperAdminGuard` L23–L89)
  - `apps/api/src/modules/platform-boundary/platform-boundary.controller.ts` (L11–L74)
- **Expected Security Behavior:**
  - JWT claim `sa: true` alone is **never** sufficient; `PlatformSuperAdminGuard` queries PostgreSQL inside an authenticated user transaction and denies access (`403 PLATFORM_SUPER_ADMIN_REQUIRED`) if `is_platform_super_admin` is `FALSE` or the account is not `ACTIVE`.
  - Denied attempts record `AUTH_PLATFORM_BOUNDARY_DENIED` with user-plane `tenantId: null` (preserving active tenant context in `metadata`).
- **Evidence the Reviewer Should Inspect:**
  - Inspect `PlatformSuperAdminGuard` (`platform-super-admin.guard.ts` L29–L88).
  - Inspect `SEC-P3-06` (`phase3-auth-negative-security.int-spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Audit plane isolation aligned in Remediation Area #4; Reviewer notes: `[ ]`

### D.5 Cross-Tenant Access Rejection
- **Review Requirement:** Tenant A sessions must be completely unable to read, insert, update, delete, or write audit entries attributed to Tenant B across both HTTP endpoints and direct SQL queries under `ft360_app`.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `db/migrations/0005_authentication_sessions_tokens_and_audit.up.sql` (`p_auth_audit_logs_select` L375–L395)
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql` (`fn_record_auth_audit_log` L1554–L1721)
  - `apps/api/src/modules/workspace-boundary/workspace-boundary.controller.ts` (`listTenantAuthLogs` L94–L110)
- **Expected Security Behavior:**
  - `GET /api/v1/workspace/admin/auth-logs` in Tenant A returns strictly Tenant A's `auth_audit_logs` rows (`tenant_id = Tenant A`) and never exposes Tenant B logs or global platform logs.
  - Attempting to write an audit log for Tenant B from a Tenant A transaction or unscoped session raises `42501`.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `p_auth_audit_logs_select` (`0005` L375–L395) and `fn_record_auth_audit_log` (`0006` L1554–L1721).
  - Inspect `REM-P3-04` (`phase3-security-remediation.int-spec.ts`), `SEC-P3-05`, and Phase 2 10-case negative RLS suite (`phase2-rls-negative.int-spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Remediation Area #4; Reviewer notes: `[ ]`

### D.6 Tenant Transaction Context and Connection-Pool Isolation
- **Review Requirement:** All PostgreSQL session context GUCs (`app.current_tenant_id`, `app.current_user_id`, `app.current_membership_id`, `app.is_super_admin`, `app.correlation_id`) must use transaction-scoped `set_config(..., true)` (`SET LOCAL` semantics) inside `BEGIN ... COMMIT/ROLLBACK` blocks with mandatory pool eviction on dirty/failed rollback states.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/database/tenant-transaction.manager.ts` (`withVerifiedMemberTransaction`, `withAuthenticatedUserTransaction`, `withPlatformAdminTransaction`, `withSystemBootstrapTransaction` L16–L333)
- **Expected Security Behavior:**
  - Reused `pg.Pool` connections never retain previous `app.current_tenant_id`, `app.current_user_id`, or `app.is_super_admin` settings after `COMMIT` or `ROLLBACK`.
  - If `ROLLBACK` itself fails on a broken connection, `client.release(true)` destroys and evicts the socket from the pool.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `TenantTransactionManager` (`tenant-transaction.manager.ts` L16–L333).
  - Inspect connection-reuse negative tests in `apps/api/test/integration/phase2-rls-negative.int-spec.ts`.
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Preserved from Phase 2 & extended across Phase 3 auth transactions; Reviewer notes: `[ ]`

---

## E. Email and Recovery

### E.1 SMTP and Webhook Providers (`AuthMailProviderAdapter`)
- **Review Requirement:** Transactional authentication emails (verification & password reset) must dispatch through real configurable provider adapters (`smtp`, `webhook`, `sandbox` [dev/test only], `disabled` [default]) and must **never** report `delivered: true` unless an upstream provider actually accepts the message.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/modules/auth/auth-mail-provider.ts` (`DisabledAuthMailProvider` L65–L79, `SandboxAuthMailProvider` L81–L120, `HttpWebhookAuthMailProvider` L122–L202, `SmtpAuthMailProvider` L204–L511)
- **Expected Security Behavior:**
  - `AUTH_MAIL_PROVIDER=disabled` (default) throws retryable `MAIL_PROVIDER_NOT_CONFIGURED` (`delivered: false`) rather than fabricating delivery.
  - `SmtpAuthMailProvider` enforces CRLF header-injection sanitization, dot-stuffing, implicit TLS / `STARTTLS`, `AUTH PLAIN`, and socket timeouts.
  - `HttpWebhookAuthMailProvider` enforces `https://` in `production`, sends `X-Idempotency-Key` (`outboxId`) and `X-Correlation-Id`, and classifies `4xx` vs `5xx`/network retryability accurately.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `apps/api/src/modules/auth/auth-mail-provider.ts` (L65–L549).
  - Inspect `REM-P3-01` (`phase3-security-remediation.int-spec.ts`) and `UT-P3-07` (`phase3-auth-and-guards.spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Remediation Area #1; Reviewer notes: `[ ]`

### E.2 Encrypted Outbox Token Storage & Log Redaction
- **Review Requirement:** Durable outbox items in `public.auth_email_outbox` must seal action tokens with authenticated encryption (`AES-256-GCM` via HKDF-SHA256), wipe ciphertext once terminal (`SENT`, `DEAD_LETTER`, `EXPIRED`), keep BullMQ job payloads secret-free, and never log raw tokens or complete action URLs.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/modules/auth/auth-mail-outbox.service.ts` (`redactMailLogText` L64–L79, `enqueueDurableMail` L250–L317, `executeClaimedDelivery` L319–L418, `sealActionToken` / `openActionToken`)
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql` (`public.auth_email_outbox` L137–L219, `fn_auth_complete_email_outbox_delivery` L506–L547, `fn_auth_fail_email_outbox_delivery` L550–L592)
- **Expected Security Behavior:**
  - `auth_email_outbox.encrypted_action_token` stores `v1:<iv>:<authTag>:<ciphertext>` bound to AAD `outboxPurpose|recipientEmail`, is unreadable via direct `SELECT` by `ft360_app` (`42501`), and is overwritten with `NULL` upon `SENT`, `DEAD_LETTER`, or `EXPIRED`.
  - BullMQ jobs contain only `{ outboxId, correlationId }` (zero raw tokens or URLs in Redis queue storage).
  - `redactMailLogText` strips query token parameters and raw tokens from any error telemetry.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `AuthMailOutboxService` (`auth-mail-outbox.service.ts`) and `0006` outbox functions (L137–L592).
  - Inspect log-capture assertions in `REM-P3-01` (`phase3-security-remediation.int-spec.ts`) confirming zero raw tokens or action URLs appear in logs across success, retry, and failure paths.
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Remediation Area #1; Reviewer notes: `[ ]`

### E.3 Retry with Bounded Exponential Backoff and Dead-Letter Behavior
- **Review Requirement:** Transient mail provider failures must schedule bounded exponential backoff retries (`base * 2^(attempt-1)` capped at `AUTH_MAIL_MAX_BACKOFF_SECONDS`) up to `AUTH_MAIL_MAX_ATTEMPTS`, transitioning exhausted or permanently rejected messages to `DEAD_LETTER` while wiping `encrypted_action_token`.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/modules/auth/auth-mail-outbox.service.ts` (`executeClaimedDelivery` L319–L418)
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql` (`fn_auth_fail_email_outbox_delivery` L550–L592)
- **Expected Security Behavior:**
  - Transient `5xx`/network errors increment `attempt_count`, set `status = 'RETRY_SCHEDULED'`, compute bounded `next_attempt_at`, and re-schedule delivery.
  - Non-retryable `4xx` errors or exhausted `max_attempts` transition `status = 'DEAD_LETTER'` and set `encrypted_action_token = NULL`.
- **Evidence the Reviewer Should Inspect:**
  - Inspect backoff calculation in `AuthMailOutboxService.executeClaimedDelivery` (`auth-mail-outbox.service.ts` L360–L418).
  - Inspect provider failure -> retry -> recovery integration test in `REM-P3-01` (`phase3-security-remediation.int-spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Remediation Area #1; Reviewer notes: `[ ]`

### E.4 Queue Unavailable Recovery (`drainDueOutboxBatch`)
- **Review Requirement:** Temporary Redis/BullMQ unavailability during `register`, `resend-verification`, or `forgot-password` must **not** lose the transactional email or crash the user workflow once the PostgreSQL outbox row is committed.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/modules/auth/auth-mail-outbox.service.ts` (`enqueueDurableMail` L250–L317, `drainDueOutboxBatch` L195–L202)
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql` (`fn_auth_claim_email_outbox_batch` L429–L503)
- **Expected Security Behavior:**
  - Outbox record is persisted in PostgreSQL **before** `mailQueue.add(...)`.
  - If `mailQueue.add(...)` throws (e.g., Redis broker down), the error is caught safely (logging only `err.name`) and the background recovery poller (`drainDueOutboxBatch` using `FOR UPDATE SKIP LOCKED`) claims and delivers due `PENDING` / `RETRY_SCHEDULED` rows.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `enqueueDurableMail` and `drainDueOutboxBatch` in `auth-mail-outbox.service.ts` and `fn_auth_claim_email_outbox_batch` in `0006` (L429–L503).
  - Inspect simulated queue outage + `drainDueOutboxBatch` recovery test in `REM-P3-01` (`phase3-security-remediation.int-spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Remediation Area #1; Reviewer notes: `[ ]`

### E.5 Token Expiration and Single-Use Enforcement Across Outbox Lifecycle
- **Review Requirement:** Outbox retries and delayed deliveries must preserve the underlying verification/reset token `token_expires_at` deadline and single-use consumption semantics.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql` (`fn_auth_claim_email_outbox_by_id` L335–L426, `fn_auth_claim_email_outbox_batch` L429–L503)
  - `db/migrations/0005_authentication_sessions_tokens_and_audit.up.sql` (`fn_auth_verify_email_token` L554–L616, `fn_auth_reset_password` L744–L824)
- **Expected Security Behavior:**
  - If `token_expires_at <= NOW()` before an outbox item can be delivered, `fn_auth_claim_email_outbox_*` marks the outbox row `EXPIRED`, wipes `encrypted_action_token = NULL`, and suppresses stale email dispatch.
  - Once a verification or password-reset token is consumed, any replay of the same token fails (`400 INVALID_OR_EXPIRED_TOKEN`).
- **Evidence the Reviewer Should Inspect:**
  - Inspect expiry pruning in `fn_auth_claim_email_outbox_by_id` (`0006` L350–L380) and single-use tests in `IT-P3-02`, `IT-P3-04`, and `REM-P3-01`.
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Remediation Area #1; Reviewer notes: `[ ]`

### E.6 Development Outbox Restrictions (`AUTH_DEV_OUTBOX_ENABLED`)
- **Review Requirement:** Development outbox preview (`GET /api/v1/auth/dev-outbox`) must be **disabled by default** (`false`), forbidden at startup in `staging`, `preview`, `production`, or any `NODE_ENV` outside `development` and `test`, and restricted at runtime to loopback client IPs (`127.0.0.1` / `::1`).
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/config/env.config.ts` (`loadAppConfig` L290–L365)
  - `apps/api/src/modules/auth/auth.controller.ts` (`getDevOutboxPreview` + `LOOPBACK_CLIENT_IPS` L43, L205–L239)
  - `apps/api/src/modules/auth/auth-mail-outbox.service.ts` (`readLatestDevOutboxMessage` L208–L248)
- **Expected Security Behavior:**
  - `AUTH_DEV_OUTBOX_ENABLED` defaults to `false`.
  - Setting `AUTH_DEV_OUTBOX_ENABLED=true` in `NODE_ENV=staging`, `preview`, or `production` throws a fatal startup configuration error.
  - Even when explicitly enabled in `development`/`test`, requests from non-loopback IPs (e.g., `10.x.x.x` or `203.0.113.9`) receive `404 Not Found`.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `env.config.ts`, `auth.controller.ts`, and `auth-mail-outbox.service.ts`.
  - Inspect `UT-P3-07` (`phase3-auth-and-guards.spec.ts`) and `REM-P3-03` (`phase3-security-remediation.int-spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Remediation Area #3; Reviewer notes: `[ ]`

---

## F. Operational Security

### F.1 Environment Validation (`loadAppConfig`)
- **Review Requirement:** Application startup must fail closed on missing or unsafe environment variables across database roles, JWT secrets, outbox encryption secrets, mail transport settings (`smtp` / `webhook` / `sandbox`), cookie settings, and dev-outbox flags.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/config/env.config.ts` (`loadAppConfig` L196–L488)
  - `.env.example` (L1–L120)
- **Expected Security Behavior:**
  - Rejects `AUTH_MAIL_PROVIDER=sandbox` outside `development`/`test`.
  - Rejects `AUTH_MAIL_PROVIDER=webhook` with plain `http://` URLs in `production`.
  - Rejects `AUTH_MAIL_PROVIDER=smtp` when `AUTH_SMTP_HOST` is missing.
  - Rejects short (< `32` chars) `AUTH_OUTBOX_ENCRYPTION_SECRET` when supplied.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `loadAppConfig` in `apps/api/src/config/env.config.ts` and `.env.example`.
  - Inspect `UT-P3-07` and `UT-P3-08` (`phase3-auth-and-guards.spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Remediation Areas #1, #3, #9; Reviewer notes: `[ ]`

### F.2 Production Cookie Configuration (`COOKIE_SECURE` & `COOKIE_DOMAIN`)
- **Review Requirement:** In `NODE_ENV=production`, `Secure` cookies must be mandatory (`COOKIE_SECURE=false` rejected at startup), `HttpOnly` and `SameSite` must remain enforced on session cookies, and `COOKIE_DOMAIN` must reject malformed or unsafe domain strings.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/config/env.config.ts` (`validateCookieDomain` L116–L194, `loadAppConfig` L280–L310)
  - `apps/api/src/common/http-cookie.util.ts` (`AUTH_COOKIE_NAMES` L3–L16, `serializeSetCookie` L40–L74)
- **Expected Security Behavior:**
  - `NODE_ENV=production` + `COOKIE_SECURE=false` aborts startup immediately.
  - `validateCookieDomain` rejects schemes (`https://`), paths (`/`), ports (`:4000`), control characters, whitespace, IP literals (`127.0.0.1`, `[::1]`), `localhost`, and single-label public TLDs (`com`).
  - `ft360_at` and `ft360_rt` always carry `HttpOnly; SameSite=Lax` (plus `Secure` in production), with `ft360_rt` scoped to `Path=/api/v1/auth`.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `validateCookieDomain` (`env.config.ts` L116–L194) and `serializeSetCookie` (`http-cookie.util.ts` L40–L74).
  - Inspect `UT-P3-08` (`phase3-auth-and-guards.spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Remediation Area #9; Reviewer notes: `[ ]`

### F.3 JWT Signing Secret Management
- **Review Requirement:** Access JWT signing (`HS256` with explicit algorithm pinning, `iss`, `aud`, `jti`, `sid`, `sub`) must require a strong `>= 32`-character non-placeholder `AUTH_JWT_SECRET` in `production` and reject `alg: none` or algorithm confusion.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/config/env.config.ts` (`loadAppConfig` L250–L280)
  - `apps/api/src/modules/auth/token.service.ts` (`TokenService` L39–L277)
- **Expected Security Behavior:**
  - `NODE_ENV=production` rejects missing, `< 32`-character, or default placeholder `AUTH_JWT_SECRET` at startup.
  - `TokenService.verifyAccessToken` enforces `alg === 'HS256'`, constant-time HMAC-SHA256 verification, `iss`, `aud`, `exp`, and `nbf`.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `TokenService` (`token.service.ts` L39–L277) and `env.config.ts`.
  - Inspect JWT tampering/algorithm negative tests in `UT-P3-02` (`phase3-auth-and-guards.spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Core Phase 3 JWT hardening; Reviewer notes: `[ ]`

### F.4 Controlled One-Time Bootstrap Super Admin Procedure
- **Review Requirement:** Initial Platform Super Admin provisioning must be a controlled one-time CLI operation (`npm run auth:bootstrap-super-admin`); normal NestJS startup (`onApplicationBootstrap`) must **never** elevate an existing user, overwrite a password, activate an account, or mark an email verified.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/modules/auth/bootstrap-super-admin.service.ts` (`onApplicationBootstrap` L49–L60, `provisionInitialSuperAdmin` L62–L158)
  - `apps/api/src/modules/auth/bootstrap-super-admin.cli.ts` (L1–L44)
  - `db/migrations/0006_phase3_auth_security_remediation.up.sql` (`public.fn_auth_bootstrap_initial_super_admin` L653–L738)
  - `docs/operations/02-local-development-setup.md`
- **Expected Security Behavior:**
  - If `BOOTSTRAP_SUPER_ADMIN_*` variables remain set during normal `onApplicationBootstrap()`, `BootstrapSuperAdminService` logs a warning and performs **zero** database writes.
  - `fn_auth_bootstrap_initial_super_admin` acquires transaction advisory lock `360003` and refuses provisioning (`409 ConflictException` + `AUTH_SUPER_ADMIN_BOOTSTRAP_REFUSED` audit entry) if:
    1. Any `ACTIVE` Super Admin already exists (`SUPER_ADMIN_ALREADY_PROVISIONED`), **or**
    2. The email belongs to **any** existing user account (`BOOTSTRAP_EMAIL_CONFLICT` — never promotes or overwrites passwords).
- **Evidence the Reviewer Should Inspect:**
  - Inspect `BootstrapSuperAdminService` (`bootstrap-super-admin.service.ts`), `bootstrap-super-admin.cli.ts`, and `fn_auth_bootstrap_initial_super_admin` (`0006` L653–L738).
  - Inspect `REM-P3-02` (`phase3-security-remediation.int-spec.ts`) covering residual startup env vars, existing-email conflict rejection, one-time creation, and duplicate Super Admin rejection.
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Remediation Area #2; Reviewer notes: `[ ]`

### F.5 Error Handling and Audit Logging
- **Review Requirement:** Global exception handling (`GlobalExceptionFilter`) must return structured `{ error: { code, message, correlationId } }` responses without leaking stack traces, SQL table/constraint internals, password hashes, or session secrets, while security-relevant events are recorded consistently in `auth_audit_logs`.
- **Relevant Implementation File(s) / SQL Function(s):**
  - `apps/api/src/common/global-exception.filter.ts`
  - `apps/api/src/common/correlation-id.interceptor.ts`
  - `apps/api/src/modules/auth/auth-audit.service.ts`
- **Expected Security Behavior:**
  - No API response (`register`, `login`, `me`, `sessions`, `refresh`, `dev-outbox` disabled, error payloads) ever contains `passwordHash`, `refreshTokenHash`, `csrfSecretHash`, or raw PostgreSQL driver stack traces.
  - Every authentication lifecycle and boundary denial event includes request `correlationId` (`UUID`) for forensic traceability.
- **Evidence the Reviewer Should Inspect:**
  - Inspect `GlobalExceptionFilter` and `AuthAuditService`.
  - Inspect secret-non-exposure assertions in `SEC-P3-08` (`phase3-auth-negative-security.int-spec.ts`).
- **Reviewer Result:** `NOT VERIFIED` *(Select one: `PASS` | `FAIL` | `NOT VERIFIED`)*
- **Comments & Remediation References:** Verified across `SEC-P3-08` & `REM-P3-04`/`07`; Reviewer notes: `[ ]`

---

## G. Independent Reviewer Sign-Off (`@NakshtraSulakhe`)

> [!WARNING]
> **Mandatory Reviewer Protocol:**
> 1. Inspect the actual code and SQL migration diffs on [PR #3](https://github.com/TusharPhalak44/ft360/pull/3) (`development...feature/phase-3-authentication`).
> 2. Independently verify the security-critical implementation across Sections A–F above (do not rely solely on automated CI output).
> 3. Execute additional local or negative tests where necessary.
> 4. Record any findings, questions, or required fixes directly in GitHub [PR #3](https://github.com/TusharPhalak44/ft360/pull/3).
> 5. Submit an actual GitHub **`APPROVED`** or **`CHANGES_REQUESTED`** review under `@NakshtraSulakhe`'s GitHub account. *(No approval may be generated on behalf of the reviewer, and PR #3 must not be merged without explicit post-review authorization).*

| Sign-Off Field | Entry (To Be Completed by `@NakshtraSulakhe`) |
|---|---|
| **Reviewer GitHub Handle** | `@NakshtraSulakhe` |
| **Commit SHA Reviewed** | `[ ]` |
| **Checklist Items Verified (`34` total)** | `0 / 34` (`NOT VERIFIED`) |
| **GitHub Review Decision** | `PENDING` (`APPROVED` / `CHANGES_REQUESTED`) |
| **Review Timestamp (UTC)** | `[ ]` |
