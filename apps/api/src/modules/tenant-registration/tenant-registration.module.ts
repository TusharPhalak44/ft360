import { Module } from '@nestjs/common';
import { TenantRegistrationController } from './tenant-registration.controller';
import { TenantRegistrationRepository } from './tenant-registration.repository';
import { TenantRegistrationService } from './tenant-registration.service';

@Module({
  controllers: [TenantRegistrationController],
  providers: [TenantRegistrationService, TenantRegistrationRepository],
  exports: [TenantRegistrationService, TenantRegistrationRepository],
})
export class TenantRegistrationModule {}
