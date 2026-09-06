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

### Config fields (`manifest.configFields`)

| Field | Secret? | Notes |
| --- | --- | --- |
| `endpoint` | no | e.g. `tcp://nas.local:2376`, `http://dockerproxy:2375`, or `unix:///var/run/docker.sock` |
| `transport` | no | `mtls` \| `socket-proxy` \| `unix` (drives which fields below are shown) |
| `tlsCaCert` | no | PEM — verify the daemon (mTLS) |
| `tlsClientCert` | no | PEM — client identity (mTLS) |
| `tlsClientKey` | **yes** | PEM private key — vault-encrypted |
| `insecureSkipVerify` | no | dev only; default false |

## Design decision — dependency-free Engine API client

Built against the **Docker Engine API** (documented, versioned — pin `/v1.43/…`) with a
dependency-free HTTPS client in the Proxmox/HA/Cloudflare style (Node `https`/`http` with a
client-cert `Agent` for mTLS, or a Unix-socket agent for the local case). No `dockerode` SDK —
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

## Phase 2 — Manage (Engine API actions + operations)

Map the daemon's mutating endpoints onto the existing action/operation machinery. Every one is
audited (they flow through the connector action path → the timeline).

- **Container actions** (`ConnectorAction[]` on the `container` kind): `start`, `stop`,
  `restart`, `pause`, `unpause`, `kill`, `remove` (with `confirm`).
- **Operations** (forms): **pull image** (`fromImage` + tag → streamed to a `JobService` job so
  progress shows in the running-jobs banner), **prune** (images / volumes / networks / build
  cache, with a scope dropdown), **recreate container** (stop → remove → run with the same
  config from inspect — the safe 80% of "redeploy").
- **`deleteResource`** for image / volume / network, guarded when in use.
- Gate all of this behind `connectors:action` (already the permission for mutating a connector),
  and behind the **socket-proxy `POST=1`** flag if that transport is chosen.

**Deliverable:** restart/recreate/prune/pull from Cerebro — replaces ~80% of daily Portainer use
with **zero agent**.

## Phase 3 — Live, logs, and shell (existing relays)

- **`subscribeLive`** subscribes to `GET /events` (filtered to container/health events) and calls
  `onUpdate` with the re-normalized container whenever one starts, dies, or changes health. Reuses
  the exact contract built for Home Assistant — container rows update in place, and these events
  also feed the **timeline** live tail.
- **Log tail**: `GET /containers/:id/logs?follow=1` is a chunked HTTP stream (with Docker's 8-byte
  multiplexing header when no TTY). Surface it over SSE, like the timeline, on the container detail
  page. Requires a small **demux** of the stdout/stderr framing.
- **Interactive shell (`exec`)**: `openConsole(kind:'container', mode:'shell')` returns a
  `ConnectorConsoleTarget{ type:'terminal' }`. The browser already has the terminal client from the
  Proxmox serial console.
  - ⚠️ **The one real wrinkle.** Docker's exec attach is **not** a WebSocket — `POST /exec/:id/start`
    **hijacks** the HTTP connection into a raw bidirectional byte stream. The current console relay
    is a WebSocket↔WebSocket proxy, so exec needs a small **hijack↔WebSocket bridge** in the relay
    (create the exec with `AttachStdin/Stdout/Stderr`, `Tty:true`, start it, then pipe the hijacked
    socket to the browser WebSocket). This is an additive relay mode, not a rewrite — the byte-pump
    and the browser terminal are unchanged; only the upstream dial differs. Resize via
    `POST /exec/:id/resize`.

**Deliverable:** watch containers flip live, tail logs, and drop into a shell — parity with the
things people actually open Portainer for.

## Phase 4 — Health alerts (reuse the metric-threshold monitor)

A new **Docker** alert category wired into the generic threshold monitor (same pattern as
Cloudflare/HA): `docker.container_unhealthy`, `docker.container_died` (an expected-running
container is stopped), `docker.host_disk_high` (`/system/df` past a % of a configured ceiling),
`docker.host_unreachable`. Per-connector thresholds; alerts appear in the timeline via
`NotificationLog`.

## Phase 5 — The end game: stacks (deploy / edit / launch)

This is where the Engine API stops. **Docker's API has no compose endpoints** — `docker compose`
is a client-side tool that translates YAML into many container/network/volume API calls. So
launching or editing a *stack* means one of:

- **(A) Host-side compose runner** — a tiny per-host helper (an agent, or SSH to run
  `docker compose up -d` against a Cerebro-managed compose file). This is what Portainer's agent
  does. Most capable; requires deploying something on each host, and a decision Cerebro has so far
  avoided.
- **(B) Reimplement compose over the API** — translate a compose file into the individual
  create/connect/start calls ourselves. No agent, but it re-derives Portainer's stack engine
  (dependency ordering, networks, volumes, healthcheck waits, `depends_on`) — a large, bug-prone
  surface.
- **(C) Stack *storage* + host apply** — Cerebro stores/edits the compose files (git-style
  versioning in a new table) and Phase-2 recreate handles single-service changes, but full
  multi-service `up` still calls out to (A). A pragmatic middle path: **own the compose files and
  the diff, delegate the apply.**

**Recommendation:** ship Phases 1–4 first (they need only mTLS/socket-proxy and replace most of
Portainer). Treat Phase 5 as a separate, explicit decision — lead with **(C)**: let Cerebro be the
system of record for stack definitions and single-service updates, and add the host-side runner
**(A)** only when full multi-service deploy is worth an agent. Reassess **(B)** only if "no agent,
ever" becomes a hard requirement.

## Host system metrics — how far the API gets us

The Engine API gives real but **partial** host metrics: `/info` (MemTotal, NCPU, OS, kernel),
`/system/df` (disk consumed by Docker), and per-container `stats`. That covers "is this host's
Docker full / busy?" well. **Full** host RAM/disk/CPU/temperature (beyond Docker's own footprint)
needs a node-exporter-style source or the same host-side helper as Phase 5. Scope Phase 1 to the
Docker-derived metrics; note full host telemetry as a Phase-5-adjacent add-on so we don't imply
more than `/info` + `/system/df` deliver.

---

## Files touched (when built)

| File | Change |
| --- | --- |
| `apps/server/src/connectors/docker/docker.connector.ts` (new) | manifest + `Connector` impl |
| `apps/server/src/connectors/docker/docker-api.ts` (new) | typed Engine API client (mTLS / socket / unix agents) |
| `apps/server/src/connectors/connector-registry.service.ts` | register the connector |
| `apps/server/src/connectors/console-relay.ts` | additive **hijack↔WebSocket** exec bridge (Phase 3) |
| `apps/server/src/notifications/alerts/alert-registry.ts` | Docker alert category (Phase 4) |
| `packages/shared/src/connector.ts` | broaden `openConsole` mode to include `'shell'` |
| web: connector icon + a container detail/logs pane | mostly reuses generic resource views |

## Open questions

1. **Transport default per environment** — mTLS is the default; should a fresh install nudge
   toward the socket-proxy for anything not on the same host? (Lean: yes, document proxy-first for
   exposed hosts.)
2. **Stats on the list view** — one `stats` call per container is too expensive to poll for a big
   host. Detail-page-only, or an opt-in "live stats" mode on the list? (Lean: detail-only + a
   manual "sample all" button.)
3. **Exec security** — an in-browser root shell to any container is powerful. Gate behind
   `connectors:action`, audit every `openConsole`, and consider a per-connector "allow shell"
   toggle (default off) like the console relay's existing model.
4. **Phase 5 agent** — is a per-host helper acceptable for full stack deploy, or is "no agent"
   a hard line that pushes us to option (C)-only? This is the single decision that scopes the end
   game.
