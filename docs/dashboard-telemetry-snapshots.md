# Persisted telemetry snapshots (instant dashboard + fleet on login)

## Problem

The dashboard **system readout** (`GET /api/connectors/overview`) and the **Docker Fleet**
page (`GET /api/docker/fleet`) both render blank right after login and only fill in on a later
poll or a manual refresh.

### Why (as built before this change)

- Both are **computed on demand** and cached **only in memory** — `overviewCache` +
  `connectorTelemetry` (a `Map`) on `ConnectorInstanceService`, and `cache` on
  `DockerFleetService`. Nothing is persisted.
- **Every redeploy wipes those caches** (fresh process). Cerebro is redeployed often, so a cold
  process is the common case at login.
- **The overview cache is only warmed as a side effect of someone viewing the dashboard.** There
  is no always-on warmer, so the *first* viewer after a restart pays a cold, blocking network
  fan-out across every connector. Docker Fleet has a background warmer, but it is gated on
  `lastAccess` (only runs while the page was recently open), so it too is cold at login.
- Meanwhile the frontend paints empty tiles during that window and silently swallows a slow/failed
  first request, so it *looks* blank until the next 5s poll (or a manual refresh) lands.

Net: telemetry that Cerebro is perfectly capable of keeping warm is instead recomputed lazily and
lost on every restart.

## Fix — a last-known-good snapshot in the database + a warmer

Store the last-good telemetry in a table, seed the in-memory cache from it on boot, and keep it
warm on a schedule. Classic **stale-while-revalidate**: a request always serves the warm value
immediately (even if slightly stale, stamped with its age) and triggers a background refresh; it
never blocks on a cold network fan-out.

### Data model (migration `0015_telemetry_snapshots`)

```prisma
/// Last-known-good dashboard telemetry for one connector, so the dashboard renders
/// instantly on login / after a redeploy instead of waiting on a cold network fan-out.
/// Written by the background warmer; seeded into an in-memory cache on boot.
model ConnectorTelemetrySnapshot {
  instanceId String            @id
  instance   ConnectorInstance @relation(fields: [instanceId], references: [id], onDelete: Cascade)
  metrics    Json              // OverviewMetric[]
  guests     Json              // { name, kind, status, node }[]
  syncedAt   DateTime          // when the telemetry was actually fetched from the connector
  updatedAt  DateTime          @updatedAt
}

/// Single-row cache (id = "singleton") of the aggregated Docker Fleet tree. Same purpose
/// as ConnectorTelemetrySnapshot, for the /docker-fleet page.
model DockerFleetSnapshot {
  id        String   @id
  data      Json     // DockerFleet
  syncedAt  DateTime
  updatedAt DateTime @updatedAt
}
```

`ConnectorTelemetrySnapshot` cascades on connector delete, so removing a connector cleans its
snapshot automatically.

### Server behaviour

**`ConnectorInstanceService`**
- Implements `OnModuleInit`: seeds `connectorTelemetry` from `ConnectorTelemetrySnapshot` on boot,
  so the very first request after a redeploy has data.
- `connectorOverview()` now writes through to the cache + persists the snapshot on every successful
  fetch. Because the per-minute `resource-monitor` cron already calls `connectorOverview()` for
  each connector (respecting `refreshIntervalSec`), **the warmer is essentially free** — the data
  it already fetches now warms and persists the dashboard cache instead of being discarded.
- `dashboardOverview()` becomes non-blocking: it aggregates from the in-memory map, serving the
  last-good value for any connector whose telemetry is stale/missing and kicking a **background**
  refresh (deduped per connector) rather than blocking the request on a live fetch.
- Each metric/tile still carries `asOf`, so the UI can show how fresh it is.

**`DockerFleetService`**
- Injects Prisma, implements `OnModuleInit`: seeds `cache` from `DockerFleetSnapshot` on boot.
- `refresh()` persists the snapshot after each successful compute.
- `fleet()` serves any warm cache immediately and refreshes in the background when stale, instead
  of blocking on a cold compute when there's already a (possibly stale) snapshot.
- The background warmer keeps the fast 15s cadence while the page is active, and also refreshes at
  least once a minute when idle, so a login gets fresh-enough data without hammering every host
  every 15s around the clock.

### Frontend polish

- `Dashboard.tsx` already keeps last-good telemetry across empty polls; add an **"as of …"**
  freshness stamp on the system-readout block and stop silently swallowing the *first* post-login
  request (quick-retry once), so a transient auth race can't leave it blank.

## Trade-off

A persisted snapshot means that immediately after a restart the dashboard can briefly show
*last-known* numbers (clearly stamped with their age) rather than nothing, until the first warm
completes. This is deliberate and strictly better than a blank — but it does mean the tiles are
"last good," not "guaranteed live to the second," for the first few seconds.

## Not doing

- No new cron: warming piggybacks the existing per-minute `resource-monitor` tick plus the
  dashboard's own 5s poll (which now triggers background refreshes on staleness).
- No change to the connector contract — `overview()` is unchanged; this is purely
  caching/persistence around it.
