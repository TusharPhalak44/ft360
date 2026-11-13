import * as http from 'node:http';
import * as net from 'node:net';
import { ConflictException, Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { Pool } from 'pg';
import request from 'supertest';
import type { TenantEntity, TenantMembershipEntity } from '@ft360/shared-types';
import { AppModule } from '../../src/app.module';
import { configureNestApp } from '../../src/bootstrap';
import { RedisService } from '../../src/cache/redis.service';
import { APP_CONFIG, loadAppConfig, type AppEnvConfig } from '../../src/config/env.config';
import { DatabasePoolService } from '../../src/database/database-pool.service';
import { TenantTransactionManager } from '../../src/database/tenant-transaction.manager';
import { AuthAuditService } from '../../src/modules/auth/auth-audit.service';
import {
  AUTH_TRANSACTIONAL_MAIL_QUEUE,
  AuthMailOutboxService,
} from '../../src/modules/auth/auth-mail-outbox.service';
import {
  DisabledAuthMailProvider,
  HttpWebhookAuthMailProvider,
  SmtpAuthMailProvider,
  type AuthMailProviderAdapter,
} from '../../src/modules/auth/auth-mail-provider';
import { AuthRepository } from '../../src/modules/auth/auth.repository';
import { BootstrapSuperAdminService } from '../../src/modules/auth/bootstrap-super-admin.service';
import { PasswordHashService } from '../../src/modules/auth/password-hash.service';
import { TokenService } from '../../src/modules/auth/token.service';
import { PlatformDirectoryRepository } from '../../src/modules/foundation-db/platform-directory.repository';
import { RbacRepository } from '../../src/modules/foundation-db/rbac.repository';
import { TenantMembershipRepository } from '../../src/modules/foundation-db/tenant-membership.repository';

function parseSetCookies(setCookieHeader: string | string[] | undefined): Record<string, string> {
  const arr = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : typeof setCookieHeader === 'string'
      ? [setCookieHeader]
      : [];
  const map: Record<string, string> = {};
  for (const raw of arr) {
    const first = raw.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) {
      map[first.slice(0, eq).trim()] = decodeURIComponent(first.slice(eq + 1).trim());
    }
  }
  return map;
}

function buildCookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('; ');
}

interface EphemeralSmtpServer {
  port: number;
  receivedRawData: string[];
  close: () => Promise<void>;
}

async function startEphemeralSmtpServer(): Promise<EphemeralSmtpServer> {
  const receivedRawData: string[] = [];
  const server = net.createServer((socket) => {
    let inDataMode = false;
    let lineBuf = '';
    let dataBuf = '';

    socket.write('220 localhost ESMTP FT360TestServer\r\n');

    socket.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      if (inDataMode) {
        dataBuf += str;
        const endMarker = dataBuf.indexOf('\r\n.\r\n');
        if (endMarker !== -1) {
          receivedRawData.push(dataBuf.slice(0, endMarker));
          lineBuf = dataBuf.slice(endMarker + 5);
          dataBuf = '';
          inDataMode = false;
          socket.write('250 2.0.0 OK queued as smtp-msg-test-001\r\n');
          processBufferedCommands();
        }
        return;
      }

      lineBuf += str;
      processBufferedCommands();
    });

    function processBufferedCommands() {
      while (!inDataMode) {
        const idx = lineBuf.indexOf('\r\n');
        if (idx === -1) break;
        const cmd = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 2);
        const upper = cmd.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-localhost Hello\r\n250 AUTH PLAIN\r\n');
        } else if (upper.startsWith('AUTH PLAIN')) {
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (upper.startsWith('MAIL FROM:')) {
          socket.write('250 2.1.0 Originator OK\r\n');
        } else if (upper.startsWith('RCPT TO:')) {
          socket.write('250 2.1.5 Recipient OK\r\n');
        } else if (upper === 'DATA') {
          inDataMode = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 OK\r\n');
        }
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as net.AddressInfo;

  return {
    port: addr.port,
    receivedRawData,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface EphemeralWebhookServer {
  url: string;
  setMode: (mode: 'ok' | 'fail503' | 'fail400') => void;
  receivedPayloads: Array<{ authHeader?: string; body: Record<string, unknown> }>;
  close: () => Promise<void>;
}

async function startEphemeralWebhookServer(): Promise<EphemeralWebhookServer> {
  let currentMode: 'ok' | 'fail503' | 'fail400' = 'ok';
  const receivedPayloads: Array<{ authHeader?: string; body: Record<string, unknown> }> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
        string,
        unknown
      >;
      receivedPayloads.push({
        authHeader: req.headers.authorization,
        body: parsed,
      });

      if (currentMode === 'fail503') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upstream MTA temporarily unavailable' }));
        return;
      }
      if (currentMode === 'fail400') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Permanent recipient rejection' }));
        return;
      }

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messageId: `wh-msg-${receivedPayloads.length}` }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as net.AddressInfo;

  return {
    url: `http://127.0.0.1:${addr.port}/v1/send`,
    setMode: (m) => {
      currentMode = m;
    },
    receivedPayloads,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe('Phase 3 Security Remediation & Re-Verification Suite (REM-P3-01..08)', () => {
  let app: INestApplication;
  let config: AppEnvConfig;
  let dbPool: DatabasePoolService;
  let redisService: RedisService;
  let txManager: TenantTransactionManager;
  let authRepo: AuthRepository;
  let auditService: AuthAuditService;
  let passwordHashService: PasswordHashService;
  let tokenService: TokenService;
  let platformRepo: PlatformDirectoryRepository;
  let membershipRepo: TenantMembershipRepository;
  let rbacRepo: RbacRepository;

  let superAdminUserId: string;
  let tenantAlpha: TenantEntity;
  let tenantBeta: TenantEntity;

  const SUPER_ADMIN_EMAIL = 'remediation.root@phase3-rem.test';
  const SUPER_ADMIN_PW = 'RemRoot#2026!Secure';

  async function registerAndVerifyViaDb(fullName: string, email: string, password: string) {
    const passwordHash = await passwordHashService.hashPassword(password);
    const verifySecret = tokenService.generateOpaqueSecret();
    const user = await authRepo.registerPendingUser({
      email: email.toLowerCase(),
      passwordHash,
      fullName,
      phoneE164: null,
      verifyTokenHash: verifySecret.tokenHashHex,
      verifyTtlSeconds: 900,
      requestedIp: '127.0.0.1',
    });
    const verified = await authRepo.consumeEmailVerificationToken(verifySecret.tokenHashHex);
    expect(verified?.userId).toBe(user.id);
    return user.id;
  }

  beforeAll(async () => {
    config = loadAppConfig();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue({
        ...config,
        corsAllowedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
        database: { ...config.database, poolMin: 1, poolMax: 8 },
        auth: {
          ...config.auth,
          argon2MemoryCostKiB: 19456,
          argon2TimeCost: 2,
          argon2Parallelism: 2,
          rateLimitIpBurstMax: 500,
          // Keep devOutboxEnabled FALSE (the secure default) in this remediation app!
          devOutboxEnabled: false,
          mail: {
            ...config.auth.mail,
            provider: 'sandbox',
            pollIntervalMs: 0,
            maxAttempts: 3,
            baseBackoffSeconds: 5,
            maxBackoffSeconds: 60,
          },
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    configureNestApp(app);
    await app.init();

    dbPool = app.get(DatabasePoolService);
    redisService = app.get(RedisService);
    txManager = app.get(TenantTransactionManager);
    authRepo = app.get(AuthRepository);
    auditService = app.get(AuthAuditService);
    passwordHashService = app.get(PasswordHashService);
    tokenService = app.get(TokenService);
    platformRepo = app.get(PlatformDirectoryRepository);
    membershipRepo = app.get(TenantMembershipRepository);
    rbacRepo = app.get(RbacRepository);

    const cleanupPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
    try {
      await cleanupPool.query(
        `DELETE FROM public.tenants WHERE slug IN ('p3-rem-alpha', 'p3-rem-beta')`,
      );
      await cleanupPool.query(`DELETE FROM public.users WHERE email LIKE '%@phase3-rem.test'`);
    } finally {
      await cleanupPool.end();
    }

    const saHash = await passwordHashService.hashPassword(SUPER_ADMIN_PW);
    const sa = await txManager.withSystemBootstrapTransaction((tx) =>
      platformRepo.createUser(tx, {
        email: SUPER_ADMIN_EMAIL,
        passwordHash: saHash,
        fullName: 'Remediation Super Admin',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        emailVerified: true,
      }),
    );
    superAdminUserId = sa.id;

    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      tenantAlpha = await platformRepo.createTenant(tx, {
        slug: 'p3-rem-alpha',
        legalName: 'Remediation Alpha Corp',
        displayName: 'Remediation Alpha',
        status: 'ACTIVE',
      });
      tenantBeta = await platformRepo.createTenant(tx, {
        slug: 'p3-rem-beta',
        legalName: 'Remediation Beta Corp',
        displayName: 'Remediation Beta',
        status: 'ACTIVE',
      });
    });
  });

  afterAll(async () => {
    try {
      const cleanupPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
      try {
        await cleanupPool.query(
          `DELETE FROM public.tenants WHERE slug IN ('p3-rem-alpha', 'p3-rem-beta')`,
        );
        await cleanupPool.query(`DELETE FROM public.users WHERE email LIKE '%@phase3-rem.test'`);
      } finally {
        await cleanupPool.end();
      }
    } finally {
      if (app) {
        await app.close();
      }
    }
  });

  it('REM-P3-01: delivers verification & password-reset emails via real SMTP & Webhook adapters, enforces bounded backoff retries, recovers from unavailable queues, never reports delivery when disabled, and never logs raw tokens/URLs', async () => {
    const smtpServer = await startEphemeralSmtpServer();
    const webhookServer = await startEphemeralWebhookServer();

    const capturedLogs: string[] = [];
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation((msg: unknown) => {
      capturedLogs.push(String(msg));
    });
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation((msg: unknown) => {
      capturedLogs.push(String(msg));
    });

    try {
      const email = 'mail.recipient@phase3-rem.test';
      const pw = 'MailUser#2026!Valid';
      const verifySecret = tokenService.generateOpaqueSecret();
      const pendingUser = await authRepo.registerPendingUser({
        email,
        passwordHash: await passwordHashService.hashPassword(pw),
        fullName: 'Mail Recipient',
        phoneE164: null,
        verifyTokenHash: verifySecret.tokenHashHex,
        verifyTtlSeconds: 900,
        requestedIp: '127.0.0.1',
      });

      const noopQueue = {
        name: AUTH_TRANSACTIONAL_MAIL_QUEUE,
        add: jest.fn().mockResolvedValue({ id: 'job-1' }),
      } as unknown as Queue;

      const buildOutboxService = (
        provider: AuthMailProviderAdapter,
        queueImpl: Queue = noopQueue,
        maxAttempts = 3,
      ) =>
        new AuthMailOutboxService(queueImpl, redisService, authRepo, provider, {
          ...config,
          auth: {
            ...config.auth,
            devOutboxEnabled: false,
            mail: {
              ...config.auth.mail,
              provider:
                provider.providerName === 'smtp' ||
                provider.providerName === 'webhook' ||
                provider.providerName === 'sandbox'
                  ? provider.providerName
                  : 'disabled',
              pollIntervalMs: 0,
              maxAttempts,
              baseBackoffSeconds: 5,
              maxBackoffSeconds: 40,
            },
          },
        });

      // 1. Disabled provider NEVER claims delivered: true
      const disabledOutbox = buildOutboxService(new DisabledAuthMailProvider());
      const disabledEnqueued = await disabledOutbox.enqueueEmailVerification({
        userId: pendingUser.id,
        email,
        fullName: pendingUser.fullName,
        rawToken: verifySecret.rawToken,
        correlationId: '0195f3a2-7c40-7b12-9a10-4e8d21b99001',
      });
      const disabledOutcome = await disabledOutbox.deliverOutboxItem(disabledEnqueued.outboxId);
      expect(disabledOutcome.delivered).toBe(false);
      expect(disabledOutcome.status).toBe('FAILED_RETRYABLE');
      expect(disabledOutcome.errorCode).toBe('MAIL_PROVIDER_NOT_CONFIGURED');

      // 2. Real RFC 5321 SMTP delivery for EMAIL_VERIFICATION + single-use token verification
      const smtpAdapter = new SmtpAuthMailProvider({
        host: '127.0.0.1',
        port: smtpServer.port,
        secure: false,
        requireTls: false,
        user: 'mailer',
        password: 'smtp-secret-password',
        timeoutMs: 5000,
      });
      const smtpOutbox = buildOutboxService(smtpAdapter);
      const smtpVerifySecret = tokenService.generateOpaqueSecret();
      await authRepo.issueEmailVerificationToken({
        email,
        tokenHashHex: smtpVerifySecret.tokenHashHex,
        ttlSeconds: 900,
        requestedIp: '127.0.0.1',
      });

      const smtpEnq = await smtpOutbox.enqueueEmailVerification({
        userId: pendingUser.id,
        email,
        fullName: pendingUser.fullName,
        rawToken: smtpVerifySecret.rawToken,
        correlationId: '0195f3a2-7c40-7b12-9a10-4e8d21b99002',
      });
      // Verify BullMQ job payload contains ONLY outboxId + correlationId (zero rawToken/URL)
      expect((noopQueue.add as jest.Mock).mock.calls.at(-1)?.[1]).toEqual({
        outboxId: smtpEnq.outboxId,
        correlationId: '0195f3a2-7c40-7b12-9a10-4e8d21b99002',
      });

      const smtpDelivered = await smtpOutbox.deliverOutboxItem(smtpEnq.outboxId);
      expect(smtpDelivered.delivered).toBe(true);
      expect(smtpDelivered.status).toBe('SENT');
      expect(smtpDelivered.provider).toBe('smtp');
      expect(smtpServer.receivedRawData.length).toBe(1);
      expect(smtpServer.receivedRawData[0]).toContain(encodeURIComponent(smtpVerifySecret.rawToken));

      const smtpStatus = await smtpOutbox.getOutboxItemStatus(smtpEnq.outboxId);
      expect(smtpStatus?.status).toBe('SENT');
      expect(smtpStatus?.hasCiphertext).toBe(false);

      // Consume the token extracted from the delivered SMTP email (single-use)
      await request(app.getHttpServer())
        .post('/api/v1/auth/verify-email')
        .send({ token: smtpVerifySecret.rawToken })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/auth/verify-email')
        .send({ token: smtpVerifySecret.rawToken })
        .expect(400);

      // 3. HTTP Webhook provider failure (503) -> bounded exponential backoff -> recovery on retry (PASSWORD_RESET)
      const webhookAdapter = new HttpWebhookAuthMailProvider({
        url: webhookServer.url,
        bearerToken: 'webhook-secret-token',
        timeoutMs: 5000,
      });
      const webhookOutbox = buildOutboxService(webhookAdapter, noopQueue, 3);
      expect(webhookOutbox.computeBackoffSeconds(1)).toBe(5);
      expect(webhookOutbox.computeBackoffSeconds(2)).toBe(10);
      expect(webhookOutbox.computeBackoffSeconds(3)).toBe(20);
      expect(webhookOutbox.computeBackoffSeconds(9)).toBe(40);

      const resetSecret = tokenService.generateOpaqueSecret();
      await authRepo.issuePasswordResetToken({
        email,
        tokenHashHex: resetSecret.tokenHashHex,
        ttlSeconds: 900,
        requestedIp: '127.0.0.1',
      });
      const resetEnq = await webhookOutbox.enqueuePasswordReset({
        userId: pendingUser.id,
        email,
        fullName: pendingUser.fullName,
        rawToken: resetSecret.rawToken,
        correlationId: '0195f3a2-7c40-7b12-9a10-4e8d21b99003',
      });

      webhookServer.setMode('fail503');
      const attempt1 = await webhookOutbox.deliverOutboxItem(resetEnq.outboxId);
      expect(attempt1.delivered).toBe(false);
      expect(attempt1.status).toBe('FAILED_RETRYABLE');
      expect(attempt1.backoffSeconds).toBe(5);

      // Fast-forward next_attempt_at in DB to simulate elapsed backoff window, then restore webhook to 202 OK
      const migratorPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
      try {
        await migratorPool.query(
          `UPDATE public.auth_email_outbox SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1::uuid`,
          [resetEnq.outboxId],
        );
      } finally {
        await migratorPool.end();
      }

      webhookServer.setMode('ok');
      const retryOutcome = await webhookOutbox.deliverOutboxItem(resetEnq.outboxId);
      expect(retryOutcome.delivered).toBe(true);
      expect(retryOutcome.status).toBe('SENT');
      expect(retryOutcome.providerMessageId).toBe('wh-msg-2');
      expect(webhookServer.receivedPayloads.at(-1)?.authHeader).toBe('Bearer webhook-secret-token');
      expect(String(webhookServer.receivedPayloads.at(-1)?.body.text)).toContain(
        encodeURIComponent(resetSecret.rawToken),
      );

      // 4. Unavailable BullMQ queue at enqueue time -> durable PostgreSQL outbox + drainDueOutboxBatch() prevents silent message loss
      const queueDownSecret = tokenService.generateOpaqueSecret();
      const brokenQueue = {
        name: AUTH_TRANSACTIONAL_MAIL_QUEUE,
        add: jest
          .fn()
          .mockRejectedValue(
            new Error(`ECONNREFUSED Redis broker down ${queueDownSecret.rawToken}`),
          ),
      } as unknown as Queue;
      const resilientOutbox = buildOutboxService(webhookAdapter, brokenQueue, 3);
      const queueDownEnq = await resilientOutbox.enqueuePasswordReset({
        userId: pendingUser.id,
        email,
        fullName: pendingUser.fullName,
        rawToken: queueDownSecret.rawToken,
        correlationId: '0195f3a2-7c40-7b12-9a10-4e8d21b99004',
      });
      expect(queueDownEnq.queuedToWorker).toBe(false);

      const pendingRow = await resilientOutbox.getOutboxItemStatus(queueDownEnq.outboxId);
      expect(pendingRow?.status).toBe('PENDING');
      expect(pendingRow?.hasCiphertext).toBe(true);

      const swept = await resilientOutbox.drainDueOutboxBatch(25);
      const sweptTarget = swept.find((o) => o.outboxId === queueDownEnq.outboxId);
      expect(sweptTarget?.delivered).toBe(true);
      expect(sweptTarget?.status).toBe('SENT');

      // 5. Expired token is never dispatched to provider
      const expiredSecret = tokenService.generateOpaqueSecret();
      const expiredEnq = await webhookOutbox.enqueuePasswordReset({
        userId: pendingUser.id,
        email,
        fullName: pendingUser.fullName,
        rawToken: expiredSecret.rawToken,
        ttlSecondsOverride: 1,
        correlationId: '0195f3a2-7c40-7b12-9a10-4e8d21b99005',
      });
      const expPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
      try {
        await expPool.query(
          `UPDATE public.auth_email_outbox SET token_expires_at = NOW() - INTERVAL '5 seconds' WHERE id = $1::uuid`,
          [expiredEnq.outboxId],
        );
      } finally {
        await expPool.end();
      }
      const expiredResult = await webhookOutbox.deliverOutboxItem(expiredEnq.outboxId);
      expect(expiredResult.delivered).toBe(false);
      expect(expiredResult.status).toBe('EXPIRED');

      // 6. Verify ZERO raw tokens or complete action URLs were ever written to logs
      const combinedLogs = capturedLogs.join('\n');
      for (const secretVal of [
        verifySecret.rawToken,
        smtpVerifySecret.rawToken,
        resetSecret.rawToken,
        queueDownSecret.rawToken,
        expiredSecret.rawToken,
      ]) {
        expect(combinedLogs).not.toContain(secretVal);
      }
      expect(combinedLogs).not.toMatch(/\/(?:verify-email|reset-password)\?token=/i);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      await smtpServer.close();
      await webhookServer.close();
    }
  });

  it('REM-P3-02: prevents normal startup elevation/password overwrite and enforces controlled one-time Super Admin bootstrap', async () => {
    const ordinaryEmail = 'ordinary.citizen@phase3-rem.test';
    const originalPw = 'Ordinary#Orig2026!Safe';
    const attackerBootstrapPw = 'Attacker#Overwrite2026!Bad';

    const originalHash = await passwordHashService.hashPassword(originalPw);
    const pendingOrdinary = await authRepo.registerPendingUser({
      email: ordinaryEmail,
      passwordHash: originalHash,
      fullName: 'Ordinary Citizen',
      phoneE164: null,
      verifyTokenHash: tokenService.generateOpaqueSecret().tokenHashHex,
      verifyTtlSeconds: 900,
      requestedIp: '127.0.0.1',
    });

    // 1. Construct BootstrapSuperAdminService with residual BOOTSTRAP_SUPER_ADMIN_* env pointing at ordinaryEmail
    const configuredBootstrapService = new BootstrapSuperAdminService(
      {
        ...config,
        auth: {
          ...config.auth,
          bootstrapSuperAdminEmail: ordinaryEmail,
          bootstrapSuperAdminPassword: attackerBootstrapPw,
          bootstrapSuperAdminFullName: 'Hijacked Super Admin',
        },
      },
      txManager,
      passwordHashService,
      auditService,
    );

    // Normal NestJS startup hook runs -> MUST NOT promote, activate, verify email, or overwrite password!
    await configuredBootstrapService.onApplicationBootstrap();

    const inspectPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
    try {
      const checkAfterStartup = await inspectPool.query<{
        password_hash: string;
        status: string;
        email_verified: boolean;
        is_platform_super_admin: boolean;
      }>(
        `SELECT password_hash, status, email_verified, is_platform_super_admin
         FROM public.users WHERE id = $1::uuid`,
        [pendingOrdinary.id],
      );
      expect(checkAfterStartup.rows[0]).toEqual({
        password_hash: originalHash,
        status: 'PENDING',
        email_verified: false,
        is_platform_super_admin: false,
      });

      // 2. When >= 1 active Super Admin already exists, provisionInitialSuperAdmin is refused with 409 SUPER_ADMIN_ALREADY_PROVISIONED
      await expect(
        configuredBootstrapService.provisionInitialSuperAdmin({
          email: 'second.superadmin@phase3-rem.test',
          password: 'SecondSuper#2026!Safe',
          fullName: 'Second Super Admin',
        }),
      ).rejects.toThrow(ConflictException);

      // 3. Temporarily suspend existing active Super Admins in an isolated block to test zero-super-admin initial bootstrap & email conflict refusal
      const suspendedExisting = await inspectPool.query<{ id: string }>(
        `UPDATE public.users
            SET status = 'SUSPENDED'
          WHERE is_platform_super_admin = TRUE AND status = 'ACTIVE'
          RETURNING id`,
      );

      let freshlyBootstrappedId: string | null = null;
      try {
        // Attempting initial bootstrap using ordinaryEmail MUST fail with 409 BOOTSTRAP_EMAIL_CONFLICT and NEVER promote or overwrite password!
        let conflictErr: unknown;
        try {
          await configuredBootstrapService.provisionInitialSuperAdmin({
            email: ordinaryEmail,
            password: attackerBootstrapPw,
            fullName: 'Conflict Attempt',
          });
        } catch (err) {
          conflictErr = err;
        }
        expect(conflictErr).toBeInstanceOf(ConflictException);
        expect((conflictErr as ConflictException).getResponse()).toMatchObject({
          code: 'BOOTSTRAP_EMAIL_CONFLICT',
        });

        const afterConflict = await inspectPool.query<{
          password_hash: string;
          is_platform_super_admin: boolean;
        }>(
          `SELECT password_hash, is_platform_super_admin FROM public.users WHERE id = $1::uuid`,
          [pendingOrdinary.id],
        );
        expect(afterConflict.rows[0]).toEqual({
          password_hash: originalHash,
          is_platform_super_admin: false,
        });

        // Fresh email when 0 active Super Admins exist -> succeeds ONCE
        const created = await configuredBootstrapService.provisionInitialSuperAdmin({
          email: 'first.controlled@phase3-rem.test',
          password: 'FirstControlled#2026!Ok',
          fullName: 'First Controlled Super Admin',
        });
        expect(created.outcome).toBe('CREATED');
        freshlyBootstrappedId = created.userId;

        // Immediate second attempt -> refused with 409 SUPER_ADMIN_ALREADY_PROVISIONED
        let duplicateErr: unknown;
        try {
          await configuredBootstrapService.provisionInitialSuperAdmin({
            email: 'another.super@phase3-rem.test',
            password: 'AnotherSuper#2026!Ok',
            fullName: 'Duplicate Super Admin',
          });
        } catch (err) {
          duplicateErr = err;
        }
        expect(duplicateErr).toBeInstanceOf(ConflictException);
        expect((duplicateErr as ConflictException).getResponse()).toMatchObject({
          code: 'SUPER_ADMIN_ALREADY_PROVISIONED',
        });
      } finally {
        if (freshlyBootstrappedId) {
          await inspectPool.query(`DELETE FROM public.users WHERE id = $1::uuid`, [
            freshlyBootstrappedId,
          ]);
        }
        if (suspendedExisting.rows.length > 0) {
          await inspectPool.query(
            `UPDATE public.users SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])`,
            [suspendedExisting.rows.map((r) => r.id)],
          );
        }
      }
    } finally {
      await inspectPool.end();
    }
  });

  it('REM-P3-03: returns 404 on GET /api/v1/auth/dev-outbox by default and blocks non-loopback requests even if enabled', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/auth/dev-outbox?email=anyone@phase3-rem.test&kind=EMAIL_VERIFICATION')
      .expect(404);
  });

  it('REM-P3-04: enforces strict tenant, unscoped, session, and platform control-plane isolation inside fn_record_auth_audit_log under ft360_app', async () => {
    const alphaUserId = await registerAndVerifyViaDb(
      'Audit Alpha Admin',
      'audit.alpha@phase3-rem.test',
      'AuditAlpha#2026!Safe',
    );
    const betaUserId = await registerAndVerifyViaDb(
      'Audit Beta Admin',
      'audit.beta@phase3-rem.test',
      'AuditBeta#2026!Safe',
    );

    let alphaMember!: TenantMembershipEntity;
    let betaMember!: TenantMembershipEntity;
    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      alphaMember = await membershipRepo.createMembership(tx, {
        tenantId: tenantAlpha.id,
        userId: alphaUserId,
        status: 'ACTIVE',
      });
      betaMember = await membershipRepo.createMembership(tx, {
        tenantId: betaUserId === alphaUserId ? tenantAlpha.id : tenantBeta.id,
        userId: betaUserId,
        status: 'ACTIVE',
      });
    });

    // Grant audit:auth:read to both Alpha and Beta admins inside their respective tenants
    for (const [tId, uId, mId, slug] of [
      [tenantAlpha.id, alphaUserId, alphaMember.id, 'rem_alpha_auditor'],
      [tenantBeta.id, betaUserId, betaMember.id, 'rem_beta_auditor'],
    ] as const) {
      await txManager.withVerifiedMemberTransaction(
        {
          tenantId: tId,
          actorUserId: uId,
          membershipId: mId,
          correlationId: '0195f3a2-7c40-7b12-9a10-4e8d21b99100',
        },
        async (tx) => {
          const role = await rbacRepo.createRole(tx, {
            tenantId: tId,
            slug,
            name: slug,
            isSystemRole: true,
            dataAccessScope: 'TENANT',
          });
          const perm = await tx.query<{ id: string }>(
            `SELECT id FROM public.permissions WHERE code = 'audit:auth:read'`,
          );
          await rbacRepo.grantPermissionToRole(tx, {
            tenantId: tId,
            roleId: role.id,
            permissionId: perm.rows[0].id,
          });
          await rbacRepo.assignRoleToMembership(tx, {
            tenantId: tId,
            membershipId: mId,
            roleId: role.id,
          });
        },
      );
    }

    // Case 1: Unscoped ft360_app call attempting to insert a tenant audit event -> REJECTED (42501)
    await expect(
      dbPool.queryUnscoped(
        `SELECT public.fn_record_auth_audit_log(
           'AUTH_FORGED_UNSCOPED_TENANT',
           'SUCCESS',
           '0195f3a2-7c40-7b12-9a10-4e8d21b99101'::uuid,
           $1::uuid,
           NULL,
           $2::uuid
         )`,
        [alphaUserId, tenantAlpha.id],
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Case 2: Tenant Alpha transaction attempting to insert an audit event for Tenant Beta -> REJECTED (42501)
    await expect(
      txManager.withVerifiedMemberTransaction(
        {
          tenantId: tenantAlpha.id,
          actorUserId: alphaUserId,
          membershipId: alphaMember.id,
          correlationId: '0195f3a2-7c40-7b12-9a10-4e8d21b99102',
        },
        (tx) =>
          tx.query(
            `SELECT public.fn_record_auth_audit_log(
               'AUTH_CROSS_TENANT_FORGERY',
               'SUCCESS',
               '0195f3a2-7c40-7b12-9a10-4e8d21b99102'::uuid,
               $1::uuid,
               NULL,
               $2::uuid
             )`,
            [alphaUserId, tenantBeta.id],
          ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Also: Tenant Alpha transaction attempting to write a NULL-tenant global event -> REJECTED (42501)
    await expect(
      txManager.withVerifiedMemberTransaction(
        {
          tenantId: tenantAlpha.id,
          actorUserId: alphaUserId,
          membershipId: alphaMember.id,
          correlationId: '0195f3a2-7c40-7b12-9a10-4e8d21b99103',
        },
        (tx) =>
          tx.query(
            `SELECT public.fn_record_auth_audit_log(
               'AUTH_GLOBAL_ESCAPE_ATTEMPT',
               'SUCCESS',
               '0195f3a2-7c40-7b12-9a10-4e8d21b99103'::uuid,
               $1::uuid,
               NULL,
               NULL
             )`,
            [alphaUserId],
          ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Case 3: Valid Tenant Alpha event -> SUCCEEDS and is strictly isolated from Tenant Beta
    const validAlphaAuditId = await txManager.withVerifiedMemberTransaction(
      {
        tenantId: tenantAlpha.id,
        actorUserId: alphaUserId,
        membershipId: alphaMember.id,
        correlationId: '0195f3a2-7c40-7b12-9a10-4e8d21b99104',
      },
      async (tx) => {
        const res = await tx.query<{ id: string }>(
          `SELECT public.fn_record_auth_audit_log(
             'AUTH_TENANT_ALPHA_VERIFIED_EVENT',
             'SUCCESS',
             '0195f3a2-7c40-7b12-9a10-4e8d21b99104'::uuid,
             $1::uuid,
             NULL,
             $2::uuid,
             NULL,
             '127.0.0.1'::inet,
             'JestRemediation',
             '{"scope":"alpha"}'::jsonb
           ) AS id`,
          [alphaUserId, tenantAlpha.id],
        );
        return res.rows[0].id;
      },
    );
    expect(validAlphaAuditId).toBeDefined();

    const betaVisible = await txManager.withVerifiedMemberTransaction(
      {
        tenantId: tenantBeta.id,
        actorUserId: betaUserId,
        membershipId: betaMember.id,
        correlationId: '0195f3a2-7c40-7b12-9a10-4e8d21b99105',
      },
      (tx) =>
        tx.query(`SELECT id FROM public.auth_audit_logs WHERE id = $1::uuid`, [validAlphaAuditId]),
    );
    expect(betaVisible.rows).toHaveLength(0);

    // Case 4: Valid Platform Super Admin control-plane (PLATFORM_*) event -> SUCCEEDS
    const validPlatformAuditId = await txManager.withPlatformAdminTransaction(
      superAdminUserId,
      async (tx) => {
        const res = await tx.query<{ id: string }>(
          `SELECT public.fn_record_auth_audit_log(
             'PLATFORM_CONTROL_AUDIT_VERIFIED',
             'SUCCESS',
             '0195f3a2-7c40-7b12-9a10-4e8d21b99106'::uuid,
             $1::uuid,
             NULL,
             $2::uuid,
             NULL,
             '127.0.0.1'::inet,
             'JestPlatformPlane',
             '{"plane":"platform"}'::jsonb
           ) AS id`,
          [superAdminUserId, tenantAlpha.id],
        );
        return res.rows[0].id;
      },
    );
    expect(validPlatformAuditId).toBeDefined();

    // Case 5: Unauthorized cross-plane PLATFORM_* event (unscoped or tenant-scoped) & session-tenant mismatch -> REJECTED (42501)
    await expect(
      dbPool.queryUnscoped(
        `SELECT public.fn_record_auth_audit_log(
           'PLATFORM_UNAUTHORIZED_EVENT',
           'SUCCESS',
           '0195f3a2-7c40-7b12-9a10-4e8d21b99107'::uuid,
           $1::uuid
         )`,
        [alphaUserId],
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      txManager.withVerifiedMemberTransaction(
        {
          tenantId: tenantAlpha.id,
          actorUserId: alphaUserId,
          membershipId: alphaMember.id,
          correlationId: '0195f3a2-7c40-7b12-9a10-4e8d21b99108',
        },
        (tx) =>
          tx.query(
            `SELECT public.fn_record_auth_audit_log(
               'PLATFORM_TENANT_SPOOF_EVENT',
               'SUCCESS',
               '0195f3a2-7c40-7b12-9a10-4e8d21b99108'::uuid,
               $1::uuid,
               NULL,
               $2::uuid
             )`,
            [alphaUserId, tenantAlpha.id],
          ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Create a session for betaUserId and prove Alpha cannot attach betaUserId's sessionId to an audit event (42501)
    const betaSession = await authRepo.createSession({
      userId: betaUserId,
      refreshTokenHashHex: tokenService.generateOpaqueSecret().tokenHashHex,
      csrfSecretHashHex: tokenService.generateOpaqueSecret().tokenHashHex,
      idleTtlSeconds: 900,
      absoluteTtlSeconds: 3600,
      ipAddress: '127.0.0.1',
      userAgent: 'JestSessionCheck',
    });

    await expect(
      dbPool.queryUnscoped(
        `SELECT public.fn_record_auth_audit_log(
           'AUTH_SESSION_ACTOR_MISMATCH',
           'SUCCESS',
           '0195f3a2-7c40-7b12-9a10-4e8d21b99109'::uuid,
           $1::uuid,
           NULL,
           NULL,
           $2::uuid
         )`,
        [alphaUserId, betaSession.sessionId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('REM-P3-05: blocks Login-CSRF vectors on POST /api/v1/auth/login and enforces global CSRF protection across all cookie-authenticated mutations', async () => {
    const email = 'csrf.login@phase3-rem.test';
    const pw = 'CsrfLogin#2026!Safe';
    const userId = await registerAndVerifyViaDb('CSRF Tester', email, pw);

    await txManager.withPlatformAdminTransaction(superAdminUserId, async (tx) => {
      await membershipRepo.createMembership(tx, {
        tenantId: tenantAlpha.id,
        userId,
        status: 'ACTIVE',
      });
    });

    // 1. Login-CSRF negative vectors on POST /api/v1/auth/login -> ALL rejected with 403 CSRF_TOKEN_INVALID
    const negativeLoginHeaders: Array<Record<string, string>> = [
      { Origin: 'https://evil-phishing.example' },
      { Origin: 'null' },
      { Origin: '' },
      { Origin: 'http://[::malformed-origin' },
      { Referer: 'https://evil-phishing.example/auto-submit.html' },
      { Referer: ':::malformed-referer' },
      { Referer: '' },
      { Origin: 'http://localhost:3000', 'Sec-Fetch-Site': 'cross-site' },
      { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/135.0' },
    ];

    for (const badHeaders of negativeLoginHeaders) {
      let reqBuilder = request(app.getHttpServer()).post('/api/v1/auth/login');
      for (const [hKey, hVal] of Object.entries(badHeaders)) {
        reqBuilder = reqBuilder.set(hKey, hVal);
      }
      const res = await reqBuilder.send({ email, password: pw }).expect(403);
      expect(res.body.error.code).toBe('CSRF_TOKEN_INVALID');
    }

    // HTML form Content-Type cross-site auto-submit attempt -> 403 CSRF_TOKEN_INVALID
    const formLoginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:3000')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`email=${encodeURIComponent(email)}&password=${encodeURIComponent(pw)}`)
      .expect(403);
    expect(formLoginRes.body.error.code).toBe('CSRF_TOKEN_INVALID');

    // 2. Browser pre-auth CSRF handshake (GET /api/v1/auth/csrf -> POST /api/v1/auth/login) succeeds (200)
    const preAuthCsrfRes = await request(app.getHttpServer())
      .get('/api/v1/auth/csrf')
      .set('User-Agent', 'Mozilla/5.0 Chrome/135.0')
      .expect(200);
    const preJar = parseSetCookies(preAuthCsrfRes.headers['set-cookie']);
    expect(preJar.ft360_csrf).toBe(preAuthCsrfRes.body.data.csrfToken);

    const browserLoginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('User-Agent', 'Mozilla/5.0 Chrome/135.0')
      .set('Origin', 'http://localhost:3000')
      .set('Cookie', buildCookieHeader(preJar))
      .set('X-CSRF-Token', preJar.ft360_csrf)
      .send({ email, password: pw })
      .expect(200);
    const jar = parseSetCookies(browserLoginRes.headers['set-cookie']);

    // 3. Global APP_GUARD CSRF enforcement across cookie-authenticated mutating endpoints
    await request(app.getHttpServer())
      .post('/api/v1/auth/select-organization')
      .set('Cookie', buildCookieHeader(jar))
      .send({ targetOrganizationId: tenantAlpha.id })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/auth/exit-organization')
      .set('Cookie', buildCookieHeader(jar))
      .set('X-CSRF-Token', 'forged-wrong-csrf-token')
      .send({})
      .expect(403);

    await request(app.getHttpServer())
      .delete(`/api/v1/auth/sessions/${browserLoginRes.body.data.sessionId}`)
      .set('Cookie', buildCookieHeader(jar))
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout-all')
      .set('Cookie', buildCookieHeader(jar))
      .expect(403);

    // 4. Explicit Authorization: Bearer API client (without ambient cookies) remains supported
    await request(app.getHttpServer())
      .post('/api/v1/auth/exit-organization')
      .set('Authorization', `Bearer ${jar.ft360_at}`)
      .send({})
      .expect(200);
  });

  it('REM-P3-06: detects multi-generation refresh token replay (RT1 -> RT2 -> RT3, replay RT1 revokes family & invalidates RT3) and serializes concurrent refresh races', async () => {
    const email = 'multigen.replay@phase3-rem.test';
    const pw = 'MultiGen#2026!Safe';
    await registerAndVerifyViaDb('MultiGen Replay User', email, pw);

    // 1. Issue RT1
    const login1 = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: pw })
      .expect(200);
    const jarRT1 = parseSetCookies(login1.headers['set-cookie']);

    // 2. Rotate RT1 -> RT2
    const rot2 = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', buildCookieHeader(jarRT1))
      .set('X-CSRF-Token', jarRT1.ft360_csrf)
      .send({})
      .expect(200);
    const jarRT2 = parseSetCookies(rot2.headers['set-cookie']);

    // 3. Rotate RT2 -> RT3 (RT1 is now two generations old, retained in auth_refresh_token_history)
    const rot3 = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', buildCookieHeader(jarRT2))
      .set('X-CSRF-Token', jarRT2.ft360_csrf)
      .send({})
      .expect(200);
    const jarRT3 = parseSetCookies(rot3.headers['set-cookie']);

    // 4. Replay older retired generation RT1 -> MUST trigger 401 REFRESH_TOKEN_REPLAY_DETECTED!
    const replayRT1 = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', buildCookieHeader(jarRT1))
      .set('X-CSRF-Token', jarRT1.ft360_csrf)
      .send({})
      .expect(401);
    expect(replayRT1.body.error.code).toBe('REFRESH_TOKEN_REPLAY_DETECTED');

    // 5. Confirm session family is revoked in PostgreSQL
    const migratorPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
    try {
      const famCheck = await migratorPool.query<{
        revoked_at: Date | null;
        revoked_reason: string | null;
      }>(`SELECT revoked_at, revoked_reason FROM public.auth_sessions WHERE id = $1::uuid`, [
        login1.body.data.sessionId,
      ]);
      expect(famCheck.rows[0].revoked_at).not.toBeNull();
      expect(famCheck.rows[0].revoked_reason).toBe('REPLAY_COMPROMISE');
    } finally {
      await migratorPool.end();
    }

    // 6. Confirm both AT3 (/auth/me) AND RT3 (/auth/refresh) are immediately rejected!
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', buildCookieHeader(jarRT3))
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', buildCookieHeader(jarRT3))
      .set('X-CSRF-Token', jarRT3.ft360_csrf)
      .send({})
      .expect(401);

    // 7. Concurrent refresh race with the exact same RT_RACE: row lock (FOR UPDATE) allows at most 1 rotation and revokes family on duplicate
    const raceLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: pw })
      .expect(200);
    const jarRace = parseSetCookies(raceLogin.headers['set-cookie']);

    const [raceA, raceB] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', buildCookieHeader(jarRace))
        .set('X-CSRF-Token', jarRace.ft360_csrf)
        .send({}),
      request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', buildCookieHeader(jarRace))
        .set('X-CSRF-Token', jarRace.ft360_csrf)
        .send({}),
    ]);

    const statuses = [raceA.status, raceB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 401]);
    const failedRace = raceA.status === 401 ? raceA : raceB;
    const succeededRace = raceA.status === 200 ? raceA : raceB;
    expect(failedRace.body.error.code).toBe('REFRESH_TOKEN_REPLAY_DETECTED');

    // Because the duplicate raced immediately after rotation, the family was revoked -> even the 200 winner's cookies are now dead!
    const winnerJar = parseSetCookies(succeededRace.headers['set-cookie']);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', buildCookieHeader(winnerJar))
      .expect(401);
  });

  it('REM-P3-07: recursively sanitizes secrets inside arrays & nested objects in AuthAuditService and enforces recursive PostgreSQL JSONB check constraint (23514)', async () => {
    const corrId = '0195f3a2-7c40-7b12-9a10-4e8d21b99301';
    await auditService.record({
      eventType: 'AUTH_NESTED_SANITIZE_VERIFICATION',
      outcome: 'SUCCESS',
      correlationId: corrId,
      actorUserId: superAdminUserId,
      metadata: {
        safeLabel: 'retained',
        nestedArray: [
          {
            keepMe: true,
            password: 'nested-array-password-secret',
            deeper: [
              {
                refresh_token: 'nested-array-rt-secret',
                csrfSecret: 'nested-csrf-secret',
                safeInner: 'inner-ok',
              },
            ],
          },
        ],
      },
    });

    const stored = await txManager.withPlatformAdminTransaction(superAdminUserId, (tx) =>
      tx.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM public.auth_audit_logs WHERE correlation_id = $1::uuid`,
        [corrId],
      ),
    );
    expect(stored.rows[0].metadata).toEqual({
      safeLabel: 'retained',
      nestedArray: [
        {
          keepMe: true,
          deeper: [{ safeInner: 'inner-ok' }],
        },
      ],
    });

    // Direct ft360_app SQL bypass attempt with secret nested inside a JSONB array -> REJECTED by chk_auth_audit_logs_no_secret_keys (23514)!
    await expect(
      dbPool.queryUnscoped(
        `SELECT public.fn_record_auth_audit_log(
           'AUTH_DIRECT_SQL_ARRAY_SECRET',
           'SUCCESS',
           '0195f3a2-7c40-7b12-9a10-4e8d21b99302'::uuid,
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           '{"events":[{"deep":{"refresh_token":"leaked"}}]}'::jsonb
         )`,
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      dbPool.queryUnscoped(
        `SELECT public.fn_record_auth_audit_log(
           'AUTH_DIRECT_SQL_ARRAY_PW',
           'SUCCESS',
           '0195f3a2-7c40-7b12-9a10-4e8d21b99303'::uuid,
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           '{"arr":[[{"passwordHash":"$argon2id$leaked"}]]}'::jsonb
         )`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('REM-P3-08: enforces PostgreSQL caller-context authorization (42501), explicit search_path, and zero PUBLIC privileges across SECURITY DEFINER auth functions', async () => {
    const userA = await registerAndVerifyViaDb(
      'DB Auth User A',
      'db.user.a@phase3-rem.test',
      'DbUserA#2026!Safe',
    );
    const userB = await registerAndVerifyViaDb(
      'DB Auth User B',
      'db.user.b@phase3-rem.test',
      'DbUserB#2026!Safe',
    );

    const userBSession = await authRepo.createSession({
      userId: userB,
      refreshTokenHashHex: tokenService.generateOpaqueSecret().tokenHashHex,
      csrfSecretHashHex: tokenService.generateOpaqueSecret().tokenHashHex,
      idleTtlSeconds: 900,
      absoluteTtlSeconds: 3600,
      ipAddress: '127.0.0.1',
      userAgent: 'JestDbAuthB',
    });

    // 1. Unscoped ft360_app calls (missing app.current_user_id) MUST fail closed with 42501
    await expect(
      dbPool.queryUnscoped(
        `SELECT * FROM public.fn_auth_create_session($1::uuid, $2, $3, 900, 3600, NULL, NULL)`,
        [
          userB,
          tokenService.generateOpaqueSecret().tokenHashHex,
          tokenService.generateOpaqueSecret().tokenHashHex,
        ],
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      dbPool.queryUnscoped(`SELECT public.fn_auth_revoke_session($1::uuid, $2::uuid, 'ATTACK')`, [
        userBSession.sessionId,
        userB,
      ]),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      dbPool.queryUnscoped(`SELECT public.fn_auth_revoke_all_user_sessions($1::uuid, 'ATTACK')`, [
        userB,
      ]),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      dbPool.queryUnscoped(`SELECT * FROM public.fn_auth_validate_session($1::uuid, NULL)`, [
        userBSession.sessionId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      dbPool.queryUnscoped(
        `SELECT * FROM public.fn_auth_bind_session_organization($1::uuid, $2::uuid, NULL)`,
        [userBSession.sessionId, userB],
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      dbPool.queryUnscoped(
        `SELECT * FROM public.fn_auth_bootstrap_initial_super_admin('rogue@phase3-rem.test', 'hash', 'Rogue')`,
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // 2. Authenticated User A transaction targeting User B's user_id or session_id MUST fail closed with 42501!
    await expect(
      txManager.withAuthenticatedUserTransaction(userA, (tx) =>
        tx.query(`SELECT public.fn_auth_revoke_session($1::uuid, $2::uuid, 'CROSS_USER_REVOKE')`, [
          userBSession.sessionId,
          userB,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      txManager.withAuthenticatedUserTransaction(userA, (tx) =>
        tx.query(`SELECT public.fn_auth_revoke_all_user_sessions($1::uuid, 'CROSS_USER_NUKE')`, [
          userB,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      txManager.withAuthenticatedUserTransaction(userA, (tx) =>
        tx.query(`SELECT * FROM public.fn_auth_validate_session($1::uuid, NULL)`, [
          userBSession.sessionId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      txManager.withAuthenticatedUserTransaction(userA, (tx) =>
        tx.query(
          `SELECT * FROM public.fn_auth_bind_session_organization($1::uuid, $2::uuid, NULL)`,
          [userBSession.sessionId, userB],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // 3. Verified Platform Super Admin transaction CAN legitimately revoke User B's sessions
    const adminRevoked = await authRepo.revokeAllUserSessionsAsPlatformAdmin(
      superAdminUserId,
      userB,
      'PLATFORM_SECURITY_REVOKE',
    );
    expect(adminRevoked).toContain(userBSession.sessionId);

    // 4. Verify PostgreSQL catalog posture for all SECURITY DEFINER auth/audit routines
    const procCheck = await dbPool.queryUnscoped<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      public_exec: boolean;
    }>(
      `SELECT
         p.proname,
         p.prosecdef,
         p.proconfig,
         has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
       FROM pg_proc p
       INNER JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND (p.proname LIKE 'fn_auth_%' OR p.proname = 'fn_record_auth_audit_log')
       ORDER BY p.proname ASC`,
    );

    expect(procCheck.rows.length).toBeGreaterThanOrEqual(16);
    for (const fnRow of procCheck.rows) {
      expect(fnRow.prosecdef).toBe(true);
      expect(fnRow.public_exec).toBe(false);
      expect((fnRow.proconfig ?? []).join(',')).toContain('search_path=pg_catalog, public, pg_temp');
    }
  });
});
