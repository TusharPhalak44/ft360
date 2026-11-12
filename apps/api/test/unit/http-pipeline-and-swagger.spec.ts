import { type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CacheModule } from '../../src/cache/cache.module';
import { RedisService } from '../../src/cache/redis.service';
import { CorrelationIdInterceptor } from '../../src/common/correlation-id.interceptor';
import { GlobalExceptionFilter } from '../../src/common/global-exception.filter';
import { UntrustedTenantInputGuard } from '../../src/common/untrusted-tenant-input.guard';
import { AppConfigModule } from '../../src/config/app-config.module';
import { APP_CONFIG, loadAppConfig } from '../../src/config/env.config';
import { DatabaseModule } from '../../src/database/database.module';
import { DatabasePoolService } from '../../src/database/database-pool.service';
import { BrandingModule } from '../../src/modules/branding/branding.module';
import { HealthModule } from '../../src/modules/health/health.module';
import { configureNestApp } from '../../src/bootstrap';

const CORR_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b97777';
const SPOOF_TENANT = '0195f3a2-7c40-7b12-9a10-4e8d21b91111';

describe('NestJS HTTP Pipeline, Swagger OpenAPI & Public/Health Endpoints (Supertest)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const testConfig = loadAppConfig({
      DATABASE_MIGRATOR_URL: 'postgresql://ft360_migrator:pw1@localhost:5433/ft360_dev',
      DATABASE_APP_URL: 'postgresql://ft360_app:pw2@localhost:5433/ft360_dev',
      DEFAULT_PRODUCT_NAME: 'ConfigurableSuite360',
      DEFAULT_PRODUCT_TAGLINE: 'White-Label Ready Multi-Tenant Platform',
      DEFAULT_SUPPORT_EMAIL: 'ops@example.local',
      DEFAULT_WEBSITE_URL: 'http://localhost:3000',
      CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
      SWAGGER_ENABLED: 'true',
    });

    const mockDbPool: Partial<DatabasePoolService> = {
      queryUnscoped: jest.fn(async () => ({ rows: [{ exists: null }], rowCount: 1 }) as never),
      getHealth: jest.fn(async () => ({
        connected: true,
        latencyMs: 1.2,
        serverVersion: '18.x',
        currentRole: 'ft360_app',
        bypassRls: false,
        isSuperuser: false,
        appliedMigrations: 2,
        pool: { totalCount: 2, idleCount: 2, waitingCount: 0 },
      })),
    };

    const mockRedis: Partial<RedisService> = {
      getHealth: jest.fn(async () => ({
        connected: true,
        latencyMs: 0.5,
        mode: 'standalone',
      })),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule, CacheModule, BrandingModule, HealthModule],
      providers: [
        { provide: APP_GUARD, useClass: UntrustedTenantInputGuard },
        { provide: APP_INTERCEPTOR, useClass: CorrelationIdInterceptor },
        { provide: APP_FILTER, useClass: GlobalExceptionFilter },
      ],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(testConfig)
      .overrideProvider(DatabasePoolService)
      .useValue(mockDbPool)
      .overrideProvider(RedisService)
      .useValue(mockRedis)
      .compile();

    app = moduleRef.createNestApplication();
    configureNestApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves GET /api/v1/health/live with correlation envelope and CORS headers', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .set('Origin', 'http://localhost:3000')
      .set('X-Correlation-Id', CORR_ID)
      .expect(200);

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(res.headers['x-correlation-id']).toBe(CORR_ID);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('alive');
    expect(res.body.meta.correlationId).toBe(CORR_ID);
  });

  it('serves GET /api/v1/health and /api/v1/health/ready with DB & Redis readiness contract', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('healthy');
    expect(res.body.data.database.currentRole).toBe('ft360_app');
    expect(res.body.data.database.bypassRls).toBe(false);
    expect(res.body.data.redis.connected).toBe(true);
  });

  it('serves GET /api/v1/public/branding dynamically from configurable settings', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/public/branding').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.productName).toBe('ConfigurableSuite360');
    expect(res.body.data.source).toBe('BOOTSTRAP_DEFAULT');
  });

  it('exposes Swagger OpenAPI 3 specification at /api/docs-json with dynamic product title', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.info.title).toBe('ConfigurableSuite360 REST API');
    expect(res.body.paths['/api/v1/health']).toBeDefined();
    expect(res.body.paths['/api/v1/public/branding']).toBeDefined();
  });

  it('rejects untrusted x-tenant-id header and ?tenant_id query parameter over HTTP with 400', async () => {
    const headerAttack = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('x-tenant-id', SPOOF_TENANT)
      .expect(400);
    expect(headerAttack.body.success).toBe(false);
    expect(headerAttack.body.error.code).toBe('UNTRUSTED_TENANT_INPUT_REJECTED');

    const queryAttack = await request(app.getHttpServer())
      .get(`/api/v1/public/branding?tenant_id=${SPOOF_TENANT}`)
      .expect(400);
    expect(queryAttack.body.success).toBe(false);
    expect(queryAttack.body.error.code).toBe('UNTRUSTED_TENANT_INPUT_REJECTED');
  });
});

