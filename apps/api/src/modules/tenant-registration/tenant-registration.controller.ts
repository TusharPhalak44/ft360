import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type {
  CheckSlugAvailabilityResponsePayload,
  TenantRegistrationResponsePayload,
} from '@ft360/shared-types';
import { extractClientIp, extractUserAgent } from '../../common/http-cookie.util';
import type { RequestWithAuthSession } from '../../common/jwt-auth.guard';
import {
  CheckSlugAvailabilityQueryDto,
  RegisterTenantDto,
} from './tenant-registration.dto';
import { TenantRegistrationService } from './tenant-registration.service';

@ApiTags('Tenant Registration (User Onboarding Plane)')
@ApiBearerAuth()
@Controller('tenants')
export class TenantRegistrationController {
  constructor(private readonly registrationService: TenantRegistrationService) {}

  /**
   * Endpoint #1: Checks whether a candidate slug is available for registration.
   *
   * Security & Policy:
   * - Authenticated global user with ACTIVE status and verified email required.
   * - Multi-tier rate limiting (15 burst/min per user, 20 burst/min per IP, 100/hr sustained per user).
   * - Fails closed (503) if Redis is offline.
   * - Discloses binary occupancy only; reserved and occupied slugs return identical { available: false }.
   */
  @Get('slug-availability')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check candidate tenant slug availability (binary occupancy disclosure only)',
    description:
      'Checks whether a syntactically valid slug is available for registration while enforcing anti-scraping throttling and zero tenant metadata disclosure.',
  })
  @ApiOkResponse({
    description: 'Binary slug availability check result',
  })
  async checkSlugAvailability(
    @Query() query: CheckSlugAvailabilityQueryDto,
    @Req() req: RequestWithAuthSession,
  ): Promise<CheckSlugAvailabilityResponsePayload> {
    const session = req.authSession;
    if (!session || !session.userId) {
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication is required to check slug availability.',
      });
    }

    const ip = extractClientIp(req);
    const ua = extractUserAgent(req);
    const correlationId = req.correlationId || '00000000-0000-0000-0000-000000000000';

    return this.registrationService.checkSlugAvailability(
      session.userId,
      ip,
      ua,
      correlationId,
      query,
    );
  }

  /**
   * Endpoint #2: Atomically provisions a new organization and binds caller's session.
   *
   * Security & Policy:
   * - Authenticated non-Super-Admin user with ACTIVE status and verified email.
   * - CsrfProtectionGuard active on cookie-authenticated requests.
   * - Max 5 owned ACTIVE/TRIAL tenants enforced inside PostgreSQL under advisory lock.
   * - 5 registrations / hour per user & IP rate limits.
   * - Rotates session tenant binding, evicts Redis session cache, and updates access token cookie.
   */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Atomically provision a new organization and bind active session',
    description:
      'Atomically provisions a new organization in TRIAL status, seeds tenant_admin and member system roles, assigns caller as primary owner, initializes 1:1 companion records, and binds the caller session.',
  })
  @ApiCreatedResponse({
    description: 'Tenant provisioned and session bound successfully',
  })
  async registerTenant(
    @Body() dto: RegisterTenantDto,
    @Req() req: RequestWithAuthSession,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TenantRegistrationResponsePayload> {
    const session = req.authSession;
    if (!session || !session.userId || !session.sessionId) {
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Active authenticated session is required to register an organization.',
      });
    }

    const ip = extractClientIp(req);
    const ua = extractUserAgent(req);
    const correlationId = req.correlationId || '00000000-0000-0000-0000-000000000000';

    return this.registrationService.registerTenant(
      {
        userId: session.userId,
        sessionId: session.sessionId,
        isPlatformSuperAdmin: Boolean(session.isPlatformSuperAdmin),
        activeTenantId: session.activeTenantId,
        activeMembershipId: session.activeMembershipId,
      },
      ip,
      ua,
      correlationId,
      dto,
      res,
    );
  }
}
