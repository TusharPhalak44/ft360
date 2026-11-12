import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { ProductBrandingConfig } from '@ft360/shared-types';
import { BrandingService } from './branding.service';

@ApiTags('Public Branding')
@Controller('public/branding')
export class BrandingController {
  constructor(private readonly brandingService: BrandingService) {}

  @Get()
  @ApiOperation({
    summary: 'Resolve active product identity & branding tokens',
    description:
      'Returns configurable product name, support contacts, logos, and color palette without hardcoding branding in frontend code.',
  })
  @ApiOkResponse({ description: 'Resolved branding configuration' })
  async getPublicBranding(): Promise<ProductBrandingConfig> {
    return this.brandingService.resolvePublicBranding();
  }
}

