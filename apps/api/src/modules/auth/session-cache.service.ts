import { Inject, Injectable } from '@nestjs/common';
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

@Injectable()
export class RedisSessionCacheService {
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
    await this.redis.setAuthJson('sess', sid, state, ttl);
  }

  async getCachedSession(sessionId: string): Promise<CachedActiveSessionState | null> {
    const sid = assertValidUuid(sessionId, 'sessionId');
    const revoked = await this.isSessionTombstoned(sid);
    if (revoked) return null;
    return this.redis.getAuthJson<CachedActiveSessionState>('sess', sid);
  }

  async isSessionTombstoned(sessionId: string): Promise<boolean> {
    const sid = assertValidUuid(sessionId, 'sessionId');
    const marker = await this.redis.getAuthJson<{ revokedAt: number }>('revoked_sess', sid);
    return marker !== null;
  }

  async tombstoneSessions(sessionIds: readonly string[], reason: string): Promise<void> {
    const normalized = sessionIds
      .filter((id) => typeof id === 'string' && id.trim() !== '')
      .map((id) => assertValidUuid(id, 'sessionId'));
    if (normalized.length === 0) return;

    await this.redis.deleteAuthKeys('sess', normalized);
    const ttl = Math.max(60, this.config.auth.refreshIdleTtlSeconds);
    await Promise.all(
      normalized.map((sid) =>
        this.redis.setAuthJson('revoked_sess', sid, { revokedAt: Date.now(), reason }, ttl),
      ),
    );
  }

  async markAllUserSessionsRevoked(
    userId: string,
    sessionIds: readonly string[],
    reason: string,
  ): Promise<void> {
    const uid = assertValidUuid(userId, 'userId');
    await this.tombstoneSessions(sessionIds, reason);
    await this.redis.setAuthJson(
      'user_revoked_at',
      uid,
      { revokedAtEpochMs: Date.now(), reason },
      Math.max(60, this.config.auth.sessionAbsoluteTtlSeconds),
    );
  }

  async evictSessionCache(sessionId: string): Promise<void> {
    const sid = assertValidUuid(sessionId, 'sessionId');
    await this.redis.deleteAuthKeys('sess', [sid]);
  }
}
