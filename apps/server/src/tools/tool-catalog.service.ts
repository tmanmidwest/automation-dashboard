import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ConnectorInstance } from '@prisma/client';
import type {
  AutomationRuleInput,
  ConnectorInstanceSummary,
  MonitorInput,
  NotificationChannelId,
  NotificationSeverity,
  Permission,
  SessionUser,
  TimelineKind,
} from '@cerebro/shared';
import { TIMELINE_KINDS } from '@cerebro/shared';
import { ConnectorRegistry } from '../connectors/connector-registry.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { MonitorsService } from '../monitors/monitors.service';
import { TimelineService } from '../timeline/timeline.service';
import { AutomationsService } from '../automations/automations.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReplicatorService } from '../app-replicator/replicator.service';
import { DeploymentService } from '../app-replicator/deployment.service';
import { UpdateCheckService } from '../app-replicator/update-check.service';
import { IngressService } from '../app-replicator/ingress.service';

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
  /** action only: arg keys to strip before the call is written to the audit trail
   *  (e.g. plaintext secrets). Honoured by both the MCP factory and the assistant. */
  redactKeys?: string[];
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
    private readonly notifications: NotificationsService,
    private readonly replicator: ReplicatorService,
    private readonly deployments: DeploymentService,
    private readonly updateCheck: UpdateCheckService,
    private readonly ingress: IngressService,
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

      read({
        name: 'list_monitor_types',
        description:
          'List the available monitor probe types (http, ping, tcp, dns, …) and each one\'s config fields. Use before create_monitor / update_monitor to build a valid `type` + `config`.',
        permission: 'monitors:read',
        inputSchema: {},
        run: () => Promise.resolve(this.monitors.types()),
      });
    }

    // ── Monitor management (monitors:write) ──
    if (has('monitors:write')) {
      action({
        name: 'create_monitor',
        description:
          'Create an uptime monitor. `type` is a probe id (e.g. "http", "ping", "tcp", "dns") and `config` holds that probe\'s fields — discover both with list_monitor_types. Interval/retry/timeout fields are optional and default sensibly.',
        permission: 'monitors:write',
        inputSchema: monitorInputShape(),
        run: (a) => this.monitors.create(toMonitorInput(a)),
      });

      action({
        name: 'update_monitor',
        description:
          'Update an uptime monitor. This replaces the monitor\'s settings (PUT semantics), so pass the full desired config — read the current one with get_monitor first.',
        permission: 'monitors:write',
        inputSchema: { monitorId: z.string().describe('Monitor id'), ...monitorInputShape() },
        run: (a) => this.monitors.update(a.monitorId as string, toMonitorInput(a)),
      });

      action({
        name: 'delete_monitor',
        description: 'Delete an uptime monitor and its history. Irreversible.',
        permission: 'monitors:write',
        destructive: true,
        inputSchema: { monitorId: z.string().describe('Monitor id') },
        run: async ({ monitorId }) => {
          await this.monitors.remove(monitorId as string);
          return { ok: true };
        },
      });

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
      const actor = { actorId: user.id, actorEmail: user.email };

      action({
        name: 'create_automation',
        description:
          'Create an automation rule: WHEN a trigger fires, IF conditions hold, DO actions. ' +
          "trigger is either {type:'event', kinds?, severities?, source?, textContains?} or {type:'schedule', cron:'m h dom mon dow'}. " +
          "actions is an array; each is one of: {type:'notify', title, body?}, {type:'connector_action', instanceId, kind, resourceId, actionId}, {type:'connector_operation', instanceId, operationId, resourceId?, values?}, {type:'pause_monitor', monitorId}, {type:'resume_monitor', monitorId}, {type:'webhook', url, method?, body?}, {type:'ask_computer', prompt, title?}. " +
          "conditions (optional, AND'd) each: {type:'severity_at_least', severity}, {type:'time_window', start, end}, {type:'meta_threshold', path, op, value}, {type:'monitor_state', monitorId, state}. Discover connector ids/actions with list_connectors + list_actions.",
        permission: 'automations:write',
        inputSchema: automationInputShape(),
        run: (a) => this.automations.create(toAutomationInput(a), actor),
      });

      action({
        name: 'update_automation',
        description:
          'Update an automation rule. Only the fields you pass are changed; omit a field to leave it as-is. Pass a full replacement for `trigger`, `conditions`, or `actions` when you change them (they are not merged element-wise).',
        permission: 'automations:write',
        inputSchema: {
          ruleId: z.string().describe('Automation rule id'),
          ...automationInputShape({ partial: true }),
        },
        run: (a) => this.automations.update(a.ruleId as string, toAutomationInput(a), actor),
      });

      action({
        name: 'delete_automation',
        description: 'Delete an automation rule. Irreversible.',
        permission: 'automations:write',
        destructive: true,
        inputSchema: { ruleId: z.string().describe('Automation rule id') },
        run: async ({ ruleId }) => {
          await this.automations.remove(ruleId as string, actor);
          return { ok: true };
        },
      });

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

    // ── App Replicator (replicator:read) ──
    if (has('replicator:read')) {
      read({
        name: 'list_replicator_apps',
        description:
          'List the apps registered in the App Replicator (a Git-repo app that can be materialized as many isolated instances), with their variable/port/secret schema.',
        permission: 'replicator:read',
        inputSchema: {},
        run: () => this.replicator.listApps(),
      });

      read({
        name: 'get_replicator_app',
        description: 'Full detail for one registered App Replicator app: repo, compose schema, variables, ports, secrets, and deploy target.',
        permission: 'replicator:read',
        inputSchema: { appId: z.string().describe('Replicator app id') },
        run: ({ appId }) => this.replicator.getApp(appId as string),
      });

      read({
        name: 'list_replicator_deployments',
        description:
          'List App Replicator deployments (materialized instances) with their status, host, and update availability. Optionally filter to one app.',
        permission: 'replicator:read',
        inputSchema: { appId: z.string().optional().describe('Optional app id to filter by') },
        run: ({ appId }) =>
          appId ? this.deployments.listForApp(appId as string) : this.deployments.listAll(),
      });

      read({
        name: 'check_replicator_update',
        description:
          "Check one deployment against its app's Git repo tip and report whether a newer commit is available to redeploy.",
        permission: 'replicator:read',
        inputSchema: { deploymentId: z.string().describe('Replicator deployment id') },
        run: ({ deploymentId }) => this.updateCheck.checkOne(deploymentId as string),
      });

      read({
        name: 'get_replicator_deployment',
        description:
          'Full detail for one App Replicator deployment — status, live phase, resolved values, ports, and ingress. Poll this after deploy/redeploy until status is "deployed" or "error".',
        permission: 'replicator:read',
        inputSchema: { deploymentId: z.string().describe('Replicator deployment id') },
        run: async ({ deploymentId }) => {
          const all = await this.deployments.listAll();
          const dep = all.find((d) => d.id === deploymentId);
          if (!dep) throw new Error('Deployment not found.');
          return dep;
        },
      });

      read({
        name: 'list_replicator_targets',
        description:
          'List the deploy targets an app can be materialized onto (Docker hosts and AWS/ECS connector instances), with each target\'s reachability and whether it can accept a deploy.',
        permission: 'replicator:read',
        inputSchema: {},
        run: () => this.replicator.listTargets(),
      });

      read({
        name: 'get_replicator_deploy_plan',
        description:
          'Plan a deploy of an app onto a target: returns the host IP, ports already in use, and a suggested free host port per published-port variable. Use to pick ports before deploy_replicator_instance.',
        permission: 'replicator:read',
        inputSchema: {
          appId: z.string().describe('Replicator app id'),
          dockerInstanceId: z.string().describe('Target connector instance id (from list_replicator_targets)'),
        },
        run: async ({ appId, dockerInstanceId }) => {
          const app = await this.replicator.getApp(appId as string);
          return this.deployments.targetInfo(dockerInstanceId as string, app.variables);
        },
      });

      read({
        name: 'list_replicator_ingress_options',
        description:
          'For a Cloudflare or NPM connector instance, list the ingress options a deployment can be fronted with: Cloudflare tunnels and NPM certificates. Use before add_replicator_ingress.',
        permission: 'replicator:read',
        inputSchema: { instanceId: z.string().describe('Cloudflare or NPM connector instance id') },
        run: async ({ instanceId }) => ({
          tunnels: await this.ingress.listTunnels(instanceId as string),
          certs: await this.ingress.listCerts(instanceId as string),
        }),
      });
    }

    // ── App Replicator writes (replicator:write) — Computer-only; deploying runs
    //    infra, so this scope is deliberately NOT in GRANTABLE_TOKEN_SCOPES (no bearer
    //    token holds it — only the owner's in-app assistant session does). ──
    if (has('replicator:write')) {
      const actor = { actorId: user.id, actorEmail: user.email };

      action({
        name: 'deploy_replicator_instance',
        description:
          'Deploy a registered app as a new isolated instance on a target host. Validates synchronously (name/port clash, missing required values) then builds in the background — poll get_replicator_deployment until status is "deployed" or "error". Discover ids with list_replicator_apps + list_replicator_targets, and free ports with get_replicator_deploy_plan.',
        permission: 'replicator:write',
        destructive: true,
        redactKeys: ['secrets'],
        inputSchema: {
          appId: z.string().describe('Registered app id'),
          dockerInstanceId: z.string().describe('Target connector instance id (Docker host, or AWS for an ECS deploy)'),
          name: z.string().describe('Operator-chosen instance name (sanitized into the compose project name)'),
          values: z.record(z.string()).optional().describe('Non-secret variable values keyed by name (omit → repo default)'),
          secrets: z.record(z.string()).optional().describe('Secret variable values keyed by name (plaintext, one-time; stored encrypted in the vault)'),
          ports: z.record(z.number()).optional().describe('Chosen host port per host_port variable name'),
          forceRebuild: z.boolean().optional().describe('docker compose build --no-cache (for repos that build their own image)'),
          targetKind: z.enum(['docker', 'ecs']).optional().describe("Deploy backend (default 'docker')"),
          taskCpu: z.string().optional().describe('ECS only: Fargate task CPU units (default 256)'),
          taskMemory: z.string().optional().describe('ECS only: Fargate task memory MiB (default 512)'),
        },
        run: (a) =>
          this.deployments.deploy(
            a.appId as string,
            {
              dockerInstanceId: a.dockerInstanceId as string,
              name: a.name as string,
              values: (a.values as Record<string, string>) ?? {},
              secrets: (a.secrets as Record<string, string>) ?? {},
              ports: (a.ports as Record<string, number>) ?? {},
              forceRebuild: a.forceRebuild as boolean | undefined,
              targetKind: a.targetKind as 'docker' | 'ecs' | undefined,
              taskCpu: a.taskCpu as string | undefined,
              taskMemory: a.taskMemory as string | undefined,
            },
            actor,
          ),
      });

      action({
        name: 'redeploy_replicator_deployment',
        description:
          'Redeploy an existing deployment. With edit omitted/false it re-runs the stored config (pull latest / rebuild) — the way to apply an available update. With edit:true the supplied maps are merged over the stored config first (change a value, rotate a secret, move a host port). Runs in the background; poll get_replicator_deployment.',
        permission: 'replicator:write',
        redactKeys: ['secrets'],
        inputSchema: {
          deploymentId: z.string().describe('Deployment id'),
          forceRebuild: z.boolean().optional().describe('docker compose build --no-cache'),
          edit: z.boolean().optional().describe('Apply the maps below before redeploying (an edit), rather than reusing the stored config'),
          values: z.record(z.string()).optional().describe('Edited non-secret values (name→value); omit a key to keep the stored value'),
          secrets: z.record(z.string()).optional().describe('Rotated secrets (name→value); omit or blank a key to keep the stored secret'),
          ports: z.record(z.number()).optional().describe('Edited host ports (host_port var name→port); omit a key to keep the stored port'),
        },
        run: (a) =>
          this.deployments.redeploy(
            a.deploymentId as string,
            {
              forceRebuild: a.forceRebuild as boolean | undefined,
              edit: a.edit as boolean | undefined,
              values: a.values as Record<string, string> | undefined,
              secrets: a.secrets as Record<string, string> | undefined,
              ports: a.ports as Record<string, number> | undefined,
            },
            actor,
          ),
      });

      action({
        name: 'teardown_replicator_deployment',
        description:
          'Tear down a deployment: stops and removes the stack, removes any ingress routes fronting it, and deletes its vault secrets. Irreversible.',
        permission: 'replicator:write',
        destructive: true,
        inputSchema: { deploymentId: z.string().describe('Deployment id') },
        run: ({ deploymentId }) => this.deployments.remove(deploymentId as string, actor),
      });

      action({
        name: 'add_replicator_ingress',
        description:
          'Expose a deployment\'s published port to the outside via a Cloudflare tunnel or an NPM proxy host. Discover the instanceId and its tunnels/certs with list_replicator_ingress_options; the service + hostPort come from the deployment\'s ports (get_replicator_deployment).',
        permission: 'replicator:write',
        inputSchema: {
          deploymentId: z.string().describe('Deployment id'),
          kind: z.enum(['cloudflare', 'npm']).describe('Ingress backend'),
          instanceId: z.string().describe('Cloudflare or NPM connector instance id'),
          service: z.string().describe('The compose service whose published port this fronts'),
          hostPort: z.number().describe('The published host port to route to'),
          hostname: z.string().describe('Public hostname, e.g. demo.example.com'),
          tunnelId: z.string().optional().describe('Cloudflare: the tunnel to add the public-hostname route to'),
          certificateId: z.number().optional().describe('NPM: existing certificate id (0/omitted = HTTP-only)'),
          sslForced: z.boolean().optional().describe('NPM: force SSL when a cert is attached'),
        },
        run: (a) =>
          this.ingress.add(
            a.deploymentId as string,
            {
              kind: a.kind as 'cloudflare' | 'npm',
              instanceId: a.instanceId as string,
              service: a.service as string,
              hostPort: a.hostPort as number,
              hostname: a.hostname as string,
              tunnelId: a.tunnelId as string | undefined,
              certificateId: a.certificateId as number | undefined,
              sslForced: a.sslForced as boolean | undefined,
            },
            actor,
          ),
      });

      action({
        name: 'remove_replicator_ingress',
        description: 'Remove one ingress route fronting a deployment (Cloudflare tunnel route or NPM proxy host). Irreversible.',
        permission: 'replicator:write',
        destructive: true,
        inputSchema: { ingressId: z.string().describe('Ingress route id (from get_replicator_deployment / list ingress)') },
        run: ({ ingressId }) => this.ingress.remove(ingressId as string, actor),
      });
    }

    // ── Notifications (notifications:send) ──
    if (has('notifications:send')) {
      action({
        name: 'send_notification',
        description:
          "Send a notification with a custom title and body through Cerebro's configured channels (email / SMS / Signal). Honours channel enablement, quiet hours, and throttling. Use for a one-off message; for a recurring condition, create an automation rule instead.",
        permission: 'notifications:send',
        inputSchema: {
          title: z.string().describe('Short notification title/subject'),
          body: z.string().describe('Notification body text'),
          severity: z
            .enum(['info', 'success', 'warning', 'critical'])
            .optional()
            .describe('Severity (default info)'),
          channels: z
            .array(z.enum(['email', 'textbelt', 'signal']))
            .optional()
            .describe('Channels to send through (default: all configured). textbelt = SMS.'),
        },
        run: ({ title, body, severity, channels }) =>
          this.notifications.sendMessage({
            title: title as string,
            body: body as string,
            severity: severity as NotificationSeverity | undefined,
            channels: channels as NotificationChannelId[] | undefined,
          }),
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

// ── Tool input helpers ────────────────────────────────────────────
//
// The structured payloads (monitor config, automation rule) are validated and
// defaulted by their own services, so these zod shapes stay deliberately loose
// (a `config` / `trigger` bag) with rich descriptions to guide the LLM. The
// `to*Input` casts hand the args straight to the typed service methods.

/** Zod shape for a monitor create/update payload. Numeric knobs are optional — the
 *  service clamps and defaults them (see MonitorsService.normalize). */
function monitorInputShape(): z.ZodRawShape {
  return {
    name: z.string().describe('Display name'),
    type: z.string().describe('Probe type id from list_monitor_types, e.g. "http", "ping", "tcp", "dns"'),
    config: z.record(z.unknown()).describe('Probe config — the fields that probe type declares (see list_monitor_types)'),
    enabled: z.boolean().optional().describe('Start enabled (default true)'),
    intervalSec: z.number().optional().describe('Seconds between checks (default 60)'),
    retries: z.number().optional().describe('Retries before marking down (default 1)'),
    retryIntervalSec: z.number().optional().describe('Seconds between retries (default 60)'),
    timeoutSec: z.number().optional().describe('Per-check timeout in seconds (default 10)'),
    resendEveryN: z.number().optional().describe('Re-alert every N repeated failures (0 = alert once)'),
    upsideDown: z.boolean().optional().describe('Invert: treat a reachable target as down'),
    description: z.string().optional(),
    tags: z.array(z.string()).optional().describe('Free-form tags'),
  };
}

/** Assemble a MonitorInput from validated tool args. Missing numeric knobs are left
 *  undefined for the service to default; the cast satisfies the required-field type. */
function toMonitorInput(a: Record<string, unknown>): MonitorInput {
  return {
    name: a.name as string,
    type: a.type as string,
    config: (a.config as Record<string, unknown>) ?? {},
    enabled: a.enabled as boolean | undefined,
    intervalSec: a.intervalSec as number,
    retries: a.retries as number,
    retryIntervalSec: a.retryIntervalSec as number,
    timeoutSec: a.timeoutSec as number,
    resendEveryN: a.resendEveryN as number,
    upsideDown: a.upsideDown as boolean,
    description: a.description as string | undefined,
    tags: a.tags as string[] | undefined,
  };
}

/** Zod shape for an automation rule. `partial` makes name/trigger optional for updates. */
function automationInputShape(opts?: { partial?: boolean }): z.ZodRawShape {
  const partial = opts?.partial ?? false;
  const name = z.string().describe('Rule name');
  const trigger = z
    .record(z.unknown())
    .describe("When to fire: {type:'event', kinds?, severities?, source?, textContains?} or {type:'schedule', cron}");
  return {
    name: partial ? name.optional() : name,
    enabled: z.boolean().optional().describe('Whether the rule is active (default true)'),
    trigger: partial ? trigger.optional() : trigger,
    conditions: z.array(z.record(z.unknown())).optional().describe("Conditions (AND'd). See create_automation for shapes."),
    actions: z.array(z.record(z.unknown())).optional().describe('Actions to run in order. See create_automation for shapes.'),
    cooldownSec: z.number().optional().describe("Don't re-fire within this many seconds (default 60)"),
  };
}

/** Copy only the defined rule fields from tool args. Safe for both create (schema
 *  guarantees name+trigger) and update (the service applies only present keys). */
function toAutomationInput(a: Record<string, unknown>): AutomationRuleInput {
  const out: Record<string, unknown> = {};
  for (const key of ['name', 'enabled', 'trigger', 'conditions', 'actions', 'cooldownSec']) {
    if (a[key] !== undefined) out[key] = a[key];
  }
  return out as unknown as AutomationRuleInput;
}
