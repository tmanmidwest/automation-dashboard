import { Global, Module } from '@nestjs/common';
import { LoggingService } from './logging.service';
import { AuditService } from './audit.service';
import { LoggingController } from './logging.controller';

@Global()
@Module({
  controllers: [LoggingController],
  providers: [LoggingService, AuditService],
  exports: [LoggingService, AuditService],
})
export class LoggingModule {}
