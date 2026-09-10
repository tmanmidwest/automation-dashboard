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
| **user** | `GET /Users` | name · last activity · admin · enabled | New user · Edit settings (full policy + config) · Set password · Set/Remove avatar · Make/Revoke admin · Enable/Disable · Delete |
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
- **Phase 5 (built):** full **user management**. **New user** (`create-user`, scope `create` on the user kind →
  `POST /Users/New`, then a policy round-trip if Administrator is checked), **Set password** (`reset-password`
  resource op → `POST /Users/{id}/Password` as admin, blank clears it), **Make / Revoke admin** (policy
  round-trip toggling `Policy.IsAdministrator`), and **Delete** user (user kind now `deletable` →
  `DELETE /Users/{id}`), alongside the existing Enable/Disable. Connector v0.5.0.
- **Phase 6 (built):** **full user editor** — an **Edit settings** operation (`edit-user`, scope `resource`,
  `prefill: true`) that opens populated with the user's current **Policy** *and* **Configuration** and mirrors
  the whole Jellyfin user page: rename; every permission toggle (playback/transcoding/remuxing, content
  deletion/downloads/conversion, collection/subtitle/live-TV management, remote access & remote control,
  hidden); library/device/channel access (all-vs-list, libraries picked by **name**); parental control
  (max rating, block unrated types, blocked/allowed tags); limits (max sessions, remote bitrate, lockout);
  SyncPlay + auth providers; and the display Configuration (audio/subtitle language + mode, missing episodes,
  auto-play next, remember selections, local PIN, latest/my-media excludes, home library order). Driven by one
  `USER_FIELD_DEFS` descriptor list that generates the form fields, the prefill (`operationDefaults`), and the
  save coder — so each field round-trips through the same key/target/type. **Save merges over the freshly
  fetched Policy/Configuration** (only managed keys overridden), so unmanaged/structured settings (e.g.
  `AccessSchedules`) are preserved. API additions: `getUser` now returns `Configuration`; new
  `setUserConfiguration` (`POST /Users/{id}/Configuration`) + `updateUser` (`POST /Users/{id}` for rename).
  Library-id ↔ name mapping via `/Library/VirtualFolders`. Connector v0.6.0. *(AccessSchedules time-window
  editing is intentionally left out of the form — preserved but not editable here.)*
- **Phase 7 (built):** **avatar upload.** New **Set avatar** operation (`set-avatar`, scope `resource`) with a
  new framework `image` form-field type (renders a file picker, downscales large images to ≤512px / JPEG on the
  client so the JSON payload stays small, and stores the result as a `data:` URL string) → the connector parses
  the data-URL and `POST /Users/{id}/Images/Primary` with the raw base64 body + the image MIME as `Content-Type`
  (`JellyfinApi.setUserImage`, via a new raw-body branch in the request helper). A **Remove avatar** user action
  clears it (`DELETE /Users/{id}/Images/Primary` → `deleteUserImage`). Shared: `ConnectorFormField.type` gains
  `'image'`, handled generically in `OperationDialog` (reusable by any future connector). Connector v0.7.0.
  The `image` field also offers **inline camera capture** for tablet/kiosk setup — a "Take photo" button opens a
  live `getUserMedia` viewfinder (rear camera hint, downscaled to ≤512px JPEG on capture, same data-URL path).
  It requires a secure context (HTTPS/localhost); on an insecure-origin tablet the button is hidden and the file
  picker (which still exposes the OS camera on mobile) is the fallback. No server change — a captured photo is
  the same data-URL an uploaded file produces.
