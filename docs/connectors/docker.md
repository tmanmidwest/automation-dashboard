# Docker connector (a Portainer replacement)

> **Status: BUILT — connector v0.2.0, all five phases (2026-09-06).** Phase 1 is deployed and
> live-connected (a real Docker 29.1.3 host); Phases 2–5 are built and smoke-tested, awaiting
> deploy (per the repo's edit-only workflow — the user commits, builds, and deploys). This
> document now describes **what was built**; where reality diverged from the original plan it
> says so inline, and the phase table below records the shape. It follows the Proxmox / AWS /
> Cloudflare / Home Assistant connectors: a typed API behind a `Connector`, host/container
> objects normalized into resource kinds, mutating endpoints mapped to actions/operations, a
> health-oriented `overview`, live updates via `subscribeLive`, and an interactive shell.

A connector that lets Cerebro monitor and manage one or more Docker hosts — replacing Portainer
for day-to-day use: see every stack and container, watch host resources, start/stop/restart/
prune, tail logs, `exec` into a container, and deploy Compose stacks. Full **stack deploy** (the
Portainer end-game) is where the Docker Engine API stops, so it runs the host's own
`docker compose` over SSH — see Phase 5.

> **Two decisions that changed during the build:**
> - **No pinned API version.** The plan pinned `/v1.43`; a Docker 26+/29 daemon rejects that
>   (minimum 1.44), and pinning any fixed version breaks a mixed fleet the other way. The client
>   calls the API **unversioned**, so each daemon uses its own maximum supported version.
> - **Phase 5 uses SSH, not option C.** The plan led with "store-only + delegate later"; the user
>   chose the **host-side helper** for full Compose fidelity, implemented as SSH running the
>   host's own `docker compose` (no agent image, no compose reimplementation).

```
  ┌──────────────┐   GET /containers/json, /images/json, /info, /system/df   ┌────────────┐
  │ Docker Engine│◀──────────────────────────────────────────────────────────│  Cerebro   │
  │ API (2376)   │   POST /containers/:id/{start,stop,restart}, /images/create│  Docker    │
  │ mTLS         │   GET  /events  (live)   ·  POST /exec  (shell)            │ connector  │
  └──────────────┘   Client cert + key (from the secrets vault)              └────────────┘
```

## Transport — mutual TLS by default, socket-proxy as the hardened option

The Docker Engine API is **root-equivalent**: anything that can call it can own the host. So the
transport decision is a security decision, and the connector supports two, chosen per host in
the config form:

1. **Direct mTLS (default).** Talk to the Engine API on `tcp://host:2376` with a **client
   certificate + key** (Docker's own `--tlsverify` model). The daemon is started with
   `--tlsverify --tlscacert --tlscert --tlskey`; Cerebro presents a client cert signed by the
   same CA. This is the standard remote-Docker setup and needs **no agent**. The client key +
   cert live in the **secrets vault** (`docs/secrets-vault.md`) — exactly the kind of credential
   it was built for.

2. **Socket proxy (hardened).** Point the connector at a
   [`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy) sidecar
   running on each host, which exposes the Unix socket over HTTP with **per-endpoint allow/deny**
   env flags (`CONTAINERS=1`, `POST=0`, …). Cerebro connects over plain HTTP on the internal
   network (or mTLS to the proxy). This lets you run **read-only** or **read + limited-write**
   without hitting the raw daemon. Recommended when the host is exposed or shared.

> **Never expose `2375` (plaintext, unauthenticated).** The connector refuses a `tcp://…:2375`
> URL without an explicit `insecureAllowPlaintext` config flag, and warns loudly. A local
> unix-socket mode (`unix:///var/run/docker.sock`) is also supported for the host Cerebro itself
> runs on, but the primary use case is **many remote hosts**, so mTLS is the default.

### Config fields (`manifest.configFields`, as built)

| Field | Secret? | Notes |
| --- | --- | --- |
| `endpoint` | no | e.g. `tcp://nas.local:2376`, `http://dockerproxy:2375`, or `unix:///var/run/docker.sock` — the scheme selects the transport |
| `tlsCaCert` | no | PEM — verify the daemon (mTLS) |
| `tlsClientCert` | no | PEM — client identity (mTLS) |
| `tlsClientKey` | **yes** | PEM private key — vault-encrypted |
| `insecureSkipVerify` | no | dev only; default false |
| `sshHost` / `sshPort` / `sshUser` | no | Phase 5 stack deploys — the SSH host running `docker compose` (optional) |
| `sshPassword` | **yes** | password for the SSH user — vault-encrypted (provide this **or** a key) |
| `sshPrivateKey` | **yes** | PEM key for the SSH user — vault-encrypted (alternative to the password) |
| `stacksDir` | no | where Cerebro writes compose files on the host (default `/opt/cerebro-stacks`) |

> The transport is **inferred from the endpoint scheme** (unix / http / tcp+https), not a separate
> `transport` field. All SSH fields are optional — blank keeps the connector monitor/manage-only.

## Design decision — dependency-free Engine API client

Built against the **Docker Engine API**, called **unversioned** (each daemon uses its own maximum
supported version — see the decision note above), with a dependency-free HTTPS client in the
Proxmox/HA/Cloudflare style (Node `https`/`http` with a client-cert `Agent` for mTLS, a Unix-socket
agent for the local case, or plain HTTP to a socket-proxy). No `dockerode` SDK —
the surface we need is a couple dozen endpoints, and the existing connectors set the precedent
for a hand-rolled typed client + a friendly `DockerApiError`.

Relevant endpoints:
- `GET /info`, `GET /version` — daemon health, host CPU/mem total, container/image counts (`testConnection` + host tile).
- `GET /system/df` — disk used by images / containers / volumes / build cache (storage tiles).
- `GET /containers/json?all=1` — every container: state, status, image, ports, `com.docker.compose.project` label, health.
- `GET /containers/:id/stats?stream=0` — per-container CPU / memory (one-shot sample).
- `GET /images/json`, `GET /volumes`, `GET /networks` — the other resource kinds.
- `POST /containers/:id/{start,stop,restart,pause,unpause,kill}` — lifecycle actions.
- `DELETE /containers/:id`, `DELETE /images/:id`, `POST /{containers,images,volumes,networks}/prune` — cleanup.
- `POST /images/create?fromImage=…` — pull an image (streamed progress → a JobService job).
- `GET /events` — the live stream (`subscribeLive`).
- `POST /containers/:id/exec` + `POST /exec/:id/start` — interactive shell (see Phase 3 wrinkle).
- `GET /containers/:id/logs?follow=1&stdout=1&stderr=1` — log tail.

## Resource kinds

| Kind | `category` | Source | Notes |
| --- | --- | --- | --- |
| `docker_host` | — | `/info`, `/version`, `/system/df` | One per instance; the node. CPU/mem/disk tiles. |
| `stack` | — | grouped by `com.docker.compose.project` label | How Portainer groups too. Sub-resource: its containers. |
| `container` | `container` | `/containers/json?all=1` | The workhorse kind. Actions + console + logs. |
| `image` | — | `/images/json` | Deletable; pull via operation. |
| `volume` | — | `/volumes` | Deletable; prune. |
| `network` | — | `/networks` | Deletable; prune. |

`stack` uses `subResources` to nest its containers (like a Proxmox VM's snapshots), so the UI
drills host → stack → container. Containers roll up into the cross-connector **`container`**
dashboard bucket, sitting alongside Proxmox LXC and HA add-ons.

---

## Phase 1 — Monitor (Engine API only, no agent, READ-ONLY)

Ship the whole read surface first. Nothing here mutates a host, so it's safe to point at
production immediately.

- **`listResources`** for all six kinds, normalized to `ConnectorResource` (id, name, status,
  badges). Container status → the standard running/stopped/unhealthy badge colors.
- **`overview`**: tiles for containers running / stopped / **unhealthy**, image count, **disk
  used** (`/system/df`, broken down), and host **RAM / CPU / kernel / Docker version** from
  `/info`. Unhealthy-container count is the quietly-important one Portainer buries.
- **`describeResource`** for a container: full inspect (env-scrubbed), mounts, ports, restart
  count, health log, the compose project/service labels.
- **`listNodes`** returns the one host so it appears on the infrastructure map.
- Per-container CPU/mem from a one-shot `stats` sample, shown on the detail page (kept off the
  list view — one stats call per container is expensive; fetch lazily).

**Deliverable:** a live read-only Portainer dashboard across every host. `testConnection` =
`GET /info` (cheap, one call).

## Phase 2 — Manage (Engine API actions + operations) — BUILT

Maps the daemon's mutating endpoints onto the existing action/operation machinery. Every one is
audited (they flow through the connector action path → the timeline).

- **Container actions** (`ConnectorAction[]` on the `container` kind): `start`, `stop`,
  `restart`, `pause`, `unpause`, `kill` — each with `showWhenStatus` so only valid actions
  appear. **Remove** is the generic delete control (`deletable: true`).
- **Operations** (forms): **pull image** (streamed to a `JobService` job so progress shows in the
  running-jobs banner), and **four prune operations** (dangling images / stopped containers /
  unused volumes / unused networks) — each a separate op with a **required confirm checkbox** so
  it never runs on a stray click (simpler and safer than one scope dropdown).
- **`deleteResource`** for container (force), image (force), volume (**not** forced — an in-use
  volume returns a clear 409 instead of data loss), and network.
- Gated behind `connectors:action`; over the socket-proxy this needs **`POST=1`** (and the delete
  paths need a proxy that permits `DELETE`, else use the TLS transport).

> **Diverged from the plan:** **recreate container** was deferred — recreating faithfully from
> `inspect` (ports, mounts, networks, restart policy) is fiddly and risky; Phase 5's stack
> redeploy covers "redeploy" properly instead.

**Deliverable:** restart/kill/prune/pull/remove from Cerebro — replaces most daily Portainer use
with **zero agent**.

## Phase 3 — Live, logs, and shell — BUILT

- **`subscribeLive`** subscribes to `GET /events` (filtered to `type=container`) and maps each
  event **directly** to a normalized container resource — no per-event API round-trip — pushing it
  via `onUpdate`. Reuses the Home Assistant `live` contract; container rows update in place and
  feed the **timeline** live tail. Auto-reconnects 5 s after a stream drop.
- **Log tail** and **interactive `exec` shell**, both reached from a container's detail page
  (**Logs** and **Shell** buttons; Shell only when running).

> **How the exec wrinkle was solved.** Docker's exec attach **hijacks** the HTTP connection and
> logs is a chunked stream — neither is a WebSocket, which is all the console relay spoke. Rather
> than teach the generic relay Docker's HTTP, the console contract gained an optional
> **`raw` upstream** on `ConnectorConsoleTarget` (`type: 'docker-exec' | 'docker-logs'`), and a
> self-contained bridge (`docker/docker-console-bridge.ts`) opens its own socket to the daemon,
> sends the raw HTTP request, skips the response headers, then pipes bytes — **demuxing** Docker's
> 8-byte stdout/stderr frame headers for non-TTY logs. The console relay gained **one additive
> branch** (`if (target.raw) …`); the VNC/serial WebSocket path is untouched. The browser reuses
> the existing xterm terminal, with a new raw-byte mode (Docker exec sends raw keystrokes, not
> Proxmox's `0:len:` framing).
>
> **Limitation:** no live TTY resize yet — the exec runs at Docker's default 80×24. Live resize
> needs a mid-session `POST /exec/:id/resize`; deferred.
>
> **Socket-proxy note:** exec needs `EXEC=1` + `POST=1` on the proxy; logs works read-only with
> just `CONTAINERS=1`. The TLS transport does it all with no toggles.

**Deliverable:** watch containers flip live, tail logs, and drop into a shell.

## Phase 4 — Health alerts (metric-threshold monitor) — BUILT

A new **Docker** alert category wired into the generic threshold monitor (same pattern as
Cloudflare/HA), three per-connector thresholds:

- `docker.unhealthy` — unhealthy-container count over the limit (default on).
- `docker.stopped` — stopped-container count over the limit (default off; stopped is often
  intentional).
- `docker.disk_high` — `/system/df` disk-used GB over the limit (default on).

Alerts appear in the timeline via `NotificationLog`.

> **Diverged from the plan:** the plan listed `container_died` and `host_unreachable`. `host_
> unreachable` was dropped — the baseline connection monitor already alerts when any connector
> goes unreachable. `container_died` folds into the `docker.stopped` count.

## Phase 5 — Stacks (deploy / edit) — BUILT (host-side helper over SSH)

The Engine API has **no compose endpoints**, so the plan laid out three options: (A) a host-side
`docker compose` runner, (B) reimplement compose over the API, (C) store-only + delegate. **The
user chose (A)** — full Compose fidelity — implemented as **SSH running the host's own
`docker compose`**, which needs no custom agent image (it reuses the compose CLI already on the
host).

What was built:
- **Cerebro is the versioned store** for each stack's compose (`DockerStack` table, migration
  `0010`). Deploys write the compose to `<stacksDir>/<project>/docker-compose.yml` on the host and
  run `docker compose -p <project> -f … up -d` over SSH (`ssh2`; key in the secrets vault).
- **Operations on the `stack` kind:** `deploy-stack` (name + compose textarea, create), `edit-
  stack` (prefilled with the stored compose via `operationDefaults`, resource), `redeploy-stack`,
  and `stop-stack` (`compose down`). Delete = down + forget the stored stack.
- **`listResources('stack')` merges** running stacks (grouped from containers by the
  `com.docker.compose.project` label) with Cerebro-stored stacks that aren't currently running, so
  a stopped managed stack still shows and can be redeployed.
- SSH host/user/key/dir are **optional** connector settings — blank keeps a connector
  monitor/manage-only. No new frontend (reuses the operation dialog's textarea + prefill).

> **Caveats:** needs `docker compose` v2 on the host and an SSH user in the `docker` group; a
> deploy runs arbitrary compose (RCE by design — gated by `connectors:action`, key vaulted, every
> open audited); SSH host keys are **not pinned** (homelab default).

## Host system metrics — how far the API gets us

The Engine API gives real but **partial** host metrics: `/info` (MemTotal, NCPU, OS, kernel),
`/system/df` (disk consumed by Docker), and per-container `stats`. That covers "is this host's
Docker full / busy?" well. **Full** host RAM/disk/CPU/temperature (beyond Docker's own footprint)
needs a node-exporter-style source or the same host-side helper as Phase 5. Scope Phase 1 to the
Docker-derived metrics; note full host telemetry as a Phase-5-adjacent add-on so we don't imply
more than `/info` + `/system/df` deliver.

---

## Files touched (as built)

| File | Change |
| --- | --- |
| `apps/server/src/connectors/docker/docker.connector.ts` (new) | manifest + `Connector` impl (all phases) |
| `apps/server/src/connectors/docker/docker-api.ts` (new) | typed Engine API client (unix / socket-proxy / mTLS); events, exec-create, prune, pull-stream; unversioned paths + `POST=1`-aware 403 messages |
| `apps/server/src/connectors/docker/docker-console-bridge.ts` (new) | raw exec-hijack + logs-demux ↔ WebSocket bridge (Phase 3) |
| `apps/server/src/connectors/docker/docker-ssh.ts` (new) | `ssh2` command runner (Phase 5) |
| `apps/server/src/connectors/docker/docker-stack.service.ts` (new) | Prisma-backed compose store + SSH `docker compose` deploy/down (Phase 5) |
| `apps/server/src/connectors/console-relay.ts` | one additive `if (target.raw)` branch → `bridgeDockerRaw` (Phase 3) |
| `apps/server/src/connectors/connectors.module.ts` | register `DockerConnector` + provide `DockerStackService` |
| `apps/server/src/connectors/connector-instance.service.ts`, `connectors.controller.ts` | widen `openConsole` mode to `'shell' \| 'logs'`, pass it through |
| `apps/server/src/connectors/proxmox/proxmox.connector.ts` | widen `openConsole` mode signature (contract change) |
| `apps/server/src/notifications/alerts/alert-registry.ts`, `metric-thresholds.ts` | Docker alert category + threshold defs (Phase 4) |
| `packages/shared/src/connector.ts` | `openConsole` mode `+'shell'\|'logs'`; `ConnectorConsoleTarget.type` `+'docker-exec'\|'docker-logs'` + `raw?: RawConsoleUpstream` |
| `apps/server/prisma/schema.prisma` (+ migration `0010_docker_stack`) | `DockerStack` model |
| `apps/server/package.json` | add `ssh2` |
| web: `ConnectorIcon.tsx`, `Console.tsx` (raw terminal + log viewer), `ConnectorDetail.tsx` (Shell/Logs buttons), `ConnectorAlerts.tsx` (Docker threshold mirror) | the only frontend changes — the rest is generic |

## Resolved decisions (were open questions)

1. **Transport** — mTLS is the documented default; the socket-proxy compose is offered as a
   copy-paste sample on the setup screen for anything not on the same host. Plaintext `2375` is
   refused without an explicit override.
2. **Stats on the list view** — detail-page-only (one `stats` sample, fetched lazily); never on
   the list, to keep big hosts cheap.
3. **Exec security** — resolved as **always available to `connectors:action`** (the user's call),
   every open audited. No per-connector "allow shell" toggle was added; the socket-proxy `EXEC`
   flag is the coarse gate for proxy transports.
4. **Phase 5 helper** — the user accepted a **host-side helper (SSH `docker compose`)** for full
   fidelity over the agentless-but-partial reimplementation.

## Post-Phase-5 additions (built)

- **Live TTY resize** for the exec shell — the web terminal sends `{resize:{cols,rows}}` control
  frames (FitAddon) and the bridge issues `POST /exec/:id/resize`.
- **Host telemetry over SSH** — CPU load (1-min load + load %), memory used %, and root-fs disk used %.
  The Engine API can't see these, so `DockerConnector.hostMetrics` reads `/proc/loadavg`, `/proc/meminfo`,
  and `df -Pk /` over the existing SSH transport (only when SSH is configured), cached 15s and
  background-refreshed so the overview never blocks. Surfaced as `hostLoadPct` / `hostMemUsedPct` /
  `hostRootDiskPct` metrics and wired to threshold alerts `docker.host_disk` / `docker.host_mem` /
  `docker.host_load`.
- **Stack drift check** — `stack-check-drift` operation (managed stacks): compares the compose on the
  host vs. Cerebro's stored copy, and expected services (`compose config --services`) vs. what's
  actually up (`compose ps`), reporting missing / not-running / orphan services. `DockerStackService.checkDrift`.
- **Container recreate** — `recreate-container` operation: inspects the container, optionally pulls a
  newer image, renames the old one aside, creates a new one from the same Config/HostConfig (+ networks),
  swaps them, and removes the old — rolling back on failure. `DockerApi.recreateContainer`. Best for
  standalone containers; compose-managed ones should use a stack redeploy.
- **Stack & container image-update status** — the same cached registry-digest check that powers the
  overview "Updates" tile now surfaces on stacks and containers (`DockerConnector.updatesByContainerId`):
  the stacks **and** containers lists show an **amber "updates" chip** on any row with an outdated image,
  the stack detail shows an amber "Image updates" summary (`warn` detail variant) plus an "update
  available" marker on each outdated member, and the container detail's "Image update" line turns amber.
  The `warn` `ConnectorDetailItem` variant and the amber `updates` tag-chip are generic (reusable by any
  connector). Pairs with **recreate** to pull the newer image.

## Still open / future

- **Multi-network static-IP recreate** — recreate reconnects extra named networks with their aliases,
  but a container pinned to a fixed IP on several networks may need a manual recreate (the old one still
  holds the IP until removed).
- **Drift auto-check** — drift is on-demand today; a periodic check that raises an alert on drift would
  close the loop (pairs well with the automations engine).
