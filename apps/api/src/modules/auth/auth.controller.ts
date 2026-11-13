import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type {
  AuthMeResponsePayload,
  AuthSessionSummary,
  LoginResponsePayload,
  RegisterUserResponsePayload,
  SelectOrganizationResponsePayload,
} from '@ft360/shared-types';
import { Public } from '../../common/auth.decorators';
import { CsrfProtectionGuard } from '../../common/csrf-protection.guard';
import type { RequestWithAuthSession } from '../../common/jwt-auth.guard';
import {
  ForgotPasswordDto,
  LoginDto,
  RegisterUserDto,
  ResendVerificationDto,
  ResetPasswordDto,
  SelectOrganizationDto,
  VerifyEmailDto,
} from './auth.dto';
import {
  AuthMailOutboxService,
  type DevOutboxPreviewMessage,
} from './auth-mail-outbox.service';
import { AuthService } from './auth.service';

@ApiTags('Authentication & Session Management')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly mailOutbox: AuthMailOutboxService,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Self-service user registration with Argon2id hashing and email verification dispatch' })
  async register(
    @Body() dto: RegisterUserDto,
    @Req() req: RequestWithAuthSession,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RegisterUserResponsePayload> {
    return this.authService.register(dto, req, res);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify account email address using single-use SHA-256 token' })
  async verifyEmail(
    @Body() dto: VerifyEmailDto,
    @Req() req: RequestWithAuthSession,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ verified: true }> {
    return this.authService.verifyEmail(dto, req, res);
  }

  @Public()
  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Resend email verification link without account enumeration' })
  async resendVerification(
    @Body() dto: ResendVerificationDto,
    @Req() req: RequestWithAuthSession,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accepted: true; message: string }> {
    return this.authService.resendVerification(dto, req, res);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate user with Argon2id, progressive lockout protection, and HttpOnly session cookies' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: RequestWithAuthSession,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponsePayload> {
    return this.authService.login(dto, req, res);
  }

  @Public()
  @UseGuards(CsrfProtectionGuard)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate single-use opaque refresh token and detect token replay/theft' })
  async refresh(
    @Req() req: RequestWithAuthSession,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ refreshed: true; sessionId: string; activeTenantId: string | null }> {
    return this.authService.refreshSession(req, res);
  }

  @Public()
  @UseGuards(CsrfProtectionGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke current session in PostgreSQL + Redis and clear session cookies' })
  async logout(
    @Req() req: RequestWithAuthSession,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ loggedOut: true }> {
    return this.authService.logout(req, res);
  }

  @UseGuards(CsrfProtectionGuard)
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke all active device sessions for the authenticated user' })
  async logoutAll(
    @Req() req: RequestWithAuthSession,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ loggedOutAll: true; revokedCount: number }> {
    return this.authService.logoutAll(req, res);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Request single-use password reset link without account enumeration' })
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Req() req: RequestWithAuthSession,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accepted: true; message: string }> {
    return this.authService.forgotPassword(dto, req, res);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using single-use token and revoke all active sessions' })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() req: RequestWithAuthSession,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ passwordReset: true }> {
    return this.authService.resetPassword(dto, req, res);
  }

  @Get('me')
  @ApiOperation({ summary: 'Retrieve authenticated user profile, active organization, and available workspaces' })
  async getMe(@Req() req: RequestWithAuthSession): Promise<AuthMeResponsePayload> {
    return this.authService.getMe(req);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'List active device sessions for the authenticated user (redacted)' })
  async listSessions(@Req() req: RequestWithAuthSession): Promise<AuthSessionSummary[]> {
    return this.authService.listOwnSessions(req);
  }

  @UseGuards(CsrfProtectionGuard)
  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a specific device session belonging to the authenticated user' })
  async revokeSession(
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Req() req: RequestWithAuthSession,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ revoked: true }> {
    return this.authService.revokeOwnSessionById(sessionId, req, res);
  }

  @UseGuards(CsrfProtectionGuard)
  @Post('select-organization')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify membership and bind server-side session to target organization' })
  async selectOrganization(
    @Body() dto: SelectOrganizationDto,
    @Req() req: RequestWithAuthSession,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SelectOrganizationResponsePayload> {
    return this.authService.selectOrganization(dto, req, res);
  }

  @UseGuards(CsrfProtectionGuard)
  @Post('exit-organization')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Clear active organization context on server-side session' })
  async exitOrganization(
    @Req() req: RequestWithAuthSession,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SelectOrganizationResponsePayload> {
    return this.authService.exitOrganization(req, res);
  }

  @Public()
  @Get('dev-outbox')
  @ApiOperation({ summary: 'Non-production local/E2E mail outbox preview (returns 404 in production)' })
  async getDevOutboxPreview(
    @Query('email') email = '',
    @Query('kind') kind: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET' = 'EMAIL_VERIFICATION',
  ): Promise<DevOutboxPreviewMessage | null> {
    const safeKind = kind === 'PASSWORD_RESET' ? 'PASSWORD_RESET' : 'EMAIL_VERIFICATION';
    return this.mailOutbox.readLatestDevOutboxMessage(email, safeKind);
  }
}
