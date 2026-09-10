import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { MonitorsModule } from '../monitors/monitors.module';
import { TimelineModule } from '../timeline/timeline.module';
import { AutomationsModule } from '../automations/automations.module';
import { ToolCatalogService } from './tool-catalog.service';

/**
 * The shared tool catalog — the single source of truth for the tools both the MCP
 * server and the in-app assistant expose. Imports the same service modules the tool
 * bodies call into. See docs/assistant-computer.md.
 */
@Module({
  imports: [ConnectorsModule, MonitorsModule, TimelineModule, AutomationsModule],
  providers: [ToolCatalogService],
  exports: [ToolCatalogService],
})
export class ToolsModule {}
