/**
 * The external, read-only agent catalog (GET /api/v1/agents): what an outside inventory such
 * as Saviynt reads about each Computer agent. Built from an explicit field list; it never
 * carries API keys, credentials, full LLM URLs or agent instructions.
 * See docs/assistant-computer.md, "External agent catalog".
 */
import type { AgentGovernance } from './zuma';

export type AgentCatalogStatus = 'ready' | 'disabled' | 'not_configured';

export interface AgentCatalogEntry {
  id: string;
  name: string;
  description: string | null;
  /** Link to the agent's page in Cerebro. Null when no public URL is configured. */
  url: string | null;
  platform: 'cerebro';
  platformVersion: string;
  /** Bumps on every change to the agent; use as the agent's version. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  status: AgentCatalogStatus;
  enabled: boolean;
  isDefault: boolean;
  llm: {
    /** 'ollama' | 'openai-compat' | 'anthropic' */
    provider: string;
    model: string;
    /** Host of the model endpoint only (no path, no credentials); null for the provider default. */
    endpointHost: string | null;
    temperature: number;
    maxRounds: number;
  };
  tools: {
    /** 'all' = every built-in tool the chatting user may use; 'selected' = builtIn only. */
    mode: 'all' | 'selected';
    builtIn: string[];
    mcpServers: {
      id: string;
      name: string;
      host: string | null;
      enabled: boolean;
      /** Tools the agent can call on this server. */
      tools: { name: string; requiresApproval: boolean }[];
    }[];
  };
  access: {
    /** Role slugs allowed to chat with the agent; empty = anyone with Computer access. */
    allowedRoles: string[];
  };
  governance: AgentGovernance | null;
  zuma: { agentId: string | null; status: string | null; syncedAt: string | null };
}

export interface AgentCatalogResponse {
  items: AgentCatalogEntry[];
  totalCount: number;
  /** Set only when the caller asked for paging. */
  page?: number;
  limit?: number;
  generatedAt: string;
}
