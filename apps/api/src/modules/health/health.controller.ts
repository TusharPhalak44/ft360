import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { SystemHealthStatus } from '@ft360/shared-types';
import { HealthService } from './health.service';

@ApiTags('Health & Readiness')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Full platform readiness check (PostgreSQL pool, RLS role posture, migrations, Redis)',
  })
  @ApiOkResponse({ description: 'All infrastructure dependencies are healthy and least-privilege verified.' })
  @ApiServiceUnavailableResponse({ description: 'Database or Redis dependency unavailable.' })
  async checkHealth(): Promise<SystemHealthStatus> {
    return this.healthService.getReadiness();
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe alias for container orchestrators' })
  async checkReady(): Promise<SystemHealthStatus> {
    return this.healthService.getReadiness();
  }

  @Get('live')
  @ApiOperation({ summary: 'Lightweight process liveness probe' })
  checkLive(): { status: 'alive'; uptimeSeconds: number } {
    return this.healthService.getLiveness();
  }
}

