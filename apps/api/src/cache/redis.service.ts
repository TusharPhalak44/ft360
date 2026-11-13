import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import type { RedisHealth } from '@ft360/shared-types';
import { assertValidUuid } from '../common/uuid.util';
import { APP_CONFIG, type AppEnvConfig } from '../config/env.config';

const SAFE_TOKEN_REGEX = /^[a-zA-Z0-9:_-]{1,128}$/;

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  private loggedOfflineWarning = false;

  constructor(@Inject(APP_CONFIG) private readonly config: AppEnvConfig) {
    this.client = new Redis({
      host: this.config.redis.host,
      port: this.config.redis.port,
      password: this.config.redis.password,
      db: this.config.redis.cacheDb,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 2000, 15000),
    });

    this.client.on('ready', () => {
      this.loggedOfflineWarning = false;
    });

    this.client.on('error', (err) => {
      if (!this.loggedOfflineWarning) {
        this.loggedOfflineWarning = true;
        this.logger.warn(
          `Redis cache unreachable (${err.message}). Start Docker Desktop and run "npm run infra:up".`,
        );
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }

  /**
   * Builds a strictly isolated tenant cache key (`t:{tenantId}:{namespace}:{key}`).
   * Rejects missing/invalid UUIDs or unsafe characters so one tenant can NEVER
   * collide with or traverse into another tenant's cache keyspace.
   */
  buildTenantKey(tenantId: string, namespace: string, key: string): string {
    const normalizedTenantId = assertValidUuid(tenantId, 'tenantId');
    if (!SAFE_TOKEN_REGEX.test(namespace)) {
      throw new Error(`Invalid Redis namespace "${namespace}".`);
    }
    if (!SAFE_TOKEN_REGEX.test(key)) {
      throw new Error(`Invalid Redis key "${key}".`);
    }
    return `t:${normalizedTenantId}:${namespace}:${key}`;
  }

  async setTenantJson<T>(
    tenantId: string,
    namespace: string,
    key: string,
    value: T,
    ttlSeconds: number,
  ): Promise<void> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error('ttlSeconds must be a positive integer.');
    }
    const scopedKey = this.buildTenantKey(tenantId, namespace, key);
    await this.client.set(scopedKey, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async getTenantJson<T>(tenantId: string, namespace: string, key: string): Promise<T | null> {
    const scopedKey = this.buildTenantKey(tenantId, namespace, key);
    const raw = await this.client.get(scopedKey);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  }

  async deleteTenantKey(tenantId: string, namespace: string, key: string): Promise<number> {
    const scopedKey = this.buildTenantKey(tenantId, namespace, key);
    return this.client.del(scopedKey);
  }

  /**
   * Builds a strictly isolated global authentication/rate-limit key (`auth:{namespace}:{key}`).
   * Never collides with `t:{tenantId}:*` tenant cache keys.
   */
  buildAuthKey(namespace: string, key: string): string {
    if (!SAFE_TOKEN_REGEX.test(namespace)) {
      throw new Error(`Invalid Redis auth namespace "${namespace}".`);
    }
    if (!SAFE_TOKEN_REGEX.test(key)) {
      throw new Error(`Invalid Redis auth key "${key}".`);
    }
    return `auth:${namespace}:${key}`;
  }

  async setAuthJson<T>(
    namespace: string,
    key: string,
    value: T,
    ttlSeconds: number,
  ): Promise<void> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error('ttlSeconds must be a positive integer.');
    }
    const scopedKey = this.buildAuthKey(namespace, key);
    await this.client.set(scopedKey, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async getAuthJson<T>(namespace: string, key: string): Promise<T | null> {
    const scopedKey = this.buildAuthKey(namespace, key);
    const raw = await this.client.get(scopedKey);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  }

  async deleteAuthKeys(namespace: string, keys: readonly string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const scopedKeys = keys.map((k) => this.buildAuthKey(namespace, k));
    return this.client.del(...scopedKeys);
  }

  async incrementAuthCounterWithTtl(
    namespace: string,
    key: string,
    windowSeconds: number,
  ): Promise<{ count: number; ttlSeconds: number }> {
    const scopedKey = this.buildAuthKey(namespace, key);
    const results = await this.client
      .multi()
      .incr(scopedKey)
      .ttl(scopedKey)
      .exec();

    const count = Number(results?.[0]?.[1] ?? 1);
    let ttl = Number(results?.[1]?.[1] ?? -1);
    if (count === 1 || ttl < 0) {
      await this.client.expire(scopedKey, windowSeconds);
      ttl = windowSeconds;
    }
    return { count, ttlSeconds: Math.max(1, ttl) };
  }

  async getAuthKeyTtl(namespace: string, key: string): Promise<number> {
    const scopedKey = this.buildAuthKey(namespace, key);
    return this.client.ttl(scopedKey);
  }

  async getHealth(): Promise<RedisHealth> {
    const start = performance.now();
    const pong = await this.client.ping();
    const latencyMs = Math.round((performance.now() - start) * 100) / 100;

    return {
      connected: pong === 'PONG',
      latencyMs,
      mode: this.client.mode ?? 'standalone',
    };
  }
}

