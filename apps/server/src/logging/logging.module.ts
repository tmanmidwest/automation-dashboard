import { Global, Module } from '@nestjs/common';
import { LoggingService } from './logging.service';
import { AuditService } from './audit.service';
import { LoggingController } from './logging.controller';
import { TimelineBus } from '../timeline/timeline-bus';

@Global()
@Module({
  controllers: [LoggingController],
  // TimelineBus lives here (a global module) so audit/log writers can publish to
  // it and the timeline controller can subscribe, with no cross-module imports.
  providers: [LoggingService, AuditService, TimelineBus],
  exports: [LoggingService, AuditService, TimelineBus],
})
export class LoggingModule {}
