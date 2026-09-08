import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { MonitorsModule } from '../monitors/monitors.module';
import { TimelineModule } from '../timeline/timeline.module';
import { AutomationsModule } from '../automations/automations.module';
import { McpServerFactory } from './mcp-server.factory';
import { McpController } from './mcp.controller';

@Module({
  // ConnectorsModule exports ConnectorRegistry + ConnectorInstanceService;
  // MonitorsModule exports MonitorsService; Timeline/Automations export their services.
  imports: [ConnectorsModule, MonitorsModule, TimelineModule, AutomationsModule],
  controllers: [McpController],
  providers: [McpServerFactory],
})
export class McpModule {}
