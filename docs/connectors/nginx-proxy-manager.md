# Nginx Proxy Manager connector

Monitor (and, later, manage) one or more self-hosted **Nginx Proxy Manager** (jc21/NPM)
instances through NPM's REST API — the same API its own web UI drives. The headline is a
**hosts + certificates** view: every proxy host and where it forwards, whether it's enabled
and reachable, and — the part NPM itself won't nag you about — **which SSL certificates are
about to expire**. Wired into Cerebro's overview tiles, and (later) automations / monitors /
Ship's Log like every other connector.

You run a couple of NPM boxes, so each is just another connector **instance** (same as Docker
Fleet / multiple Proxmox nodes); Command Palette search deep-links across all of them.

## Transport & auth
NPM is self-hosted, so the base URL is user-supplied — the **admin UI origin**, e.g.
`http://10.0.0.5:81` (NPM's admin defaults to port 81). Auth is a short-lived **JWT** obtained
from the login endpoint:

- `POST /api/tokens` with `{ identity: <email>, secret: <password> }` → `{ token, expires }`
  (default expiry ~1 day; `GET /api/tokens` with the bearer refreshes it).
- Every other call sends `Authorization: Bearer <token>`.

The connector mints a token lazily per API instance and reuses it across the calls in one
fan-out (so a `listResources` / `overview` pass logs in once). Dependency-free HTTP/HTTPS client
(`npm-api.ts`) in the Jellyfin/Cloudflare style; `insecureSkipVerify` for self-signed HTTPS.

- `configFields`: **Base URL** (text) + **Email** (text) + **Password** (password/secret) +
  optional **Skip TLS verify**.
- `testConnection` → `POST /api/tokens` (proves the credentials) then `GET /api/` for the NPM
  version string.

> **Note on the API:** jc21 documents this API as "for the UI, use at your own risk" — it isn't a
> stability-contracted public API, but it has been stable across releases in practice. We pin to
> the documented endpoints below and degrade gracefully (a kind that errors returns an empty list
> rather than failing the whole connector). NPM also serves its own schema at `GET /api/schema`.

## Resource kinds

| Kind | Source | Shows | Actions (Phase 2) |
| --- | --- | --- | --- |
| **proxy_host** | `GET /api/nginx/proxy-hosts` | domains · `scheme://host:port` upstream · SSL forced? · enabled/online | Enable · Disable · Delete · **Add/Edit** (operation forms) |
| **redirection_host** | `GET /api/nginx/redirection-hosts` | domains · → target · HTTP code · enabled | Enable · Disable · Delete |
| **stream** | `GET /api/nginx/streams` | incoming port · → host:port · TCP/UDP · enabled | Enable · Disable · Delete |
| **dead_host** | `GET /api/nginx/dead-hosts` | 404 hosts: domains · enabled | Enable · Disable · Delete |
| **certificate** | `GET /api/nginx/certificates` | provider (Let's Encrypt / custom) · domains · **expiry** · status | Renew (LE only) · Delete |
| **access_list** | `GET /api/nginx/access-lists` | name · auth users · client rules · # hosts using it | Delete |

Status derivation:
- **hosts**: `enabled ? 'online' : 'disabled'`, downgraded to **`error`** when
  `meta.nginx_online === false` (NPM couldn't bring the vhost up — bad config / cert).
- **certificate**: `expired` when past `expires_on`, **`expiring`** within 14 days, else `valid`.

## Overview (dashboard)
- Tiles: **Proxy hosts**, **Disabled** (hosts turned off), **Errored** (hosts NPM couldn't start),
  **Certificates**, **Expiring ≤14d** (alert-worthy), **Streams**, **Redirections**.
- Counts come cheaply from `GET /api/reports/hosts` (`{ proxy, redirection, stream, dead }`) plus
  one certificates pull for the expiry math.
- Guests list = a sample of proxy hosts (name = primary domain, status = online/disabled/error) —
  same shape Docker/Proxmox/Jellyfin use.

## Roadmap

**Phase 1 — read-only (done).** All six kinds above + overview tiles + `testConnection`.
Proves the token flow and the mappings against real NPM instances with zero write risk.

**Phase 2 — manage (done).** Writes on the existing kinds:
- Enable/disable a proxy/redirection/stream/dead host (`POST /api/nginx/<segment>/{id}/enable|disable`),
  exposed as status-gated `ConnectorAction`s.
- **Renew a certificate** (`POST /api/nginx/certificates/{id}/renew`) — offered on all certs, but
  rejected with a clear message for non-Let's-Encrypt (custom) certs.
- **Delete** any host / certificate / access list (`DELETE /api/nginx/<segment>/{id}`) via the
  generic delete control.
- **Add / edit a proxy host** via `ConnectorOperation` forms (`POST` / `PUT /api/nginx/proxy-hosts/{id}`).
  Domains are entered as a textarea (split on comma/space/newline); the SSL certificate is a dynamic
  dropdown (`resolveOptions('npm-certs')`, "None" = HTTP only); force-SSL is auto-cleared when no cert
  is attached. **Edit** prefills from the live host and **merges** back — fields the form doesn't
  expose (HSTS, HTTP/2, access list, advanced config, custom locations) are read from the existing
  host and preserved on save, so an edit never silently drops them.

**Phase 3 — health alerts (done).** A "Nginx Proxy Manager" alert category on the metric-threshold
monitor, wired the same way as HA/Cloudflare/Docker/Jellyfin (thresholds set per connector on its
Alerts card; the monitor reads the connector's cached overview every 5 min and fires once on the
up-crossing). Three defs — the overview already emits all three metric keys, so no connector change
was needed:
- `npm.certs_expiring` ← `certsExpiring` — certificates expiring ≤14d or already expired (warning, on).
- `npm.hosts_errored` ← `erroredHosts` — hosts NPM couldn't bring online (warning, on).
- `npm.hosts_disabled` ← `disabledHosts` — disabled proxy hosts (info, off by default).
- (`connection.down` is the generic reachability alert, free with the connector.)

Registered in `alert-registry.ts` + `metric-thresholds.ts` (server) and the `THRESHOLD_DEFS` mirror
in `ConnectorAlerts.tsx` (web) — the web mirror is what gates a threshold to only show on connectors
that report its metric.

**Phase 3.5 — audit-log feed (done).** `NpmAuditPollService` polls `GET /api/audit-log?expand=user`
every 5 min for each enabled NPM instance and mirrors NPM's own change history into the unified
Ship's Log timeline:
- Records new entries through `AuditService.record()`, which persists to the `AuditLog` table **and**
  publishes to the live timeline bus (so events appear in the SSE tail immediately). No new table or
  migration — the timeline already unions `AuditLog`.
- `meta.connectorId = instance.id` sets the event's `source`, so entries land on that connector's
  filtered timeline. Titles read "NPM proxy host created — app.example.com"; deletes map to `warning`.
- **Dedupe** is a per-instance high-watermark in Settings (`npm.audit.<instanceId>.lastId`); only ids
  above it are recorded, and the watermark advances after each poll. The **first** sight of an instance
  seeds the watermark to the current max *without* replaying history (no backfill flood). Capped at the
  newest 200 entries per poll to bound a long-lived NPM's log.

`ConnectorInstanceService.contextFor()` was added (public) so the poller can build a decrypted context
and reach NPM's API outside the generic `Connector` interface.

Access-list membership drill-in remains a nice-to-have.

## Ties into the rest of Cerebro
Registered in `ConnectorsModule`; icon `nginx-proxy-manager`. Overview metrics feed the dashboard
and (Phase 3) the threshold monitor; resources are searchable/deep-linkable via the Command Palette;
multiple NPM boxes are independent instances aggregated by the generic connector UI.
