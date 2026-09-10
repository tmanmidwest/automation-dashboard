import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService, type ActorCtx } from '../secrets/secrets.service';
import { AuditService } from '../logging/audit.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { DockerStackService, projectName } from '../connectors/docker/docker-stack.service';
import { dockerTargetFrom, type DockerTarget } from './docker-target';
import { PortAllocatorService } from './port-allocator.service';
import { IngressService } from './ingress.service';
import type {
  DeployInput, ReplicatorVariable, ReplicatorPort, ReplicatorDeployment, ReplicatorDeploymentStatus, DeployTargetInfo, PortSuggestion,
  ReplicatorIngress, ReplicatorIngressKind,
} from '@cerebro/shared';
import type { ReplicatorApp as AppRow, ReplicatorDeployment as DeploymentRow, ReplicatorIngress as IngressRow } from '@prisma/client';

/** The vault key holding one deployment's secret variable value. */
function secretKey(deploymentId: string, varName: string): string {
  return `deployment:${deploymentId}:${varName}`;
}

/** Lowercase a compose service/name fragment to something docker accepts. */
function slug(s: string): string {
  return (s || 'app').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+/, '').slice(0, 40) || 'app';
}

/**
 * Deploys, redeploys, and tears down App Replicator instances. The low-level
 * clone + `docker compose up` is the Docker connector's DockerStackService
 * (deployGit), so each deployment is also a managed stack (redeploy/rollback via
 * the connector). This service adds the catalog glue: compose-variable → env
 * assembly, per-instance isolation, vault-backed secrets with teardown cleanup,
 * and host port preflight. See docs/app-replicator.md.
 */
@Injectable()
export class DeploymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: ConnectorInstanceService,
    private readonly stacks: DockerStackService,
    private readonly secrets: SecretsService,
    private readonly audit: AuditService,
    private readonly ports: PortAllocatorService,
    private readonly ingress: IngressService,
  ) {}

  /** Build the SSH deploy target for a Docker connector instance (throws if not deployable). */
  private async targetFor(dockerInstanceId: string): Promise<DockerTarget> {
    const instance = await this.instances.get(dockerInstanceId).catch(() => null);
    if (!instance) throw new BadRequestException('The selected Docker connector no longer exists.');
    if (instance.connectorId !== 'docker') throw new BadRequestException('The selected target is not a Docker connector.');
    const ctx = await this.instances.contextFor(instance);
    const target = dockerTargetFrom(ctx);
    if (!target.deployable) {
      throw new BadRequestException('That Docker connector has no SSH configured — App Replicator deploys over SSH. Set the SSH host + credentials on the connector.');
    }
    return target;
  }

  /** Used ports + per-variable free-port suggestions for the deploy wizard. */
  async targetInfo(dockerInstanceId: string, variables: ReplicatorVariable[]): Promise<DeployTargetInfo> {
    const target = await this.targetFor(dockerInstanceId);
    const used = new Set(await this.ports.usedPorts(target.ssh));
    const taken = new Set<number>();
    const suggestions: PortSuggestion[] = variables
      .filter((v) => v.role === 'host_port')
      .map((v) => {
        const cport = v.containerPort ?? Number(v.default) ?? 8080;
        return { variable: v.name, service: v.service ?? 'app', containerPort: cport, suggested: this.ports.suggest(cport, used, taken) };
      });
    return { hostIp: target.hostIp, usedPorts: [...used].sort((a, b) => a - b), suggestions };
  }

  // ── Deploy ────────────────────────────────────────────────────────

  async deploy(appId: string, input: DeployInput, actor: ActorCtx): Promise<ReplicatorDeployment> {
    const app = await this.prisma.replicatorApp.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException('App not found.');
    if (app.usesGeneratedCompose) {
      throw new BadRequestException('This app has no committed docker-compose.yml (Cerebro generated a preview wrapper). Commit a compose file to deploy — Dockerfile-only deploys land in a follow-up.');
    }
    const variables = (app.variables as unknown as ReplicatorVariable[]) ?? [];
    const project = projectName(input.name);
    if (!project) throw new BadRequestException('A valid deployment name is required.');

    const target = await this.targetFor(input.dockerInstanceId);

    // Name must be unique per host.
    const clash = await this.prisma.replicatorDeployment.findFirst({ where: { dockerInstanceId: input.dockerInstanceId, project } });
    if (clash) throw new BadRequestException(`A deployment named "${project}" already exists on that host.`);

    // Resolve + preflight ports before creating anything.
    const portList = this.resolvePorts(variables, input.ports);
    await this.preflightPorts(target, portList);

    // Validate required non-managed values are supplied (or have a repo default).
    const missing = variables
      .filter((v) => v.required && v.role !== 'host_port' && v.role !== 'image_tag' && v.role !== 'container_name')
      .filter((v) => {
        const provided = v.secret ? input.secrets[v.name] : input.values[v.name];
        return (provided == null || provided === '') && (v.default == null);
      })
      .map((v) => v.name);
    if (missing.length) throw new BadRequestException(`Missing required value(s): ${missing.join(', ')}.`);

    // Persist the row first so secret vault keys can be namespaced by its id.
    const nonSecretValues: Record<string, string> = {};
    for (const v of variables) {
      if (v.role === 'plain' && input.values[v.name] != null && input.values[v.name] !== '') nonSecretValues[v.name] = String(input.values[v.name]);
    }
    const secretVars = variables.filter((v) => v.secret && input.secrets[v.name] != null && input.secrets[v.name] !== '').map((v) => v.name);

    const row = await this.prisma.replicatorDeployment.create({
      data: {
        appId: app.id,
        dockerInstanceId: input.dockerInstanceId,
        name: input.name.trim(),
        project,
        values: nonSecretValues,
        secretVars,
        ports: portList as unknown as object,
        status: 'pending',
      },
    });

    // Store secret values in the vault (encrypted), namespaced to this deployment.
    for (const name of secretVars) {
      await this.secrets.set(secretKey(row.id, name), String(input.secrets[name]), {
        label: `Replicator · ${project} · ${name}`,
      }, actor);
    }

    // Assemble the .env and deploy.
    const env = this.buildEnv(app, variables, project, portList, nonSecretValues, input.secrets);
    const result = await this.stacks.deployGit(
      target,
      input.dockerInstanceId,
      project,
      { gitUrl: app.gitUrl, gitRef: app.gitRef, gitPath: app.gitPath, credKey: app.gitCredKey, env },
      { pull: true, forceRebuild: !!input.forceRebuild },
    );

    const commit = await this.latestCommit(input.dockerInstanceId, project);
    const updated = await this.prisma.replicatorDeployment.update({
      where: { id: row.id },
      data: { status: result.ok ? 'deployed' : 'error', lastMessage: result.message.slice(0, 1000), deployedCommit: commit },
    });
    await this.audit.record({ ...actor, action: result.ok ? 'replicator.deploy' : 'replicator.deploy_failed', target: `${app.name}/${project}`, meta: { appId: app.id, dockerInstanceId: input.dockerInstanceId, ok: result.ok } });
    return this.map(updated, app.name);
  }

  // ── Redeploy (pull latest / rebuild) ───────────────────────────────

  async redeploy(id: string, opts: { forceRebuild?: boolean }, actor: ActorCtx): Promise<ReplicatorDeployment> {
    const { row, app } = await this.load(id);
    const target = await this.targetFor(row.dockerInstanceId);
    const variables = (app.variables as unknown as ReplicatorVariable[]) ?? [];
    const portList = (row.ports as unknown as ReplicatorPort[]) ?? [];
    const nonSecretValues = (row.values as unknown as Record<string, string>) ?? {};

    // Reveal stored secrets back into the env map.
    const secrets: Record<string, string> = {};
    for (const name of row.secretVars) {
      const v = await this.secrets.reveal(secretKey(row.id, name)).catch(() => null);
      if (v != null) secrets[name] = v;
    }

    await this.prisma.replicatorDeployment.update({ where: { id: row.id }, data: { status: 'updating' } });
    const env = this.buildEnv(app, variables, row.project, portList, nonSecretValues, secrets);
    const result = await this.stacks.deployGit(
      target,
      row.dockerInstanceId,
      row.project,
      { gitUrl: app.gitUrl, gitRef: app.gitRef, gitPath: app.gitPath, credKey: app.gitCredKey, env },
      { pull: true, forceRebuild: !!opts.forceRebuild },
    );
    const commit = await this.latestCommit(row.dockerInstanceId, row.project);
    const updated = await this.prisma.replicatorDeployment.update({
      where: { id: row.id },
      data: {
        status: result.ok ? 'deployed' : 'error', lastMessage: result.message.slice(0, 1000), deployedCommit: commit,
        // A successful redeploy pulls latest, so clear any pending "update available".
        ...(result.ok ? { updateAvailable: false, availableCommit: null } : {}),
      },
    });
    await this.audit.record({ ...actor, action: result.ok ? 'replicator.redeploy' : 'replicator.redeploy_failed', target: `${app.name}/${row.project}`, meta: { ok: result.ok } });
    return this.map(updated, app.name);
  }

  // ── Teardown (stack down + vault cleanup) ──────────────────────────

  async remove(id: string, actor: ActorCtx): Promise<{ ok: boolean; message: string }> {
    const { row, app } = await this.load(id);
    const problems: string[] = [];

    // Tear down any ingress routes first (CF tunnel routes / NPM proxy hosts),
    // so we don't leave dangling public hostnames pointing at a dead port.
    problems.push(...await this.ingress.removeAllForDeployment(row.id));

    // Best-effort: stop the stack and remove its host dir + managed-stack record.
    try {
      const target = await this.targetFor(row.dockerInstanceId);
      const down = await this.stacks.down(target, row.dockerInstanceId, row.project);
      if (!down.ok) problems.push(down.message);
      await this.stacks.purgeDir(target, row.project);
      await this.stacks.remove(row.dockerInstanceId, row.project);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : 'Could not reach the host to stop the stack.');
    }

    // Always clean up the vault secrets and the row, so nothing is left stale.
    for (const name of row.secretVars) {
      await this.secrets.remove(secretKey(row.id, name), actor).catch(() => {});
    }
    await this.prisma.replicatorDeployment.delete({ where: { id: row.id } });
    await this.audit.record({ ...actor, action: 'replicator.remove', target: `${app.name}/${row.project}`, meta: { problems } });

    return problems.length
      ? { ok: true, message: `Removed the deployment and its secrets. The host stopped with warnings: ${problems.join('; ')}` }
      : { ok: true, message: `Removed "${row.project}" and cleaned up its secrets.` };
  }

  // ── Listing ────────────────────────────────────────────────────────

  async listForApp(appId: string): Promise<ReplicatorDeployment[]> {
    const [app, rows] = await Promise.all([
      this.prisma.replicatorApp.findUnique({ where: { id: appId } }),
      this.prisma.replicatorDeployment.findMany({ where: { appId }, orderBy: { createdAt: 'desc' }, include: { ingress: true } }),
    ]);
    const names = await this.instanceNames();
    return rows.map((r) => this.map(r, app?.name, names.get(r.dockerInstanceId), this.mapIngress(r.ingress, names)));
  }

  async listAll(): Promise<ReplicatorDeployment[]> {
    const [apps, rows, names] = await Promise.all([
      this.prisma.replicatorApp.findMany(),
      this.prisma.replicatorDeployment.findMany({ orderBy: { createdAt: 'desc' }, include: { ingress: true } }),
      this.instanceNames(),
    ]);
    const appName = new Map(apps.map((a) => [a.id, a.name]));
    return rows.map((r) => this.map(r, appName.get(r.appId), names.get(r.dockerInstanceId), this.mapIngress(r.ingress, names)));
  }

  private mapIngress(rows: IngressRow[] | undefined, names: Map<string, string>): ReplicatorIngress[] {
    return (rows ?? []).map((r) => ({
      id: r.id, deploymentId: r.deploymentId, kind: r.kind as ReplicatorIngressKind,
      instanceId: r.instanceId, instanceName: names.get(r.instanceId),
      service: r.service, hostPort: r.hostPort, hostname: r.hostname, ref: r.ref,
      url: `https://${r.hostname}`, createdAt: r.createdAt.toISOString(),
    }));
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private async load(id: string): Promise<{ row: DeploymentRow; app: AppRow }> {
    const row = await this.prisma.replicatorDeployment.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Deployment not found.');
    const app = await this.prisma.replicatorApp.findUnique({ where: { id: row.appId } });
    if (!app) throw new NotFoundException('The deployment’s app no longer exists.');
    return { row, app };
  }

  private async instanceNames(): Promise<Map<string, string>> {
    const list = await this.instances.list().catch(() => []);
    return new Map(list.map((i) => [i.id, i.name]));
  }

  private resolvePorts(variables: ReplicatorVariable[], chosen: Record<string, number>): ReplicatorPort[] {
    return variables
      .filter((v) => v.role === 'host_port')
      .map((v) => {
        const cport = v.containerPort ?? Number(v.default) ?? 8080;
        const hostPort = Number(chosen[v.name] ?? v.default ?? cport);
        if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
          throw new BadRequestException(`Invalid host port for ${v.name}.`);
        }
        return { service: v.service ?? 'app', variable: v.name, hostPort, containerPort: cport };
      });
  }

  private async preflightPorts(target: DockerTarget, portList: ReplicatorPort[]): Promise<void> {
    const used = new Set(await this.ports.usedPorts(target.ssh));
    const seen = new Set<number>();
    const conflicts: string[] = [];
    for (const p of portList) {
      if (seen.has(p.hostPort)) conflicts.push(`${p.hostPort} (assigned twice in this deployment)`);
      else if (used.has(p.hostPort)) conflicts.push(`${p.hostPort} (already in use on the host)`);
      seen.add(p.hostPort);
    }
    if (conflicts.length) throw new BadRequestException(`Port conflict: ${conflicts.join(', ')}. Pick different host ports.`);
  }

  /** Assemble the `.env` handed to `docker compose` — managed isolation vars + host ports + user values + secrets. */
  private buildEnv(
    app: AppRow,
    variables: ReplicatorVariable[],
    project: string,
    portList: ReplicatorPort[],
    values: Record<string, string>,
    secrets: Record<string, string>,
  ): string {
    void app;
    const env = new Map<string, string>();
    const portByVar = new Map(portList.map((p) => [p.variable, p.hostPort]));

    for (const v of variables) {
      const svc = slug(v.service ?? 'app');
      if (v.role === 'image_tag') env.set(v.name, `${project}-${svc}:latest`);
      else if (v.role === 'container_name') env.set(v.name, `${project}-${svc}`);
      else if (v.role === 'host_port') { const p = portByVar.get(v.name); if (p != null) env.set(v.name, String(p)); }
      else if (v.role === 'secret') { const s = secrets[v.name]; if (s != null && s !== '') env.set(v.name, s); }
      else if (v.role === 'plain') { const val = values[v.name]; if (val != null && val !== '') env.set(v.name, String(val)); }
    }
    // dotenv lines; drop any newline in a value (single-line format).
    return [...env.entries()].map(([k, val]) => `${k}=${String(val).replace(/[\r\n]+/g, ' ')}`).join('\n') + '\n';
  }

  private async latestCommit(instanceId: string, project: string): Promise<string | null> {
    const rev = await this.prisma.dockerStackRevision.findFirst({
      where: { connectorInstanceId: instanceId, name: project },
      orderBy: { createdAt: 'desc' },
      select: { commit: true },
    }).catch(() => null);
    return rev?.commit ?? null;
  }

  private map(row: DeploymentRow, appName?: string, instanceName?: string, ingress?: ReplicatorIngress[]): ReplicatorDeployment {
    return {
      id: row.id,
      appId: row.appId,
      appName,
      name: row.name,
      project: row.project,
      dockerInstanceId: row.dockerInstanceId,
      dockerInstanceName: instanceName,
      values: (row.values as unknown as Record<string, string>) ?? {},
      secretVars: row.secretVars ?? [],
      ports: (row.ports as unknown as ReplicatorPort[]) ?? [],
      status: row.status as ReplicatorDeploymentStatus,
      lastMessage: row.lastMessage,
      deployedCommit: row.deployedCommit,
      updateAvailable: row.updateAvailable,
      availableCommit: row.availableCommit,
      ingress: ingress ?? [],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
