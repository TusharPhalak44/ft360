import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  IsTimeZone,
  Matches,
  Max,
  Min,
} from 'class-validator';
import type { UpdateTenantSettingsRequest } from '@ft360/shared-types';

export const VALID_DATE_FORMATS = [
  'YYYY-MM-DD',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'DD-MMM-YYYY',
] as const;

export const VALID_TIME_FORMATS = ['12H', '24H'] as const;

export class UpdateOrganizationSettingsDto implements UpdateTenantSettingsRequest {
  @ApiProperty({
    description: 'IANA Time Zone identifier (e.g. "UTC", "America/New_York", "Asia/Kolkata")',
    example: 'America/New_York',
  })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsTimeZone()
  timezone!: string;

  @ApiProperty({
    description: 'BCP-47 language and locale tag',
    example: 'en-US',
  })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @Matches(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, {
    message: 'locale must be a valid BCP-47 language tag (e.g. "en-US", "fr-CA")',
  })
  locale!: string;

  @ApiProperty({
    description: 'Date display format',
    example: 'YYYY-MM-DD',
    enum: VALID_DATE_FORMATS,
  })
  @IsString()
  @IsIn(VALID_DATE_FORMATS)
  dateFormat!: (typeof VALID_DATE_FORMATS)[number];

  @ApiProperty({
    description: 'Time display format',
    example: '24H',
    enum: VALID_TIME_FORMATS,
  })
  @IsString()
  @IsIn(VALID_TIME_FORMATS)
  timeFormat!: (typeof VALID_TIME_FORMATS)[number];

  @ApiProperty({
    description: 'Default 3-letter uppercase ISO-4217 currency code',
    example: 'USD',
  })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z]{3}$/, {
    message: 'defaultCurrency must be a valid 3-letter uppercase ISO-4217 code',
  })
  defaultCurrency!: string;

  @ApiProperty({
    description: 'Week start day index (0 = Sunday, 1 = Monday, ..., 6 = Saturday)',
    example: 1,
    minimum: 0,
    maximum: 6,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  weekStartDay!: number;

  @ApiProperty({
    description: 'Fiscal year start calendar month index (1 = January, ..., 12 = December)',
    example: 1,
    minimum: 1,
    maximum: 12,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  fiscalYearStartMonth!: number;

  @ApiProperty({
    description: 'Team invitation token expiration duration in hours (1..720)',
    example: 168,
    minimum: 1,
    maximum: 720,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  invitationExpiryHours!: number;

  @ApiProperty({
    description: 'Whether standard workspace members are permitted to view the member directory',
    example: false,
  })
  @IsBoolean()
  allowMemberDirectoryView!: boolean;

  @ApiProperty({
    description: 'Expected optimistic lock version of settings',
    example: 1,
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
