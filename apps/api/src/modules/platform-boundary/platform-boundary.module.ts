import { Module } from '@nestjs/common';
import { PlatformBoundaryController } from './platform-boundary.controller';

@Module({
  controllers: [PlatformBoundaryController],
})
export class PlatformBoundaryModule {}
