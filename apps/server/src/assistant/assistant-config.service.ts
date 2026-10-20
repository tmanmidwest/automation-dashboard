import { Injectable } from '@nestjs/common';
import type { AssistantAgent } from '@prisma/client';
import type { AssistantConfig, AssistantConfigView, AssistantModelInfo, LlmBackend } from '@cerebro/shared';
import { AssistantAgentsService } from './assistant-agents.service';

/**
 * The default agent seen through the original single-agent config shape, so Settings →
 * Computer (and its Ollama deploy wizard) keep working unchanged. All storage lives in
 * {@link AssistantAgentsService}.
 */
@Injectable()
export class AssistantConfigService {
  constructor(private readonly agents: AssistantAgentsService) {}

  async getConfig(): Promise<AssistantConfig> {
    return toConfig(await this.agents.getDefault());
  }

  async getView(): Promise<AssistantConfigView> {
    const row = await this.agents.getDefault();
    const cfg = toConfig(row);
    const apiKeySet = await this.agents.apiKeySet(row);
    // Anthropic may leave the base URL blank (the provider has a default endpoint).
    const ready = cfg.enabled && !!cfg.model && (!!cfg.baseUrl || cfg.backend === 'anthropic');
    return { ...cfg, apiKeySet, ready };
  }

  async update(patch: Partial<AssistantConfig>): Promise<AssistantConfigView> {
    const row = await this.agents.getDefault();
    await this.agents.update(row.id, {
      enabled: patch.enabled,
      backend: patch.backend,
      baseUrl: patch.baseUrl,
      model: patch.model,
      temperature: patch.temperature,
      instructions: patch.systemPromptExtra,
      contextPrimer: patch.contextPrimer,
    });
    return this.getView();
  }

  async setApiKey(plaintext: string): Promise<void> {
    await this.agents.setApiKey(await this.agents.getDefault(), plaintext);
  }

  /** List models the default agent's backend advertises (best-effort). */
  async listModels(): Promise<AssistantModelInfo[]> {
    return this.agents.listModels(await this.agents.getDefault());
  }
}

function toConfig(row: AssistantAgent): AssistantConfig {
  return {
    enabled: row.enabled,
    backend: row.backend as LlmBackend,
    baseUrl: row.baseUrl,
    model: row.model,
    temperature: row.temperature,
    systemPromptExtra: row.instructions ?? '',
    contextPrimer: row.contextPrimer,
  };
}
