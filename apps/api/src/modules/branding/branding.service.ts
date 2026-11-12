import { Inject, Injectable } from '@nestjs/common';
import type { ProductBrandingConfig } from '@ft360/shared-types';
import { APP_CONFIG, type AppEnvConfig } from '../../config/env.config';
import { BrandingRepository } from './branding.repository';

@Injectable()
export class BrandingService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppEnvConfig,
    private readonly brandingRepository: BrandingRepository,
  ) {}

  async resolvePublicBranding(): Promise<ProductBrandingConfig> {
    const platformRow = await this.brandingRepository.findPlatformBranding();
    if (platformRow) {
      return {
        productName: platformRow.product_name,
        tagline: platformRow.tagline,
        supportEmail: platformRow.support_email,
        websiteUrl: platformRow.website_url,
        logoLightUrl: platformRow.logo_light_url,
        logoDarkUrl: platformRow.logo_dark_url,
        faviconUrl: platformRow.favicon_url,
        primaryColorHex: platformRow.primary_color_hex,
        accentColorHex: platformRow.accent_color_hex,
        source: 'PLATFORM',
      };
    }

    const defaults = this.config.brandingDefaults;
    return {
      productName: defaults.productName,
      tagline: defaults.tagline,
      supportEmail: defaults.supportEmail,
      websiteUrl: defaults.websiteUrl,
      logoLightUrl: null,
      logoDarkUrl: null,
      faviconUrl: null,
      primaryColorHex: defaults.primaryColorHex,
      accentColorHex: defaults.accentColorHex,
      source: 'BOOTSTRAP_DEFAULT',
    };
  }
}

