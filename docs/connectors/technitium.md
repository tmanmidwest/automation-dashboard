# Technitium DNS connector

Monitor a self-hosted [Technitium DNS Server](https://technitium.com/dns/) — a
combined authoritative/recursive DNS server **and** a Pi-hole-style ad-blocker,
with a built-in DHCP server.

**Status:** Phase 1 (read-only) + Phase 2 (writes) + Phase 3 (alerts) **BUILT &
VERIFIED** (logic harnesses + green builds), **not git-committed** and not live-tested
against a real server. Connector `v0.3.0`.

## Files

- `apps/server/src/connectors/technitium/technitium-api.ts` — dependency-free
  HTTP/HTTPS client (NPM/Cloudflare style). Sends the token as
  `Authorization: Bearer <token>` (required since Technitium v15), checks the
  body's `status` field, and unwraps the `response` envelope. Maps failures to a
  friendly `TechApiError`. Handles self-signed TLS via `insecureSkipVerify`.
- `apps/server/src/connectors/technitium/technitium.connector.ts` — the connector
  class (manifest + read paths).
- Registered in `apps/server/src/connectors/connectors.module.ts`.
- Icon: manifest `icon: 'technitium'` → lucide `Network` in
  `apps/web/src/components/ConnectorIcon.tsx`.
- `apps/web/src/lib/utils.ts` status sets extended: `allowed` → good (green);
  `blocked`, `dynamic`, `reserved` → idle (neutral, not alarming amber).

## Auth & config

| Field | Type | Notes |
| --- | --- | --- |
| `baseUrl` | url (required) | e.g. `http://192.168.10.1:5380` — console/API origin incl. port (default 5380). |
| `apiToken` | password (secret, required) | Administration → Sessions → Create API Token. Non-expiring recommended. |
| `insecureSkipVerify` | boolean | Accept a self-signed cert when the URL is HTTPS. |

The token inherits its user's permissions; an admin token works. Minimum for this
read-only connector: Dashboard: View, Zones: View, DHCP: View.

## Endpoints used

- `testConnection` → `GET /api/user/session/get` (cheap; validates the token and
  reports the server version — safe to run every minute per the connector cost gotcha).
- `overview` → `GET /api/dashboard/stats/get?type=LastHour` (one call). Metrics:
  queries (1h), blocked (1h), blocked %, clients (1h), zones, cached entries. The
  live guest sample is `topClients` from the same payload.
- `zone` kind → `GET /api/zones/list` (walks `pageNumber`/`totalPages`, 50/page).
- `dhcp_scope` kind → `GET /api/dhcp/scopes/list`.
- `dhcp_lease` kind → `GET /api/dhcp/leases/list` (id = IP address, name = host name).
- `allowed_zone` / `blocked_zone` kinds → `GET /api/allowed/list` /
  `GET /api/blocked/list` (direction=down): the manually allowed/blocked domains
  at the root of each tree (distinct from block-list-URL-sourced blocks).

## Resource kinds

`zone`, `dhcp_scope`, `dhcp_lease`, `allowed_zone`, `blocked_zone`. DHCP stays
read-only (`actions: []`, `deletable: false`).

Zone status: `expired` → `disabled` → else `active`; DNSSEC shown as a tag only
when signed. Lease status = its type (`dynamic`/`reserved`), tagged by scope.

## Phase 2 — writes (`v0.2.0`)

- **Zones:** `enable` / `disable` actions (`/api/zones/enable|disable`); typed-name
  delete in the drawer (`/api/zones/delete`).
- **DNS records** — a `record` sub-collection under each zone
  (`listSubResources` → `/api/zones/records/get?listZone=true`). Add / edit / delete
  for **A, AAAA, CNAME, TXT, MX, NS, PTR, SRV** via `runOperation`
  (`/api/zones/records/add|update|delete`). SOA and DNSSEC records (RRSIG/NSEC/
  DNSKEY/…) are filtered out of the editable list.
  - The sub-resource id is a base64url-encoded `{d: fullDomain, t: type, rd: {…}}`
    identity so edit/delete rebuild the exact type-specific params Technitium needs
    (e.g. an A edit sends the current `ipAddress` + `newIpAddress`, so the right
    record is targeted when a name has several). CNAME edit just sets `cname`
    (one per name). MX/SRV send current + `new*` params. `operationDefaults`
    decodes the id to prefill the edit form.
  - Record name resolution: `@`/blank → the zone root; a bare label → relative to
    the zone; an FQDN already under the zone → used as-is.
- **Allow / block lists:** `allowed_zone` / `blocked_zone` are now `deletable`
  (`/api/allowed|blocked/delete`), and each tab has an "Add" create-operation
  (`/api/allowed|blocked/add`).
- All writes are POST with params in the query string (Technitium accepts either);
  missing Zone: Modify/Delete permissions surface as a friendly error.

## Phase 3 — alerts (`v0.3.0`)

A **"Technitium DNS"** alert category, driven by the generic metric-threshold
monitor (`metric-threshold-monitor.service.ts`, fires on value ≥ a user-set
threshold) — no connector-specific monitor code, same pattern as the Cloudflare
alerts. The connector just emits the metrics; the alerts are wired in three places:

- `metric-thresholds.ts` — `technitiumZonesExpired`/`ServerFailures`/`BlockRate`
  defs mapping each overview metric key → threshold id → alert key.
- `alert-registry.ts` — the three alert types under category `Technitium DNS`.
- `ConnectorAlerts.tsx` — the mirrored `THRESHOLD_DEFS` so the connector's Alerts
  page shows a threshold row for each (only when the metric is present in overview).

| Alert key | Metric | Severity | Meaning |
| --- | --- | --- | --- |
| `technitium.zones_expired` | `zonesExpired` | warning | Zones that have expired (e.g. a secondary that failed to transfer). |
| `technitium.server_failures` | `serverFailures1h` | warning | SERVFAIL responses in the last hour (upstream/forwarder or DNSSEC trouble). |
| `technitium.block_rate` | `blockedPct` | info | Share of queries blocked in the last hour crossed the % limit (possible flooding client). |

`overview` now emits `serverFailures1h` (free, from the dashboard-stats call) and
`zonesExpired` (one extra best-effort `zones/list` call, wrapped in try/catch so it
never sinks the overview). `blockedPct` was already emitted in P1. The monitor only
fires once the user sets a threshold on the connector's Alerts page.

## Future phases (not built)

- **P4:** flush DNS cache, logs browsing, block-list-URL management, DHCP
  reservation create/convert, Prometheus metrics for observability.
