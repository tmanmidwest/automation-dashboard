import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { RepoIntrospectService } from './repo-introspect.service';
import { dockerTargetFrom } from './docker-target';
import type {
  IntrospectRepoInput, IntrospectResult, RegisterAppInput, ReplicatorApp, ReplicatorVariable, ReplicatorTarget,
} from '@cerebro/shared';
import type { ReplicatorApp as AppRow } from '@prisma/client';

/**
 * The App Replicator catalog: register/edit/remove app templates, introspect a
 * repo's compose file, and enumerate deployable Docker targets. Deploying itself
 * lives in DeploymentService. See docs/app-replicator.md.
 */
@Injectable()
export class ReplicatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: ConnectorInstanceService,
    private readonly repo: RepoIntrospectService,
  ) {}

  introspect(input: IntrospectRepoInput): Promise<IntrospectResult> {
    return this.repo.introspect(input);
  }

  async listApps(): Promise<ReplicatorApp[]> {
    const [apps, counts] = await Promise.all([
      this.prisma.replicatorApp.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.replicatorDeployment.groupBy({ by: ['appId'], _count: { _all: true } }),
    ]);
    const countBy = new Map(counts.map((c) => [c.appId, c._count._all]));
    return apps.map((a) => this.map(a, countBy.get(a.id) ?? 0));
  }

  async getApp(id: string): Promise<ReplicatorApp> {
    const app = await this.prisma.replicatorApp.findUnique({ where: { id } });
    if (!app) throw new NotFoundException('App not found.');
    const count = await this.prisma.replicatorDeployment.count({ where: { appId: id } });
    return this.map(app, count);
  }

  async registerApp(input: RegisterAppInput): Promise<ReplicatorApp> {
    if (!input.name?.trim()) throw new BadRequestException('A name is required.');
    if (!input.gitUrl?.trim()) throw new BadRequestException('A git repository URL is required.');
    const variables = sanitizeVariables(input.variables);
    const app = await this.prisma.replicatorApp.create({
      data: {
        name: input.name.trim(),
        gitUrl: input.gitUrl.trim(),
        gitRef: input.gitRef?.trim() || 'main',
        gitPath: input.gitPath?.trim() || null,
        gitCredKey: input.gitCredKey || null,
        variables: variables as unknown as object,
        usesGeneratedCompose: !!input.usesGeneratedCompose,
      },
    });
    return this.map(app, 0);
  }

  async updateApp(id: string, patch: Partial<RegisterAppInput>): Promise<ReplicatorApp> {
    const existing = await this.prisma.replicatorApp.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('App not found.');
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = patch.name.trim();
    if (patch.gitUrl !== undefined) data.gitUrl = patch.gitUrl.trim();
    if (patch.gitRef !== undefined) data.gitRef = patch.gitRef.trim() || 'main';
    if (patch.gitPath !== undefined) data.gitPath = patch.gitPath?.trim() || null;
    if (patch.gitCredKey !== undefined) data.gitCredKey = patch.gitCredKey || null;
    if (patch.variables !== undefined) data.variables = sanitizeVariables(patch.variables) as unknown as object;
    if (patch.usesGeneratedCompose !== undefined) data.usesGeneratedCompose = !!patch.usesGeneratedCompose;
    const app = await this.prisma.replicatorApp.update({ where: { id }, data });
    const count = await this.prisma.replicatorDeployment.count({ where: { appId: id } });
    return this.map(app, count);
  }

  async removeApp(id: string): Promise<void> {
    const count = await this.prisma.replicatorDeployment.count({ where: { appId: id } });
    if (count > 0) throw new BadRequestException(`Remove this app's ${count} deployment(s) first.`);
    await this.prisma.replicatorApp.delete({ where: { id } });
  }

  /** Docker connector instances, flagged by whether they can accept a deploy (SSH configured). */
  async listTargets(): Promise<ReplicatorTarget[]> {
    const dockerInstances = (await this.instances.list()).filter((i) => i.connectorId === 'docker' && i.enabled);
    const out: ReplicatorTarget[] = [];
    for (const inst of dockerInstances) {
      try {
        const ctx = await this.instances.contextFor(inst);
        const t = dockerTargetFrom(ctx);
        out.push({ instanceId: inst.id, name: inst.name, hostIp: t.hostIp, deployable: t.deployable });
      } catch {
        out.push({ instanceId: inst.id, name: inst.name, hostIp: '', deployable: false });
      }
    }
    return out;
  }

  private map(row: AppRow, deploymentCount: number): ReplicatorApp {
    return {
      id: row.id,
      name: row.name,
      gitUrl: row.gitUrl,
      gitRef: row.gitRef,
      gitPath: row.gitPath,
      gitCredKey: row.gitCredKey,
      variables: (row.variables as unknown as ReplicatorVariable[]) ?? [],
      usesGeneratedCompose: row.usesGeneratedCompose,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deploymentCount,
    };
  }
}

/** Keep only well-formed variables and normalize the effective secret flag. */
function sanitizeVariables(vars?: ReplicatorVariable[]): ReplicatorVariable[] {
  if (!Array.isArray(vars)) return [];
  return vars
    .filter((v) => v && typeof v.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name))
    .map((v) => ({
      name: v.name,
      default: v.default ?? null,
      role: v.role,
      service: v.service ?? null,
      containerPort: v.containerPort ?? null,
      required: !!v.required,
      // Managed/port roles are never secret; otherwise honor the (possibly toggled) flag.
      secret: v.role === 'secret' ? true : v.role === 'plain' ? !!v.secret : false,
    }))
    // A plain var toggled secret becomes role 'secret'; a secret toggled off becomes 'plain'.
    .map((v) => ({ ...v, role: v.secret && v.role === 'plain' ? 'secret' : !v.secret && v.role === 'secret' ? 'plain' : v.role }));
}
