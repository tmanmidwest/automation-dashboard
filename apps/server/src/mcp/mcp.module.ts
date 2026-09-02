import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { MonitorsModule } from '../monitors/monitors.module';
import { McpServerFactory } from './mcp-server.factory';
import { McpController } from './mcp.controller';

@Module({
  // ConnectorsModule exports ConnectorRegistry + ConnectorInstanceService;
  // MonitorsModule exports MonitorsService.
  imports: [ConnectorsModule, MonitorsModule],
  controllers: [McpController],
  providers: [McpServerFactory],
})
export class McpModule {}
