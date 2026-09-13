import type { ReplicatorVariable, ReplicatorPort, EcsDeploymentRefs, TargetKind } from '@cerebro/shared';

/**
 * The deploy-target seam. The App Replicator materializes a deployment onto one of
 * two backends — a Docker host over SSH (DockerDeployTarget) or AWS Fargate
 * (EcsDeployTarget) — behind this interface. DeploymentService stays the
 * orchestrator (validation, row persistence, vault, audit, phase/status); a target
 * only does the backend-specific provisioning and teardown. See
 * docs/app-replicator-ecs-target.md.
 */

/** Lowercase a compose service/name fragment to something docker/ECS accepts. */
export function slug(s: string): string {
  return (s || 'app').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+/, '').slice(0, 40) || 'app';
}

/**
 * Resolve every compose variable to its effective value — the interpolation
 * dictionary both targets share. Managed roles (image_tag/container_name/host_port)
 * get Cerebro-assigned isolation values; plain/host_ip/secret take the operator's
 * value. Docker serializes this to a compose `.env`; ECS uses it to interpolate
 * `${VAR}` tokens when translating the compose into a task definition.
 */
export function buildEnvMap(
  variables: ReplicatorVariable[],
  project: string,
  portList: ReplicatorPort[],
  values: Record<string, string>,
  secrets: Record<string, string>,
): Map<string, string> {
  const env = new Map<string, string>();
  const portByVar = new Map(portList.map((p) => [p.variable, p.hostPort]));
  for (const v of variables) {
    const svc = slug(v.service ?? 'app');
    if (v.role === 'image_tag') env.set(v.name, `${project}-${svc}:latest`);
    else if (v.role === 'container_name') env.set(v.name, `${project}-${svc}`);
    else if (v.role === 'host_port') { const p = portByVar.get(v.name); if (p != null) env.set(v.name, String(p)); }
    else if (v.role === 'secret') { const s = secrets[v.name]; if (s != null && s !== '') env.set(v.name, s); }
    else if (v.role === 'plain' || v.role === 'host_ip') { const val = values[v.name]; if (val != null && val !== '') env.set(v.name, String(val)); }
  }
  return env;
}

/** Serialize an env map to a single-line-per-entry compose `.env` string. */
export function toDotenv(env: Map<string, string>): string {
  return [...env.entries()].map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, ' ')}`).join('\n') + '\n';
}

/** Everything a target needs to materialize one deployment. */
export interface DeploySpec {
  deploymentId: string;
  /** Target ConnectorInstance id (Docker or AWS). */
  targetInstanceId: string;
  project: string;
  source: { gitUrl: string; gitRef: string; gitPath: string | null; gitCredKey: string | null };
  variables: ReplicatorVariable[];
  portList: ReplicatorPort[];
  values: Record<string, string>;
  secrets: Record<string, string>;
  forceRebuild: boolean;
  /** ECS only. */
  taskCpu?: string;
  taskMemory?: string;
}

export interface DeployOutcome {
  ok: boolean;
  message: string;
  /** The commit that was deployed (for update tracking). */
  deployedCommit?: string | null;
  /** ECS teardown handles to persist on the row (undefined for Docker). */
  refs?: EcsDeploymentRefs | null;
}

/** What a target needs to tear a deployment down. */
export interface DestroyContext {
  targetInstanceId: string;
  project: string;
  /** ECS teardown handles (present only for an ECS deployment). */
  ecs?: EcsDeploymentRefs | null;
}

export interface DeployTarget {
  readonly kind: TargetKind;
  /** Provision/redeploy the deployment. `onPhase` streams coarse progress markers. */
  deploy(spec: DeploySpec, onPhase: (phase: string) => void): Promise<DeployOutcome>;
  /** Tear down backend resources; best-effort, returns human-readable problems. */
  destroy(ctx: DestroyContext, onPhase?: (phase: string) => void): Promise<{ problems: string[] }>;
}
