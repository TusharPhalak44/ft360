import { Inject, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../cache/redis.service';
import { assertValidUuid } from '../../common/uuid.util';
import { APP_CONFIG, type AppEnvConfig } from '../../config/env.config';

export interface CachedActiveSessionState {
  sessionId: string;
  familyId: string;
  userId: string;
  activeTenantId: string | null;
  activeMembershipId: string | null;
  isPlatformSuperAdmin: boolean;
  idleExpiresAtEpochMs: number;
  expiresAtEpochMs: number;
}

/**
 * Redis session cache accelerator with fail-safe PostgreSQL fallback.
 *
 * Security invariant: `JwtAuthGuard` and `TenantMembershipGuard` unconditionally
 * validate session, user, membership, and tenant operational lifecycle directly
 * against PostgreSQL on every request. If Redis is unavailable, all cache operations
 * log a structured `[REDIS_UNAVAILABLE_FALLBACK_PG]` warning and degrade cleanly
 * to synchronous PostgreSQL validation — never granting cached access and never
 * blocking Platform Super Admin lifecycle controls.
 */
@Injectable()
export class RedisSessionCacheService {
  private readonly logger = new Logger(RedisSessionCacheService.name);

  constructor(
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppEnvConfig,
  ) {}

  async cacheActiveSession(state: CachedActiveSessionState): Promise<void> {
    const sid = assertValidUuid(state.sessionId, 'sessionId');
    const nowMs = Date.now();
    const remainingSec = Math.floor(
      (Math.min(state.idleExpiresAtEpochMs, state.expiresAtEpochMs) - nowMs) / 1000,
    );
    const ttl = Math.max(1, Math.min(this.config.auth.accessTokenTtlSeconds, remainingSec));
    try {
      await this.redis.setAuthJson('sess', sid, state, ttl);
    } catch (err) {
      this.logFallback('cacheActiveSession', err);
    }
  }

  async getCachedSession(sessionId: string): Promise<CachedActiveSessionState | null> {
    const sid = assertValidUuid(sessionId, 'sessionId');
    try {
      const revoked = await this.isSessionTombstoned(sid);
      if (revoked) return null;
      return await this.redis.getAuthJson<CachedActiveSessionState>('sess', sid);
    } catch (err) {
      this.logFallback('getCachedSession', err);
      return null;
    }
  }

  async isSessionTombstoned(sessionId: string): Promise<boolean> {
    const sid = assertValidUuid(sessionId, 'sessionId');
    try {
      const marker = await this.redis.getAuthJson<{ revokedAt: number }>('revoked_sess', sid);
      return marker !== null;
    } catch (err) {
      this.logFallback('isSessionTombstoned', err);
      return false;
    }
  }

  async tombstoneSessions(sessionIds: readonly string[], reason: string): Promise<void> {
    const normalized = sessionIds
      .filter((id) => typeof id === 'string' && id.trim() !== '')
      .map((id) => assertValidUuid(id, 'sessionId'));
    if (normalized.length === 0) return;

    try {
      await this.redis.deleteAuthKeys('sess', normalized);
      const ttl = Math.max(60, this.config.auth.refreshIdleTtlSeconds);
      await Promise.all(
        normalized.map((sid) =>
          this.redis.setAuthJson('revoked_sess', sid, { revokedAt: Date.now(), reason }, ttl),
        ),
      );
    } catch (err) {
      this.logFallback('tombstoneSessions', err);
    }
  }

  async markAllUserSessionsRevoked(
    userId: string,
    sessionIds: readonly string[],
    reason: string,
  ): Promise<void> {
    const uid = assertValidUuid(userId, 'userId');
    await this.tombstoneSessions(sessionIds, reason);
    try {
      await this.redis.setAuthJson(
        'user_revoked_at',
        uid,
        { revokedAtEpochMs: Date.now(), reason },
        Math.max(60, this.config.auth.sessionAbsoluteTtlSeconds),
      );
    } catch (err) {
      this.logFallback('markAllUserSessionsRevoked', err);
    }
  }

  async evictSessionCache(sessionId: string): Promise<void> {
    const sid = assertValidUuid(sessionId, 'sessionId');
    try {
      await this.redis.deleteAuthKeys('sess', [sid]);
    } catch (err) {
      this.logFallback('evictSessionCache', err);
    }
  }

  private logFallback(operation: string, err: unknown): void {
    const errName = err instanceof Error ? err.name : 'RedisError';
    this.logger.warn(
      `[REDIS_UNAVAILABLE_FALLBACK_PG] Redis session cache unavailable during ${operation} (${errName}); authoritative PostgreSQL validation remains active.`,
    );
  }
}
