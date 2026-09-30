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
