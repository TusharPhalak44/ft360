import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { SystemHealthStatus } from '@ft360/shared-types';
import { RedisService } from '../../cache/redis.service';
import { APP_CONFIG, type AppEnvConfig } from '../../config/env.config';
import { DatabasePoolService } from '../../database/database-pool.service';

@Injectable()
export class HealthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppEnvConfig,
    private readonly dbPool: DatabasePoolService,
    private readonly redisService: RedisService,
  ) {}

  getLiveness(): { status: 'alive'; uptimeSeconds: number } {
    return {
      status: 'alive',
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  async getReadiness(): Promise<SystemHealthStatus> {
    try {
      const [dbHealth, redisHealth] = await Promise.all([
        this.dbPool.getHealth(),
        this.redisService.getHealth(),
      ]);

      const healthy =
        dbHealth.connected &&
        !dbHealth.bypassRls &&
        !dbHealth.isSuperuser &&
        redisHealth.connected;

      const statusPayload: SystemHealthStatus = {
        status: healthy ? 'healthy' : 'unhealthy',
        service: `${this.config.brandingDefaults.productName} API`,
        environment: this.config.nodeEnv,
        uptimeSeconds: Math.round(process.uptime()),
        database: dbHealth,
        redis: redisHealth,
      };

      if (!healthy) {
        throw new ServiceUnavailableException({
          code: 'DEPENDENCY_UNHEALTHY',
          message: 'One or more backing data stores failed readiness checks.',
        });
      }

      return statusPayload;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      throw new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Backend readiness check failed to reach PostgreSQL or Redis.',
      });
    }
  }
}

