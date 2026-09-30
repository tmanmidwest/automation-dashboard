import type { DockerApi } from '../connectors/docker/docker-api';

/**
 * Works out what a compose stack is made of, so a backup can capture all of it.
 * Everything comes from the Engine API's own view (labels + inspect), which means
 * it works for stacks Cerebro never deployed — the bare-host case this feature
 * exists for. See docs/stack-backup.md.
 */

const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';
const CONFIG_FILES_LABEL = 'com.docker.compose.project.config_files';
const WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';

/**
 * Bind mounts that are plumbing, not data. Backing these up would be pointless at
 * best (a socket) and dangerous at worst, so they are never offered for inclusion.
 */
const PLUMBING_BINDS = [
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/etc/localtime',
  '/etc/timezone',
  '/etc/hostname',
  '/etc/hosts',
  '/etc/resolv.conf',
];
const PLUMBING_PREFIXES = ['/proc', '/sys', '/dev'];

export interface StackContainerInfo {
  id: string;
  name: string;
  service?: string;
  /** The image reference as configured (e.g. `postgres:16`). */
  image?: string;
  /** The resolved image id/digest actually running — what a faithful restore needs. */
  imageId?: string;
  state?: string;
  restartPolicy?: string;
  labels: Record<string, string>;
  ports: { hostIp?: string; hostPort?: string; containerPort: string }[];
  mounts: { type: string; source?: string; destination?: string; name?: string; rw?: boolean }[];
  networks: string[];
  /** Resolved container environment. Values are credentials as often as not, so
   *  they are routed through the secretMode capture and stripped from the manifest
   *  by {@link manifestOf} — never written unsealed. */
  env: Record<string, string>;
}

export interface StackVolumeInfo {
  name: string;
  driver?: string;
  options?: Record<string, string> | null;
  labels?: Record<string, string> | null;
  /** Not labelled with the compose project — an anonymous or externally-created volume. */
  external: boolean;
}

export interface StackBindInfo {
  path: string;
  containers: string[];
  readOnly: boolean;
}

export interface StackInspection {
  project: string;
  containers: StackContainerInfo[];
  volumes: StackVolumeInfo[];
  binds: StackBindInfo[];
  networks: { name: string; driver?: string }[];
  /** From the compose labels — where the stack's compose file lives on the host. */
  composePath?: string;
  workingDir?: string;
}

function isPlumbing(path: string): boolean {
  if (PLUMBING_BINDS.includes(path)) return true;
  return PLUMBING_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Inspect every resource belonging to one compose project. */
export async function inspectStack(api: DockerApi, project: string): Promise<StackInspection> {
  const all = await api.listContainers(true);
  const members = all.filter((c) => (c.Labels ?? {})[PROJECT_LABEL] === project);
  if (!members.length) {
    throw new Error(`No containers found for stack "${project}" on this host — it may have been removed or renamed.`);
  }

  const containers: StackContainerInfo[] = [];
  const volumeNames = new Set<string>();
  const bindMap = new Map<string, { containers: string[]; readOnly: boolean }>();

  for (const c of members) {
    const name = (c.Names ?? [])[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12);
    let inspect: Awaited<ReturnType<DockerApi['inspectContainer']>> | null = null;
    try {
      inspect = await api.inspectContainer(c.Id);
    } catch {
      // A container that vanished mid-inspect shouldn't fail the whole backup; the
      // list entry still carries enough for the manifest.
    }

    const mounts = (inspect?.Mounts ?? []).map((m) => ({
      type: m.Type ?? 'unknown',
      source: m.Source,
      destination: m.Destination,
      name: m.Name,
      rw: m.RW,
    }));

    for (const m of mounts) {
      if (m.type === 'volume' && m.name) volumeNames.add(m.name);
      if (m.type === 'bind' && m.source && !isPlumbing(m.source)) {
        const entry = bindMap.get(m.source) ?? { containers: [], readOnly: true };
        entry.containers.push(name);
        // A path any container can write to must be treated as writable data.
        if (m.rw !== false) entry.readOnly = false;
        bindMap.set(m.source, entry);
      }
    }

    const ports: StackContainerInfo['ports'] = [];
    for (const [containerPort, bindings] of Object.entries(inspect?.NetworkSettings?.Ports ?? {})) {
      for (const b of bindings ?? []) ports.push({ hostIp: b.HostIp, hostPort: b.HostPort, containerPort });
    }

    containers.push({
      id: c.Id,
      name,
      service: (c.Labels ?? {})[SERVICE_LABEL],
      image: c.Image ?? inspect?.Config?.Image,
      imageId: c.ImageID ?? inspect?.Image,
      state: c.State,
      labels: c.Labels ?? {},
      ports,
      mounts,
      networks: Object.keys(inspect?.NetworkSettings?.Networks ?? c.NetworkSettings?.Networks ?? {}),
      env: parseEnv(inspect?.Config?.Env ?? []),
    });
  }

  // Volumes labelled with the project but not currently mounted still hold data
  // (a scaled-down or removed service), so union them in.
  let labelled: { Name: string; Labels?: Record<string, string> | null }[] = [];
  try {
    labelled = await api.listVolumes();
  } catch {
    /* volume listing may be denied by a socket proxy — mounted volumes still work */
  }
  for (const v of labelled) {
    if ((v.Labels ?? {})[PROJECT_LABEL] === project) volumeNames.add(v.Name);
  }

  const volumes: StackVolumeInfo[] = [];
  for (const name of [...volumeNames].sort()) {
    try {
      const v = await api.inspectVolume(name);
      volumes.push({
        name,
        driver: v.Driver,
        options: v.Options ?? null,
        labels: v.Labels ?? null,
        external: (v.Labels ?? {})[PROJECT_LABEL] !== project,
      });
    } catch {
      volumes.push({ name, external: true });
    }
  }

  const first = members[0]?.Labels ?? {};
  return {
    project,
    containers,
    volumes,
    binds: [...bindMap.entries()]
      .map(([path, v]) => ({ path, containers: v.containers, readOnly: v.readOnly }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    networks: [...new Set(containers.flatMap((c) => c.networks))].map((name) => ({ name })),
    composePath: first[CONFIG_FILES_LABEL],
    workingDir: first[WORKING_DIR_LABEL],
  };
}

/** Docker reports container env as `KEY=value` strings. */
function parseEnv(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/**
 * The snapshot's `manifest.json`: everything needed to understand and rebuild the
 * stack, with every environment VALUE stripped to a bare name. Those values are
 * credentials often enough that duplicating them into an unsealed file would
 * quietly undo whatever the policy's secretMode was trying to achieve.
 */
export function manifestOf(inspection: StackInspection, extra: Record<string, unknown> = {}): string {
  const body = {
    schema: 1,
    capturedAt: new Date().toISOString(),
    ...extra,
    project: inspection.project,
    composePath: inspection.composePath,
    workingDir: inspection.workingDir,
    networks: inspection.networks,
    volumes: inspection.volumes,
    binds: inspection.binds,
    containers: inspection.containers.map(({ env, ...c }) => ({ ...c, envNames: Object.keys(env).sort() })),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** A filesystem-safe directory name for a bind path (`/srv/app data` → `srv-app-data`). */
export function bindSlug(path: string): string {
  const slug = path.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'root';
}
