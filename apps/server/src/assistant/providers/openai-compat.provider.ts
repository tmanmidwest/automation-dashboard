import type { AssistantModelInfo } from '@cerebro/shared';
import type { LlmChatParams, LlmDelta, LlmProvider } from '../llm-provider';
import { getJson, streamChatCompletions } from '../llm-http';

/**
 * Any OpenAI-compatible server (LM Studio, vLLM, llama.cpp server, LocalAI, or the
 * OpenAI API itself). `baseUrl` is expected to be the API root that carries the
 * `/chat/completions` and `/models` routes — typically ending in `/v1`. An API key is
 * optional (local servers usually ignore it). See docs/assistant-computer.md.
 */
export class OpenAiCompatProvider implements LlmProvider {
  readonly id = 'openai-compat' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  private base(): string {
    return this.baseUrl.replace(/\/+$/, '');
  }

  chat(params: LlmChatParams): AsyncIterable<LlmDelta> {
    return streamChatCompletions(`${this.base()}/chat/completions`, this.apiKey, params);
  }

  async listModels(): Promise<AssistantModelInfo[]> {
    const data = await getJson<{ data?: { id: string }[] }>(`${this.base()}/models`, this.apiKey);
    return (data?.data ?? []).map((m) => ({ name: m.id }));
  }
}
