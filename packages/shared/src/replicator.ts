// App Replicator — register a Git-repo app once, then materialize it as many
// isolated deployments onto a Docker host. See docs/app-replicator.md.
//
// The compose file IS the manifest: a repo's variables/ports/secrets are derived
// from Docker Compose's own `${VAR:-default}` interpolation (see the server-side
// compose introspector), so an app needs no hand-authored manifest.

/** How a detected compose variable is used, which drives how the deploy form treats it. */
export type ReplicatorVarRole =
  | 'host_port' // the host-port segment of a `ports:` mapping — a published host port
  | 'host_ip' // the host-IP segment of a `ports:` mapping (e.g. 0.0.0.0) — a bind address, not a port
  | 'image_tag' // appears in `image:` — auto-managed per deployment (isolation)
  | 'container_name' // appears in `container_name:` — auto-managed per deployment
  | 'secret' // name looks secret (password/token/key/…) — stored in the vault
  | 'plain'; // an ordinary configuration value

/** One variable detected in an app's compose file. */
export interface ReplicatorVariable {
  name: string;
  /** Default from `${VAR:-default}` (undefined when the repo declares none). */
  default?: string | null;
  role: ReplicatorVarRole;
  /** The compose service the variable belongs to (best-effort). */
  service?: string | null;
  /** For host_port: the fixed internal container port (right side of the mapping). */
  containerPort?: number | null;
  /** No default in the repo — the operator must supply a value. */
  required: boolean;
  /** Effective secret flag: the role heuristic, overridable per-variable at register time. */
  secret: boolean;
}

/** A catalog entry: a reusable app template registered once. */
export interface ReplicatorApp {
  id: string;
  name: string;
  gitUrl: string;
  gitRef: string;
  gitPath?: string | null;
  /** Vault secret key (kind='git') to authenticate a private repo; null = public. */
  gitCredKey?: string | null;
  variables: ReplicatorVariable[];
  /** True when the repo had only a Dockerfile and Cerebro generated a compose wrapper. */
  usesGeneratedCompose: boolean;
  createdAt: string;
  updatedAt: string;
  /** How many deployments reference this app (list view). */
  deploymentCount?: number;
}

/** A published port mapping for a deployment. */
export interface ReplicatorPort {
  service: string;
  variable: string;
  hostPort: number;
  containerPort: number;
}

/**
 * Which backend a deployment runs on. 'docker' materializes it as a compose stack
 * on a Docker host over SSH (the original target); 'ecs' builds the image and runs
 * it on AWS Fargate fronted by a cloudflared sidecar. See
 * docs/app-replicator-ecs-target.md.
 */
export type TargetKind = 'docker' | 'ecs';

/**
 * Account-specific facts an ECS deploy needs that the compose file can't provide.
 * Configured once on the AWS connector instance (not per deployment). Cerebro
 * selects existing infrastructure here (subnets/SGs/roles/cluster) — it never
 * creates a VPC, subnet, security group, or IAM role.
 */
export interface EcsDeploymentProfile {
  /** Existing ECS cluster name (Cerebro lazily creates it only if absent). */
  cluster: string;
  /** Subnets for awsvpc networking (from the connector's existing subnet picker). */
  subnetIds: string[];
  /** Security group(s) — egress-only is enough with the cloudflared sidecar. */
  securityGroupIds: string[];
  /** Pre-provisioned task execution role (ECR pull + logs write). */
  taskExecutionRoleArn: string;
  /** Optional app-level task role. */
  taskRoleArn?: string;
  /** ENABLED public IP — needed for egress when subnets are public with no NAT. */
  assignPublicIp?: boolean;
  /** Docker connector instance used to build + push the image (else chosen at deploy). */
  builderInstanceId?: string;
  /** Cloudflare connector instance whose named tunnel the sidecar joins. */
  cloudflareInstanceId?: string;
}

/** Teardown handles for an ECS deployment (persisted on the deployment row). */
export interface EcsDeploymentRefs {
  cluster: string;
  serviceArn: string;
  /** Task-definition family — every revision is deregistered on teardown. */
  taskDefFamily: string;
  /** ECR repository name (…/cerebro/<project>) — force-deleted on teardown. */
  ecrRepositoryName: string;
  /** CloudWatch log group (/cerebro/<project>). */
  logGroupName: string;
  /** The Docker connector instance the image was built on. */
  builderInstanceId: string;
  /** Container port the cloudflared sidecar routes to (the app's published port). */
  routedContainerPort?: number;
}

export type ReplicatorDeploymentStatus = 'pending' | 'deployed' | 'error' | 'updating' | 'stopped';

/** One running instance of an app on a target host. */
export interface ReplicatorDeployment {
  id: string;
  appId: string;
  appName?: string;
  /** Operator-chosen name → sanitized compose project name. */
  name: string;
  project: string;
  /**
   * Which backend this deployment runs on. Absent/`'docker'` for the original
   * Docker-host target; `'ecs'` for AWS Fargate.
   */
  targetKind?: TargetKind;
  /**
   * The target ConnectorInstance id. Historically named for Docker (the first and
   * only target); for an ECS deployment this is the AWS connector instance.
   */
  dockerInstanceId: string;
  dockerInstanceName?: string;
  /** ECS teardown handles (present only when targetKind === 'ecs'). */
  ecs?: EcsDeploymentRefs | null;
  /** Non-secret resolved variable values (keyed by variable name). */
  values: Record<string, string>;
  /** Names of variables whose values live in the vault (`deployment:<id>:<name>`). */
  secretVars: string[];
  ports: ReplicatorPort[];
  status: ReplicatorDeploymentStatus;
  /** Live sub-step while a deploy/redeploy runs (e.g. "Building images…"); null when settled. */
  phase?: string | null;
  lastMessage?: string | null;
  deployedCommit?: string | null;
  /** Set when the update-check sweep found the repo has moved ahead of the deployed commit. */
  updateAvailable?: boolean;
  /** The remote tip commit that's available but not yet deployed. */
  availableCommit?: string | null;
  /** Ingress routes fronting this deployment's ports (Phase 2). */
  ingress?: ReplicatorIngress[];
  createdAt: string;
  updatedAt: string;
}

// ── DTOs ──────────────────────────────────────────────────────────

/** Introspect a repo's compose file into a variable/port schema (register step 1). */
export interface IntrospectRepoInput {
  gitUrl: string;
  gitRef?: string;
  gitPath?: string;
  gitCredKey?: string | null;
}

export interface IntrospectResult {
  variables: ReplicatorVariable[];
  services: string[];
  /** Path to the compose file used within the repo (or the generated wrapper name). */
  composePath: string;
  usesGeneratedCompose: boolean;
  warnings: string[];
}

/** What a schema refresh would change relative to the app's stored variables. */
export interface ReplicatorSchemaDiff {
  /** Variables in the repo now but not in the stored schema. */
  added: string[];
  /** Variables in the stored schema but no longer in the repo. */
  removed: string[];
  /** Variables whose role changed (e.g. a bind IP reclassified from host_port → host_ip). */
  roleChanged: { name: string; from: ReplicatorVarRole; to: ReplicatorVarRole }[];
}

/**
 * Result of re-introspecting a registered app's repo, merged against its stored
 * schema (new vars added, gone vars dropped, operator secret toggles preserved).
 * Read-only preview — the operator applies it via the app PATCH.
 */
export interface RefreshSchemaResult {
  /** The proposed merged variable schema. */
  variables: ReplicatorVariable[];
  diff: ReplicatorSchemaDiff;
  composePath: string;
  usesGeneratedCompose: boolean;
  warnings: string[];
}

/** Register a reviewed app into the catalog. */
export interface RegisterAppInput {
  name: string;
  gitUrl: string;
  gitRef?: string;
  gitPath?: string;
  gitCredKey?: string | null;
  /** The reviewed/adjusted variable schema (secret flags may have been toggled). */
  variables: ReplicatorVariable[];
  usesGeneratedCompose?: boolean;
}

/** Deploy an app as a new isolated instance. */
export interface DeployInput {
  /**
   * Target ConnectorInstance id (a Docker connector for a 'docker' deploy, an AWS
   * connector for an 'ecs' deploy). Named for Docker for backward compatibility.
   */
  dockerInstanceId: string;
  /** Which backend to deploy on. Absent = 'docker' (backward compatible). */
  targetKind?: TargetKind;
  name: string;
  /** Non-secret variable values keyed by name (missing → the repo default). */
  values: Record<string, string>;
  /** Secret variable values keyed by name (plaintext, one-time; stored in the vault). */
  secrets: Record<string, string>;
  /** Chosen host port per host_port variable name. */
  ports: Record<string, number>;
  /** `docker compose build --no-cache` — for repos that build their own image. */
  forceRebuild?: boolean;
  /** ECS only: Fargate task CPU units (e.g. '256'); default 256. */
  taskCpu?: string;
  /** ECS only: Fargate task memory in MiB (e.g. '512'); default 512. */
  taskMemory?: string;
}

/**
 * Redeploy an existing deployment. With `edit` false/absent it re-runs the stored
 * config (pull latest / rebuild). With `edit: true` the supplied maps are merged
 * over the stored config and persisted before the redeploy, so the operator can
 * change values, rotate secrets, or move host ports without tearing down.
 */
export interface RedeployInput {
  /** `docker compose build --no-cache` — rebuild locally-built images from scratch. */
  forceRebuild?: boolean;
  /** Apply the maps below before redeploying (an edit), rather than reusing the stored config. */
  edit?: boolean;
  /** Edited non-secret values (name→value). A key left out keeps the stored value. */
  values?: Record<string, string>;
  /** Rotated secrets (name→value). A key left out or blank keeps the stored secret. */
  secrets?: Record<string, string>;
  /** Edited host ports (host_port var name→port). A key left out keeps the stored port. */
  ports?: Record<string, number>;
}

/** A suggested free host port for one host_port variable. */
export interface PortSuggestion {
  variable: string;
  service: string;
  containerPort: number;
  suggested: number;
}

/** Target host facts for the deploy wizard: used ports + suggestions + the ingress host IP. */
export interface DeployTargetInfo {
  hostIp: string;
  usedPorts: number[];
  suggestions: PortSuggestion[];
}

// ── Ingress (Phase 2) ─────────────────────────────────────────────

export type ReplicatorIngressKind = 'cloudflare' | 'npm';

/** One ingress route exposing a deployment's published port to the outside. */
export interface ReplicatorIngress {
  id: string;
  deploymentId: string;
  kind: ReplicatorIngressKind;
  /** The Cloudflare / NPM connector instance that owns the route. */
  instanceId: string;
  instanceName?: string;
  /** Which published port this fronts (the compose service + host port). */
  service: string;
  hostPort: number;
  hostname: string;
  /** Teardown handle: CF → the tunnel id (route keyed by hostname); NPM → the proxy-host id. */
  ref: string;
  /** Convenience: https://<hostname>. */
  url: string;
  createdAt: string;
}

/** A Cloudflare or NPM connector instance that can front a deployment. */
export interface IngressTarget {
  instanceId: string;
  name: string;
  kind: ReplicatorIngressKind;
}

/** A tunnel offered by a Cloudflare instance (for the ingress picker). */
export interface CfTunnelOption {
  id: string;
  name: string;
  /** False when the tunnel is locally-managed (its ingress can't be edited via the API). */
  editable: boolean;
}

/** A certificate offered by an NPM instance (id 0 = None / HTTP-only). */
export interface NpmCertOption {
  id: number;
  name: string;
}

/** Add an ingress route to a deployment's published port. */
export interface AddIngressInput {
  kind: ReplicatorIngressKind;
  instanceId: string;
  service: string;
  hostPort: number;
  hostname: string;
  /** Cloudflare: the tunnel to add the public-hostname route to. */
  tunnelId?: string;
  /** NPM: an existing certificate id to attach (0/omitted = HTTP-only). */
  certificateId?: number;
  /** NPM: force SSL when a cert is attached. */
  sslForced?: boolean;
}

/** A connector instance eligible as a deploy target (Docker host or AWS/ECS). */
export interface ReplicatorTarget {
  instanceId: string;
  name: string;
  /** Which backend this target deploys to. */
  targetKind: TargetKind;
  /** Docker: the SSH host IP (also the ingress forward host). ECS: the region. */
  hostIp: string;
  /** False when the target can't accept a deploy (Docker: no SSH; ECS: no profile). */
  deployable: boolean;
}
