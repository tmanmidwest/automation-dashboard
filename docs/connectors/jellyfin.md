# Jellyfin connector

Monitor (and, later, control) a self-hosted **Jellyfin** media server through its REST API.
The headline is a **"Now Playing"** view — every active stream, who's watching what, and crucially
**who's transcoding** (the thing that pegs your CPU/GPU) — with health tiles and alerts, wired into
Cerebro's automations / monitors / Ship's Log like every other connector.

## Transport & auth
Jellyfin is self-hosted, so the base URL is user-supplied (`http(s)://host:8096`). Auth is an **API key**
(Dashboard → API Keys), sent as the `X-Emby-Token` header. Dependency-free HTTP/HTTPS client
(`jellyfin-api.ts`) in the Proxmox/Cloudflare style; `insecureSkipVerify` for self-signed HTTPS.

- `configFields`: **Base URL** (text) + **API key** (password/secret) + optional **Skip TLS verify**.
- `testConnection` → `GET /System/Info` (ServerName + Version) — proves the key works.

## Resource kinds

| Kind | Source | Shows | Actions |
| --- | --- | --- | --- |
| **server** | `GET /System/Info` | name · version · OS | Scan all libraries · Restart · Shut down |
| **session** | `GET /Sessions` | active streams: user · title · client/device · **play method** (Direct Play / Direct Stream / **Transcode**) · progress · bitrate | Pause · Unpause · Stop · Send message |
| **user** | `GET /Users` | name · last activity · admin · enabled | Enable / Disable |
| **library** | `GET /Library/VirtualFolders` (+ `/Items/Counts`) | name · type · item count | Scan now |
| **task** | `GET /ScheduledTasks` | scheduled jobs · state · last result · progress | Run now |
| **device** | `GET /Devices` | remembered clients: user · device · app · last activity | Delete (forget) |
| **activity** | `GET /System/ActivityLog/Entries` | recent server log: name · severity · when | — (read-only) |
| **plugin** | `GET /Plugins` | installed plugins: name · version · status | — (read-only) |

## Overview (dashboard)
- Tiles: **Active streams**, **Transcodes** (alert-worthy), **Users** (total), **Movies**, **Episodes**,
  **Series**, server version.
- Guests list = the current **now-playing** sessions (user · title, status = play method, node = device) —
  same shape Docker/Proxmox use.

## Alerts (metric-threshold)
- **`jellyfin.transcodes_high`** — transcoding sessions over the limit set on the connector's page
  (server strain). Category "Jellyfin". (Others later: active-streams-high, failed-task; connection.down
  is the generic reachability alert.)

## Ties into the rest of Cerebro
- **Automations** — e.g. "transcodes > 3 → notify", "nightly at 3am → scan library", "Jellyfin unreachable → alert".
- **Monitors** — an HTTP uptime monitor on the Jellyfin endpoint.
- **Ship's Log** — playback / login / error events flow into the timeline.

## Phasing
- **Phase 1 (built + verified):** read-only — sessions (now playing), users, libraries, tasks; overview
  tiles + guests; connection health; transcode threshold alert.
- **Phase 2 (built):** controls — **Pause / Resume / Stop** a session (`POST /Sessions/{id}/Playing/{cmd}`),
  **Send message** to a client (`send-message` operation → `POST /Sessions/{id}/Message`), **Scan** a library
  (`POST /Items/{id}/Refresh`), **Run** a scheduled task (`POST /ScheduledTasks/Running/{id}`). New overview
  metric `tasksFailed`, and alerts `jellyfin.active_streams` + `jellyfin.tasks_failed` (alongside
  `transcodes_high`). Connector v0.2.0. *(User enable/disable deferred — needs the full policy round-trip.)*
- **Phase 3 (built):** **live Now Playing** via Jellyfin's WebSocket. `JellyfinApi.watchSessions` opens
  `ws(s)://host/socket?api_key=…`, subscribes (`SessionsStart` at 1.5s), answers keep-alives, and streams the
  session list; `subscribeLive` (+ `manifest.live`) maps each active session and emits a **`removed`** update
  when a stream ends. Auto-reconnects (5s). The generic frontend live handler now **drops a row on a
  `removed` update** (helps Docker's destroyed containers too). Connector v0.3.0. *(Playback/login → Ship's
  Log timeline events deferred — connectors don't publish to the TimelineBus yet; would need a small
  bus-publishing hook.)*
- **Phase 4 (built):** everything else the API cheaply exposes. New read-only kinds **device**
  (`GET /Devices`, deletable — "forget" a remembered client), **activity** (`GET /System/ActivityLog/Entries`,
  recent server log with severity), and **plugin** (`GET /Plugins`). New **server** kind (single resource
  from `/System/Info`) with **Scan all libraries** (`POST /Library/Refresh`), **Restart** (`POST /System/Restart`),
  and **Shut down** (`POST /System/Shutdown`) — both destructive + confirm. **User Enable/Disable** now
  implemented via the full policy round-trip (`GET /Users/{id}` → set `Policy.IsDisabled` → `POST /Users/{id}/Policy`).
  Connector v0.4.0.
