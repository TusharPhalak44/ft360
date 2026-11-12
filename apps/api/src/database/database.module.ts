import { Global, Module } from '@nestjs/common';
import { DatabasePoolService } from './database-pool.service';
import { TenantTransactionManager } from './tenant-transaction.manager';

@Global()
@Module({
  providers: [DatabasePoolService, TenantTransactionManager],
  exports: [DatabasePoolService, TenantTransactionManager],
})
export class DatabaseModule {}

