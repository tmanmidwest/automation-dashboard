# App Replicator — AWS ECS target live-test walkthrough

A hands-on script to exercise the **ECS/Fargate deploy target** (Phases 1–3) end to end against a
real AWS account: configure the profile → register → deploy to Fargate → reach it through the ALB +
Cloudflare → redeploy → tear the whole thing down and confirm nothing is left. Follow top to bottom.
See [app-replicator-ecs-target.md](app-replicator-ecs-target.md) for the design, and
[app-replicator-live-test.md](app-replicator-live-test.md) for the Docker-target walkthrough.

> **This target spends real money.** Fargate bills per running task, and the shared ALB is ~$16+/mo
> per connector while it exists. Use a throwaway/sandbox account, and actually run the teardown (step
> 7) — a leaked service or ALB keeps charging.

> Acceptance app: **hrDemoWebApp** (`github.com/tmanmidwest/hrDemoWebApp`). Its `hr-sot` service
> builds from the repo and serves HTTP, so it's a good single-service Fargate subject. (Its second
> service, `hr-mcp`, becomes a co-located container in the same task; only the primary published port
> is fronted by the ALB — see the multi-port note in step 3.)

---

## 0. Prerequisites

### 0a. Rebuild the image
The ECS target adds migrations and new dependencies, so the container must be rebuilt:
- **Migrations `0020_replicator_target`** (adds `targetKind` + `ecs` to `ReplicatorDeployment`) and
  **`0021_replicator_ingress_meta`** (adds `meta` to `ReplicatorIngress`) apply on entrypoint.
- New npm deps: **`@aws-sdk/client-ecr`**, **`@aws-sdk/client-cloudwatch-logs`**,
  **`@aws-sdk/client-resource-groups-tagging-api`**, and **`js-yaml`** (compose→task-def parsing).
- The existing **`git`** in the image (Docker target) is still used by the builder step.

Rebuild + restart, sign in as **admin**.

### 0b. A Docker connector to use as the image builder (required)
Fargate needs a registry image, and Cerebro has no build farm — it builds + pushes on a Docker host
over SSH. You need a **Docker connector with SSH configured** (same as the Docker target's 0b) whose
host has **Docker + git** and **egress to ECR and Docker Hub** (to pull base images during the build).
No AWS CLI is needed on the host — Cerebro fetches the ECR token and pipes it to `docker login`.

**Verify:** the connector shows deployable in the App Replicator deploy dialog (Docker target).

### 0c. AWS IAM — an access key for the connector
Create an IAM user (or role) and an access key. Attach a policy allowing at least:
- **STS**: `sts:GetCallerIdentity`
- **ECR**: `ecr:CreateRepository`, `DescribeRepositories`, `DeleteRepository`, `GetAuthorizationToken`,
  and the push set (`BatchCheckLayerAvailability`, `InitiateLayerUpload`, `UploadLayerPart`,
  `CompleteLayerUpload`, `PutImage`)
- **ECS**: `ecs:CreateCluster`, `DescribeClusters`, `RegisterTaskDefinition`, `DeregisterTaskDefinition`,
  `ListTaskDefinitions`, `CreateService`, `UpdateService`, `DeleteService`, `DescribeServices`
- **ELBv2** (`elasticloadbalancing:*` on the create/describe/delete verbs): `CreateLoadBalancer`,
  `DescribeLoadBalancers`, `CreateListener`, `DescribeListeners`, `CreateTargetGroup`,
  `DeleteTargetGroup`, `CreateRule`, `DeleteRule`, `DescribeRules`
- **EC2**: `DescribeSubnets`, `DescribeSecurityGroups`, `AuthorizeSecurityGroupIngress`
- **CloudWatch Logs**: `logs:CreateLogGroup`, `logs:DeleteLogGroup`
- **Tagging**: `tag:GetResources`
- **IAM**: `iam:PassRole` for the task execution role (below) — ECS needs it to launch tasks

One region per connector.

### 0d. Pre-provisioned AWS infrastructure (Cerebro selects, never creates)
Create these once in the connector's region and note their IDs:
- **Task execution role** — an IAM role (e.g. `ecsTaskExecutionRole`) with the AWS-managed
  `AmazonECSTaskExecutionRolePolicy` (grants ECR pull + logs write). Note its **ARN**.
- **Subnets** — at least **two** in different AZs. For the simplest path use **public** subnets
  (internet-facing ALB + `assignPublicIp` gives the task egress for the ECR pull without a NAT). Note
  the **subnet IDs**.
- **Task security group** — allows all **egress** (inbound is added automatically from the ALB SG).
  Note its **ID**.
- **ALB security group** — allows **inbound TCP 80** (from anywhere, or restrict to Cloudflare's IP
  ranges). Note its **ID**.

### 0e. Configure the ECS profile on the AWS connector
On **Connectors → your AWS connector → config**, fill the App Replicator ECS fields:
- **ECS cluster**: blank (defaults to `cerebro`, created if absent) or an existing cluster name
- **ECS subnet IDs**: the 0d subnets, comma-separated
- **ECS security group IDs**: the task SG
- **ECS ALB security group IDs**: the ALB SG
- **ECS task execution role ARN**: the 0d role ARN
- **ECS assign public IP**: `true` (public subnets, no NAT)
- **ECS image builder**: the **id of the Docker connector** from 0b (find it in the URL on its
  connector page, or via the connectors list)
- **ECS ingress Cloudflare connector id**: optional; leave blank (ingress picks the CF connector in
  the dialog)

**Verify:** on **App Replicator → Deploy**, the **Target** dropdown now lists this connector as
**"… — AWS ECS (\<region\>)"**. If it's missing, the profile is incomplete (subnets + execution role
+ builder are the minimum) — the connector is only offered when the profile is complete.

### 0f. A Cloudflare connector (for ingress, step 4)
Have a **Cloudflare** connector connected whose API token can manage a **zone** you own (DNS edit).
Skippable if you only want to test deploy + teardown.

---

## 1. Register the app

Identical to the Docker walkthrough — registration is target-agnostic.
1. **App Replicator → Register app** → Git URL `https://github.com/tmanmidwest/hrDemoWebApp.git`,
   ref `main`, credential if private.
2. **Introspect repo** → confirm services **hr-sot, hr-mcp** and the detected variables, name it
   (e.g. `HR Demo`), **Register app**.

**✅ Verify:** the app card appears.

---

## 2. Deploy to Fargate

1. On the app card, **Deploy**.
2. **Target** = your AWS ECS connector. **Deployment name** = `acme-ecs` (becomes the ECS service /
   task-def family / ECR repo suffix / log group). Click **Next: configure**.
   - *(No port-preflight step runs for ECS — Fargate has no host ports.)*
3. Set **Task CPU** = 0.25 vCPU and **Task memory** = 0.5 GB (defaults). Confirm the **estimated
   $/mo** line appears.
4. Fill the variable form (secrets + plain vars only — host-port/bind-address vars are hidden for
   ECS). Generate `HRSOT_SESSION_SECRET`; leave others at defaults.
5. Leave **Force rebuild image** checked → **Deploy**.

> The row appears **pending** with live phases: *Preparing ECR repository… → Cloning… → Building
> image… → Pushing to ECR… → Translating compose… → Ensuring the load balancer… → Ensuring ECS
> cluster… → Ensuring log group… → Registering task definition… → Deploying the Fargate service… →
> Waiting for a steady state…* First build + push takes several minutes.

**✅ Verify the deploy** (app side): the row shows the sky **ECS** pill, **· deployed**, `cluster
<name>`, and a short commit. **Ship's Log**: `replicator.deploy`.

**✅ Verify on AWS** (CLI, same region/creds):
```bash
aws ecr describe-repositories --repository-names cerebro/acme-ecs
aws ecs describe-services --cluster cerebro --services acme-ecs \
  --query 'services[0].{status:status,running:runningCount,desired:desiredCount}'
aws elbv2 describe-target-groups --names cbo-acme-ecs \
  --query 'TargetGroups[0].TargetGroupArn'
# tasks should register as healthy targets once they pass the health check:
aws elbv2 describe-target-health --target-group-arn <tg-arn> \
  --query 'TargetHealthDescriptions[].TargetHealth.State'
```
Expect the service `ACTIVE` with `running` reaching `desired` (1), and the target `healthy`.
Everything is tagged `cerebro:deployment=<id>` / `cerebro:project=acme-ecs`.

> **Health check:** the target group health-checks `GET /` expecting `200–399`. If the app's `/`
> doesn't answer in that range the task stays `unhealthy` and the ALB returns 503 (see
> Troubleshooting). hrDemoWebApp's root responds, so it should go healthy.

---

## 3. (Multi-service note)

The whole compose becomes **one task definition** with both `hr-sot` and `hr-mcp` as co-located
containers (they reach each other on `localhost`, as in a single-host compose). Only the **primary
published port** (the first service with a port — `hr-sot:8000`) is wired to the ALB target group.
`hr-mcp` runs but isn't independently load-balanced. That's expected for this version.

---

## 4. Ingress — a hostname via Cloudflare → the ALB

On the `acme-ecs` row, click the **🌐 globe** → the ECS ingress panel (Cloudflare-only).
1. **Cloudflare connector** = your CF connector.
2. **Hostname** = e.g. `acme-ecs.yourdomain.com` (must sit under a zone that connector manages).
3. **Add hostname.**

**✅ Verify:**
- A chip/link to `https://acme-ecs.yourdomain.com` appears.
- **On AWS**: a new **listener rule** (host-header = your hostname → the target group):
  ```bash
  aws elbv2 describe-rules --listener-arn <listener-arn> \
    --query 'Rules[?Conditions[?HostHeaderConfig]].{prio:Priority,cond:Conditions}'
  ```
- **In Cloudflare**: a proxied **CNAME** `acme-ecs → <alb-dns-name>.elb.amazonaws.com`.
- **Load `https://acme-ecs.yourdomain.com`** — it serves the app (CF terminates TLS, forwards to the
  ALB on HTTP:80, which routes to the task). Allow a minute for DNS + the target to go healthy.
- **Ship's Log**: `replicator.ingress_add`.

*(Add a second hostname to confirm multiple rules → the same target group work. Teardown removes all.)*

---

## 5. Redeploy & idempotency

Click **redeploy** (↻) on the `acme-ecs` row. It rebuilds + pushes a new image tag, registers a new
task-def revision, and updates the service (reusing the existing ALB/target group — no duplicate TG).

**✅ Verify:** the row returns to **deployed**; `aws ecs describe-services` shows a new deployment
rolling out; the ALB rule + DNS from step 4 are unchanged and the hostname still serves.

---

## 6. Edit & redeploy (optional)

Use the **✏️ pencil** to change a plain var or rotate a secret, then redeploy. Confirm the change
takes effect and secrets left blank are preserved (re-read from the vault).

---

## 7. Teardown (the money-saver — verify everything is gone)

On the `acme-ecs` row, **🗑 trash → confirm**.

**✅ Verify the full cleanup** (ingress is torn down first, then the backend):
```bash
# service gone (or draining → gone):
aws ecs describe-services --cluster cerebro --services acme-ecs \
  --query 'services[0].status'          # -> "INACTIVE" or not found
# target group gone:
aws elbv2 describe-target-groups --names cbo-acme-ecs   # -> LoadBalancerNotFound/TargetGroupNotFound
# ECR repo + images gone:
aws ecr describe-repositories --repository-names cerebro/acme-ecs   # -> RepositoryNotFoundException
# log group gone:
aws logs describe-log-groups --log-group-name-prefix /cerebro/acme-ecs   # -> empty
# nothing left tagged for this deployment:
aws resourcegroupstaggingapi get-resources --tag-filters Key=cerebro:project,Values=acme-ecs \
  --query 'ResourceTagMappingList[].ResourceARN'   # -> []
```
- **Cloudflare**: the CNAME(s) from step 4 are removed; the ALB listener rule(s) are gone.
- **Settings → Secrets**: `Replicator · acme-ecs · *` entries are deleted.
- The row disappears; **Ship's Log**: `replicator.ingress_remove` (if any) + `replicator.remove`.
- **The shared ALB (`cerebro-replicator`) intentionally remains** — it's shared across deployments.
  Delete it manually when you're done testing:
  ```bash
  aws elbv2 delete-load-balancer --load-balancer-arn \
    "$(aws elbv2 describe-load-balancers --names cerebro-replicator --query 'LoadBalancers[0].LoadBalancerArn' --output text)"
  ```

> If teardown reports a problem like "target group still in use", the service was still **draining**.
> Wait ~1 min and re-run the delete, or delete the target group manually — the teardown's tag sweep in
> the result names anything left behind.

---

## Verification checklist

- [ ] AWS connector shows as an **AWS ECS** deploy target once the profile is complete
- [ ] Deploy → ECR repo created, image pushed, task-def registered, service reaches `running=desired`
- [ ] Target registers **healthy** in the target group
- [ ] Deployment row shows the **ECS** pill + cluster; `replicator.deploy` on the timeline
- [ ] Ingress → ALB host-header rule + proxied CF CNAME; hostname serves the app over HTTPS
- [ ] Redeploy reuses the ALB/target group (no duplicate TG); hostname keeps working
- [ ] Teardown removes service + target group + ECR repo + log group + ALB rule + CF DNS + vault secrets
- [ ] Tag sweep (`cerebro:project=…`) returns empty after teardown
- [ ] Shared ALB deleted manually when finished

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Connector not offered as an ECS target | Profile incomplete — needs subnet IDs, a task execution role ARN, **and** an image builder Docker connector id (0e). |
| Deploy fails at "Preparing ECR repository" / auth | IAM key lacks ECR permissions, or wrong region (0c). |
| Build/push fails | The builder host can't reach ECR/Docker Hub, or lacks Docker/git; the row's error shows the host output. Egress from the builder is required. |
| `docker login` to ECR fails | IAM key lacks `ecr:GetAuthorizationToken` / push permissions (0c). |
| Service created but never steady; targets `unhealthy` | The app doesn't answer `GET /` with 200–399 (health check), the task SG doesn't allow the ALB SG on the container port (auto-authorized — check the SG), or `assignPublicIp` is false on a subnet with no NAT so the ECR pull fails. |
| `CreateLoadBalancer` fails "at least two subnets" | Provide ≥2 subnets in different AZs in the profile (0d). |
| `RegisterTaskDefinition` AccessDenied on PassRole | Add `iam:PassRole` for the execution role to the connector's IAM policy (0c). |
| Hostname 503s | Target not healthy yet (give it a minute), or the health check is failing (see above). |
| No Cloudflare zone matches the hostname | The chosen CF connector doesn't manage that domain's zone — pick the right connector / hostname. |
| Invalid CPU/memory combo | Fargate only allows specific CPU↔memory pairings; pick a valid combination (AWS rejects invalid ones). |
| Teardown leaves a target group | Service still draining — retry the delete shortly; the tag sweep flags leftovers. |

---

## What this proves vs. what's still stubbed

- **Proves**: the ECS deploy target end to end — ECR build/push over SSH, compose→task-definition
  translation, cluster/log-group provisioning, the Fargate service, the shared ALB + per-deployment
  target group + host-header rules, Cloudflare DNS ingress, redeploy reuse, and **tag-verified
  teardown** of every created resource.
- **Not covered / limitations**: one image built per deployment (multi-Dockerfile repos unhandled),
  compose **volumes ignored** (Fargate), `desiredCount` fixed at 1, secrets injected as task **env**
  (Secrets Manager is a fast-follow), the ALB is HTTP:80 behind Cloudflare's TLS, only the primary
  published port is load-balanced, and the shared ALB is left for manual deletion.
