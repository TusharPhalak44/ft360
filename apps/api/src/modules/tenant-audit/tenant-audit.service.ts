import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type {
  TenantAuditLogPagePayload,
  TenantAuditOutcome,
  TenantAuditResourceType,
  VerifiedTenantContext,
} from '@ft360/shared-types';
import { isValidUuid } from '../../common/uuid.util';
import { InvalidTenantContextError, type QueryExecutor } from '../../database/database.types';
import { TenantTransactionManager } from '../../database/tenant-transaction.manager';
import { isForbiddenAuditSecretKey } from '../auth/auth-audit.service';
import type { ListTenantAuditLogsQueryDto } from './tenant-audit.dto';
import { TenantAuditRepository } from './tenant-audit.repository';

export interface RecordTenantDomainAuditInput {
  eventType: string;
  resourceType: TenantAuditResourceType;
  resourceId?: string | null;
  outcome?: TenantAuditOutcome;
  reason?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface RecordPlatformTenantAuditInput extends RecordTenantDomainAuditInput {
  tenantId: string;
  actorUserId: string;
  correlationId: string;
}

export interface ComputedFieldDiff {
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  changedFields: string[];
}

@Injectable()
export class TenantAuditService {
  constructor(
    private readonly repo: TenantAuditRepository,
    private readonly txManager: TenantTransactionManager,
  ) {}

  /**
   * Recursively validates JSON payloads (`beforeState`, `afterState`, `metadata`) across
   * nested objects and arrays and explicitly REJECTS any payload containing a forbidden
   * credential, token, cookie, or secret key before hitting PostgreSQL (`chk_tal_no_secret_keys`).
   */
  assertNoForbiddenSecretKeys(
    payload: Record<string, unknown> | null | undefined,
    fieldName = 'metadata',
  ): void {
    if (payload === null || payload === undefined) {
      return;
    }
    if (typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestException({
        code: 'INVALID_AUDIT_STATE_OBJECT',
        message: `Audit ${fieldName} must be a plain JSON object.`,
      });
    }
    this.walkAndRejectSecrets(payload, fieldName, 0);
  }

  /**
   * Computes minimal `beforeState` and `afterState` snapshots containing only keys
   * whose values actually mutated between `before` and `after`.
   */
  computeFieldDiff(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): ComputedFieldDiff {
    this.assertNoForbiddenSecretKeys(before, 'beforeState');
    this.assertNoForbiddenSecretKeys(after, 'afterState');

    const allKeys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
    const beforeDiff: Record<string, unknown> = {};
    const afterDiff: Record<string, unknown> = {};
    const changedFields: string[] = [];

    for (const key of allKeys) {
      const prevVal = before[key] ?? null;
      const nextVal = after[key] ?? null;
      if (!this.areJsonValuesEqual(prevVal, nextVal)) {
        beforeDiff[key] = this.normalizeJsonValue(prevVal, 0);
        afterDiff[key] = this.normalizeJsonValue(nextVal, 0);
        changedFields.push(key);
      }
    }

    if (changedFields.length === 0) {
      return {
        beforeState: null,
        afterState: null,
        changedFields: [],
      };
    }

    return {
      beforeState: beforeDiff,
      afterState: afterDiff,
      changedFields,
    };
  }

  /**
   * Records a single-tenant workspace domain event (`actorPlane = 'TENANT'`) inside
   * the caller's active `withVerifiedMemberTransaction` (`tx`).
   */
  async recordTenantEvent(
    tx: QueryExecutor,
    ctx: VerifiedTenantContext,
    input: RecordTenantDomainAuditInput,
  ): Promise<string> {
    if (!ctx || !isValidUuid(ctx.tenantId) || !isValidUuid(ctx.actorUserId)) {
      throw new InvalidTenantContextError(
        'TenantAuditService requires a server-verified tenantId and actorUserId.',
      );
    }
    if (!isValidUuid(ctx.correlationId)) {
      throw new BadRequestException({
        code: 'INVALID_CORRELATION_ID',
        message: 'Tenant audit logging requires a valid canonical UUID correlationId.',
      });
    }

    const trimmedEvent = input.eventType?.trim() ?? '';
    if (!trimmedEvent) {
      throw new BadRequestException({
        code: 'INVALID_AUDIT_EVENT_TYPE',
        message: 'Tenant audit eventType must be non-empty.',
      });
    }
    if (trimmedEvent.toUpperCase().startsWith('PLATFORM_')) {
      throw new ForbiddenException({
        code: 'INVALID_TENANT_AUDIT_PLANE',
        message: 'PLATFORM_* audit events cannot be recorded from a tenant workspace plane.',
      });
    }
    if (input.resourceId !== undefined && input.resourceId !== null && !isValidUuid(input.resourceId)) {
      throw new BadRequestException({
        code: 'INVALID_AUDIT_RESOURCE_ID',
        message: 'Audit resourceId must be a valid UUID when provided.',
      });
    }

    this.assertNoForbiddenSecretKeys(input.beforeState, 'beforeState');
    this.assertNoForbiddenSecretKeys(input.afterState, 'afterState');
    this.assertNoForbiddenSecretKeys(input.metadata, 'metadata');

    return this.repo.insertAuditLog(tx, {
      tenantId: ctx.tenantId.trim().toLowerCase(),
      eventType: trimmedEvent,
      resourceType: input.resourceType,
      resourceId: input.resourceId ? input.resourceId.trim().toLowerCase() : null,
      outcome: input.outcome ?? 'SUCCESS',
      actorPlane: 'TENANT',
      actorUserId: ctx.actorUserId.trim().toLowerCase(),
      actorMembershipId: isValidUuid(ctx.membershipId)
        ? ctx.membershipId.trim().toLowerCase()
        : null,
      reason: input.reason?.trim() || null,
      beforeState: input.beforeState
        ? (this.normalizeJsonValue(input.beforeState, 0) as Record<string, unknown>)
        : null,
      afterState: input.afterState
        ? (this.normalizeJsonValue(input.afterState, 0) as Record<string, unknown>)
        : null,
      metadata: input.metadata
        ? (this.normalizeJsonValue(input.metadata, 0) as Record<string, unknown>)
        : {},
      correlationId: ctx.correlationId.trim().toLowerCase(),
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
  }

  /**
   * Records a Platform Super Admin tenant governance event (`actorPlane = 'PLATFORM'`)
   * inside the caller's `withPlatformAdminTransaction` (`tx`).
   */
  async recordPlatformTenantEvent(
    tx: QueryExecutor,
    input: RecordPlatformTenantAuditInput,
  ): Promise<string> {
    if (!isValidUuid(input.tenantId) || !isValidUuid(input.actorUserId)) {
      throw new BadRequestException({
        code: 'INVALID_PLATFORM_AUDIT_TARGET',
        message: 'Platform tenant audit logging requires valid tenantId and actorUserId UUIDs.',
      });
    }
    if (!isValidUuid(input.correlationId)) {
      throw new BadRequestException({
        code: 'INVALID_CORRELATION_ID',
        message: 'Platform tenant audit logging requires a valid canonical UUID correlationId.',
      });
    }

    const trimmedEvent = input.eventType?.trim() ?? '';
    if (!trimmedEvent) {
      throw new BadRequestException({
        code: 'INVALID_AUDIT_EVENT_TYPE',
        message: 'Platform tenant audit eventType must be non-empty.',
      });
    }

    this.assertNoForbiddenSecretKeys(input.beforeState, 'beforeState');
    this.assertNoForbiddenSecretKeys(input.afterState, 'afterState');
    this.assertNoForbiddenSecretKeys(input.metadata, 'metadata');

    return this.repo.insertAuditLog(tx, {
      tenantId: input.tenantId.trim().toLowerCase(),
      eventType: trimmedEvent,
      resourceType: input.resourceType,
      resourceId: input.resourceId ? input.resourceId.trim().toLowerCase() : null,
      outcome: input.outcome ?? 'SUCCESS',
      actorPlane: 'PLATFORM',
      actorUserId: input.actorUserId.trim().toLowerCase(),
      actorMembershipId: null,
      reason: input.reason?.trim() || null,
      beforeState: input.beforeState
        ? (this.normalizeJsonValue(input.beforeState, 0) as Record<string, unknown>)
        : null,
      afterState: input.afterState
        ? (this.normalizeJsonValue(input.afterState, 0) as Record<string, unknown>)
        : null,
      metadata: input.metadata
        ? (this.normalizeJsonValue(input.metadata, 0) as Record<string, unknown>)
        : {},
      correlationId: input.correlationId.trim().toLowerCase(),
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
  }

  /**
   * Lists append-only `tenant_audit_logs` within the verified active workspace context
   * (`FORCE RLS` guarantees strict single-tenant isolation).
   */
  async listWorkspaceAuditLogs(
    ctx: VerifiedTenantContext,
    query: ListTenantAuditLogsQueryDto,
  ): Promise<TenantAuditLogPagePayload> {
    return this.txManager.withVerifiedMemberTransaction(ctx, (tx) =>
      this.repo.listAuditLogs(tx, {
        tenantId: ctx.tenantId,
        eventType: query.eventType,
        resourceType: query.resourceType,
        actorUserId: query.actorUserId,
        fromIso: query.from,
        toIso: query.to,
        cursor: query.cursor,
        limit: query.limit,
      }),
    );
  }

  /**
   * Lists `tenant_audit_logs` for a specific tenant inside a verified Platform Super Admin
   * control-plane transaction.
   */
  async listPlatformTenantAuditLogs(
    actorSuperAdminUserId: string,
    targetTenantId: string,
    query: ListTenantAuditLogsQueryDto,
  ): Promise<TenantAuditLogPagePayload> {
    if (!isValidUuid(targetTenantId)) {
      throw new BadRequestException({
        code: 'INVALID_TENANT_ID',
        message: 'Target tenantId must be a valid UUID.',
      });
    }

    return this.txManager.withPlatformAdminTransaction(actorSuperAdminUserId, (tx) =>
      this.repo.listAuditLogs(tx, {
        tenantId: targetTenantId,
        eventType: query.eventType,
        resourceType: query.resourceType,
        actorUserId: query.actorUserId,
        fromIso: query.from,
        toIso: query.to,
        cursor: query.cursor,
        limit: query.limit,
      }),
    );
  }

  private walkAndRejectSecrets(value: unknown, pathLabel: string, depth: number): void {
    if (depth > 16) {
      throw new BadRequestException({
        code: 'AUDIT_PAYLOAD_MAX_DEPTH_EXCEEDED',
        message: `Audit payload ${pathLabel} exceeds maximum nesting depth of 16.`,
      });
    }
    if (value === null || value === undefined || typeof value !== 'object') {
      return;
    }
    if (value instanceof Date) {
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        this.walkAndRejectSecrets(value[i], `${pathLabel}[${i}]`, depth + 1);
      }
      return;
    }

    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (isForbiddenAuditSecretKey(key)) {
        throw new BadRequestException({
          code: 'AUDIT_SECRET_KEY_REJECTED',
          message: `Audit payload rejected: forbidden sensitive key '${key}' detected in ${pathLabel}.`,
        });
      }
      this.walkAndRejectSecrets(nested, `${pathLabel}.${key}`, depth + 1);
    }
  }

  private normalizeJsonValue(value: unknown, depth: number): unknown {
    if (depth > 16 || value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeJsonValue(item, depth + 1));
    }
    if (typeof value === 'object') {
      const normalized: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        const v = (value as Record<string, unknown>)[k];
        if (v !== undefined) {
          normalized[k] = this.normalizeJsonValue(v, depth + 1);
        }
      }
      return normalized;
    }
    return String(value);
  }

  private areJsonValuesEqual(a: unknown, b: unknown): boolean {
    return (
      JSON.stringify(this.normalizeJsonValue(a, 0)) ===
      JSON.stringify(this.normalizeJsonValue(b, 0))
    );
  }
}
