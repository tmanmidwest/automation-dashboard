# UniFi connector

> **Status: SHELVED (2026-09-06).** Phase 1 was built and deployed, but **the Cerebro host cannot
> reach the UDM's management interface** (`192.168.10.1:443`) — a `curl` from the host times out
> too, so it's a network-path issue (cross-VLAN access to the gateway management interface is
> blocked, or Cerebro sits on a subnet with no route to it), not a code problem. The connector code
> was **removed** to keep the build clean; this design + the client are the starting point when the
> networking is sorted (allow the Cerebro host → `192.168.10.1:443` in UniFi, or run Cerebro on the
> UDM's subnet). The Integration-API approach below is sound; field names still need live
> verification. Original plan follows.

A connector for a UniFi network (UDM / Cloud Gateway / UNAS-hosting controller): see every
**device** (gateway, switches, APs) with its status, uptime, and firmware; **clients** on the
network; **WAN/ISP** health; and roll it up into an at-a-glance overview — then restart a device
and get alerted when one drops or a WAN link fails. Leans directly into hardware the operator
already runs (including the UNAS Pro).

```
  ┌───────────────┐   GET /proxy/network/integration/v1/sites, /.../devices, /.../clients  ┌──────────┐
  │ UniFi OS       │◀──────────────────────────────────────────────────────────────────────│  Cerebro │
  │ gateway (UDM,  │   POST /.../devices/{id}/actions {"action":"RESTART"}                   │  UniFi   │
  │ Cloud Gateway) │   X-API-KEY: <key>   (local, self-signed TLS)                           │ connector│
  └───────────────┘                                                                          └──────────┘
```

## Transport & auth — the Integration API with an API key

Ubiquiti now ships an official, documented **UniFi Network Integration API** (UniFi Network 9+ /
UniFi OS 4+) authenticated with an **API key** (`X-API-KEY` header) — no username/password, no
CSRF-cookie dance. That's what this connector targets:

- **Base URL:** `https://<gateway-host>/proxy/network/integration/v1`
- **Auth header:** `X-API-KEY: <key>` — the key is minted in UniFi OS (Settings → Control Plane →
  Integrations / Admins → API Keys) and stored in the **secrets vault**.
- **TLS:** the local gateway serves a **self-signed** certificate, so the connector defaults to
  **not verifying** TLS (a `verifyTls` toggle re-enables it for operators who install the CA).
  Same trade-off Proxmox makes for a local appliance.
- **Responses** use a pagination envelope: `{ offset, limit, count, totalCount, data: [...] }`.
  The client follows pages until `count == 0` or the total is reached.

> **Why not the legacy controller API?** The old `/proxy/network/api/s/<site>/stat/*` endpoints
> expose more data but need username/password + a login cookie + CSRF token, are undocumented, and
> change between releases. Start on the supported Integration API; if a needed datum is only in the
> legacy API, add it as an optional secondary path later (an explicit decision, like Cloudflare's
> GraphQL-for-analytics split).

### Config fields (`manifest.configFields`)

| Field | Secret? | Notes |
| --- | --- | --- |
| `host` | no | Gateway host/IP, e.g. `192.168.1.1` or `unifi.lan` (https assumed; `:port` optional) |
| `apiKey` | **yes** | UniFi OS API key — vault-encrypted |
| `siteId` | no | Optional; auto-resolved when the key sees exactly one site (usually "default") |
| `verifyTls` | no | Verify the controller's TLS cert (default **false** — local self-signed) |

## Resource kinds

| Kind | `category` | Source | Notes |
| --- | --- | --- | --- |
| `device` | — | `/sites/{id}/devices` | Gateway, switches, APs. Status, model, uptime, firmware, IP/MAC. Restartable (Phase 2). |
| `client` | — | `/sites/{id}/clients` | Connected clients (wired/wireless), name, IP/MAC, uplink device, connected-since. |

Sites map to **`listNodes`** (each site is a node on the infrastructure map). WAN/ISP status comes
off the gateway device (and, where exposed, a dedicated stats call).

Relevant endpoints:
- `GET /sites` — sites the key can see (auto-resolve `siteId`).
- `GET /sites/{siteId}/devices` — every adopted device + `state` (ONLINE/OFFLINE/…), `model`,
  `name`, `macAddress`, `ipAddress`, `firmwareVersion`, `firmwareUpdatable`.
- `GET /sites/{siteId}/devices/{deviceId}` — device detail (uptime, load, port/radio detail).
- `GET /sites/{siteId}/clients` — connected clients.
- `POST /sites/{siteId}/devices/{deviceId}/actions` body `{ "action": "RESTART" }` — device
  actions (Phase 2).
- `GET /info` — controller/application version (used by `testConnection`).

> The exact JSON field names (e.g. `firmwareUpdatable` vs `upgradable`, the WAN stats shape) are
> the thing to confirm against the live controller while building Phase 1; the client types are
> written defensively (all optional) so a mismatch degrades a tile rather than breaking a list.

---

## Phase 1 — Monitor (Integration API, read-only)

The whole read surface. Nothing mutates the network, so it's safe against a production gateway.

- **`testConnection`** = `GET /info` (cheap) → controller version; `GET /sites` to resolve the site.
- **`listResources('device')`** — normalize each device: name, `status` from `state`
  (online/offline/updating), model, IP, uptime, firmware (+ "update available" flag).
- **`listResources('client')`** — connected clients: name/hostname, IP, MAC, wired vs wireless,
  the device/port or AP/SSID they're on, connected-since.
- **`describeResource('device')`** — full device detail: model, firmware (+ updatable), uptime,
  CPU/memory load, per-port (switch) or per-radio (AP) summary, uplink.
- **`listNodes`** — one node per site.
- **`overview`** tiles:
  - devices **total / offline**, **firmware updates available**
  - clients **total** (wired vs wireless)
  - **WAN status** (up/down) + ISP latency, when the gateway exposes it
  - guests list sorted offline-first so a downed AP/switch surfaces at the top.

**Deliverable:** a live UniFi dashboard — every device and client, and the quietly-important
things (an AP offline, a WAN flap, three switches with a firmware update).

## Phase 2 — Manage (device actions)

- **Device action:** `restart` on the `device` kind → `POST /devices/{id}/actions {action:RESTART}`.
  Gated by `connectors:action` and audited (flows through the connector action path → timeline).
- Possible follow-ups the API supports: **locate** (blink the LED), **adopt/forget**. Add as the
  API surface is confirmed. Client-level actions (block/reconnect) are legacy-API-only — deferred.

## Phase 3 — Health alerts (metric-threshold monitor)

A new **UniFi** alert category wired into the generic threshold monitor (same pattern as
Cloudflare/HA/Docker):
- `unifi.devices_offline` — offline device count over a threshold.
- `unifi.firmware_updates` — devices with a firmware update over a threshold.
- `unifi.wan_down` — WAN/ISP link down (a 0/1 metric, threshold 1).

Per-connector thresholds; alerts land in the timeline via `NotificationLog`. (Device-unreachable
of the *whole controller* is already covered by the baseline connection monitor.)

## Phase 4 — Bonus (optional)

- **UNAS Pro storage** — if the controller/site exposes NAS disk usage + SMART, surface it as a
  tile + a `unifi.disk_high` alert. Otherwise a separate UNAS connector is the cleaner home.
- **Per-client / per-port traffic** and **WAN throughput** graphs — richer stats calls, cached
  like Cloudflare's analytics.
- **Live updates** via the controller's websocket event stream (`subscribeLive`, reusing the HA
  contract) so a device going offline updates the row instantly.

---

## Files touched (when built)

| File | Change |
| --- | --- |
| `apps/server/src/connectors/unifi/unifi.connector.ts` (new) | manifest + `Connector` impl |
| `apps/server/src/connectors/unifi/unifi-api.ts` (new) | typed Integration API client (X-API-KEY, self-signed TLS, pagination) |
| `apps/server/src/connectors/connectors.module.ts` | register the connector |
| `apps/server/src/notifications/alerts/alert-registry.ts` + `metric-thresholds.ts` | UniFi alert category + threshold defs (Phase 3) |
| web `ConnectorAlerts.tsx` | mirror the UniFi threshold defs (Phase 3) |
| web `ConnectorIcon.tsx` | a `unifi` icon (lucide `Wifi` / `Network`) |

## Open questions

1. **API version floor** — the Integration API needs a recent UniFi Network/OS. Confirm the
   operator's controller version; if it predates the API-key API, fall back to the legacy
   login+CSRF path (bigger, deferred).
2. **Multi-site** — most home setups are single-site ("default"); auto-resolve when one, require
   `siteId` when many (mirror Cloudflare's account-id resolution).
3. **WAN health shape** — where exactly WAN up/down + ISP latency live in the Integration API is
   the main field to pin down for the overview + `unifi.wan_down` alert.
4. **UNAS Pro** — is it reachable through this controller's API, or does it want its own connector?
   Decide once Phase 1 shows what the API exposes.
