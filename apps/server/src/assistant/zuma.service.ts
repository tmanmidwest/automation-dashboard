import { createHash } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, type AssistantAgent } from '@prisma/client';
import {
  ZUMA_AGENT_TYPES,
  ZUMA_CRITICALITIES,
  ZUMA_ENVIRONMENTS,
  type AgentGovernance,
  type ZumaAuthMode,
  type ZumaConnectionInput,
  type ZumaConnectionView,
  type ZumaOwner,
  type ZumaSyncState,
} from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../package.json') as { version: string };

const CONFIG_KEY = 'zuma.config';
/** Client secret (client_credentials) or the pasted token (token mode). */
const CREDENTIAL_KEY = 'zuma.credential';
const REGISTRY_PATH = '/agent/v2/registry/agents';
const TIMEOUT_MS = 20_000;
const AUTH_MODES: ZumaAuthMode[] = ['client_credentials', 'token'];
const OWNER_ROLES = ['Business Owner', 'Technical Owner'];
const LABEL_RE = /^[a-z0-9_-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_CONNECTION: ZumaConnectionInput = {
  enabled: false,
  baseUrl: '',
  tenantId: '',
  authMode: 'client_credentials',
  tokenUrl: '',
  clientId: '',
  scope: '',
  publicUrl: '',
};

/** Fields the documented PUT accepts, so a sync can carry them. */
interface ZumaUpdateBody {
  name: string;
  displayName: string;
  description?: string;
  url: string;
  environment: string;
  agentType?: string;
  sourceId: string;
  platform: string;
  framework: string;
  version: string;
  agentMetadata: Record<string, unknown>;
  criticality?: string;
}

/** Set once on registration; the documented API has no way to change them afterwards. */
interface ZumaExtras {
  ownerTeamName?: string;
  ownerTeamContact?: string;
  owners?: { name: string; email: string; role: string; rank: number; source: 'API' }[];
  labels?: Record<string, string>;
}

interface ZumaAgentResponse {
  agentId?: string;
  status?: string;
}

/**
 * Saviynt Zuma agent registry client (Agent API v2): the tenant connection (settings + vault),
 * and registering, updating and reading back Computer agents. Zuma assigns the agent ID;
 * Cerebro sends `sourceId = cerebro-<agent id>` so a retried registration upserts instead of
 * creating a duplicate. See docs/assistant-computer.md, "Saviynt Zuma".
 */
@Injectable()
export class ZumaService {
  private token: { value: string; expiresAt: number; fingerprint: string } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  // ── Connection ────────────────────────────────────────────────

  async getConnection(): Promise<ZumaConnectionView> {
    const cfg = await this.config();
    const credentialSet = await this.settings.hasSecret(CREDENTIAL_KEY);
    const ready =
      cfg.enabled &&
      !!cfg.baseUrl &&
      !!cfg.tenantId &&
      credentialSet &&
      (cfg.authMode === 'token' || (!!cfg.tokenUrl && !!cfg.clientId));
    return { ...cfg, credentialSet, ready, effectivePublicUrl: publicUrl(cfg) };
  }

  async setConnection(patch: Partial<ZumaConnectionInput>, credential?: string): Promise<ZumaConnectionView> {
    const cfg = { ...(await this.config()), ...cleanConnection(patch) };
    await this.settings.set(CONFIG_KEY, cfg);
    if (credential !== undefined) {
      if (credential) await this.settings.setSecret(CREDENTIAL_KEY, credential);
      else if (await this.settings.hasSecret(CREDENTIAL_KEY)) await this.settings.deleteSecret(CREDENTIAL_KEY);
    }
    this.token = null;
    return this.getConnection();
  }

  /** Get a token and make one read-only list call, to prove the URL, tenant and credential work. */
  async testConnection(): Promise<{ ok: true; agentCount: number | null }> {
    try {
      const res = await this.request<{ totalCount?: number }>('GET', `${REGISTRY_PATH}?page=1&limit=1`);
      return { ok: true, agentCount: typeof res?.totalCount === 'number' ? res.totalCount : null };
    } catch (e) {
      throw toUserError(e);
    }
  }

  // ── Agents ────────────────────────────────────────────────────

  /**
   * Register the agent (first time) or push its current details (after). Records the outcome
   * on the agent either way; throws a user-facing error on failure.
   */
  async sync(row: AssistantAgent): Promise<AssistantAgent> {
    try {
      const { body, extras } = await this.payload(row);
      let agentId = row.zumaAgentId;
      let status: string | null = row.zumaStatus;
      let extrasHash = row.zumaExtrasHash;
      if (!agentId) {
        const res = await this.request<ZumaAgentResponse>('POST', REGISTRY_PATH, { ...body, ingestionMethod: 'API', ...extras });
        if (!res?.agentId) throw new Error('Zuma accepted the registration but returned no agent ID.');
        agentId = res.agentId;
        status = res.status ?? null;
        extrasHash = hash(extras);
      } else {
        const res = await this.request<ZumaAgentResponse>('PUT', `${REGISTRY_PATH}/${encodeURIComponent(agentId)}`, body);
        status = res?.status ?? status;
      }
      return this.prisma.assistantAgent.update({
        where: { id: row.id },
        data: {
          zumaAgentId: agentId,
          zumaStatus: status,
          zumaSyncedAt: new Date(),
          zumaLastError: null,
          zumaPayloadHash: hash(body),
          zumaExtrasHash: extrasHash,
        },
      });
    } catch (e) {
      await this.recordError(row, e);
      throw toUserError(e);
    }
  }

  /** Re-read the agent's lifecycle status from Zuma. */
  async refreshStatus(row: AssistantAgent): Promise<AssistantAgent> {
    if (!row.zumaAgentId) throw new BadRequestException('This agent is not registered with Zuma yet.');
    try {
      const res = await this.request<ZumaAgentResponse>('GET', `${REGISTRY_PATH}/${encodeURIComponent(row.zumaAgentId)}`);
      return this.prisma.assistantAgent.update({
        where: { id: row.id },
        data: { zumaStatus: res?.status ?? null, zumaLastError: null },
      });
    } catch (e) {
      await this.recordError(row, e);
      throw toUserError(e);
    }
  }

  /** Forget the Zuma registration locally. The agent stays in Zuma (the API has no delete). */
  unlink(row: AssistantAgent): Promise<AssistantAgent> {
    return this.prisma.assistantAgent.update({
      where: { id: row.id },
      data: {
        zumaAgentId: null,
        zumaStatus: null,
        zumaSyncedAt: null,
        zumaLastError: null,
        zumaPayloadHash: null,
        zumaExtrasHash: null,
      },
    });
  }

  /** The agent's registration state, including whether it changed since the last sync. */
  async state(row: AssistantAgent): Promise<ZumaSyncState> {
    let outOfDate = false;
    let ownersOrLabelsChanged = false;
    if (row.zumaAgentId) {
      const built = await this.payload(row).catch(() => null);
      if (built) {
        outOfDate = hash(built.body) !== row.zumaPayloadHash;
        ownersOrLabelsChanged = hash(built.extras) !== row.zumaExtrasHash;
      }
    }
    return {
      agentId: row.zumaAgentId,
      status: row.zumaStatus,
      syncedAt: row.zumaSyncedAt?.toISOString() ?? null,
      lastError: row.zumaLastError,
      outOfDate,
      ownersOrLabelsChanged,
    };
  }

  // ── Internals ─────────────────────────────────────────────────

  private async config(): Promise<ZumaConnectionInput> {
    return { ...DEFAULT_CONNECTION, ...((await this.settings.get<Partial<ZumaConnectionInput>>(CONFIG_KEY)) ?? {}) };
  }

  /** The Zuma request body for an agent, split into updatable fields and registration-only ones. */
  private async payload(row: AssistantAgent): Promise<{ body: ZumaUpdateBody; extras: ZumaExtras }> {
    const gov = row.governance as unknown as AgentGovernance | null;
    if (!gov?.environment) throw new BadRequestException('Fill in the agent\'s governance details (at least the environment) first.');
    const base = publicUrl(await this.config());
    if (!base) throw new BadRequestException('Set Cerebro\'s public URL on the Saviynt Zuma settings page (or APP_URL) first.');

    const servers = row.mcpServerIds.length
      ? await this.prisma.mcpServer.findMany({ where: { id: { in: row.mcpServerIds } }, orderBy: { name: 'asc' } })
      : [];
    const body: ZumaUpdateBody = {
      name: row.name.slice(0, 100),
      displayName: row.name.slice(0, 255),
      ...(row.description ? { description: row.description.slice(0, 500) } : {}),
      url: `${base}/settings/agents/${row.id}`.slice(0, 255),
      environment: gov.environment,
      ...(gov.agentType ? { agentType: gov.agentType } : {}),
      sourceId: `cerebro-${row.id}`,
      platform: 'cerebro',
      framework: 'cerebro',
      version: pkg.version.slice(0, 50),
      agentMetadata: {
        cerebroAgentId: row.id,
        defaultAgent: row.isDefault,
        enabled: row.enabled,
        backend: row.backend,
        model: row.model,
        toolMode: row.toolMode,
        tools: row.toolMode === 'selected' ? row.tools : 'all permitted built-in tools',
        mcpServers: servers.map((s) => ({ name: s.name, host: hostOf(s.url) })),
        maxRounds: row.maxRounds,
      },
      ...(gov.criticality ? { criticality: gov.criticality } : {}),
    };
    const extras: ZumaExtras = {
      ...(gov.ownerTeamName ? { ownerTeamName: gov.ownerTeamName } : {}),
      ...(gov.ownerTeamContact ? { ownerTeamContact: gov.ownerTeamContact } : {}),
      ...(gov.owners.length
        ? { owners: gov.owners.map((o, i) => ({ name: o.name, email: o.email, role: o.role, rank: i + 1, source: 'API' as const })) }
        : {}),
      ...(Object.keys(gov.labels).length ? { labels: gov.labels } : {}),
    };
    return { body, extras };
  }

  private async request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T | null> {
    const cfg = await this.config();
    if (!cfg.enabled) throw new BadRequestException('The Saviynt Zuma connection is turned off. Enable it in Settings → Saviynt Zuma.');
    if (!cfg.baseUrl || !cfg.tenantId) throw new BadRequestException('Set the Zuma URL and tenant ID in Settings → Saviynt Zuma first.');
    const send = async (token: string) =>
      fetch(`${cfg.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Tenant-Id': cfg.tenantId,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

    let res = await send(await this.accessToken(cfg));
    if (res.status === 401 && cfg.authMode === 'client_credentials') {
      // The cached token may have been revoked or expired early; fetch a fresh one once.
      this.token = null;
      res = await send(await this.accessToken(cfg));
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new ZumaHttpError(res.status, describe(res.status, text));
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  private async accessToken(cfg: ZumaConnectionInput): Promise<string> {
    const secret = await this.settings.getSecret(CREDENTIAL_KEY);
    if (!secret) {
      throw new BadRequestException(
        cfg.authMode === 'token' ? 'No Zuma access token is saved.' : 'No Zuma client secret is saved.',
      );
    }
    if (cfg.authMode === 'token') return secret;

    if (!cfg.tokenUrl || !cfg.clientId) throw new BadRequestException('Set the token URL and client ID for Zuma first.');
    const fingerprint = hash([cfg.tokenUrl, cfg.clientId, cfg.scope, secret]);
    if (this.token && this.token.fingerprint === fingerprint && this.token.expiresAt > Date.now()) return this.token.value;

    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId });
    if (cfg.scope) form.set('scope', cfg.scope);
    const res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${secret}`).toString('base64')}`,
      },
      body: form.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new ZumaHttpError(res.status, `Getting a Zuma token failed (${res.status}): ${text.slice(0, 300) || res.statusText}`);
    let json: { access_token?: string; expires_in?: number };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('The token endpoint did not return JSON.');
    }
    if (!json.access_token) throw new Error('The token endpoint returned no access_token.');
    const ttl = Math.max(30, (Number(json.expires_in) || 3600) - 60);
    this.token = { value: json.access_token, expiresAt: Date.now() + ttl * 1000, fingerprint };
    return json.access_token;
  }

  private async recordError(row: AssistantAgent, e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    await this.prisma.assistantAgent
      .update({ where: { id: row.id }, data: { zumaLastError: message.slice(0, 1000) } })
      .catch(() => undefined);
  }
}

class ZumaHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Validate and normalize governance input from the agent editor. Null clears it. */
export function cleanGovernance(input: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (input === null) return Prisma.DbNull;
  if (typeof input !== 'object') throw new BadRequestException('Invalid governance details.');
  const g = input as Partial<AgentGovernance>;

  if (!ZUMA_ENVIRONMENTS.includes(g.environment as never)) {
    throw new BadRequestException(`Environment must be one of: ${ZUMA_ENVIRONMENTS.join(', ')}.`);
  }
  const criticality = g.criticality || null;
  if (criticality && !ZUMA_CRITICALITIES.includes(criticality)) {
    throw new BadRequestException(`Criticality must be one of: ${ZUMA_CRITICALITIES.join(', ')}.`);
  }
  const agentType = g.agentType || null;
  if (agentType && !ZUMA_AGENT_TYPES.includes(agentType)) {
    throw new BadRequestException(`Agent type must be one of: ${ZUMA_AGENT_TYPES.join(', ')}.`);
  }

  const owners: ZumaOwner[] = [];
  for (const o of Array.isArray(g.owners) ? g.owners : []) {
    const name = String(o?.name ?? '').trim();
    const email = String(o?.email ?? '').trim();
    if (!name && !email) continue;
    if (!name || name.length > 100) throw new BadRequestException('Each owner needs a name (100 characters max).');
    if (!EMAIL_RE.test(email) || email.length > 255) throw new BadRequestException(`"${email}" is not a valid owner email.`);
    if (!OWNER_ROLES.includes(o.role)) throw new BadRequestException('Owner role must be Business Owner or Technical Owner.');
    owners.push({ name, email, role: o.role });
  }

  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(g.labels && typeof g.labels === 'object' ? g.labels : {})) {
    const key = k.trim().toLowerCase();
    const value = String(v ?? '').trim().toLowerCase();
    if (!key) continue;
    if (!LABEL_RE.test(key) || key.length > 100) {
      throw new BadRequestException(`Label "${k}": keys may only use letters, digits, - and _ (100 characters max).`);
    }
    if (!LABEL_RE.test(value) || value.length > 255) {
      throw new BadRequestException(`Label "${k}": values may only use letters, digits, - and _ (255 characters max).`);
    }
    labels[key] = value;
  }
  if (Object.keys(labels).length > 50) throw new BadRequestException('At most 50 labels.');

  const text = (v: unknown, max: number, what: string) => {
    const s = String(v ?? '').trim();
    if (s.length > max) throw new BadRequestException(`${what} is too long (${max} characters max).`);
    return s || null;
  };
  const out: AgentGovernance = {
    environment: g.environment!,
    criticality,
    agentType,
    owners,
    ownerTeamName: text(g.ownerTeamName, 100, 'Owner team name'),
    ownerTeamContact: text(g.ownerTeamContact, 255, 'Owner team contact'),
    labels,
  };
  return out as unknown as Prisma.InputJsonValue;
}

function cleanConnection(input: Partial<ZumaConnectionInput>): Partial<ZumaConnectionInput> {
  const out: Partial<ZumaConnectionInput> = {};
  const url = (v: unknown, what: string) => {
    const s = String(v ?? '').trim().replace(/\/+$/, '');
    if (s && !/^https?:\/\//i.test(s)) throw new BadRequestException(`${what} must start with http:// or https://.`);
    return s;
  };
  if (input.enabled !== undefined) out.enabled = input.enabled === true;
  if (input.baseUrl !== undefined) out.baseUrl = url(input.baseUrl, 'The Zuma URL');
  if (input.tenantId !== undefined) out.tenantId = String(input.tenantId ?? '').trim();
  if (input.authMode !== undefined) {
    if (!AUTH_MODES.includes(input.authMode)) throw new BadRequestException(`Unknown auth mode "${input.authMode}".`);
    out.authMode = input.authMode;
  }
  if (input.tokenUrl !== undefined) out.tokenUrl = url(input.tokenUrl, 'The token URL');
  if (input.clientId !== undefined) out.clientId = String(input.clientId ?? '').trim();
  if (input.scope !== undefined) out.scope = String(input.scope ?? '').trim();
  if (input.publicUrl !== undefined) out.publicUrl = url(input.publicUrl, 'The public URL');
  return out;
}

function publicUrl(cfg: ZumaConnectionInput): string | null {
  return (cfg.publicUrl || process.env.APP_URL || '').replace(/\/+$/, '') || null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Stable hash of a JSON value (object keys sorted). */
function hash(v: unknown): string {
  const stable = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(stable)
      : x && typeof x === 'object'
        ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, stable((x as Record<string, unknown>)[k])]))
        : x;
  return createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
}

function describe(status: number, text: string): string {
  let detail = text.slice(0, 500);
  try {
    const j = JSON.parse(text) as { message?: unknown; error?: unknown; errors?: unknown };
    const parts = [j.message, j.error, j.errors].filter(Boolean).map((p) => (typeof p === 'string' ? p : JSON.stringify(p)));
    if (parts.length) detail = parts.join(' · ').slice(0, 500);
  } catch {
    /* not JSON */
  }
  if (status === 401) return `Zuma rejected the token (401). ${detail}`.trim();
  if (status === 403) return `Zuma refused access for this tenant (403). ${detail}`.trim();
  if (status === 404) return `Zuma could not find that agent (404). If it was removed in Saviynt, unlink it and register again. ${detail}`.trim();
  return `Zuma returned ${status}. ${detail}`.trim();
}

function toUserError(e: unknown): Error {
  if (e instanceof BadRequestException) return e;
  if (e instanceof ZumaHttpError) return new BadRequestException(e.message);
  const message = e instanceof Error ? e.message : String(e);
  if (/timeout|aborted/i.test(message)) return new BadRequestException('Zuma did not respond in time.');
  return new BadRequestException(`Could not reach Zuma: ${message}`);
}
