import { Module } from '@nestjs/common';
import { FoundationDbModule } from '../foundation-db/foundation-db.module';
import { WorkspaceBoundaryController } from './workspace-boundary.controller';

@Module({
  imports: [FoundationDbModule],
  controllers: [WorkspaceBoundaryController],
})
export class WorkspaceBoundaryModule {}
