// App Replicator — register a Git-repo app once, then materialize it as many
// isolated deployments onto a Docker host. See docs/app-replicator.md.
//
// The compose file IS the manifest: a repo's variables/ports/secrets are derived
// from Docker Compose's own `${VAR:-default}` interpolation (see the server-side
// compose introspector), so an app needs no hand-authored manifest.

/** How a detected compose variable is used, which drives how the deploy form treats it. */
export type ReplicatorVarRole =
  | 'host_port' // left side of a `ports:` mapping — a published host port
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

export type ReplicatorDeploymentStatus = 'pending' | 'deployed' | 'error' | 'updating' | 'stopped';

/** One running instance of an app on a target host. */
export interface ReplicatorDeployment {
  id: string;
  appId: string;
  appName?: string;
  /** Operator-chosen name → sanitized compose project name. */
  name: string;
  project: string;
  dockerInstanceId: string;
  dockerInstanceName?: string;
  /** Non-secret resolved variable values (keyed by variable name). */
  values: Record<string, string>;
  /** Names of variables whose values live in the vault (`deployment:<id>:<name>`). */
  secretVars: string[];
  ports: ReplicatorPort[];
  status: ReplicatorDeploymentStatus;
  lastMessage?: string | null;
  deployedCommit?: string | null;
  /** Set when a drift check found the repo has moved ahead of the deployed commit. */
  updateAvailable?: boolean;
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
  dockerInstanceId: string;
  name: string;
  /** Non-secret variable values keyed by name (missing → the repo default). */
  values: Record<string, string>;
  /** Secret variable values keyed by name (plaintext, one-time; stored in the vault). */
  secrets: Record<string, string>;
  /** Chosen host port per host_port variable name. */
  ports: Record<string, number>;
  /** `docker compose build --no-cache` — for repos that build their own image. */
  forceRebuild?: boolean;
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

/** A Docker connector instance eligible as a deploy target. */
export interface ReplicatorTarget {
  instanceId: string;
  name: string;
  hostIp: string;
  /** False when the connector has no SSH configured (deploys need SSH). */
  deployable: boolean;
}
