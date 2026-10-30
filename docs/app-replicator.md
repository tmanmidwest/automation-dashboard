# App Replicator (deploy apps from Git → Docker → ingress)

Design + implementation plan for a top-level feature — **App Replicator** — that lets Cerebro
**register an app from a Git repo once, then materialize it as many isolated instances** onto a
Docker host — resolving the app's variables, picking free ports, and (optionally) exposing it
through a Cloudflare tunnel or Nginx Proxy Manager. It turns Cerebro from a thing that *monitors*
your infra into a thing that *ships apps onto* it. The metaphor: a **pattern** in the catalog,
**replicated** into running instances on demand.

Like [Automations](automations.md), this engine invents very little: the deploy transport, the
vault, and the ingress writes all already exist. The new work is the **catalog**, the **repo
introspection** (compose file → variable/port schema), **port allocation**, and the **wizard** that
stitches these together.

## The two objects

- **App (catalog entry)** — a reusable template registered *once*: a Git repo + credential, which
  compose file to use, and the variable/port schema detected from that compose file. Think
  "`hrDemoWebApp`, main branch, `docker-compose.yml`".
- **Deployment** — one running instance of an App on a target host: resolved variable values,
  allocated host ports, the vault keys holding its secrets, and any ingress it was given. One App →
  **many** Deployments (`hr-demo/acme`, `hr-demo/poc-3`, `hr-demo/testing`), each isolated by its
  own image tag / container name / ports.

This 1-app-to-N-deployments shape is the POC use case directly: register the demo app once, spin up
a fresh isolated instance per prospect.

## Why this rides on existing plumbing

| Need | Reused from |
|---|---|
| Clone/pull repo on a host over SSH, `docker compose up -d`, force-rebuild, record commit, keep rollback revisions, **accepts an `env` map** | `DockerStackService.deployGit(target, instanceId, name, src, opts)` |
| "Is there an upstream update?" (local vs remote commit) | `DockerStackService.checkDrift()` |
| Git credentials, shared across apps | Vault `kind='git'` secrets + `{$secretRef}` resolution |
| Store/reveal per-deployment secrets | `SecretsService.set()` / `.reveal()` / `.remove()` |
| Create a Cloudflare tunnel ingress route + proxied CNAME | CF connector `tunnel-add-route` operation |
| Create an NPM proxy host → host:port with an existing cert | NPM connector `create-proxy-host` operation |
| Run a connector operation from another feature | `ConnectorInstanceService.runOperationAwait(id, opId, values)` |
| Top-level cross-connector screen precedent | Docker Fleet (`/docker-fleet`, own module + nav entry) |

**Architecture decision:** this is a **top-level feature module** (`AppReplicatorModule`), *not* code
inside the Docker connector — because it orchestrates Docker **plus** Cloudflare **plus** NPM (and,
in V2, AWS). It calls those connectors through `ConnectorInstanceService`, exactly as Automations
does.

## The compose file *is* the manifest

The central trick: we don't ask you to author a manifest. We read the app's compose file and derive
everything from Docker Compose's own `${VAR:-default}` interpolation — plus, for apps that configure
themselves through an `env_file:` instead, the env file the repo commits (see [Env
files](#env-files-env_file--envexample)). From the demo app:

```yaml
image:          ${HRSOT_IMAGE:-demo-hr-sot:local}      # → per-instance image tag (auto-managed)
container_name: ${HRSOT_CONTAINER_NAME:-demo-hr-sot}   # → per-instance name (auto-managed)
ports:        - "${HRSOT_HOST_PORT:-8000}:8000"        # → PUBLISHED PORT var, default 8000
environment:    HRSOT_SESSION_SECRET: ${HRSOT_SESSION_SECRET:-}   # → SECRET-shaped var (empty default)
                HRSOT_LOG_LEVEL: ${HRSOT_LOG_LEVEL:-INFO}         # → plain var, default INFO
```

The introspector parses the compose file into a **VariableSpec[]**:

```ts
interface VariableSpec {
  name: string;               // HRSOT_HOST_PORT
  default?: string;           // "8000" (from :-default), or undefined
  role: 'host_port' | 'image_tag' | 'container_name' | 'secret' | 'plain';
  service: string;            // which compose service it belongs to
  containerPort?: number;     // for host_port: the fixed internal port (":8000")
  required: boolean;          // true when there is no default
  source: 'compose' | 'env_file' | 'manual';  // provenance — see "Env files" below
  envFile?: string;           // which env file it came from (source === 'env_file')
  comment?: string;           // the repo's own `#` documentation for the key
}
```

Role detection:
- **host_port** — the variable appears on the host side of a `ports:` `"${X}:NNNN"` mapping. Ports
  that don't interpolate a variable are handled separately — see *Reachable ports* below.
- **image_tag** / **container_name** — appears in `image:` / `container_name:`. These are
  **auto-managed** per deployment (Cerebro sets them so instances never collide); hidden from the
  user form.
- **secret** — heuristic: name matches `/secret|password|token|key|pass/i`, **whether or not it has
  a default**. A baked-in default secret (e.g. the demo's `HRSOT_INITIAL_ADMIN_PASSWORD`) is a smell
  we *want* surfaced: it's flagged secret, its default is shown as a masked prefill, and we offer
  **"regenerate"**. Presented as a masked field, stored in the vault (see below). The user can
  toggle any variable's secret flag when registering the app, so the heuristic is only a starting
  guess.
- **plain** — everything else; a normal text field prefilled with its default.

A multi-service app (the demo publishes **two** ports — `hr-sot:8000` and `hr-mcp:8100`) yields
**two** `host_port` specs. Ingress is therefore modeled **per published port**, not per app.

### Reachable ports (not just `${VAR}` mappings)

`host_port` above only covers a port whose **host** side interpolates a `${VAR}` — the shape an app
written *for* Cerebro uses. Real-world repos bind ports every other way, and those were silently
missed (a repo with a hardcoded `8123:8123`, or `network_mode: host`, registered with nothing to
expose, so ingress couldn't be set up). The introspector now parses `ports:` **structurally**,
whether or not a `${VAR}` is present, and anything not backed by an adjustable variable becomes a
**`ReplicatorFixedPort`** (stored on the app alongside its variable schema, since deploy reads the
stored schema rather than re-reading the repo):

| Compose shape | Becomes |
| --- | --- |
| `"${APP_PORT:-8080}:80"` | a `host_port` **variable** (adjustable per deployment) — unchanged |
| `"8123:8123"` (literal) | a fixed port, `adjustable: false` — can't be remapped per instance |
| `"3000-3002:3000-3002"` | a fixed port range |
| `"51820:51820/udp"` | a fixed port, `protocol: 'udp'` |
| `target:/published:` long form | parsed the same way (literal → fixed, `${VAR}` → variable) |
| `network_mode: host` | a **host-network** fixed port, its number inferred from a `PORT`-style env var |
| `"8080"` (container-only) | **skipped** — Docker assigns an ephemeral host port, nothing to target |

**Host-network inference is deliberately conservative.** A service with `network_mode: host` binds
the host directly, so there's no mapping to read; Cerebro takes the port from an env var named
exactly `PORT`, or a single `*_PORT` with a numeric default (bambuddy's `PORT=${PORT:-8000}`). When
that var is adjustable the reachable port tracks the operator's chosen value. If it's ambiguous,
Cerebro infers nothing and warns, rather than guessing the wrong port.

**Every reachable port is preflighted** against the host's bound ports before a deploy, so a
collision is caught up front with an actionable message rather than a container that fails to bind:
a parameterized port says *pick a different host port*; a host-network port backed by an env var says
*change `<VAR>`* (its own field in the form); a hardcoded literal says *free it on the host or edit
the compose*. The deploy form also runs this check **live** for host-network ports, flagging a clash
(and clearing to a ✓) as you edit the backing variable. All reachable ports land in the deployment's
stored `ports`, so the preflight and the ingress picker see every one however the repo declared it.
A redeploy excludes the deployment's own currently-bound ports, so it never conflicts with itself.

**The escape hatch.** No heuristic covers every repo, so the register and refresh dialogs carry an
**Add a reachable port** control (host port, container port, published vs host-network). A
hand-added port is `source: 'manual'` and, like a hand-added variable, survives a schema refresh.
This is what keeps a repo that binds its port in some unreadable way from being a dead end.

**The remaining limitation:** a *hardcoded* literal host port can't be moved (Cerebro doesn't rewrite
the compose), so you can't run two instances of such an app on one host — the preflight will correctly
refuse the second. A host-network port backed by an env var is **not** subject to this — change the
var. A `docker-compose.override.yml` that remaps a hardcoded port is a possible follow-up; it's purely
additive on top of this.

### Env files (`env_file:` / `.env.example`)

Plenty of apps don't interpolate anything — the compose says `env_file: .env` and the repo commits a
`.env.example` documenting every key. Compose interpolation alone would find **nothing** there, so
the introspector reads the env file too and folds its keys into the same `VariableSpec[]`.

Which file it reads:

- **Every path the compose declares** via `env_file:` (scalar, list, and long `- path:` forms). The
  real file is almost always gitignored, so each path is tried as-is and then with `.example`,
  `.sample`, `.template`, `.dist`.
- **When compose declares none:** the committed `.env.example`-style file beside the compose, else
  at the repo root — compose auto-loads a `.env` from the project directory, so that file describes
  variables the app expects just as much as an explicit declaration.

How an entry becomes a variable:

| Env-file entry | Becomes |
| --- | --- |
| `TZ=Etc/UTC` | plain, default `Etc/UTC` |
| `DB_PASSWORD=changeme` | **secret, required, no default** — a committed sample credential must never become a live deployment's password |
| `SMTP_HOST=` | plain, no default, optional (a blank sample is ambiguous; blocking the deploy on it would be worse than leaving the key unset) |
| `# The location…` above an entry | that variable's help text in the form |

**Compose wins on overlap.** Only compose knows a name is a published port, an image tag or a
container name, so a variable in both keeps its compose role — but the env file's sample value fills
a default compose didn't declare, and its comment becomes the field's help text.

**Provenance changes what "leave it blank" means.** A compose `${VAR:-default}` left blank is simply
omitted from the `.env` — compose applies its own default. An env-file or hand-added variable has no
such fallback: its default exists only in Cerebro's schema, so `buildEnvMap` writes it out, or the
key would reach the container unset. Secrets are excluded from that — the sample is never reused.

**Caveat — Cerebro writes exactly one file:** `.env` beside the compose file. That's both the
compose default and the overwhelmingly common `env_file:` target, but a compose reading
`config/app.env` gets a warning at register time saying the values will land in `.env` instead.

**ECS:** Fargate has no `.env` to write, so `fileEnvOf()` picks out the env-file and hand-added
variables and `composeToTaskDef` injects them into every container's `environment`, beneath anything
the compose `environment:` block sets explicitly (mirroring compose, where `environment:` overrides
`env_file:`).

### Adding variables by hand (app-wide)

Some apps read a key that neither the compose nor any committed env file mentions. The register and
refresh dialogs both carry an **Add a variable** row (name, optional default, `secret` toggle) that
appends a `source: 'manual'` variable to the app's schema. It flows through the deploy form, the
vault and the written `.env` exactly like a detected one.

Hand-added variables are **preserved across a schema refresh** — they have no counterpart in the
repo, so re-reading it could never "find" them; `mergeSchema` carries them through instead of
reporting them removed. If the repo later declares the same name, the repo's version wins.

These are **app-wide** — every deployment gets the variable, with its own value. For a key only one
instance needs, use the per-deployment extras below.

### Per-deployment extras

The app schema is shared by every instance of an app. Some keys aren't: something one instance needs
and the others don't, or a value that differs per deployment. The deploy wizard and the
**Edit & redeploy** dialog both carry an **Additional environment** grid — name, value, `secret`
toggle — plus a **Paste .env** box that parses pasted `KEY=value` lines into rows (credential-looking
names arrive pre-flagged secret).

Storage mirrors the schema variables: non-secret entries live on the deployment row
(`extraEnv` JSON), secret ones in the vault under the *same* `deployment:<id>:<name>` keys as
`secretVars`, so teardown cleans both up in one pass.

`splitExtras()` in `DeploymentService` is the edge that keeps free-form input safe to write into a
`.env`: a shell-safe name, no duplicates, and **no shadowing a schema variable** — an extra named
`APP_HOST_PORT` would silently fight the port allocator, so it's rejected rather than merged.

**Extras replace, they don't merge.** `RedeployInput.values`/`secrets` merge (a key left out keeps
its stored value, falling back to the repo default when cleared). Extras have no repo to fall back
to, so removal has to be expressible: the edit dialog submits the whole grid, an entry left out is
deleted, and its vault secret is removed right then rather than waiting for teardown. A blank value
on an entry already marked secret still means "keep the stored one".

### Per-deployment volume mounts

Env keys are the common per-instance addition; the other is a **volume** the repo's compose can't
know about — a NAS share, a host data directory. The deploy wizard and **Edit & redeploy** both carry
a **Volumes & mounts** grid (Docker target only — Fargate has no host filesystem): per row a `bind`
(an existing absolute host path) or a Docker `volume` (a named volume), the compose **service** it
attaches to, the absolute **container path**, and a read-only toggle. Stored as `extraMounts` JSON on
the deployment row; they **replace** rather than merge, exactly like extras.

**The override also carries the deployment's extra env.** An app's compose only receives an operator
extra if it interpolates it (`- KEY=${KEY}`) or pulls in the stack's `.env` via `env_file:`. Many apps
do neither for an *optional* key — bambuddy ships `BAMBUDDY_EXTERNAL_ROOTS` **commented out**, so writing
it to `.env` alone does nothing. So `renderComposeOverride` also injects the extra env straight into
each known service's `environment:`, which makes an extra take effect regardless of what the repo's
compose mentions. (`$` is doubled, like in the `.env` writer, since Compose interpolates the override
too.) The same `.env` is still written for the schema variables.

**How mounts reach the container — a generated compose override, never an edit of the repo.** The
replicator deploys the cloned compose verbatim (`docker compose -f <repo compose> up`). To add a
mount, `renderComposeOverride()` emits a second compose file —
`<stacksDir>/<project>/cerebro.override.yml`, written *beside* the clone (so a `git reset --hard`
can't touch it) — and `deployGit` passes it as an extra `-f`, which Docker merges over the base. The
base manifest stays pristine, so a schema refresh or an upstream change never clobbers the operator's
mounts. No mounts → the stale override is removed, so a deleted mount actually goes away. The override
uses the long mount syntax (a `:` in a path can't be misparsed) and sets `create_host_path: false` on
binds, so a host path that isn't there (a NAS share that didn't mount) fails loudly instead of
silently binding an empty local directory.

**`sanitizeMounts()` is the security edge.** A host bind punches straight through the per-instance
isolation that is the whole point of the replicator, so the server refuses the Docker socket and the
host paths that would hand a "deployment" the box (`/`, `/etc`, `/proc`, `/sys`, `/dev`, `/boot`,
`/root`, `/run`, `/var/run`, `/var/lib/docker`), requires absolute paths, blocks `..` traversal, and
requires the service to be a real one in the app's compose (so the override can't invent a phantom,
image-less service). Only these specific fields are exposed — deliberately **not** a raw compose
fragment, which would re-open `privileged`, `cap_add`, `network_mode`, or new services and dissolve
the isolation guarantee. Writes stay `replicator:write` + session-only and are audited with the
(re)deploy. Named volumes an operator adds are *not* removed on teardown (`docker compose down`
without `-v`), erring toward not destroying data.

### Seeing what actually got written

`GET /api/replicator/deployments/:id/env` resolves a deployment's environment **through the same
`buildEnvMap` call a redeploy makes** — same variables, same stored values, same revealed secrets and
extras — and labels every line with where it came from (`managed` / `compose` / `env_file` / `manual`
/ `extra`). The **Environment** button on a deployment row opens it.

This is the answer to "what did this instance actually get?", which the deploy form can only imply:
managed values are assigned at deploy time, env-file defaults are materialized, and a blank falls
back or doesn't depending on provenance. Resolving it through the real code path — rather than
re-deriving it for display — is the point: a preview that could disagree with the file would be worse
than none.

**Secrets are never echoed.** An entry's `value` is `null` when it's a secret; the response carries
the `vaultKey` instead. The vault's step-up-gated reveal stays the single audited path to plaintext —
a second, weaker door to the same value through a read-only screen would undercut it. The route needs
only `replicator:read`, which is safe precisely because of that.

**Drift check.** `GET …/env/drift` reads the `.env` actually on the host and compares it with what
Cerebro would write, so a hand-edit is visible *before* the next redeploy silently overwrites it. It
returns **key names only** — `onlyOnHost`, `missingOnHost`, `differing` — never host values, so it
can't become a side channel for reading secrets back off the box. ECS returns `available: false`
(no file to compare).

The host path comes from `gitStackEnvPath()`, exported from `DockerStackService` so the reader and
the writer derive it from the same validated logic instead of re-deriving it and silently comparing
against the wrong file.

**Repos with no compose file:** Cerebro generates one (`source-detect.ts`) and runs it through the
*same* introspector, so the variable form, per-instance image/name and port mapping work uniformly.
A repo with a `Dockerfile` gets a minimal wrapper (`build:` the repo, one parameterized port from its
`EXPOSE`). A repo with neither is matched against a few marker-file layouts, each built from an
inline Dockerfile (`dockerfile_inline`, Docker Compose 2.17+) on a stock base image:

| Layout | Detected by | Runs as |
|---|---|---|
| WordPress | `wp-includes/version.php` + `wp-config-sample.php` | `wordpress:php8.3-apache` with the repo copied in, plus a `mariadb:11` service; `WORDPRESS_DB_PASSWORD` required, uploads + DB in named volumes |
| Node | `package.json` with a `start` script | `node:22-alpine`, npm/yarn/pnpm by lockfile, `build` script if present, `PORT=3000` |
| PHP | `index.php` at the root | `php:8.3-apache` serving the repo root (no Composer install) |
| Static | `index.html` at the root | `nginx:alpine` serving the repo root |

Anything else fails introspection with a message asking for a Dockerfile or compose file. At deploy
time the compose is regenerated from the current checkout and written to
`<stacksDir>/<project>/docker-compose.cerebro.yml` — beside `repo/`, not inside it — with
`build.context: ./repo`, so the `.env` (which holds the deployment's secrets) is outside the build
context and never lands in an image or a web root. It is also stored on the managed stack row, so
the Docker connector's own redeploy/rollback rewrites it. If the repo later commits a real compose,
the next deploy uses that instead. Generated-compose apps deploy to Docker hosts only; the ECS
builder does a plain `docker build` of the repo and can't follow an inline Dockerfile.

**A ref that doesn't exist** (most often the form's `main` default on a repo whose branch is
`master`, like WordPress) no longer triggers a full-history clone: introspection falls back to the
remote's default branch with a warning, and the register form switches its ref to it.

## Deployment flow (the wizard)

1. **Pick the app** from the catalog, and a **name** for this deployment (→ compose project name,
   image tag, container name; sanitized, uniqueness-checked on the target).
2. **Pick the target** — a Docker connector instance (V1). Its SSH host IP is both the deploy target
   *and* the ingress forward host (per decision: the SSH host IP is always the host IP).
3. **Resolve variables** — a form generated from `VariableSpec[]`: plain fields prefilled with
   defaults; secret fields masked (blank secrets with a known pattern, e.g. a session secret, offer
   **"generate random"**); host-port fields prefilled with a **suggested free port** (see below).
4. **Ingress (optional)** — none / Cloudflare tunnel route / NPM proxy host, chosen **per published
   port**. Cerebro pre-fills `forward_host` = the target's SSH host IP and `forward_port` = the
   allocated host port; you supply the hostname (and pick a tunnel or a cert).
5. **Preflight check** — validate every chosen host port is free on the target (hard fail with the
   conflicting container named), `docker compose config -q` the rendered file, and confirm the
   ingress connector is reachable. This is the "error check when deploying" requirement.
6. **Deploy** — write secrets to the vault, assemble the env map, call `deployGit(env)`, then run
   the ingress operation(s). Record the `Deployment` row with its commit, ports, vault keys, and
   ingress references.

### Port allocation

Before suggesting/validating ports we ask the target what's already taken:
`docker ps --format '{{.Ports}}'` over the existing SSH transport (plus, optionally, listening
sockets) → the set of published host ports. Suggest the lowest free port at/above a per-app base;
**hard-fail preflight** if a user-chosen port is in that set. Cheap, uses `runSsh`, no new deps.

### Async deploys with live phases

The deploy request does only the **fast checks** synchronously — name uniqueness, port preflight,
required-value validation — so those errors surface immediately in the dialog. It then creates the
row (`pending`), stores the secrets, and hands the slow clone/build/`up` to a **background worker**
(`runDeployment`, fire-and-forget); the request returns right away and the dialog closes. The worker
streams **coarse phase markers** onto the row — *Queued… → Cloning… → Validating compose… → Building
images… → Starting containers…* — via a progress callback threaded into `deployGit`, and sets the
final `deployed`/`error` status + `lastMessage` when done. The page **polls every 2.5 s while any
deployment is in flight** so the phase + outcome update on their own; a settled page never polls.
Redeploy uses the same worker (`updating` status). Everything is logged: `replicator.<kind>_started`
+ the final `replicator.<kind>`/`_failed` audit events (Ship's Log) plus per-phase app-log lines.

No infinite hang: each SSH step has a raised, bounded timeout (`git` 5 min, `build` 30 min, `up` 10
min — the old flat 120 s could time out mid-build), so a stuck deploy always resolves to `error`.
Migration `0019_replicator_phase` adds the `phase` column.

## Secrets & lifecycle (vault)

The **encrypted vault is Cerebro's source of truth** for secret-role variables — Cerebro never
persists a secret in a Deployment row or anywhere in plaintext. Each is stored under a
deployment-scoped vault key and revealed only to assemble the `.env` handed to `docker compose` at
deploy time (the value necessarily lands in the stack's `.env` on the operator's own Docker host, as
compose interpolation requires — a derived artifact, not Cerebro's store; tightening its host-side
file mode is a hardening follow-up):

```
deployment:<deploymentId>:<VAR_NAME>     e.g. deployment:d_ab12:HRSOT_SESSION_SECRET
```

**Cleanup is a first-class requirement.** Deleting a Deployment removes its container/stack **and**
deletes every `deployment:<id>:*` vault key in the same transaction. Deleting an App refuses if it
still has Deployments (or cascades on explicit confirm), so no orphaned secrets are ever left
behind. A reconcile check can also sweep vault keys whose deployment no longer exists.

Non-secret variables are passed through the normal stack env (they already have safe defaults and
are fine on the host).

## Updates (notify + one-click, opt-in auto) — ✅ Phase 3 built

Each App tracks its deployed commit per Deployment (recorded by `deployGit`). An hourly
`UpdateCheckService` sweep resolves each repo's remote tip **Cerebro-side** via `git ls-remote`
(deduped per repo+ref, no clone, no host round-trip) and sets `updateAvailable` when the tip differs
from the deployed commit. UX: an amber **"update available"** chip + a highlighted one-click
**Redeploy** (re-runs `deployGit` with `pull`/`forceRebuild`, which clears the flag). A manual
**Check for updates** button forces a sweep; `GET /deployments/:id/check-update` re-checks one.

On the **rising edge** (not-available → available) the sweep records an audit event
`replicator.update_available` (target `app/project`, `meta` carries `deploymentId`,
`dockerInstanceId`, `project`, `from`/`to` commits). Because that lands on the timeline bus as a
`kind:'audit'` event, an **Automations** rule can *opt into* auto-redeploy: trigger on the audit
event (`textContains: "update available"`) → a `connector_operation` running the Docker connector's
`redeploy-stack` on that `project` (each deployment is a managed stack). Nothing auto-redeploys by
default.

## Data model

```ts
interface App {
  id: string; name: string;
  gitUrl: string; gitRef: string;          // branch/tag
  gitPath?: string;                          // compose file path within the repo
  gitCredKey?: string;                       // vault kind='git' secret key
  variables: VariableSpec[];                 // snapshotted at register/refresh time
  usesGeneratedCompose: boolean;             // no compose in the repo; Cerebro generates one
  createdAt; updatedAt;
}

interface Deployment {
  id: string; appId: string; name: string;
  dockerInstanceId: string;                  // target connector instance
  values: Record<string, string>;            // non-secret resolved vars
  secretVars: string[];                       // var names whose values live in the vault
  ports: { service: string; hostPort: number; containerPort: number }[];
  ingress: DeploymentIngress[];
  deployedCommit?: string;
  status: 'pending' | 'deployed' | 'error' | 'updating';
  createdAt; updatedAt;
}

interface ReplicatorIngress {                // Phase 2
  kind: 'cloudflare' | 'npm';
  instanceId: string;                        // CF or NPM connector instance
  service: string; hostPort: number;         // which published port this fronts
  hostname: string;
  ref: string;                               // teardown handle: CF → the tunnel id
                                             // (route keyed by hostname); NPM → the proxy-host id
}
```

Migrations: `0016_app_replicator` (ReplicatorApp, ReplicatorDeployment) + `0017_replicator_ingress`
(ReplicatorIngress). Follow the `0014_git_stacks` precedent for git columns.

## Backend surface

`AppReplicatorModule` (`apps/server/src/app-replicator/`), registered in `app.module.ts`:

- `RepoIntrospectService` — shallow-clone (or fetch the single compose file) via the git transport,
  parse compose → `VariableSpec[]`.
- `PortAllocatorService` — query/validate host ports over SSH.
- `DeploymentService` — orchestrates: vault writes, env assembly, `deployGit`, ingress ops,
  row persistence, teardown (stack down + vault cleanup + ingress delete).
- `@Controller('api/replicator')` — CRUD for apps/deployments, `POST /:appId/introspect` (re-detect
  variables when the repo changes), `POST /deployments/:id/redeploy`, drift status.

RBAC: new `replicator:read` / `replicator:write` (admin; **never** a bearer scope — deploying runs
infra). Every deploy/teardown writes an audit event → shows up in Ship's Log.

## Frontend

- Route `/replicator` in `App.tsx` under `<RequirePerm perm="replicator:read">`; nav entry in
  `SidebarNav.tsx` — LCARS label **"App Replicator"**.
- **Catalog view** — app cards; "Register app" dialog (git url + ref + cred picker → introspect →
  review/adjust detected variables + secret flags).
- **Deploy wizard** — the 6 steps above, with the generated variable form, port suggestions, and the
  per-port ingress step.
- **Deployment detail** — status, ports, ingress links, update chip + Redeploy, logs (reuse the
  Docker connector's stack log stream), and Delete (with the vault-cleanup teardown).

## Phasing

- **Phase 1 — Catalog + deploy to Docker.** ✅ **Built.** Register app, introspect compose, generated
  variable form, vault secrets + lifecycle cleanup, port allocation/preflight, `deployGit`.
  *This alone delivers the POC use case.*
- **Phase 2 — Ingress wiring.** ✅ **Built.** Per published port, expose via a **Cloudflare tunnel
  route** or an **NPM proxy host**, driven through those connectors' own operations
  (`ConnectorInstanceService.runResourceOperationAwait` — CF `tunnel-add-route` is resource-scoped on
  the tunnel id; NPM `create-proxy-host` returns the proxy-host id). `forward_host` is auto-filled
  from the deployment's Docker host IP. Teardown removes the CF route (`tunnel-delete-route`) / NPM
  proxy host (`deleteResource('proxy_host', …)`) and runs automatically when the deployment is
  removed. Managed in a per-deployment **Ingress** dialog.
- **Phase 3 — Updates.** ✅ **Built.** Hourly `git ls-remote` sweep → `updateAvailable` flag + amber
  chip + highlighted redeploy (clears the flag); `replicator.update_available` audit/timeline event on
  the rising edge for an opt-in Automations auto-redeploy rule. Migration `0018_replicator_updates`.
- **V2 — AWS ECS target.** Build the image on a Docker host over SSH → push to ECR → run on Fargate,
  fronted by a **`cloudflared` sidecar** (reuses the existing CF `tunnel-add-route` ingress; no ALB).
  Introduces a `DeployTarget` seam so the Docker path is unchanged. Full design + phasing in
  [app-replicator-ecs-target.md](app-replicator-ecs-target.md).

## Safety & edge cases

- **Preflight before mutate** — port conflict, `compose config -q`, ingress reachability all checked
  before anything is created; failures are reported with the specific cause.
- **Atomic-ish teardown** — remove stack, delete vault keys, delete ingress; partial failures are
  surfaced and retryable, never silently left half-removed.
- **No stale secrets** — deployment deletion always sweeps `deployment:<id>:*`; App deletion is
  guarded on existing deployments.
- **Name collisions** — deployment name → sanitized compose project + container name + image tag,
  uniqueness-checked on the target host at preflight.
- **Secrets never on the command line** — reuse `deployGit`'s stdin-fed git credential + env file
  pattern; deploy output is `redact()`-ed.
