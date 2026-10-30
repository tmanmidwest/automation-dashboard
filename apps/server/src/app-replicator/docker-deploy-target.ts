import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { DockerStackService } from '../connectors/docker/docker-stack.service';
import { dockerTargetFrom, type DockerTarget } from './docker-target';
import { buildEnvMap, toDotenv, type DeployTarget, type DeploySpec, type DeployOutcome, type DestroyContext } from './deploy-target';
import { renderComposeOverride } from './compose-override';
import { RepoIntrospectService } from './repo-introspect.service';

/**
 * The original App Replicator target: materialize a deployment as a compose stack
 * on a Docker host over SSH. This is a thin wrapper over the Docker connector's
 * DockerStackService (deployGit / down / purgeDir / remove) — each deployment is
 * also a managed DockerStack keyed by the same project name. Behavior is identical
 * to the pre-seam inline calls in DeploymentService. See docs/app-replicator.md.
 */
@Injectable()
export class DockerDeployTarget implements DeployTarget {
  readonly kind = 'docker' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: ConnectorInstanceService,
    private readonly stacks: DockerStackService,
    private readonly repo: RepoIntrospectService,
  ) {}

  /** Build the SSH deploy target for a Docker connector instance (throws if not deployable). */
  private async targetFor(instanceId: string): Promise<DockerTarget> {
    const instance = await this.instances.get(instanceId).catch(() => null);
    if (!instance) throw new BadRequestException('The selected Docker connector no longer exists.');
    if (instance.connectorId !== 'docker') throw new BadRequestException('The selected target is not a Docker connector.');
    const ctx = await this.instances.contextFor(instance);
    const target = dockerTargetFrom(ctx);
    if (!target.deployable) {
      throw new BadRequestException('That Docker connector has no SSH configured — App Replicator deploys over SSH. Set the SSH host + credentials on the connector.');
    }
    return target;
  }

  async deploy(spec: DeploySpec, onPhase: (phase: string) => void): Promise<DeployOutcome> {
    const target = await this.targetFor(spec.targetInstanceId);
    const env = toDotenv(buildEnvMap(spec.variables, spec.project, spec.portList, spec.values, spec.secrets, spec.extras));
    // Operator-added mounts + extra env become a generated compose override merged
    // at `up` (null when there's nothing to add, which clears any stale override).
    // Extra env is injected into every known service so it reaches the container
    // even when the app's compose never references it (no `${VAR}` / no env_file).
    const envServices = [...new Set(
      [...spec.variables.map((v) => v.service), ...spec.portList.map((p) => p.service), ...spec.mounts.map((m) => m.service)]
        .filter((s): s is string => !!s),
    )];
    const overrideCompose = renderComposeOverride(spec.project, spec.mounts ?? [], spec.extras ?? {}, envServices) ?? undefined;

    // A repo with no compose of its own: regenerate Cerebro's compose from the
    // current checkout (so it tracks the repo), written beside it on the host.
    // Should the repo have since committed a real compose, that one is used.
    let gitPath = spec.source.gitPath;
    let generatedCompose: string | undefined;
    if (spec.source.generated) {
      onPhase('Generating compose…');
      const c = await this.repo.fetchComposeText({
        gitUrl: spec.source.gitUrl, gitRef: spec.source.gitRef, gitPath: spec.source.gitPath ?? undefined, gitCredKey: spec.source.gitCredKey,
      });
      if (c.usesGeneratedCompose) generatedCompose = c.text;
      else gitPath = c.composePath;
    }

    const result = await this.stacks.deployGit(
      target,
      spec.targetInstanceId,
      spec.project,
      { gitUrl: spec.source.gitUrl, gitRef: spec.source.gitRef, gitPath, credKey: spec.source.gitCredKey, env, overrideCompose, generatedCompose },
      { pull: true, forceRebuild: spec.forceRebuild },
      onPhase,
    );
    const commit = await this.latestCommit(spec.targetInstanceId, spec.project);
    return { ok: result.ok, message: result.message, deployedCommit: commit };
  }

  async destroy(ctx: DestroyContext): Promise<{ problems: string[] }> {
    const problems: string[] = [];
    try {
      const target = await this.targetFor(ctx.targetInstanceId);
      const down = await this.stacks.down(target, ctx.targetInstanceId, ctx.project);
      if (!down.ok) problems.push(down.message);
      await this.stacks.purgeDir(target, ctx.project);
      await this.stacks.remove(ctx.targetInstanceId, ctx.project);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : 'Could not reach the host to stop the stack.');
    }
    return { problems };
  }

  /** The commit recorded for the managed stack's most recent revision. */
  private async latestCommit(instanceId: string, project: string): Promise<string | null> {
    const rev = await this.prisma.dockerStackRevision.findFirst({
      where: { connectorInstanceId: instanceId, name: project },
      orderBy: { createdAt: 'desc' },
      select: { commit: true },
    }).catch(() => null);
    return rev?.commit ?? null;
  }
}
