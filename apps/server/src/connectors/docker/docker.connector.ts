import type {
  Connector,
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
  TestConnectionResult,
} from '@cerebro/shared';
import {
  DockerApi,
  DockerContainer,
  cleanContainerName,
  healthFromStatus,
  type DockerAuth,
  type DockerContainerStats,
} from './docker-api';

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
    deletable: false,
    actions: [],
    subResources: [{ id: CONTAINER_KIND, label: 'Containers', labelSingular: 'Container' }],
  },
  {
    id: CONTAINER_KIND,
    label: 'Containers',
    category: 'container',
    deletable: true,
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

const OPERATIONS: ConnectorOperation[] = [
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
      CONTAINERS: 1
      IMAGES: 1
      VOLUMES: 1
      NETWORKS: 1
      POST: 1          # 1 = allow actions (start/stop/restart, pull, prune); 0 = read-only
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

/** A short, human port summary, e.g. "8080→80/tcp". */
function portSummary(c: DockerContainer): string | null {
  const mapped = (c.Ports ?? []).filter((p) => p.PublicPort);
  if (mapped.length === 0) return null;
  return mapped
    .slice(0, 4)
    .map((p) => `${p.PublicPort}→${p.PrivatePort}/${p.Type ?? 'tcp'}`)
    .join(', ');
}

export class DockerConnector implements Connector {
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
    ],
    resourceKinds: KINDS,
    operations: OPERATIONS,
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
            'A tiny, read/write-scoped gateway to the Docker socket — no agent, no UI. POST=1 enables the connector\'s actions (start/stop/restart, pull, prune). Set POST=0 to keep the host read-only.',
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
    if (kind !== CONTAINER_KIND) return { ok: false, message: `No actions for ${kind}.` };
    const api = this.apiFrom(ctx);
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
      return this.stacksFromContainers(containers);
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
  private stacksFromContainers(containers: DockerContainer[]): ConnectorResource[] {
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
        },
        tags: { status },
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
      const general: ConnectorDetailItem[] = [
        { label: 'Name', value: name || shortId(inspect.Id) },
        { label: 'State', value: inspect.State?.Status ?? '—', variant: 'status' },
        ...(health ? [{ label: 'Health', value: health, variant: 'status' as const }] : []),
        { label: 'Image', value: inspect.Config?.Image ?? '—', variant: 'mono' },
        { label: 'Restart count', value: String(inspect.RestartCount ?? 0) },
        { label: 'Started', value: rel(inspect.State?.StartedAt) ?? '—' },
        { label: 'Stack', value: inspect.Config?.Labels?.[COMPOSE_PROJECT] ?? '—' },
        { label: 'Service', value: inspect.Config?.Labels?.[COMPOSE_SERVICE] ?? '—' },
        { label: 'Container ID', value: shortId(inspect.Id), variant: 'mono' },
      ];
      const groups: ConnectorDetailGroup[] = [{ title: 'General', items: general }];

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

      return {
        id: inspect.Id,
        kind,
        name: name || shortId(inspect.Id),
        status: health === 'unhealthy' ? 'unhealthy' : inspect.State?.Status ?? 'unknown',
        groups,
      };
    }

    // Images/volumes/networks/stacks: build a light detail from the list entry.
    const list = await this.listResources(ctx, kind);
    const r = list.find((x) => x.id === resourceId);
    if (!r) throw new Error(`${kind} ${resourceId} not found.`);
    const items: ConnectorDetailItem[] = Object.entries(r.details ?? {}).map(([k, v]) => ({
      label: k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
      value: v == null ? '—' : String(v),
    }));
    return { id: r.id, kind, name: r.name, status: r.status, groups: [{ title: 'General', items }] };
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

    const metrics: OverviewMetric[] = [
      { key: 'containersRunning', label: 'Running', value: running },
      { key: 'containersStopped', label: 'Stopped', value: stopped },
      { key: 'containersUnhealthy', label: 'Unhealthy', value: unhealthy },
      { key: 'imagesTotal', label: 'Images', value: info.Images ?? 0 },
    ];
    if (df) metrics.push({ key: 'diskUsedGb', label: 'Disk used', value: bytesToGb(diskUsed(df)), unit: 'GB' });
    if (info.MemTotal) metrics.push({ key: 'memTotalGb', label: 'Host RAM', value: bytesToGb(info.MemTotal), unit: 'GB' });
    if (info.NCPU) metrics.push({ key: 'hostCpus', label: 'Host CPUs', value: info.NCPU });

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

function str(v: unknown): string | undefined {
  const s = v == null ? '' : String(v).trim();
  return s ? s : undefined;
}

function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
}
