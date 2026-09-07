import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SecretsService } from '../../secrets/secrets.service';
import { runSsh, type SshConfig } from './docker-ssh';
import type { GitCredential } from '@cerebro/shared';

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
  /** `--build` — (re)build images from the repo's Dockerfiles as part of up. */
  build?: boolean;
  /** `compose build --no-cache --pull` then recreate — force a full rebuild of locally-built images. */
  forceRebuild?: boolean;
}

/** Git source for a stack. */
export interface StackGitSource {
  gitUrl: string;
  gitRef?: string | null;
  gitPath?: string | null;
  /** Vault secret key (kind='git') to authenticate a private repo; null = public. */
  credKey?: string | null;
  env?: string;
}

/**
 * Cerebro-managed compose stacks (Docker connector Phase 5). Cerebro is the
 * versioned store for each stack's compose file; deploys run the host's own
 * `docker compose` over SSH — no agent image, full compose fidelity. See
 * docs/connectors/docker.md.
 */
@Injectable()
export class DockerStackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
  ) {}

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
    const data = { compose, env: env || null, source: 'compose', gitUrl: null, gitRef: null, gitPath: null, gitCredKey: null };
    return this.prisma.dockerStack.upsert({
      where: { connectorInstanceId_name: { connectorInstanceId: instanceId, name: project } },
      update: data,
      create: { connectorInstanceId: instanceId, name: project, ...data },
    });
  }

  private saveGit(instanceId: string, name: string, src: StackGitSource) {
    const project = projectName(name);
    const data = {
      source: 'git', compose: '', env: src.env || null,
      gitUrl: src.gitUrl, gitRef: src.gitRef || null, gitPath: src.gitPath || null, gitCredKey: src.credKey || null,
    };
    return this.prisma.dockerStack.upsert({
      where: { connectorInstanceId_name: { connectorInstanceId: instanceId, name: project } },
      update: data,
      create: { connectorInstanceId: instanceId, name: project, ...data },
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

      // 3) optional forced rebuild of locally-built images, then docker compose up -d [flags]
      if (opts.forceRebuild) {
        const b = await runSsh(target.ssh, `docker compose -p '${project}' -f '${file}' build --no-cache --pull`);
        if (b.code !== 0) {
          const detail = tail(b.stderr || b.stdout, 3000);
          await this.record(instanceId, project, 'error', detail);
          return { ok: false, message: `Image rebuild failed: ${detail}` };
        }
      }
      const flags = composeUpFlags(opts);
      const up = await runSsh(target.ssh, `docker compose -p '${project}' -f '${file}' up -d ${flags}`.trim());
      const out = tail(up.stderr || up.stdout, 4000);
      if (up.code !== 0) {
        await this.record(instanceId, project, 'error', out);
        return { ok: false, message: out || `docker compose exited ${up.code}.` };
      }
      await this.record(instanceId, project, 'success', out);
      await this.recordRevision(instanceId, project, { compose, env, source: 'compose' });
      return { ok: true, message: `Deployed "${project}".${out ? `\n${out}` : ''}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Deploy failed.';
      await this.record(instanceId, project, 'error', message);
      return { ok: false, message };
    }
  }

  /**
   * Deploy a stack from a Git repository: clone/pull on the host (private repos
   * authenticate with a vault Git credential fed via a temp git-credential file,
   * removed after), then `docker compose` from the repo — with build / force-rebuild
   * options for repos that build their own images. Stores the git source + commit.
   */
  async deployGit(
    target: StackDeployTarget,
    instanceId: string,
    name: string,
    src: StackGitSource,
    opts: StackDeployOpts = {},
  ): Promise<StackRunResult> {
    const project = projectName(name);
    if (!project) return { ok: false, message: 'A valid stack name is required.' };
    if (!src.gitUrl?.trim()) return { ok: false, message: 'A git repository URL is required.' };

    const base = `${trimSlash(target.stacksDir)}/${project}`;
    const dir = `${base}/repo`;
    const relCompose = (src.gitPath?.trim() || 'docker-compose.yml').replace(/^\/+/, '');
    const composeFile = `${dir}/${relCompose}`;
    const composeDir = composeFile.replace(/\/[^/]*$/, '') || dir;
    const credFile = `${base}/.gitcred`;
    const ref = src.gitRef?.trim();

    // Resolve the vault Git credential (kind='git' JSON), if any.
    let cred: GitCredential | null = null;
    if (src.credKey) {
      const raw = await this.secrets.reveal(src.credKey).catch(() => null);
      if (raw) { try { cred = JSON.parse(raw) as GitCredential; } catch { cred = { secret: raw }; } }
    }
    const helper = cred ? `-c credential.helper='store --file=${credFile}'` : '';

    await this.saveGit(instanceId, name, src);
    try {
      await runSsh(target.ssh, `mkdir -p '${base}'`);
      // Write the credential file over stdin so the token never appears in a command line.
      if (cred?.secret) {
        const host = cred.host?.trim() || hostFromUrl(src.gitUrl);
        const line = `https://${encodeURIComponent(cred.username || 'x-access-token')}:${encodeURIComponent(cred.secret)}@${host}\n`;
        const w = await runSsh(target.ssh, `cat > '${credFile}' && chmod 600 '${credFile}'`, line);
        if (w.code !== 0) throw new Error('Failed to write git credentials on the host.');
      }

      // Clone (first time) or fetch + hard-reset to the ref.
      const isRepo = (await runSsh(target.ssh, `test -d '${dir}/.git' && echo yes || echo no`)).stdout.trim() === 'yes';
      const g = isRepo
        ? await runSsh(target.ssh, `git -C '${dir}' ${helper} fetch --all --prune && git -C '${dir}' checkout ${ref ? `'${sq(ref)}'` : 'HEAD'} && git -C '${dir}' ${helper} reset --hard ${ref ? `'origin/${sq(ref)}'` : '@{u}'} 2>/dev/null || git -C '${dir}' ${helper} pull --ff-only`)
        : await runSsh(target.ssh, `rm -rf '${dir}' && git ${helper} clone ${ref ? `--branch '${sq(ref)}'` : ''} '${sq(src.gitUrl)}' '${dir}'`);
      if (g.code !== 0) {
        const detail = redact(tail(g.stderr || g.stdout, 2000), cred);
        await this.record(instanceId, project, 'error', detail);
        return { ok: false, message: `Git ${isRepo ? 'update' : 'clone'} failed: ${detail}` };
      }

      // Write the .env beside the compose (only if provided).
      if (src.env != null && src.env !== '') {
        const we = await runSsh(target.ssh, `mkdir -p '${composeDir}' && cat > '${composeDir}/.env'`, src.env);
        if (we.code !== 0) throw new Error('Failed to write the .env file on the host.');
      }

      // Validate, then optional force-rebuild, then up.
      const cfg = await runSsh(target.ssh, `docker compose -p '${project}' -f '${composeFile}' config -q`);
      if (cfg.code !== 0) {
        const detail = tail(cfg.stderr || cfg.stdout, 2000);
        await this.record(instanceId, project, 'error', detail);
        return { ok: false, message: `Compose validation failed: ${detail}` };
      }
      if (opts.forceRebuild) {
        const b = await runSsh(target.ssh, `docker compose -p '${project}' -f '${composeFile}' build --no-cache --pull`);
        if (b.code !== 0) {
          const detail = tail(b.stderr || b.stdout, 3000);
          await this.record(instanceId, project, 'error', detail);
          return { ok: false, message: `Image rebuild failed: ${detail}` };
        }
      }
      const up = await runSsh(target.ssh, `docker compose -p '${project}' -f '${composeFile}' up -d ${composeUpFlags(opts)}`.trim());
      const out = tail(up.stderr || up.stdout, 4000);
      if (up.code !== 0) {
        await this.record(instanceId, project, 'error', out);
        return { ok: false, message: out || `docker compose exited ${up.code}.` };
      }

      const commit = (await runSsh(target.ssh, `git -C '${dir}' rev-parse HEAD`).catch(() => null))?.stdout.trim() || null;
      await this.record(instanceId, project, 'success', out);
      await this.recordRevision(instanceId, project, {
        compose: '', env: src.env ?? '', source: 'git',
        gitUrl: src.gitUrl, gitRef: src.gitRef ?? null, gitPath: src.gitPath ?? null, commit,
      });
      return { ok: true, message: `Deployed "${project}" from git${commit ? ` @ ${commit.slice(0, 7)}` : ''}.${out ? `\n${out}` : ''}` };
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : 'Git deploy failed.', cred);
      await this.record(instanceId, project, 'error', message);
      return { ok: false, message };
    } finally {
      // Never leave credentials on disk.
      await runSsh(target.ssh, `rm -f '${credFile}'`).catch(() => { /* best-effort */ });
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

    const file = await this.composeFileFor(target, instanceId, name);
    const lines: string[] = [];
    let drift = false;

    try {
      // 1) Source drift.
      if (stored.source === 'git') {
        // Git stacks: compare the deployed commit to the remote tip of the ref.
        const dir = `${trimSlash(target.stacksDir)}/${project}/repo`;
        const ref = stored.gitRef?.trim();
        const local = (await runSsh(target.ssh, `git -C '${dir}' rev-parse HEAD 2>/dev/null || true`)).stdout.trim();
        const remote = (await runSsh(target.ssh, `git -C '${dir}' ls-remote origin ${ref ? `'${ref}'` : 'HEAD'} 2>/dev/null | awk '{print $1}' | head -1`)).stdout.trim();
        if (local && remote && local !== remote) { lines.push(`⚠ Repo has moved: deployed ${local.slice(0, 7)}, ${ref || 'HEAD'} is now ${remote.slice(0, 7)}. Redeploy to update.`); drift = true; }
        else if (local) lines.push(`✓ On the latest commit for ${ref || 'the default branch'} (${local.slice(0, 7)}).`);
        else lines.push('⚠ No git checkout found on the host.');
      } else {
        // Compose stacks: the compose on the host vs. the version Cerebro deployed.
        const read = await runSsh(target.ssh, `cat '${file}' 2>/dev/null || true`);
        const hostFile = read.stdout;
        if (!hostFile.trim()) {
          lines.push(`⚠ No compose file found on the host at ${file}.`); drift = true;
        } else if (normalizeCompose(hostFile) !== normalizeCompose(stored.compose)) {
          lines.push('⚠ The compose file on the host DIFFERS from the version Cerebro stored (edited out of band?).'); drift = true;
        } else {
          lines.push("✓ Compose file on the host matches Cerebro's stored version.");
        }
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

  /** The host path to a stored stack's compose file (repo path for git stacks). */
  private async composeFileFor(target: StackDeployTarget, instanceId: string, name: string): Promise<string> {
    const project = projectName(name);
    const base = `${trimSlash(target.stacksDir)}/${project}`;
    const stored = await this.get(instanceId, name).catch(() => null);
    if (stored?.source === 'git') return `${base}/repo/${(stored.gitPath?.trim() || 'docker-compose.yml').replace(/^\/+/, '')}`;
    return `${base}/docker-compose.yml`;
  }

  /** `docker compose down` for a stored stack. */
  async down(target: StackDeployTarget, instanceId: string, name: string): Promise<StackRunResult> {
    const project = projectName(name);
    const file = await this.composeFileFor(target, instanceId, name);
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
  private async recordRevision(
    instanceId: string,
    project: string,
    rev: { compose: string; env: string; source: string; gitUrl?: string | null; gitRef?: string | null; gitPath?: string | null; commit?: string | null },
  ): Promise<void> {
    try {
      await this.prisma.dockerStackRevision.create({
        data: {
          connectorInstanceId: instanceId, name: project,
          compose: rev.compose, env: rev.env || null,
          source: rev.source, gitUrl: rev.gitUrl ?? null, gitRef: rev.gitRef ?? null, gitPath: rev.gitPath ?? null, commit: rev.commit ?? null,
        },
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

/** `docker compose up` flags from the deploy options (shared by compose + git deploys). */
function composeUpFlags(opts: StackDeployOpts): string {
  return [
    opts.pull ? '--pull always' : '',
    (opts.build || opts.forceRebuild) ? '--build' : '',
    (opts.forceRecreate || opts.forceRebuild) ? '--force-recreate' : '',
    opts.removeOrphans ? '--remove-orphans' : '',
  ].filter(Boolean).join(' ');
}

/** Escape a string for safe embedding inside single quotes in a shell command. */
function sq(s: string): string {
  return (s || '').replace(/'/g, `'\\''`);
}

/** Hostname from a git URL, for the credential-store line. */
function hostFromUrl(url: string): string {
  try { return new URL(url).host; } catch { return (url.match(/^https?:\/\/([^/]+)/i)?.[1]) ?? ''; }
}

/** Strip a credential's secret out of any host output before it's stored/shown. */
function redact(text: string, cred: GitCredential | null): string {
  if (!cred?.secret) return text;
  return (text || '').split(cred.secret).join('***');
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
