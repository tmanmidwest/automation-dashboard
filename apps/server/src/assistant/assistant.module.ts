import { Module } from '@nestjs/common';
import { ToolsModule } from '../tools/tools.module';
import { SettingsModule } from '../settings/settings.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { MonitorsModule } from '../monitors/monitors.module';
import { TimelineModule } from '../timeline/timeline.module';
import { AssistantConfigService } from './assistant-config.service';
import { AssistantContextService } from './assistant-context.service';
import { AssistantService } from './assistant.service';
import { OllamaProvisionService } from './ollama-provision.service';
import { PendingActionStore } from './pending-action.store';
import { AssistantController } from './assistant.controller';
import { ASSISTANT_AUTOMATION_PORT } from './assistant.port';

/**
 * The Computer — in-app LLM assistant. Reuses the shared tool catalog (ToolsModule) as
 * the agent's tools and SettingsService for its pluggable-backend config + API key in
 * the vault. See docs/assistant-computer.md.
 */
@Module({
  imports: [ToolsModule, SettingsModule, ConnectorsModule, MonitorsModule, TimelineModule],
  controllers: [AssistantController],
  providers: [
    AssistantConfigService,
    AssistantContextService,
    AssistantService,
    OllamaProvisionService,
    PendingActionStore,
    // Bind the automations port to the assistant so the rules engine can reach it via
    // ModuleRef without importing this module (avoids a module cycle).
    { provide: ASSISTANT_AUTOMATION_PORT, useExisting: AssistantService },
  ],
  exports: [AssistantConfigService, AssistantService, ASSISTANT_AUTOMATION_PORT],
})
export class AssistantModule {}
