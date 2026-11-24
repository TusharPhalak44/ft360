import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsISO31661Alpha2,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import type {
  IndustryCode,
  OrganizationType,
  UpdateOrganizationProfileRequest,
} from '@ft360/shared-types';
import {
  VALID_INDUSTRIES,
  VALID_ORGANIZATION_TYPES,
} from '../tenant-registration/tenant-registration.dto';

export class UpdateOrganizationProfileDto implements UpdateOrganizationProfileRequest {
  @ApiProperty({
    description: 'Human-readable organization display name',
    example: 'Acme Corporation',
    minLength: 2,
    maxLength: 160,
  })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @Length(2, 160)
  displayName!: string;

  @ApiProperty({
    description: 'Registered business legal name',
    example: 'Acme Corporation LLC',
    minLength: 2,
    maxLength: 200,
  })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @Length(2, 200)
  legalName!: string;

  @ApiProperty({
    description: 'Organization structure classification',
    example: 'COMPANY',
    enum: VALID_ORGANIZATION_TYPES,
  })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(VALID_ORGANIZATION_TYPES)
  organizationType!: OrganizationType;

  @ApiProperty({
    description: 'Primary industry classification',
    example: 'SAAS_TECHNOLOGY',
    enum: VALID_INDUSTRIES,
  })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(VALID_INDUSTRIES)
  industry!: IndustryCode;

  @ApiProperty({
    description: 'Headquarters ISO 3166-1 alpha-2 country code',
    example: 'US',
  })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsISO31661Alpha2()
  countryCode!: string;

  @ApiPropertyOptional({
    description: 'Company size band',
    example: '11-50',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  companySizeBand?: string | null;

  @ApiPropertyOptional({
    description: 'Official corporate registration number',
    example: 'REG-12345678',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  registrationNumber?: string | null;

  @ApiPropertyOptional({
    description: 'Tax identification / VAT number',
    example: 'TAX-87654321',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  taxId?: string | null;

  @ApiPropertyOptional({
    description: 'Official website URL',
    example: 'https://example.com',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(/^https?:\/\/.+$/, {
    message: 'websiteUrl must be a valid HTTP or HTTPS URL',
  })
  websiteUrl?: string | null;

  @ApiPropertyOptional({
    description: 'Primary contact person full name',
    example: 'Jane Doe',
  })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  primaryContactName?: string | null;

  @ApiPropertyOptional({
    description: 'Primary contact email address',
    example: 'jane@example.com',
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  primaryContactEmail?: string | null;

  @ApiPropertyOptional({
    description: 'Primary contact phone number in E.164 format',
    example: '+14155552671',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\+[1-9]\d{1,14}$/, {
    message: 'primaryContactPhoneE164 must be in valid E.164 format (e.g. +14155552671)',
  })
  primaryContactPhoneE164?: string | null;

  @ApiPropertyOptional({
    description: 'Branded customer support email address',
    example: 'support@example.com',
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  supportEmail?: string | null;

  @ApiPropertyOptional({
    description: 'Street address line 1',
    example: '100 Market Street',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  addressLine1?: string | null;

  @ApiPropertyOptional({
    description: 'Street address line 2',
    example: 'Suite 400',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  addressLine2?: string | null;

  @ApiPropertyOptional({
    description: 'City',
    example: 'San Francisco',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string | null;

  @ApiPropertyOptional({
    description: 'State / Province / Region',
    example: 'CA',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  stateProvince?: string | null;

  @ApiPropertyOptional({
    description: 'Postal / ZIP code',
    example: '94105',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  postalCode?: string | null;

  @ApiPropertyOptional({
    description: 'Public description or about summary',
    example: 'Enterprise analytics and workflow automation suite.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  aboutDescription?: string | null;

  @ApiProperty({
    description: 'Expected current version of the tenant profile for optimistic concurrency control',
    example: 1,
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
