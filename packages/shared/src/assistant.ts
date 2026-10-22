/**
 * Shared types for the in-app LLM assistant ("the Computer").
 * See docs/assistant-computer.md.
 */
import type { AutomationRuleInput } from './automations';
import type { Permission } from './rbac';
import type { AgentGovernance, ZumaSyncState } from './zuma';

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

// ── Agent profiles ──
//
// A named Computer configuration: model + instructions + tool selection + who may use it.
// The default agent ("Computer") is the one Settings → Computer edits through
// /api/assistant/config; the rest are managed at /api/assistant/agents.

/** Which tools an agent offers: every tool the caller may use, or only a chosen list. */
export type AssistantToolMode = 'all' | 'selected';

/** Body of POST/PUT /api/assistant/agents. `apiKey` (write-only) goes to the vault. */
export interface AssistantAgentInput {
  name: string;
  description?: string | null;
  enabled: boolean;
  backend: LlmBackend;
  baseUrl: string;
  model: string;
  temperature: number;
  /** Agent-specific instructions, appended after the built-in safety preamble. */
  instructions?: string | null;
  contextPrimer: boolean;
  /** Max tool-calling rounds per turn (loop guard), 1–20. */
  maxRounds: number;
  toolMode: AssistantToolMode;
  /** Tool names offered when `toolMode` is 'selected'. Still intersected with the caller's RBAC. */
  tools: string[];
  /** Role slugs that may chat with this agent. Empty = anyone with assistant:use. */
  allowedRoles: string[];
  /** External MCP servers whose (pinned) tools this agent offers. Their actions always need approval. */
  mcpServerIds: string[];
  /** MCP tools switched off for this agent, as `<serverId>:<toolName>`. */
  mcpDisabledTools: string[];
  /** MCP tools that run without the approval prompt, as `<serverId>:<toolName>`. Never
   *  honoured for a tool the server marks destructive. */
  mcpAutoApproveTools: string[];
  /** Governance details for the Saviynt Zuma registry; null = not filled in. */
  governance?: AgentGovernance | null;
  /** Leave this agent out of the external agent catalog (GET /api/v1/agents). */
  catalogHidden?: boolean;
}

/** An agent as the editor sees it (never the API key itself). */
export interface AssistantAgentView extends AssistantAgentInput {
  id: string;
  isDefault: boolean;
  apiKeySet: boolean;
  governance: AgentGovernance | null;
  zuma: ZumaSyncState;
  catalogHidden: boolean;
  /** Bumps on every save; reported as the agent's version in the external catalog. */
  revision: number;
  /** enabled && model set && (baseUrl set || anthropic). */
  ready: boolean;
  createdAt: string;
  updatedAt: string;
}

/** An agent as the chat picker sees it. */
export interface AssistantAgentSummary {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  ready: boolean;
  backend: LlmBackend;
  model: string;
}

/** A built-in tool, for the agent editor's tool picker. */
export interface AssistantToolInfo {
  name: string;
  description: string;
  kind: 'read' | 'action';
  permission: Permission;
  destructive: boolean;
}

export const DEFAULT_AGENT_MAX_ROUNDS = 6;

// ── External MCP servers (a Computer tool source) ──

/** How Cerebro authenticates to an MCP server. The credential itself lives in the vault. */
export type McpAuthType = 'none' | 'bearer' | 'header';

/** One tool discovered on an MCP server (pinned at the last refresh). */
export interface McpToolInfo {
  name: string;
  description: string;
  /** JSON Schema of the tool's arguments, as the server advertised it. */
  inputSchema: Record<string, unknown>;
  /** The server's own destructiveHint/readOnlyHint (untrusted; shown, not relied on). */
  destructive: boolean;
  readOnly: boolean;
}

/** Body of POST/PUT /api/assistant/mcp-servers. `credential` (write-only) goes to the vault. */
export interface McpServerInput {
  name: string;
  description?: string | null;
  enabled: boolean;
  url: string;
  authType: McpAuthType;
  /** Header name when authType is 'header', e.g. X-API-Key. */
  authHeader?: string | null;
}

export interface McpServerView extends McpServerInput {
  id: string;
  credentialSet: boolean;
  tools: McpToolInfo[];
  toolsRefreshedAt: string | null;
  lastError: string | null;
  /** Agents this server is attached to (names), for the delete warning. */
  agents: string[];
  createdAt: string;
  updatedAt: string;
}

/** One turn in the conversation the client sends up. */
export interface AssistantChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantChatRequest {
  messages: AssistantChatMessage[];
  /** Which agent profile answers. Omitted = the default agent. */
  agentId?: string;
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

// ── One-click Ollama provisioning (deploy a self-hosted backend from the UI) ──

/** A Docker connector instance that can host the Ollama container (also reused to list
 *  Nginx Proxy Manager instances for the reverse-proxy option). */
export interface OllamaHost {
  instanceId: string;
  name: string;
}

/** An NPM certificate option (id 0 = None / HTTP only). */
export interface OllamaCertOption {
  id: number;
  name: string;
}

/** Optional reverse-proxy (Nginx Proxy Manager) fronting for the deployed Ollama. */
export interface OllamaProxyConfig {
  /** NPM connector instance id. */
  instanceId: string;
  /** Public hostname to route to Ollama, e.g. ollama.lan or ollama.example.com. */
  domain: string;
  /** NPM certificate id to attach (0 / omitted = HTTP only). */
  certificateId?: number;
  /** Force HTTPS (only meaningful with a certificate). */
  sslForced?: boolean;
}

/** Body of POST /api/assistant/ollama/deploy. */
export interface OllamaDeployRequest {
  /** Docker connector instance to deploy onto (may be a remote host, e.g. a GPU box). */
  instanceId: string;
  /** Host port to publish 11434 on (default 11434). */
  port: number;
  /** Request all GPUs (host must have the NVIDIA runtime). */
  gpu: boolean;
  /** Model to pull once the container is up (blank = skip). */
  model?: string;
  /**
   * How Cerebro should reach the deployed Ollama, if the auto-derived URL (from the Docker
   * endpoint) isn't the right address — e.g. the Docker API is on a VPN IP but Ollama should
   * be reached on the LAN. Blank = derive from the Docker host. Full URL, e.g. http://gpu-box:11434.
   */
  baseUrlOverride?: string;
  /**
   * Optionally front Ollama with an Nginx Proxy Manager proxy host. When set, Cerebro
   * deploys + pulls over the direct URL, then routes `domain` → the container and points the
   * Computer at the proxy URL instead. Omit for a direct connection.
   */
  proxy?: OllamaProxyConfig;
  /** Remove and rebuild the container from scratch (e.g. to change GPU/port, or fix a broken one). */
  recreate?: boolean;
}

/** SSE progress events from the deploy stream. */
export type OllamaDeployEvent =
  | { type: 'log'; text: string }
  | { type: 'done'; baseUrl: string; model?: string }
  | { type: 'error'; message: string };

/** SSE progress events from a setup stream (toolkit install). */
export type OllamaSetupEvent =
  | { type: 'log'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** One GPU-stack component's presence on a Docker host. */
export interface GpuComponent {
  present: boolean;
  detail?: string;
}

/** GPU readiness of a Docker host, probed over the connector's SSH + Engine API. */
export interface GpuStatus {
  /** The connector has SSH credentials (needed to inspect/install). */
  sshConfigured: boolean;
  /** SSH connected successfully. */
  reachable: boolean;
  /** e.g. "ubuntu 22.04". */
  distro?: string;
  /** Auto-install is supported for this distro (Debian/Ubuntu). */
  distroSupported: boolean;
  /** NVIDIA driver (nvidia-smi). */
  driver: GpuComponent;
  /** NVIDIA Container Toolkit (nvidia-ctk). */
  toolkit: GpuComponent;
  /** Docker `nvidia` runtime registered. */
  runtime: GpuComponent;
  /** Cerebro can install the toolkit from here (supported distro + reachable + toolkit missing). */
  canInstallToolkit: boolean;
  /** Human-readable summary / next step. */
  message: string;
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
