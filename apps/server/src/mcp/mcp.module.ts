import { Module } from '@nestjs/common';
import { ToolsModule } from '../tools/tools.module';
import { McpServerFactory } from './mcp-server.factory';
import { McpController } from './mcp.controller';

@Module({
  // ToolsModule exports the shared ToolCatalogService the factory registers from.
  // AuditService + LoggingService come from LoggingModule (global).
  imports: [ToolsModule],
  controllers: [McpController],
  providers: [McpServerFactory],
})
export class McpModule {}
