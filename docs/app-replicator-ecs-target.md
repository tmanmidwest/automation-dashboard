# App Replicator — AWS ECS target (V2)

Design + implementation plan for a **second deploy target** in the [App Replicator](app-replicator.md):
alongside "deploy to a Docker host over SSH", let Cerebro **build an app's image, push it to ECR,
and run it on AWS Fargate** — then front it with the same Cloudflare ingress the Docker target uses,
and tear the whole thing down cleanly (service, task defs, image repo, log group, ingress, secrets).

This rides on the App Replicator's existing shape: the **catalog**, the **compose→variable/port
schema**, the **vault**, the **wizard**, and the **teardown-is-first-class** discipline are all
target-agnostic already. What's new is a second implementation of the deploy transport and a batch
of AWS connector operations that don't exist yet.

> **Scope note.** Today the deploy path is hardcoded to Docker: `DeploymentService.targetFor()`
> rejects any `connectorId !== 'docker'`, the schema column is literally `dockerInstanceId`, and
> `listTargets()` filters to Docker instances. The AWS connector can *read* ECS clusters/services/
> tasks and `UpdateService`/`StopTask` an **existing** service — it cannot create one, has no ECR
> support (not even the SDK dependency), and ELB is describe+delete only. So this V2 is mostly
> greenfield on the connector side plus a refactor to introduce a target seam on the replicator side.

## The core insight: we become the orchestrator

The Docker target is easy because **the compose file *is* the manifest and orchestration is
delegated to the host's own `docker compose up`.** ECS has no "run this compose file" primitive. We
translate the compose model into AWS primitives ourselves — that translation *is* the feature.

Two decisions keep that translation tractable rather than "port the whole AWS console":

### Decision 1 — Ingress via a `cloudflared` sidecar, **not** an ALB

The instinct — Fargate service → ALB → target group → listener → security-group ingress → CF CNAME
to the ALB — forces us to build the single largest missing piece (ALB/target-group/listener
creation) into the AWS connector, plus SG ingress rules, and it's the messiest thing to unwind on
teardown.

Instead we add a **`cloudflared` sidecar container to the task definition**, pointed at a named
Cloudflare tunnel. Then:

- We **reuse the existing CF ingress path almost verbatim** — the same `tunnel-add-route` operation
  the Docker target already calls, with `service: http://localhost:<containerPort>` (localhost
  because the sidecar shares the task's network namespace with the app container).
- **No ALB, no target group, no listener, no inbound security-group rules, no public IP.** The task
  needs egress only. Cheaper, more secure, and teardown shrinks to a handful of deletes.

Trade-off: a small `cloudflared` sidecar per task and a tunnel token injected into the task. The
user already runs CF tunnels, and the token is a vault secret.

> NPM ingress is **not** offered for the ECS target — an NPM proxy host forwards to a routable
> `host:port`, which a Fargate task behind a tunnel doesn't have. ECS ingress is Cloudflare-only.

### Decision 2 — Build & push the image on an **existing Docker host over SSH**

Fargate needs a registry image; nothing in Cerebro's container runs `docker build`. Rather than
stand up AWS CodeBuild (a whole subsystem + extra IAM), we **reuse a Docker connector host as the
builder** over the SSH transport we already have:

```
git clone/pull        (reuse DockerStackService's git-over-SSH)
docker build          (reuse the host's engine)
aws ecr get-login-password | docker login    (auth token from the new ECR op)
docker push <ecr-uri>
```

So an ECS deploy also requires *a* Docker host as builder — pragmatic, no new infra, and it reuses
`DockerStackService`'s existing SSH plumbing. The builder host is chosen at deploy time (or fixed in
the AWS connector's deployment profile).

## What must be built new in the AWS connector

Even with the sidecar shortcut, the connector needs these (all inherit the existing per-call
`new AwsApi(this.authFrom(ctx))` credential/region plumbing for free):

| Area | New operation(s) | AWS SDK call | Status today |
|---|---|---|---|
| **ECR** | create-repo, get-auth-token, delete-repo (+ images) | `CreateRepository`, `GetAuthorizationToken`, `DeleteRepository(force)` | **none** — must add `@aws-sdk/client-ecr` dep + client getter |
| **ECS** | register-task-def, create-service, deregister-task-def, delete-service | `RegisterTaskDefinition`, `CreateService`, `DeregisterTaskDefinition`, `DeleteService` | only `UpdateService`(count/forceNew) + `StopTask` exist |
| **CloudWatch Logs** | create-log-group, delete-log-group | `CreateLogGroup`, `DeleteLogGroup` | **none** — add `@aws-sdk/client-cloudwatch-logs` |
| **IAM** | *(none — see below)* | — | intentionally not built |

**IAM is deliberately out of scope.** Having Cerebro create task-execution roles needs `iam:*` and
is a footgun. Instead the **AWS connector's deployment profile carries a pre-provisioned
`taskExecutionRoleArn`** (and optional `taskRoleArn`) that the user creates once. `RegisterTaskDefinition`
references it.

The **cluster is reused, not created** — the deployment profile names an existing ECS cluster (or we
default to a `cerebro` cluster and create it lazily if absent via `CreateCluster`, a small addition).

## The deployment profile (AWS connector config)

Deploying to ECS needs a few account-specific facts the compose file can't provide. These live on
the **AWS connector instance's config** (not per-deployment), so they're picked once:

```ts
interface EcsDeploymentProfile {
  cluster: string;                 // existing ECS cluster name (or lazily-created 'cerebro')
  subnetIds: string[];             // existing subnets for awsvpc networking (reuse the EC2 form's DescribeSubnets picker)
  securityGroupIds: string[];      // existing SG(s) — egress-only is enough with the sidecar
  taskExecutionRoleArn: string;    // pre-provisioned; grants ECR pull + logs write
  taskRoleArn?: string;            // optional app-level role
  assignPublicIp?: boolean;        // true if subnets are public + no NAT (egress for cloudflared/ECR pull)
  builderInstanceId?: string;      // Docker connector instance used to build/push (else chosen at deploy)
  cloudflareInstanceId?: string;   // CF connector instance whose tunnel token the sidecar uses
}
```

`subnetIds`/`securityGroupIds` reuse the AWS connector's **existing** `DescribeSubnets` /
`DescribeSecurityGroups` option sources (already wired for the EC2 launch form) — we select
infrastructure, we never create VPCs/subnets/SGs.

## compose → ECS translation

The introspector already yields services, ports, env, secrets, and image per service. The mapping:

| Compose concept | ECS task definition |
|---|---|
| all services in the compose | **one task definition, multiple containers** (they share `localhost`, matching compose's single-host bring-up — parity with the Docker target) |
| `image:` (built locally) | rewritten to the pushed ECR URI `…/cerebro/<project>:<gitCommit>` |
| `ports:` published port | `portMappings` (container port only; no host port on Fargate) + the sidecar's route target |
| `environment:` plain vars | `containerDefinitions[].environment` |
| secret-role vars | `containerDefinitions[].environment` from the vault at deploy time *(V2a; a `secrets`→Secrets Manager path is a later hardening step)* |
| logging | `awslogs` driver → the per-deployment CloudWatch log group |
| — | **+ a `cloudflared` sidecar container** running `tunnel run`, tunnel token injected as a secret env var |

`cpu`/`memory` are Fargate-required task-level fields with no compose equivalent → sensible defaults
(0.25 vCPU / 512 MB) overridable per deployment in the wizard.

## Deployment flow (what changes vs. the Docker wizard)

The wizard's shape is unchanged (pick app → name → **pick target** → resolve variables → ingress →
preflight → deploy). The target-specific steps:

2. **Pick the target** — now either a Docker instance **or an AWS instance that has an
   `EcsDeploymentProfile` configured**. `listTargets()` returns both kinds.
3. **Resolve variables** — identical (host-port fields become the container port + tunnel route;
   no free-port allocation needed on Fargate, so the port-preflight step is skipped for ECS).
4. **Ingress** — Cloudflare only, per published port (NPM hidden for ECS targets).
5. **Preflight** — for ECS: STS `GetCallerIdentity` (creds valid), cluster exists, execution role
   ARN present, builder host reachable over SSH, `docker compose config -q` on the builder. No port
   preflight.
6. **Deploy** (background worker, coarse phase markers like the Docker path):
   *Queued… → Cloning… → Building image… → Pushing to ECR… → Registering task def… → Creating
   service… → Adding tunnel route… → Waiting for RUNNING…*

## Data model changes

Introduce a **target seam** on the deployment row rather than a Docker-only column:

```ts
interface Deployment {
  // was: dockerInstanceId: string;
  targetKind: 'docker' | 'ecs';
  targetInstanceId: string;        // Docker OR AWS connector instance id
  // … existing fields (values, secretVars, ports, ingress, status, deployedCommit) …
  ecs?: EcsDeploymentRefs;         // teardown handles for the ECS target (null for docker)
}

interface EcsDeploymentRefs {
  cluster: string;
  serviceArn: string;
  taskDefFamily: string;           // deregister every revision on teardown
  ecrRepositoryName: string;       // …/cerebro/<project>
  logGroupName: string;            // /cerebro/<project>
  builderInstanceId: string;       // where the image was built
}
```

Migration `0020_replicator_target` renames/back-fills `dockerInstanceId → targetInstanceId` +
`targetKind='docker'` for existing rows, and adds the nullable `ecs` JSON column. All existing Docker
deployments keep working unchanged.

**Tag everything.** Every AWS resource we create is tagged `cerebro:deployment=<id>` +
`cerebro:app=<appId>`. Teardown finds orphans by tag (not just by stored ARN) — far more robust than
the Docker path needs to be, because leaked AWS resources cost money.

## The target seam (replicator refactor)

`DeploymentService` calls the concrete `DockerStackService` directly today. Introduce a small
interface implemented by two backends:

```ts
interface DeployTarget {
  kind: 'docker' | 'ecs';
  deploy(project: string, src: StackGitSource, env: EnvMap,
         opts: DeployOpts, onProgress: (phase: string) => void): Promise<DeployResult>;
  destroy(project: string, refs: TargetRefs): Promise<{ problems: string[] }>;
  // docker-only extras (usedPorts/preflight) stay on the docker impl
}
```

- `DockerDeployTarget` — wraps today's `deployGit` / `down` / `purgeDir` / `remove` calls. No
  behavior change.
- `EcsDeployTarget` — orchestrates build-on-SSH → ECR push → register task def → create service →
  tunnel route, via `ConnectorInstanceService.runResourceOperationAwait` against the AWS **and**
  Docker (builder) connectors, exactly as ingress already does.

Target-agnostic code that **does not move**: the catalog, `compose-introspect.ts`, the var/role
model, secret resolution, `buildEnv`, and the DTO shapes.

## Teardown (first-class, tag-verified)

`remove()` for an ECS deployment, best-effort with problem collection like the Docker path:

1. **Ingress first** — delete the CF tunnel route(s) (`tunnel-delete-route`) so no hostname points at
   a dying task.
2. **ECS service** — `UpdateService` desiredCount=0 → `DeleteService`.
3. **Task defs** — `DeregisterTaskDefinition` for every revision in the family.
4. **ECR repo** — `DeleteRepository(force: true)` (removes the repo **and its images**).
5. **Log group** — `DeleteLogGroup`.
6. **Vault secrets** — sweep `deployment:<id>:*` (unchanged).
7. **Tag sweep** — list resources tagged `cerebro:deployment=<id>` via the Resource Groups Tagging
   API; anything still present is reported as a leaked-resource problem for retry.
8. Delete the row (ingress rows cascade) + audit event.

## Cost guardrail

Docker-on-your-own-hardware is free; **Fargate bills per running task** and the replicator makes
spinning up N instances trivial. The AWS connector's cost data is account-wide and ~24 h delayed —
**not** per-deploy attributed. So:

- Surface an **estimated $/mo** in the deploy wizard from the chosen cpu/memory (Fargate pricing is
  deterministic per vCPU-hour + GB-hour) before the user commits.
- Lean on the `cerebro:deployment` tags for cost allocation (the user can enable a Cost Allocation
  Tag in AWS) and reliable teardown.
- The connector's existing `costForecast`/`costMtd` metrics will reflect the new spend account-wide.

## RBAC & audit

Reuses the existing `replicator:write` (admin; **never** a bearer scope — this launches infra and
spends money). Every ECS deploy/teardown writes `replicator.*` audit events to Ship's Log, same as
Docker.

## Phasing

- **Phase 1 — AWS connector primitives.** ECR (new dep + create/auth/delete-force), ECS
  (register-task-def / create-service / deregister / delete-service, lazy create-cluster), CloudWatch
  Logs (create/delete-log-group). Tag every created resource. Unit-verifiable against a real account
  before any replicator wiring.
- **Phase 2 — Target seam + `EcsDeployTarget`.** Refactor `DeploymentService` to the `DeployTarget`
  interface (Docker impl unchanged), add the ECS impl: build-on-SSH → ECR push → task def (incl.
  `cloudflared` sidecar) → service → wait-for-RUNNING. Migration `0020_replicator_target` + the
  `EcsDeploymentProfile` config on the AWS connector. `listTargets()` includes AWS instances.
- **Phase 3 — Ingress + teardown + cost.** Reuse the CF `tunnel-add-route` path (localhost service),
  tag-verified teardown, estimated-cost surfacing in the wizard. Cloudflare-only ingress for ECS.
- **Fast-follows (not V2):** secrets via Secrets Manager instead of task env; ALB ingress option for
  users who want native AWS DNS; CodeBuild as an alternative builder; AWS CodePipeline-style
  auto-redeploy on `replicator.update_available` (the audit event already fires and an Automations
  rule can act on it, same as Docker).

## Safety & edge cases

- **Preflight before mutate** — creds valid (STS), cluster exists, execution role present, builder
  reachable, `compose config -q` — all before any AWS resource is created.
- **Tag-verified teardown** — orphans discoverable by tag, not just stored ARNs; partial failures
  surfaced and retryable, never silently half-removed (leaked Fargate tasks cost money).
- **Image build isolation** — each deployment pushes to its own ECR repo `cerebro/<project>` tagged
  by git commit; teardown force-deletes the repo and all images.
- **No IAM creation** — execution/task roles are referenced, never created by Cerebro.
- **Secrets** — tunnel token + secret-role vars injected at deploy time; deploy output `redact()`-ed;
  vault swept on teardown. (Secrets Manager is the hardening follow-up.)
- **Region** — one region per AWS connector instance (existing config); a deployment lives in that
  connector's region.

---

# Implementation plan (file-level)

> **Build status (2026-09-12):** Phase 1 ✅ and Phase 2 ✅ built — server `tsc` + shared build green,
> Prisma client regenerated, migration `0020_replicator_target` written. **Not committed, not
> live-tested** (needs a real AWS account + a Docker builder host). Phase 3 (ingress + cost + web UI)
> is next. Phase 2 landed the `dockerInstanceId` column *name* as-is (it holds the target instance id
> for both kinds) rather than renaming it — additive columns only, to avoid a web/controller blast
> radius.

Three phases, each independently green + verifiable. Phase 1 is isolated (AWS connector only), so it
lands and gets tested against a real account before any replicator code changes. Phase 2 is the
behavior-preserving refactor + the ECS deploy engine. Phase 3 wires ingress, teardown, and cost.

Convention markers below: **[new]** = new file, **[mod]** = edit existing.

## Phase 1 — AWS connector primitives (no replicator changes yet)

**Goal:** the AWS connector can create/delete the ECR repo, task def, service, cluster, and log
group for a deployment, and read them back. Independently testable against a real AWS account via
the connector's own operation-run path.

| File | Change |
|---|---|
| `apps/server/package.json` **[mod]** | add deps `@aws-sdk/client-ecr`, `@aws-sdk/client-cloudwatch-logs` (pin to the same major as the other 12 `@aws-sdk/client-*`). |
| `apps/server/src/connectors/aws/aws-api.ts` **[mod]** | add lazy client getters `ecr` / `logs` (mirror the existing `ecs`/`ec2` getter pattern: `{ region: this.auth.region, credentials: this.credentials, maxAttempts: 3 }`). Add methods (all thin `AwsApi` wrappers): `ensureEcrRepo(name, tags)` → `CreateRepository` (idempotent: swallow `RepositoryAlreadyExistsException`); `ecrAuthToken()` → `GetAuthorizationToken` (returns `{ endpoint, username:'AWS', password }`, base64-decoded); `deleteEcrRepo(name)` → `DeleteRepository({force:true})`; `registerTaskDef(input)` → `RegisterTaskDefinition` (returns family + revision + ARN); `deregisterTaskDef(arn)`; `listTaskDefRevisions(family)` → `ListTaskDefinitions({familyPrefix})`; `createEcsService(input)` → `CreateService`; `deleteEcsService(cluster, service)` → `UpdateService{desiredCount:0}` then `DeleteService`; `ensureCluster(name, tags)` → `DescribeClusters`/`CreateCluster`; `waitServiceStable(cluster, service, timeoutMs)` (poll `DescribeServices` until `runningCount>=desired` or timeout); `createLogGroup(name, tags)` (swallow `ResourceAlreadyExistsException`); `deleteLogGroup(name)`; `resourcesByTag(tagKey, tagValue)` → Resource Groups Tagging API `GetResources` (for teardown orphan sweep — add `@aws-sdk/client-resource-groups-tagging-api` here too). Reuse the existing `AwsAuth`/`credentials` plumbing untouched. |
| `apps/server/src/connectors/aws/aws.connector.ts` **[mod]** | register new operations in `manifest.resourceKinds` (or a small set of non-scoped `create` ops on the `ecs` kind) and dispatch them in the operation handler, following the existing `launch-ec2` / `ecs-scale-service` precedent. Operation ids: `ecr-ensure-repo`, `ecr-auth-token`, `ecr-delete-repo`, `ecs-register-taskdef`, `ecs-create-service`, `ecs-delete-service`, `ecs-deregister-taskdef`, `logs-create-group`, `logs-delete-group`, `tags-get-resources`. Each just calls the matching `AwsApi` method with `this.authFrom(ctx)`. **Tag** every create call with `cerebro:deployment` / `cerebro:app` passed through `values`. |

**Acceptance:** `pnpm -F server tsc` green; against a throwaway AWS account, drive each op via the
existing connector operation-run endpoint (or a scratch script) — create a repo, get an auth token,
register a trivial task def, create+delete a service on a scratch cluster, create+delete a log group.
Confirm `resourcesByTag('cerebro:deployment','test')` returns the tagged resources.

## Phase 2 — Target seam + `EcsDeployTarget` + migration

**Goal:** the replicator can build→push→run an app on Fargate. The Docker path is refactored behind
an interface but behaves identically.

### 2a — the seam (behavior-preserving refactor)

| File | Change |
|---|---|
| `apps/server/src/app-replicator/deploy-target.ts` **[new]** | define `interface DeployTarget { kind:'docker'|'ecs'; deploy(project, src, env, opts, onProgress): Promise<DeployResult>; destroy(project, refs, onProgress?): Promise<{problems:string[]}>; }` plus `DeployResult { ok; message; deployedCommit?; refs?: TargetRefs }` and `TargetRefs = DockerRefs | EcsDeploymentRefs`. |
| `apps/server/src/app-replicator/docker-deploy-target.ts` **[new]** | `DockerDeployTarget implements DeployTarget` — moves today's `stacks.deployGit` / `down` / `purgeDir` / `remove` calls out of `DeploymentService` verbatim. No logic change. Holds the injected `DockerStackService` + a `dockerTargetFrom(ctx)` resolved target. |
| `apps/server/src/app-replicator/deployment.service.ts` **[mod]** | replace the direct `DockerStackService` calls in `runDeployment` (~:229) and `remove` (~:273) with a resolved `DeployTarget`. Replace `targetFor()` (~:52) with `targetFor(kind, instanceId)` that returns a `DockerDeployTarget` or (2b) `EcsDeployTarget`. `buildEnv` (~:377) is unchanged and shared by both. Port preflight (`resolvePorts`/`preflightPorts`) is called **only** when `kind==='docker'`. |
| `apps/server/src/app-replicator/replicator.service.ts` **[mod]** | `listTargets()` (~:114) returns Docker instances **and** AWS instances whose config has a complete `EcsDeploymentProfile`; each row carries `targetKind`. |

### 2b — the ECS engine + data model + config

| File | Change |
|---|---|
| `apps/server/prisma/schema.prisma` **[mod]** | on `ReplicatorDeployment`: add `targetKind String @default("docker")`, rename `dockerInstanceId`→`targetInstanceId` (keep index), add `ecs Json?`. |
| `apps/server/prisma/migrations/0020_replicator_target/…` **[new]** | `ALTER TABLE … RENAME COLUMN dockerInstanceId TO targetInstanceId`; add `targetKind` (default `'docker'`, back-fills existing rows); add nullable `ecs`. |
| `packages/shared/src/replicator.ts` **[mod]** | `Deployment`: swap `dockerInstanceId` for `targetKind` + `targetInstanceId`, add `ecs?: EcsDeploymentRefs`. Add `EcsDeploymentProfile`, `EcsDeploymentRefs`, and `taskCpu?/taskMemory?` to `DeployInput`. `ReplicatorTarget` gains `targetKind`. |
| `apps/server/src/app-replicator/ecs-deploy-target.ts` **[new]** | `EcsDeployTarget implements DeployTarget`, injects `ConnectorInstanceService`. `deploy()` orchestration, each step emitting a phase via `onProgress`: **(1)** resolve the AWS instance's `EcsDeploymentProfile` + a builder Docker instance; **(2)** build+push on the builder host (see below); **(3)** `ecr-ensure-repo`; **(4)** compose→task-def JSON via a new `composeToTaskDef(app, values, env, ecrUri, profile, ports)` incl. the `cloudflared` sidecar; **(5)** `logs-create-group`; **(6)** `ecs-register-taskdef`; **(7)** `ecs-create-service` (or update if exists); **(8)** `waitServiceStable`. Returns `refs: EcsDeploymentRefs` + `deployedCommit`. All AWS calls go through `instances.runResourceOperationAwait(awsInstanceId, opId, undefined, values)`. |
| `apps/server/src/app-replicator/compose-to-taskdef.ts` **[new]** | pure translator: compose services → one task def with N app containers + a `cloudflared` sidecar; `environment` from `buildEnv`'s map; `logConfiguration` = awslogs → the log group; `portMappings` = container ports; task-level `cpu`/`memory` from input/defaults; `executionRoleArn`/`taskRoleArn` from profile; `networkMode:'awsvpc'`, `requiresCompatibilities:['FARGATE']`. Unit-testable in isolation. |
| `apps/server/src/app-replicator/ecs-builder.service.ts` **[new]** | build+push on a Docker connector host over SSH, reusing the connector's existing `runSsh`/git transport: clone/pull → `docker build -t <ecrUri>` → `docker login` (password from `ecr-auth-token`, fed on **stdin**, never argv) → `docker push`. Returns the pushed `<ecrUri>` + resolved git commit. Emits phase markers. |
| `apps/server/src/connectors/aws/aws.connector.ts` **[mod]** | add `EcsDeploymentProfile` fields to the AWS connector's config manifest (cluster, subnetIds, securityGroupIds, taskExecutionRoleArn, taskRoleArn?, assignPublicIp?, builderInstanceId?, cloudflareInstanceId?); reuse existing `DescribeSubnets`/`DescribeSecurityGroups` option sources for the subnet/SG pickers. |
| `apps/server/src/app-replicator/app-replicator.module.ts` **[mod]** | provide `DockerDeployTarget`, `EcsDeployTarget`, `EcsBuilderService`. |

**Acceptance:** `pnpm -F server tsc` + `pnpm -F shared tsc` green. **Regression:** an existing Docker
deployment still deploys/redeploys/tears down unchanged (the seam is behavior-preserving). **New:**
against a real account + a builder Docker host, deploy `hrDemoWebApp` to Fargate — service reaches
RUNNING, container serves on its port inside the task, `ecs` refs persisted, `cerebro:deployment` tag
present on repo/service/log-group.

## Phase 3 — Ingress + tag-verified teardown + cost

**Goal:** public hostname via the CF sidecar, clean teardown, and a cost estimate in the wizard.

| File | Change |
|---|---|
| `apps/server/src/app-replicator/ingress.service.ts` **[mod]** | for a `targetKind==='ecs'` deployment, `add()` skips `hostIpFor()` and uses `service: http://localhost:<containerPort>` (the sidecar shares the task netns); still calls `tunnel-add-route` with `createDns:true` on the CF instance from the profile. Hide/deny NPM for ECS targets. Teardown route deletion (`tunnel-delete-route`) is unchanged. |
| `apps/server/src/app-replicator/ecs-deploy-target.ts` **[mod]** | implement `destroy(project, refs)`: `tunnel-delete-route` (via ingress) → `ecs-delete-service` (scale 0 then delete) → `ecs-deregister-taskdef` for every revision from `listTaskDefRevisions` → `ecr-delete-repo` → `logs-delete-group` → `tags-get-resources('cerebro:deployment', id)` and report any still-present ARNs as `problems`. Best-effort, collects problems like the Docker path. |
| `apps/server/src/app-replicator/deployment.service.ts` **[mod]** | `remove()` (~:273) already runs ingress-first + vault sweep; route the stack/service teardown through the resolved `DeployTarget.destroy()` so ECS and Docker share the ordering + problem-collection. |
| `apps/server/src/app-replicator/ecs-cost.ts` **[new]** | pure `estimateMonthlyUsd(cpu, memory, region)` from Fargate per-vCPU-hour + per-GB-hour rates (static table, `assignPublicIp` note). |
| `packages/shared/src/replicator.ts` **[mod]** | `DeployInput`/preview response carry `estimatedMonthlyUsd`. |
| `apps/server/src/app-replicator/app-replicator.controller.ts` **[mod]** | preflight/preview endpoint returns the estimate for ECS targets; STS `GetCallerIdentity` + cluster-exists + role-present + builder-reachable checks. |
| `apps/web/src/pages/Replicator.tsx` **[mod]** | target picker shows Docker + AWS instances (badge per `targetKind`); ECS branch hides port-allocation UI, shows cpu/mem selectors + **estimated $/mo**, and offers Cloudflare-only ingress. Deployment row/detail render ECS refs (service, cluster, image) alongside the existing Docker fields. |

**Acceptance:** end-to-end on a real account: deploy `hrDemoWebApp` to Fargate with a CF hostname →
the tunnel serves the app; delete the deployment → service/task-defs/ECR repo/log group/CF route all
gone, `tags-get-resources` returns empty, vault keys swept, row deleted; wizard shows a sane $/mo
before deploy.

## Cross-phase notes

- **RBAC/audit:** no new perms — reuse `replicator:write` (admin, never a bearer scope). Emit the
  same `replicator.<kind>_started` / `replicator.<kind>` / `_failed` audit events; ECS phase markers
  reuse the existing `phase` column + 2.5 s poll.
- **Timeouts:** the build-on-SSH step reuses `DockerStackService`'s raised SSH timeouts (build 30 m);
  `waitServiceStable` gets its own bounded timeout → `error` status, never an infinite hang.
- **Deploy = follows the existing async worker:** `deploy()` does fast checks sync (creds/cluster/
  role/builder), then fire-and-forget `runDeployment` calls `DeployTarget.deploy` with the phase
  callback — same control flow as Docker today.
- **Migration ordering:** `0020_replicator_target` supersedes the Docker-target-only
  `0019_replicator_phase` numbering already used — pick the next free migration number at build time
  (likely `0020_replicator_target`) and keep the phase migration intact.
