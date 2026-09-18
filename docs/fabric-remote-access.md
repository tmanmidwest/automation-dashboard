# Cerebro Fabric — agent-brokered remote access (RDP / SSH)

Design + implementation plan for a top-level feature — **Fabric** — that lets Cerebro reach into
Linux/Windows machines (cloud VMs, on-prem boxes) **without any inbound firewall rule**. A tiny
**Cerebro Agent** installed on the box dials *out* to Cerebro over TLS and holds one persistent
connection open. When an operator wants a session, Cerebro brokers an **RDP or SSH tunnel back down
that outbound connection** to the box's own `127.0.0.1:3389` / `:22`. The box's security group can
deny 22/3389 to the world; the only trust relationship is agent → Cerebro.

The mental model is **Cloudflare Tunnel + Teleport-lite, self-hosted**: reverse tunnel, central
broker, per-session RBAC, full audit — but living inside Cerebro's LCARS UI and reusing its
existing relay, vault, crypto, RBAC, and timeline plumbing.

> Status: **Phases 1–3 BUILT** (2026-09-18) — control plane + tunnel data path + in-browser SSH.
> Phase 1: control plane, enrollment, Go agent, `/fabric` screen.
> `tsc`/`vite` green; the Go agent **cross-compiles inside the Docker image build** (`agent-build`
> stage → all three binaries verified) so no manual Go step is needed — a normal image build produces
> and ships them at `/app/agent-dist`. NOT committed / not live-tested. Later phases follow the same convention as
> [App Replicator](app-replicator.md) and [Docker](connectors/docker.md): each phase records what
> shipped and what remains.
>
> **Phase-3 SSH note:** in-browser SSH is **xterm.js** (browser) ⟷ a session WS relay
> (`/api/fabric/session/ws`) ⟷ **ssh2** whose `sock` is the tunnel (`TunnelSocket` adapts a
> `TunnelStream` to a Node Duplex) ⟷ `127.0.0.1:22` on the box. The Go agent is unchanged — SSH is
> just bytes over the Phase-2 stream. Phase 3 uses **operator-supplied credentials** (entered in the
> connect dialog, held server-side in a 30s one-time ticket, never in a URL); **vault credential
> injection** (`AgentTarget.secretRef`) is a **Phase 3.5** fast-follow. Host keys are not yet pinned
> (the tunnel authenticates the box via the agent). Each session is recorded to `FabricSession` +
> Ship's Log (`fabric.session.start`/`end`, byte counts).
>
> **Phase-2 mux note:** the multiplexer rides the agent WebSocket's own message framing — **JSON
> text frames** for stream lifecycle (`open-stream`/`stream-opened`/`stream-error`/`close-stream`)
> and **binary frames** (`[4-byte streamId][payload]`) for raw bytes — rather than embedding a full
> yamux byte-stream protocol. Same multiplexing, identical in Go (gorilla) and Node (`ws`), far less
> surface. The Phase-2 acceptance check is a broker-initiated **tunnel probe** (opens a stream, reads
> the target's connect banner) surfaced as a **Test tunnel** button per target — more self-contained
> and testable than a raw local TCP forward, which would need a published container port to exercise.
>
> **Phase-1 auth note:** the agent authenticates with a **per-agent bearer credential** over TLS
> (sha256-stored, exactly like a Cerebro API token), *not* mTLS. Full mTLS terminates awkwardly behind
> the reverse proxy that already fronts Cerebro, and the bearer credential gives the same
> enroll→authenticate→revoke properties with far less surface. **mTLS moves to Phase 5 hardening.**

## Why this is a top-level module, not a connector

A connector integrates a *third-party* system's API. Fabric is **Cerebro's own overlay network** —
its rendezvous point, its agents, its tunnels. There is no upstream vendor. So, like
[Docker Fleet](docker-fleet.md), [App Replicator](app-replicator.md), and the Viewscreen, it is a
**top-level feature module** (`FabricModule`) with its own screen (`/fabric`), not code inside a
connector. It *may later* light up connector-adjacent conveniences (e.g. "this EC2 instance has a
Fabric agent → Connect" button on the AWS connector), but the fabric itself stands alone.

## The two objects

- **Agent** — one installed binary on one machine. Registered once via a one-time enrollment token,
  then holds a persistent, mutually-authenticated outbound connection. Carries identity (cert
  fingerprint), metadata (hostname, OS, tags), liveness (last-seen, online/offline), and the set of
  local targets it will expose (default: `ssh → 127.0.0.1:22` on Linux, `rdp → 127.0.0.1:3389` on
  Windows). One agent → many targets.
- **Session** — one brokered tunnel from one operator to one target on one agent, for one sitting.
  Audited (who / which agent / target / start / stop / duration / bytes), optionally recorded. Many
  sessions over the life of an agent.

## Why this rides on existing plumbing

| Need | Reused from |
|---|---|
| Attach a second WebSocket server to the running HTTP server, upgrade-routed by path | `attachConsoleRelay(app.getHttpServer(), …)` in `main.ts:46` — Fabric attaches the same way |
| Pipe raw bytes between a browser WS and an upstream stream, protocol-agnostic | `console-relay.ts` (the VNC/serial relay) — the data-plane shape is identical |
| Bridge a browser WS to a *non-WS* upstream (hijacked HTTP / raw TCP) | the `if (target.raw)` branch + `bridgeDockerRaw` (Docker exec) — the muxed agent stream is another such raw upstream |
| Encrypt the agent CA private key + agent credentials at rest (AES-256-GCM) | `CryptoService` (`common/crypto.service.ts`), keyed off `APP_ENCRYPTION_KEY` |
| Store per-target RDP/SSH credentials, reveal on demand, rotate | Secrets vault — `SecretsService.set/reveal/remove`, `{$secretRef}` resolution ([secrets-vault.md](secrets-vault.md)) |
| Gate who may enroll agents / open sessions | RBAC `Permission` union + `PermissionsGuard` (`packages/shared/src/rbac.ts`) |
| Log every enroll / connect / disconnect / session to the Ship's Log + live tail | Timeline bus + `AuditService.record` ([event-timeline.md](event-timeline.md)) |
| "Agent went offline" alerting | Monitors / notifications ([monitors.md]) — an offline agent is a heartbeat monitor |
| Sequential schema migration | Prisma, `apps/server/prisma/migrations/` (next is `0022_fabric`) |

The genuinely **new** work is: (1) a **Go agent binary**, (2) the **control-plane handshake +
stream multiplexer**, and (3) the **RDP/SSH-in-browser** rendering. Everything else is wiring into
plumbing that already exists.

---

## Architecture

```
  Operator browser (LCARS /fabric)                      AWS VM (no inbound 22/3389)
        │                                                     ┌──────────────────┐
        │  wss://cerebro/api/fabric/session/ws?token=…        │  cerebro-agent   │
        ▼                                                     │  (Go, outbound)  │
  ┌───────────────────────────────────────────┐  wss (mTLS)  │       │          │
  │            Cerebro  (broker)               │◄─────────────┤  control channel │
  │                                            │   443 out    │   + mux streams  │
  │  Fabric control server  ── agent registry  │              │       │          │
  │  Session relay  ── guacd sidecar (RDP/SSH) │──stream N────►│  dials 127.0.0.1:22
  └───────────────────────────────────────────┘              └──────────────────┘
```

### 1. Control plane — the persistent agent connection

The agent opens **one** outbound `wss://cerebro/api/fabric/agent/ws` and keeps it open forever
(auto-reconnect with exponential backoff + jitter). Authentication is **mutual TLS**: the agent
presents a client certificate issued by a **Cerebro-internal CA** during enrollment; Cerebro pins
the fingerprint recorded on the `Agent` row. (See *Enrollment* below for how it gets that cert.)

Over this connection the agent and broker exchange small JSON control frames:

- `hello` (agent → broker): agent id, version, OS, hostname, discovered local targets.
- `heartbeat` (both ways, ~15s): liveness; missed N in a row ⇒ mark offline, fire the monitor.
- `open-stream` (broker → agent): `{ streamId, host: '127.0.0.1', port: 3389 }` — asks the agent to
  dial a local target and attach a new data stream.
- `stream-opened` / `stream-error` (agent → broker): result of the dial.
- `close-stream` (both ways): tear a stream down.

### 2. Data plane — multiplexed streams over the single connection

Multiple concurrent tunnels (and the control channel) share the **one** outbound TLS connection via
a **yamux-style multiplexer**. When the broker sends `open-stream`, the agent opens a new mux stream,
dials `127.0.0.1:<port>`, and pipes bytes raw in both directions. Cerebro never parses RDP/SSH — it
just relays, exactly like `console-relay.ts` relays VNC.

**Why mux over one connection (not a new WSS per session):** one firewall hole (443 out), clean NAT
traversal, one heartbeat, one auth. This is the Cloudflare-tunnel property we want.

> **Transport decision.** Primary transport is **WebSocket-over-TLS (443)** with an application-layer
> mux, because it reuses Cerebro's relay stack and is the friendliest to corporate egress proxies.
> yamux (well-supported in Go) rides *inside* the WS binary frames. We explicitly are **not** using
> WireGuard: it's an L3 VPN (inbound UDP, kernel module, Windows WG service, mesh key management) and
> gives *network reach* rather than *brokered, per-session, audited* reach — the opposite of the
> lockdown goal. Revisit QUIC only if WS framing overhead ever matters (it won't at human-RDP scale).

### 3. Operator plane — RDP/SSH in the browser (Phase-3/4), native client (Phase-5)

**Browser-first**, to match the LCARS product and reuse the relay:

```
browser ⟷ Cerebro (Guacamole protocol WS) ⟷ guacd ⟷ ephemeral localhost forward ⟷ agent tunnel ⟷ 127.0.0.1:22/3389
```

Add **guacd** (Apache Guacamole daemon) as a Docker sidecar — it speaks **both RDP and SSH**, renders
to a canvas in the browser, and gives **session recording for free**. Cerebro opens a short-lived
local TCP forward *through the agent tunnel*, points guacd at `127.0.0.1:<ephemeralPort>`, and streams
the Guacamole protocol to `xterm`/the guac client in the web app. Credentials come from the vault
(injected server-side; the operator never sees them) or are prompted per session.

**Native client fast-follow (Phase 5):** a small `cerebro access tcp <agent>/<target>` CLI that opens
a `localhost:1<port>` listener and forwards through the same broker — so power users run their own
`mstsc` / `ssh`. Same tunnel, different frontend. This is literally `cloudflared access tcp`.

---

## The agent (Go)

**Language: Go.** This is a deliberate, single exception to the TS monorepo, and the right call for a
deployable system agent:

- one **static binary**, no runtime; cross-compiles to `linux/amd64`, `linux/arm64`, `windows/amd64`;
- first-class **systemd unit** *and* **Windows service** integration;
- tiny, signable, `curl | sh`-installable; mature yamux + WS + mTLS libraries.

Lives in a new top-level `agent/` directory (its own Go module, its own build; **not** part of the
Node build). CI/release builds and (later) code-signs the three binaries.

**Config** (env or `/etc/cerebro-agent/config.yaml`): `CEREBRO_URL`, and on first run an
`ENROLLMENT_TOKEN`. After enrollment it persists its issued cert/key locally (root-only perms) and
never needs the token again. Everything else — its id, its targets — it learns/reports on connect.

**Footprint & safety:** outbound-only (never binds a listening port), dials only the configured
Cerebro URL, only opens `127.0.0.1` targets the broker asks for *and* that policy allows (see
target allow-list), runs as a dedicated service account, logs locally.

**Install UX:** `/fabric` shows a **"Add machine"** wizard that generates a one-time token and hands
back a copy-paste one-liner:

```bash
# Linux
curl -fsSL https://cerebro.example/api/fabric/install.sh | sudo CEREBRO_URL=https://cerebro.example ENROLL=abc123… sh
```

```powershell
# Windows (elevated)
iwr https://cerebro.example/api/fabric/install.ps1 -UseBasicParsing | iex   # prompts for URL + token
```

---

## Security model (the point of the feature)

| Control | Design |
|---|---|
| **No inbound exposure** | Agent only *dials out* (443). Box security group can drop all inbound 22/3389. Documented as the headline benefit. |
| **Agent identity** | One-time **enrollment token** (1h TTL, single use, sha256-stored) → exchanged at `POST /api/fabric/enroll` for a long-lived **per-agent bearer credential** (`cbroagent_<prefix>_<secret>`, sha256-stored). Revoke = drop `credPrefix`/`credHash` + close the live socket; the agent's next dial is rejected. **Phase 5:** upgrade to mTLS via an internal CA (`CryptoService`-sealed key). |
| **Operator authz** | New RBAC perms `fabric:read` / `fabric:connect` / `fabric:manage`, enforced by `PermissionsGuard`. Session-only (never a bearer-token scope initially) — brokering an interactive shell is not something we hand an API token yet. Per-agent / per-tag grants can follow. |
| **Target allow-list** | An agent only ever proxies to targets on its **declared allow-list** (`127.0.0.1:22`, `:3389`). The broker cannot ask it to reach arbitrary host:port (no pivoting into the box's LAN unless an operator explicitly adds a target). |
| **Credential handling** | RDP/SSH creds live in the **vault**, injected server-side into guacd; the operator never sees them. Per-session prompt is the alternative. Prohibited-action rules still apply — Cerebro injects a stored secret, it does not ask the human to type bank/gov credentials anywhere. |
| **Audit** | Enroll, connect, disconnect, session-start, session-end → **Ship's Log** with actor, agent, target, duration, byte counts. Live tail via the timeline SSE. |
| **Liveness alerting** | Missed-heartbeat ⇒ agent offline ⇒ heartbeat monitor ⇒ notification. Natural reuse of the monitors module. |
| **Session recording** *(later)* | guacd can record sessions to disk for playback — opt-in per agent/target. |
| **Break-glass approval** *(later)* | Optional per-session approval gate reusing the assistant's `PendingActionStore` pattern. |

---

## Data model (migration `0022_fabric`)

```prisma
model Agent {
  id            String   @id @default(cuid())
  name          String
  hostname      String?
  os            String?              // "linux" | "windows"
  osVersion     String?
  agentVersion  String?
  tags          String[]             // for grouping / per-tag grants later
  status        String   @default("pending") // pending | online | offline | revoked
  certFpr       String?  @unique      // pinned client-cert SHA-256 (set at enrollment)
  enrollToken   String?  @unique      // one-time, hashed; cleared after first connect
  enrollExpires DateTime?
  lastSeenAt    DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  targets       AgentTarget[]
  sessions      FabricSession[]
}

model AgentTarget {
  id        String @id @default(cuid())
  agentId   String
  agent     Agent  @relation(fields: [agentId], references: [id], onDelete: Cascade)
  kind      String                    // "ssh" | "rdp"
  host      String @default("127.0.0.1")
  port      Int                       // 22 | 3389 | custom
  label     String?
  secretRef String?                   // vault key for injected credentials
}

model FabricSession {
  id         String    @id @default(cuid())
  agentId    String
  agent      Agent     @relation(fields: [agentId], references: [id], onDelete: Cascade)
  targetKind String                   // "ssh" | "rdp"
  userId     String                   // operator
  startedAt  DateTime  @default(now())
  endedAt    DateTime?
  bytesUp    BigInt    @default(0)
  bytesDown  BigInt    @default(0)
  recordPath String?
}
```

(In-flight mux stream state is in-memory only; nothing ephemeral is persisted.)

---

## Server module layout (`apps/server/src/fabric/`)

| File | Responsibility |
|---|---|
| `fabric.module.ts` | Nest module; registered in `app.module.ts` alongside `AppReplicatorModule` |
| `fabric.controller.ts` | REST: list/register/revoke agents, list sessions, mint enrollment token, serve `install.sh`/`install.ps1`, mint a one-time session WS token |
| `agent-registry.service.ts` | In-memory map of connected agents (id → live socket/mux), backed by the `Agent` table; heartbeat tracking; online/offline transitions → timeline + monitor |
| `fabric-agent-relay.ts` | Second `WebSocketServer({ noServer:true })` on `/api/fabric/agent/ws`; mTLS verify; control-frame protocol; owns the yamux mux per agent. Attached in `main.ts` next to `attachConsoleRelay` |
| `fabric-session-relay.ts` | Browser-side WS `/api/fabric/session/ws`; consumes one-time token; opens a mux stream via the registry; pipes bytes (or hands off to guacd). Mirrors `console-relay.ts` |
| `agent-ca.service.ts` | Internal CA: issue/sign per-agent client certs, verify fingerprints, revoke; key sealed via `CryptoService` |
| `enrollment.service.ts` | Mint/validate one-time tokens; exchange token → signed cert on first connect |
| `guac.service.ts` *(Phase 3+)* | Talk the Guacamole protocol to the guacd sidecar; open the ephemeral local forward through a mux stream |

**Web** (`apps/web/src/…`): a `/fabric` route + nav entry (LCARS, RBAC-gated on `fabric:read`); an
agent inventory (online dot, OS, last-seen, tags); an **Add machine** wizard; per-target **Connect
(SSH/RDP)** buttons that open the session view; a session history panel.

**Shared** (`packages/shared/src/rbac.ts`): add `fabric:read | fabric:connect | fabric:manage` to the
`Permission` union; grant `fabric:read` to Viewer, all three to Admin. **Rebuild `packages/shared`
dist** after editing (the web build consumes the barrel; keep imports types-only per the known
CJS-barrel gotcha).

---

## Phased plan

| Phase | Scope | Proves |
|---|---|---|
| **1 — Control plane + enrollment** ✅ **BUILT** | Go agent (`agent/`); enrollment token → bearer-credential exchange; `/api/fabric/agent/ws` control server (bearer auth); `Agent`/`AgentTarget`/`FabricSession` tables (migration `0022`); heartbeat + online/offline; `/fabric` screen + **Add machine** wizard + `install.sh`/`install.ps1` + binary-serve route. **No tunnels yet.** | A real cloud VM's agent dials home, enrolls, and shows **online** in the UI with zero inbound rules. |
| **2 — Tunnel data path** ✅ **BUILT** | WS-framed mux (`stream-mux.ts` on the broker; single-writer session in the Go agent) — `open-stream`/`stream-opened`/`stream-error`/`close-stream` + binary data frames; agent-side **allow-list** (only declared targets + loopback 22/3389); **Test tunnel** probe end to end. `tsc`/`vet` green; agent compiled in Docker. | Bytes flow through the tunnel; a probe reads the live SSH banner; allow-list enforced. |
| **3 — SSH in browser** ✅ **BUILT** | `xterm.js` ⟷ session WS relay (`fabric-session-relay.ts`) ⟷ `ssh2` over the tunnel (`TunnelSocket`); one-time session ticket (`FabricSessionService`); operator-supplied creds; `FabricSession` + Ship's Log audit. `tsc`/`vite` green. *Vault injection = Phase 3.5; host-key pinning + guacd/RDP = Phase 4.* | First real interactive session, fully in LCARS, audited. |
| **4 — RDP in browser** | guacd RDP; Windows agent as a service; credential injection; connection quality / resize. | Windows RDP in the browser through the tunnel. |
| **5 — Native client + hardening** | `cerebro access tcp` CLI; agent offline monitors + notifications; session recording; optional approval gate; agent self-update. | Power-user path + enterprise-grade controls. |

---

## Open decisions (carried from the design chat — confirm before/at Phase 1)

1. **Browser-first vs native-first** → **browser-first** (LCARS payoff, reuses relay). *Recommended, assumed.*
2. **Agent auth: mTLS vs signed bearer** → **mTLS** (we already have the crypto/vault primitives). *Recommended, assumed.*
3. **Credentials: vault-injected vs operator-supplied** → **support both**; default to vault-injected so operators never see secrets.
4. **Go agent as a non-TS artifact in the repo** → **yes**, `agent/` as its own module. *Confirm you're good with a Go component.*
5. **guacd sidecar** in the compose/Docker image → needed at Phase 3; fine to defer the container until then.

---

## Phase 1 readiness checklist

Everything Phase 1 touches has a verified anchor in the current tree:

- [x] **Second WS server can attach** — `main.ts:46` already calls `attachConsoleRelay(app.getHttpServer(), …)`; Fabric attaches an identical `noServer` WSS on `/api/fabric/agent/ws`.
- [x] **Relay pattern to copy** — `connectors/console-relay.ts` (token consume → upstream → pipe) is the template for both the agent relay and (Phase 2) the session relay.
- [x] **Crypto for the CA key** — `common/crypto.service.ts` `encrypt/decrypt` (AES-256-GCM) available for sealing the CA private key; rides the system-backup re-key path.
- [x] **Vault for credentials** — `SecretsService` + `{$secretRef}` resolution ready for Phase 3 injection.
- [x] **RBAC extension point** — `packages/shared/src/rbac.ts` `Permission` union + `BUILTIN_ROLES`; add `fabric:*`, rebuild shared dist.
- [x] **Module registration** — drop `FabricModule` into `app.module.ts` next to `AppReplicatorModule`.
- [x] **Migration slot** — next sequential migration is `0022_fabric` (latest on disk is `0021_replicator_ingress_meta`).
- [x] **Audit/timeline + monitors** — `AuditService.record` / timeline bus for events; monitors module for heartbeat alerting.
- [ ] **New: `agent/` Go module** — needs creating (Go toolchain + CI build target for 3 platforms). *Only genuinely new scaffolding in Phase 1.*
- [ ] **New: internal CA** — `agent-ca.service.ts` (issue/sign/verify/revoke). Small, self-contained.
- [ ] **Confirm decision #4** (Go component in the repo) before scaffolding `agent/`.

**Bottom line:** the broker side of Phase 1 is almost entirely assembly of primitives Cerebro already
has. The only net-new engineering is the **Go agent** and the **internal CA** — both small and
well-scoped. Ready to build once decision #4 is confirmed.
