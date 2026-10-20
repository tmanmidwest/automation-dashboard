import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'crypto';
import type { McpServer } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpAuthType, McpServerInput, McpServerView, McpToolInfo } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import type { CatalogTool } from '../tools/tool-catalog.service';

const AUTH_TYPES: McpAuthType[] = ['none', 'bearer', 'header'];
/** Timeouts for talking to a remote server: a slow one must not stall the chat. */
const LIST_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
/** Caps on what a remote server can push into the model's context. */
const MAX_DESCRIPTION = 1_000;
const MAX_RESULT = 20_000;
const MAX_TOOLS = 100;

type Connection = { client: Client; key: string };

/**
 * External MCP servers as a Computer tool source: the registry (CRUD, credential in the
 * vault), tool discovery (`refresh` pins the server's tool list), and the client that calls
 * those tools over Streamable HTTP. Remote tools are untrusted: they are always offered as
 * approval-required actions, never in headless runs, and only the pinned list is offered.
 * See docs/assistant-computer.md.
 */
@Injectable()
export class McpServersService implements OnModuleDestroy {
  /** Live client sessions, reused across calls and dropped on error or config change. */
  private readonly connections = new Map<string, Connection>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async onModuleDestroy() {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }

  // ── Registry ───────────────────────────────────────────────────

  async list(): Promise<McpServerView[]> {
    const rows = await this.prisma.mcpServer.findMany({ orderBy: { name: 'asc' } });
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async get(id: string): Promise<McpServer> {
    const row = await this.prisma.mcpServer.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('MCP server not found.');
    return row;
  }

  async getView(id: string): Promise<McpServerView> {
    return this.view(await this.get(id));
  }

  async create(input: McpServerInput, credential?: string): Promise<McpServerView> {
    const data = clean(input, true);
    const row = await this.prisma.mcpServer.create({
      data: { ...data, name: data.name!, url: data.url! },
    });
    if (credential) await this.settings.setSecret(secretKey(row.id), credential);
    return this.view(row);
  }

  async update(id: string, patch: Partial<McpServerInput>, credential?: string): Promise<McpServerView> {
    await this.get(id);
    const row = await this.prisma.mcpServer.update({ where: { id }, data: clean(patch, false) });
    if (credential !== undefined) {
      if (credential) await this.settings.setSecret(secretKey(id), credential);
      else if (await this.settings.hasSecret(secretKey(id))) await this.settings.deleteSecret(secretKey(id));
    }
    await this.disconnect(id); // URL/auth may have changed
    return this.view(row);
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    await this.disconnect(id);
    // Detach from every agent, then delete the server and its credential.
    const agents = await this.prisma.assistantAgent.findMany({ where: { mcpServerIds: { has: id } } });
    for (const a of agents) {
      await this.prisma.assistantAgent.update({
        where: { id: a.id },
        data: { mcpServerIds: a.mcpServerIds.filter((s) => s !== id) },
      });
    }
    await this.prisma.mcpServer.delete({ where: { id } });
    if (await this.settings.hasSecret(secretKey(id))) await this.settings.deleteSecret(secretKey(id));
  }

  /**
   * Connect, list the server's tools, and pin them. This is the approval step: only tools
   * pinned here are offered to agents, so a server that adds or changes tools needs a
   * manager to refresh again.
   */
  async refresh(id: string): Promise<McpServerView> {
    const row = await this.get(id);
    try {
      await this.disconnect(id);
      const { client } = await this.connect(row);
      const tools: McpToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: LIST_TIMEOUT_MS });
        for (const t of page.tools) {
          if (tools.length >= MAX_TOOLS) break;
          tools.push({
            name: t.name,
            description: (t.description ?? t.title ?? '').slice(0, MAX_DESCRIPTION),
            inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
            destructive: t.annotations?.destructiveHint === true,
            readOnly: t.annotations?.readOnlyHint === true,
          });
        }
        cursor = tools.length < MAX_TOOLS ? page.nextCursor : undefined;
      } while (cursor);
      const updated = await this.prisma.mcpServer.update({
        where: { id },
        data: { tools: tools as object[], toolsRefreshedAt: new Date(), lastError: null },
      });
      return this.view(updated);
    } catch (err) {
      await this.disconnect(id);
      const message = errorText(err);
      const updated = await this.prisma.mcpServer.update({ where: { id }, data: { lastError: message } });
      return this.view(updated);
    }
  }

  // ── Tools for the agent loop ───────────────────────────────────

  /**
   * The pinned tools of the given (enabled) servers as catalog tools. Every one is an
   * approval-required action, whatever the server's own hints say. Names are namespaced
   * `mcp_<server>__<tool>` (≤ 64 chars, the strictest provider limit).
   */
  async catalogTools(serverIds: string[]): Promise<CatalogTool[]> {
    if (serverIds.length === 0) return [];
    const rows = await this.prisma.mcpServer.findMany({ where: { id: { in: serverIds }, enabled: true } });
    const out: CatalogTool[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const prefix = `mcp_${slug(row.name).slice(0, 16)}_${row.id.slice(-4)}__`;
      for (const t of toolList(row.tools)) {
        const name = `${prefix}${t.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({
          name,
          description: `[External MCP server "${row.name}"] ${t.description}`,
          inputSchema: {},
          jsonSchema: t.inputSchema,
          permission: 'assistant:use',
          kind: 'action',
          confirm: true,
          destructive: t.destructive,
          external: true,
          run: (args) => this.callTool(row.id, t.name, args),
        });
      }
    }
    return out;
  }

  /** Call one tool, reconnecting once if the session dropped. Returns the result as text. */
  async callTool(serverId: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const row = await this.get(serverId);
    if (!row.enabled) throw new Error(`The MCP server "${row.name}" is disabled.`);
    let attempt = 0;
    for (;;) {
      try {
        const { client } = await this.connect(row);
        const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
        const text = resultText(result);
        if (result.isError) throw new Error(text || 'The MCP tool reported an error.');
        return text;
      } catch (err) {
        await this.disconnect(serverId);
        if (attempt++ > 0 || !isTransportError(err)) throw new Error(`MCP server "${row.name}": ${errorText(err)}`);
      }
    }
  }

  // ── internals ──────────────────────────────────────────────────

  private async connect(row: McpServer): Promise<Connection> {
    const credential = row.authType === 'none' ? null : await this.settings.getSecret(secretKey(row.id));
    const key = createHash('sha256')
      .update(`${row.url}\n${row.authType}\n${row.authHeader ?? ''}\n${credential ?? ''}`)
      .digest('hex');
    const existing = this.connections.get(row.id);
    if (existing?.key === key) return existing;
    if (existing) await this.disconnect(row.id);

    const headers: Record<string, string> = {};
    if (row.authType === 'bearer' && credential) headers.Authorization = `Bearer ${credential}`;
    if (row.authType === 'header' && credential && row.authHeader) headers[row.authHeader] = credential;

    const client = new Client({ name: 'cerebro-computer', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(row.url), { requestInit: { headers } });
    await client.connect(transport, { timeout: LIST_TIMEOUT_MS });
    const conn = { client, key };
    this.connections.set(row.id, conn);
    return conn;
  }

  private async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id);
    this.connections.delete(id);
    await conn?.client.close().catch(() => undefined);
  }

  private async view(row: McpServer): Promise<McpServerView> {
    const agents = await this.prisma.assistantAgent.findMany({
      where: { mcpServerIds: { has: row.id } },
      select: { name: true },
      orderBy: { name: 'asc' },
    });
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      url: row.url,
      authType: row.authType as McpAuthType,
      authHeader: row.authHeader,
      credentialSet: await this.settings.hasSecret(secretKey(row.id)),
      tools: toolList(row.tools),
      toolsRefreshedAt: row.toolsRefreshedAt?.toISOString() ?? null,
      lastError: row.lastError,
      agents: agents.map((a) => a.name),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function secretKey(id: string): string {
  return `mcp.${id}.credential`;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'server';
}

function toolList(json: unknown): McpToolInfo[] {
  return Array.isArray(json) ? (json as McpToolInfo[]) : [];
}

/** Flatten an MCP tool result into text for the model (structured content wins). */
function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  let text: string;
  if (result.structuredContent) {
    text = JSON.stringify(result.structuredContent);
  } else {
    const parts = Array.isArray(result.content) ? (result.content as { type: string; text?: string }[]) : [];
    text = parts.map((p) => (p.type === 'text' ? (p.text ?? '') : `[${p.type} content omitted]`)).join('\n');
  }
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}… [truncated]` : text;
}

/** Network/session failures worth one reconnect (not a tool's own error). */
function isTransportError(err: unknown): boolean {
  const msg = errorText(err).toLowerCase();
  return /fetch failed|econnreset|econnrefused|socket|session|not connected|404|connection closed/.test(msg);
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/** Validate and normalize an input; on a create, name and URL are required. */
function clean(input: Partial<McpServerInput>, creating: boolean) {
  const out: Partial<Pick<McpServer, 'name' | 'description' | 'enabled' | 'url' | 'authType' | 'authHeader'>> = {};
  if (input.name !== undefined || creating) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new BadRequestException('A name is required.');
    if (name.length > 80) throw new BadRequestException('The name is too long (80 characters max).');
    out.name = name;
  }
  if (input.description !== undefined) out.description = input.description ? String(input.description).slice(0, 500) : null;
  if (input.enabled !== undefined) out.enabled = input.enabled === true;
  if (input.url !== undefined || creating) {
    const url = String(input.url ?? '').trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('Enter the server URL, e.g. https://mcp.example.com/mcp.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('The URL must start with http:// or https://.');
    }
    out.url = url;
  }
  if (input.authType !== undefined) {
    if (!AUTH_TYPES.includes(input.authType)) throw new BadRequestException(`Unknown auth type "${input.authType}".`);
    out.authType = input.authType;
  }
  if (input.authHeader !== undefined) {
    const h = input.authHeader ? String(input.authHeader).trim() : '';
    if (h && !/^[A-Za-z0-9-]+$/.test(h)) throw new BadRequestException('The header name may only contain letters, digits and dashes.');
    out.authHeader = h || null;
  }
  if ((out.authType ?? input.authType) === 'header' && creating && !out.authHeader) {
    throw new BadRequestException('Enter the header name for header authentication.');
  }
  return out;
}
