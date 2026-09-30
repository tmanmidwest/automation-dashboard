import { spawn } from 'node:child_process';
import { mkdir, rm, statfs } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DockerApi } from '../connectors/docker/docker-api';
import type { StackInspection } from './stack-inspect';
import { bindSlug } from './stack-inspect';

/**
 * Relay transfer: move a stack's data **through Cerebro** instead of having the
 * Docker host talk to the repository itself.
 *
 * This exists for hosts that cannot do it themselves — no SSH to launch a helper
 * container, or no outbound network to reach B2. The trick that makes it work
 * without needing any image on the host is that we never create a container at
 * all: every volume is already mounted by one of the stack's own containers, and
 * the Engine API can stream a path out of a container (`docker cp`, essentially)
 * whether or not it is running.
 *
 * The cost is real and worth stating plainly: every byte crosses the network
 * twice and lands on Cerebro's disk in between. See docs/stack-backup.md.
 */

/** One thing to copy, and the container it is reachable through. */
export interface RelaySource {
  kind: 'volume' | 'bind';
  /** Volume name, or host path for a bind. */
  name: string;
  containerId: string;
  containerName: string;
  /** Where it is mounted inside that container. */
  pathInContainer: string;
  /** Where it lands in the staging tree, relative to the staging root. */
  relDir: string;
}

export interface RelayPlan {
  sources: RelaySource[];
  /** Volumes/binds no running-or-stopped container mounts, so relay cannot reach them. */
  unreachable: string[];
}

/**
 * Work out how to reach each volume and bind through the stack's own containers.
 * A volume nothing mounts is unreachable in relay mode — there is no container to
 * read it through — and is reported rather than silently missing.
 */
export function planRelay(inspection: StackInspection, volumes: string[], binds: string[]): RelayPlan {
  const sources: RelaySource[] = [];
  const unreachable: string[] = [];

  for (const name of volumes) {
    const hit = findMount(inspection, (m) => m.type === 'volume' && m.name === name);
    if (!hit) { unreachable.push(name); continue; }
    sources.push({
      kind: 'volume', name,
      containerId: hit.container.id, containerName: hit.container.name,
      pathInContainer: hit.mount.destination!,
      relDir: `volumes/${name}`,
    });
  }

  for (const path of binds) {
    const hit = findMount(inspection, (m) => m.type === 'bind' && m.source === path);
    if (!hit) { unreachable.push(path); continue; }
    sources.push({
      kind: 'bind', name: path,
      containerId: hit.container.id, containerName: hit.container.name,
      pathInContainer: hit.mount.destination!,
      relDir: `binds/${bindSlug(path)}`,
    });
  }

  return { sources, unreachable };
}

function findMount(
  inspection: StackInspection,
  match: (m: StackInspection['containers'][number]['mounts'][number]) => boolean,
) {
  for (const container of inspection.containers) {
    const mount = container.mounts.find((m) => match(m) && !!m.destination);
    if (mount) return { container, mount };
  }
  return null;
}

/**
 * Where staged data lives on Cerebro. Deliberately a **stable** path rather than
 * one per run: restic records absolute paths, so a per-run directory would make
 * every snapshot a fresh tree and cost the dedup that makes incremental backups
 * cheap.
 */
export function relayRoot(): string {
  const base = process.env.STACK_BACKUP_RELAY_DIR
    || (existsSync('/data') ? '/data/stack-relay' : join(tmpdir(), 'cerebro-stack-relay'));
  return join(base, 'data');
}

/** Empty the staging tree and recreate it. */
export async function resetStaging(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, 'meta'), { recursive: true });
}

/** Free bytes where staging lives, or null when it cannot be determined. */
export async function freeBytes(root: string): Promise<number | null> {
  try {
    const st = await statfs(existsSync(root) ? root : tmpdir());
    return Number(st.bsize) * Number(st.bavail);
  } catch {
    return null;
  }
}

/**
 * Best-effort size of the volumes about to be staged, from the daemon's own
 * accounting. Used to refuse a relay run that would fill Cerebro's disk rather
 * than discovering it halfway through a 200 GB copy.
 */
export async function estimateBytes(api: DockerApi, volumeNames: string[]): Promise<number | null> {
  try {
    const df = await api.df();
    const wanted = new Set(volumeNames);
    let total = 0;
    let seen = 0;
    for (const v of df.Volumes ?? []) {
      if (!v.Name || !wanted.has(v.Name)) continue;
      const size = v.UsageData?.Size ?? -1;
      if (size >= 0) { total += size; seen += 1; }
    }
    return seen ? total : null;
  } catch {
    return null;
  }
}

/**
 * Stream one source out of its container and extract it into the staging tree.
 *
 * Docker's archive endpoint wraps the contents in a directory named after the
 * path's basename, so `--strip-components=1` puts the volume's own files at the
 * top of `<root>/<relDir>` — the same shape a direct-mode capture produces.
 */
export async function pullSource(api: DockerApi, source: RelaySource, root: string): Promise<void> {
  const dest = join(root, source.relDir);
  await mkdir(dest, { recursive: true });
  const tar = spawn('tar', ['-x', '-C', dest, '--strip-components=1'], { stdio: ['pipe', 'ignore', 'pipe'] });

  const stderr: Buffer[] = [];
  tar.stderr.on('data', (c: Buffer) => { if (stderr.length < 32) stderr.push(c); });
  const finished = new Promise<void>((resolve, reject) => {
    tar.on('error', reject);
    tar.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`Extracting ${source.name} failed (tar exited ${code}): ${Buffer.concat(stderr).toString('utf8').trim()}`));
    });
  });

  await api.getArchive(source.containerId, source.pathInContainer, tar.stdin);
  await finished;
}

/**
 * Stream a staged directory back into a container path. The tar is created from
 * the directory's *contents*, because Docker extracts the archive **into** the
 * path given, not alongside it.
 */
export async function pushDir(api: DockerApi, containerId: string, pathInContainer: string, dir: string): Promise<void> {
  const tar = spawn('tar', ['-C', dir, '-c', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr: Buffer[] = [];
  tar.stderr.on('data', (c: Buffer) => { if (stderr.length < 32) stderr.push(c); });

  const tarDone = new Promise<void>((resolve, reject) => {
    tar.on('error', reject);
    tar.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(`Packing ${dir} failed (tar exited ${code}): ${Buffer.concat(stderr).toString('utf8').trim()}`))));
  });

  await api.putArchive(containerId, pathInContainer, tar.stdout);
  await tarDone;
}

export function fmtBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
