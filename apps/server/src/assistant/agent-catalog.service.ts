import { Injectable, NotFoundException } from '@nestjs/common';
import type { AssistantAgent, McpServer, Prisma } from '@prisma/client';
import type {
  AgentCatalogEntry,
  AgentCatalogResponse,
  AgentCatalogStatus,
  AgentGovernance,
  McpToolInfo,
} from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ZumaService } from './zuma.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../package.json') as { version: string };

/** Without paging, one response returns up to this many agents. */
export const CATALOG_MAX_ITEMS = 1000;
const STATUSES: AgentCatalogStatus[] = ['ready', 'disabled', 'not_configured'];

export interface CatalogQuery {
  updatedSince?: Date;
  status?: AgentCatalogStatus;
  environment?: string;
  /** `key:value` on the agent's governance labels. */
  label?: { key: string; value: string };
  page?: number;
  limit?: number;
}

/**
 * The external, read-only agent catalog (GET /api/v1/agents). Every entry is built from an
 * explicit field list: API keys, credentials, the full LLM URL and agent instructions are
 * never included, and agents marked `catalogHidden` are left out. See
 * docs/assistant-computer.md, "External agent catalog".
 */
@Injectable()
export class AgentCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly zuma: ZumaService,
  ) {}

  async list(q: CatalogQuery): Promise<AgentCatalogResponse> {
    const where: Prisma.AssistantAgentWhereInput = { catalogHidden: false };
    if (q.updatedSince) where.updatedAt = { gte: q.updatedSince };
    const rows = await this.prisma.assistantAgent.findMany({ where, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }] });
    const ctx = await this.context(rows);
    // Status, environment and labels are derived or stored as JSON, so filter after building.
    const all = rows
      .map((r) => this.entry(r, ctx))
      .filter((e) => !q.status || e.status === q.status)
      .filter((e) => !q.environment || e.governance?.environment === q.environment)
      .filter((e) => !q.label || e.governance?.labels[q.label.key] === q.label.value);

    const generatedAt = new Date().toISOString();
    if (q.page !== undefined || q.limit !== undefined) {
      const page = q.page ?? 1;
      const limit = q.limit ?? 100;
      return { items: all.slice((page - 1) * limit, page * limit), totalCount: all.length, page, limit, generatedAt };
    }
    return { items: all.slice(0, CATALOG_MAX_ITEMS), totalCount: all.length, generatedAt };
  }

  async get(id: string): Promise<AgentCatalogEntry> {
    const row = await this.prisma.assistantAgent.findUnique({ where: { id } });
    if (!row || row.catalogHidden) throw new NotFoundException('Agent not found.');
    return this.entry(row, await this.context([row]));
  }

  private async context(rows: AssistantAgent[]) {
    const ids = [...new Set(rows.flatMap((r) => r.mcpServerIds))];
    const servers = ids.length ? await this.prisma.mcpServer.findMany({ where: { id: { in: ids } } }) : [];
    const base = (await this.zuma.getConnection()).effectivePublicUrl;
    return { servers: new Map(servers.map((s) => [s.id, s])), base };
  }

  private entry(row: AssistantAgent, ctx: { servers: Map<string, McpServer>; base: string | null }): AgentCatalogEntry {
    const disabled = new Set(row.mcpDisabledTools);
    const autoApprove = new Set(row.mcpAutoApproveTools);
    const status: AgentCatalogStatus = !row.enabled
      ? 'disabled'
      : row.model && (row.baseUrl || row.backend === 'anthropic')
        ? 'ready'
        : 'not_configured';
    const gov = row.governance as unknown as AgentGovernance | null;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      url: ctx.base ? `${ctx.base}/settings/agents/${row.id}` : null,
      platform: 'cerebro',
      platformVersion: pkg.version,
      revision: row.revision,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      status,
      enabled: row.enabled,
      isDefault: row.isDefault,
      llm: {
        provider: row.backend,
        model: row.model,
        endpointHost: hostOf(row.baseUrl),
        temperature: row.temperature,
        maxRounds: row.maxRounds,
      },
      tools: {
        mode: row.toolMode === 'selected' ? 'selected' : 'all',
        builtIn: row.toolMode === 'selected' ? row.tools : [],
        mcpServers: row.mcpServerIds.flatMap((id) => {
          const s = ctx.servers.get(id);
          if (!s) return [];
          const tools = (Array.isArray(s.tools) ? (s.tools as unknown as McpToolInfo[]) : [])
            .filter((t) => !disabled.has(`${s.id}:${t.name}`))
            .map((t) => ({ name: t.name, requiresApproval: t.destructive || !autoApprove.has(`${s.id}:${t.name}`) }));
          return [{ id: s.id, name: s.name, host: hostOf(s.url), enabled: s.enabled, tools }];
        }),
      },
      access: { allowedRoles: row.allowedRoles },
      governance: gov
        ? {
            environment: gov.environment,
            criticality: gov.criticality ?? null,
            agentType: gov.agentType ?? null,
            owners: (gov.owners ?? []).map((o) => ({ name: o.name, email: o.email, role: o.role })),
            ownerTeamName: gov.ownerTeamName ?? null,
            ownerTeamContact: gov.ownerTeamContact ?? null,
            labels: { ...(gov.labels ?? {}) },
          }
        : null,
      zuma: {
        agentId: row.zumaAgentId,
        status: row.zumaStatus,
        syncedAt: row.zumaSyncedAt?.toISOString() ?? null,
      },
    };
  }
}

export function isCatalogStatus(v: string): v is AgentCatalogStatus {
  return (STATUSES as string[]).includes(v);
}

function hostOf(url: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}
