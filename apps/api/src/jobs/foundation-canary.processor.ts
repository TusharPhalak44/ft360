import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { TenantTransactionManager } from '../database/tenant-transaction.manager';
import { verifyTenantJobEnvelope } from './tenant-job-envelope';

export const SYSTEM_MAINTENANCE_QUEUE = 'system-maintenance';

export interface CanaryJobPayload {
  probeLabel: string;
  simulateFailure?: boolean;
}

export interface CanaryJobResult {
  insertedId: string;
  tenantId: string;
  probeLabel: string;
}

@Injectable()
@Processor(SYSTEM_MAINTENANCE_QUEUE)
export class FoundationCanaryProcessor extends WorkerHost {
  constructor(private readonly txManager: TenantTransactionManager) {
    super();
  }

  async process(job: Job<unknown, CanaryJobResult, string>): Promise<CanaryJobResult> {
    const envelope = verifyTenantJobEnvelope<CanaryJobPayload>(job.data);
    const probeLabel = envelope.payload?.probeLabel?.trim();
    if (!probeLabel) {
      throw new Error('Canary job rejected: probeLabel is required.');
    }

    return this.txManager.withTenantTransaction(
      {
        tenantId: envelope.tenantId,
        actorUserId: envelope.actorUserId,
        correlationId: envelope.correlationId,
      },
      async (tx) => {
        const inserted = await tx.query<{ id: string; tenant_id: string }>(
          `INSERT INTO public.rls_isolation_canary (tenant_id, probe_label)
           VALUES ($1, $2)
           RETURNING id, tenant_id`,
          [envelope.tenantId, probeLabel],
        );

        if (envelope.payload.simulateFailure) {
          throw new Error('Simulated BullMQ worker failure: transaction must roll back cleanly.');
        }

        return {
          insertedId: inserted.rows[0].id,
          tenantId: inserted.rows[0].tenant_id,
          probeLabel,
        };
      },
    );
  }
}

