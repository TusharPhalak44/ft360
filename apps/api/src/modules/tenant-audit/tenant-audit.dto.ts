import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { TenantAuditResourceType } from '@ft360/shared-types';

export const TENANT_AUDIT_RESOURCE_TYPES: readonly TenantAuditResourceType[] = [
  'TENANT',
  'ONBOARDING',
  'PROFILE',
  'SETTINGS',
  'BRANDING',
  'INVITATION',
  'MEMBERSHIP',
  'ROLE_ASSIGNMENT',
] as const;

export class ListTenantAuditLogsQueryDto {
  @ApiPropertyOptional({ example: 'TENANT_PROFILE_UPDATED', maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  eventType?: string;

  @ApiPropertyOptional({ enum: TENANT_AUDIT_RESOURCE_TYPES })
  @IsOptional()
  @IsIn(TENANT_AUDIT_RESOURCE_TYPES)
  resourceType?: TenantAuditResourceType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @ApiPropertyOptional({ description: 'ISO-8601 inclusive lower timestamp bound' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO-8601 inclusive upper timestamp bound' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Opaque base64url pagination cursor' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
