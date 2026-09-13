import type { ConnectorContext, EcsDeploymentProfile } from '@cerebro/shared';

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
/** Split a comma/space/newline-separated config value into a trimmed id list. */
const idList = (v: unknown): string[] => str(v).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

/**
 * Read the ECS deployment profile off an AWS connector instance's config. Returns
 * null when the profile is incomplete (so the connector isn't offered as an ECS
 * deploy target). Mirrors docker-target.ts. See docs/app-replicator-ecs-target.md.
 */
export function ecsProfileFrom(ctx: ConnectorContext): EcsDeploymentProfile | null {
  const cluster = str(ctx.config.ecsCluster).trim() || 'cerebro';
  const subnetIds = idList(ctx.config.ecsSubnetIds);
  const securityGroupIds = idList(ctx.config.ecsSecurityGroupIds);
  const taskExecutionRoleArn = str(ctx.config.ecsTaskExecutionRoleArn).trim();
  const taskRoleArn = str(ctx.config.ecsTaskRoleArn).trim() || undefined;
  // Default ENABLED so the task has egress for the ECR image pull + cloudflared on
  // a public subnet without a NAT gateway; the operator can set 'false' when using
  // private subnets with a NAT.
  const assignPublicIp = /^(false|no|0|disabled)$/i.test(str(ctx.config.ecsAssignPublicIp).trim()) ? false : true;
  const builderInstanceId = str(ctx.config.ecsBuilderInstanceId).trim() || undefined;
  const cloudflareInstanceId = str(ctx.config.ecsCloudflareInstanceId).trim() || undefined;

  // The minimum needed to register a task def and create a Fargate service.
  if (!subnetIds.length || !taskExecutionRoleArn) return null;

  return { cluster, subnetIds, securityGroupIds, taskExecutionRoleArn, taskRoleArn, assignPublicIp, builderInstanceId, cloudflareInstanceId };
}

/** The region an AWS connector instance manages (for display + ECR URIs). */
export function regionOf(ctx: ConnectorContext): string {
  return str(ctx.config.region).trim();
}
