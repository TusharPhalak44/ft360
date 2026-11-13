import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AuthAuditOutcome } from '@ft360/shared-types';
import { isValidUuid } from '../../common/uuid.util';
import type { QueryExecutor } from '../../database/database.types';
import { AuthRepository } from './auth.repository';

const FORBIDDEN_SECRET_METADATA_KEY =
  /^(password|passwordhash|password_hash|refreshtoken|refresh_token|refreshtokenhash|refresh_token_hash|accesstoken|access_token|csrfsecret|csrf_secret|csrfsecrethash|csrf_secret_hash|rawtoken|token|secret)$/i;

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

  sanitizeMetadata(raw?: Record<string, unknown>): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {};
    }
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (FORBIDDEN_SECRET_METADATA_KEY.test(key)) {
        continue;
      }
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        cleaned[key] = this.sanitizeMetadata(value as Record<string, unknown>);
      } else {
        cleaned[key] = value;
      }
    }
    return cleaned;
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
