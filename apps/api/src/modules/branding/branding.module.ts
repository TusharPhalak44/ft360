import { Module } from '@nestjs/common';
import { BrandingController } from './branding.controller';
import { BrandingRepository } from './branding.repository';
import { BrandingService } from './branding.service';

@Module({
  controllers: [BrandingController],
  providers: [BrandingRepository, BrandingService],
  exports: [BrandingService],
})
export class BrandingModule {}

