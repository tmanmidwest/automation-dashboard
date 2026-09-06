import type {
  Connector,
  ConnectorCodeBlock,
  ConnectorConsoleTarget,
  ConnectorContext,
  ConnectorDetailGroup,
  ConnectorDetailItem,
  ConnectorManifest,
  ConnectorNode,
  ConnectorOperation,
  ConnectorOverview,
  ConnectorResource,
  ConnectorResourceDetail,
  ConnectorResourceKind,
  OperationProgress,
  OperationResult,
  OverviewMetric,
  RawConsoleUpstream,
  TestConnectionResult,
} from '@cerebro/shared';
import {
  DockerApi,
  DockerContainer,
  cleanContainerName,
  healthFromStatus,
  type DockerAuth,
  type DockerContainerStats,
  type DockerEvent,
} from './docker-api';
import { DockerStackService, projectName, type StackDeployTarget } from './docker-stack.service';
import { runSsh, type SshConfig } from './docker-ssh';
import { remoteDigest } from './docker-registry';

const HOST_KIND = 'docker_host';
const STACK_KIND = 'stack';
const CONTAINER_KIND = 'container';
const IMAGE_KIND = 'image';
const VOLUME_KIND = 'volume';
const NETWORK_KIND = 'network';

/** Container states that mean "not running" (drive the overview stopped count). */
const STOPPED_STATES = new Set(['exited', 'dead', 'created']);

/** Container statuses that mean "running" for action visibility (status is the State, or 'unhealthy'). */
const RUNNING_LIKE = ['running', 'restarting', 'unhealthy'];
const STOPPED_LIKE = ['exited', 'created', 'dead'];

/** Phase 2: container lifecycle actions + deletable/prunable kinds. Host + stacks stay read-only. */
const KINDS: ConnectorResourceKind[] = [
  { id: HOST_KIND, label: 'Docker Host', deletable: false, actions: [] },
  {
    id: STACK_KIND,
    label: 'Stacks',
    deletable: true,
    // Lifecycle actions work on ANY stack (managed or pre-existing) by acting on
    // its containers via the Engine API — no compose file needed. Member containers,
    // compose, env, and deploy history are shown in the stack's detail view.
    actions: [
      { id: 'start', label: 'Start', mutating: true, showWhenStatus: ['stopped', 'degraded'] },
      { id: 'stop', label: 'Stop', mutating: true, showWhenStatus: RUNNING_LIKE, confirm: 'Stop all containers in this stack?' },
      { id: 'restart', label: 'Restart', mutating: true, showWhenStatus: RUNNING_LIKE },
    ],
  },
  {
    id: CONTAINER_KIND,
    label: 'Containers',
    category: 'container',
    deletable: true,
    console: true,
    actions: [
      { id: 'start', label: 'Start', mutating: true, showWhenStatus: STOPPED_LIKE },
      { id: 'stop', label: 'Stop', mutating: true, showWhenStatus: RUNNING_LIKE },
      { id: 'restart', label: 'Restart', mutating: true, showWhenStatus: [...RUNNING_LIKE, 'exited'] },
      { id: 'pause', label: 'Pause', mutating: true, showWhenStatus: ['running', 'unhealthy'] },
      { id: 'unpause', label: 'Unpause', mutating: true, showWhenStatus: ['paused'] },
      { id: 'kill', label: 'Kill', mutating: true, intent: 'destructive', confirm: 'Force-kill this container (SIGKILL)?', showWhenStatus: RUNNING_LIKE },
    ],
  },
  { id: IMAGE_KIND, label: 'Images', deletable: true, actions: [] },
  { id: VOLUME_KIND, label: 'Volumes', deletable: true, actions: [] },
  { id: NETWORK_KIND, label: 'Networks', deletable: true, actions: [] },
];

/** Confirmation field reused by the prune operations so they never run on a stray click. */
const pruneConfirmField = (what: string) => ({
  key: 'confirm',
  label: `Yes, remove all unused ${what}`,
  type: 'boolean' as const,
  required: true,
});

const COMPOSE_FIELD = {
  key: 'compose',
  label: 'docker-compose.yml',
  type: 'textarea' as const,
  required: true,
  placeholder: 'services:\n  web:\n    image: nginx:latest\n    ports:\n      - "8080:80"\n    restart: unless-stopped',
  help: 'Standard Compose. Cerebro writes this to the host and runs "docker compose up -d".',
};

const ENV_FIELD = {
  key: 'env',
  label: 'Environment (.env)',
  type: 'textarea' as const,
  required: false,
  placeholder: 'TZ=America/Chicago\nPUID=1000\nPGID=1000',
  help: 'Optional KEY=value lines, written to a .env beside the compose — used for ${VAR} interpolation.',
};

/** Redeploy toggles that map to `docker compose up` flags (Portainer-style). */
const REDEPLOY_OPTS_FIELDS = [
  { key: 'pull', label: 'Pull newer images (--pull always)', type: 'boolean' as const, required: false, default: false },
  { key: 'forceRecreate', label: 'Force recreate containers', type: 'boolean' as const, required: false, default: false },
  { key: 'removeOrphans', label: 'Remove orphaned containers', type: 'boolean' as const, required: false, default: false },
];

const OPERATIONS: ConnectorOperation[] = [
  {
    id: 'deploy-stack',
    label: 'Deploy stack',
    description: 'Create or update a Compose stack. Cerebro stores it and runs "docker compose up -d" on the host over SSH.',
    scope: 'create',
    kind: STACK_KIND,
    icon: 'rocket',
    submitLabel: 'Deploy',
    background: true,
    fields: [
      { key: 'name', label: 'Stack name', type: 'text', required: true, placeholder: 'my-app', help: 'Compose project name (lowercased).' },
      COMPOSE_FIELD,
      ENV_FIELD,
    ],
  },
  {
    id: 'edit-stack',
    label: 'Edit & redeploy',
    description: 'Edit this stack\'s compose and environment, then redeploy it.',
    scope: 'resource',
    kind: STACK_KIND,
    icon: 'pencil',
    submitLabel: 'Save & deploy',
    background: true,
    prefill: true,
    fields: [COMPOSE_FIELD, ENV_FIELD, ...REDEPLOY_OPTS_FIELDS],
  },
  {
    id: 'redeploy-stack',
    label: 'Redeploy',
    description: 'Re-run "docker compose up -d" with the stored compose and environment.',
    scope: 'resource',
    kind: STACK_KIND,
    icon: 'refresh-cw',
    submitLabel: 'Redeploy',
    background: true,
    fields: REDEPLOY_OPTS_FIELDS,
  },
  {
    id: 'rollback-stack',
    label: 'Roll back to previous',
    description: 'Redeploy the version that was running before the last deploy (compose + environment).',
    scope: 'resource',
    kind: STACK_KIND,
    icon: 'history',
    submitLabel: 'Roll back',
    background: true,
    fields: [],
  },
  {
    id: 'stack-check-drift',
    label: 'Check drift',
    description: "Compare the stored compose and expected services against what's actually running on the host.",
    scope: 'resource',
    kind: STACK_KIND,
    icon: 'search',
    submitLabel: 'Check drift',
    background: true,
    fields: [],
  },
  {
    id: 'stop-stack',
    label: 'Stop (compose down)',
    description: 'Run "docker compose down" — stops and removes the stack\'s containers (named volumes are kept).',
    scope: 'resource',
    kind: STACK_KIND,
    icon: 'ban',
    intent: 'destructive',
    submitLabel: 'Stop stack',
    background: true,
    fields: [],
  },
  {
    id: 'pull-image',
    label: 'Pull image',
    description: 'Download an image (or a newer version of one) onto this host.',
    scope: 'create',
    kind: IMAGE_KIND,
    icon: 'download',
    submitLabel: 'Pull',
    background: true,
    fields: [
      { key: 'image', label: 'Image', type: 'text', required: true, placeholder: 'nginx:latest', help: 'repo:tag — e.g. ghcr.io/owner/app:1.2.3. Defaults to :latest.' },
    ],
  },
  {
    id: 'prune-images',
    label: 'Prune images',
    description: 'Remove dangling (untagged) images to reclaim disk.',
    scope: 'create',
    kind: IMAGE_KIND,
    icon: 'trash-2',
    intent: 'destructive',
    submitLabel: 'Prune',
    fields: [pruneConfirmField('dangling images')],
  },
  {
    id: 'recreate-container',
    label: 'Recreate',
    description: 'Stop and recreate this container from its current configuration — optionally pulling a newer image first. Best for updating a standalone container (compose stacks: use redeploy).',
    scope: 'resource',
    kind: CONTAINER_KIND,
    icon: 'refresh-cw',
    intent: 'destructive',
    submitLabel: 'Recreate',
    background: true,
    fields: [
      { key: 'pullLatest', label: 'Pull the latest image first', type: 'boolean' as const, required: false, default: true },
      { key: 'confirm', label: 'Yes, recreate this container', type: 'boolean' as const, required: true },
    ],
  },
  {
    id: 'prune-containers',
    label: 'Prune stopped containers',
    description: 'Remove all stopped containers.',
    scope: 'create',
    kind: CONTAINER_KIND,
    icon: 'trash-2',
    intent: 'destructive',
    submitLabel: 'Prune',
    fields: [pruneConfirmField('stopped containers')],
  },
  {
    id: 'prune-volumes',
    label: 'Prune volumes',
    description: 'Remove volumes not used by any container. This deletes their data — be sure.',
    scope: 'create',
    kind: VOLUME_KIND,
    icon: 'trash-2',
    intent: 'destructive',
    submitLabel: 'Prune',
    fields: [pruneConfirmField('volumes (deletes data)')],
  },
  {
    id: 'prune-networks',
    label: 'Prune networks',
    description: 'Remove custom networks not used by any container.',
    scope: 'create',
    kind: NETWORK_KIND,
    icon: 'trash-2',
    intent: 'destructive',
    submitLabel: 'Prune',
    fields: [pruneConfirmField('networks')],
  },
];

const COMPOSE_PROJECT = 'com.docker.compose.project';
const COMPOSE_SERVICE = 'com.docker.compose.service';

/** Copy-paste compose for a scoped socket gateway, shown on the setup screen. */
const SOCKET_PROXY_COMPOSE = `# Run one per Docker host you want Cerebro to see.
# Then set the connector endpoint to  http://<this-host>:2375
services:
  dockerproxy:
    image: tecnativa/docker-socket-proxy
    restart: unless-stopped
    environment:
      INFO: 1
      VERSION: 1
      EVENTS: 1        # live container updates (Cerebro's real-time resource stream)
      CONTAINERS: 1
      IMAGES: 1
      VOLUMES: 1
      NETWORKS: 1
      SYSTEM: 1        # /system/df — the host "Disk used" overview metric
      EXEC: 1          # interactive Shell console + terminal resize
      POST: 1          # 1 = allow actions (start/stop/restart, pull, prune, recreate); 0 = read-only
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    ports:
      - "2375:2375"    # expose only on a trusted network — this is root-equivalent`;

function bytesToGb(bytes: number): number {
  return Math.round((bytes / 1e9) * 10) / 10;
}

function rel(iso?: string | number | null): string | null {
  if (iso == null) return null;
  const then = typeof iso === 'number' ? iso * 1000 : Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Compute container CPU % from one stats sample (Docker's standard formula). */
function cpuPercent(s: DockerContainerStats): number | null {
  const cpu = s.cpu_stats;
  const pre = s.precpu_stats;
  if (!cpu?.cpu_usage?.total_usage || !cpu.system_cpu_usage || !pre?.system_cpu_usage) return null;
  const cpuDelta = cpu.cpu_usage.total_usage - (pre.cpu_usage?.total_usage ?? 0);
  const sysDelta = cpu.system_cpu_usage - pre.system_cpu_usage;
  if (sysDelta <= 0 || cpuDelta < 0) return null;
  const cpus = cpu.online_cpus || 1;
  return Math.round(((cpuDelta / sysDelta) * cpus * 100) * 10) / 10;
}

/** A short, human port summary, e.g. "8080→80/tcp". Deduped — Docker lists each
 *  published port once per IP family (IPv4 + IPv6). */
function portSummary(c: DockerContainer): string | null {
  const seen = new Set<string>();
  for (const p of c.Ports ?? []) {
    if (!p.PublicPort) continue;
    seen.add(`${p.PublicPort}→${p.PrivatePort}/${p.Type ?? 'tcp'}`);
  }
  if (seen.size === 0) return null;
  return [...seen].slice(0, 6).join(', ');
}

/** How long an image's "update available" result is cached before re-checking the registry. */
const UPDATE_TTL_MS = 6 * 60 * 60 * 1000;
/** How long host telemetry (over SSH) is cached before re-reading /proc. */
const HOST_TTL_MS = 15 * 1000;

export class DockerConnector implements Connector {
  /** Injected so stack deploys (Phase 5) can store compose + run SSH. */
  constructor(private readonly stacks: DockerStackService) {}

  /** Image-update cache, keyed by `${ref}@@${localDigest}`. hasUpdate null = unknown/unchecked. */
  private readonly updateCache = new Map<string, { at: number; hasUpdate: boolean | null }>();
  private readonly updateInFlight = new Set<string>();

  /** Host telemetry cache (keyed by instance id), collected over SSH and refreshed in the background. */
  private readonly hostCache = new Map<string, { at: number; metrics: OverviewMetric[] }>();
  private readonly hostInFlight = new Set<string>();

  /** Background registry check comparing the running image digest to the tag's current digest. */
  private async refreshUpdate(key: string, ref: string, localDigest: string): Promise<void> {
    if (this.updateInFlight.has(key)) return;
    this.updateInFlight.add(key);
    try {
      const remote = await remoteDigest(ref);
      this.updateCache.set(key, { at: Date.now(), hasUpdate: remote ? remote !== localDigest : null });
    } catch {
      this.updateCache.set(key, { at: Date.now(), hasUpdate: null });
    } finally {
      this.updateInFlight.delete(key);
    }
  }

  /**
   * Host CPU load / memory / root-disk metrics — the Engine API can't provide
   * these, so we read /proc + df over SSH (when SSH is configured). Cached and
   * refreshed in the background so the overview never blocks on SSH. Returns [] when
   * SSH isn't configured or hasn't been read yet.
   */
  private hostMetrics(ctx: ConnectorContext): OverviewMetric[] {
    const key = ctx.instanceId ?? '';
    const hasSsh = !!str(ctx.config.sshHost) && (!!str(ctx.config.sshPrivateKey) || !!str(ctx.config.sshPassword));
    if (!key || !hasSsh) return [];
    const cached = this.hostCache.get(key);
    if (!cached || Date.now() - cached.at > HOST_TTL_MS) void this.refreshHost(key, ctx);
    return cached?.metrics ?? [];
  }

  /** Background SSH read of host telemetry. Best-effort — failures leave the last good value. */
  private async refreshHost(key: string, ctx: ConnectorContext): Promise<void> {
    if (this.hostInFlight.has(key)) return;
    this.hostInFlight.add(key);
    try {
      const target = this.sshTargetFrom(ctx);
      // One round-trip; each value is prefixed so parsing is order-independent.
      const cmd =
        `printf 'L='; awk '{print $1}' /proc/loadavg; ` +
        `printf 'C='; nproc; ` +
        `printf 'M='; awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{print t","a}' /proc/meminfo; ` +
        `printf 'D='; df -Pk / | awk 'NR==2{print $2","$3}'`;
      const res = await runSsh(target.ssh, cmd, undefined, 15000);
      const metrics = parseHostStats(res.stdout);
      if (metrics.length) this.hostCache.set(key, { at: Date.now(), metrics });
    } catch {
      /* host telemetry is best-effort; keep any prior value */
    } finally {
      this.hostInFlight.delete(key);
    }
  }

  /** Local (pulled) digest of an image from its RepoDigests, or null if none (locally built). */
  private static localDigest(repoDigests: string[] | undefined): string | null {
    for (const rd of repoDigests ?? []) {
      const at = rd.indexOf('@');
      if (at >= 0) return rd.slice(at + 1);
    }
    return null;
  }

  manifest: ConnectorManifest = {
    id: 'docker',
    name: 'Docker',
    description:
      'Monitor and manage Docker hosts: stacks, containers, images, volumes, and networks, plus host resources. ' +
      'Start / stop / restart / pause / kill and remove containers, pull images, and prune. Logs and exec come next.',
    icon: 'docker',
    version: '0.2.0',
    configFields: [
      {
        key: 'endpoint',
        label: 'Endpoint',
        type: 'text',
        required: true,
        placeholder: 'tcp://dockerhost:2376',
        help: 'tcp://host:2376 (TLS), http://host:2375 (socket-proxy), or unix:///var/run/docker.sock (local).',
      },
      {
        key: 'tlsCaCert',
        label: 'TLS CA certificate (PEM)',
        type: 'textarea',
        required: false,
        help: 'For tcp:// with mutual TLS — the CA that signed the daemon certificate.',
      },
      {
        key: 'tlsClientCert',
        label: 'TLS client certificate (PEM)',
        type: 'textarea',
        required: false,
        help: 'Client certificate presented to the daemon (mutual TLS).',
      },
      {
        key: 'tlsClientKey',
        label: 'TLS client key (PEM)',
        type: 'textarea',
        secret: true,
        required: false,
        help: 'Private key for the client certificate. Stored encrypted in the secrets vault.',
      },
      {
        key: 'insecureSkipVerify',
        label: 'Skip TLS verification (insecure)',
        type: 'boolean',
        required: false,
        help: 'Development only — do not use against a real host.',
      },
      // ── Stack management over SSH (optional; Phase 5) ──
      {
        key: 'sshHost',
        label: 'SSH host (for stack deploys)',
        type: 'text',
        required: false,
        placeholder: 'same host as the Docker endpoint',
        help: 'To deploy compose stacks, Cerebro runs the host\'s own "docker compose" over SSH. Leave the SSH fields blank to keep this connector monitor/manage-only.',
      },
      { key: 'sshPort', label: 'SSH port', type: 'number', required: false, placeholder: '22' },
      { key: 'sshUser', label: 'SSH user', type: 'text', required: false, placeholder: 'a user in the docker group' },
      {
        key: 'sshPassword',
        label: 'SSH password',
        type: 'password',
        secret: true,
        required: false,
        help: 'Password for the SSH user (vault-encrypted). Provide this OR a private key below.',
      },
      {
        key: 'sshPrivateKey',
        label: 'SSH private key (PEM)',
        type: 'textarea',
        secret: true,
        required: false,
        help: 'Alternative to the password — a PEM key for the SSH user (vault-encrypted). The user must be able to run "docker compose".',
      },
      {
        key: 'stacksDir',
        label: 'Stacks directory on host',
        type: 'text',
        required: false,
        placeholder: '/opt/cerebro-stacks',
        help: 'Where Cerebro writes each stack\'s compose file on the host.',
      },
    ],
    resourceKinds: KINDS,
    operations: OPERATIONS,
    live: true,
    help: {
      overview:
        'Monitor and manage one Docker host: every stack (grouped by Compose project) and container with its state and health, ' +
        'plus images, volumes, networks, and host resources. Start/stop/restart/pause/kill and remove containers, pull images, and prune.',
      setupSteps: [
        'Preferred: expose the daemon over TLS. Generate a CA + server + client certs (see Docker\'s "Protect the Docker daemon socket" guide) and start dockerd with --tlsverify.',
        'Set the endpoint to tcp://your-host:2376 and paste the CA cert, client cert, and client key below.',
        'Hardened alternative: run the docker-socket-proxy container below on each host and set the endpoint to http://that-proxy:2375.',
        'Local only: if Cerebro runs on the Docker host itself, mount the socket and use unix:///var/run/docker.sock.',
      ],
      requiredPermissions: [
        'Read: /info, /version, /system/df, /containers, /images, /volumes, /networks.',
        'Manage (this connector\'s actions): POST on /containers/*/{start,stop,restart,pause,kill}, DELETE on containers/images/volumes/networks, POST /images/create and the /*/prune endpoints.',
        'With the socket-proxy, that means POST=1 plus the section flags below. DELETE (remove/prune) needs a proxy that permits it, or use the TLS transport for full management.',
      ],
      codeSamples: [
        {
          title: 'docker-socket-proxy (run one per host)',
          description:
            'A tiny, read/write-scoped gateway to the Docker socket — no agent, no UI. POST=1 enables the connector\'s actions (start/stop/restart, pull, prune, recreate); EXEC=1 the Shell console; SYSTEM=1 the host disk metric; EVENTS=1 live updates. Set POST=0 to keep the host read-only. (Stack deploy/drift and host CPU/RAM telemetry use SSH, not this proxy.)',
          language: 'yaml',
          code: SOCKET_PROXY_COMPOSE,
        },
      ],
      referenceLinks: [
        { label: 'Protect the Docker daemon socket (TLS)', url: 'https://docs.docker.com/engine/security/protect-access/' },
        { label: 'docker-socket-proxy', url: 'https://github.com/Tecnativa/docker-socket-proxy' },
        { label: 'Docker Engine API', url: 'https://docs.docker.com/engine/api/' },
      ],
      notes:
        'The Docker Engine API is root-equivalent. Prefer TLS client certs, or the socket-proxy for per-endpoint scoping. ' +
        'Never expose the plaintext port 2375 to an untrusted network. Full host CPU/RAM beyond Docker\'s own view needs a node-exporter-style source (a later phase).',
    },
  };

  private apiFrom(ctx: ConnectorContext): DockerApi {
    const auth: DockerAuth = {
      endpoint: String(ctx.config.endpoint ?? ''),
      tlsCaCert: str(ctx.config.tlsCaCert),
      tlsClientCert: str(ctx.config.tlsClientCert),
      tlsClientKey: str(ctx.config.tlsClientKey),
      insecureSkipVerify: bool(ctx.config.insecureSkipVerify),
    };
    return new DockerApi(auth);
  }

  /** Build the SSH deploy target from config, or throw a clear message if unset. */
  private sshTargetFrom(ctx: ConnectorContext): StackDeployTarget {
    const host = str(ctx.config.sshHost);
    const key = str(ctx.config.sshPrivateKey);
    const password = str(ctx.config.sshPassword);
    if (!host || (!key && !password)) {
      throw new Error('Stack deploys need SSH configured — set the SSH host, user, and either a password or a private key on this connector.');
    }
    const ssh: SshConfig = {
      host,
      port: Number(ctx.config.sshPort) || 22,
      username: str(ctx.config.sshUser) || 'root',
      privateKey: key,
      password,
    };
    return { ssh, stacksDir: str(ctx.config.stacksDir) || '/opt/cerebro-stacks' };
  }

  async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    const api = this.apiFrom(ctx);
    try {
      const [info, version] = await Promise.all([api.info(), api.version()]);
      const name = info.Name ?? 'docker';
      ctx.log('info', `Docker daemon reachable: ${name} (Engine ${version.Version ?? '?'}).`);
      return {
        ok: true,
        message: `Connected to ${name} — Docker ${version.Version ?? '?'}, ${info.ContainersRunning ?? 0} running.`,
        details: {
          host: name,
          engine: version.Version ?? '?',
          containers: String(info.Containers ?? 0),
          os: info.OperatingSystem ?? '?',
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed.';
      ctx.log('warn', `Docker connection test failed: ${message}`);
      return { ok: false, message };
    }
  }

  async performAction(
    ctx: ConnectorContext,
    kind: string,
    resourceId: string,
    actionId: string,
  ): Promise<{ ok: boolean; message: string }> {
    const api = this.apiFrom(ctx);

    // Stack lifecycle: act on every container in the compose project (label-based,
    // so it works for stacks Cerebro didn't create).
    if (kind === STACK_KIND) {
      if (!['start', 'stop', 'restart'].includes(actionId)) return { ok: false, message: `Unsupported stack action "${actionId}".` };
      try {
        return await this.stackLifecycle(ctx, api, resourceId, actionId as 'start' | 'stop' | 'restart');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Action failed.';
        ctx.log('error', `Docker stack ${actionId} on ${resourceId} failed: ${message}`);
        return { ok: false, message };
      }
    }

    if (kind !== CONTAINER_KIND) return { ok: false, message: `No actions for ${kind}.` };
    try {
      switch (actionId) {
        case 'start': await api.startContainer(resourceId); break;
        case 'stop': await api.stopContainer(resourceId); break;
        case 'restart': await api.restartContainer(resourceId); break;
        case 'pause': await api.pauseContainer(resourceId); break;
        case 'unpause': await api.unpauseContainer(resourceId); break;
        case 'kill': await api.killContainer(resourceId); break;
        default: return { ok: false, message: `Unsupported action "${actionId}".` };
      }
      ctx.log('info', `Docker ${actionId} on container ${resourceId.slice(0, 12)}.`);
      return { ok: true, message: `Container ${actionId} succeeded.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action failed.';
      ctx.log('error', `Docker ${actionId} on ${resourceId.slice(0, 12)} failed: ${message}`);
      return { ok: false, message };
    }
  }

  async deleteResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<{ ok: boolean; message: string }> {
    const api = this.apiFrom(ctx);
    try {
      if (kind === STACK_KIND) {
        if (!ctx.instanceId) return { ok: false, message: 'Missing connector instance.' };
        const stored = await this.stacks.get(ctx.instanceId, resourceId);
        if (stored) {
          // Managed: compose down (best-effort) then forget the stored stack.
          try {
            await this.stacks.down(this.sshTargetFrom(ctx), ctx.instanceId, resourceId);
          } catch (err) {
            ctx.log('debug', `Stack down before delete failed: ${err instanceof Error ? err.message : err}`);
          }
          await this.stacks.remove(ctx.instanceId, resourceId);
          ctx.log('info', `Docker removed managed stack ${resourceId}.`);
          return { ok: true, message: `Stack "${resourceId}" removed.` };
        }
        // Unmanaged: force-remove the project's containers via the Engine API.
        const members = (await api.listContainers(true)).filter(
          (c) => (c.Labels?.[COMPOSE_PROJECT] ?? 'ungrouped') === resourceId,
        );
        if (members.length === 0) return { ok: false, message: `No containers found for stack "${resourceId}".` };
        const results = await Promise.allSettled(members.map((m) => api.removeContainer(m.Id)));
        const failed = results.filter((r) => r.status === 'rejected').length;
        ctx.log('info', `Docker removed unmanaged stack ${resourceId}: ${members.length - failed}/${members.length} containers.`);
        if (failed) return { ok: false, message: `Removed ${members.length - failed}/${members.length} containers; ${failed} failed.` };
        return { ok: true, message: `Removed ${members.length} container${members.length !== 1 ? 's' : ''} from "${resourceId}".` };
      }
      switch (kind) {
        case CONTAINER_KIND: await api.removeContainer(resourceId); break;
        case IMAGE_KIND: await api.removeImage(resourceId); break;
        case VOLUME_KIND: await api.removeVolume(resourceId); break;
        case NETWORK_KIND: await api.removeNetwork(resourceId); break;
        default: return { ok: false, message: `${kind} resources can't be deleted.` };
      }
      ctx.log('info', `Docker removed ${kind} ${resourceId.slice(0, 24)}.`);
      return { ok: true, message: `${kind} removed.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Delete failed.';
      ctx.log('error', `Docker delete ${kind} ${resourceId.slice(0, 24)} failed: ${message}`);
      return { ok: false, message };
    }
  }

  async runOperation(
    ctx: ConnectorContext,
    operationId: string,
    _resourceId: string | undefined,
    values: Record<string, unknown>,
    onProgress: OperationProgress,
    signal?: AbortSignal,
  ): Promise<OperationResult> {
    const api = this.apiFrom(ctx);
    try {
      // ── Stack operations (Phase 5, over SSH) ──
      if (operationId === 'deploy-stack' || operationId === 'edit-stack') {
        const instanceId = ctx.instanceId;
        if (!instanceId) return { ok: false, message: 'Missing connector instance.' };
        const name = operationId === 'deploy-stack' ? str(values.name) : (_resourceId ?? '');
        const compose = str(values.compose);
        if (!name) return { ok: false, message: 'A stack name is required.' };
        if (!compose) return { ok: false, message: 'The compose file is empty.' };
        const target = this.sshTargetFrom(ctx);
        onProgress(`Deploying stack "${projectName(name)}" over SSH…`);
        const res = await this.stacks.deploy(target, instanceId, name, compose, str(values.env) ?? '', optsFrom(values));
        ctx.log(res.ok ? 'info' : 'error', `Docker stack deploy "${projectName(name)}": ${res.message}`);
        return res;
      }
      if (operationId === 'stop-stack') {
        const instanceId = ctx.instanceId;
        if (!instanceId || !_resourceId) return { ok: false, message: 'Missing stack reference.' };
        const stored = await this.stacks.get(instanceId, _resourceId);
        if (stored) {
          onProgress(`Running compose down for "${_resourceId}"…`);
          return await this.stacks.down(this.sshTargetFrom(ctx), instanceId, _resourceId);
        }
        // Existing (unmanaged) stack — no compose file to `down`; stop its containers instead.
        onProgress(`Stopping containers for "${_resourceId}"…`);
        return await this.stackLifecycle(ctx, api, _resourceId, 'stop');
      }
      if (operationId === 'redeploy-stack') {
        const instanceId = ctx.instanceId;
        if (!instanceId || !_resourceId) return { ok: false, message: 'Missing stack reference.' };
        const stored = await this.stacks.get(instanceId, _resourceId);
        if (!stored) {
          return { ok: false, message: 'This stack isn\'t managed by Cerebro. Use "Deploy stack" to import its compose, then redeploy.' };
        }
        onProgress(`Redeploying stack "${_resourceId}"…`);
        return await this.stacks.deploy(this.sshTargetFrom(ctx), instanceId, _resourceId, stored.compose, stored.env ?? '', optsFrom(values));
      }
      if (operationId === 'rollback-stack') {
        const instanceId = ctx.instanceId;
        if (!instanceId || !_resourceId) return { ok: false, message: 'Missing stack reference.' };
        const prev = await this.stacks.previousRevision(instanceId, _resourceId);
        if (!prev) return { ok: false, message: 'No previous version to roll back to — this stack has only one stored version.' };
        onProgress(`Rolling back "${_resourceId}" to the previous version…`);
        return await this.stacks.deploy(this.sshTargetFrom(ctx), instanceId, _resourceId, prev.compose, prev.env ?? '');
      }

      if (operationId === 'stack-check-drift') {
        const instanceId = ctx.instanceId;
        if (!instanceId || !_resourceId) return { ok: false, message: 'Missing stack reference.' };
        onProgress(`Checking "${_resourceId}" for drift…`);
        return await this.stacks.checkDrift(this.sshTargetFrom(ctx), instanceId, _resourceId);
      }

      if (operationId === 'recreate-container') {
        if (!_resourceId) return { ok: false, message: 'Missing container reference.' };
        if (values.confirm !== true) return { ok: false, message: 'Please confirm before recreating.' };
        onProgress(bool(values.pullLatest) ? 'Pulling the latest image and recreating…' : 'Recreating container…');
        const res = await api.recreateContainer(_resourceId, { pull: bool(values.pullLatest) });
        ctx.log('info', `Docker recreated container ${_resourceId}.`);
        return { ok: true, message: res.message };
      }

      if (operationId === 'pull-image') {
        const image = str(values.image);
        if (!image) return { ok: false, message: 'An image name is required.' };
        onProgress(`Pulling ${image}…`);
        await api.pullImage(image, (line) => onProgress(line), signal);
        ctx.log('info', `Docker pulled image ${image}.`);
        return { ok: true, message: `Pulled ${image}.` };
      }

      const prune: Record<string, () => Promise<{ SpaceReclaimed?: number }>> = {
        'prune-images': () => api.pruneImages(),
        'prune-containers': () => api.pruneContainers(),
        'prune-volumes': () => api.pruneVolumes(),
        'prune-networks': () => api.pruneNetworks(),
      };
      if (prune[operationId]) {
        if (values.confirm !== true) return { ok: false, message: 'Please confirm before pruning.' };
        const res = await prune[operationId]();
        const gb = res.SpaceReclaimed ? bytesToGb(res.SpaceReclaimed) : 0;
        ctx.log('info', `Docker ${operationId} reclaimed ${gb} GB.`);
        return { ok: true, message: `Prune complete — reclaimed ${gb} GB.` };
      }

      return { ok: false, message: `Unknown operation "${operationId}".` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Operation failed.';
      ctx.log('error', `Docker operation ${operationId} failed: ${message}`);
      return { ok: false, message };
    }
  }

  async listResources(ctx: ConnectorContext, kind: string): Promise<ConnectorResource[]> {
    const api = this.apiFrom(ctx);

    if (kind === HOST_KIND) {
      const [info, version, df] = await Promise.all([api.info(), api.version(), api.df().catch(() => null)]);
      return [this.hostToResource(info, version, df)];
    }

    if (kind === CONTAINER_KIND) {
      const containers = await api.listContainers(true);
      return containers
        .map((c) => this.containerToResource(c))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    if (kind === STACK_KIND) {
      const containers = await api.listContainers(true);
      const updates = await this.updatesByContainerId(api, containers).catch(() => new Map<string, boolean | null>());
      const running = this.stacksFromContainers(containers, updates);
      // Merge in Cerebro-managed stacks that aren't currently running, so a
      // stopped stack still shows and can be redeployed/edited.
      const stored = ctx.instanceId ? await this.stacks.list(ctx.instanceId).catch(() => []) : [];
      const versionCounts: Record<string, number> = ctx.instanceId
        ? await this.stacks.revisionCounts(ctx.instanceId).catch(() => ({}))
        : {};
      const runningNames = new Set(running.map((r) => r.id));
      for (const s of stored) {
        if (runningNames.has(s.name)) continue;
        running.push({
          id: s.name,
          kind: STACK_KIND,
          name: s.name,
          status: s.lastStatus === 'success' ? 'stopped' : s.lastStatus, // 'stopped' | 'error' | 'never'
          details: {
            containers: 0,
            running: 0,
            managed: true,
            versions: versionCounts[s.name] ?? 0,
            last_deploy: s.lastDeployedAt ? rel(s.lastDeployedAt.toISOString()) : null,
          },
          tags: { status: s.lastStatus === 'success' ? 'stopped' : s.lastStatus, managed: 'cerebro' },
        });
      }
      return running.sort((a, b) => a.name.localeCompare(b.name));
    }

    if (kind === IMAGE_KIND) {
      const images = await api.listImages();
      return images
        .map((im) => {
          const tag = im.RepoTags?.find((t) => t && t !== '<none>:<none>') ?? im.RepoDigests?.[0] ?? shortId(im.Id);
          return {
            id: im.Id,
            kind: IMAGE_KIND,
            name: tag,
            status: (im.Containers ?? 0) > 0 ? 'in use' : 'unused',
            details: {
              size: im.Size != null ? `${bytesToGb(im.Size)} GB` : null,
              containers: im.Containers ?? 0,
              created: rel(im.Created),
              id: shortId(im.Id),
            },
            tags: (im.Containers ?? 0) > 0 ? { status: 'in use' } : { status: 'unused' },
          } as ConnectorResource;
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    if (kind === VOLUME_KIND) {
      const volumes = await api.listVolumes();
      return volumes
        .map((v) => ({
          id: v.Name,
          kind: VOLUME_KIND,
          name: v.Name,
          status: v.Driver ?? 'local',
          details: { driver: v.Driver ?? null, mountpoint: v.Mountpoint ?? null, created: rel(v.CreatedAt) },
        }) as ConnectorResource)
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    if (kind === NETWORK_KIND) {
      const networks = await api.listNetworks();
      return networks
        .map((n) => ({
          id: n.Id,
          kind: NETWORK_KIND,
          name: n.Name,
          status: n.Driver ?? 'bridge',
          details: {
            driver: n.Driver ?? null,
            scope: n.Scope ?? null,
            internal: !!n.Internal,
            containers: n.Containers ? Object.keys(n.Containers).length : 0,
          },
          tags: n.Driver ? { driver: n.Driver } : undefined,
        }) as ConnectorResource)
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    return [];
  }

  async listSubResources(
    ctx: ConnectorContext,
    kind: string,
    resourceId: string,
    subKind: string,
  ): Promise<ConnectorResource[]> {
    if (kind !== STACK_KIND || subKind !== CONTAINER_KIND) return [];
    const api = this.apiFrom(ctx);
    const containers = await api.listContainers(true);
    return containers
      .filter((c) => (c.Labels?.[COMPOSE_PROJECT] ?? 'ungrouped') === resourceId)
      .map((c) => this.containerToResource(c))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private hostToResource(
    info: Awaited<ReturnType<DockerApi['info']>>,
    version: Awaited<ReturnType<DockerApi['version']>>,
    df: Awaited<ReturnType<DockerApi['df']>> | null,
  ): ConnectorResource {
    return {
      id: info.ID ?? info.Name ?? 'docker-host',
      kind: HOST_KIND,
      name: info.Name ?? 'Docker host',
      status: 'running',
      details: {
        engine: version.Version ?? null,
        os: info.OperatingSystem ?? null,
        kernel: info.KernelVersion ?? null,
        arch: info.Architecture ?? null,
        cpus: info.NCPU ?? null,
        memory: info.MemTotal != null ? `${bytesToGb(info.MemTotal)} GB` : null,
        containers: info.Containers ?? 0,
        running: info.ContainersRunning ?? 0,
        images: info.Images ?? 0,
        disk_used: df ? `${bytesToGb(diskUsed(df))} GB` : null,
      },
    };
  }

  private containerToResource(c: DockerContainer): ConnectorResource {
    const name = cleanContainerName(c.Names);
    const health = healthFromStatus(c.Status);
    const state = c.State ?? 'unknown';
    const status = health === 'unhealthy' ? 'unhealthy' : state;
    const project = c.Labels?.[COMPOSE_PROJECT];
    const service = c.Labels?.[COMPOSE_SERVICE];
    return {
      id: c.Id,
      kind: CONTAINER_KIND,
      name,
      status,
      details: {
        state,
        health: health ?? null,
        image: c.Image ?? null,
        status_text: c.Status ?? null,
        ports: portSummary(c),
        stack: project ?? null,
        service: service ?? null,
        created: rel(c.Created),
      },
      tags: {
        state,
        ...(health ? { health } : {}),
        ...(project ? { stack: project } : {}),
      },
    };
  }

  /** Roll a container list up into one resource per Compose project. */
  private stacksFromContainers(containers: DockerContainer[], updates?: Map<string, boolean | null>): ConnectorResource[] {
    const byProject = new Map<string, DockerContainer[]>();
    for (const c of containers) {
      const project = c.Labels?.[COMPOSE_PROJECT] ?? 'ungrouped';
      const arr = byProject.get(project) ?? [];
      arr.push(c);
      byProject.set(project, arr);
    }
    const out: ConnectorResource[] = [];
    for (const [project, members] of byProject) {
      const running = members.filter((m) => m.State === 'running').length;
      const total = members.length;
      const unhealthy = members.filter((m) => healthFromStatus(m.Status) === 'unhealthy').length;
      const status = unhealthy > 0 ? 'unhealthy' : running === 0 ? 'stopped' : running < total ? 'degraded' : 'running';
      const outdated = updates ? members.filter((m) => m.Id && updates.get(m.Id) === true).length : 0;
      out.push({
        id: project,
        kind: STACK_KIND,
        name: project,
        status,
        details: {
          containers: total,
          running,
          stopped: total - running,
          unhealthy,
          services: new Set(members.map((m) => m.Labels?.[COMPOSE_SERVICE]).filter(Boolean)).size || total,
          updates: outdated,
        },
        // Surface an "updates" chip on the row when a member's image is outdated.
        tags: { status, ...(outdated > 0 ? { updates: `${outdated} update${outdated === 1 ? '' : 's'}` } : {}) },
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async describeResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<ConnectorResourceDetail> {
    const api = this.apiFrom(ctx);

    if (kind === HOST_KIND) {
      const [info, version, df] = await Promise.all([api.info(), api.version(), api.df().catch(() => null)]);
      const general: ConnectorDetailItem[] = [
        { label: 'Name', value: info.Name ?? '—' },
        { label: 'Engine', value: version.Version ?? '—' },
        { label: 'API version', value: version.ApiVersion ?? '—' },
        { label: 'OS', value: info.OperatingSystem ?? '—' },
        { label: 'Kernel', value: info.KernelVersion ?? '—', variant: 'mono' },
        { label: 'Architecture', value: info.Architecture ?? '—' },
        { label: 'CPUs', value: String(info.NCPU ?? '—') },
        { label: 'Total memory', value: info.MemTotal != null ? `${bytesToGb(info.MemTotal)} GB` : '—' },
      ];
      const counts: ConnectorDetailItem[] = [
        { label: 'Containers', value: String(info.Containers ?? 0) },
        { label: 'Running', value: String(info.ContainersRunning ?? 0) },
        { label: 'Paused', value: String(info.ContainersPaused ?? 0) },
        { label: 'Stopped', value: String(info.ContainersStopped ?? 0) },
        { label: 'Images', value: String(info.Images ?? 0) },
        ...(df ? [{ label: 'Disk used', value: `${bytesToGb(diskUsed(df))} GB` }] : []),
      ];
      return {
        id: resourceId,
        kind,
        name: info.Name ?? 'Docker host',
        status: 'running',
        groups: [
          { title: 'General', items: general },
          { title: 'Usage', items: counts },
        ],
      };
    }

    if (kind === CONTAINER_KIND) {
      const inspect = await api.inspectContainer(resourceId);
      const health = inspect.State?.Health?.Status;
      const name = (inspect.Name ?? '').replace(/^\//, '');
      const command =
        inspect.Config?.Cmd?.length ? inspect.Config.Cmd.join(' ')
          : [inspect.Path, ...(inspect.Args ?? [])].filter(Boolean).join(' ');
      const general: ConnectorDetailItem[] = [
        { label: 'Name', value: name || shortId(inspect.Id) },
        { label: 'State', value: inspect.State?.Status ?? '—', variant: 'status' },
        ...(health ? [{ label: 'Health', value: health, variant: 'status' as const }] : []),
        { label: 'Image', value: inspect.Config?.Image ?? '—', variant: 'mono' },
        ...(command ? [{ label: 'Command', value: command, variant: 'mono' as const }] : []),
        { label: 'Restart count', value: String(inspect.RestartCount ?? 0) },
        { label: 'Started', value: rel(inspect.State?.StartedAt) ?? '—' },
        { label: 'Created', value: rel(inspect.Created) ?? '—' },
        { label: 'Stack', value: inspect.Config?.Labels?.[COMPOSE_PROJECT] ?? '—' },
        { label: 'Service', value: inspect.Config?.Labels?.[COMPOSE_SERVICE] ?? '—' },
        { label: 'Container ID', value: shortId(inspect.Id), variant: 'mono' },
      ];
      const groups: ConnectorDetailGroup[] = [{ title: 'General', items: general }];

      // Image update status (from the cached registry check; kicks a refresh if stale).
      try {
        const img = inspect.Image ? await api.inspectImage(inspect.Image) : null;
        const local = DockerConnector.localDigest(img?.RepoDigests);
        const ref = inspect.Config?.Image;
        if (local && ref) {
          const key = `${ref}@@${local}`;
          const cached = this.updateCache.get(key);
          if (!cached || Date.now() - cached.at > UPDATE_TTL_MS) void this.refreshUpdate(key, ref, local);
          const value = !cached ? 'checking…'
            : cached.hasUpdate === true ? 'Newer image available'
            : cached.hasUpdate === false ? 'Up to date'
            : 'Unknown';
          general.push({ label: 'Image update', value, variant: cached?.hasUpdate ? 'status' : 'default' });
        }
      } catch {
        /* best-effort */
      }

      // Published ports — as clickable links to the host when one can be derived.
      const host = browsableHost(ctx.config);
      const portItems: ConnectorDetailItem[] = [];
      const seenPort = new Set<string>();
      for (const [cport, bindings] of Object.entries(inspect.NetworkSettings?.Ports ?? {})) {
        for (const b of bindings ?? []) {
          if (!b.HostPort) continue;
          const key = `${b.HostPort}:${cport}`;
          if (seenPort.has(key)) continue;
          seenPort.add(key);
          portItems.push(
            host
              ? { label: cport, value: `http://${host}:${b.HostPort}`, variant: 'link' }
              : { label: cport, value: `:${b.HostPort}`, variant: 'mono' },
          );
        }
      }
      if (portItems.length) groups.push({ title: 'Published ports', items: portItems });

      // One-shot resource sample (on-demand only — never on the list view).
      try {
        const stats = await api.containerStats(resourceId);
        const cpu = cpuPercent(stats);
        const memUsed = stats.memory_stats?.usage;
        const memLimit = stats.memory_stats?.limit;
        groups.push({
          title: 'Resources',
          items: [
            { label: 'CPU', value: cpu != null ? `${cpu}%` : '—' },
            {
              label: 'Memory',
              value:
                memUsed != null
                  ? `${bytesToGb(memUsed)} GB${memLimit ? ` / ${bytesToGb(memLimit)} GB` : ''}`
                  : '—',
            },
          ],
        });
      } catch {
        /* stats are best-effort */
      }

      const mounts = (inspect.Mounts ?? []).filter((m) => m.Destination);
      if (mounts.length) {
        groups.push({
          title: 'Mounts',
          items: mounts.map((m) => ({
            label: m.Name || m.Type || 'mount',
            value: `${m.Source ?? ''} → ${m.Destination}${m.RW === false ? ' (ro)' : ''}`,
            variant: 'mono' as const,
          })),
        });
      }

      const nets = inspect.NetworkSettings?.Networks ?? {};
      const netItems = Object.entries(nets).map(([n, v]) => ({
        label: n,
        value: v.IPAddress || '—',
        variant: 'mono' as const,
      }));
      if (netItems.length) groups.push({ title: 'Networks', items: netItems });

      // Environment — secret-looking values masked (best-effort, by key name).
      const envItems: ConnectorDetailItem[] = (inspect.Config?.Env ?? []).slice(0, 40).map((e) => {
        const eq = e.indexOf('=');
        const k = eq >= 0 ? e.slice(0, eq) : e;
        const v = eq >= 0 ? e.slice(eq + 1) : '';
        return { label: k, value: SECRETISH.test(k) ? '••••••••' : v || '—', variant: 'mono' as const };
      });
      if (envItems.length) groups.push({ title: 'Environment', items: envItems });

      return {
        id: inspect.Id,
        kind,
        name: name || shortId(inspect.Id),
        status: health === 'unhealthy' ? 'unhealthy' : inspect.State?.Status ?? 'unknown',
        groups,
      };
    }

    if (kind === STACK_KIND) {
      return this.describeStack(ctx, api, resourceId);
    }

    // Images/volumes/networks: build a light detail from the list entry.
    const list = await this.listResources(ctx, kind);
    const r = list.find((x) => x.id === resourceId);
    if (!r) throw new Error(`${kind} ${resourceId} not found.`);
    const items: ConnectorDetailItem[] = Object.entries(r.details ?? {}).map(([k, v]) => ({
      label: k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
      value: v == null ? '—' : String(v),
    }));
    return { id: r.id, kind, name: r.name, status: r.status, groups: [{ title: 'General', items }] };
  }

  /** Rich stack detail: status + member containers + deploy history + compose/env. */
  private async describeStack(ctx: ConnectorContext, api: DockerApi, project: string): Promise<ConnectorResourceDetail> {
    const instanceId = ctx.instanceId;
    const stored = instanceId ? await this.stacks.get(instanceId, project) : null;
    const all = await api.listContainers(true);
    const members = all.filter((c) => (c.Labels?.[COMPOSE_PROJECT] ?? 'ungrouped') === project);
    const running = members.filter((m) => m.State === 'running').length;
    const unhealthy = members.filter((m) => healthFromStatus(m.Status) === 'unhealthy').length;
    const status = members.length === 0 ? (stored?.lastStatus === 'success' ? 'stopped' : stored?.lastStatus ?? 'stopped')
      : unhealthy > 0 ? 'unhealthy' : running === 0 ? 'stopped' : running < members.length ? 'degraded' : 'running';

    const updates = await this.updatesByContainerId(api, members).catch(() => new Map<string, boolean | null>());
    const outdated = members.filter((m) => m.Id && updates.get(m.Id) === true).length;
    const checkable = members.filter((m) => m.Id && updates.get(m.Id) != null).length;

    const general: ConnectorDetailItem[] = [
      { label: 'Status', value: status, variant: 'status' },
      { label: 'Containers', value: `${running}/${members.length} running` },
      {
        label: 'Image updates',
        value: outdated > 0 ? `${outdated} update${outdated === 1 ? '' : 's'} available`
          : checkable > 0 ? 'All up to date'
          : 'Unknown',
        variant: outdated > 0 ? 'status' : 'default',
      },
      { label: 'Managed by Cerebro', value: stored ? 'Yes' : 'No — lifecycle only' },
    ];
    if (stored) {
      general.push(
        { label: 'Last deploy', value: stored.lastDeployedAt ? (rel(stored.lastDeployedAt.toISOString()) ?? '—') : 'never' },
        { label: 'Last result', value: stored.lastStatus, variant: 'status' },
      );
    }
    const groups: ConnectorDetailGroup[] = [{ title: 'General', items: general }];

    // Member containers (image · ports · state).
    if (members.length) {
      groups.push({
        title: 'Containers',
        items: members
          .sort((a, b) => cleanContainerName(a.Names).localeCompare(cleanContainerName(b.Names)))
          .map((m) => ({
            label: cleanContainerName(m.Names),
            value: [
              m.Image,
              portSummary(m),
              healthFromStatus(m.Status) === 'unhealthy' ? 'unhealthy' : m.State,
              m.Id && updates.get(m.Id) === true ? 'update available' : '',
            ].filter(Boolean).join(' · '),
            variant: 'mono' as const,
          })),
      });
    }

    // Deploy history.
    if (stored && instanceId) {
      const revs = await this.stacks.listRevisions(instanceId, project).catch(() => []);
      if (revs.length) {
        groups.push({
          title: 'Deploy history',
          items: revs.map((r, i) => ({
            label: i === 0 ? 'Current' : `#${revs.length - i}`,
            value: rel(r.createdAt.toISOString()) ?? r.createdAt.toISOString(),
          })),
        });
      }
    }

    // Compose + .env, read-only.
    const code: ConnectorCodeBlock[] = [];
    if (stored) {
      code.push({ title: 'docker-compose.yml', language: 'yaml', content: stored.compose });
      if (stored.env) code.push({ title: '.env', language: 'ini', content: stored.env });
    }

    return { id: project, kind: STACK_KIND, name: project, status, groups, code: code.length ? code : undefined };
  }

  async listNodes(ctx: ConnectorContext): Promise<ConnectorNode[]> {
    const api = this.apiFrom(ctx);
    try {
      const info = await api.info();
      // Host CPU load isn't exposed by the Engine API (needs a node-exporter-style
      // source); report the known facts and leave cpuPct at 0. See docs/connectors/docker.md.
      return [
        {
          name: info.Name ?? 'docker-host',
          status: 'running',
          cpuPct: 0,
          vcpus: info.NCPU ?? undefined,
          memTotalBytes: info.MemTotal ?? undefined,
        },
      ];
    } catch (err) {
      ctx.log('debug', `Docker listNodes failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  /**
   * Live container updates via the Docker /events stream. Maps each event to a
   * normalized container resource and pushes it — no per-event API round-trip.
   * Runs in the background and reconnects if the stream drops; the returned
   * function tears it down when the client disconnects.
   */
  async subscribeLive(ctx: ConnectorContext, onUpdate: (resource: ConnectorResource) => void): Promise<() => void> {
    const api = this.apiFrom(ctx);
    const controller = new AbortController();

    const run = () => {
      api
        .watchContainerEvents((e) => {
          const r = eventToResource(e);
          if (r) onUpdate(r);
        }, controller.signal)
        .catch((err) => {
          if (controller.signal.aborted) return;
          ctx.log('debug', `Docker event stream ended (${err instanceof Error ? err.message : err}); reconnecting in 5s.`);
          setTimeout(() => {
            if (!controller.signal.aborted) run();
          }, 5000);
        });
    };
    run();
    ctx.log('info', 'Docker live event stream subscribed.');

    return () => controller.abort();
  }

  /**
   * Open an interactive shell (mode 'shell'/'serial') or a live log stream
   * (mode 'logs') into a container. Returns a raw upstream the core's console
   * relay bridges to the browser terminal. See docs/connectors/docker.md.
   */
  async openConsole(
    ctx: ConnectorContext,
    kind: string,
    resourceId: string,
    mode: 'vnc' | 'serial' | 'shell' | 'logs',
  ): Promise<ConnectorConsoleTarget> {
    if (kind !== CONTAINER_KIND) throw new Error('Only containers have a console.');
    const api = this.apiFrom(ctx);
    const conn = api.connectionDescriptor();

    if (mode === 'logs') {
      const inspect = await api.inspectContainer(resourceId).catch(() => null);
      // A TTY container's logs are a raw stream; otherwise they carry Docker's frame headers.
      const framing: RawConsoleUpstream['framing'] = inspect?.Config?.Tty ? 'raw' : 'docker-multiplexed';
      const request =
        `GET /containers/${encodeURIComponent(resourceId)}/logs?follow=1&stdout=1&stderr=1&tail=500 HTTP/1.1\r\n` +
        `Host: docker\r\n\r\n`;
      ctx.log('info', `Docker logs stream opened for ${resourceId.slice(0, 12)}.`);
      return { url: '', type: 'docker-logs', raw: { ...conn, request, framing, readOnly: true } };
    }

    // Interactive shell (default). Prefer bash, fall back to sh.
    const execId = await api.createExec(resourceId, [
      '/bin/sh',
      '-c',
      '[ -x /bin/bash ] && exec /bin/bash || exec /bin/sh',
    ]);
    const body = JSON.stringify({ Detach: false, Tty: true });
    const request =
      `POST /exec/${execId}/start HTTP/1.1\r\n` +
      `Host: docker\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body;
    ctx.log('info', `Docker exec shell opened for ${resourceId.slice(0, 12)}.`);
    return { url: '', type: 'docker-exec', raw: { ...conn, request, framing: 'raw', execId } };
  }

  /** Prefill the edit-stack form with the stored compose. */
  async operationDefaults(
    ctx: ConnectorContext,
    operationId: string,
    resourceId: string | undefined,
  ): Promise<Record<string, unknown>> {
    if (operationId === 'edit-stack' && resourceId && ctx.instanceId) {
      const stored = await this.stacks.get(ctx.instanceId, resourceId);
      if (stored) return { compose: stored.compose, env: stored.env ?? '' };
    }
    return {};
  }

  /** Start / stop / restart every container in a compose project (works for any stack). */
  private async stackLifecycle(
    ctx: ConnectorContext,
    api: DockerApi,
    project: string,
    action: 'start' | 'stop' | 'restart',
  ): Promise<{ ok: boolean; message: string }> {
    const all = await api.listContainers(true);
    const members = all.filter((c) => (c.Labels?.[COMPOSE_PROJECT] ?? 'ungrouped') === project);
    if (members.length === 0) return { ok: false, message: `No containers found for stack "${project}".` };

    // Only act on containers that need it (start the stopped, stop the running); restart all.
    const targets =
      action === 'stop'
        ? members.filter((m) => m.State === 'running' || m.State === 'restarting')
        : action === 'start'
          ? members.filter((m) => STOPPED_STATES.has(m.State ?? ''))
          : members;
    if (targets.length === 0) return { ok: true, message: `Stack "${project}" is already in the desired state.` };

    const run = (id: string) =>
      action === 'start' ? api.startContainer(id) : action === 'stop' ? api.stopContainer(id) : api.restartContainer(id);
    const results = await Promise.allSettled(targets.map((m) => run(m.Id)));
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    const past = action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted';
    ctx.log('info', `Docker stack ${action} "${project}": ${targets.length - failed.length}/${targets.length} containers ${past}.`);
    if (failed.length) {
      const first = failed[0].reason;
      return { ok: false, message: `Only ${targets.length - failed.length}/${targets.length} containers ${past}: ${first instanceof Error ? first.message : first}` };
    }
    return { ok: true, message: `Stack ${past} — ${targets.length} container${targets.length !== 1 ? 's' : ''}.` };
  }

  /**
   * How many distinct running images have a newer version in their registry.
   * Reads the cache and kicks off background refreshes for stale entries — the
   * count populates over a few polls and never blocks on registry latency.
   */
  /**
   * Per-container image-update state (containerId → true/false/null-unknown), reusing the same
   * cached registry-digest comparison as the overview count. Non-blocking: unknown entries kick off
   * a background refresh. Used to surface "update available" on stacks and their member containers.
   */
  private async updatesByContainerId(api: DockerApi, containers: DockerContainer[]): Promise<Map<string, boolean | null>> {
    const out = new Map<string, boolean | null>();
    let images: Awaited<ReturnType<DockerApi['listImages']>>;
    try {
      images = await api.listImages();
    } catch {
      return out;
    }
    const digestByImageId = new Map<string, string | null>();
    for (const im of images) digestByImageId.set(im.Id, DockerConnector.localDigest(im.RepoDigests));
    for (const c of containers) {
      if (c.State !== 'running' || !c.Image || !c.ImageID || !c.Id) continue;
      const local = digestByImageId.get(c.ImageID);
      if (!local) { out.set(c.Id, null); continue; } // locally-built / no registry digest → unknown
      const key = `${c.Image}@@${local}`;
      const cached = this.updateCache.get(key);
      if (!cached || Date.now() - cached.at > UPDATE_TTL_MS) void this.refreshUpdate(key, c.Image, local);
      out.set(c.Id, cached?.hasUpdate ?? null);
    }
    return out;
  }

  private async countUpdates(api: DockerApi, containers: DockerContainer[]): Promise<number> {
    let images: Awaited<ReturnType<DockerApi['listImages']>>;
    try {
      images = await api.listImages();
    } catch {
      return 0;
    }
    const digestByImageId = new Map<string, string | null>();
    for (const im of images) digestByImageId.set(im.Id, DockerConnector.localDigest(im.RepoDigests));

    let count = 0;
    const seen = new Set<string>();
    for (const c of containers) {
      if (c.State !== 'running' || !c.Image || !c.ImageID) continue;
      const local = digestByImageId.get(c.ImageID);
      if (!local) continue; // locally-built / no registry digest → can't check
      const key = `${c.Image}@@${local}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cached = this.updateCache.get(key);
      if (!cached || Date.now() - cached.at > UPDATE_TTL_MS) void this.refreshUpdate(key, c.Image, local);
      if (cached?.hasUpdate) count++;
    }
    return count;
  }

  async overview(ctx: ConnectorContext): Promise<ConnectorOverview> {
    const api = this.apiFrom(ctx);
    const [info, containers, df] = await Promise.all([
      api.info(),
      api.listContainers(true).catch(() => [] as DockerContainer[]),
      api.df().catch(() => null),
    ]);

    const running = containers.filter((c) => c.State === 'running').length;
    const stopped = containers.filter((c) => STOPPED_STATES.has(c.State ?? '')).length;
    const unhealthy = containers.filter((c) => healthFromStatus(c.Status) === 'unhealthy').length;
    const restarting = containers.filter((c) => c.State === 'restarting').length;

    const metrics: OverviewMetric[] = [
      { key: 'containersRunning', label: 'Running', value: running },
      { key: 'containersStopped', label: 'Stopped', value: stopped },
      { key: 'containersUnhealthy', label: 'Unhealthy', value: unhealthy },
      { key: 'containersRestarting', label: 'Restarting', value: restarting },
      { key: 'imagesTotal', label: 'Images', value: info.Images ?? 0 },
    ];
    // Image updates available — heavily cached + background-refreshed (registry calls
    // are rate-limited, so never block the overview on them).
    metrics.push({ key: 'updatesAvailable', label: 'Updates', value: await this.countUpdates(api, containers) });

    if (df) metrics.push({ key: 'diskUsedGb', label: 'Disk used', value: bytesToGb(diskUsed(df)), unit: 'GB' });
    if (info.MemTotal) metrics.push({ key: 'memTotalGb', label: 'Host RAM', value: bytesToGb(info.MemTotal), unit: 'GB' });
    if (info.NCPU) metrics.push({ key: 'hostCpus', label: 'Host CPUs', value: info.NCPU });

    // Host telemetry over SSH (CPU load, memory, root-fs disk) — the Engine API can't see these.
    metrics.push(...this.hostMetrics(ctx));

    // Guests: unhealthy/stopped first so problems surface at the top of the list.
    const guests = containers
      .slice()
      .sort((a, b) => severityRank(b) - severityRank(a) || cleanContainerName(a.Names).localeCompare(cleanContainerName(b.Names)))
      .slice(0, 40)
      .map((c) => ({
        name: cleanContainerName(c.Names),
        kind: CONTAINER_KIND,
        status: healthFromStatus(c.Status) === 'unhealthy' ? 'unhealthy' : c.State ?? 'unknown',
        node: info.Name ?? '',
      }));

    return { metrics, guests };
  }
}

/** Map a container event to the resource state it implies. Returns null for events we ignore. */
function eventToResource(e: DockerEvent): ConnectorResource | null {
  const id = e.Actor?.ID || e.id;
  if (!id) return null;
  const action = (e.Action || e.status || '').toLowerCase();
  const attrs = e.Actor?.Attributes ?? {};
  const name = attrs.name || id.slice(0, 12);

  // Derive the new state from the action; skip actions that don't change lifecycle state.
  let status: string;
  if (action.startsWith('health_status')) {
    status = action.includes('unhealthy') ? 'unhealthy' : 'running';
  } else {
    switch (action) {
      case 'start':
      case 'unpause':
      case 'restart': status = 'running'; break;
      case 'die':
      case 'stop':
      case 'kill': status = 'exited'; break;
      case 'pause': status = 'paused'; break;
      case 'create': status = 'created'; break;
      case 'destroy': status = 'removed'; break;
      default: return null; // exec_*, attach, top, etc. — not a state change
    }
  }

  const project = attrs[COMPOSE_PROJECT];
  const service = attrs[COMPOSE_SERVICE];
  return {
    id,
    kind: CONTAINER_KIND,
    name,
    status,
    details: {
      state: status,
      image: attrs.image ?? null,
      stack: project ?? null,
      service: service ?? null,
    },
    tags: { state: status, ...(project ? { stack: project } : {}) },
  };
}

/** Sort weight so unhealthy > stopped > everything else floats to the top of the guest list. */
function severityRank(c: DockerContainer): number {
  if (healthFromStatus(c.Status) === 'unhealthy') return 2;
  if (STOPPED_STATES.has(c.State ?? '')) return 1;
  return 0;
}

/** Total disk consumed by Docker: deduped image layers + container writable + volumes + build cache. */
function diskUsed(df: NonNullable<Awaited<ReturnType<DockerApi['df']>>>): number {
  const images = df.LayersSize ?? 0;
  const containers = (df.Containers ?? []).reduce((n, c) => n + (c.SizeRw ?? 0), 0);
  const volumes = (df.Volumes ?? []).reduce((n, v) => n + (v.UsageData?.Size ?? 0), 0);
  const cache = (df.BuildCache ?? []).reduce((n, b) => n + (b.Size ?? 0), 0);
  return images + containers + volumes + cache;
}

function shortId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}

/**
 * Parse the prefixed host-telemetry output (see refreshHost) into overview metrics:
 * load average + load %, memory used %, and root-fs disk used %.
 */
function parseHostStats(out: string): OverviewMetric[] {
  const get = (p: string) => new RegExp(`^${p}=(.*)$`, 'm').exec(out || '')?.[1]?.trim();
  const load1 = Number(get('L'));
  const cpus = Number(get('C'));
  const [memTotal, memAvail] = (get('M') ?? '').split(',').map(Number);
  const [diskTotal, diskUsed] = (get('D') ?? '').split(',').map(Number);

  const metrics: OverviewMetric[] = [];
  if (Number.isFinite(load1)) metrics.push({ key: 'hostLoad1', label: 'Host load', value: round(load1, 2) });
  if (Number.isFinite(load1) && cpus > 0) metrics.push({ key: 'hostLoadPct', label: 'CPU load', value: round((load1 / cpus) * 100, 0), unit: '%' });
  if (memTotal > 0 && Number.isFinite(memAvail)) metrics.push({ key: 'hostMemUsedPct', label: 'Host memory', value: round(((memTotal - memAvail) / memTotal) * 100, 0), unit: '%' });
  if (diskTotal > 0 && Number.isFinite(diskUsed)) metrics.push({ key: 'hostRootDiskPct', label: 'Root disk', value: round((diskUsed / diskTotal) * 100, 0), unit: '%' });
  return metrics;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Env var names whose values we mask in the detail view. */
const SECRETISH = /pass|secret|token|key|pwd|cred|auth/i;

/** Best-effort host the browser can reach a published port on: the SSH host, else
 *  the endpoint host (tcp/http/https). Null for a local unix socket. */
function browsableHost(config: Record<string, unknown>): string | null {
  const ssh = str(config.sshHost);
  if (ssh) return ssh;
  const ep = str(config.endpoint) ?? '';
  const m = ep.match(/^(?:tcp|https?):\/\/([^:/]+)/i);
  return m ? m[1] : null;
}

function str(v: unknown): string | undefined {
  const s = v == null ? '' : String(v).trim();
  return s ? s : undefined;
}

function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
}

/** Extract the `docker compose up` flag toggles from an operation's values. */
function optsFrom(values: Record<string, unknown>) {
  return {
    pull: bool(values.pull),
    forceRecreate: bool(values.forceRecreate),
    removeOrphans: bool(values.removeOrphans),
  };
}
