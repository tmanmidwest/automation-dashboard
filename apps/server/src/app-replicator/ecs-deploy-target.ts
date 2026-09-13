import { Injectable } from '@nestjs/common';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { RepoIntrospectService } from './repo-introspect.service';
import { EcsBuilderService } from './ecs-builder.service';
import { ecsProfileFrom } from './ecs-target';
import { composeToTaskDef } from './compose-to-taskdef';
import { buildEnvMap, type DeployTarget, type DeploySpec, type DeployOutcome, type DestroyContext } from './deploy-target';
import type { EcsServiceInput } from '../connectors/aws/aws-api';
import type { EcsDeploymentRefs, OperationResult } from '@cerebro/shared';

/**
 * The AWS ECS/Fargate deploy target: build the app image on a Docker host over
 * SSH, push it to ECR, translate the compose into a Fargate task definition, and
 * run it as an ECS service — all AWS mutations go through the AWS connector's own
 * deploy operations (via ConnectorInstanceService), never a direct SDK here.
 * Teardown deletes the service, task-def revisions, ECR repo, and log group, then
 * sweeps by tag for orphans. Cloudflare ingress (the cloudflared sidecar) is wired
 * in Phase 3. See docs/app-replicator-ecs-target.md.
 */
@Injectable()
export class EcsDeployTarget implements DeployTarget {
  readonly kind = 'ecs' as const;

  constructor(
    private readonly instances: ConnectorInstanceService,
    private readonly repo: RepoIntrospectService,
    private readonly builder: EcsBuilderService,
  ) {}

  private op(instanceId: string, operationId: string, values: Record<string, unknown>): Promise<OperationResult> {
    return this.instances.runResourceOperationAwait(instanceId, operationId, undefined, values);
  }

  async deploy(spec: DeploySpec, onPhase: (phase: string) => void): Promise<DeployOutcome> {
    const instance = await this.instances.get(spec.targetInstanceId).catch(() => null);
    if (!instance) return { ok: false, message: 'The selected AWS connector no longer exists.' };
    if (instance.connectorId !== 'aws') return { ok: false, message: 'The selected target is not an AWS connector.' };
    const ctx = await this.instances.contextFor(instance);
    const profile = ecsProfileFrom(ctx);
    if (!profile) return { ok: false, message: 'This AWS connector has no complete ECS deployment profile (it needs subnets and a task execution role ARN).' };
    if (!profile.builderInstanceId) return { ok: false, message: 'Set an image builder (a Docker connector instance) in the AWS connector’s ECS profile — the image is built there and pushed to ECR.' };

    const project = spec.project;
    const ecrRepositoryName = `cerebro/${project}`;
    const logGroupName = `/cerebro/${project}`;
    const tags = { 'cerebro:deployment': spec.deploymentId, 'cerebro:project': project };
    const cpu = spec.taskCpu || '256';
    const memory = spec.taskMemory || '512';

    // 1. ECR repository.
    onPhase('Preparing ECR repository…');
    const repo = await this.op(spec.targetInstanceId, 'ecr-ensure-repo', { name: ecrRepositoryName, tags });
    if (!repo.ok) return { ok: false, message: `ECR: ${repo.message}` };
    const repositoryUri = String(repo.data?.repositoryUri ?? '');
    if (!repositoryUri) return { ok: false, message: 'ECR did not return a repository URI.' };

    // 2. Registry auth for the builder's `docker login`.
    const auth = await this.op(spec.targetInstanceId, 'ecr-auth-token', {});
    if (!auth.ok) return { ok: false, message: `ECR auth: ${auth.message}` };
    const endpoint = String(auth.data?.endpoint ?? '');
    const username = String(auth.data?.username ?? 'AWS');
    const password = String(auth.data?.password ?? '');
    if (!endpoint || !password) return { ok: false, message: 'ECR did not return an authorization token.' };

    // 3. Build + push the image on the builder host.
    const imageRef = `${repositoryUri}:d${Date.now().toString(36)}`;
    let commit: string | null = null;
    try {
      const built = await this.builder.buildAndPush(
        {
          builderInstanceId: profile.builderInstanceId,
          project,
          source: { gitUrl: spec.source.gitUrl, gitRef: spec.source.gitRef, gitPath: spec.source.gitPath, credKey: spec.source.gitCredKey },
          imageRef,
          registryEndpoint: endpoint,
          username,
          password,
          forceRebuild: spec.forceRebuild,
        },
        onPhase,
      );
      commit = built.commit;
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Image build/push failed.' };
    }

    // 4. Translate the compose file into a Fargate task definition.
    onPhase('Translating compose…');
    let taskDef, warnings: string[], primaryContainerPort: number | null;
    try {
      const composeInfo = await this.repo.fetchComposeText({
        gitUrl: spec.source.gitUrl, gitRef: spec.source.gitRef ?? undefined, gitPath: spec.source.gitPath ?? undefined, gitCredKey: spec.source.gitCredKey,
      });
      const env = buildEnvMap(spec.variables, project, spec.portList, spec.values, spec.secrets);
      const result = composeToTaskDef({
        family: project,
        composeText: composeInfo.text,
        ecrImageUri: imageRef,
        env,
        logGroup: logGroupName,
        executionRoleArn: profile.taskExecutionRoleArn,
        taskRoleArn: profile.taskRoleArn,
        cpu,
        memory,
        tags,
        // Cloudflare ingress (cloudflared sidecar) is added in Phase 3.
      });
      taskDef = result.taskDef;
      warnings = result.warnings;
      primaryContainerPort = result.primaryContainerPort;
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Failed to translate the compose file.' };
    }
    if (!taskDef.containers.length) return { ok: false, message: 'No deployable services were found in the compose file.' };

    // 5. Cluster (lazily created).
    onPhase('Ensuring ECS cluster…');
    const clusterRes = await this.op(spec.targetInstanceId, 'ecs-ensure-cluster', { name: profile.cluster, tags });
    if (!clusterRes.ok) return { ok: false, message: `Cluster: ${clusterRes.message}` };
    const cluster = String(clusterRes.data?.cluster ?? profile.cluster);

    // 6. Log group.
    onPhase('Ensuring log group…');
    const lg = await this.op(spec.targetInstanceId, 'logs-create-group', { name: logGroupName, tags });
    if (!lg.ok) return { ok: false, message: `Logs: ${lg.message}` };

    // 7. Register the task definition.
    onPhase('Registering task definition…');
    const reg = await this.op(spec.targetInstanceId, 'ecs-register-taskdef', { taskDef });
    if (!reg.ok) return { ok: false, message: `Task definition: ${reg.message}` };
    const taskDefRef = String(reg.data?.ref ?? '');
    const taskDefFamily = String(reg.data?.family ?? project);
    if (!taskDefRef) return { ok: false, message: 'ECS did not return the task definition revision.' };

    // 8. Create or update the Fargate service.
    onPhase('Deploying the Fargate service…');
    const serviceInput: EcsServiceInput = {
      cluster,
      serviceName: project,
      taskDefinition: taskDefRef,
      desiredCount: 1,
      subnets: profile.subnetIds,
      securityGroups: profile.securityGroupIds,
      assignPublicIp: profile.assignPublicIp,
      tags,
    };
    const svcRes = await this.op(spec.targetInstanceId, 'ecs-deploy-service', { service: serviceInput });
    if (!svcRes.ok) return { ok: false, message: `Service: ${svcRes.message}` };
    const serviceArn = String(svcRes.data?.arn ?? '');

    // 9. Wait for a steady state (soft — a timeout is a note, not a failure).
    const wait = await this.op(spec.targetInstanceId, 'ecs-wait-service', { cluster, service: project, timeoutMs: 300_000 });

    const refs: EcsDeploymentRefs = {
      cluster,
      serviceArn,
      taskDefFamily,
      ecrRepositoryName,
      logGroupName,
      builderInstanceId: profile.builderInstanceId,
      routedContainerPort: primaryContainerPort ?? undefined,
    };
    const parts = [`Deployed ${project} to ECS cluster ${cluster}.`, wait.message];
    if (warnings.length) parts.push(`Notes: ${warnings.join(' ')}`);
    return { ok: true, message: parts.join(' '), deployedCommit: commit, refs };
  }

  async destroy(ctx: DestroyContext, onPhase?: (phase: string) => void): Promise<{ problems: string[] }> {
    const problems: string[] = [];
    const refs = ctx.ecs ?? null;
    const phase = onPhase ?? (() => {});
    const instance = await this.instances.get(ctx.targetInstanceId).catch(() => null);
    if (!instance) return { problems: ['The AWS connector no longer exists; ECS resources may need manual cleanup.'] };

    const call = async (operationId: string, values: Record<string, unknown>, label: string) => {
      try {
        const r = await this.op(ctx.targetInstanceId, operationId, values);
        if (!r.ok) problems.push(`${label}: ${r.message}`);
      } catch (err) {
        problems.push(`${label}: ${err instanceof Error ? err.message : 'failed'}`);
      }
    };

    if (refs?.cluster) {
      phase('Deleting the ECS service…');
      await call('ecs-delete-service', { cluster: refs.cluster, service: ctx.project }, 'delete service');
    }
    if (refs?.taskDefFamily) {
      phase('Deregistering task definitions…');
      await call('ecs-deregister-taskdef', { family: refs.taskDefFamily }, 'deregister task defs');
    }
    if (refs?.ecrRepositoryName) {
      phase('Deleting the ECR repository…');
      await call('ecr-delete-repo', { name: refs.ecrRepositoryName }, 'delete ECR repo');
    }
    if (refs?.logGroupName) {
      phase('Deleting the log group…');
      await call('logs-delete-group', { name: refs.logGroupName }, 'delete log group');
    }

    // Orphan sweep by tag (the service may still be DRAINING — reported as a note).
    phase('Checking for leftover tagged resources…');
    try {
      const sweep = await this.op(ctx.targetInstanceId, 'tags-get-resources', { key: 'cerebro:project', value: ctx.project });
      const arns = (sweep.data?.arns as string[] | undefined) ?? [];
      if (arns.length) problems.push(`${arns.length} resource(s) still tagged cerebro:project=${ctx.project} (the service may still be draining): ${arns.slice(0, 5).join(', ')}`);
    } catch {
      /* best-effort */
    }
    return { problems };
  }
}
