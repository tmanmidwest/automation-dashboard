/**
 * Saviynt Zuma agent registry (Agent API v2). Cerebro registers its Computer agents there so
 * they show up in Saviynt's AI-agent inventory. Registration is outbound only: Cerebro calls
 * Zuma, Zuma assigns the agent ID. See docs/assistant-computer.md, "Saviynt Zuma".
 */

export const ZUMA_ENVIRONMENTS = ['dev', 'test', 'staging', 'prod'] as const;
export type ZumaEnvironment = (typeof ZUMA_ENVIRONMENTS)[number];

export const ZUMA_CRITICALITIES = ['critical', 'high', 'medium', 'low'] as const;
export type ZumaCriticality = (typeof ZUMA_CRITICALITIES)[number];

export const ZUMA_AGENT_TYPES = ['assistant', 'conversational', 'autonomous'] as const;
export type ZumaAgentType = (typeof ZUMA_AGENT_TYPES)[number];

export type ZumaOwnerRole = 'Business Owner' | 'Technical Owner';

/** An owner of the agent. The email must already exist as an identity in the Saviynt tenant. */
export interface ZumaOwner {
  name: string;
  email: string;
  role: ZumaOwnerRole;
}

/** Governance details sent to Zuma with an agent. Stored on the agent. */
export interface AgentGovernance {
  environment: ZumaEnvironment;
  criticality: ZumaCriticality | null;
  agentType: ZumaAgentType | null;
  owners: ZumaOwner[];
  ownerTeamName: string | null;
  ownerTeamContact: string | null;
  /** Lowercase keys and values matching ^[a-z0-9_-]+$, at most 50. */
  labels: Record<string, string>;
}

/**
 * How Cerebro gets the CognitoJWT for Zuma: an OAuth2 client-credentials grant against a
 * token endpoint (refreshed automatically), or a token pasted in by hand.
 */
export type ZumaAuthMode = 'client_credentials' | 'token';

/** Body of PUT /api/assistant/zuma/connection. `credential` (write-only) goes to the vault. */
export interface ZumaConnectionInput {
  enabled: boolean;
  /** e.g. https://identisphere-dev.saviyntqa.com */
  baseUrl: string;
  tenantId: string;
  authMode: ZumaAuthMode;
  /** client_credentials only: the OAuth2 token endpoint. */
  tokenUrl: string;
  /** client_credentials only. The client secret is the credential. */
  clientId: string;
  /** client_credentials only, optional. */
  scope: string;
  /** Cerebro's public address, used for each agent's `url` in Zuma. Blank = APP_URL. */
  publicUrl: string;
}

export interface ZumaConnectionView extends ZumaConnectionInput {
  credentialSet: boolean;
  /** enabled, base URL, tenant and credential set (and client ID / token URL for client_credentials). */
  ready: boolean;
  /** The address agents are registered with (publicUrl, else APP_URL, else null). */
  effectivePublicUrl: string | null;
}

/** An agent's registration state in Zuma. */
export interface ZumaSyncState {
  /** The ID Zuma assigned; null = not registered. */
  agentId: string | null;
  /** Lifecycle status as last read from Zuma (pending, active, suspended, ...). */
  status: string | null;
  syncedAt: string | null;
  lastError: string | null;
  /** The agent or its governance fields changed since the last sync. */
  outOfDate: boolean;
  /** Owners, owner team or labels changed since registration. The documented API can't update
   *  these after registration, so the change has to be made in Saviynt. */
  ownersOrLabelsChanged: boolean;
}
