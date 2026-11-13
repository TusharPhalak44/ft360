import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { RedisService } from '../../cache/redis.service';
import { isValidUuid } from '../../common/uuid.util';
import { APP_CONFIG, type AppEnvConfig } from '../../config/env.config';
import {
  AUTH_MAIL_PROVIDER,
  AuthMailDeliveryError,
  type AuthMailProviderAdapter,
  type AuthTransactionalMailMessage,
} from './auth-mail-provider';
import {
  AuthRepository,
  type ClaimedEmailOutboxRecord,
  type EmailOutboxStatus,
  type EmailOutboxStatusRecord,
} from './auth.repository';

export const AUTH_TRANSACTIONAL_MAIL_QUEUE = 'auth-transactional-mail';

export interface AuthMailJobPayload {
  outboxId: string;
  correlationId: string;
}

export interface AuthMailDeliveryOutcome {
  delivered: boolean;
  status: EmailOutboxStatus | 'SKIPPED';
  outboxId: string;
  provider?: string;
  providerMessageId?: string;
  backoffSeconds?: number;
  errorCode?: string;
}

export interface DevOutboxPreviewMessage {
  kind: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';
  recipientEmail: string;
  actionUrl: string;
  rawToken: string;
  enqueuedAt: string;
}

const PERMITTED_DEV_OUTBOX_ENVS = new Set(['development', 'test']);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function redactMailLogText(input: string, rawToken?: string): string {
  let scrubbed = input;
  if (rawToken && rawToken.trim().length >= 8) {
    scrubbed = scrubbed.split(rawToken.trim()).join('[REDACTED_TOKEN]');
    const encoded = encodeURIComponent(rawToken.trim());
    scrubbed = scrubbed.split(encoded).join('[REDACTED_TOKEN]');
  }
  // Scrub any verification/reset action URLs or query tokens
  scrubbed = scrubbed.replace(
    /https?:\/\/[^\s"'<>]+\/(?:verify-email|reset-password)[^\s"'<>]*/gi,
    '[REDACTED_ACTION_URL]',
  );
  scrubbed = scrubbed.replace(/([?&]token=)[^&\s"'<>]+/gi, '$1[REDACTED_TOKEN]');
  return scrubbed.slice(0, 500);
}

@Injectable()
export class AuthMailOutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthMailOutboxService.name);
  private readonly encryptionKey: Buffer;
  private sweeperTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectQueue(AUTH_TRANSACTIONAL_MAIL_QUEUE) private readonly mailQueue: Queue,
    private readonly redis: RedisService,
    private readonly authRepo: AuthRepository,
    @Inject(AUTH_MAIL_PROVIDER) private readonly mailProvider: AuthMailProviderAdapter,
    @Inject(APP_CONFIG) private readonly config: AppEnvConfig,
  ) {
    this.encryptionKey = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(this.config.auth.mail.outboxEncryptionSecret, 'utf8'),
        Buffer.from('ft360-auth-email-outbox-salt-v1', 'utf8'),
        Buffer.from('ft360-auth-email-outbox-aes-256-gcm', 'utf8'),
        32,
      ),
    );
  }

  onModuleInit(): void {
    const pollMs = this.config.auth.mail.pollIntervalMs;
    if (pollMs > 0 && this.config.auth.mail.provider !== 'disabled') {
      this.sweeperTimer = setInterval(() => {
        void this.drainDueOutboxBatch(10).catch((err) => {
          this.logger.warn(
            `Durable auth email outbox sweeper error: ${redactMailLogText(err instanceof Error ? err.message : String(err))}`,
          );
        });
      }, pollMs);
      this.sweeperTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.sweeperTimer) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = null;
    }
  }

  computeBackoffSeconds(attemptCount: number): number {
    const base = this.config.auth.mail.baseBackoffSeconds;
    const cap = this.config.auth.mail.maxBackoffSeconds;
    const exp = Math.pow(2, Math.max(0, attemptCount - 1));
    return Math.min(cap, Math.max(1, Math.round(base * exp)));
  }

  async enqueueEmailVerification(input: {
    userId: string;
    email: string;
    fullName: string;
    rawToken: string;
    correlationId: string;
    ttlSecondsOverride?: number;
  }): Promise<{ outboxId: string; queuedToWorker: boolean }> {
    return this.enqueueDurableMail({
      kind: 'EMAIL_VERIFICATION',
      userId: input.userId,
      recipientEmail: input.email.trim().toLowerCase(),
      recipientFullName: input.fullName,
      rawToken: input.rawToken,
      tokenTtlSeconds: input.ttlSecondsOverride ?? this.config.auth.emailVerificationTtlSeconds,
      correlationId: input.correlationId,
    });
  }

  async enqueuePasswordReset(input: {
    userId: string;
    email: string;
    fullName: string;
    rawToken: string;
    correlationId: string;
    ttlSecondsOverride?: number;
  }): Promise<{ outboxId: string; queuedToWorker: boolean }> {
    return this.enqueueDurableMail({
      kind: 'PASSWORD_RESET',
      userId: input.userId,
      recipientEmail: input.email.trim().toLowerCase(),
      recipientFullName: input.fullName,
      rawToken: input.rawToken,
      tokenTtlSeconds: input.ttlSecondsOverride ?? this.config.auth.passwordResetTtlSeconds,
      correlationId: input.correlationId,
    });
  }

  async deliverOutboxItem(outboxId: string): Promise<AuthMailDeliveryOutcome> {
    const claimed = await this.authRepo.claimEmailOutboxById(outboxId);
    if (!claimed) {
      return { delivered: false, status: 'SKIPPED', outboxId };
    }
    if (claimed.status === 'EXPIRED') {
      this.logger.warn(
        `[${claimed.correlationId}] Transactional ${claimed.kind} outbox=${outboxId} expired prior to provider dispatch.`,
      );
      return {
        delivered: false,
        status: 'EXPIRED',
        outboxId,
        errorCode: 'TOKEN_EXPIRED_BEFORE_SEND',
      };
    }

    return this.executeClaimedDelivery(claimed);
  }

  /**
   * Sweeps due `PENDING` and `FAILED_RETRYABLE` outbox items directly from PostgreSQL.
   * Guarantees zero message loss if Redis/BullMQ was temporarily unreachable at enqueue time
   * or if a retry delay has elapsed.
   */
  async drainDueOutboxBatch(batchSize = 10): Promise<AuthMailDeliveryOutcome[]> {
    const claimedRows = await this.authRepo.claimEmailOutboxBatch(batchSize);
    const outcomes: AuthMailDeliveryOutcome[] = [];
    for (const row of claimedRows) {
      outcomes.push(await this.executeClaimedDelivery(row));
    }
    return outcomes;
  }

  async getOutboxItemStatus(outboxId: string): Promise<EmailOutboxStatusRecord | null> {
    return this.authRepo.getEmailOutboxStatus(outboxId);
  }

  async readLatestDevOutboxMessage(
    email: string,
    kind: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
  ): Promise<DevOutboxPreviewMessage | null> {
    if (
      !this.config.auth.devOutboxEnabled ||
      !PERMITTED_DEV_OUTBOX_ENVS.has(this.config.nodeEnv)
    ) {
      throw new NotFoundException('Endpoint not found.');
    }
    const safeKey = this.toSafeOutboxKey(email, kind);
    return this.redis.getAuthJson<DevOutboxPreviewMessage>('dev_outbox', safeKey);
  }

  sealActionToken(rawToken: string, userId: string, kind: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(`${userId.toLowerCase()}:${kind}`, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(rawToken, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `v1:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  openActionToken(sealed: string, userId: string, kind: string): string {
    const parts = sealed.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new AuthMailDeliveryError(
        'OUTBOX_CIPHERTEXT_MALFORMED',
        'Outbox encrypted token payload has unrecognized format.',
        false,
      );
    }
    const iv = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const ciphertext = Buffer.from(parts[3], 'hex');
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAAD(Buffer.from(`${userId.toLowerCase()}:${kind}`, 'utf8'));
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf8');
  }

  private async enqueueDurableMail(input: {
    kind: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';
    userId: string;
    recipientEmail: string;
    recipientFullName: string;
    rawToken: string;
    tokenTtlSeconds: number;
    correlationId: string;
  }): Promise<{ outboxId: string; queuedToWorker: boolean }> {
    const safeCorrelationId = isValidUuid(input.correlationId)
      ? input.correlationId.trim().toLowerCase()
      : randomUUID();

    const encryptedActionToken = this.sealActionToken(input.rawToken, input.userId, input.kind);

    // 1. Persist durably in PostgreSQL BEFORE touching Redis/BullMQ so queue failures never lose mail
    const outboxId = await this.authRepo.enqueueEmailOutbox({
      kind: input.kind,
      userId: input.userId,
      recipientEmail: input.recipientEmail,
      recipientFullName: input.recipientFullName,
      encryptedActionToken,
      tokenTtlSeconds: input.tokenTtlSeconds,
      maxAttempts: this.config.auth.mail.maxAttempts,
      correlationId: safeCorrelationId,
    });

    // 2. Local/test dev-outbox preview strictly gated to explicit development/test environments
    if (this.config.auth.devOutboxEnabled && PERMITTED_DEV_OUTBOX_ENVS.has(this.config.nodeEnv)) {
      const actionUrl = this.buildActionUrl(input.kind, input.rawToken);
      const safeKey = this.toSafeOutboxKey(input.recipientEmail, input.kind);
      await this.redis
        .setAuthJson<DevOutboxPreviewMessage>(
          'dev_outbox',
          safeKey,
          {
            kind: input.kind,
            recipientEmail: input.recipientEmail,
            actionUrl,
            rawToken: input.rawToken,
            enqueuedAt: new Date().toISOString(),
          },
          Math.min(1800, Math.max(60, input.tokenTtlSeconds)),
        )
        .catch(() => undefined);
    }

    // 3. Push secret-free job reference onto BullMQ
    const jobPayload: AuthMailJobPayload = {
      outboxId,
      correlationId: safeCorrelationId,
    };

    try {
      await this.mailQueue.add(input.kind.toLowerCase(), jobPayload, {
        jobId: `outbox-${outboxId}-attempt-0`,
        removeOnComplete: 100,
        removeOnFail: 200,
      });
      return { outboxId, queuedToWorker: true };
    } catch (err) {
      const errorName = err instanceof Error ? err.name : 'QueueEnqueueError';
      this.logger.warn(
        `[${safeCorrelationId}] BullMQ enqueue unavailable for ${input.kind} outbox=${outboxId}; durable PostgreSQL outbox retained for recovery (${errorName}).`,
      );
      return { outboxId, queuedToWorker: false };
    }
  }

  private async executeClaimedDelivery(
    claimed: ClaimedEmailOutboxRecord,
  ): Promise<AuthMailDeliveryOutcome> {
    let rawToken: string | undefined;
    try {
      if (!claimed.encryptedActionToken) {
        throw new AuthMailDeliveryError(
          'OUTBOX_CIPHERTEXT_MISSING',
          'Claimed outbox item has no sealed token payload.',
          false,
        );
      }

      if (new Date(claimed.tokenExpiresAtIso).getTime() <= Date.now()) {
        const expiredStatus = await this.authRepo.failEmailOutboxDelivery({
          outboxId: claimed.outboxId,
          backoffSeconds: 1,
          errorCode: 'TOKEN_EXPIRED_BEFORE_SEND',
          errorRedacted: 'Underlying token expired prior to provider dispatch.',
          forceDeadLetter: true,
        });
        return {
          delivered: false,
          status: expiredStatus,
          outboxId: claimed.outboxId,
          errorCode: 'TOKEN_EXPIRED_BEFORE_SEND',
        };
      }

      rawToken = this.openActionToken(claimed.encryptedActionToken, claimed.userId, claimed.kind);
      const envelope = this.renderTransactionalEnvelope(claimed, rawToken);
      const result = await this.mailProvider.send(envelope);

      await this.authRepo.completeEmailOutboxDelivery(
        claimed.outboxId,
        result.provider,
        result.messageId,
      );

      // Log strictly non-secret delivery metadata (never rawToken or actionUrl)
      this.logger.log(
        `[${claimed.correlationId}] Delivered ${claimed.kind} outbox=${claimed.outboxId} via provider=${result.provider} messageId=${result.messageId}`,
      );

      return {
        delivered: true,
        status: 'SENT',
        outboxId: claimed.outboxId,
        provider: result.provider,
        providerMessageId: result.messageId,
      };
    } catch (err) {
      const errorCode =
        err instanceof AuthMailDeliveryError ? err.code : 'PROVIDER_UNEXPECTED_ERROR';
      const retryable = err instanceof AuthMailDeliveryError ? err.retryable : true;
      const backoffSeconds = this.computeBackoffSeconds(claimed.attemptCount);
      const errorRedacted = redactMailLogText(
        err instanceof Error ? err.message : String(err),
        rawToken,
      );

      const nextStatus = await this.authRepo.failEmailOutboxDelivery({
        outboxId: claimed.outboxId,
        backoffSeconds,
        errorCode,
        errorRedacted,
        forceDeadLetter: !retryable,
      });

      this.logger.warn(
        `[${claimed.correlationId}] Transactional ${claimed.kind} outbox=${claimed.outboxId} attempt=${claimed.attemptCount}/${claimed.maxAttempts} failed (${errorCode}) -> status=${nextStatus} nextBackoff=${backoffSeconds}s`,
      );

      if (nextStatus === 'FAILED_RETRYABLE') {
        await this.mailQueue
          .add(
            `${claimed.kind.toLowerCase()}-retry`,
            {
              outboxId: claimed.outboxId,
              correlationId: claimed.correlationId,
            } satisfies AuthMailJobPayload,
            {
              delay: backoffSeconds * 1000,
              jobId: `outbox-${claimed.outboxId}-attempt-${claimed.attemptCount}`,
              removeOnComplete: 100,
              removeOnFail: 200,
            },
          )
          .catch(() => undefined);
      }

      return {
        delivered: false,
        status: nextStatus,
        outboxId: claimed.outboxId,
        backoffSeconds,
        errorCode,
      };
    }
  }

  private buildActionUrl(
    kind: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
    rawToken: string,
  ): string {
    const baseUrl = this.config.brandingDefaults.websiteUrl.replace(/\/+$/, '');
    const route = kind === 'EMAIL_VERIFICATION' ? '/verify-email' : '/reset-password';
    return `${baseUrl}${route}?token=${encodeURIComponent(rawToken)}`;
  }

  private renderTransactionalEnvelope(
    claimed: ClaimedEmailOutboxRecord,
    rawToken: string,
  ): AuthTransactionalMailMessage {
    const productName = this.config.brandingDefaults.productName;
    const actionUrl = this.buildActionUrl(claimed.kind, rawToken);
    const safeName = escapeHtml(claimed.recipientFullName || 'User');
    const safeProduct = escapeHtml(productName);
    const safeHref = escapeHtml(actionUrl);

    if (claimed.kind === 'EMAIL_VERIFICATION') {
      return {
        outboxId: claimed.outboxId,
        correlationId: claimed.correlationId,
        kind: claimed.kind,
        fromEmail: this.config.auth.mail.fromEmail,
        fromName: this.config.auth.mail.fromName,
        toEmail: claimed.recipientEmail,
        toName: claimed.recipientFullName,
        subject: `Verify your ${productName} email address`,
        textBody: [
          `Hello ${claimed.recipientFullName},`,
          '',
          `Please verify your email address for ${productName} by opening the single-use link below:`,
          actionUrl,
          '',
          `This link expires at ${claimed.tokenExpiresAtIso}. If you did not create an account, you can ignore this message.`,
        ].join('\n'),
        htmlBody: [
          `<p>Hello ${safeName},</p>`,
          `<p>Please verify your email address for <strong>${safeProduct}</strong> using the single-use link below:</p>`,
          `<p><a href="${safeHref}">Verify Email Address</a></p>`,
          `<p>This link expires at <code>${escapeHtml(claimed.tokenExpiresAtIso)}</code>.</p>`,
        ].join('\n'),
      };
    }

    return {
      outboxId: claimed.outboxId,
      correlationId: claimed.correlationId,
      kind: claimed.kind,
      fromEmail: this.config.auth.mail.fromEmail,
      fromName: this.config.auth.mail.fromName,
      toEmail: claimed.recipientEmail,
      toName: claimed.recipientFullName,
      subject: `Reset your ${productName} password`,
      textBody: [
        `Hello ${claimed.recipientFullName},`,
        '',
        `A password reset was requested for your ${productName} account. Open the single-use link below to choose a new password:`,
        actionUrl,
        '',
        `This link expires at ${claimed.tokenExpiresAtIso}. Completing a password reset revokes all active sessions.`,
      ].join('\n'),
      htmlBody: [
        `<p>Hello ${safeName},</p>`,
        `<p>A password reset was requested for your <strong>${safeProduct}</strong> account:</p>`,
        `<p><a href="${safeHref}">Reset Password</a></p>`,
        `<p>This link expires at <code>${escapeHtml(claimed.tokenExpiresAtIso)}</code>.</p>`,
      ].join('\n'),
    };
  }

  private toSafeOutboxKey(
    email: string,
    kind: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
  ): string {
    const encoded = Buffer.from(email.trim().toLowerCase(), 'utf8')
      .toString('base64url')
      .slice(0, 80);
    return `${kind}:${encoded}`;
  }
}

@Processor(AUTH_TRANSACTIONAL_MAIL_QUEUE)
export class AuthTransactionalMailProcessor extends WorkerHost {
  constructor(private readonly outboxService: AuthMailOutboxService) {
    super();
  }

  async process(job: Job<AuthMailJobPayload>): Promise<AuthMailDeliveryOutcome> {
    return this.outboxService.deliverOutboxItem(job.data.outboxId);
  }
}
