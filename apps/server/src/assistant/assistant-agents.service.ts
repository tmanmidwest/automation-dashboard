import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { AssistantAgent } from '@prisma/client';
import {
  DEFAULT_AGENT_MAX_ROUNDS,
  DEFAULT_ASSISTANT_CONFIG,
  type AssistantAgentInput,
  type AssistantAgentSummary,
  type AssistantAgentView,
  type AssistantConfig,
  type AssistantModelInfo,
  type AssistantToolMode,
  type LlmBackend,
  type SessionUser,
} from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import type { LlmProvider } from './llm-provider';
import { OllamaProvider } from './providers/ollama.provider';
import { OpenAiCompatProvider } from './providers/openai-compat.provider';
import { AnthropicProvider } from './providers/anthropic.provider';

/** The legacy single-agent config key, read once to seed the default agent. */
const LEGACY_CONFIG_KEY = 'assistant.config';
/** The default agent keeps the legacy vault key so an existing API key carries over. */
const DEFAULT_API_KEY_SECRET = 'assistant.apiKey';

const BACKENDS: LlmBackend[] = ['ollama', 'openai-compat', 'anthropic'];
const TOOL_MODES: AssistantToolMode[] = ['all', 'selected'];

/**
 * Computer agent profiles: CRUD, access checks, and building an agent's LLM provider.
 * Exactly one agent is the default; it is seeded on boot from the legacy
 * `assistant.config` setting so an existing install keeps working unchanged. See
 * docs/assistant-computer.md.
 */
@Injectable()
export class AssistantAgentsService implements OnModuleInit {
  private ensuring: Promise<AssistantAgent> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async onModuleInit() {
    await this.getDefault().catch(() => undefined); // best-effort; retried lazily on first use
  }

  /** The default agent, creating it from the legacy config the first time. */
  async getDefault(): Promise<AssistantAgent> {
    const existing = await this.prisma.assistantAgent.findFirst({ where: { isDefault: true } });
    if (existing) return existing;
    this.ensuring ??= this.seedDefault().finally(() => {
      this.ensuring = null;
    });
    return this.ensuring;
  }

  private async seedDefault(): Promise<AssistantAgent> {
    const again = await this.prisma.assistantAgent.findFirst({ where: { isDefault: true } });
    if (again) return again;
    const legacy = await this.settings.get<Partial<AssistantConfig>>(LEGACY_CONFIG_KEY);
    const cfg: AssistantConfig = { ...DEFAULT_ASSISTANT_CONFIG, ...(legacy ?? {}) };
    return this.prisma.assistantAgent.create({
      data: {
        name: 'Computer',
        description: 'The built-in assistant.',
        isDefault: true,
        enabled: cfg.enabled,
        backend: cfg.backend,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        temperature: cfg.temperature,
        instructions: cfg.systemPromptExtra || null,
        contextPrimer: cfg.contextPrimer,
        maxRounds: DEFAULT_AGENT_MAX_ROUNDS,
      },
    });
  }

  async list(): Promise<AssistantAgentView[]> {
    await this.getDefault();
    const rows = await this.prisma.assistantAgent.findMany({ orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
    return Promise.all(rows.map((r) => this.view(r)));
  }

  /** Agents this user may chat with (managers see every agent, so they can test them). */
  async listFor(user: SessionUser): Promise<AssistantAgentSummary[]> {
    await this.getDefault();
    const rows = await this.prisma.assistantAgent.findMany({ orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
    return rows
      .filter((r) => this.canUse(r, user))
      .map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        isDefault: r.isDefault,
        ready: isReady(r),
        backend: r.backend as LlmBackend,
        model: r.model,
      }));
  }

  async get(id: string): Promise<AssistantAgent> {
    const row = await this.prisma.assistantAgent.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Agent not found.');
    return row;
  }

  async getView(id: string): Promise<AssistantAgentView> {
    return this.view(await this.get(id));
  }

  async create(input: AssistantAgentInput, apiKey?: string): Promise<AssistantAgentView> {
    const data = clean(input, null);
    // clean() always sets `name` on a create (or throws).
    const row = await this.prisma.assistantAgent.create({ data: { ...data, name: data.name!, isDefault: false } });
    if (apiKey) await this.setApiKey(row, apiKey);
    return this.view(row);
  }

  async update(id: string, patch: Partial<AssistantAgentInput>, apiKey?: string): Promise<AssistantAgentView> {
    const current = await this.get(id);
    const row = await this.prisma.assistantAgent.update({ where: { id }, data: clean(patch, current) });
    if (apiKey !== undefined) await this.setApiKey(row, apiKey);
    return this.view(row);
  }

  async remove(id: string): Promise<void> {
    const row = await this.get(id);
    if (row.isDefault) throw new BadRequestException('The default agent cannot be deleted.');
    await this.prisma.assistantAgent.delete({ where: { id } });
    if (await this.settings.hasSecret(this.secretKey(row))) await this.settings.deleteSecret(this.secretKey(row));
  }

  /** Set (or, with an empty string, clear) an agent's API key in the vault. */
  async setApiKey(row: AssistantAgent, plaintext: string): Promise<void> {
    if (plaintext) await this.settings.setSecret(this.secretKey(row), plaintext);
    else if (await this.settings.hasSecret(this.secretKey(row))) await this.settings.deleteSecret(this.secretKey(row));
  }

  /**
   * The agent a chat or automation runs as: `agentId`, or the default when omitted. With a
   * `user`, also enforces the agent's role allow-list. Throws a user-facing message when the
   * agent can't be used.
   */
  async resolve(agentId: string | undefined, user?: SessionUser): Promise<AssistantAgent> {
    const row = agentId
      ? await this.prisma.assistantAgent.findUnique({ where: { id: agentId } })
      : await this.getDefault();
    if (!row) throw new NotFoundException('That agent no longer exists.');
    if (user && !this.canUse(row, user)) throw new ForbiddenException(`You don't have access to the "${row.name}" agent.`);
    if (!row.enabled) {
      throw new BadRequestException(
        row.isDefault ? 'The Computer is disabled. Enable it in Settings → Computer.' : `The "${row.name}" agent is disabled.`,
      );
    }
    if (!row.model || (!row.baseUrl && row.backend !== 'anthropic')) {
      throw new BadRequestException(`The "${row.name}" agent is not configured (missing base URL or model).`);
    }
    return row;
  }

  /** Build the LLM provider for an agent. */
  async providerFor(row: AssistantAgent): Promise<LlmProvider> {
    const apiKey = (await this.settings.getSecret(this.secretKey(row))) ?? undefined;
    return buildProvider(row.backend as LlmBackend, row.baseUrl, apiKey);
  }

  /** Models the agent's backend advertises (best-effort). */
  async listModels(row: AssistantAgent): Promise<AssistantModelInfo[]> {
    if (!row.baseUrl && row.backend !== 'anthropic') return [];
    return (await this.providerFor(row)).listModels();
  }

  async apiKeySet(row: AssistantAgent): Promise<boolean> {
    return this.settings.hasSecret(this.secretKey(row));
  }

  private canUse(row: AssistantAgent, user: SessionUser): boolean {
    if (user.permissions.includes('agents:manage')) return true;
    return row.allowedRoles.length === 0 || row.allowedRoles.includes(user.roleSlug);
  }

  private secretKey(row: AssistantAgent): string {
    return row.isDefault ? DEFAULT_API_KEY_SECRET : `assistant.agent.${row.id}.apiKey`;
  }

  private async view(row: AssistantAgent): Promise<AssistantAgentView> {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      isDefault: row.isDefault,
      enabled: row.enabled,
      backend: row.backend as LlmBackend,
      baseUrl: row.baseUrl,
      model: row.model,
      temperature: row.temperature,
      instructions: row.instructions,
      contextPrimer: row.contextPrimer,
      maxRounds: row.maxRounds,
      toolMode: row.toolMode as AssistantToolMode,
      tools: row.tools,
      allowedRoles: row.allowedRoles,
      mcpServerIds: row.mcpServerIds,
      apiKeySet: await this.apiKeySet(row),
      ready: isReady(row),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** Construct the provider for a backend. Anthropic requires an API key. */
export function buildProvider(backend: LlmBackend, baseUrl: string, apiKey?: string): LlmProvider {
  switch (backend) {
    case 'ollama':
      return new OllamaProvider(baseUrl);
    case 'anthropic':
      if (!apiKey) throw new Error('Claude (Anthropic) requires an API key. Set one on the agent.');
      return new AnthropicProvider(apiKey, baseUrl || undefined);
    case 'openai-compat':
    default:
      return new OpenAiCompatProvider(baseUrl, apiKey);
  }
}

function isReady(row: AssistantAgent): boolean {
  return row.enabled && !!row.model && (!!row.baseUrl || row.backend === 'anthropic');
}

/**
 * Validate and normalize an agent input. With `current` (an update) every field is optional
 * and only the ones present are returned; without it (a create) name is required and the
 * rest fall back to defaults.
 */
function clean(input: Partial<AssistantAgentInput>, current: AssistantAgent | null) {
  const out: Partial<Omit<AssistantAgent, 'id' | 'isDefault' | 'createdAt' | 'updatedAt'>> = {};
  const creating = current === null;

  if (input.name !== undefined || creating) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new BadRequestException('A name is required.');
    if (name.length > 80) throw new BadRequestException('The name is too long (80 characters max).');
    out.name = name;
  }
  if (input.description !== undefined) out.description = input.description ? String(input.description).slice(0, 500) : null;
  if (input.enabled !== undefined) out.enabled = input.enabled === true;
  if (input.backend !== undefined || creating) {
    const backend = input.backend ?? DEFAULT_ASSISTANT_CONFIG.backend;
    if (!BACKENDS.includes(backend)) throw new BadRequestException(`Unknown backend "${backend}".`);
    out.backend = backend;
  }
  if (input.baseUrl !== undefined) {
    const url = String(input.baseUrl ?? '').trim();
    if (url && !/^https?:\/\//i.test(url)) throw new BadRequestException('The base URL must start with http:// or https://.');
    out.baseUrl = url;
  }
  if (input.model !== undefined) out.model = String(input.model ?? '').trim();
  if (input.temperature !== undefined) {
    const t = Number(input.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) throw new BadRequestException('Temperature must be between 0 and 2.');
    out.temperature = t;
  }
  if (input.instructions !== undefined) out.instructions = input.instructions ? String(input.instructions) : null;
  if (input.contextPrimer !== undefined) out.contextPrimer = input.contextPrimer === true;
  if (input.maxRounds !== undefined) {
    const n = Math.round(Number(input.maxRounds));
    if (!Number.isFinite(n) || n < 1 || n > 20) throw new BadRequestException('Max rounds must be between 1 and 20.');
    out.maxRounds = n;
  }
  if (input.toolMode !== undefined) {
    if (!TOOL_MODES.includes(input.toolMode)) throw new BadRequestException(`Unknown tool mode "${input.toolMode}".`);
    out.toolMode = input.toolMode;
  }
  if (input.tools !== undefined) out.tools = stringList(input.tools);
  if (input.allowedRoles !== undefined) out.allowedRoles = stringList(input.allowedRoles);
  if (input.mcpServerIds !== undefined) out.mcpServerIds = stringList(input.mcpServerIds);
  return out;
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) throw new BadRequestException('Expected a list of strings.');
  return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
}
