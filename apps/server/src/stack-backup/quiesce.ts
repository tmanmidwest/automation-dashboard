import type { QuiesceMode, StackHook } from '@cerebro/shared';
import type { DockerApi } from '../connectors/docker/docker-api';
import { runSsh, type SshConfig } from '../connectors/docker/docker-ssh';
import type { StackInspection } from './stack-inspect';

/**
 * Making a capture consistent.
 *
 * A `hot` tar of a live Postgres or SQLite volume is not a backup — the files
 * are mid-write. There are three answers, in increasing order of honesty about
 * the cost: run a dump while the stack is up (a pre-hook), freeze the processes
 * for the capture window (`pause`), or take the downtime (`stop`).
 *
 * See docs/stack-backup.md.
 */

/** Undo whatever quiescing did. Always called, including when the capture fails. */
export type Resume = () => Promise<void>;

const RUNNING = new Set(['running', 'restarting']);

/**
 * Freeze or stop the stack's containers, returning the function that puts them
 * back. Order matters: compose creates a stack's dependencies first, so stopping
 * newest-first and starting oldest-last approximates taking dependents down
 * before what they depend on, and bringing them back in the other order.
 */
export async function quiesceStack(
  api: DockerApi,
  inspection: StackInspection,
  mode: QuiesceMode,
  say: (line: string) => void,
): Promise<Resume> {
  if (mode === 'hot') return async () => { /* nothing to undo */ };

  const targets = inspection.containers
    .filter((c) => RUNNING.has(c.state ?? ''))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0)); // dependents first

  if (!targets.length) {
    say('Nothing is running, so the capture is already consistent.');
    return async () => { /* nothing to undo */ };
  }

  const done: typeof targets = [];
  const verb = mode === 'pause' ? 'Paused' : 'Stopped';
  for (const c of targets) {
    try {
      if (mode === 'pause') await api.pauseContainer(c.id);
      else await api.stopContainer(c.id);
      done.push(c);
    } catch (err) {
      // Put back whatever we already touched rather than capturing a stack that
      // is half-frozen — that is worse than either a hot copy or a clean failure.
      say(`Could not ${mode} ${c.name}: ${msg(err)} — undoing.`);
      await resumeAll(api, done, mode, say);
      throw new Error(`Could not ${mode} "${c.name}" for a consistent capture: ${msg(err)}`);
    }
  }
  say(`${verb} ${done.length} container(s) for the capture.`);

  let resumed = false;
  return async () => {
    if (resumed) return;
    resumed = true;
    await resumeAll(api, done, mode, say);
  };
}

async function resumeAll(
  api: DockerApi,
  done: { id: string; name: string }[],
  mode: QuiesceMode,
  say: (line: string) => void,
): Promise<void> {
  // Reverse of the stop order: what everything else depends on comes back first.
  let failed = 0;
  for (const c of [...done].reverse()) {
    try {
      if (mode === 'pause') await api.unpauseContainer(c.id);
      else await api.startContainer(c.id);
    } catch (err) {
      failed += 1;
      say(`WARNING: could not bring ${c.name} back: ${msg(err)}`);
    }
  }
  if (done.length) {
    say(failed
      ? `Resumed ${done.length - failed} of ${done.length} container(s) — ${failed} need attention.`
      : `Resumed ${done.length} container(s).`);
  }
}

/** A hook's resolved target plus the shell command to run in it. */
function resolveTarget(inspection: StackInspection, hook: StackHook): string {
  if (hook.container) {
    const byName = inspection.containers.find((c) => c.name === hook.container);
    if (!byName) throw new Error(`Hook target container "${hook.container}" is not part of this stack.`);
    return byName.name;
  }
  if (hook.service) {
    const byService = inspection.containers.find((c) => c.service === hook.service);
    if (!byService) throw new Error(`Hook target service "${hook.service}" is not part of this stack.`);
    return byService.name;
  }
  throw new Error('A hook needs either a service or a container to run in.');
}

/** stdout captured into the snapshot is for small outputs; a real dump belongs in a volume. */
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

export interface HookResult {
  /** Files to add to the snapshot's meta directory (from `captureTo`). */
  files: Record<string, string>;
}

/**
 * Run a stack's hooks over SSH (`docker exec … sh -c`), so redirects and pipes
 * work the way an operator expects when they write a `pg_dump` line.
 *
 * A failing **pre**-hook fails the backup: the whole point of the dump is that
 * the snapshot contains it, and a snapshot missing its dump is a backup that
 * looks fine and isn't. A failing **post**-hook only warns — by then the data is
 * already captured.
 */
export async function runHooks(
  ssh: SshConfig,
  inspection: StackInspection,
  hooks: StackHook[],
  phase: 'pre' | 'post',
  say: (line: string) => void,
): Promise<HookResult> {
  const files: Record<string, string> = {};
  for (const hook of hooks) {
    if (!hook?.cmd?.trim()) continue;
    let target: string;
    try {
      target = resolveTarget(inspection, hook);
    } catch (err) {
      if (phase === 'pre') throw err;
      say(`WARNING: skipping post-hook — ${msg(err)}`);
      continue;
    }

    say(`Running ${phase}-hook in ${target}: ${hook.cmd}`);
    const res = await runSsh(ssh, `docker exec ${q(target)} sh -c ${q(hook.cmd)}`, undefined, 60 * 60 * 1000);

    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim().split('\n').slice(-5).join('\n');
      const message = `${phase}-hook in ${target} exited ${res.code}: ${detail || 'no output'}`;
      if (phase === 'pre') throw new Error(message);
      say(`WARNING: ${message}`);
      continue;
    }

    if (hook.captureTo) {
      if (!/^[A-Za-z0-9._-]+$/.test(hook.captureTo)) {
        throw new Error(`Hook captureTo must be a plain filename, got "${hook.captureTo}".`);
      }
      if (Buffer.byteLength(res.stdout) > MAX_CAPTURE_BYTES) {
        throw new Error(
          `The output of the hook writing "${hook.captureTo}" is over ${MAX_CAPTURE_BYTES / 1024 / 1024} MB. ` +
          'Redirect a dump that size into a path inside a captured volume instead of capturing stdout.',
        );
      }
      files[hook.captureTo] = res.stdout;
      say(`Captured ${Buffer.byteLength(res.stdout)} bytes into ${hook.captureTo}.`);
    } else if (res.stdout.trim()) {
      say(res.stdout.trim().split('\n').slice(-5).join('\n'));
    }
  }
  return { files };
}

/** Single-quote a value for /bin/sh. */
function q(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
