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

  constructor(@Inject(APP_CONFIG) private readonly config: AppEnvConfig) {
    this.client = new Redis({
      host: this.config.redis.host,
      port: this.config.redis.port,
      password: this.config.redis.password,
      db: this.config.redis.cacheDb,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });

    this.client.on('error', (err) => {
      this.logger.warn(`Redis cache connection warning: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
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

