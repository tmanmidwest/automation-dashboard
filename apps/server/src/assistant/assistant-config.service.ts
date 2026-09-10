import { Injectable } from '@nestjs/common';
import {
  AssistantConfig,
  AssistantConfigView,
  DEFAULT_ASSISTANT_CONFIG,
  AssistantModelInfo,
} from '@cerebro/shared';
import { SettingsService } from '../settings/settings.service';
import type { LlmProvider } from './llm-provider';
import { OllamaProvider } from './providers/ollama.provider';
import { OpenAiCompatProvider } from './providers/openai-compat.provider';
import { AnthropicProvider } from './providers/anthropic.provider';

const CONFIG_KEY = 'assistant.config';
const API_KEY_SECRET = 'assistant.apiKey';

/** Reads/writes the assistant configuration and builds the active LLM provider. */
@Injectable()
export class AssistantConfigService {
  constructor(private readonly settings: SettingsService) {}

  async getConfig(): Promise<AssistantConfig> {
    const stored = await this.settings.get<Partial<AssistantConfig>>(CONFIG_KEY);
    return { ...DEFAULT_ASSISTANT_CONFIG, ...(stored ?? {}) };
  }

  async getView(): Promise<AssistantConfigView> {
    const cfg = await this.getConfig();
    const apiKeySet = await this.settings.hasSecret(API_KEY_SECRET);
    return { ...cfg, apiKeySet, ready: cfg.enabled && !!cfg.baseUrl && !!cfg.model };
  }

  async update(patch: Partial<AssistantConfig>): Promise<AssistantConfigView> {
    const current = await this.getConfig();
    // Only persist known fields.
    const next: AssistantConfig = {
      enabled: patch.enabled ?? current.enabled,
      backend: patch.backend ?? current.backend,
      baseUrl: patch.baseUrl ?? current.baseUrl,
      model: patch.model ?? current.model,
      temperature: patch.temperature ?? current.temperature,
      systemPromptExtra: patch.systemPromptExtra ?? current.systemPromptExtra,
      contextPrimer: patch.contextPrimer ?? current.contextPrimer,
    };
    await this.settings.set(CONFIG_KEY, next);
    return this.getView();
  }

  async setApiKey(plaintext: string): Promise<void> {
    if (plaintext) await this.settings.setSecret(API_KEY_SECRET, plaintext);
    else await this.settings.deleteSecret(API_KEY_SECRET);
  }

  /** Build the provider for the current config, or throw if the assistant isn't usable. */
  async buildProvider(): Promise<{ provider: LlmProvider; config: AssistantConfig }> {
    const config = await this.getConfig();
    if (!config.enabled) throw new Error('The Computer is disabled. Enable it in Settings → Computer.');
    if (!config.baseUrl || !config.model) throw new Error('The Computer is not configured (missing base URL or model).');

    const apiKey = (await this.settings.getSecret(API_KEY_SECRET)) ?? undefined;
    const provider = this.providerFor(config.backend, config.baseUrl, apiKey);
    return { provider, config };
  }

  /** List models the configured backend advertises (best-effort). */
  async listModels(): Promise<AssistantModelInfo[]> {
    const config = await this.getConfig();
    if (!config.baseUrl && config.backend !== 'anthropic') return [];
    const apiKey = (await this.settings.getSecret(API_KEY_SECRET)) ?? undefined;
    return this.providerFor(config.backend, config.baseUrl, apiKey).listModels();
  }

  /** Construct the provider for a backend. Anthropic requires an API key. */
  private providerFor(backend: AssistantConfig['backend'], baseUrl: string, apiKey?: string): LlmProvider {
    switch (backend) {
      case 'ollama':
        return new OllamaProvider(baseUrl);
      case 'anthropic':
        if (!apiKey) throw new Error('Claude (Anthropic) requires an API key. Set one in Settings → Computer.');
        return new AnthropicProvider(apiKey, baseUrl || undefined);
      case 'openai-compat':
      default:
        return new OpenAiCompatProvider(baseUrl, apiKey);
    }
  }
}
