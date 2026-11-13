import { createHash } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { RedisService } from '../../cache/redis.service';
import { APP_CONFIG, type AppEnvConfig } from '../../config/env.config';

export interface LoginLockoutStatus {
  locked: boolean;
  retryAfterSeconds: number;
  failureCount: number;
}

@Injectable()
export class AuthRateLimitService {
  constructor(
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppEnvConfig,
  ) {}

  /**
   * Enforces per-IP burst rate limiting on public authentication endpoints
   * (`register`, `verify-email`, `forgot-password`, `reset-password`, `refresh`).
   */
  async assertIpEndpointAllowed(
    action: string,
    ipAddress: string | null,
    res?: Response,
    customMax?: number,
    windowSeconds = 60,
  ): Promise<void> {
    const ipDigest = this.digestToken(ipAddress || 'unknown-ip');
    const safeAction = action.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
    const maxAllowed = customMax ?? this.config.auth.rateLimitIpBurstMax;

    const { count, ttlSeconds } = await this.redis.incrementAuthCounterWithTtl(
      'rl_ip',
      `${safeAction}:${ipDigest}`,
      windowSeconds,
    );

    if (count > maxAllowed) {
      if (res) {
        res.setHeader('Retry-After', String(ttlSeconds));
      }
      throw new HttpException(
        {
          code: 'AUTH_RATE_LIMITED',
          message: 'Too many authentication requests. Please wait before trying again.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Checks whether an `(email, ip)` login pair is currently locked out in Redis
   * BEFORE executing Argon2id verification or database queries.
   */
  async checkLoginLockout(email: string, ipAddress: string | null): Promise<LoginLockoutStatus> {
    const pairKey = this.buildLoginPairKey(email, ipAddress);
    const lockTtl = await this.redis.getAuthKeyTtl('rl_login_lock', pairKey);
    if (lockTtl > 0) {
      return {
        locked: true,
        retryAfterSeconds: lockTtl,
        failureCount: this.config.auth.rateLimitMaxLoginFailures,
      };
    }
    return {
      locked: false,
      retryAfterSeconds: 0,
      failureCount: 0,
    };
  }

  /**
   * Records a failed login attempt for `(email, ip)`. When failures reach
   * `rateLimitMaxLoginFailures` (default 5), sets an explicit lockout key for
   * `rateLimitLockoutSeconds` (default 15 minutes).
   */
  async recordLoginFailure(
    email: string,
    ipAddress: string | null,
  ): Promise<LoginLockoutStatus> {
    const pairKey = this.buildLoginPairKey(email, ipAddress);
    const { count } = await this.redis.incrementAuthCounterWithTtl(
      'rl_login_fail',
      pairKey,
      this.config.auth.rateLimitWindowSeconds,
    );

    if (count >= this.config.auth.rateLimitMaxLoginFailures) {
      const lockSeconds = this.config.auth.rateLimitLockoutSeconds;
      await this.redis.setAuthJson(
        'rl_login_lock',
        pairKey,
        { lockedAt: Date.now(), failures: count },
        lockSeconds,
      );
      return {
        locked: true,
        retryAfterSeconds: lockSeconds,
        failureCount: count,
      };
    }

    return {
      locked: false,
      retryAfterSeconds: 0,
      failureCount: count,
    };
  }

  async clearLoginFailures(email: string, ipAddress: string | null): Promise<void> {
    const pairKey = this.buildLoginPairKey(email, ipAddress);
    await this.redis.deleteAuthKeys('rl_login_fail', [pairKey]);
  }

  throwRateLimited(res: Response | undefined, retryAfterSeconds: number): never {
    const retry = Math.max(1, retryAfterSeconds);
    if (res) {
      res.setHeader('Retry-After', String(retry));
    }
    throw new HttpException(
      {
        code: 'AUTH_RATE_LIMITED',
        message: `Too many failed login attempts. Account sign-in is temporarily locked for ${retry} seconds.`,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private buildLoginPairKey(email: string, ipAddress: string | null): string {
    const emailDigest = this.digestToken(email.trim().toLowerCase());
    const ipDigest = this.digestToken(ipAddress || 'unknown-ip');
    return `${emailDigest}:${ipDigest}`;
  }

  private digestToken(val: string): string {
    return createHash('sha256').update(val, 'utf8').digest('hex').slice(0, 24);
  }
}
