import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BackupTargetKind } from '@cerebro/shared';

const execFileAsync = promisify(execFile);

/**
 * Restic invocation shared by both execution sites: the server itself (probe,
 * init, snapshots, and — from Phase 4 — forget/prune with the full credential),
 * and the helper container on a Docker host (backup/restore, which needs the
 * volumes mounted). Only the environment differs, so it is built once here.
 *
 * See docs/stack-backup.md.
 */
export interface ResticRepoAuth {
  kind: BackupTargetKind;
  /** e.g. "b2:trevor-stacks:/" or "s3:https://nas:9000/stacks". */
  repository: string;
  password: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class ResticError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'ResticError';
  }
}

/**
 * The environment restic needs. Credentials only ever travel as environment
 * variables — never as command-line arguments, which are world-readable in the
 * process list on both the server and the Docker host.
 */
export function resticEnv(auth: ResticRepoAuth): Record<string, string> {
  const env: Record<string, string> = {
    RESTIC_REPOSITORY: auth.repository,
    RESTIC_PASSWORD: auth.password,
    // Non-interactive: never try to prompt, never emit progress spam into the run log.
    RESTIC_PROGRESS_FPS: '0',
  };
  if (auth.kind === 'b2') {
    env.B2_ACCOUNT_ID = auth.accessKeyId;
    env.B2_ACCOUNT_KEY = auth.secretAccessKey;
  } else {
    env.AWS_ACCESS_KEY_ID = auth.accessKeyId;
    env.AWS_SECRET_ACCESS_KEY = auth.secretAccessKey;
  }
  return env;
}

/** Turn a restic failure into something an operator can act on. */
export function friendlyRestic(err: unknown): ResticError {
  const e = err as { code?: string | number; stderr?: string; stdout?: string; message?: string } | undefined;
  const msg = (e?.stderr || '').toString() || e?.message || String(err);
  if ((e?.code as string) === 'ENOENT' && /restic/.test(e?.message || '')) {
    return new ResticError('The restic binary is not installed in the server image.', 'ENOENT');
  }
  if (/wrong password|invalid password|unable to open repository|decrypt/i.test(msg)) {
    return new ResticError('Restic could not decrypt the repository — check the repository password.', 'auth');
  }
  if (/unable to open config file|Is there a repository|repository .* does not exist|config: no such/i.test(msg)) {
    return new ResticError('No restic repository at that location yet.', 'norepo');
  }
  if (/b2_(authorize_account|list)|401|unauthorized|bad_?auth|InvalidAccessKeyId|SignatureDoesNotMatch/i.test(msg)) {
    return new ResticError('The storage provider rejected the credentials.', 'credentials');
  }
  if (/repository is already locked|locked exclusively/i.test(msg)) {
    return new ResticError('The repository is locked by another restic run. Retry once it finishes, or unlock it.', 'locked');
  }
  if (/no such host|dial tcp|timeout|connection refused|network is unreachable/i.test(msg)) {
    return new ResticError('Could not reach the backup repository — network or DNS problem.', 'network');
  }
  const first = msg.split('\n').map((l) => l.trim()).filter(Boolean)[0] || 'restic command failed.';
  return new ResticError(first);
}

/** Run restic on the Cerebro server itself. Used for probe/init and (Phase 4) prune. */
export async function runResticLocal(
  auth: ResticRepoAuth,
  args: string[],
  timeoutMs = 120_000,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('restic', args, {
      env: { ...process.env, ...resticEnv(auth) },
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return stdout;
  } catch (err) {
    throw friendlyRestic(err);
  }
}

/** Does the repository exist and do the credentials open it? */
export async function probeRepo(auth: ResticRepoAuth): Promise<{ exists: boolean; message: string }> {
  try {
    await runResticLocal(auth, ['cat', 'config'], 60_000);
    return { exists: true, message: 'Repository opened.' };
  } catch (err) {
    if (err instanceof ResticError && err.code === 'norepo') {
      return { exists: false, message: 'No repository there yet — it can be initialized.' };
    }
    throw err;
  }
}

/** Create the repository. Safe to call only after probeRepo reports it is missing. */
export async function initRepo(auth: ResticRepoAuth): Promise<void> {
  await runResticLocal(auth, ['init'], 120_000);
}

/** restic's `--json` backup output: the one line that matters is the summary. */
export interface ResticBackupSummary {
  snapshotId?: string;
  filesNew?: number;
  filesTotal?: number;
  bytesAdded?: number;
  bytesTotal?: number;
}

/**
 * Pull the summary out of a `restic backup --json` stream. restic emits one JSON
 * object per line; with RESTIC_PROGRESS_FPS=0 that is essentially just the final
 * `summary`, but errors and verbose lines can appear alongside it.
 */
export function parseBackupSummary(stdout: string): ResticBackupSummary {
  const out: ResticBackupSummary = {};
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.message_type !== 'summary') continue;
    out.snapshotId = typeof o.snapshot_id === 'string' ? o.snapshot_id : out.snapshotId;
    out.filesNew = num(o.files_new) ?? out.filesNew;
    out.filesTotal = num(o.total_files_processed) ?? out.filesTotal;
    out.bytesAdded = num(o.data_added) ?? out.bytesAdded;
    out.bytesTotal = num(o.total_bytes_processed) ?? out.bytesTotal;
  }
  return out;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** One snapshot as restic reports it, with Cerebro's tags already decoded. */
export interface ResticSnapshot {
  id: string;
  shortId: string;
  time: string;
  hostname?: string;
  tags: string[];
}

/**
 * List Cerebro's stack snapshots, newest first. Note restic's tag semantics: a
 * comma-separated `--tag a,b` matches snapshots carrying BOTH, while repeating
 * `--tag` is an OR — so the filters below intentionally build one comma list.
 */
export async function listSnapshots(
  auth: ResticRepoAuth,
  filter: { stackName?: string; hostId?: string } = {},
): Promise<ResticSnapshot[]> {
  const tags = ['cerebro', 'type:stack'];
  if (filter.stackName) tags.push(`stack:${filter.stackName}`);
  if (filter.hostId) tags.push(`host:${filter.hostId}`);

  const raw = await runResticLocal(auth, ['snapshots', '--json', '--tag', tags.join(',')], 120_000);
  const arr = JSON.parse(raw || '[]') as {
    id: string; short_id?: string; time: string; hostname?: string; tags?: string[];
  }[];
  return arr
    .map((s) => ({
      id: s.id,
      shortId: s.short_id || s.id.slice(0, 8),
      time: s.time,
      hostname: s.hostname,
      tags: s.tags ?? [],
    }))
    .sort((a, b) => (b.time > a.time ? 1 : -1));
}

/** Read one file out of a snapshot, from the server. Used to plan a restore
 *  without touching the destination host. */
export async function dumpFile(auth: ResticRepoAuth, snapshotId: string, path: string): Promise<string> {
  return runResticLocal(auth, ['dump', snapshotId, path], 120_000);
}

/** One entry from `restic ls`. */
export interface ResticLsEntry {
  path: string;
  name: string;
  type: string;
  size?: number;
}

/**
 * List one level of a snapshot's contents. `--recursive=false` is explicit rather
 * than relying on the default: a recursive listing of a volume with a million
 * files would blow the output buffer and is useless to render anyway.
 */
export async function listFiles(
  auth: ResticRepoAuth,
  snapshotId: string,
  subtree?: string,
): Promise<ResticLsEntry[]> {
  const args = ['ls', '--json', '--recursive=false', snapshotId];
  if (subtree) args.push(subtree);
  const raw = await runResticLocal(auth, args, 180_000);
  const out: ResticLsEntry[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t) as { struct_type?: string; message_type?: string; path?: string; name?: string; type?: string; size?: number };
      // The first line is the snapshot header; only node records carry a path.
      if ((o.struct_type ?? o.message_type) !== 'node' || !o.path) continue;
      out.push({ path: o.path, name: o.name ?? o.path.split('/').pop() ?? o.path, type: o.type ?? 'file', size: o.size });
    } catch {
      /* not a node line */
    }
  }
  return out;
}

/** Pull `stack:` / `host:` / `policy:` / `run:` back out of a snapshot's tags. */
export function decodeTags(tags: string[]): { stackName?: string; hostId?: string; policyId?: string; runId?: string } {
  const find = (prefix: string) => tags.find((t) => t.startsWith(prefix))?.slice(prefix.length);
  return {
    stackName: find('stack:'),
    hostId: find('host:'),
    policyId: find('policy:'),
    runId: find('run:'),
  };
}
