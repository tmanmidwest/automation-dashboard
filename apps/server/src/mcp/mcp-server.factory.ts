import { Injectable, Logger } from '@nestjs/common';
// The specifier below is what Node resolves at runtime (via the SDK's `exports`);
// a `paths` mapping in tsconfig.json redirects *type* resolution to the physical CJS
// `.d.ts`, because the server compiles with classic (`Node10`) resolution, which
// rejects bare deep imports into a package that declares `exports`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ConnectorInstance } from '@prisma/client';
import type { ConnectorInstanceSummary, Permission, SessionUser, TimelineKind } from '@cerebro/shared';
import { TIMELINE_KINDS } from '@cerebro/shared';
import { ConnectorRegistry } from '../connectors/connector-registry.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { MonitorsService } from '../monitors/monitors.service';
import { TimelineService } from '../timeline/timeline.service';
import { AutomationsService } from '../automations/automations.service';
import { AuditService } from '../logging/audit.service';
import { LoggingService } from '../logging/logging.service';

const SERVER_NAME = 'cerebro';

/** Identifies the credential a tool call arrived on, for the audit trail. */
export interface McpOrigin {
  tokenId?: string;
  oauthClientId?: string;
}

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
    private readonly timeline: TimelineService,
    private readonly automations: AutomationsService,
    private readonly audit: AuditService,
    private readonly logging: LoggingService,
  ) {}

  build(user: SessionUser, origin: McpOrigin = {}): McpServer {
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
          const text = JSON.stringify(data, null, 2);
          // Record what Cerebro actually returned, so we can tell server-side output
          // apart from client-side truncation (e.g. a small local model showing fewer rows).
          const count = Array.isArray(data) ? data.length : undefined;
          void this.logging.info(
            'mcp',
            `tool: ${name}${count !== undefined ? ` → ${count} items` : ''} (${text.length} bytes)`,
            { user: user.email, items: count, bytes: text.length },
          );
          return { content: [{ type: 'text' as const, text }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          void this.logging.warn('mcp', `tool ${name} failed: ${message}`, { user: user.email });
          return { isError: true, content: [{ type: 'text' as const, text: `Error: ${message}` }] };
        }
      };
      // Cast around the SDK's deeply-generic registerTool overloads (TS2589) — the
      // handler's own arg typing above already gives call sites their safety.
      (server.registerTool as (n: string, c: unknown, h: typeof handler) => unknown)(name, config, handler);
    };

    // A state-changing tool. Adds MCP annotations (so clients prompt) and, when
    // `confirm` is set (default true), requires a `confirm: true` argument before running —
    // a client-agnostic guardrail. Every successful call is written to the audit trail,
    // tagged with the MCP origin, since these bypass the controllers that normally audit.
    const actionTool = <A extends z.ZodRawShape>(
      name: string,
      config: { description: string; inputSchema: A; destructive?: boolean; confirm?: boolean },
      run: (args: z.infer<z.ZodObject<A>>) => Promise<unknown>,
    ) => {
      const needsConfirm = config.confirm !== false;
      // `confirm` is optional in the schema (so an omitted value reaches the handler and
      // gets the clear refusal below, rather than a raw schema-validation error).
      const inputSchema = needsConfirm
        ? { ...config.inputSchema, confirm: z.boolean().optional().describe('Must be set to true to execute this state-changing action.') }
        : config.inputSchema;

      const handler = async (rawArgs: unknown) => {
        const args = (rawArgs ?? {}) as z.infer<z.ZodObject<A>> & { confirm?: boolean };
        if (needsConfirm && args.confirm !== true) {
          void this.logging.info('mcp', `action refused (no confirm): ${name}`, { user: user.email });
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Refused: "${name}" changes state. Re-call with confirm: true to proceed. (${config.description})` }],
          };
        }
        void this.logging.info('mcp', `action: ${name}`, { user: user.email });
        try {
          const data = await run(args);
          await this.recordAudit(user, origin, name, args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          void this.logging.warn('mcp', `action ${name} failed: ${message}`, { user: user.email });
          return { isError: true, content: [{ type: 'text' as const, text: `Error: ${message}` }] };
        }
      };

      const toolConfig = {
        description: config.description,
        inputSchema,
        annotations: { readOnlyHint: false, destructiveHint: !!config.destructive },
      };
      (server.registerTool as (n: string, c: unknown, h: typeof handler) => unknown)(name, toolConfig, handler);
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

      tool('list_actions', {
        description:
          'Discover the actions and operations available for a connector — resource actions (start/stop/…) with their mutating/destructive/confirm metadata, and parameterized operations with their form fields. Use before run_action / run_operation.',
        inputSchema: {
          instanceId: z.string().describe('Connector instance id'),
          kind: z.string().optional().describe('Optional resource kind to filter by'),
        },
      }, ({ instanceId, kind }) => this.listActions(instanceId, kind));

      tool('get_job', {
        description: 'Status of an async operation job started by run_operation (steps, progress, result).',
        inputSchema: {
          instanceId: z.string().describe('Connector instance id'),
          jobId: z.string().describe('Job id returned by run_operation'),
        },
      }, ({ instanceId, jobId }) => {
        const job = this.instances.getJob(jobId);
        if (!job || job.instanceId !== instanceId) throw new Error('Job not found.');
        return Promise.resolve({ id: job.id, label: job.label, status: job.status, steps: job.steps, message: job.message, createdResourceId: job.createdResourceId });
      });
    }

    // ── Connector actions (connectors:action) ──
    if (has('connectors:action')) {
      actionTool('run_action', {
        description: 'Perform a resource action (e.g. start/stop/reboot). Discover valid actionIds with list_actions. May be destructive.',
        destructive: true,
        inputSchema: {
          instanceId: z.string().describe('Connector instance id'),
          kind: z.string().describe('Resource kind'),
          resourceId: z.string().describe('Resource id'),
          actionId: z.string().describe('Action id from list_actions'),
        },
      }, ({ instanceId, kind, resourceId, actionId }) => this.instances.performAction(instanceId, kind, resourceId, actionId));

      actionTool('run_operation', {
        description: 'Start a parameterized operation (create/deploy/backup, etc.). Returns a jobId to poll with get_job. Discover operationIds and their fields with list_actions. May be destructive.',
        destructive: true,
        inputSchema: {
          instanceId: z.string().describe('Connector instance id'),
          operationId: z.string().describe('Operation id from list_actions'),
          resourceId: z.string().optional().describe('Target resource id, for resource-scoped operations'),
          values: z.record(z.unknown()).optional().describe('Operation field values (see list_actions fields)'),
        },
      }, async ({ instanceId, operationId, resourceId, values }) => {
        const jobId = await this.instances.startOperation(instanceId, operationId, resourceId, values ?? {});
        return { jobId };
      });

      actionTool('cancel_job', {
        description: 'Cancel a running operation job.',
        inputSchema: {
          instanceId: z.string().describe('Connector instance id'),
          jobId: z.string().describe('Job id to cancel'),
        },
      }, ({ instanceId, jobId }) => Promise.resolve({ ok: this.instances.cancelJob(instanceId, jobId) }));

      actionTool('delete_resource', {
        description:
          'Delete/remove a resource whose kind is deletable — e.g. forget a Jellyfin device, remove a Docker container. Check list_resources / the connector to confirm the kind is deletable. Irreversible.',
        destructive: true,
        inputSchema: {
          instanceId: z.string().describe('Connector instance id'),
          kind: z.string().describe('Resource kind (must be deletable for this connector)'),
          resourceId: z.string().describe('Resource id to delete'),
        },
      }, ({ instanceId, kind, resourceId }) => this.instances.deleteResource(instanceId, kind, resourceId));
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

    // ── Monitor management (monitors:write) ──
    if (has('monitors:write')) {
      actionTool('pause_monitor', {
        description: 'Pause a monitor (stop probing it).',
        inputSchema: { monitorId: z.string().describe('Monitor id') },
      }, ({ monitorId }) => this.monitors.setEnabled(monitorId, false));

      actionTool('resume_monitor', {
        description: 'Resume a paused monitor.',
        inputSchema: { monitorId: z.string().describe('Monitor id') },
      }, ({ monitorId }) => this.monitors.setEnabled(monitorId, true));

      // A trigger, not a state change — no confirm required.
      actionTool('check_monitor_now', {
        description: 'Trigger an immediate check of a monitor and return the result.',
        confirm: false,
        inputSchema: { monitorId: z.string().describe('Monitor id') },
      }, ({ monitorId }) => this.monitors.checkNow(monitorId));
    }

    // ── Timeline / Ship's Log (logs:read) ──
    if (has('logs:read')) {
      tool('get_timeline', {
        description:
          "Recent events across all of Cerebro (the \"Ship's Log\"): audit actions, app logs, delivered alerts, connector jobs, and monitor state changes — newest first. Filter by kind, severity, source (connectorId / monitor id / 'auth'), actor, or a text substring; page older with `before` (pass a prior nextCursor). Use this to answer \"what happened recently?\" or investigate an incident.",
        inputSchema: {
          kinds: z.array(z.string()).optional().describe(`Filter to these kinds. Any of: ${TIMELINE_KINDS.join(', ')}.`),
          severities: z.array(z.string()).optional().describe('Filter to these severities: info, success, warning, critical.'),
          source: z.string().optional().describe("Match an event's source (connectorId, monitor id, 'auth', 'system', …)"),
          actorId: z.string().optional().describe('Only events by this actor id'),
          text: z.string().optional().describe('Case-insensitive substring over title/detail'),
          before: z.string().optional().describe('ISO cursor — return events strictly older than this (from a prior nextCursor)'),
          limit: z.number().optional().describe('Max events (default 100, max 500)'),
        },
      }, (args) => {
        // Mirror the controller's audit gate: a caller without audit:read never
        // sees the who-did-what stream, so drop 'audit' from the requested kinds.
        const requested = (args.kinds ?? []).filter((k): k is TimelineKind => (TIMELINE_KINDS as string[]).includes(k));
        let kinds: TimelineKind[] | undefined = requested.length ? requested : undefined;
        if (!has('audit:read')) {
          const base = kinds ?? TIMELINE_KINDS;
          kinds = base.filter((k) => k !== 'audit');
        }
        return this.timeline.query({
          kinds,
          severities: args.severities as ('info' | 'success' | 'warning' | 'critical')[] | undefined,
          source: args.source,
          actorId: args.actorId,
          text: args.text,
          before: args.before,
          limit: args.limit,
        });
      });
    }

    // ── Automations (automations:read) ──
    if (has('automations:read')) {
      tool('list_automations', {
        description: 'List automation rules (WHEN a trigger → IF conditions → DO actions) with their enabled state, trigger, and last-fired time.',
      }, () => this.automations.list());

      tool('get_automation', {
        description: 'Full detail for one automation rule: trigger, conditions, actions, cooldown.',
        inputSchema: { ruleId: z.string().describe('Automation rule id') },
      }, async ({ ruleId }) => {
        const rule = await this.automations.get(ruleId);
        if (!rule) throw new Error('Rule not found.');
        return rule;
      });

      tool('get_automation_runs', {
        description: 'Recent automation run history (status + message per firing), optionally for one rule.',
        inputSchema: {
          ruleId: z.string().optional().describe('Optional rule id to filter by'),
          limit: z.number().optional().describe('Max runs (default 100)'),
        },
      }, ({ ruleId, limit }) => this.automations.runs(ruleId, limit));
    }

    // ── Automation management (automations:write) ──
    // Rule authoring (create/edit/delete) stays in the session-only REST API; over a
    // token we expose only enable/disable and test — enough to operate, not to author.
    if (has('automations:write')) {
      actionTool('set_automation_enabled', {
        description: 'Enable or disable an automation rule.',
        inputSchema: {
          ruleId: z.string().describe('Automation rule id'),
          enabled: z.boolean().describe('true to enable, false to disable'),
        },
      }, ({ ruleId, enabled }) => this.automations.update(ruleId, { enabled }, { actorId: user.id, actorEmail: user.email }));

      actionTool('test_automation', {
        description: 'Run an automation rule now (fires its actions, ignoring the trigger and cooldown). May be destructive depending on the rule.',
        destructive: true,
        inputSchema: { ruleId: z.string().describe('Automation rule id') },
      }, ({ ruleId }) => this.automations.test(ruleId));
    }

    return server;
  }

  /** Discover the resource actions and operations available for an instance (optionally by kind). */
  private async listActions(instanceId: string, kind?: string) {
    const inst = await this.instances.get(instanceId);
    const manifest = this.registry.get(inst.connectorId)?.manifest;
    const resourceActions = (manifest?.resourceKinds ?? [])
      .filter((k) => !kind || k.id === kind)
      .flatMap((k) =>
        k.actions.map((a) => ({
          kind: k.id,
          id: a.id,
          label: a.label,
          mutating: a.mutating,
          intent: a.intent ?? 'default',
          confirm: a.confirm,
          showWhenStatus: a.showWhenStatus,
        })),
      );
    const operations = this.instances
      .operations(inst)
      .filter((o) => !kind || o.kind === kind)
      .map((o) => ({ id: o.id, label: o.label, description: o.description, scope: o.scope, kind: o.kind, intent: o.intent ?? 'default', fields: o.fields }));
    return { resourceActions, operations };
  }

  /** Record an MCP-initiated action to the audit trail (services don't audit; controllers do). */
  private async recordAudit(user: SessionUser, origin: McpOrigin, toolName: string, args: Record<string, unknown>) {
    const { confirm: _confirm, ...meta } = args;
    const target = String(args.resourceId ?? args.monitorId ?? args.ruleId ?? args.operationId ?? args.jobId ?? args.instanceId ?? '');
    await this.audit
      .record({
        actorId: user.id,
        actorEmail: user.email,
        action: `mcp.${toolName}`,
        target: target || null,
        meta: { ...meta, via: 'mcp', tokenId: origin.tokenId, oauthClientId: origin.oauthClientId },
      })
      .catch(() => undefined);
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
