import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsISO31661Alpha2,
  IsNotEmpty,
  IsString,
  IsTimeZone,
  Length,
  Matches,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import validator from 'validator';
import type {
  CheckSlugAvailabilityQuery,
  IndustryCode,
  OrganizationType,
  TenantRegistrationRequestPayload,
} from '@ft360/shared-types';

@ValidatorConstraint({ name: 'isISO4217Currency', async: false })
export class IsISO4217CurrencyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && validator.isISO4217(value.trim().toUpperCase());
  }

  defaultMessage(): string {
    return 'defaultCurrency must be a valid ISO-4217 currency code';
  }
}

export const VALID_ORGANIZATION_TYPES: readonly OrganizationType[] = [
  'COMPANY',
  'AGENCY',
  'ENTERPRISE',
  'NONPROFIT',
  'GOVERNMENT',
  'SOLE_PROPRIETORSHIP',
  'PARTNERSHIP',
  'OTHER',
] as const;

export const VALID_INDUSTRIES: readonly IndustryCode[] = [
  'SAAS_TECHNOLOGY',
  'MARKETING_AGENCY',
  'FINANCE_FINTECH',
  'HEALTHCARE',
  'ECOMMERCE_RETAIL',
  'REAL_ESTATE',
  'EDUCATION',
  'MANUFACTURING',
  'CONSULTING',
  'LOGISTICS',
  'OTHER',
] as const;

export const SLUG_FORMAT_REGEX = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/;

export class CheckSlugAvailabilityQueryDto implements CheckSlugAvailabilityQuery {
  @ApiProperty({
    description: 'Candidate tenant slug (3-63 lowercase alphanumeric with hyphens)',
    example: 'acme-corp',
  })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @Matches(SLUG_FORMAT_REGEX, {
    message:
      'slug must be 3 to 63 lowercase alphanumeric or hyphen characters without leading or trailing hyphens',
  })
  @Length(3, 63)
  slug!: string;
}

export class RegisterTenantDto implements TenantRegistrationRequestPayload {
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
    description: 'Unique URL slug for the organization workspace',
    example: 'acme-corp',
    minLength: 3,
    maxLength: 63,
  })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @Matches(SLUG_FORMAT_REGEX, {
    message:
      'slug must be 3 to 63 lowercase alphanumeric or hyphen characters without leading or trailing hyphens',
  })
  @Length(3, 63)
  slug!: string;

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

  @ApiProperty({
    description: 'Default IANA timezone for calendar scheduling and reports',
    example: 'America/New_York',
  })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsTimeZone()
  defaultTimezone!: string;

  @ApiProperty({
    description: 'Default 3-letter ISO-4217 currency code',
    example: 'USD',
  })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z]{3}$/, {
    message: 'defaultCurrency must be a 3-letter ISO-4217 currency code',
  })
  @Validate(IsISO4217CurrencyConstraint)
  defaultCurrency!: string;
}
