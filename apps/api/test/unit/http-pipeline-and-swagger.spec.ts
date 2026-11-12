import {
  Controller,
  Get,
  Req,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CacheModule } from '../../src/cache/cache.module';
import { RedisService } from '../../src/cache/redis.service';
import { CorrelationIdInterceptor } from '../../src/common/correlation-id.interceptor';
import { GlobalExceptionFilter } from '../../src/common/global-exception.filter';
import {
  TENANT_MEMBERSHIP_VERIFIER,
  TenantMembershipGuard,
  type RequestWithVerifiedTenant,
  type TenantMembershipRecord,
  type TenantMembershipVerifier,
} from '../../src/common/tenant-membership.guard';
import { UntrustedTenantInputGuard } from '../../src/common/untrusted-tenant-input.guard';
import { AppConfigModule } from '../../src/config/app-config.module';
import { APP_CONFIG, loadAppConfig } from '../../src/config/env.config';
import { DatabaseModule } from '../../src/database/database.module';
import { DatabasePoolService } from '../../src/database/database-pool.service';
import { BrandingModule } from '../../src/modules/branding/branding.module';
import { HealthModule } from '../../src/modules/health/health.module';
import { configureNestApp } from '../../src/bootstrap';

const CORR_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b97777';
const TENANT_ALPHA = '0195f3a2-7c40-7b12-9a10-4e8d21b91111';
const TENANT_BETA = '0195f3a2-7c40-7b12-9a10-4e8d21b92222';
const TENANT_SUSPENDED = '0195f3a2-7c40-7b12-9a10-4e8d21b93333';
const USER_ALPHA = '0195f3a2-7c40-7b12-9a10-4e8d21b9aaaa';
const MEMBERSHIP_ALPHA = '0195f3a2-7c40-7b12-9a10-4e8d21b9dddd';

/**
 * Simulates server-side JWT/session decoding from Authorization bearer token for guard verification
 * (Never accepts raw client x-tenant-id headers).
 */
class MockJwtSessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithVerifiedTenant>();
    const auth = req.headers.authorization;
    if (auth === 'Bearer token-alpha-in-alpha') {
      req.authSession = { userId: USER_ALPHA, activeTenantId: TENANT_ALPHA };
    } else if (auth === 'Bearer token-alpha-claiming-beta') {
      req.authSession = { userId: USER_ALPHA, activeTenantId: TENANT_BETA };
    } else if (auth === 'Bearer token-alpha-in-suspended-tenant') {
      req.authSession = { userId: USER_ALPHA, activeTenantId: TENANT_SUSPENDED };
    }
    return true;
  }
}

@Controller('workspace/probe')
@UseGuards(MockJwtSessionGuard, TenantMembershipGuard)
class WorkspaceMembershipProbeController {
  @Get()
  getScopedProbe(@Req() req: RequestWithVerifiedTenant) {
    return {
      verifiedTenantId: req.tenantContext?.tenantId,
      verifiedMembershipId: req.tenantContext?.membershipId,
    };
  }
}

describe('NestJS HTTP Pipeline, Swagger OpenAPI, Error Envelopes & Membership Guard (Supertest)', () => {
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
        serverVersion: '18.6',
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

    // User Alpha ONLY belongs to Tenant Alpha (and a suspended org), NOT Tenant Beta
    const membershipDirectory: TenantMembershipRecord[] = [
      {
        membershipId: MEMBERSHIP_ALPHA,
        userId: USER_ALPHA,
        tenantId: TENANT_ALPHA,
        status: 'ACTIVE',
        tenantStatus: 'ACTIVE',
      },
      {
        membershipId: '0195f3a2-7c40-7b12-9a10-4e8d21b9eeee',
        userId: USER_ALPHA,
        tenantId: TENANT_SUSPENDED,
        status: 'ACTIVE',
        tenantStatus: 'SUSPENDED',
      },
    ];

    const mockMembershipVerifier: TenantMembershipVerifier = {
      findMembership: jest.fn(async (userId: string, tenantId: string) => {
        return (
          membershipDirectory.find((m) => m.userId === userId && m.tenantId === tenantId) ?? null
        );
      }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule, CacheModule, BrandingModule, HealthModule],
      controllers: [WorkspaceMembershipProbeController],
      providers: [
        MockJwtSessionGuard,
        TenantMembershipGuard,
        { provide: TENANT_MEMBERSHIP_VERIFIER, useValue: mockMembershipVerifier },
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

  it('formats unknown routes into standardized 404 RESOURCE_NOT_FOUND ApiErrorResponse', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/does-not-exist')
      .set('X-Correlation-Id', CORR_ID)
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(res.body.meta.correlationId).toBe(CORR_ID);
  });

  it('rejects untrusted x-tenant-id header and ?tenant_id query parameter over HTTP with 400', async () => {
    const headerAttack = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('x-tenant-id', TENANT_ALPHA)
      .expect(400);
    expect(headerAttack.body.success).toBe(false);
    expect(headerAttack.body.error.code).toBe('UNTRUSTED_TENANT_INPUT_REJECTED');

    const queryAttack = await request(app.getHttpServer())
      .get(`/api/v1/public/branding?tenant_id=${TENANT_ALPHA}`)
      .expect(400);
    expect(queryAttack.body.success).toBe(false);
    expect(queryAttack.body.error.code).toBe('UNTRUSTED_TENANT_INPUT_REJECTED');
  });

  it('enforces TenantMembershipGuard: blocks missing session (401), wrong tenant membership (403), and suspended tenant (403), while allowing verified membership (200)', async () => {
    // 1. Missing session -> 401
    const unauth = await request(app.getHttpServer()).get('/api/v1/workspace/probe').expect(401);
    expect(unauth.body.error.code).toBe('MISSING_OR_INVALID_AUTH_SESSION');

    // 2. Wrong tenant membership (User Alpha attempting access to Tenant Beta) -> 403
    const wrongTenant = await request(app.getHttpServer())
      .get('/api/v1/workspace/probe')
      .set('Authorization', 'Bearer token-alpha-claiming-beta')
      .expect(403);
    expect(wrongTenant.body.error.code).toBe('TENANT_MEMBERSHIP_DENIED');

    // 3. Suspended tenant organization -> 403
    const suspendedOrg = await request(app.getHttpServer())
      .get('/api/v1/workspace/probe')
      .set('Authorization', 'Bearer token-alpha-in-suspended-tenant')
      .expect(403);
    expect(suspendedOrg.body.error.code).toBe('TENANT_SUSPENDED_OR_INACTIVE');

    // 4. Verified active membership in Tenant Alpha -> 200
    const allowed = await request(app.getHttpServer())
      .get('/api/v1/workspace/probe')
      .set('Authorization', 'Bearer token-alpha-in-alpha')
      .expect(200);
    expect(allowed.body.success).toBe(true);
    expect(allowed.body.data).toEqual({
      verifiedTenantId: TENANT_ALPHA,
      verifiedMembershipId: MEMBERSHIP_ALPHA,
    });
  });
});
