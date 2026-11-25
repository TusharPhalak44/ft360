import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  TenantSettingsPayload,
  VerifiedTenantContext,
} from '@ft360/shared-types';
import { RedisService } from '../../cache/redis.service';
import { TenantTransactionManager } from '../../database/tenant-transaction.manager';
import { TenantAuditService } from '../tenant-audit/tenant-audit.service';
import type { UpdateOrganizationSettingsDto } from './organization-settings.dto';
import {
  OrganizationSettingsRepository,
  type TenantSettingsRow,
} from './organization-settings.repository';

const SETTINGS_CACHE_NAMESPACE = 'settings';
const SETTINGS_CACHE_KEY = 'active';
const SETTINGS_CACHE_TTL_SECONDS = 300;

@Injectable()
export class OrganizationSettingsService {
  private readonly logger = new Logger(OrganizationSettingsService.name);

  constructor(
    private readonly repo: OrganizationSettingsRepository,
    private readonly txManager: TenantTransactionManager,
    private readonly auditService: TenantAuditService,
    private readonly redis: RedisService,
  ) {}

  async getSettings(ctx: VerifiedTenantContext): Promise<TenantSettingsPayload> {
    // 1. Check Redis cache first (resilient cache-aside pattern)
    try {
      const cached = await this.redis.getTenantJson<TenantSettingsPayload>(
        ctx.tenantId,
        SETTINGS_CACHE_NAMESPACE,
        SETTINGS_CACHE_KEY,
      );
      if (cached) {
        return cached;
      }
    } catch (err) {
      this.logger.warn(
        `Redis cache get failed for tenant ${ctx.tenantId}, falling back to PostgreSQL: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // 2. Cache miss or Redis error: retrieve from PostgreSQL within verified tenant transaction
    const payload = await this.txManager.withVerifiedMemberTransaction(ctx, async (tx) => {
      const row = await this.repo.getSettings(tx, ctx.tenantId);
      if (!row) {
        throw new NotFoundException({
          code: 'SETTINGS_NOT_FOUND',
          message: 'Organization settings not found for the active organization.',
        });
      }
      return this.mapRowToPayload(row);
    });

    // 3. Populate Redis cache (fail-safe if Redis unreachable)
    try {
      await this.redis.setTenantJson(
        ctx.tenantId,
        SETTINGS_CACHE_NAMESPACE,
        SETTINGS_CACHE_KEY,
        payload,
        SETTINGS_CACHE_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(
        `Redis cache set failed for tenant ${ctx.tenantId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return payload;
  }

  async updateSettings(
    ctx: VerifiedTenantContext,
    dto: UpdateOrganizationSettingsDto,
  ): Promise<TenantSettingsPayload> {
    const payload = await this.txManager.withVerifiedMemberTransaction(
      ctx,
      async (tx, verifiedMembershipId) => {
        const current = await this.repo.getSettings(tx, ctx.tenantId);
        if (!current) {
          throw new NotFoundException({
            code: 'SETTINGS_NOT_FOUND',
            message: 'Organization settings not found for the active organization.',
          });
        }

        if (current.version !== dto.expectedVersion) {
          throw new ConflictException({
            code: 'SETTINGS_VERSION_CONFLICT',
            message:
              'Settings have been updated by another process. Please reload and retry.',
          });
        }

        const updated = await this.repo.updateSettings(
          tx,
          ctx.tenantId,
          dto.expectedVersion,
          dto,
          verifiedMembershipId,
        );

        if (!updated) {
          throw new ConflictException({
            code: 'SETTINGS_VERSION_CONFLICT',
            message:
              'Settings have been updated by another process. Please reload and retry.',
          });
        }

        const beforeState: Record<string, unknown> = {
          timezone: current.timezone,
          locale: current.locale,
          dateFormat: current.date_format,
          timeFormat: current.time_format,
          defaultCurrency: current.default_currency,
          weekStartDay: current.week_start_day,
          fiscalYearStartMonth: current.fiscal_year_start_month,
          invitationExpiryHours: current.invitation_expiry_hours,
          allowMemberDirectoryView: current.allow_member_directory_view,
        };

        const afterState: Record<string, unknown> = {
          timezone: updated.timezone,
          locale: updated.locale,
          dateFormat: updated.date_format,
          timeFormat: updated.time_format,
          defaultCurrency: updated.default_currency,
          weekStartDay: updated.week_start_day,
          fiscalYearStartMonth: updated.fiscal_year_start_month,
          invitationExpiryHours: updated.invitation_expiry_hours,
          allowMemberDirectoryView: updated.allow_member_directory_view,
        };

        const diff = this.auditService.computeFieldDiff(beforeState, afterState);

        await this.auditService.recordTenantEvent(tx, ctx, {
          eventType: 'TENANT_SETTINGS_UPDATED',
          resourceType: 'SETTINGS',
          resourceId: ctx.tenantId,
          beforeState: diff.beforeState,
          afterState: diff.afterState,
          metadata: {
            changedFields: diff.changedFields,
            version: updated.version,
          },
        });

        return this.mapRowToPayload(updated);
      },
    );

    // Invalidate Redis cache key after commit
    try {
      await this.redis.deleteTenantKey(
        ctx.tenantId,
        SETTINGS_CACHE_NAMESPACE,
        SETTINGS_CACHE_KEY,
      );
    } catch (err) {
      this.logger.warn(
        `Redis cache invalidation failed for tenant ${ctx.tenantId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return payload;
  }

  private mapRowToPayload(row: TenantSettingsRow): TenantSettingsPayload {
    return {
      tenantId: row.tenant_id,
      timezone: row.timezone,
      locale: row.locale,
      dateFormat: row.date_format,
      timeFormat: row.time_format,
      defaultCurrency: row.default_currency,
      weekStartDay: row.week_start_day,
      fiscalYearStartMonth: row.fiscal_year_start_month,
      invitationExpiryHours: row.invitation_expiry_hours,
      allowMemberDirectoryView: row.allow_member_directory_view,
      updatedByMembershipId: row.updated_by_membership_id,
      version: row.version,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : String(row.updated_at),
    };
  }
}
