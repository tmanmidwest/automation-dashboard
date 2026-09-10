/**
 * Shared types for the in-app LLM assistant ("the Computer").
 * See docs/assistant-computer.md.
 */
import type { AutomationRuleInput } from './automations';

/** Which LLM backend the assistant talks to. */
export type LlmBackend = 'ollama' | 'openai-compat' | 'anthropic';

/**
 * Assistant configuration, persisted via SettingsService under `assistant.config`.
 * The API key (for openai-compat backends that need one) is stored separately in the
 * vault, never in this object — the API returns only `apiKeySet`.
 */
export interface AssistantConfig {
  enabled: boolean;
  backend: LlmBackend;
  /** Base URL of the model server, e.g. http://ollama:11434 or http://host:1234/v1 */
  baseUrl: string;
  /** Model name/tag, e.g. "qwen2.5:7b" or "gpt-4o-mini". */
  model: string;
  /** Sampling temperature (0–2). Ignored by the `anthropic` backend (current Claude
   *  models reject sampling params). */
  temperature: number;
  /** Optional system-prompt preamble appended to the built-in instructions. */
  systemPromptExtra?: string;
  /** Prepend a compact "current situation" digest (overview + monitors + recent
   *  warnings) to each new conversation, so the model is grounded without a tool round-trip. */
  contextPrimer: boolean;
}

/** What the config endpoint returns (never the secret itself). */
export interface AssistantConfigView extends AssistantConfig {
  apiKeySet: boolean;
  /** Convenience flag: usable = enabled && baseUrl && model set. */
  ready: boolean;
}

export const DEFAULT_ASSISTANT_CONFIG: AssistantConfig = {
  enabled: false,
  backend: 'ollama',
  baseUrl: 'http://ollama:11434',
  model: 'qwen2.5:7b',
  temperature: 0.2,
  contextPrimer: true,
};

/** One turn in the conversation the client sends up. */
export interface AssistantChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantChatRequest {
  messages: AssistantChatMessage[];
}

/**
 * A state-changing tool call the model wants to make, paused awaiting the operator's
 * explicit approval before it runs. The model can never self-approve — the human decides.
 */
export interface AssistantPendingCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Hints an irreversible/destructive change (delete/reboot/…), for a sterner prompt. */
  destructive: boolean;
}

/**
 * SSE event payloads streamed from POST /api/assistant/chat and /resume. Each is sent as
 * one frame whose `data` is one of these objects (discriminated by `type`).
 */
export type AssistantStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; ok: boolean; summary: string }
  // The loop is paused: this action needs the operator to approve or deny it, then the
  // client calls /resume with the pendingId to continue.
  | { type: 'confirm_required'; pendingId: string; call: AssistantPendingCall }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** Body of POST /api/assistant/resume — approve or deny a paused action. */
export interface AssistantResumeRequest {
  pendingId: string;
  approve: boolean;
}

/** A model the backend advertises (Ollama /api/tags, etc.), for the settings dropdown. */
export interface AssistantModelInfo {
  name: string;
}

/** Body of POST /api/assistant/propose-rule — a natural-language automation request. */
export interface AssistantProposeRuleRequest {
  prompt: string;
}

/**
 * The Computer's draft of an automation rule from a natural-language request. `rule` is a
 * partial {@link AutomationRuleInput} to prefill the rule builder (ids may need the operator
 * to fill in); `notes` explains the draft or why it couldn't. See docs/assistant-computer.md.
 */
export interface AssistantRuleProposal {
  rule: Partial<AutomationRuleInput> | null;
  notes: string;
}
