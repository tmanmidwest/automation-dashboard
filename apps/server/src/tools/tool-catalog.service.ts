import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ConnectorInstance } from '@prisma/client';
import type { ConnectorInstanceSummary, Permission, SessionUser, TimelineKind } from '@cerebro/shared';
import { TIMELINE_KINDS } from '@cerebro/shared';
import { ConnectorRegistry } from '../connectors/connector-registry.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { MonitorsService } from '../monitors/monitors.service';
import { TimelineService } from '../timeline/timeline.service';
import { AutomationsService } from '../automations/automations.service';

/**
 * One tool in the shared catalog: a name, an LLM-facing description, a zod input shape,
 * the permission that gates it, and the body that actually runs it against Cerebro's
 * services. Both the MCP server ({@link ../mcp/mcp-server.factory}) and the in-app
 * assistant ({@link ../assistant/assistant.service}) consume this list, so there is
 * exactly one definition of each tool. Transport concerns — JSON wrapping, logging,
 * the confirm gate, and audit — stay in each consumer's wrapper, not here.
 */
export interface CatalogTool {
  name: string;
  description: string;
  /** Zod raw shape ({} when the tool takes no arguments). */
  inputSchema: z.ZodRawShape;
  permission: Permission;
  /** 'read' tools are side-effect-free; 'action' tools change state. */
  kind: 'read' | 'action';
  /** action only: hints a destructive change (delete/reboot/…). */
  destructive?: boolean;
  /** action only: require an explicit confirm before running (default true). */
  confirm?: boolean;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Builds the tool catalog for a single caller. Tools are included only when the caller
 * holds the required permission, so the user's role decides which tools exist — the same
 * model the REST API and MCP server enforce. Tool bodies call the underlying services
 * directly (no HTTP self-call).
 */
@Injectable()
export class ToolCatalogService {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly instances: ConnectorInstanceService,
    private readonly monitors: MonitorsService,
    private readonly timeline: TimelineService,
    private readonly automations: AutomationsService,
  ) {}

  /** Every tool the given user is permitted to use. */
  build(user: SessionUser): CatalogTool[] {
    const has = (p: Permission) => user.permissions.includes(p);
    const tools: CatalogTool[] = [];
    const read = (t: Omit<CatalogTool, 'kind'>) => tools.push({ ...t, kind: 'read' });
    const action = (t: Omit<CatalogTool, 'kind'>) => tools.push({ ...t, kind: 'action' });

    // ── Connectors (connectors:read) ──
    if (has('connectors:read')) {
      read({
        name: 'list_connectors',
        description: 'List all configured connector instances (Proxmox, AWS, …) with their status.',
        permission: 'connectors:read',
        inputSchema: {},
        run: async () => {
          const rows = await this.instances.list();
          return rows.map((r) => this.summary(r));
        },
      });

      read({
        name: 'get_overview',
        description:
          'Aggregate dashboard telemetry across all connectors: totals, per-connector reachability, metrics, and guests.',
        permission: 'connectors:read',
        inputSchema: {},
        run: () => this.instances.dashboardOverview(),
      });

      read({
        name: 'get_connector_overview',
        description: 'Metrics and guests for one connector instance.',
        permission: 'connectors:read',
        inputSchema: { instanceId: z.string().describe('Connector instance id') },
        run: ({ instanceId }) => this.instances.connectorOverview(instanceId as string),
      });

      read({
        name: 'list_resources',
        description: 'List resources of a given kind (e.g. "vm", "ec2", "bucket") for one connector instance.',
        permission: 'connectors:read',
        inputSchema: {
          instanceId: z.string().describe('Connector instance id'),
          kind: z.string().describe('Resource kind, as reported by the connector'),
        },
        run: ({ instanceId, kind }) => this.instances.listResources(instanceId as string, kind as string),
      });

      read({
        name: 'list_actions',
        description:
          'Discover the actions and operations available for a connector — resource actions (start/stop/…) with their mutating/destructive/confirm metadata, and parameterized operations with their form fields. Use before run_action / run_operation.',
        permission: 'connectors:read',
        inputSchema: {
          instanceId: z.string().describe('Connector instance id'),
          kind: z.string().optional().describe('Optional resource kind to filter by'),
        },
        run: ({ instanceId, kind }) => this.listActions(instanceId as string, kind as string | undefined),
      });

      read({
        name: 'get_job',
        description: 'Status of an async operation job started by run_operation (steps, progress, result).',
        permission: 'connectors:read',
        inputSchema: {
          instanceId: z.string().describe('Connector instance id'),
          jobId: z.string().describe('Job id returned by run_operation'),
        },
        run: ({ instanceId, jobId }) => {
          const job = this.instances.getJob(jobId as string);
          if (!job || job.instanceId !== instanceId) throw new Error('Job not found.');
          return Promise.resolve({
            id: job.id,
            label: job.label,
            status: job.status,
            steps: job.steps,
            message: job.message,
            createdResourceId: job.createdResourceId,
          });
        },
      });
    }

    // ── Connector actions (connectors:action) ──
    if (has('connectors:action')) {
      action({
        name: 'run_action',
        description: 'Perform a resource action (e.g. start/stop/reboot). Discover valid actionIds with list_actions. May be destructive.',
        permission: 'connectors:action',
        destructive: true,
        inputSchema: {
          instanceId: z.string().describe('Connector instance id'),
          kind: z.string().describe('Resource kind'),
          resourceId: z.string().describe('Resource id'),
          actionId: z.string().describe('Action id from list_actions'),
        },
        run: ({ instanceId, kind, resourceId, actionId }) =>
          this.instances.performAction(instanceId as string, kind as string, resourceId as string, actionId as string),
      });

      action({
        name: 'run_operation',
        description: 'Start a parameterized operation (create/deploy/backup, etc.). Returns a jobId to poll with get_job. Discover operationIds and their fields with list_actions. May be destructive.',
        permission: 'connectors:action',
        destructive: true,
        inputSchema: {
          instanceId: z.string().describe('Connector instance id'),
          operationId: z.string().describe('Operation id from list_actions'),
          resourceId: z.string().optional().describe('Target resource id, for resource-scoped operations'),
          values: z.record(z.unknown()).optional().describe('Operation field values (see list_actions fields)'),
        },
        run: async ({ instanceId, operationId, resourceId, values }) => {
          const jobId = await this.instances.startOperation(
            instanceId as string,
            operationId as string,
            resourceId as string | undefined,
            (values as Record<string, unknown>) ?? {},
          );
          return { jobId };
        },
      });

      action({
        name: 'cancel_job',
        description: 'Cancel a running operation job.',
        permission: 'connectors:action',
        inputSchema: {
          instanceId: z.string().describe('Connector instance id'),
          jobId: z.string().describe('Job id to cancel'),
        },
        run: ({ instanceId, jobId }) =>
          Promise.resolve({ ok: this.instances.cancelJob(instanceId as string, jobId as string) }),
      });

      action({
        name: 'delete_resource',
        description:
          'Delete/remove a resource whose kind is deletable — e.g. forget a Jellyfin device, remove a Docker container. Check list_resources / the connector to confirm the kind is deletable. Irreversible.',
        permission: 'connectors:action',
        destructive: true,
        inputSchema: {
          instanceId: z.string().describe('Connector instance id'),
          kind: z.string().describe('Resource kind (must be deletable for this connector)'),
          resourceId: z.string().describe('Resource id to delete'),
        },
        run: ({ instanceId, kind, resourceId }) =>
          this.instances.deleteResource(instanceId as string, kind as string, resourceId as string),
      });
    }

    // ── Monitors (monitors:read) ──
    if (has('monitors:read')) {
      read({
        name: 'list_monitors',
        description: 'List all uptime monitors with their current status.',
        permission: 'monitors:read',
        inputSchema: {},
        run: () => this.monitors.list(),
      });

      read({
        name: 'get_monitor',
        description: 'Full detail for one uptime monitor, including recent status.',
        permission: 'monitors:read',
        inputSchema: { monitorId: z.string().describe('Monitor id') },
        run: ({ monitorId }) => this.monitors.get(monitorId as string),
      });

      read({
        name: 'get_monitor_stats',
        description: 'Aggregate uptime-monitor statistics (counts up/down/paused, etc.).',
        permission: 'monitors:read',
        inputSchema: {},
        run: () => this.monitors.stats(),
      });
    }

    // ── Monitor management (monitors:write) ──
    if (has('monitors:write')) {
      action({
        name: 'pause_monitor',
        description: 'Pause a monitor (stop probing it).',
        permission: 'monitors:write',
        inputSchema: { monitorId: z.string().describe('Monitor id') },
        run: ({ monitorId }) => this.monitors.setEnabled(monitorId as string, false),
      });

      action({
        name: 'resume_monitor',
        description: 'Resume a paused monitor.',
        permission: 'monitors:write',
        inputSchema: { monitorId: z.string().describe('Monitor id') },
        run: ({ monitorId }) => this.monitors.setEnabled(monitorId as string, true),
      });

      // A trigger, not a state change — no confirm required.
      action({
        name: 'check_monitor_now',
        description: 'Trigger an immediate check of a monitor and return the result.',
        permission: 'monitors:write',
        confirm: false,
        inputSchema: { monitorId: z.string().describe('Monitor id') },
        run: ({ monitorId }) => this.monitors.checkNow(monitorId as string),
      });
    }

    // ── Timeline / Ship's Log (logs:read) ──
    if (has('logs:read')) {
      read({
        name: 'get_timeline',
        description:
          "Recent events across all of Cerebro (the \"Ship's Log\"): audit actions, app logs, delivered alerts, connector jobs, and monitor state changes — newest first. Filter by kind, severity, source (connectorId / monitor id / 'auth'), actor, or a text substring; page older with `before` (pass a prior nextCursor). Use this to answer \"what happened recently?\" or investigate an incident.",
        permission: 'logs:read',
        inputSchema: {
          kinds: z.array(z.string()).optional().describe(`Filter to these kinds. Any of: ${TIMELINE_KINDS.join(', ')}.`),
          severities: z.array(z.string()).optional().describe('Filter to these severities: info, success, warning, critical.'),
          source: z.string().optional().describe("Match an event's source (connectorId, monitor id, 'auth', 'system', …)"),
          actorId: z.string().optional().describe('Only events by this actor id'),
          text: z.string().optional().describe('Case-insensitive substring over title/detail'),
          before: z.string().optional().describe('ISO cursor — return events strictly older than this (from a prior nextCursor)'),
          limit: z.number().optional().describe('Max events (default 100, max 500)'),
        },
        run: (args) => {
          // Mirror the controller's audit gate: a caller without audit:read never
          // sees the who-did-what stream, so drop 'audit' from the requested kinds.
          const requested = ((args.kinds as string[] | undefined) ?? []).filter((k): k is TimelineKind =>
            (TIMELINE_KINDS as string[]).includes(k),
          );
          let kinds: TimelineKind[] | undefined = requested.length ? requested : undefined;
          if (!has('audit:read')) {
            const base = kinds ?? TIMELINE_KINDS;
            kinds = base.filter((k) => k !== 'audit');
          }
          return this.timeline.query({
            kinds,
            severities: args.severities as ('info' | 'success' | 'warning' | 'critical')[] | undefined,
            source: args.source as string | undefined,
            actorId: args.actorId as string | undefined,
            text: args.text as string | undefined,
            before: args.before as string | undefined,
            limit: args.limit as number | undefined,
          });
        },
      });
    }

    // ── Automations (automations:read) ──
    if (has('automations:read')) {
      read({
        name: 'list_automations',
        description: 'List automation rules (WHEN a trigger → IF conditions → DO actions) with their enabled state, trigger, and last-fired time.',
        permission: 'automations:read',
        inputSchema: {},
        run: () => this.automations.list(),
      });

      read({
        name: 'get_automation',
        description: 'Full detail for one automation rule: trigger, conditions, actions, cooldown.',
        permission: 'automations:read',
        inputSchema: { ruleId: z.string().describe('Automation rule id') },
        run: async ({ ruleId }) => {
          const rule = await this.automations.get(ruleId as string);
          if (!rule) throw new Error('Rule not found.');
          return rule;
        },
      });

      read({
        name: 'get_automation_runs',
        description: 'Recent automation run history (status + message per firing), optionally for one rule.',
        permission: 'automations:read',
        inputSchema: {
          ruleId: z.string().optional().describe('Optional rule id to filter by'),
          limit: z.number().optional().describe('Max runs (default 100)'),
        },
        run: ({ ruleId, limit }) => this.automations.runs(ruleId as string | undefined, limit as number | undefined),
      });
    }

    // ── Automation management (automations:write) ──
    if (has('automations:write')) {
      action({
        name: 'set_automation_enabled',
        description: 'Enable or disable an automation rule.',
        permission: 'automations:write',
        inputSchema: {
          ruleId: z.string().describe('Automation rule id'),
          enabled: z.boolean().describe('true to enable, false to disable'),
        },
        run: ({ ruleId, enabled }) =>
          this.automations.update(ruleId as string, { enabled: enabled as boolean }, { actorId: user.id, actorEmail: user.email }),
      });

      action({
        name: 'test_automation',
        description: 'Run an automation rule now (fires its actions, ignoring the trigger and cooldown). May be destructive depending on the rule.',
        permission: 'automations:write',
        destructive: true,
        inputSchema: { ruleId: z.string().describe('Automation rule id') },
        run: ({ ruleId }) => this.automations.test(ruleId as string),
      });
    }

    return tools;
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

  /** Mirror of ConnectorsController.summary — keeps tool output identical to the REST API. */
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
