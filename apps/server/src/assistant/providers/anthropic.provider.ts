import type { AssistantModelInfo } from '@cerebro/shared';
import type { LlmChatParams, LlmDelta, LlmProvider, WireMessage } from '../llm-provider';

/**
 * Anthropic (Claude) via the native Messages API. Claude is NOT OpenAI-shaped — different
 * endpoint, message/tool blocks, and streaming events — so this provider translates our
 * neutral wire format to/from the Messages API rather than reusing the OpenAI client.
 *
 * Implemented over raw HTTP (fetch) to match the rest of the assistant's dependency-free
 * streaming clients; swapping to `@anthropic-ai/sdk` is a clean follow-up. Note: current
 * Claude models reject sampling params, so `temperature` is intentionally not sent. See
 * docs/assistant-computer.md.
 */
export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.anthropic.com',
    private readonly maxTokens = 8192,
  ) {}

  private base(): string {
    return this.baseUrl.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  async *chat(params: LlmChatParams): AsyncIterable<LlmDelta> {
    const { system, messages } = toAnthropicMessages(params.messages);
    const body = {
      model: params.model,
      max_tokens: this.maxTokens,
      stream: true,
      ...(system ? { system } : {}),
      messages,
      ...(params.tools?.length
        ? {
            tools: params.tools.map((t) => ({
              name: t.function.name,
              description: t.function.description,
              input_schema: t.function.parameters,
            })),
          }
        : {}),
      // Deliberately no `temperature`: current Claude models 400 on sampling params.
    };

    const res = await fetch(`${this.base()}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: params.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`Claude request failed (${res.status}): ${text.slice(0, 500) || res.statusText}`);
    }

    // Track which streamed content-block index is a tool_use, to route input_json_delta.
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        // Anthropic SSE carries both `event:` and `data:` lines; we only need the JSON.
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let evt: AnthropicEvent;
        try {
          evt = JSON.parse(payload) as AnthropicEvent;
        } catch {
          continue;
        }
        yield* this.mapEvent(evt);
      }
    }
  }

  private *mapEvent(evt: AnthropicEvent): Iterable<LlmDelta> {
    if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
      yield {
        kind: 'tool_call',
        index: evt.index ?? 0,
        id: evt.content_block.id,
        name: evt.content_block.name,
      };
    } else if (evt.type === 'content_block_delta' && evt.delta) {
      if (evt.delta.type === 'text_delta' && evt.delta.text) {
        yield { kind: 'content', text: evt.delta.text };
      } else if (evt.delta.type === 'input_json_delta' && evt.delta.partial_json) {
        yield { kind: 'tool_call', index: evt.index ?? 0, argsFragment: evt.delta.partial_json };
      }
      // thinking_delta / signature_delta are ignored (not surfaced to the loop).
    } else if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
      yield { kind: 'finish', reason: evt.delta.stop_reason };
    }
  }

  async listModels(): Promise<AssistantModelInfo[]> {
    try {
      const res = await fetch(`${this.base()}/v1/models?limit=100`, { headers: this.headers() });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: { id: string }[] };
      return (data.data ?? []).map((m) => ({ name: m.id }));
    } catch {
      return [];
    }
  }
}

/** Minimal shape of the Anthropic streaming events we consume. */
interface AnthropicEvent {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
}

/**
 * Translate our neutral wire messages into Anthropic's shape: system prompts hoisted to the
 * top-level `system` string, tool calls as `tool_use` blocks on assistant turns, and tool
 * results as `tool_result` blocks on user turns.
 */
function toAnthropicMessages(wire: WireMessage[]): {
  system: string;
  messages: { role: 'user' | 'assistant'; content: unknown[] }[];
} {
  const systemParts: string[] = [];
  const messages: { role: 'user' | 'assistant'; content: unknown[] }[] = [];

  for (const m of wire) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content);
    } else if (m.role === 'user') {
      messages.push({ role: 'user', content: [{ type: 'text', text: m.content ?? '' }] });
    } else if (m.role === 'assistant') {
      const content: unknown[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls ?? []) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeParse(tc.function.arguments),
        });
      }
      messages.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      // Tool results are user-role tool_result blocks. Consecutive ones are combined by the API.
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' }],
      });
    }
  }

  return { system: systemParts.join('\n\n'), messages };
}

function safeParse(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
