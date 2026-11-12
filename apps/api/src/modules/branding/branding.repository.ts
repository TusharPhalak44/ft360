import { Injectable } from '@nestjs/common';
import { DatabasePoolService } from '../../database/database-pool.service';

export interface PlatformBrandingRow {
  product_name: string;
  tagline: string;
  support_email: string;
  website_url: string;
  logo_light_url: string | null;
  logo_dark_url: string | null;
  favicon_url: string | null;
  primary_color_hex: string;
  accent_color_hex: string;
}

@Injectable()
export class BrandingRepository {
  constructor(private readonly dbPool: DatabasePoolService) {}

  async findPlatformBranding(): Promise<PlatformBrandingRow | null> {
    const regCheck = await this.dbPool.queryUnscoped<{ exists: string | null }>(
      `SELECT to_regclass('public.platform_branding_settings')::text AS exists`,
    );
    if (!regCheck.rows[0]?.exists) {
      return null;
    }

    const result = await this.dbPool.queryUnscoped<PlatformBrandingRow>(
      `SELECT
         product_name,
         tagline,
         support_email,
         website_url,
         logo_light_url,
         logo_dark_url,
         favicon_url,
         primary_color_hex,
         accent_color_hex
       FROM public.platform_branding_settings
       WHERE singleton_key = TRUE
       LIMIT 1`,
    );

    return result.rows[0] ?? null;
  }
}

