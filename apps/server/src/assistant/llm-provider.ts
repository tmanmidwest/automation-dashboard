import type { AssistantModelInfo, LlmBackend } from '@cerebro/shared';

/**
 * OpenAI-compatible chat wire types. Ollama, LM Studio, vLLM, llama.cpp, LocalAI and
 * the OpenAI/Anthropic-compat endpoints all speak this shape, so the agent loop is
 * written once against it. See docs/assistant-computer.md.
 */

export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** assistant turns that call tools */
  tool_calls?: WireToolCall[];
  /** tool result turns */
  tool_call_id?: string;
  name?: string;
}

export interface WireTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface LlmChatParams {
  model: string;
  temperature: number;
  messages: WireMessage[];
  tools?: WireTool[];
  signal?: AbortSignal;
}

/** A streamed increment from the model. */
export type LlmDelta =
  | { kind: 'content'; text: string }
  | { kind: 'tool_call'; index: number; id?: string; name?: string; argsFragment?: string }
  | { kind: 'finish'; reason: string };

/** A pluggable LLM backend. One implementation per {@link LlmBackend}. */
export interface LlmProvider {
  readonly id: LlmBackend;
  /** Stream a chat completion with tool support. */
  chat(params: LlmChatParams): AsyncIterable<LlmDelta>;
  /** Advertise available models for the settings dropdown (best-effort). */
  listModels(): Promise<AssistantModelInfo[]>;
}
