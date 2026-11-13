import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterUserDto {
  @ApiProperty({ example: 'Aarav Kulkarni', maxLength: 160 })
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  fullName!: string;

  @ApiProperty({ example: 'aarav@acme.example', maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;

  @ApiPropertyOptional({ example: '+919876543210' })
  @IsOptional()
  @IsString()
  @Matches(/^\+[1-9][0-9]{6,14}$/, {
    message: 'phoneE164 must be formatted in E.164 format (e.g. +919876543210).',
  })
  phoneE164?: string;
}

export class VerifyEmailDto {
  @ApiProperty({ description: 'Single-use email verification token from verification link' })
  @IsString()
  @MinLength(20)
  @MaxLength(256)
  token!: string;
}

export class ResendVerificationDto {
  @ApiProperty({ example: 'aarav@acme.example' })
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'aarav@acme.example' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ minLength: 1, maxLength: 256 })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'aarav@acme.example' })
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Single-use password reset token' })
  @IsString()
  @MinLength(20)
  @MaxLength(256)
  token!: string;

  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  newPassword!: string;
}

export class SelectOrganizationDto {
  @ApiProperty({
    description:
      'UUID of the organization to activate on the server-side session (must pass live membership verification).',
  })
  @IsUUID()
  targetOrganizationId!: string;
}
