import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { RedisService } from '../../cache/redis.service';
import { APP_CONFIG, type AppEnvConfig } from '../../config/env.config';

export const AUTH_TRANSACTIONAL_MAIL_QUEUE = 'auth-transactional-mail';

export interface AuthMailJobPayload {
  kind: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';
  recipientEmail: string;
  recipientFullName: string;
  actionUrl: string;
  correlationId: string;
}

export interface DevOutboxPreviewMessage {
  kind: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';
  recipientEmail: string;
  actionUrl: string;
  rawToken: string;
  enqueuedAt: string;
}

@Injectable()
export class AuthMailOutboxService {
  private readonly logger = new Logger(AuthMailOutboxService.name);

  constructor(
    @InjectQueue(AUTH_TRANSACTIONAL_MAIL_QUEUE) private readonly mailQueue: Queue,
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppEnvConfig,
  ) {}

  async enqueueEmailVerification(input: {
    email: string;
    fullName: string;
    rawToken: string;
    correlationId: string;
  }): Promise<void> {
    const baseUrl = this.config.brandingDefaults.websiteUrl.replace(/\/+$/, '');
    const actionUrl = `${baseUrl}/verify-email?token=${encodeURIComponent(input.rawToken)}`;
    await this.dispatch({
      kind: 'EMAIL_VERIFICATION',
      recipientEmail: input.email.trim().toLowerCase(),
      recipientFullName: input.fullName,
      actionUrl,
      rawToken: input.rawToken,
      correlationId: input.correlationId,
    });
  }

  async enqueuePasswordReset(input: {
    email: string;
    fullName: string;
    rawToken: string;
    correlationId: string;
  }): Promise<void> {
    const baseUrl = this.config.brandingDefaults.websiteUrl.replace(/\/+$/, '');
    const actionUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(input.rawToken)}`;
    await this.dispatch({
      kind: 'PASSWORD_RESET',
      recipientEmail: input.email.trim().toLowerCase(),
      recipientFullName: input.fullName,
      actionUrl,
      rawToken: input.rawToken,
      correlationId: input.correlationId,
    });
  }

  /**
   * Non-production local development & automated E2E outbox sink reader.
   * Strictly disabled in `production` (`404 RESOURCE_NOT_FOUND`).
   */
  async readLatestDevOutboxMessage(
    email: string,
    kind: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
  ): Promise<DevOutboxPreviewMessage | null> {
    if (this.config.nodeEnv === 'production' || !this.config.auth.devOutboxEnabled) {
      throw new NotFoundException({
        code: 'RESOURCE_NOT_FOUND',
        message: 'Requested endpoint is not available.',
      });
    }
    const safeKey = this.toSafeOutboxKey(email, kind);
    return this.redis.getAuthJson<DevOutboxPreviewMessage>('dev_outbox', safeKey);
  }

  private async dispatch(input: {
    kind: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';
    recipientEmail: string;
    recipientFullName: string;
    actionUrl: string;
    rawToken: string;
    correlationId: string;
  }): Promise<void> {
    if (this.config.nodeEnv !== 'production' && this.config.auth.devOutboxEnabled) {
      const safeKey = this.toSafeOutboxKey(input.recipientEmail, input.kind);
      await this.redis.setAuthJson<DevOutboxPreviewMessage>(
        'dev_outbox',
        safeKey,
        {
          kind: input.kind,
          recipientEmail: input.recipientEmail,
          actionUrl: input.actionUrl,
          rawToken: input.rawToken,
          enqueuedAt: new Date().toISOString(),
        },
        1800,
      );
    }

    const jobPayload: AuthMailJobPayload = {
      kind: input.kind,
      recipientEmail: input.recipientEmail,
      recipientFullName: input.recipientFullName,
      actionUrl: input.actionUrl,
      correlationId: input.correlationId,
    };

    try {
      await this.mailQueue.add(input.kind.toLowerCase(), jobPayload);
    } catch (err) {
      this.logger.warn(
        `[${input.correlationId}] Failed to enqueue ${input.kind} mail job: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
  private readonly logger = new Logger(AuthTransactionalMailProcessor.name);

  async process(job: Job<AuthMailJobPayload>): Promise<{ delivered: boolean; kind: string }> {
    // Log delivery metadata WITHOUT logging actionUrl or raw tokens
    this.logger.log(
      `[${job.data.correlationId}] Processed ${job.data.kind} mail job for ${job.data.recipientEmail}`,
    );
    return { delivered: true, kind: job.data.kind };
  }
}
