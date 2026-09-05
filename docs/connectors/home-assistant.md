# Home Assistant connector

A read-first **home health + control** connector for a self-hosted Home Assistant
instance exposed over a public DNS name. Cerebro treats HA the way it treats Proxmox
and AWS: a typed API behind a `Connector`, entities normalized into resource kinds,
services mapped to actions/operations, and a health-oriented overview that surfaces
the quietly-broken things HA never shows you in one place.

```
  ┌──────────────┐   REST /api/states, /api/config, /api/history   ┌────────────┐
  │ Home         │◀───────────────────────────────────────────────│  Cerebro   │
  │ Assistant    │   POST /api/services/<domain>/<service>          │ HA         │
  │ (public DNS) │───────────────────────────────────────────────▶│ connector  │
  └──────────────┘   WS: subscribe state_changed (Phase 4, live)   └────────────┘
        ▲  Bearer: long-lived access token
```

## Design decision — API, not HA's MCP server

HA ships an MCP server, but it is **Assist-oriented** (voice-shaped, high-level, lossy).
For a monitoring/health/control connector we want raw entity state, attributes, and
history, so this connector is built against HA's **REST API** (and, later, its
**WebSocket API** for live updates) — exactly like Proxmox's dependency-free HTTPS
client and AWS's SDK wrapper. Cerebro already exposes *its own* MCP, so wrapping HA's
MCP would be an awkward double layer. Treat HA as one more typed API target.

Relevant endpoints:
- `GET /api/config` — HA version, location, unit system, components list (cheap; used by `testConnection`).
- `GET /api/states` — every entity + attributes (the backbone of `listResources` and `overview`).
- `POST /api/services/<domain>/<service>` — call a service (turn_on, set_temperature, lock, …).
- `GET /api/history/period/<ts>?filter_entity_id=…` — history for trend tiles.
- `GET /api/error_log` — HA core error log (health signal).
- WebSocket `/api/websocket` — `subscribe_events` on `state_changed` for live radar, **plus
  `config_entries/get` and the area registry** (Phase 4).

**REST limitation (shapes the phasing):** integration setup state (`config_entries`) and the
**area registry** are only available over the **WebSocket** API, not REST. So Phase 1
computes *all* health from the single `/api/states` pull, and integration-health +
room/area grouping arrive with the WebSocket phase.

## Auth

A single **long-lived access token** (HA → Profile → Long-Lived Access Tokens), sent as
`Authorization: Bearer <token>`. One `secret:true` config field — no OAuth dance. An
admin-scoped token unlocks the integrations/config-entries health surface; a normal token
still gets everything entity-based.

`configFields`:
| key | type | notes |
|-----|------|-------|
| `baseUrl` | url | e.g. `https://ha.example.com` |
| `token` | password (secret) | long-lived access token |
| `verifyTls` | boolean | default true (honor self-signed like Proxmox) |

## ⚠️ testConnection cost gotcha

Per the connector rules, `testConnection` runs **every minute** (connection-monitor cron)
and `overview` runs on the throttled poll **plus** every minute via resource-monitor. Keep
both cheap:
- `testConnection` → `GET /api/` only (a `{"message":"API running."}` ping). Never pull `/api/states` here.
- `overview` → **one** `GET /api/states` and compute all health counts from that single
  payload in memory. Do not fan out to `/api/history` or per-entity calls on the poll.

---

## Resource kinds (the tabs)

HA's entity graph is already "resources with state + attributes," so the mapping is direct.
Group by domain into a focused set of kinds rather than exposing all ~30 domains:

| kind id | label | actions | notes |
|---------|-------|---------|-------|
| `light` | Lights | turn_on / turn_off / toggle | brightness/color via operation (Phase 2) |
| `switch` | Switches | turn_on / turn_off / toggle | |
| `climate` | Climate | set temperature / hvac mode | operation with numeric + mode fields |
| `lock` | Locks | lock / **unlock** (destructive) | unlock gated `intent:'destructive'` |
| `cover` | Covers | open / close / stop | garage, blinds |
| `sensor` | Sensors | *(read-only)* | temp/humidity/power; battery rolled into health |
| `binary_sensor` | Binary sensors | *(read-only)* | doors/motion/leak |
| `media_player` | Media | play / pause / next / volume | |
| `automation` | Automations | trigger / enable / disable | last-triggered in details |
| `script` | Scripts | run / stop | |
| `scene` | Scenes | activate | state is a timestamp, so Activate always shows |
| `integration` | Integrations | reload | WebSocket-only (`config_entries`); Phase 4 |

Each entity normalizes to `ConnectorResource`:
- `id` = entity_id (`light.kitchen`), `name` = friendly_name, `status` = state (`on`/`off`/`unavailable`/…).
- `details` = the useful attributes (brightness, temperature, battery_level, last_changed).
- `tags` = `{ class: device_class }` so the list filters/groups by class. Room/area grouping
  needs the area registry (WebSocket-only) and arrives in Phase 4.

`describeResource` → General / State / Attributes / History-summary groups.

---

## Health — the strongest case

HA is chronically full of quietly-broken things no single view surfaces. `overview()`
computes a real health score from the one `/api/states` payload, emitting `OverviewMetric`s
that the dashboard tiles and the **metric-threshold-monitor** can alert on:

- **`unavailable` / `unknown` entity count** — the #1 "something's wrong" signal (dead
  Zigbee device, offline integration, flapping sensor). Trended over time.
- **Low-battery count** — every `device_class: battery` sensor (or `battery_level` attr)
  below a threshold, rolled into one panel. This alone justifies the connector.
- **Updates available** — `update.*` domain entities in state `on`.
- **Automations off** — `automation.*` entities in state `off`.
- **Endpoint reachability** — a plain Cerebro HTTP monitor on `baseUrl` (you already have Monitors).

Suggested metrics: `entitiesTotal`, `entitiesUnavailable`, `batteriesLow`,
`updatesAvailable`, `automationsOff`. `entitiesUnavailable` and `batteriesLow` are the money
tiles. (Integration setup-failure counts need the WebSocket `config_entries` call — Phase 4.)

---

## Monitors & alerts (reuse what's built)

Your Monitors + Notifications + metric-threshold-monitor plug in directly:
- HTTP monitor on the HA endpoint → availability of HA itself.
- Entity-state alerts via metric thresholds: `sensor.freezer_temp > X`, a door
  `binary_sensor` `on` > N min, critical entity → `unavailable`.
- `batteriesLow` / `integrationsDegraded` metrics → threshold alert → existing notification
  channels (Email / SMS / Signal).

A dedicated `ha_entity` monitor probe is possible later, but the metric-threshold path
covers most needs with zero new probe code.

---

## Controls (actions & operations)

HA services map cleanly onto the action model with the existing `confirm:true` /
`intent:'destructive'` gate:

- **Actions** (no params): light/switch/scene/automation on-off-toggle, media play/pause/next, cover open/close/stop, lock/unlock, script run, integration reload.
- **Operations** (params): `climate-set` (temperature + hvac_mode), `light-set`
  (brightness + color), `media-volume` (level). Same `operations[] + runOperation` path as
  Proxmox deploy / AWS launch.
- **Destructive-gated but genuinely useful:** restart HA Core, restart an add-on, reload a
  stuck integration.

`performAction` → `POST /api/services/<domain>/<service>` with `{ entity_id }`.
`runOperation` adds the extra service-data fields.

---

## Overview / radar

Areas become radar clusters; entity health is the pulse; the top line reads
"N unavailable · M low battery · K integrations degraded." Structurally the same as the AWS
overview, but for the house. `guests[]` samples a handful of notable entities (anything
`unavailable`, plus a few lights/climate) for the live list.

---

## Phased plan

**Phase 1 — Health & read (highest value, zero control auth). ← building now.**
`ha-api.ts` (dependency-free HTTPS client, bearer auth, friendly error mapping — copy
Proxmox's shape) + `home-assistant.connector.ts`: manifest, `testConnection` (`GET /api/config`),
read-only kinds (`sensor`, `binary_sensor`, `light`, `switch`, `climate`, `lock`, `cover`,
`media_player`, `automation`), `listResources` from `/api/states`, `describeResource`,
`overview` with the health metrics from one states pull. Register in `connectors.module.ts`.
Add an HTTP monitor on the endpoint. **Ship this alone first.**

**Phase 2 — Controls. ← DONE (built & verified 2026-09-03).** `performAction` maps
(kind, actionId) → HA service via `SERVICE_MAP` (light/switch on/off/toggle, lock/unlock
[unlock destructive], cover open/close/stop, media play/pause/next/previous, automation
enable/disable/trigger, scene activate, script run/stop) — all gated by `showWhenStatus`.
Added `scene` + `script` resource kinds. Operations `climate-set` (set_hvac_mode +
set_temperature), `light-set` (turn_on brightness_pct/color_temp_kelvin), `media-volume`
(volume_set) via `runOperation`, with `operationDefaults` prefill from live attributes and
0–100 range validation. Integration `reload` + HA Core restart deferred (reload needs the
WebSocket `config_entries` API — Phase 4).

**Phase 3 — Alerts. ← DONE (built & verified 2026-09-03).** Wired the health metrics into
the generic `metric-threshold-monitor` via four `METRIC_THRESHOLDS` defs (`entitiesUnavailable`,
`batteriesLow`, `updatesAvailable`, `automationsOff`) + matching alert types under a new
**Home Assistant** category in `alert-registry.ts` (+ the frontend `THRESHOLD_DEFS` mirror in
`ConnectorAlerts.tsx`, which scopes the inputs/rows to connectors that actually report the
metric). The user sets a per-connector threshold on the connector's **Alerts** card; the
5-minute monitor fires the matching alert (email/SMS/Signal) once on the up-crossing and
re-arms when it drops back under. No connector code changed — `overview` already emits the
metrics. Recommended starting thresholds: unavailable ≥ 1, low batteries ≥ 1.

**Phase 4 — WebSocket.** Split into increments since the pieces differ a lot in weight:

- **4a — Integration health. ← DONE (built & verified 2026-09-03).** Added `ha-ws.ts`: an
  authenticated request/response WebSocket client (`HaWsConn` + `withHaWs`) doing the
  `auth_required`→`auth`→`auth_ok` handshake, then id-matched commands. New `integration`
  resource kind sourced from `config_entries/get` (title/domain/state/reason), a **Reload**
  action (`config_entries/reload`), an `integrationsDegraded` overview metric (setup_error /
  setup_retry / migration_error / failed_unload — cached 2 min so the every-minute poll
  doesn't reconnect the WS each time; best-effort so a WS hiccup never fails the overview),
  and a matching `ha.integrations` threshold alert. Integration states also got badge colors
  (loaded → green, setup_error/failed_unload → red).
- **4b — Area/room grouping. ← DONE (built & verified 2026-09-03).** `fetchEntityAreaMap`
  resolves entity → area name via the three registries (`config/area_registry/list`,
  `config/device_registry/list`, `config/entity_registry/list`) — an entity's own `area_id`,
  else its device's `area_id`. Entities get an `area` tag (cached 10 min, best-effort so a
  restricted token just omits areas). No frontend change: the generic tag machinery gives an
  area chip, a "Tag: area" filter, and "Group by tag: area" for free.
- **4c — Live updates. ← DONE (built & verified 2026-09-03).** On-demand SSE rather than an
  always-on manager: while a client views the connector page it opens an `EventSource` to
  `GET /api/connectors/instances/:id/live`; the server holds **one** WebSocket to HA
  subscribed to `state_changed` (with keepalive pings), normalizes each changed entity to a
  `ConnectorResource` (area tags included), and pushes it over SSE. Closing the page tears the
  WebSocket down (verified: upstream subscribers return to 0). New contract bits:
  `ConnectorManifest.live` + optional `Connector.subscribeLive(ctx, onUpdate) → unsubscribe`;
  `HaWsConn` gained event delivery + keepalive. The connector-detail page merges updates into
  the current tab's rows in place (status flips, action buttons re-gate) and shows a "Live"
  marker — no polling of `/api/states` needed while watching.

Later / optional: HA Core restart (`homeassistant.restart` REST service); entity history
sparklines via `/api/history`; Zigbee/Z-Wave mesh health; Supervisor/add-on health.

---

## Connector interface sketch

```ts
// apps/server/src/connectors/home-assistant/home-assistant.connector.ts
export class HomeAssistantConnector implements Connector {
  manifest: ConnectorManifest = {
    id: 'home-assistant',
    name: 'Home Assistant',
    description: 'Monitor and control a Home Assistant instance.',
    version: '0.1.0',
    icon: 'home-assistant', // add to ConnectorIcon.tsx icon-key map
    configFields: [
      { key: 'baseUrl', label: 'Base URL', type: 'url', required: true, placeholder: 'https://ha.example.com' },
      { key: 'token', label: 'Long-lived access token', type: 'password', secret: true, required: true },
      { key: 'verifyTls', label: 'Verify TLS certificate', type: 'boolean', default: true },
    ],
    resourceKinds: [
      { id: 'sensor', label: 'Sensors', actions: [], deletable: false },
      { id: 'light', label: 'Lights', actions: [
        { id: 'turn_on', label: 'On', mutating: true, showWhenStatus: ['off'] },
        { id: 'turn_off', label: 'Off', mutating: true, showWhenStatus: ['on'] },
      ] },
      { id: 'lock', label: 'Locks', actions: [
        { id: 'lock', label: 'Lock', mutating: true, showWhenStatus: ['unlocked'] },
        { id: 'unlock', label: 'Unlock', mutating: true, intent: 'destructive',
          confirm: 'Unlock this lock?', showWhenStatus: ['locked'] },
      ] },
      // climate, switch, cover, media_player, automation, integration…
    ],
    operations: [
      { id: 'climate-set', label: 'Set temperature', scope: 'resource', kind: 'climate',
        prefill: true, fields: [
          { key: 'temperature', label: 'Target °', type: 'number', required: true },
          { key: 'hvac_mode', label: 'Mode', type: 'select', options: [/* heat/cool/auto/off */] },
        ] },
    ],
    help: { overview: '…', setupSteps: ['Profile → Long-Lived Access Tokens → Create'],
            requiredPermissions: ['Admin token for integration health (optional)'],
            referenceLinks: [{ label: 'HA REST API', url: 'https://developers.home-assistant.io/docs/api/rest/' }] },
  };

  async testConnection(ctx) { /* GET /api/  → { ok, message: 'API running', details: { version } } */ }
  async listResources(ctx, kind) { /* GET /api/states, filter entity_id domain === kind, normalize */ }
  async describeResource(ctx, kind, id) { /* one state → grouped attributes */ }
  async performAction(ctx, kind, id, actionId) {
    /* POST /api/services/<kind>/<actionId>  body { entity_id: id } */
  }
  async overview(ctx) {
    /* GET /api/states once → count unavailable, low battery, degraded integrations → metrics */
  }
}
```

Everything else — the dynamic config form, resource tabs, action buttons, operation
dialogs, detail drawer, dashboard aggregation — renders generically from this manifest with
**no frontend changes**, except adding a `home-assistant` icon key to
`ConnectorIcon.tsx`.
