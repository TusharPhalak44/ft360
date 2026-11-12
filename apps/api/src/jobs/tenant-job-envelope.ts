import type { VerifiedTenantContext } from '@ft360/shared-types';
import { assertValidUuid } from '../common/uuid.util';

export interface BaseTenantJobEnvelope<TPayload> {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly enqueuedAt: string;
  readonly payload: TPayload;
}

/**
 * Wraps and validates any background job payload with an immutable verified tenant envelope
 * so BullMQ workers can never execute tenant jobs without verified isolation metadata.
 */
export function createTenantJobEnvelope<TPayload>(
  ctx: VerifiedTenantContext,
  payload: TPayload,
): BaseTenantJobEnvelope<TPayload> {
  const tenantId = assertValidUuid(ctx.tenantId, 'job.tenantId');
  const actorUserId = assertValidUuid(ctx.actorUserId, 'job.actorUserId');
  const correlationId = assertValidUuid(ctx.correlationId, 'job.correlationId');

  return Object.freeze({
    tenantId,
    actorUserId,
    correlationId,
    enqueuedAt: new Date().toISOString(),
    payload,
  });
}

export function verifyTenantJobEnvelope<TPayload>(
  raw: unknown,
): BaseTenantJobEnvelope<TPayload> {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Rejected BullMQ job: missing tenant job envelope.');
  }
  const obj = raw as Record<string, unknown>;
  const tenantId = assertValidUuid(obj.tenantId, 'job.tenantId');
  const actorUserId = assertValidUuid(obj.actorUserId, 'job.actorUserId');
  const correlationId = assertValidUuid(obj.correlationId, 'job.correlationId');

  return {
    tenantId,
    actorUserId,
    correlationId,
    enqueuedAt: typeof obj.enqueuedAt === 'string' ? obj.enqueuedAt : new Date().toISOString(),
    payload: obj.payload as TPayload,
  };
}

