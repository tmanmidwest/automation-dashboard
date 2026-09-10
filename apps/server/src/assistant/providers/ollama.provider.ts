import type { AssistantModelInfo } from '@cerebro/shared';
import type { LlmChatParams, LlmDelta, LlmProvider } from '../llm-provider';
import { getJson, streamChatCompletions } from '../llm-http';

/**
 * Self-hosted Ollama. Serves an OpenAI-compatible endpoint at `${baseUrl}/v1/chat/completions`
 * and lists local models at `${baseUrl}/api/tags`. No API key. See docs/assistant-computer.md.
 */
export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama' as const;

  constructor(private readonly baseUrl: string) {}

  private base(): string {
    return this.baseUrl.replace(/\/+$/, '');
  }

  chat(params: LlmChatParams): AsyncIterable<LlmDelta> {
    return streamChatCompletions(`${this.base()}/v1/chat/completions`, undefined, params);
  }

  async listModels(): Promise<AssistantModelInfo[]> {
    const data = await getJson<{ models?: { name: string }[] }>(`${this.base()}/api/tags`);
    return (data?.models ?? []).map((m) => ({ name: m.name }));
  }
}
