# Pi-hole connector (design)

A Cerebro connector for [Pi-hole](https://pi-hole.net/) — the network-wide DNS
sinkhole / ad-blocker (with optional DHCP). Monitor query volume and block rate,
see top clients/domains, manage allow/deny lists and adlists, and toggle blocking.

**Status: DESIGN / PLANNED — not built.** This doc is the plan; nothing is coded
yet. It targets the **Pi-hole v6 REST API** (FTL's built-in HTTP API). It reuses
the connector pattern and most of the learnings from the Technitium connector
(see `docs/connectors/technitium.md`), which is Pi-hole's closest sibling
(DNS + ad-block + DHCP) — but the two APIs differ significantly, so this is a
separate connector, not a mode of that one.

> Verify every path/field below against your own instance's live, versioned API
> docs at `http://<pi-hole>/api/docs` before implementing — v6's API is young and
> still shifting. The headline shapes here are confirmed against the official
> docs; some sub-fields are from community clients and marked where uncertain.

## Why a separate connector (vs. Technitium)

Same problem domain, but Pi-hole's v6 API is structurally different from
Technitium's:

| | Technitium | Pi-hole v6 |
| --- | --- | --- |
| Auth | Bearer **API token** (stateless) | **Session** (`sid`) obtained by password login; expires on inactivity |
| Envelope | `{ status, response }` | plain JSON; errors are an `error` object `{key,message,hint}` |
| Blocking model | allow/block *zones* + block-list URLs | gravity (adlists) + allow/deny **domains** (exact/regex) + groups/clients |

The session model is the main new wrinkle and drives the API-client design below.

## Auth & session handling (the key design point)

Pi-hole v6 is session-based, confirmed against the official auth docs:

1. **Login:** `POST /api/auth` with JSON `{"password":"<app-password>"}` (add
   `"totp":<code>` only if 2FA is on). On `200`, the response has a `session`
   object: `session.sid`, `session.csrf`, `session.validity` (seconds),
   `session.valid`, `session.totp`.
2. **Subsequent requests:** send the SID in the **`X-FTL-SID`** header (simplest
   of the four accepted ways — header, `?sid=`, JSON field, or cookie+`X-FTL-CSRF`).
   We use the header and avoid cookies/CSRF entirely.
3. **Expiry:** each successful call extends the session; a prolonged idle period
   expires it (→ `401`). The server also **caps concurrent sessions**.
4. **Logout:** `DELETE /api/auth` frees the slot (`204`).
5. **No password set:** if the instance has no password, auth is disabled and
   calls work without a SID — handle this (skip login, don't fail).

**API-client design (`pihole-api.ts`):** a dependency-free HTTP/HTTPS client
(like `technitium-api.ts`/`npm-api.ts`) that **caches one `sid` per connector
instance** and reuses it across a fan-out. On `401` (or no cached sid) it logs in
once, stores the sid, and retries the call a single time. This matters because of
the **every-minute `testConnection` cost gotcha** (see the Technitium/AWS notes):
re-authenticating on every poll would churn through the session cap and defeat the
inactivity timer. Instead, the long-lived cached sid is kept warm by the regular
polls; we never call `DELETE /api/auth` except on `invalidateCache`.

Config field is an **application password**, not the admin web password —
generated in the Pi-hole UI under *Settings → Web interface / API → App password*.
This keeps the real password out of the vault and works when 2FA is enabled.

## Config fields

| Field | Type | Notes |
| --- | --- | --- |
| `baseUrl` | url (required) | Pi-hole origin, e.g. `http://192.168.1.2` (API served at `/api`). Include a port if non-standard. |
| `appPassword` | password (secret) | App password from *Settings → Web interface / API*. Leave blank only if the instance has no password. |
| `insecureSkipVerify` | boolean | Accept a self-signed cert when `baseUrl` is HTTPS. |
| `totp` | text (optional) | Only if 2FA is enabled and no app password is used; app password is strongly preferred. |

## Endpoint map (v6)

- **Auth:** `POST /api/auth`, `DELETE /api/auth`.
- **Overview/stats:** `GET /api/stats/summary` (queries total/blocked/
  `percent_blocked`/unique/forwarded/cached; `clients.active`; `gravity.
  domains_being_blocked`, `gravity.last_update`), `GET /api/stats/top_domains`,
  `GET /api/stats/top_clients`, `GET /api/stats/upstreams`,
  `GET /api/stats/query_types`.
- **Blocking:** `GET /api/dns/blocking` → `{ blocking, timer }`;
  `POST /api/dns/blocking` `{ "blocking": false, "timer": 300 }` to disable
  temporarily (or enable).
- **Domains (allow/deny):** `GET /api/domains`,
  `GET /api/domains/{allow|deny}/{exact|regex}`,
  `POST /api/domains/{type}/{kind}` `{domain, comment?, enabled?, groups?}`,
  `PUT`/`DELETE /api/domains/{type}/{kind}/{domain}`.
- **Adlists:** `GET /api/lists`, `POST /api/lists` `{address, type:block|allow}`,
  `GET`/`PUT`/`DELETE /api/lists/{address}`.
- **Groups / Clients:** `GET|POST /api/groups`, `.../{name}`;
  `GET|POST /api/clients`, `.../{client}`.
- **History / queries:** `GET /api/history`, `GET /api/history/clients`,
  `GET /api/queries`.
- **Info:** `GET /api/info/version`, `/api/info/system`, `/api/info/ftl`,
  `/api/info/host`, `/api/info/sensors`, `/api/info/metrics`,
  `/api/info/messages` (FTL diagnosis).
- **Network / DHCP:** `GET /api/network/devices`, `GET /api/network/gateway`,
  `GET /api/dhcp/leases`, `DELETE /api/dhcp/leases/{ip}`.
- **Actions:** `POST /api/action/gravity` (update adlists),
  `POST /api/action/restartdns`, `POST /api/action/flush/logs`,
  `POST /api/action/flush/arp`.

## Proposed resource kinds

Phase 1 is read-only; later phases make them deletable / add actions.

| Kind | Source | Notes |
| --- | --- | --- |
| `allow_domain` | `/api/domains/allow/*` | exact + regex; `tags:{kind}` |
| `deny_domain` | `/api/domains/deny/*` | exact + regex |
| `adlist` | `/api/lists` | block/allow lists; status from `enabled`; `tags:{type}` |
| `group` | `/api/groups` | enabled/disabled |
| `client` | `/api/clients` | configured clients + group membership |
| `dhcp_lease` | `/api/dhcp/leases` | only if the instance runs Pi-hole's DHCP |

## Overview (dashboard summary)

One cheap `GET /api/stats/summary` (plus the cached-sid login) per poll:

- Metrics: `queriesToday`, `blockedToday`, `blockedPct` (%), `clientsActive`,
  `domainsOnGravity` (blocklist size), and `blockingDisabled` (0/1 from
  `/api/dns/blocking` — one extra cheap call, drives the P3 alert).
- Guests (live sample): top clients from `top_clients` (IP/name + hit count),
  mirroring the Technitium overview.

## Phasing

- **P1 — read-only:** summary overview + top clients tile; kinds `allow_domain`,
  `deny_domain`, `adlist`, `group`, `client`, `dhcp_lease`; `describeResource`
  for each; session-caching API client; `testConnection` = `GET /api/info/version`
  on the cached sid. **Most valuable single view:** block rate + whether blocking
  is currently disabled.
- **P2 — writes:** the headline **Enable / Disable blocking** (with a
  "disable for N minutes" timer op — Pi-hole's signature action); add/remove
  allow & deny domains (exact/regex); add/remove adlists; **Update gravity**,
  **Flush logs**, **Restart DNS** (server-level `scope:'create'` ops, as in
  Technitium P4); delete a DHCP lease.
- **P3 — alerts:** a **"Pi-hole"** alert category via the generic
  metric-threshold monitor (no connector-specific monitor code — the 3-place
  wiring in `metric-thresholds.ts` + `alert-registry.ts` + `ConnectorAlerts.tsx`,
  exactly like the Cloudflare/Technitium alerts):
  - `pihole.blocking_disabled` (warning) ← `blockingDisabled` — fires when someone
    left blocking off (threshold 1). Arguably the single most useful alert.
  - `pihole.block_rate` (info) ← `blockedPct` — spike may mean an infected client.
  - `pihole.ftl_messages` (warning) ← count from `/api/info/messages` — FTL
    flagged a diagnosis issue.
  - `pihole.gravity_stale` (info) ← days since `gravity.last_update`.
- **P4 — extras:** query-log browsing (`/api/queries`), group/client membership
  editing, network-devices view, PADD-style live tile, temperature/`sensors`
  tile, and (observability roadmap) a Prometheus/metrics feed from
  `/api/info/metrics`.

## Files (when built)

- `apps/server/src/connectors/pihole/` — `pihole-api.ts` (session-caching
  HTTP/HTTPS client) + `pihole.connector.ts` (the class).
- Register in `apps/server/src/connectors/connectors.module.ts`
  (`this.registry.register(new PiholeConnector())`).
- Icon: manifest `icon: 'pihole'` → a custom glyph in
  `apps/web/src/components/ConnectorIcon.tsx` (Pi-hole has no Lucide icon; a
  shield/"pi" glyph, or reuse a `ShieldBan`-style mark).
- Extend the status-color sets in `apps/web/src/lib/utils.ts` for any new status
  strings (most — `enabled`/`disabled`/`blocked`/`allowed` — already exist from
  the Technitium work).

## Open questions / caveats

- **v5 is out of scope.** Legacy Pi-hole v5 used `GET /admin/api.php?...&auth=<hash>`,
  a completely different (and now superseded) API. This connector is v6-only; if a
  v5 target is ever needed it would be a separate code path.
- Some operations that existed in v5 moved or changed in v6 (community reports note
  a few list operations are UI-only in early v6 builds) — confirm add/delete domain
  and adlist writes against the target version's `/api/docs` before building P2.
- Session cap: keep exactly one cached session per instance; verify the connection
  monitor's every-minute `testConnection` reuses it and never logs in afresh.
