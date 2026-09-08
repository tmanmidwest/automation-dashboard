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

| Kind | Source | Shows | Actions (Phase 2) |
| --- | --- | --- | --- |
| **session** | `GET /Sessions` | active streams: user · title · client/device · **play method** (Direct Play / Direct Stream / **Transcode**) · progress · bitrate | Pause · Unpause · Stop · Send message |
| **user** | `GET /Users` | name · last activity · admin · enabled | Enable / Disable |
| **library** | `GET /Library/VirtualFolders` (+ `/Items/Counts`) | name · type · item count | Scan now |
| **task** | `GET /ScheduledTasks` | scheduled jobs · state · last result · progress | Run now |

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
- **Phase 1 (this pass):** read-only — sessions (now playing), users, libraries, tasks; overview tiles +
  guests; connection health; transcode threshold alert.
- **Phase 2:** controls — pause/unpause/stop/message a session, scan a library, run a task; +
  active-streams / failed-task alerts.
- **Phase 3:** live now-playing via Jellyfin's **WebSocket** session events (`subscribeLive` + `manifest.live`),
  and timeline events.
