import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  TenantAuditActorPlane,
  TenantAuditLogEntry,
  TenantAuditLogPagePayload,
  TenantAuditOutcome,
  TenantAuditResourceType,
} from '@ft360/shared-types';
import { isValidUuid } from '../../common/uuid.util';
import type { QueryExecutor } from '../../database/database.types';

export interface InsertTenantAuditLogParams {
  tenantId: string;
  eventType: string;
  resourceType: TenantAuditResourceType;
  resourceId?: string | null;
  outcome: TenantAuditOutcome;
  actorPlane: 'TENANT' | 'PLATFORM';
  actorUserId: string;
  actorMembershipId?: string | null;
  reason?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  correlationId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ListTenantAuditLogsFilter {
  tenantId: string;
  eventType?: string;
  resourceType?: TenantAuditResourceType;
  actorUserId?: string;
  fromIso?: string;
  toIso?: string;
  cursor?: string;
  limit?: number;
}

interface TenantAuditLogRow {
  id: string;
  tenant_id: string;
  event_type: string;
  resource_type: TenantAuditResourceType;
  resource_id: string | null;
  outcome: TenantAuditOutcome;
  actor_plane: TenantAuditActorPlane;
  actor_user_id: string | null;
  actor_membership_id: string | null;
  reason: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  correlation_id: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date | string;
}

interface DecodedAuditCursor {
  createdAtIso: string;
  id: string;
}

function toIso(val: Date | string): string {
  return val instanceof Date ? val.toISOString() : String(val);
}

export function encodeTenantAuditCursor(createdAtIso: string, id: string): string {
  return Buffer.from(JSON.stringify({ c: createdAtIso, id }), 'utf8').toString('base64url');
}

export function decodeTenantAuditCursor(cursorRaw: string): DecodedAuditCursor {
  try {
    const raw = Buffer.from(cursorRaw.trim(), 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as { c?: unknown; id?: unknown };
    if (
      typeof parsed?.c !== 'string' ||
      Number.isNaN(Date.parse(parsed.c)) ||
      typeof parsed?.id !== 'string' ||
      !isValidUuid(parsed.id)
    ) {
      throw new Error('Malformed cursor payload');
    }
    return {
      createdAtIso: new Date(parsed.c).toISOString(),
      id: parsed.id.trim().toLowerCase(),
    };
  } catch {
    throw new BadRequestException({
      code: 'INVALID_AUDIT_CURSOR',
      message: 'Pagination cursor is malformed or invalid.',
    });
  }
}

@Injectable()
export class TenantAuditRepository {
  async insertAuditLog(tx: QueryExecutor, input: InsertTenantAuditLogParams): Promise<string> {
    const res = await tx.query<{ audit_id: string }>(
      `SELECT public.fn_record_tenant_audit_log(
         $1::uuid,
         $2::varchar(80),
         $3::varchar(48),
         $4::varchar(16),
         $5::varchar(24),
         $6::uuid,
         $7::uuid,
         $8::uuid,
         $9::uuid,
         $10::varchar(500),
         $11::jsonb,
         $12::jsonb,
         $13::jsonb,
         $14::inet,
         $15::varchar(512)
       ) AS audit_id`,
      [
        input.tenantId,
        input.eventType.trim(),
        input.resourceType,
        input.outcome,
        input.actorPlane,
        input.correlationId,
        input.resourceId ?? null,
        input.actorUserId,
        input.actorMembershipId ?? null,
        input.reason ?? null,
        input.beforeState ? JSON.stringify(input.beforeState) : null,
        input.afterState ? JSON.stringify(input.afterState) : null,
        JSON.stringify(input.metadata ?? {}),
        input.ipAddress ?? null,
        input.userAgent ? input.userAgent.slice(0, 512) : null,
      ],
    );
    return res.rows[0].audit_id;
  }

  async listAuditLogs(
    tx: QueryExecutor,
    filter: ListTenantAuditLogsFilter,
  ): Promise<TenantAuditLogPagePayload> {
    const safeLimit = Math.min(100, Math.max(1, filter.limit ?? 50));
    const decodedCursor = filter.cursor ? decodeTenantAuditCursor(filter.cursor) : null;

    if (
      filter.fromIso &&
      filter.toIso &&
      new Date(filter.fromIso).getTime() > new Date(filter.toIso).getTime()
    ) {
      throw new BadRequestException({
        code: 'INVALID_AUDIT_DATE_RANGE',
        message: 'Query parameter `from` must be less than or equal to `to`.',
      });
    }

    const res = await tx.query<TenantAuditLogRow>(
      `SELECT
         id,
         tenant_id,
         event_type,
         resource_type,
         resource_id,
         outcome,
         actor_plane,
         actor_user_id,
         actor_membership_id,
         reason,
         before_state,
         after_state,
         metadata,
         correlation_id,
         host(ip_address) AS ip_address,
         user_agent,
         created_at
       FROM public.tenant_audit_logs
       WHERE tenant_id = $1::uuid
         AND ($2::varchar(80) IS NULL OR event_type = $2::varchar(80))
         AND ($3::varchar(48) IS NULL OR resource_type = $3::varchar(48))
         AND ($4::uuid IS NULL OR actor_user_id = $4::uuid)
         AND ($5::timestamptz IS NULL OR created_at >= $5::timestamptz)
         AND ($6::timestamptz IS NULL OR created_at <= $6::timestamptz)
         AND (
           $7::timestamptz IS NULL
           OR (created_at, id) < ($7::timestamptz, $8::uuid)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT $9`,
      [
        filter.tenantId.trim().toLowerCase(),
        filter.eventType?.trim() || null,
        filter.resourceType ?? null,
        filter.actorUserId?.trim().toLowerCase() || null,
        filter.fromIso ?? null,
        filter.toIso ?? null,
        decodedCursor?.createdAtIso ?? null,
        decodedCursor?.id ?? null,
        safeLimit + 1,
      ],
    );

    const hasMore = res.rows.length > safeLimit;
    const slice = hasMore ? res.rows.slice(0, safeLimit) : res.rows;
    const items = slice.map((row) => this.mapRow(row));
    const last = items.at(-1);

    return {
      items,
      nextCursor: hasMore && last ? encodeTenantAuditCursor(last.createdAt, last.id) : null,
    };
  }

  private mapRow(row: TenantAuditLogRow): TenantAuditLogEntry {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      eventType: row.event_type,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      outcome: row.outcome,
      actorPlane: row.actor_plane,
      actorUserId: row.actor_user_id,
      actorMembershipId: row.actor_membership_id,
      reason: row.reason,
      beforeState: row.before_state ?? null,
      afterState: row.after_state ?? null,
      metadata: row.metadata ?? {},
      correlationId: row.correlation_id,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      createdAt: toIso(row.created_at),
    };
  }
}
