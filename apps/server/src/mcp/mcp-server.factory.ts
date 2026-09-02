import { Injectable, Logger } from '@nestjs/common';
// The specifier below is what Node resolves at runtime (via the SDK's `exports`);
// a `paths` mapping in tsconfig.json redirects *type* resolution to the physical CJS
// `.d.ts`, because the server compiles with classic (`Node10`) resolution, which
// rejects bare deep imports into a package that declares `exports`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ConnectorInstance } from '@prisma/client';
import type { ConnectorInstanceSummary, Permission, SessionUser } from '@cerebro/shared';
import { ConnectorRegistry } from '../connectors/connector-registry.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { MonitorsService } from '../monitors/monitors.service';

const SERVER_NAME = 'cerebro';

/**
 * Builds an MCP server scoped to a single caller. Tools are registered only when the
 * caller holds the required permission, so the token's scopes decide which tools exist
 * for that connection — the same read permissions the REST API enforces. Tools call the
 * underlying services directly (no HTTP self-call), and return results as JSON text.
 */
@Injectable()
export class McpServerFactory {
  private readonly logger = new Logger(McpServerFactory.name);

  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly instances: ConnectorInstanceService,
    private readonly monitors: MonitorsService,
  ) {}

  build(user: SessionUser): McpServer {
    const server = new McpServer({ name: SERVER_NAME, version: '1.0.0' });
    const has = (p: Permission) => user.permissions.includes(p);

    // Wraps a tool body so thrown errors become a clean MCP error result rather
    // than crashing the request, and successful results become JSON text content.
    const tool = <A extends z.ZodRawShape>(
      name: string,
      config: { description: string; inputSchema?: A },
      run: (args: z.infer<z.ZodObject<A>>) => Promise<unknown>,
    ) => {
      const handler = async (args: unknown) => {
        try {
          const data = await run((args ?? {}) as z.infer<z.ZodObject<A>>);
          return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`MCP tool ${name} failed: ${message}`);
          return { isError: true, content: [{ type: 'text' as const, text: `Error: ${message}` }] };
        }
      };
      // Cast around the SDK's deeply-generic registerTool overloads (TS2589) — the
      // handler's own arg typing above already gives call sites their safety.
      (server.registerTool as (n: string, c: unknown, h: typeof handler) => unknown)(name, config, handler);
    };

    // ── Connectors (connectors:read) ──
    if (has('connectors:read')) {
      tool('list_connectors', {
        description: 'List all configured connector instances (Proxmox, AWS, …) with their status.',
      }, async () => {
        const rows = await this.instances.list();
        return rows.map((r) => this.summary(r));
      });

      tool('get_overview', {
        description:
          'Aggregate dashboard telemetry across all connectors: totals, per-connector reachability, metrics, and guests.',
      }, () => this.instances.dashboardOverview());

      tool('get_connector_overview', {
        description: 'Metrics and guests for one connector instance.',
        inputSchema: { instanceId: z.string().describe('Connector instance id') },
      }, ({ instanceId }) => this.instances.connectorOverview(instanceId));

      tool('list_resources', {
        description: 'List resources of a given kind (e.g. "vm", "ec2", "bucket") for one connector instance.',
        inputSchema: {
          instanceId: z.string().describe('Connector instance id'),
          kind: z.string().describe('Resource kind, as reported by the connector'),
        },
      }, ({ instanceId, kind }) => this.instances.listResources(instanceId, kind));
    }

    // ── Monitors (monitors:read) ──
    if (has('monitors:read')) {
      tool('list_monitors', {
        description: 'List all uptime monitors with their current status.',
      }, () => this.monitors.list());

      tool('get_monitor', {
        description: 'Full detail for one uptime monitor, including recent status.',
        inputSchema: { monitorId: z.string().describe('Monitor id') },
      }, ({ monitorId }) => this.monitors.get(monitorId));

      tool('get_monitor_stats', {
        description: 'Aggregate uptime-monitor statistics (counts up/down/paused, etc.).',
      }, () => this.monitors.stats());
    }

    return server;
  }

  /** Mirror of ConnectorsController.summary — keeps MCP output identical to the REST API. */
  private summary(inst: ConnectorInstance): ConnectorInstanceSummary {
    const manifest = this.registry.get(inst.connectorId)?.manifest;
    return {
      id: inst.id,
      connectorId: inst.connectorId,
      connectorName: manifest?.name ?? inst.connectorId,
      icon: manifest?.icon ?? 'generic',
      name: inst.name,
      enabled: inst.enabled,
      createdAt: inst.createdAt.toISOString(),
      lastSyncedAt: this.instances.lastSyncedAt(inst.id),
      refreshIntervalSec:
        (inst as ConnectorInstance & { refreshIntervalSec?: number }).refreshIntervalSec ?? 30,
    };
  }
}
