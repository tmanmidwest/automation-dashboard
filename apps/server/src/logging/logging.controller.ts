import { Controller, Get, Query } from '@nestjs/common';
import { LoggingService } from './logging.service';
import { AuditService } from './audit.service';
import { RequirePermissions } from '../auth/decorators';
import type { LogLevel } from '@cerebro/shared';

@Controller('api/logs')
export class LoggingController {
  constructor(
    private readonly logs: LoggingService,
    private readonly audit: AuditService,
  ) {}

  @Get('app')
  @RequirePermissions('logs:read')
  async appLogs(
    @Query('level') level?: LogLevel,
    @Query('context') context?: string,
    @Query('limit') limit?: string,
  ) {
    return this.logs.query({
      level,
      context,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('audit')
  @RequirePermissions('audit:read')
  async auditLogs(@Query('limit') limit?: string) {
    return this.audit.query({ limit: limit ? parseInt(limit, 10) : undefined });
  }
}
