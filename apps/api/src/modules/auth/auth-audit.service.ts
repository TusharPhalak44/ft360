import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AuthAuditOutcome } from '@ft360/shared-types';
import { isValidUuid } from '../../common/uuid.util';
import type { QueryExecutor } from '../../database/database.types';
import { AuthRepository } from './auth.repository';

/**
 * Canonical normalized secret-bearing key set matching PostgreSQL's
 * `public.fn_jsonb_has_forbidden_secret_key` (`lower` + strip `[\s_-]+`).
 */
const FORBIDDEN_NORMALIZED_SECRET_KEYS = new Set([
  'password',
  'passwd',
  'pwd',
  'passwordhash',
  'newpassword',
  'oldpassword',
  'currentpassword',
  'accesstoken',
  'refreshtoken',
  'refreshtokenhash',
  'previousrefreshtokenhash',
  'csrfsecret',
  'csrfsecrethash',
  'csrftoken',
  'rawtoken',
  'token',
  'tokenhash',
  'verifytoken',
  'verificationtoken',
  'resettoken',
  'encryptedactiontoken',
  'actionurl',
  'secret',
  'clientsecret',
  'apikey',
  'privatekey',
  'authorization',
  'cookie',
  'setcookie',
]);

export function isForbiddenAuditSecretKey(rawKey: string): boolean {
  const normalized = rawKey.toLowerCase().replace(/[\s_-]+/g, '');
  return FORBIDDEN_NORMALIZED_SECRET_KEYS.has(normalized);
}

export interface RecordAuthAuditInput {
  eventType: string;
  outcome: AuthAuditOutcome;
  correlationId?: string | null;
  actorUserId?: string | null;
  targetUserId?: string | null;
  tenantId?: string | null;
  sessionId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
  tx?: QueryExecutor;
}

@Injectable()
export class AuthAuditService {
  constructor(private readonly authRepo: AuthRepository) {}

  /**
   * Recursively sanitizes objects, arrays, and nested combinations so password,
   * access-token, refresh-token, CSRF-secret, raw-token, and equivalent secret-bearing
   * keys are stripped at every nesting depth before reaching PostgreSQL.
   */
  sanitizeMetadata(raw?: Record<string, unknown>): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {};
    }
    return this.sanitizeValue(raw, 0) as Record<string, unknown>;
  }

  private sanitizeValue(value: unknown, depth: number): unknown {
    if (depth > 16) {
      return '[MAX_DEPTH_TRUNCATED]';
    }
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (Array.isArray(value)) {
      return value.map((elem) => this.sanitizeValue(elem, depth + 1));
    }
    if (typeof value === 'object') {
      const cleaned: Record<string, unknown> = {};
      for (const [key, nestedVal] of Object.entries(value as Record<string, unknown>)) {
        if (isForbiddenAuditSecretKey(key)) {
          continue;
        }
        if (nestedVal === undefined) {
          continue;
        }
        cleaned[key] = this.sanitizeValue(nestedVal, depth + 1);
      }
      return cleaned;
    }
    return String(value);
  }

  async record(input: RecordAuthAuditInput): Promise<string> {
    const safeCorrelationId = isValidUuid(input.correlationId)
      ? input.correlationId.trim().toLowerCase()
      : randomUUID();

    return this.authRepo.insertAuditLog({
      eventType: input.eventType,
      outcome: input.outcome,
      correlationId: safeCorrelationId,
      actorUserId: isValidUuid(input.actorUserId) ? input.actorUserId.trim().toLowerCase() : null,
      targetUserId: isValidUuid(input.targetUserId)
        ? input.targetUserId.trim().toLowerCase()
        : null,
      tenantId: isValidUuid(input.tenantId) ? input.tenantId.trim().toLowerCase() : null,
      sessionId: isValidUuid(input.sessionId) ? input.sessionId.trim().toLowerCase() : null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      metadata: this.sanitizeMetadata(input.metadata),
      tx: input.tx,
    });
  }
}
