import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { runSsh, type SshConfig } from './docker-ssh';

export interface StackDeployTarget {
  ssh: SshConfig;
  /** Base directory on the host where per-stack compose files live. */
  stacksDir: string;
}

export interface StackRunResult {
  ok: boolean;
  message: string;
}

/** `docker compose up` options exposed on redeploy (mirror Portainer's toggles). */
export interface StackDeployOpts {
  /** `--pull always` — fetch newer images. */
  pull?: boolean;
  /** `--force-recreate` — recreate containers even if config is unchanged. */
  forceRecreate?: boolean;
  /** `--remove-orphans` — remove containers for services no longer in the compose. */
  removeOrphans?: boolean;
}

/**
 * Cerebro-managed compose stacks (Docker connector Phase 5). Cerebro is the
 * versioned store for each stack's compose file; deploys run the host's own
 * `docker compose` over SSH — no agent image, full compose fidelity. See
 * docs/connectors/docker.md.
 */
@Injectable()
export class DockerStackService {
  constructor(private readonly prisma: PrismaService) {}

  list(instanceId: string) {
    return this.prisma.dockerStack.findMany({
      where: { connectorInstanceId: instanceId },
      orderBy: { name: 'asc' },
    });
  }

  get(instanceId: string, name: string) {
    return this.prisma.dockerStack.findUnique({
      where: { connectorInstanceId_name: { connectorInstanceId: instanceId, name: projectName(name) } },
    });
  }

  private saveCompose(instanceId: string, name: string, compose: string, env: string) {
    const project = projectName(name);
    return this.prisma.dockerStack.upsert({
      where: { connectorInstanceId_name: { connectorInstanceId: instanceId, name: project } },
      update: { compose, env: env || null },
      create: { connectorInstanceId: instanceId, name: project, compose, env: env || null },
    });
  }

  async remove(instanceId: string, name: string): Promise<void> {
    await this.prisma.dockerStack.deleteMany({
      where: { connectorInstanceId: instanceId, name: projectName(name) },
    });
  }

  /**
   * Write the compose (+ optional `.env`) to the host, validate it, then
   * `docker compose up -d`. Stores compose/env so it can be edited/redeployed,
   * and records the outcome.
   */
  async deploy(
    target: StackDeployTarget,
    instanceId: string,
    name: string,
    compose: string,
    env = '',
    opts: StackDeployOpts = {},
  ): Promise<StackRunResult> {
    const project = projectName(name);
    if (!project) return { ok: false, message: 'A valid stack name is required.' };
    if (!compose.trim()) return { ok: false, message: 'The compose file is empty.' };

    await this.saveCompose(instanceId, name, compose, env);
    const dir = `${trimSlash(target.stacksDir)}/${project}`;
    const file = `${dir}/docker-compose.yml`;
    const envFile = `${dir}/.env`;

    try {
      // 1) write the compose + .env (stdin → cat, so no shell-escaping of contents).
      //    Always write .env (even empty) so stale variables don't linger.
      const w1 = await runSsh(target.ssh, `mkdir -p '${dir}' && cat > '${file}'`, compose);
      if (w1.code !== 0) throw new Error(w1.stderr.trim() || 'Failed to write the compose file on the host.');
      const w2 = await runSsh(target.ssh, `cat > '${envFile}'`, env);
      if (w2.code !== 0) throw new Error(w2.stderr.trim() || 'Failed to write the .env file on the host.');

      // 2) validate before applying, so a YAML/compose error fails cleanly.
      const cfg = await runSsh(target.ssh, `docker compose -p '${project}' -f '${file}' config -q`);
      if (cfg.code !== 0) {
        const detail = tail(cfg.stderr || cfg.stdout, 2000);
        await this.record(instanceId, project, 'error', detail);
        return { ok: false, message: `Compose validation failed: ${detail}` };
      }

      // 3) docker compose up -d [flags]
      const flags = [
        opts.pull ? '--pull always' : '',
        opts.forceRecreate ? '--force-recreate' : '',
        opts.removeOrphans ? '--remove-orphans' : '',
      ].filter(Boolean).join(' ');
      const up = await runSsh(target.ssh, `docker compose -p '${project}' -f '${file}' up -d ${flags}`.trim());
      const out = tail(up.stderr || up.stdout, 4000);
      if (up.code !== 0) {
        await this.record(instanceId, project, 'error', out);
        return { ok: false, message: out || `docker compose exited ${up.code}.` };
      }
      await this.record(instanceId, project, 'success', out);
      await this.recordRevision(instanceId, project, compose, env);
      return { ok: true, message: `Deployed "${project}".${out ? `\n${out}` : ''}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Deploy failed.';
      await this.record(instanceId, project, 'error', message);
      return { ok: false, message };
    }
  }

  /**
   * Compare a managed stack against reality: does the compose file on the host
   * still match what Cerebro stored, and are all expected services present and
   * running? Returns a human-readable report. Read-only — runs nothing that
   * changes state.
   */
  async checkDrift(target: StackDeployTarget, instanceId: string, name: string): Promise<StackRunResult> {
    const project = projectName(name);
    const stored = await this.get(instanceId, name);
    if (!stored) return { ok: false, message: "This stack isn't managed by Cerebro — no stored compose to compare against." };

    const file = `${trimSlash(target.stacksDir)}/${project}/docker-compose.yml`;
    const lines: string[] = [];
    let drift = false;

    try {
      // 1) File drift — the compose on the host vs. the version Cerebro deployed.
      const read = await runSsh(target.ssh, `cat '${file}' 2>/dev/null || true`);
      const hostFile = read.stdout;
      if (!hostFile.trim()) {
        lines.push(`⚠ No compose file found on the host at ${file}.`); drift = true;
      } else if (normalizeCompose(hostFile) !== normalizeCompose(stored.compose)) {
        lines.push('⚠ The compose file on the host DIFFERS from the version Cerebro stored (edited out of band?).'); drift = true;
      } else {
        lines.push("✓ Compose file on the host matches Cerebro's stored version.");
      }

      // 2) Runtime drift — expected services vs. what's actually up.
      const [svc, ps] = await Promise.all([
        runSsh(target.ssh, `docker compose -p '${project}' -f '${file}' config --services 2>/dev/null || true`),
        runSsh(target.ssh, `docker compose -p '${project}' -f '${file}' ps -a --format json 2>/dev/null || true`),
      ]);
      const expected = svc.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const running = parseComposePs(ps.stdout);
      const stateByService = new Map(running.map((r) => [r.Service, r.State]));
      if (expected.length) {
        const missing = expected.filter((s) => !stateByService.has(s));
        const notRunning = expected.filter((s) => stateByService.has(s) && stateByService.get(s) !== 'running');
        const extra = running.filter((r) => r.Service && !expected.includes(r.Service)).map((r) => r.Service);
        lines.push(`Services: ${expected.length} expected, ${stateByService.size} present.`);
        if (missing.length) { lines.push(`⚠ Missing (no container): ${missing.join(', ')}`); drift = true; }
        if (notRunning.length) { lines.push(`⚠ Not running: ${notRunning.map((s) => `${s} (${stateByService.get(s)})`).join(', ')}`); drift = true; }
        if (extra.length) { lines.push(`⚠ Orphan containers not in the compose: ${[...new Set(extra)].join(', ')}`); drift = true; }
        if (!missing.length && !notRunning.length && !extra.length) lines.push('✓ All expected services are present and running.');
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Drift check failed.' };
    }

    return { ok: true, message: `${drift ? 'DRIFT DETECTED' : 'IN SYNC'}\n\n${lines.join('\n')}` };
  }

  /** `docker compose down` for a stored stack. */
  async down(target: StackDeployTarget, instanceId: string, name: string): Promise<StackRunResult> {
    const project = projectName(name);
    const file = `${trimSlash(target.stacksDir)}/${project}/docker-compose.yml`;
    try {
      const res = await runSsh(target.ssh, `docker compose -p '${project}' -f '${file}' down`);
      const out = tail(res.stderr || res.stdout);
      if (res.code !== 0) return { ok: false, message: out || `docker compose down exited ${res.code}.` };
      await this.record(instanceId, project, 'stopped', out);
      return { ok: true, message: `Stopped "${project}".` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Stop failed.' };
    }
  }

  /** How many past versions to keep per stack. */
  private static readonly MAX_REVISIONS = 10;

  /** Snapshot a deployed version and prune old ones. Best-effort. */
  private async recordRevision(instanceId: string, project: string, compose: string, env: string): Promise<void> {
    try {
      await this.prisma.dockerStackRevision.create({
        data: { connectorInstanceId: instanceId, name: project, compose, env: env || null },
      });
      const old = await this.prisma.dockerStackRevision.findMany({
        where: { connectorInstanceId: instanceId, name: project },
        orderBy: { createdAt: 'desc' },
        skip: DockerStackService.MAX_REVISIONS,
        select: { id: true },
      });
      if (old.length) {
        await this.prisma.dockerStackRevision.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
      }
    } catch {
      /* history is best-effort */
    }
  }

  /** Recent revisions of a stack (newest first) — for the detail view's history. */
  listRevisions(instanceId: string, name: string) {
    return this.prisma.dockerStackRevision.findMany({
      where: { connectorInstanceId: instanceId, name: projectName(name) },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
  }

  /** The version deployed before the current one (for one-step rollback), or null. */
  async previousRevision(instanceId: string, name: string) {
    const recent = await this.prisma.dockerStackRevision.findMany({
      where: { connectorInstanceId: instanceId, name: projectName(name) },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    return recent[1] ?? null;
  }

  /** Revision count per stack for this connector (for the "N versions" hint). */
  async revisionCounts(instanceId: string): Promise<Record<string, number>> {
    const rows = await this.prisma.dockerStackRevision.groupBy({
      by: ['name'],
      where: { connectorInstanceId: instanceId },
      _count: { _all: true },
    });
    return Object.fromEntries(rows.map((r) => [r.name, r._count._all]));
  }

  private record(instanceId: string, project: string, status: string, message: string) {
    return this.prisma.dockerStack
      .updateMany({
        where: { connectorInstanceId: instanceId, name: project },
        data: { lastStatus: status, lastMessage: message.slice(0, 500) || null, lastDeployedAt: new Date() },
      })
      .catch(() => { /* best-effort status */ });
  }
}

/** Compose project names must be lowercase [a-z0-9][a-z0-9_-]*. Sanitize + clamp. */
export function projectName(name: string): string {
  const s = (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 63);
  return s;
}

function trimSlash(p: string): string {
  return (p || '/opt/cerebro-stacks').replace(/\/+$/, '');
}

/** Normalize compose text for a stable comparison: strip trailing spaces + blank-line noise. */
function normalizeCompose(s: string): string {
  return (s || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Parse `docker compose ps --format json` — v2 emits either a JSON array or one object per line. */
function parseComposePs(out: string): { Service: string; State: string }[] {
  const text = (out || '').trim();
  if (!text) return [];
  const pick = (o: Record<string, unknown>) => ({ Service: String(o.Service ?? ''), State: String(o.State ?? '').toLowerCase() });
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(pick);
    return [pick(parsed)];
  } catch {
    // NDJSON: one JSON object per line.
    const rows: { Service: string; State: string }[] = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try { rows.push(pick(JSON.parse(t))); } catch { /* skip non-JSON noise */ }
    }
    return rows;
  }
}

function tail(s: string, max = 400): string {
  const t = (s || '').trim();
  return t.length > max ? '…' + t.slice(-max) : t;
}
