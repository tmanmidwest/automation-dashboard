import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { Writable } from 'node:stream';

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper around the `restic` CLI, pointed at a Backblaze B2 repository.
 *
 * The Proxmox host backs up with restic, so the B2 bucket holds an encrypted,
 * deduplicated restic repo — not browsable files. This talks to that repo the
 * only way possible: through restic, using B2's native API (B2_ACCOUNT_ID/KEY)
 * plus the repository password. Cerebro uses a READ-ONLY B2 key, so it can list
 * and restore but never modify the repo.
 */
export interface ResticAuth {
  /** B2 keyID (read-only application key). */
  b2KeyId: string;
  /** B2 applicationKey. */
  b2AppKey: string;
  /** Restic repository string, e.g. "b2:trevor-homelab-offsite:/". */
  repository: string;
  /** Restic repository password (ideally a dedicated key added for Cerebro). */
  password: string;
}

export interface ResticSnapshot {
  id: string;
  shortId: string;
  time?: Date;
  hostname?: string;
  paths: string[];
  tags: string[];
}

export interface ResticFile {
  /** Full path as stored in the snapshot, e.g. /mnt/pve/Backups/dump/vzdump-qemu-100-....vma.zst */
  path: string;
  name: string;
  sizeBytes: number;
}

export interface ResticRepoStats {
  totalSizeBytes: number;
  snapshotCount: number;
}

export class ResticError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'ResticError';
  }
}

/** Turn a restic CLI failure into a short, human-readable message. */
function friendly(err: unknown): ResticError {
  const e = err as { code?: string | number; stderr?: string; message?: string } | undefined;
  const stderr = (e?.stderr || '').toString();
  const msg = stderr || e?.message || String(err);
  if ((e as { name?: string })?.name === 'AbortError' || (e?.code as string) === 'ABORT_ERR') {
    return new ResticError('Cancelled.', 'cancelled');
  }
  if ((e?.code as string) === 'ENOENT' && /restic/.test(e?.message || '')) {
    return new ResticError('The restic binary is not installed in the server image.', 'ENOENT');
  }
  if (/wrong password|invalid password|unable to open repository|decrypt/i.test(msg)) {
    return new ResticError('Restic could not decrypt the repository — check the repository password.', 'auth');
  }
  if (/unable to open config file|Is there a repository|repository .* does not exist|config: no such/i.test(msg)) {
    return new ResticError('No restic repository found at that location — check the repository string and B2 bucket.', 'norepo');
  }
  if (/b2_(authorize_account|list)|401|unauthorized|bad_?auth|Authorization/i.test(msg)) {
    return new ResticError('Backblaze rejected the credentials — check the B2 keyID and applicationKey.', 'b2auth');
  }
  if (/no such host|dial tcp|timeout|connection refused|network is unreachable/i.test(msg)) {
    return new ResticError('Could not reach Backblaze B2 — network/DNS problem.', 'network');
  }
  // Trim restic's multi-line noise to the first meaningful line.
  const first = msg.split('\n').map((l) => l.trim()).filter(Boolean)[0] || 'restic command failed.';
  return new ResticError(first);
}

export class Restic {
  constructor(private readonly auth: ResticAuth) {}

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      B2_ACCOUNT_ID: this.auth.b2KeyId,
      B2_ACCOUNT_KEY: this.auth.b2AppKey,
      RESTIC_REPOSITORY: this.auth.repository,
      RESTIC_PASSWORD: this.auth.password,
      // Non-interactive: never prompt for a password on a TTY.
      RESTIC_PROGRESS_FPS: '0',
    };
  }

  private async run(args: string[], maxBuffer = 128 * 1024 * 1024, signal?: AbortSignal): Promise<string> {
    try {
      const { stdout } = await execFileAsync('restic', args, { env: this.env(), maxBuffer, signal });
      return stdout;
    } catch (err) {
      throw friendly(err);
    }
  }

  /** Remove *stale* locks (from a killed/cancelled restic process). Never touches a live lock. */
  async unlock(signal?: AbortSignal): Promise<void> {
    await this.run(['unlock'], 8 * 1024 * 1024, signal);
  }

  /** restic version string (also a cheap "is the binary present" probe). */
  async version(): Promise<string> {
    return (await this.run(['version'])).trim();
  }

  /** List snapshots (newest first). */
  async snapshots(latestOnly = false): Promise<ResticSnapshot[]> {
    const args = ['snapshots', '--json'];
    if (latestOnly) args.push('--latest', '1');
    const raw = await this.run(args);
    const arr = JSON.parse(raw || '[]') as Array<{
      id: string; short_id: string; time: string; hostname?: string; paths?: string[]; tags?: string[];
    }>;
    return arr
      .map((s) => ({
        id: s.id,
        shortId: s.short_id || s.id.slice(0, 8),
        time: s.time ? new Date(s.time) : undefined,
        hostname: s.hostname,
        paths: s.paths ?? [],
        tags: s.tags ?? [],
      }))
      .sort((a, b) => (b.time?.getTime() ?? 0) - (a.time?.getTime() ?? 0));
  }

  /** List the files in a snapshot (restic ls emits newline-delimited JSON). */
  async listFiles(snapshotId: string): Promise<ResticFile[]> {
    const raw = await this.run(['ls', snapshotId, '--json']);
    const out: ResticFile[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let obj: { type?: string; path?: string; size?: number };
      try {
        obj = JSON.parse(t);
      } catch {
        continue; // skip the leading snapshot summary / any non-node line
      }
      if (obj.type === 'file' && obj.path) {
        out.push({ path: obj.path, name: obj.path.slice(obj.path.lastIndexOf('/') + 1), sizeBytes: obj.size ?? 0 });
      }
    }
    return out;
  }

  /** Read a single small file out of a snapshot as a string, or null if it's not there. */
  async catFile(snapshotId: string, filePath: string): Promise<string | null> {
    try {
      return await this.run(['dump', snapshotId, filePath], 8 * 1024 * 1024);
    } catch {
      return null; // file absent in this snapshot (e.g. older snapshots) — caller falls back
    }
  }

  /** Deduplicated repo size + snapshot count (scans the index — cache the result). */
  async stats(): Promise<ResticRepoStats> {
    const raw = await this.run(['stats', '--mode', 'raw-data', '--json']);
    const s = JSON.parse(raw || '{}') as { total_size?: number; snapshots_count?: number };
    return { totalSizeBytes: s.total_size ?? 0, snapshotCount: s.snapshots_count ?? 0 };
  }

  /**
   * Back up one or more paths into the repository (Cerebro owns the backup now
   * that the Proxmox-side restic job was retired). Streams restic's --json output
   * so progress can be reported without buffering the whole thing; returns the
   * final summary.
   */
  async backup(
    paths: string[],
    tags: string[],
    onStatus?: (s: { percent: number; secondsRemaining?: number }) => void,
    signal?: AbortSignal,
  ): Promise<{ snapshotId?: string; filesNew?: number; filesChanged?: number; bytesAdded?: number; bytesProcessed?: number }> {
    const args = ['backup', ...paths];
    for (const t of tags) args.push('--tag', t);
    args.push('--json');
    return new Promise((resolve, reject) => {
      const child = spawn('restic', args, { env: this.env(), signal });
      let stderr = '';
      let buf = '';
      let summary: Record<string, unknown> | undefined;
      const handleLine = (line: string) => {
        const t = line.trim();
        if (!t) return;
        let o: Record<string, unknown>;
        try { o = JSON.parse(t); } catch { return; }
        if (o.message_type === 'status' && onStatus && typeof o.percent_done === 'number') {
          onStatus({
            percent: Math.floor((o.percent_done as number) * 100),
            secondsRemaining: typeof o.seconds_remaining === 'number' ? (o.seconds_remaining as number) : undefined,
          });
        } else if (o.message_type === 'summary') {
          summary = o;
        }
      };
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) handleLine(l);
      });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => reject(friendly(err)));
      child.on('close', (code) => {
        if (buf) handleLine(buf);
        if (code === 0) {
          resolve({
            snapshotId: summary?.snapshot_id as string | undefined,
            filesNew: summary?.files_new as number | undefined,
            filesChanged: summary?.files_changed as number | undefined,
            bytesAdded: summary?.data_added as number | undefined,
            bytesProcessed: summary?.total_bytes_processed as number | undefined,
          });
        } else {
          reject(friendly({ code: code ?? undefined, stderr }));
        }
      });
    });
  }

  /**
   * Age-based retention: keep snapshots within the last `days` (relative to the
   * newest snapshot — so the latest is always kept) and prune the rest from B2.
   */
  async forgetOlderThan(days: number, signal?: AbortSignal): Promise<void> {
    await this.run(['forget', '--keep-within', `${Math.max(1, Math.floor(days))}d`, '--prune'], 128 * 1024 * 1024, signal);
  }

  /**
   * Delete one snapshot. Without prune it's fast (just drops the snapshot
   * reference); the actual data is reclaimed by the next retention prune.
   */
  async forget(snapshotId: string, prune = false): Promise<void> {
    const args = ['forget', snapshotId];
    if (prune) args.push('--prune');
    await this.run(args);
  }

  /**
   * Stream one file out of a snapshot to a writable (e.g. a file in the NAS dump
   * folder). Resolves with the number of bytes written.
   */
  async dumpTo(snapshotId: string, filePath: string, dest: Writable, onBytes?: (n: number) => void, signal?: AbortSignal): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const child = spawn('restic', ['dump', snapshotId, filePath], { env: this.env(), signal });
      let bytes = 0;
      let stderr = '';
      let settled = false;
      let finished = false;
      let exitCode: number | undefined;
      const done = () => {
        if (settled || !finished || exitCode === undefined) return;
        settled = true;
        if (exitCode === 0) resolve(bytes);
        else reject(friendly({ code: exitCode, stderr }));
      };
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch { /* already gone */ }
        reject(err instanceof Error ? err : friendly(err));
      };
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (onBytes) onBytes(bytes);
      });
      child.on('error', (err) => fail(friendly(err)));
      dest.on('error', fail);
      // Resolve only when restic exited AND the file is fully flushed.
      dest.on('finish', () => { finished = true; done(); });
      child.on('close', (code) => { exitCode = code ?? 0; done(); });
      child.stdout.pipe(dest);
    });
  }
}
