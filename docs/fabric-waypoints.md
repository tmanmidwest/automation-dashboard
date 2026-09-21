# Cerebro Fabric — Waypoints (network-gateway session connectors)

> **Naming (2026-09-21):** this feature was originally drafted as "Jumpoint" (BeyondTrust's term)
> and renamed to **Waypoint** to fit the LCARS/TNG house style and avoid the trademarked term.
> Likewise the remote-browser feature was renamed **"Web Jump" → "Remote Browser."** The agent mode is
> `waypoint`; per-mode services are `cerebro-waypoint` / `com.cerebro.waypoint` / `CerebroWaypoint`.

Design + implementation plan for **Waypoints**: a second mode of the Cerebro Agent that turns a
single box into a **network proxy / bastion**, so operators can RDP / SSH / VNC / **Remote Browser** to
*any host reachable from that box's network* — not just to the box the agent runs on.

The model is a self-hosted take on **BeyondTrust PRA's Jumpoint**, living inside Cerebro: install one
Waypoint on a segment you otherwise can't reach (a DMZ, a client LAN, an OT/VLAN island behind NAT),
and every device on that segment becomes reachable through Cerebro with zero inbound firewall rules —
the Waypoint dials *out* over TLS exactly like a Fabric endpoint agent.

> **Status: Phases 1–4 BUILT (2026-09-20 / P4 2026-09-21).** **P4: per-session approval gate
> (four-eyes)** — `Agent.requireApproval` (migration 0027); a connect request through such an agent
> is held in memory (`fabric-approval.service.ts`, credentials live only in the mint closure, never
> persisted) until a `fabric:approve` user approves it, then the session is minted and returned to
> the requester's poll. New `fabric:approve` permission, `fabric.approval_requested` alert, an
> Approvals panel + badge, a requireApproval toggle, and a "waiting for approval" state on every
> connect path (SSH/RDP/VNC/ad-hoc/Remote Browser). Agent unchanged (broker-side gate). shared/server/web
> compile clean. NOT yet committed or live-tested. Remaining P4 ideas (optional): session recording
> for SSH/VNC Waypoint sessions, Remote Browser clipboard/URL policy, warm browser pool.
>
> **Status: Phases 1, 2 & 3 BUILT (2026-09-20).** P1: gateway mode, curated routes, allow-list
> push, per-mode installers, UI. P2: ad-hoc connections + egress CIDR. **P3: Remote Browser
> (option B)** — a `web` route opens an ephemeral headless-Chromium container whose traffic is
> SOCKS5-proxied through the tunnel (`remote-browser-proxy.ts`), streamed back over noVNC
> (`remote-browser.service.ts` + `fabric-remote-browser-relay.ts`); container lifecycle via the reused Docker
> Engine client; the agent needs no change (the web host:port is in the pushed allow-list).
> shared/server/web compile clean (Go agent unchanged, still v0.5.0). NOT yet committed or
> live-tested. **Remote Browser bring-up:** build the image (`docker build -t cerebro-remote-browser:latest
> docker/remote-browser`), mount the Docker socket into the app, and set `REMOTE_BROWSER_NETWORK` to the compose
> network + `REMOTE_BROWSER_CALLBACK_HOST` to the app's service name. Locked decisions: **both modes coexist per box via
> per-mode service identity** (one endpoint + one waypoint max — `cerebro-agent` vs
> `cerebro-waypoint`, not per-id); **Phase 1 is curated Routes only** (ad-hoc + egress CIDR
> deferred to Phase 2); **Remote Browser (option B)** in Phase 3. This doc is the
> buildable spec. It extends
> the existing **Fabric** feature (see `docs/fabric-remote-access.md`) rather than forking it — the
> tunnel transport, session relays (SSH/RDP/VNC), vault credential injection, host-key pinning,
> RBAC, audit, and `/fabric` UI are all reused. The only genuinely new infrastructure is the
> **Remote Browser broker**.

---

## 1. The core realization — the transport is already generic

Fabric is *already* a general TCP proxy that just happens to be locked to `127.0.0.1`:

- `AgentRegistryService.openStream(agentId, host, port)` ([agent-registry.service.ts:140](../apps/server/src/fabric/agent-registry.service.ts))
  takes an arbitrary `host:port` and has since Phase 2. The whole broker stack downstream —
  `TunnelStream` → `openTunnelForward` → ssh2 / guacamole-lite / noVNC relays — passes `host`
  end-to-end and never assumed localhost.
- The agent's `openStream` ([agent/main.go:436](../agent/main.go)) does
  `net.DialTimeout("tcp", host:port)` for whatever host it's handed.

The **one** thing pinning Fabric to per-endpoint is the agent's self-built allow-list
([agent/main.go:583](../agent/main.go)):

```go
allow := map[string]bool{
  "127.0.0.1:22": true, "127.0.0.1:3389": true, "127.0.0.1:5900": true,
}
// + self-discovered localhost services (detectTargets → Host: "127.0.0.1")
```

and `openStream` refuses anything not in it (`if !s.allow[key] { stream-error "target not allowed" }`).
That refusal is the security boundary — "the broker can never pivot the agent into arbitrary
host:ports." **A Waypoint keeps that boundary but sources the allow-list from operator-curated
targets on the LAN, pushed down from Cerebro, instead of self-discovered localhost services.**

So SSH / RDP / VNC connections are almost free. Remote Browser is the real new work.

---

## 2. Two coexisting modes (both, on the same box if wanted)

`Agent.mode`:

- **`endpoint`** (default, today's Fabric): agent self-discovers `127.0.0.1` services, builds its
  own allow-list, host key = the box itself. Zero-trust, install-on-each.
- **`waypoint`** (new): agent does **no** self-discovery for allow purposes. Its allow-list is
  **pushed from Cerebro** as the set of curated route `host:port` (+ optional egress CIDR
  ranges for ad-hoc). Host key is pinned *per target*, not per box.

The two are independent `Agent` rows with independent enrollment, so **an endpoint agent and a
Waypoint can live on the same physical machine** — useful when you want both "manage this box" and
"reach the rest of its LAN through it." This requires the installer/service identity to be
**instance-scoped** (see §6): today the service name is fixed (`com.cerebro.agent`,
`cerebro-agent.service`), which would collide. Parameterize by agent id / mode.

Keeping both is deliberate: endpoint agents are true zero-trust (the host key *is* the box);
Waypoints reduce agent sprawl but concentrate risk on one pivot host. The operator chooses per
network.

---

## 3. Data model

### 3.1 `Agent` (extend)

```prisma
model Agent {
  // ...existing...
  mode        String   @default("endpoint") // "endpoint" | "waypoint"
  /// Waypoint only: CIDR ranges the operator permits ad-hoc connections into. Empty =
  /// curated Routes only (no ad-hoc). Enforced server-side AND pushed to the
  /// agent so a compromised broker still can't widen it.
  egressCidrs String[] @default([])
}
```

### 3.2 `AgentTarget` becomes the Route (extend)

It already carries `agentId, kind, host (default 127.0.0.1), port, label, secretRef, hostKey` — it
is 90% a Route. Changes:

```prisma
model AgentTarget {
  // ...existing kind/host/port/label/secretRef/hostKey...
  kind    String // "ssh" | "rdp" | "vnc" | "web"   ← add "web"
  /// "discovered" (endpoint self-report) | "curated" (operator-defined, Waypoints)
  source  String  @default("discovered")
  /// Remote Browser only: full start URL (scheme + host + optional path). host/port are
  /// parsed from this for the tunnel + allow-list; kept separately for clarity.
  webUrl  String?
  /// Free-form grouping within a Waypoint (e.g. "Client A DMZ").
  group   String?
}
```

For a Waypoint, rows are **curated by the operator** (source = `curated`), not upserted from the
agent's `hello.targets`. `syncTargets` ([agent-registry.service.ts:276](../apps/server/src/fabric/agent-registry.service.ts))
must **skip agents whose `mode = waypoint`** so self-report can't inject allow-list entries.

### 3.3 `FabricSession` (extend for audit)

Add the resolved target so audit shows *where* a session went, not just which agent brokered it:

```prisma
model FabricSession {
  // ...existing...
  targetKind String   // add "vnc" | "web" to the existing "ssh"|"rdp"
  targetHost String?  // resolved host:port behind the Waypoint
  targetPort Int?
  targetLabel String?
}
```

Migration: `00NN_fabric_waypoints` (Agent.mode + egressCidrs, AgentTarget.kind/source/webUrl/group,
FabricSession target columns).

---

## 4. Pushing the allow-list down (server → agent)

Today `hello-ack` pushes only `heartbeatMs` + `latestAgentVersion`
([agent-registry.service.ts:238](../apps/server/src/fabric/agent-registry.service.ts)). Add the
allow-list for Waypoints, and a live-update frame for when the operator edits Routes.

- **`hello-ack`** gains, for `mode=waypoint` agents: `allow: ["ssh|host|port", ...]` (or a structured
  list) + `egressCidrs: [...]`. Built from the agent's curated `AgentTarget` rows.
- **New control frame `set-allow`** (server → agent): same payload, sent whenever an operator
  adds/edits/removes a Route, so the reachable set updates without a reconnect. Mirrors the
  existing `host-cert` / `install-ca` / `uninstall` one-shot frames.

Agent side (`agent/main.go`):

- `newSession(allow, ...)` seeds `allow` from hello-ack for Waypoints (empty local discovery).
- Handle `set-allow` → replace `s.allow` (guard with the session mutex).
- If `egressCidrs` is present, `openStream` accepts a host:port when it's either in the explicit
  allow map **or** falls inside an allowed CIDR *and* an allowed port set. Keep the default-deny.

The gate stays **on the agent** — the server sends the allow-list, but the agent is what refuses an
off-list dial, so a compromised Cerebro can't turn a Waypoint into an open proxy for the subnet.

---

## 5. Session flows

### 5.1 SSH / RDP / VNC — reuse everything

Connect flow is identical to Fabric today; only the target host differs from `127.0.0.1`:

- **SSH**: `FabricSessionService` relay → ssh2 with `sock = TunnelSocket(openStream(waypointId, host, port))`.
  Host-key pinning already per-`AgentTarget.hostKey` (TOFU) — works unchanged for LAN hosts.
- **RDP**: `openTunnelForward(registry, {agentId: waypointId, host, port})` → guacd dials the
  ephemeral forward → tunnel → the internal RDP host. `tunnel-forward.ts` already takes host+port.
- **VNC**: `pipeRawSession` raw byte pipe → tunnel → the internal VNC host.

Net new code for these three: allow-list plumbing (§4), the Route CRUD/UI (§7), and passing the
Route's `host:port` instead of localhost. That's it.

### 5.2 Remote Browser — remote browser (option B)

The chosen model: a **per-session ephemeral headless-Chromium container**, streamed to the operator,
whose browser reaches the internal web app **through the Waypoint tunnel** via a per-session SOCKS
proxy. This isolates the operator's own browser, handles any app (SPA cookies/redirects/websockets
"just work" because the browser requests the *real* internal URL), and reuses the existing display
relay. It mirrors what BeyondTrust Remote Browser does.

```
operator browser (noVNC canvas)
   ⟷  Cerebro session WS relay  (reuse pipeRawSession / noVNC path)
   ⟷  ephemeral browser container: headless Chromium + X + VNC server
                        │  Chromium --proxy-server=socks5://<per-session-bridge>
                        ▼
           per-session SOCKS5 bridge (new: remote-browser-proxy.ts)
                        │  for each CONNECT host:port →
                        ▼
           registry.openStream(waypointId, host, port)  ⟷ tunnel ⟷ internal web app
```

Pieces:

1. **Browser broker** — spins an ephemeral, single-session Chromium+VNC container per Remote Browser.
   Reuse the **Docker connector's Engine API client** to create/start/stop it on a chosen Docker
   host (or the Cerebro host). Image is baked/known (headless Chromium + `x11vnc` + minimal X, or a
   Neko-style WebRTC browser — MVP = Chromium+VNC to reuse noVNC). Fresh profile every session → no
   credential/cookie bleed between sessions. Hard teardown on session end.
2. **Per-session SOCKS5 bridge** (`apps/server/src/fabric/remote-browser-proxy.ts`) — a tiny SOCKS5
   server; each `CONNECT host:port` becomes `openStream(waypointId, host, port)` and pipes bytes.
   Constrained to the Route's host (and/or the Waypoint's `egressCidrs`) so the browser can't
   roam the subnet. Chromium is launched with `--proxy-server=socks5://…` + start URL = `webUrl`.
3. **Display relay** — reuse the VNC path (`pipeRawSession` ⟷ container's VNC) so the operator sees
   the browser in the existing full-screen viewer; no new frontend transport.
4. **Lifecycle/audit** — `FabricSession` row (`targetKind="web"`, resolved host); teardown container
   + SOCKS bridge + tunnel streams together (extend the RDP forward's `onClosed` teardown pattern).

Open decisions for Remote Browser (resolve during Phase 3 planning):

- **Where do browser containers run?** Cerebro host (needs Docker socket / the Docker connector
  pointed at "self") vs a dedicated Docker host. MVP: reuse an existing Docker connector instance +
  a config setting `remoteBrowserDockerHost`.
- **Pool vs per-session spawn.** Per-session is simplest + safest (clean profile); a warm pool cuts
  the ~1–3 s cold start later.
- **Streaming tech.** Chromium+VNC+noVNC (reuse) for MVP; consider WebRTC (Neko) later for
  smoother video + audio + clipboard.
- **File transfer / clipboard / URL allow-listing** — later hardening (BeyondTrust restricts Remote
  Browser to a host allow-list; our SOCKS bridge already enforces that).

---

## 6. Installer / enrollment

Reuse the existing enrollment + installer generation (`fabric-enrollment.service.ts`,
`agent-installers.ts`). Extend:

- **"New Waypoint"** flow = the "New agent" flow with `mode=waypoint` baked into the installer
  (server URL + one-time enroll token + `--mode waypoint`). The agent reports `mode` in `hello`;
  the server verifies it matches the `Agent.mode` it enrolled.
- **Per-mode service identity** (locked): a Waypoint and an endpoint agent coexist on one box by
  using distinct fixed names per mode — one endpoint + one waypoint max per box. Simpler than
  per-id; sufficient for the homelab/client-LAN use case.
  - Linux: `cerebro-agent.service` (endpoint) / `cerebro-waypoint.service` (waypoint),
    `/opt/cerebro-agent` / `/opt/cerebro-waypoint`
  - Windows: `CerebroAgent` / `CerebroWaypoint`
  - macOS: `com.cerebro.agent` / `com.cerebro.waypoint` launchd labels
- Self-update (`FABRIC_AGENT_VERSION`) and self-uninstall (`uninstall` frame) work unchanged; the
  remover just targets the instance-scoped unit.

---

## 7. UI (`/fabric`)

- New **Waypoints** section (or a mode filter on the inventory): each Waypoint card shows online
  status + its Routes grouped by `group`.
- **Route editor**: protocol (ssh/rdp/vnc/web), host/port or webUrl, label, group, vault
  credential (existing ssh/rdp/rdp/vnc/git SecretKind picker), host-key reset. Saving triggers a
  `set-allow` push.
- **Ad-hoc connect** (if `egressCidrs` set + permission held): a "Connect to host…" box that takes
  `host:port` + protocol, validated against the CIDR allow-list, one-off (no stored Route).
- Connect flow, creds dialog, and full-screen SSH/RDP/VNC viewers are the existing components; Remote
  Browser reuses the VNC viewer.

---

## 8. RBAC + audit

- Two new permissions, distinct from endpoint Fabric:
  - `fabric.waypoint.manage` — create Waypoints, edit Routes / egress CIDRs.
  - `fabric.waypoint.connect` — open a session through a Waypoint.
  - (Ad-hoc connect behind a third, `fabric.waypoint.adhoc`, since it's the widest.)
- Every session already audits via `FabricSession` + the timeline; ensure the resolved
  `targetHost:port` + Route label are recorded (a Waypoint brokering 40 hosts is useless in audit
  if it only logs "via Waypoint-DMZ").
- A **per-session approval gate** (four-eyes) — reaching into a client LAN is exactly where it earns
  its keep. **Built in Phase 4** (see §11).

> **RBAC as built (note):** the three dedicated `fabric.waypoint.*` permissions above were *not*
> taken. Phase 1–3 reuse the existing `fabric:manage` (create Waypoints, edit routes + egress)
> and `fabric:connect` (open any connection, curated or ad-hoc). Phase 4 adds exactly one new permission,
> `fabric:approve`. Session audit does record the resolved `targetHost`/`targetPort`/`targetLabel`
> on `FabricSession`, so a Waypoint brokering many hosts is legible in the log.

---

## 9. Suggested phasing

1. **Phase 1 — Gateway mode + SSH/RDP/VNC connections.** `Agent.mode`, curated `AgentTarget` (Route)
   CRUD, allow-list push (`hello-ack` + `set-allow`), `syncTargets` skip for waypoints, agent
   `set-allow` handling, instance-scoped installer/service. Delivers the core value; low risk (the
   transport already exists).
2. **Phase 2 — Ad-hoc connect + egress CIDR** with its own RBAC + agent-side CIDR matching.
3. **Phase 3 — Remote Browser (option B).** Browser broker (Docker Engine client), per-session
   SOCKS5 bridge, VNC display reuse, lifecycle/teardown, `web` Route kind + editor.
4. **Phase 4 — Hardening.** ✅ **Per-session approval gate (four-eyes) — built (see §11).** Still
   open (optional): session recording for SSH/VNC Waypoint sessions, Remote Browser clipboard/file/URL
   policy, a warm browser pool.

_All four phases are code-complete. §11 documents the approval gate exactly as built; §5.2 and the
status block cover Remote Browser. Agent is **v0.5.0** (unchanged since Phase 2 — Phase 4 is broker-side)._

---

## 10. Files (as built)

- **Schema/migrations**: `apps/server/prisma/schema.prisma` (`Agent.mode`/`egressCidrs`/
  `requireApproval`; `AgentTarget.source`/`group`/`webUrl`; `FabricSession.targetHost`/`targetPort`/
  `targetLabel`) + `migrations/0026_fabric_waypoints` + `migrations/0027_fabric_approval`.
- **Protocol**: `packages/shared/src/fabric.ts` (`FabricAgentMode`, `hello.mode`, `hello-ack.allow`,
  `set-allow` frame, `FabricAllowEntry`, `web` route kind + `webUrl`, approval types).
- **Allow-list push**: `agent-registry.service.ts` (`computeAllow`/`pushAllow`, hello-ack `allow`,
  `syncTargets` skips waypoints).
- **Agent (Go)**: `agent/main.go` (`--mode` flag, per-mode config dir, waypoint skips local detect,
  allow from hello-ack/`set-allow`, egress-CIDR match, thread-safe `setAllow`/`allowed`);
  `agent_linux.go` / `agent_darwin.go` / `agent_windows.go` (per-mode service identity in
  self-uninstall); `agent-installers.ts` (per-mode installer via `CEREBRO_MODE`). Agent **v0.5.0**.
- **Routes + sessions**: `fabric.service.ts` (route CRUD, `resolveStoredTarget`/
  `resolveAdhocTarget`, `issue{Ssh,Rdp,Vnc}Session`, ad-hoc methods, `gate()`), `fabric.controller.ts`.
- **Remote Browser**: `remote-browser-proxy.ts` (SOCKS5→tunnel), `remote-browser.service.ts` (container lifecycle via
  the reused `connectors/docker/docker-api.ts`), `fabric-remote-browser-relay.ts` (noVNC WS, attached in
  `main.ts`); `docker/remote-browser/` (image); `docker-compose.yml` (`REMOTE_BROWSER_*` env + Docker socket).
- **Approval gate (Phase 4)**: `fabric-approval.service.ts` (in-memory hold store), the `gate()`
  wrapper + approval routes in the service/controller, `fabric.approval_requested` in
  `notifications/alerts/alert-registry.ts`, `fabric:approve` in `packages/shared/src/rbac.ts`.
- **Web**: `apps/web/src/pages/Fabric.tsx` (Waypoints badge + routes manager, egress editor,
  ad-hoc dialog, Remote Browser chip, `requireApproval` toggle, `awaitSession()` + `WaitingApproval` on
  every connect path, `ApprovalsDialog` + header badge).

---

## 11. Phase 4 — per-session approval gate (as built)

Four-eyes for Fabric sessions: when an agent has `requireApproval`, **every** session through it —
SSH/RDP/VNC (curated *and* ad-hoc) and Remote Browser — is held until a second person approves it, then the
session is minted and handed to the requester. It is a **broker-side** gate: the Go agent is
untouched.

**Data + permission.** `Agent.requireApproval Boolean @default(false)` (migration
`0027_fabric_approval`), editable on any agent (not only Waypoints). One new permission,
`fabric:approve` (granted to the built-in Admin role).

**Hold store — in memory, no persisted credentials.** `fabric-approval.service.ts` keeps pending
requests in a `Map` (single-instance, short-lived; a restart drops them — acceptable). The crucial
property: a held request keeps the *already-resolved* session inside a **`mint` closure**, so
credentials live only in memory and are never written to a DB row. Records carry only display
metadata (agent, kind, `host:port`/URL, requester, timestamps, state).

- `request(meta, mint)` → registers the hold, fires the `fabric.approval_requested` alert, audits
  `fabric.approval.requested`, returns an `approvalId`. TTL **5 min**, then `expired`.
- `listPending()` → sanitized DTOs for approvers (never the mint/creds).
- `status(id, user)` → the requester's own poll; returns the ticket **once approved**. Only the
  requester may read their request.
- `approve(id, user)` → runs `mint()` (so side-effectful work — the guac ticket, the Remote Browser
  container — happens *at approval time*, not while waiting), stores the ticket, audits. **You cannot
  approve your own request.** A mint failure is captured as state `error` with the message.
- `deny(id, user)` → state `denied`; audits.

**The gate.** `FabricService.gate<T>(agentId, meta, user, mint)` reads `requireApproval`: off → `mint()`
immediately; on → `approvals.request(...)` and return `{ pending: true, approvalId }`. All seven
`open*` methods (SSH/RDP/VNC stored + ad-hoc, and Remote Browser) resolve their target/creds first (fail
fast, side-effect-free) and then route the side-effectful mint through `gate`, so each now returns
`FabricSessionTicket | FabricApprovalPending`.

**API.** `GET /api/fabric/approvals` (`fabric:approve`, the approver list) · `GET
/api/fabric/approvals/:id` (`fabric:connect`, the requester's poll) · `POST
/api/fabric/approvals/:id/approve` · `POST /api/fabric/approvals/:id/deny` (both `fabric:approve`).

**UI.** A shared `awaitSession()` helper turns a `{ pending }` response into a poll (≈2 s, up to the
5-min TTL) and resolves to the ticket on approval, throwing on denied/expired/error — so every
connect path shows a `WaitingApproval` banner and opens the viewer the instant it's approved (the new
browser tab, opened on click to dodge popup blockers, is navigated when ready). Approvers get an
**Approvals** header button with a live amber pending-count badge (polled) and an `ApprovalsDialog`
(list + Approve/Deny). A **Require approval (four-eyes)** checkbox sits in the machine editor.
`isApprovalPending` is *inlined* in the web (`'pending' in resp`) — never import a runtime value from
`@cerebro/shared` (it breaks the vite build).

**Notification.** `fabric.approval_requested` (category *Fabric*, default on, `warning`) routes an
"approval needed" alert to the configured channels when a request is raised.

**Still open (optional):** SSH/VNC session recording for Waypoint sessions, Remote Browser
clipboard/file/URL policy, a warm browser pool.

## 12. Reliable delete + uninstall lifecycle (as built)

Applies to **both** modes (endpoint agents and Waypoints). Previously a delete hard-dropped the
`Agent` row immediately: if the box was offline it never got the uninstall and came back as a
reconnecting **zombie** (its check-in found no row and was closed as `revoked` — never told to
uninstall), and the online uninstall was fire-and-forget (no confirmation). Now delete is a
**tombstone + positive-confirmation** lifecycle.

**State machine.** `active → (delete) → deleting → (uninstall-ack) → row purged`. A `deleting` row is a
tombstone: the box still owes us an uninstall. Every check-in re-pushes the uninstall until it sticks.

**Server.**
- `FabricService.deleteAgent` no longer deletes — it removes the target vault creds up front, then sets
  `status='deleting'`, `pendingUninstallAt`, `pendingUninstallBy`, and (if online) `requestUninstall`.
  Audit `fabric.agent.delete_requested`.
- `AgentRegistryService.onHello`: a `deleting` agent is **never** brought online — it re-pushes
  `uninstall` and returns (audit `fabric.agent.uninstall_pushed`).
- New agent→broker frame **`uninstall-ack`**: on receipt, `purgeUninstalledAgent` hard-deletes the row
  (guarded to `status==='deleting'` so a stray ack can't delete a live agent) and audits
  `fabric.agent.uninstalled`. This is the positive "it's gone" signal that closes the loop.
- `statusOf` returns `'deleting'` even while a live socket is briefly up; `finalizeOffline` skips
  tombstoned agents (no "offline" flip, no offline alert); `resolveStoredTarget`/`resolveAdhocTarget`
  refuse new sessions to a `deleting` agent.
- `FabricService.retryUninstall` (re-push to an online box) and `forceRemoveAgent` (purge the row
  without an ack — the decommissioned-box escape hatch, guarded to `deleting`). Endpoints:
  `POST /api/fabric/agents/:id/uninstall/retry`, `DELETE /api/fabric/agents/:id/force` (both
  `fabric:manage`); audits `fabric.agent.uninstall_retried` / `fabric.agent.force_removed`.

**Agent (Go, v0.5.1).** On the `uninstall` control frame the agent now sends `{t:"uninstall-ack"}` and
sleeps 300 ms to flush before `selfUninstall()` calls `os.Exit`. Self-uninstall was already mode-aware
(`resolvedMode()` → `cerebro-waypoint`/`com.cerebro.waypoint`/`CerebroWaypoint`).

**UI.** Tombstoned agents/Waypoints render in their own amber **"Removal pending"** section
(`renderPendingCard`), separate from the OS groups and the Waypoints section. Each card shows who
requested removal, a **Retry now** action (re-push if it's online), a **Force remove** action (confirm
→ purge), and a copyable **mode-aware manual uninstall command** (`uninstallCmd(os, mode)` — a Waypoint
gets `CEREBRO_MODE=waypoint … sudo -E sh`) for a box that will never check in again.

**Migration:** `0028_fabric_pending_uninstall` (adds `Agent.pendingUninstallAt`, `pendingUninstallBy`).

**Deploy note.** Full confirmation requires the **v0.5.1** agent binary on the boxes; older agents still
uninstall but don't ack, so their tombstone lingers until it's force-removed (or you can rely on the
manual command). Needs the migration + the new server + the rebuilt agent.
