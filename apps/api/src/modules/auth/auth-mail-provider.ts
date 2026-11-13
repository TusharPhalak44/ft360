import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppEnvConfig, type AuthMailConfig } from '../../config/env.config';

export interface AuthTransactionalMailMessage {
  outboxId: string;
  correlationId: string;
  kind: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';
  fromEmail: string;
  fromName: string;
  toEmail: string;
  toName: string;
  subject: string;
  textBody: string;
  htmlBody: string;
}

export interface AuthMailProviderSendResult {
  provider: string;
  messageId: string;
}

export interface AuthMailProviderAdapter {
  readonly providerName: string;
  send(message: AuthTransactionalMailMessage): Promise<AuthMailProviderSendResult>;
}

export class AuthMailDeliveryError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = true) {
    super(message);
    this.name = 'AuthMailDeliveryError';
    this.code = code;
    this.retryable = retryable;
  }
}

function assertHeaderSafe(value: string, fieldName: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new AuthMailDeliveryError(
      'INVALID_MAIL_HEADER',
      `Mail header field "${fieldName}" contains prohibited control characters.`,
      false,
    );
  }
  return value.trim();
}

function dotStuffSmtpBody(raw: string): string {
  const crlfNormalized = raw.replace(/\r?\n/g, '\r\n');
  return crlfNormalized
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

/**
 * Safe default adapter when `AUTH_MAIL_PROVIDER=disabled`.
 * Never claims successful delivery; forces durable outbox retention until a real provider is configured.
 */
export class DisabledAuthMailProvider implements AuthMailProviderAdapter {
  readonly providerName = 'disabled';

  async send(): Promise<AuthMailProviderSendResult> {
    throw new AuthMailDeliveryError(
      'MAIL_PROVIDER_NOT_CONFIGURED',
      'Transactional mail provider is disabled (AUTH_MAIL_PROVIDER=disabled); message retained in durable outbox.',
      true,
    );
  }
}

/**
 * Local/automated-test in-memory sandbox adapter (`NODE_ENV` restricted to `development` | `test` at startup).
 * Stores accepted messages in memory without logging raw tokens or claiming external production delivery.
 */
export class SandboxAuthMailProvider implements AuthMailProviderAdapter {
  readonly providerName = 'sandbox';
  private readonly sentMessages: Array<
    AuthTransactionalMailMessage & { messageId: string; acceptedAt: string }
  > = [];

  async send(message: AuthTransactionalMailMessage): Promise<AuthMailProviderSendResult> {
    assertHeaderSafe(message.fromEmail, 'fromEmail');
    assertHeaderSafe(message.toEmail, 'toEmail');
    assertHeaderSafe(message.subject, 'subject');

    const messageId = `sandbox-${randomUUID()}`;
    this.sentMessages.push({
      ...message,
      messageId,
      acceptedAt: new Date().toISOString(),
    });
    if (this.sentMessages.length > 200) {
      this.sentMessages.shift();
    }

    return {
      provider: this.providerName,
      messageId,
    };
  }

  getAcceptedMessages(): ReadonlyArray<
    AuthTransactionalMailMessage & { messageId: string; acceptedAt: string }
  > {
    return this.sentMessages;
  }

  clear(): void {
    this.sentMessages.length = 0;
  }
}

/**
 * Configurable HTTP(S) transactional email API webhook adapter (`AUTH_MAIL_PROVIDER=webhook`).
 */
export class HttpWebhookAuthMailProvider implements AuthMailProviderAdapter {
  readonly providerName = 'webhook';

  constructor(private readonly webhookConfig: AuthMailConfig['webhook']) {}

  async send(message: AuthTransactionalMailMessage): Promise<AuthMailProviderSendResult> {
    const url = this.webhookConfig.url;
    if (!url) {
      throw new AuthMailDeliveryError(
        'WEBHOOK_URL_MISSING',
        'Webhook mail provider URL is not configured.',
        true,
      );
    }

    assertHeaderSafe(message.fromEmail, 'fromEmail');
    assertHeaderSafe(message.toEmail, 'toEmail');
    assertHeaderSafe(message.subject, 'subject');

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Idempotency-Key': message.outboxId,
          'X-Correlation-Id': message.correlationId,
          ...(this.webhookConfig.bearerToken
            ? { Authorization: `Bearer ${this.webhookConfig.bearerToken}` }
            : {}),
        },
        body: JSON.stringify({
          outboxId: message.outboxId,
          category: message.kind,
          from: { email: message.fromEmail, name: message.fromName },
          to: [{ email: message.toEmail, name: message.toName }],
          subject: message.subject,
          text: message.textBody,
          html: message.htmlBody,
        }),
        signal: AbortSignal.timeout(this.webhookConfig.timeoutMs),
      });
    } catch (err) {
      throw new AuthMailDeliveryError(
        'WEBHOOK_NETWORK_ERROR',
        `Transactional mail webhook transport error: ${err instanceof Error ? err.name : 'NetworkError'}.`,
        true,
      );
    }

    if (!response.ok) {
      const retryable =
        response.status === 408 || response.status === 429 || response.status >= 500;
      throw new AuthMailDeliveryError(
        `WEBHOOK_HTTP_${response.status}`,
        `Transactional mail webhook rejected delivery with HTTP status ${response.status}.`,
        retryable,
      );
    }

    const headerMsgId = response.headers.get('x-message-id')?.trim();
    const jsonBody = (await response.json().catch(() => null)) as
      | { id?: string; messageId?: string }
      | null;
    const providerMessageId =
      jsonBody?.messageId?.trim() ||
      jsonBody?.id?.trim() ||
      headerMsgId ||
      `webhook-${response.status}-${message.outboxId}`;

    return {
      provider: this.providerName,
      messageId: providerMessageId.slice(0, 255),
    };
  }
}

/**
 * Standards-compliant RFC 5321 SMTP provider adapter (`AUTH_MAIL_PROVIDER=smtp`) built on `node:net` / `node:tls`.
 * Supports implicit TLS (`465`), explicit `STARTTLS`, `AUTH PLAIN`, and `250` acceptance verification.
 */
export class SmtpAuthMailProvider implements AuthMailProviderAdapter {
  readonly providerName = 'smtp';

  constructor(private readonly smtpConfig: AuthMailConfig['smtp']) {}

  async send(message: AuthTransactionalMailMessage): Promise<AuthMailProviderSendResult> {
    const fromEmail = assertHeaderSafe(message.fromEmail, 'fromEmail');
    const fromName = assertHeaderSafe(message.fromName, 'fromName').replace(/"/g, '');
    const toEmail = assertHeaderSafe(message.toEmail, 'toEmail');
    const toName = assertHeaderSafe(message.toName, 'toName').replace(/"/g, '');
    const subject = assertHeaderSafe(message.subject, 'subject');

    const socket = await this.openSocket();
    let activeSocket: net.Socket | tls.TLSSocket = socket;

    try {
      const greeting = await this.readSmtpResponse(activeSocket);
      this.assertExpectedCode(greeting, [220], 'SMTP_GREETING_FAILED');

      let ehlo = await this.sendCommand(activeSocket, 'EHLO ft360.local', [250], 'SMTP_EHLO_FAILED');

      const advertisesStartTls = /STARTTLS/i.test(ehlo.text);
      if (!this.smtpConfig.secure && (this.smtpConfig.requireTls || advertisesStartTls)) {
        if (this.smtpConfig.requireTls && !advertisesStartTls) {
          throw new AuthMailDeliveryError(
            'SMTP_STARTTLS_UNSUPPORTED',
            'SMTP server did not advertise required STARTTLS capability.',
            true,
          );
        }
        if (advertisesStartTls) {
          await this.sendCommand(activeSocket, 'STARTTLS', [220], 'SMTP_STARTTLS_FAILED');
          activeSocket = await this.upgradeToTls(activeSocket);
          ehlo = await this.sendCommand(
            activeSocket,
            'EHLO ft360.local',
            [250],
            'SMTP_TLS_EHLO_FAILED',
          );
        }
      }

      if (this.smtpConfig.user && this.smtpConfig.password !== undefined) {
        const authToken = Buffer.from(
          `\0${this.smtpConfig.user}\0${this.smtpConfig.password}`,
          'utf8',
        ).toString('base64');
        await this.sendCommand(
          activeSocket,
          `AUTH PLAIN ${authToken}`,
          [235],
          'SMTP_AUTH_FAILED',
          false,
        );
      }

      await this.sendCommand(
        activeSocket,
        `MAIL FROM:<${fromEmail}>`,
        [250],
        'SMTP_MAIL_FROM_REJECTED',
      );
      await this.sendCommand(
        activeSocket,
        `RCPT TO:<${toEmail}>`,
        [250, 251],
        'SMTP_RCPT_TO_REJECTED',
      );
      await this.sendCommand(activeSocket, 'DATA', [354], 'SMTP_DATA_REJECTED');

      const boundary = `ft360_${message.outboxId.replace(/-/g, '')}`;
      const rfcMessageId = `<${message.outboxId}@ft360.mail>`;
      const mimeLines = [
        `From: "${fromName}" <${fromEmail}>`,
        `To: "${toName}" <${toEmail}>`,
        `Subject: ${subject}`,
        `Message-ID: ${rfcMessageId}`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        message.textBody,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        message.htmlBody,
        '',
        `--${boundary}--`,
      ].join('\r\n');

      const dataPayload = `${dotStuffSmtpBody(mimeLines)}\r\n.\r\n`;
      const accepted = await this.writeRawAndRead(activeSocket, dataPayload);
      this.assertExpectedCode(accepted, [250], 'SMTP_MESSAGE_REJECTED');

      await this.sendCommand(activeSocket, 'QUIT', [221, 250], 'SMTP_QUIT_WARN').catch(() => null);

      const queueMatch = accepted.text.match(/\bqueued as\s+([A-Za-z0-9._-]+)/i);
      return {
        provider: this.providerName,
        messageId: queueMatch ? queueMatch[1].slice(0, 255) : rfcMessageId,
      };
    } finally {
      activeSocket.destroy();
    }
  }

  private openSocket(): Promise<net.Socket | tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        reject(
          new AuthMailDeliveryError(
            'SMTP_CONNECT_FAILED',
            `Unable to connect to SMTP host (${err.name}).`,
            true,
          ),
        );
      };

      const sock = this.smtpConfig.secure
        ? tls.connect(
            {
              host: this.smtpConfig.host,
              port: this.smtpConfig.port,
              servername: this.smtpConfig.host,
            },
            () => {
              sock.removeListener('error', onError);
              resolve(sock);
            },
          )
        : net.connect(
            {
              host: this.smtpConfig.host,
              port: this.smtpConfig.port,
            },
            () => {
              sock.removeListener('error', onError);
              resolve(sock);
            },
          );

      sock.setTimeout(this.smtpConfig.timeoutMs, () => {
        sock.destroy();
        reject(
          new AuthMailDeliveryError(
            'SMTP_TIMEOUT',
            'SMTP socket operation timed out before completion.',
            true,
          ),
        );
      });
      sock.once('error', onError);
    });
  }

  private upgradeToTls(plainSocket: net.Socket): Promise<tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const tlsSock = tls.connect(
        {
          socket: plainSocket,
          servername: this.smtpConfig.host,
        },
        () => resolve(tlsSock),
      );
      tlsSock.setTimeout(this.smtpConfig.timeoutMs, () => {
        tlsSock.destroy();
        reject(new AuthMailDeliveryError('SMTP_TLS_TIMEOUT', 'SMTP STARTTLS handshake timed out.', true));
      });
      tlsSock.once('error', (err) => {
        reject(
          new AuthMailDeliveryError(
            'SMTP_TLS_HANDSHAKE_FAILED',
            `SMTP STARTTLS handshake failed (${err.name}).`,
            true,
          ),
        );
      });
    });
  }

  private async sendCommand(
    socket: net.Socket | tls.TLSSocket,
    command: string,
    expectedCodes: number[],
    errorCode: string,
    defaultRetryable?: boolean,
  ): Promise<{ code: number; text: string }> {
    const res = await this.writeRawAndRead(socket, `${command}\r\n`);
    this.assertExpectedCode(res, expectedCodes, errorCode, defaultRetryable);
    return res;
  }

  private writeRawAndRead(
    socket: net.Socket | tls.TLSSocket,
    payload: string,
  ): Promise<{ code: number; text: string }> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        reject(
          new AuthMailDeliveryError(
            'SMTP_IO_ERROR',
            `SMTP socket I/O error (${err.name}).`,
            true,
          ),
        );
      };
      socket.once('error', onError);
      socket.write(payload, 'utf8', (writeErr) => {
        if (writeErr) {
          socket.removeListener('error', onError);
          onError(writeErr);
          return;
        }
        this.readSmtpResponse(socket)
          .then((resp) => {
            socket.removeListener('error', onError);
            resolve(resp);
          })
          .catch((readErr) => {
            socket.removeListener('error', onError);
            reject(readErr);
          });
      });
    });
  }

  private readSmtpResponse(
    socket: net.Socket | tls.TLSSocket,
  ): Promise<{ code: number; text: string }> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      const lines: string[] = [];

      const cleanup = () => {
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
      };

      const onError = (err: Error) => {
        cleanup();
        reject(
          new AuthMailDeliveryError(
            'SMTP_READ_ERROR',
            `SMTP response read error (${err.name}).`,
            true,
          ),
        );
      };

      const onClose = () => {
        cleanup();
        reject(
          new AuthMailDeliveryError(
            'SMTP_CONNECTION_CLOSED',
            'SMTP server closed connection unexpectedly.',
            true,
          ),
        );
      };

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let idx = buffer.indexOf('\n');
        while (idx !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          lines.push(line);
          // Multi-line SMTP responses have '-' at index 3 (e.g. "250-PIPELINING"), final line has ' ' or end-of-line ("250 OK")
          if (/^\d{3}(?:\s|$)/.test(line)) {
            cleanup();
            const code = Number.parseInt(line.slice(0, 3), 10);
            resolve({ code, text: lines.join('\n') });
            return;
          }
          idx = buffer.indexOf('\n');
        }
      };

      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('close', onClose);
    });
  }

  private assertExpectedCode(
    res: { code: number; text: string },
    expected: number[],
    errorCode: string,
    overrideRetryable?: boolean,
  ): void {
    if (!expected.includes(res.code)) {
      const retryable =
        overrideRetryable !== undefined ? overrideRetryable : res.code >= 400 && res.code < 500;
      throw new AuthMailDeliveryError(
        errorCode,
        `SMTP server returned unexpected status code ${res.code}.`,
        retryable,
      );
    }
  }
}

export const AUTH_MAIL_PROVIDER = Symbol('AUTH_MAIL_PROVIDER');

export function createAuthMailProviderFromConfig(mailConfig: AuthMailConfig): AuthMailProviderAdapter {
  switch (mailConfig.provider) {
    case 'smtp':
      return new SmtpAuthMailProvider(mailConfig.smtp);
    case 'webhook':
      return new HttpWebhookAuthMailProvider(mailConfig.webhook);
    case 'sandbox':
      return new SandboxAuthMailProvider();
    case 'disabled':
    default:
      return new DisabledAuthMailProvider();
  }
}

@Injectable()
export class ConfiguredAuthMailProvider implements AuthMailProviderAdapter {
  private readonly delegate: AuthMailProviderAdapter;

  constructor(@Inject(APP_CONFIG) config: AppEnvConfig) {
    this.delegate = createAuthMailProviderFromConfig(config.auth.mail);
  }

  get providerName(): string {
    return this.delegate.providerName;
  }

  getUnderlyingAdapter(): AuthMailProviderAdapter {
    return this.delegate;
  }

  send(message: AuthTransactionalMailMessage): Promise<AuthMailProviderSendResult> {
    return this.delegate.send(message);
  }
}
