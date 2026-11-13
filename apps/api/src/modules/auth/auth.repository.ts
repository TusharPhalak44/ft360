import { Injectable } from '@nestjs/common';
import type {
  ActiveUserTenantSummary,
  AuthAuditLogEntry,
  AuthAuditOutcome,
  AuthenticatedUserProfile,
  AuthSessionSummary,
  MembershipStatus,
  MembershipType,
  TenantStatus,
  UserStatus,
} from '@ft360/shared-types';
import { DatabasePoolService } from '../../database/database-pool.service';
import type { QueryExecutor } from '../../database/database.types';

export interface LoginCandidateRow {
  userId: string;
  email: string;
  fullName: string;
  phoneE164: string | null;
  passwordHash: string | null;
  status: UserStatus;
  isPlatformSuperAdmin: boolean;
  emailVerified: boolean;
  lastLoginAt: string | null;
}

export interface ValidatedSessionDbRecord {
  sessionId: string;
  familyId: string;
  userId: string;
  activeTenantId: string | null;
  activeMembershipId: string | null;
  idleExpiresAtEpochMs: number;
  expiresAtEpochMs: number;
  revokedAt: string | null;
  userStatus: UserStatus;
  userEmailVerified: boolean;
  isPlatformSuperAdmin: boolean;
  csrfValid: boolean;
}

export interface RefreshRotationDbResult {
  outcome:
  | 'NOT_FOUND'
  | 'REPLAY_DETECTED'
  | 'REVOKED'
  | 'EXPIRED'
  | 'CSRF_INVALID'
  | 'USER_INACTIVE'
  | 'ROTATED';
  sessionId: string | null;
  familyId: string | null;
  userId: string | null;
  activeTenantId: string | null;
  activeMembershipId: string | null;
  isPlatformSuperAdmin: boolean;
  idleExpiresAtEpochMs: number | null;
  expiresAtEpochMs: number | null;
  revokedFamilySessionIds: string[];
}

function toIso(val: Date | string | null): string | null {
  if (val === null || val === undefined) return null;
  return val instanceof Date ? val.toISOString() : String(val);
}

@Injectable()
export class AuthRepository {
  constructor(private readonly dbPool: DatabasePoolService) { }

  async registerPendingUser(input: {
    email: string;
    passwordHash: string;
    fullName: string;
    phoneE164?: string | null;
    verifyTokenHash: string;
    verifyTtlSeconds: number;
    requestedIp: string | null;
  }): Promise<AuthenticatedUserProfile> {
    const res = await this.dbPool.queryUnscoped<{
      user_id: string;
      email: string;
      full_name: string;
      phone_e164: string | null;
      status: UserStatus;
      is_platform_super_admin: boolean;
      email_verified: boolean;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `SELECT
         user_id, email, full_name, phone_e164, status,
         is_platform_super_admin, email_verified, created_at, updated_at
       FROM public.fn_auth_register_user($1::citext, $2, $3, $4, $5::char(64), $6, $7::inet)`,
      [
        input.email.trim().toLowerCase(),
        input.passwordHash,
        input.fullName.trim(),
        input.phoneE164 ?? null,
        input.verifyTokenHash,
        input.verifyTtlSeconds,
        input.requestedIp,
      ],
    );

    const row = res.rows[0];
    return {
      id: row.user_id,
      email: row.email,
      fullName: row.full_name,
      phoneE164: row.phone_e164,
      status: row.status,
      emailVerified: row.email_verified,
      isPlatformSuperAdmin: row.is_platform_super_admin,
      lastLoginAt: null,
    };
  }

  async findLoginCandidateByEmail(email: string): Promise<LoginCandidateRow | null> {
    const res = await this.dbPool.queryUnscoped<{
      user_id: string;
      email: string;
      full_name: string;
      phone_e164: string | null;
      password_hash: string | null;
      status: UserStatus;
      is_platform_super_admin: boolean;
      email_verified: boolean;
      last_login_at: Date | string | null;
    }>(
      `SELECT
         user_id, email, full_name, phone_e164, password_hash,
         status, is_platform_super_admin, email_verified, last_login_at
       FROM public.fn_auth_get_login_candidate($1::citext)`,
      [email.trim().toLowerCase()],
    );

    const row = res.rows[0];
    if (!row) return null;

    return {
      userId: row.user_id,
      email: row.email,
      fullName: row.full_name,
      phoneE164: row.phone_e164,
      passwordHash: row.password_hash,
      status: row.status,
      isPlatformSuperAdmin: row.is_platform_super_admin,
      emailVerified: row.email_verified,
      lastLoginAt: toIso(row.last_login_at),
    };
  }

  async consumeEmailVerificationToken(
    tokenHashHex: string,
  ): Promise<{ userId: string; email: string; status: UserStatus; emailVerified: boolean } | null> {
    const res = await this.dbPool.queryUnscoped<{
      user_id: string;
      email: string;
      status: UserStatus;
      email_verified: boolean;
    }>(
      `SELECT user_id, email, status, email_verified
       FROM public.fn_auth_verify_email_token($1::char(64))`,
      [tokenHashHex],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      email: row.email,
      status: row.status,
      emailVerified: row.email_verified,
    };
  }

  async issueEmailVerificationToken(input: {
    email: string;
    tokenHashHex: string;
    ttlSeconds: number;
    requestedIp: string | null;
  }): Promise<{ userId: string; email: string; fullName: string } | null> {
    const res = await this.dbPool.queryUnscoped<{
      user_id: string;
      email: string;
      full_name: string;
    }>(
      `SELECT user_id, email, full_name
       FROM public.fn_auth_issue_email_verification_token($1::citext, $2::char(64), $3, $4::inet)`,
      [
        input.email.trim().toLowerCase(),
        input.tokenHashHex,
        input.ttlSeconds,
        input.requestedIp,
      ],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { userId: row.user_id, email: row.email, fullName: row.full_name };
  }

  async issuePasswordResetToken(input: {
    email: string;
    tokenHashHex: string;
    ttlSeconds: number;
    requestedIp: string | null;
  }): Promise<{ userId: string; email: string; fullName: string } | null> {
    const res = await this.dbPool.queryUnscoped<{
      user_id: string;
      email: string;
      full_name: string;
    }>(
      `SELECT user_id, email, full_name
       FROM public.fn_auth_issue_password_reset_token($1::citext, $2::char(64), $3, $4::inet)`,
      [
        input.email.trim().toLowerCase(),
        input.tokenHashHex,
        input.ttlSeconds,
        input.requestedIp,
      ],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { userId: row.user_id, email: row.email, fullName: row.full_name };
  }

  async resetPasswordWithToken(input: {
    tokenHashHex: string;
    newPasswordHash: string;
    consumedIp: string | null;
  }): Promise<{ userId: string; email: string; revokedSessionIds: string[] } | null> {
    const res = await this.dbPool.queryUnscoped<{
      user_id: string;
      email: string;
      revoked_session_ids: string[] | null;
    }>(
      `SELECT user_id, email, revoked_session_ids
       FROM public.fn_auth_reset_password($1::char(64), $2, $3::inet)`,
      [input.tokenHashHex, input.newPasswordHash, input.consumedIp],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      email: row.email,
      revokedSessionIds: row.revoked_session_ids ?? [],
    };
  }

  async createSession(input: {
    userId: string;
    refreshTokenHashHex: string;
    csrfSecretHashHex: string;
    idleTtlSeconds: number;
    absoluteTtlSeconds: number;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<{
    sessionId: string;
    familyId: string;
    userId: string;
    idleExpiresAtEpochMs: number;
    expiresAtEpochMs: number;
  }> {
    const res = await this.dbPool.queryUnscoped<{
      session_id: string;
      family_id: string;
      user_id: string;
      idle_expires_at: Date | string;
      expires_at: Date | string;
    }>(
      `SELECT session_id, family_id, user_id, idle_expires_at, expires_at
       FROM public.fn_auth_create_session(
         $1::uuid,
         $2::char(64),
         $3::char(64),
         $4,
         $5,
         $6::inet,
         $7
       )`,
      [
        input.userId,
        input.refreshTokenHashHex,
        input.csrfSecretHashHex,
        input.idleTtlSeconds,
        input.absoluteTtlSeconds,
        input.ipAddress,
        input.userAgent,
      ],
    );
    const row = res.rows[0];
    return {
      sessionId: row.session_id,
      familyId: row.family_id,
      userId: row.user_id,
      idleExpiresAtEpochMs: new Date(row.idle_expires_at).getTime(),
      expiresAtEpochMs: new Date(row.expires_at).getTime(),
    };
  }

  async validateSessionInDb(
    sessionId: string,
    candidateCsrfHashHex?: string | null,
  ): Promise<ValidatedSessionDbRecord | null> {
    const res = await this.dbPool.queryUnscoped<{
      session_id: string;
      family_id: string;
      user_id: string;
      active_tenant_id: string | null;
      active_membership_id: string | null;
      idle_expires_at: Date | string;
      expires_at: Date | string;
      revoked_at: Date | string | null;
      user_status: UserStatus;
      user_email_verified: boolean;
      is_platform_super_admin: boolean;
      csrf_valid: boolean;
    }>(
      `SELECT
         session_id, family_id, user_id, active_tenant_id, active_membership_id,
         idle_expires_at, expires_at, revoked_at, user_status, user_email_verified,
         is_platform_super_admin, csrf_valid
       FROM public.fn_auth_validate_session($1::uuid, $2::char(64))`,
      [sessionId, candidateCsrfHashHex ?? null],
    );

    const row = res.rows[0];
    if (!row) return null;

    return {
      sessionId: row.session_id,
      familyId: row.family_id,
      userId: row.user_id,
      activeTenantId: row.active_tenant_id,
      activeMembershipId: row.active_membership_id,
      idleExpiresAtEpochMs: new Date(row.idle_expires_at).getTime(),
      expiresAtEpochMs: new Date(row.expires_at).getTime(),
      revokedAt: toIso(row.revoked_at),
      userStatus: row.user_status,
      userEmailVerified: row.user_email_verified,
      isPlatformSuperAdmin: row.is_platform_super_admin,
      csrfValid: row.csrf_valid,
    };
  }

  async rotateRefreshSession(input: {
    presentedRefreshHashHex: string;
    newRefreshHashHex: string;
    newCsrfHashHex: string;
    idleTtlSeconds: number;
    candidateCsrfHashHex: string | null;
    requireCsrf: boolean;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<RefreshRotationDbResult> {
    const res = await this.dbPool.queryUnscoped<{
      outcome: RefreshRotationDbResult['outcome'];
      session_id: string | null;
      family_id: string | null;
      user_id: string | null;
      active_tenant_id: string | null;
      active_membership_id: string | null;
      is_platform_super_admin: boolean;
      idle_expires_at: Date | string | null;
      expires_at: Date | string | null;
      revoked_family_session_ids: string[] | null;
    }>(
      `SELECT
         outcome, session_id, family_id, user_id, active_tenant_id, active_membership_id,
         is_platform_super_admin, idle_expires_at, expires_at, revoked_family_session_ids
       FROM public.fn_auth_rotate_refresh_session(
         $1::char(64),
         $2::char(64),
         $3::char(64),
         $4,
         $5::char(64),
         $6,
         $7::inet,
         $8
       )`,
      [
        input.presentedRefreshHashHex,
        input.newRefreshHashHex,
        input.newCsrfHashHex,
        input.idleTtlSeconds,
        input.candidateCsrfHashHex,
        input.requireCsrf,
        input.ipAddress,
        input.userAgent,
      ],
    );

    const row = res.rows[0];
    return {
      outcome: row.outcome,
      sessionId: row.session_id,
      familyId: row.family_id,
      userId: row.user_id,
      activeTenantId: row.active_tenant_id,
      activeMembershipId: row.active_membership_id,
      isPlatformSuperAdmin: Boolean(row.is_platform_super_admin),
      idleExpiresAtEpochMs: row.idle_expires_at ? new Date(row.idle_expires_at).getTime() : null,
      expiresAtEpochMs: row.expires_at ? new Date(row.expires_at).getTime() : null,
      revokedFamilySessionIds: row.revoked_family_session_ids ?? [],
    };
  }

  async bindSessionOrganization(input: {
    sessionId: string;
    userId: string;
    targetTenantId: string | null;
  }): Promise<{
    outcome: string;
    sessionId: string | null;
    activeTenantId: string | null;
    activeMembershipId: string | null;
  }> {
    const res = await this.dbPool.queryUnscoped<{
      outcome: string;
      session_id: string | null;
      active_tenant_id: string | null;
      active_membership_id: string | null;
    }>(
      `SELECT outcome, session_id, active_tenant_id, active_membership_id
       FROM public.fn_auth_bind_session_organization($1::uuid, $2::uuid, $3::uuid)`,
      [input.sessionId, input.userId, input.targetTenantId],
    );
    const row = res.rows[0];
    return {
      outcome: row.outcome,
      sessionId: row.session_id,
      activeTenantId: row.active_tenant_id,
      activeMembershipId: row.active_membership_id,
    };
  }

  async revokeSession(sessionId: string, userId: string, reason: string): Promise<boolean> {
    const res = await this.dbPool.queryUnscoped<{ revoked: boolean }>(
      `SELECT public.fn_auth_revoke_session($1::uuid, $2::uuid, $3) AS revoked`,
      [sessionId, userId, reason],
    );
    return Boolean(res.rows[0]?.revoked);
  }

  async revokeSessionByRefreshHash(
    refreshTokenHashHex: string,
    reason: string,
  ): Promise<{ sessionId: string; userId: string; activeTenantId: string | null } | null> {
    const res = await this.dbPool.queryUnscoped<{
      session_id: string;
      user_id: string;
      active_tenant_id: string | null;
    }>(
      `SELECT session_id, user_id, active_tenant_id
       FROM public.fn_auth_revoke_session_by_refresh_hash($1::char(64), $2)`,
      [refreshTokenHashHex, reason],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      sessionId: row.session_id,
      userId: row.user_id,
      activeTenantId: row.active_tenant_id,
    };
  }

  async revokeAllUserSessions(userId: string, reason: string): Promise<string[]> {
    const res = await this.dbPool.queryUnscoped<{ ids: string[] | null }>(
      `SELECT public.fn_auth_revoke_all_user_sessions($1::uuid, $2) AS ids`,
      [userId, reason],
    );
    return res.rows[0]?.ids ?? [];
  }

  async listActiveUserTenants(userId: string): Promise<ActiveUserTenantSummary[]> {
    const res = await this.dbPool.queryUnscoped<{
      membership_id: string;
      tenant_id: string;
      tenant_slug: string;
      tenant_display_name: string;
      tenant_status: TenantStatus;
      membership_type: MembershipType;
      membership_status: MembershipStatus;
    }>(
      `SELECT
         membership_id,
         tenant_id,
         tenant_slug::text AS tenant_slug,
         tenant_display_name,
         tenant_status,
         membership_type,
         membership_status
       FROM public.fn_list_user_tenants($1::uuid)`,
      [userId],
    );

    return res.rows.map((r) => ({
      membershipId: r.membership_id,
      tenantId: r.tenant_id,
      tenantSlug: r.tenant_slug,
      tenantDisplayName: r.tenant_display_name,
      tenantStatus: r.tenant_status,
      membershipType: r.membership_type,
      membershipStatus: r.membership_status,
    }));
  }

  async getAuthenticatedUserProfile(
    tx: QueryExecutor,
    userId: string,
  ): Promise<AuthenticatedUserProfile | null> {
    const res = await tx.query<{
      id: string;
      email: string;
      full_name: string;
      phone_e164: string | null;
      status: UserStatus;
      is_platform_super_admin: boolean;
      email_verified: boolean;
      last_login_at: Date | string | null;
    }>(
      `SELECT
         id, email::text AS email, full_name, phone_e164, status,
         is_platform_super_admin, email_verified, last_login_at
       FROM public.users
       WHERE id = $1::uuid`,
      [userId],
    );

    const row = res.rows[0];
    if (!row) return null;

    return {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      phoneE164: row.phone_e164,
      status: row.status,
      emailVerified: row.email_verified,
      isPlatformSuperAdmin: row.is_platform_super_admin,
      lastLoginAt: toIso(row.last_login_at),
    };
  }

  async listOwnActiveSessions(
    tx: QueryExecutor,
    userId: string,
    currentSessionId: string,
  ): Promise<AuthSessionSummary[]> {
    const res = await tx.query<{
      id: string;
      family_id: string;
      user_id: string;
      active_tenant_id: string | null;
      active_membership_id: string | null;
      ip_address: string | null;
      user_agent: string | null;
      last_active_at: Date | string;
      idle_expires_at: Date | string;
      expires_at: Date | string;
      revoked_at: Date | string | null;
      revoked_reason: string | null;
      created_at: Date | string;
    }>(
      `SELECT
         id, family_id, user_id, active_tenant_id, active_membership_id,
         host(ip_address) AS ip_address, user_agent, last_active_at,
         idle_expires_at, expires_at, revoked_at, revoked_reason, created_at
       FROM public.auth_sessions
       WHERE user_id = $1::uuid
         AND revoked_at IS NULL
         AND expires_at > NOW()
         AND idle_expires_at > NOW()
       ORDER BY last_active_at DESC`,
      [userId],
    );

    return res.rows.map((r) => ({
      id: r.id,
      familyId: r.family_id,
      userId: r.user_id,
      activeTenantId: r.active_tenant_id,
      activeMembershipId: r.active_membership_id,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      lastActiveAt: toIso(r.last_active_at)!,
      idleExpiresAt: toIso(r.idle_expires_at)!,
      expiresAt: toIso(r.expires_at)!,
      revokedAt: toIso(r.revoked_at),
      revokedReason: r.revoked_reason,
      isCurrent: r.id.toLowerCase() === currentSessionId.toLowerCase(),
      createdAt: toIso(r.created_at)!,
    }));
  }

  async listAuditLogsInScope(tx: QueryExecutor, limit = 50): Promise<AuthAuditLogEntry[]> {
    const safeLimit = Math.min(200, Math.max(1, limit));
    const res = await tx.query<{
      id: string;
      event_type: string;
      outcome: AuthAuditOutcome;
      actor_user_id: string | null;
      target_user_id: string | null;
      tenant_id: string | null;
      session_id: string | null;
      correlation_id: string;
      ip_address: string | null;
      user_agent: string | null;
      metadata: Record<string, unknown>;
      created_at: Date | string;
    }>(
      `SELECT
         id, event_type, outcome, actor_user_id, target_user_id,
         tenant_id, session_id, correlation_id,
         host(ip_address) AS ip_address, user_agent, metadata, created_at
       FROM public.auth_audit_logs
       ORDER BY created_at DESC
       LIMIT $1`,
      [safeLimit],
    );

    return res.rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      outcome: r.outcome,
      actorUserId: r.actor_user_id,
      targetUserId: r.target_user_id,
      tenantId: r.tenant_id,
      sessionId: r.session_id,
      correlationId: r.correlation_id,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      metadata: r.metadata ?? {},
      createdAt: toIso(r.created_at)!,
    }));
  }

  async insertAuditLog(input: {
    eventType: string;
    outcome: AuthAuditOutcome;
    correlationId: string;
    actorUserId?: string | null;
    targetUserId?: string | null;
    tenantId?: string | null;
    sessionId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown>;
    tx?: QueryExecutor;
  }): Promise<string> {
    const sql = `SELECT public.fn_record_auth_audit_log(
      $1, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::inet, $9, $10::jsonb
    ) AS id`;
    const params = [
      input.eventType,
      input.outcome,
      input.correlationId,
      input.actorUserId ?? null,
      input.targetUserId ?? null,
      input.tenantId ?? null,
      input.sessionId ?? null,
      input.ipAddress ?? null,
      input.userAgent ?? null,
      JSON.stringify(input.metadata ?? {}),
    ];

    const res = input.tx
      ? await input.tx.query<{ id: string }>(sql, params)
      : await this.dbPool.queryUnscoped<{ id: string }>(sql, params);
    return res.rows[0].id;
  }
}
