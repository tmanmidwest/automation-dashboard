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
      return { ok: true, message: `Deployed "${project}".${out ? `\n${out}` : ''}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Deploy failed.';
      await this.record(instanceId, project, 'error', message);
      return { ok: false, message };
    }
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

function tail(s: string, max = 400): string {
  const t = (s || '').trim();
  return t.length > max ? '…' + t.slice(-max) : t;
}
