# Cloudflare connector

> **Status: BUILT — connector v0.6.0, all six phases complete (2026-09-05).** 12 resource
> kinds, 6 operations, 5 alerts. Verified via per-phase harnesses and live against the real
> `api.cloudflare.com` on the :3900 test stack. Not yet git-committed / deployed (per the
> repo's edit-only workflow — the user commits, builds, and deploys). This document now
> describes what was built; the original plan is preserved in the phasing table at the end.

A read-first **edge + network health** connector for a Cloudflare account. Cerebro
treats Cloudflare the way it treats Proxmox, AWS, and Home Assistant: a typed API
behind a `Connector`, account/zone objects normalized into resource kinds, mutating
endpoints mapped to actions/operations, and a health-oriented overview that surfaces
the quietly-important things (a tunnel that just went down, a cert expiring in 6 days,
a zone left paused) in one place.

```
  ┌──────────────┐   GET /zones, /accounts/:id/cfd_tunnel, /dns_records   ┌────────────┐
  │  Cloudflare  │◀───────────────────────────────────────────────────────│  Cerebro   │
  │  API v4      │   POST /purge_cache, PATCH /settings, POST /dns_records │ Cloudflare │
  │ api.cf.com   │───────────────────────────────────────────────────────▶│ connector  │
  └──────────────┘   Authorization: Bearer <scoped API token>             └────────────┘
```

## Cost & rate limits (the short version)

- **The API is free.** No per-call charge. You only pay for underlying products, and
  Tunnels + basic DNS are free-tier. There is **no AWS-style billing risk** here.
- **Global rate limit: 1,200 requests / 5 min per token.** Trivial for a dashboard, but
  it's the reason `overview`/`testConnection` discipline still matters (they run every
  minute — see the gotcha below).
- **One paid caveat:** the rich **GraphQL Analytics** datasets and longer retention are
  plan-gated (Free gets basic zone analytics + short retention; Enterprise gets deep
  data). Tunnel health, DNS, Zero Trust config, and certs are fully available on Free.

## Design decision — REST/GraphQL API, scoped token

Built against the Cloudflare **REST API v4** (`https://api.cloudflare.com/client/v4`),
with **GraphQL** (`/graphql`) used only for analytics tiles. Dependency-free HTTPS
client in the Proxmox/HA style — no SDK needed. Auth is a single **scoped API token**
(`Authorization: Bearer <token>`), never the legacy Global API Key.

Every response uses the envelope `{ success, errors[], messages[], result, result_info }`
— the api client unwraps `result` and maps `success:false` / `errors[]` to a friendly
`CfApiError` (like HA's `HaApiError` and AWS's error mapping).

Account-scoped endpoints need an `account_id`. Zone-scoped endpoints need a `zone_id`.
Both are discoverable: `GET /accounts` and `GET /zones` list them, so the connector can
auto-resolve a single account and never make the user hunt for IDs.

Relevant endpoints:
- `GET /user/tokens/verify` — verify the token (cheap, one call, returns `status:"active"`; used by `testConnection`).
- `GET /accounts` — accounts the token can see (auto-resolve `account_id`).
- `GET /zones` — every zone + status/plan/paused/name_servers (backbone of zones + overview).
- `GET /zones/:id/dns_records` — DNS records for a zone.
- `POST|PATCH|DELETE /zones/:id/dns_records[/:rid]` — create / edit / delete records.
- `POST /zones/:id/purge_cache` — purge everything or specific URLs.
- `PATCH /zones/:id/settings/{security_level,development_mode}` — under-attack / dev mode.
- `GET /zones/:id/ssl/certificate_packs?status=all` — edge cert packs + `expires_on`.
- `GET /accounts/:id/cfd_tunnel` — tunnels + `status` (healthy/degraded/down/inactive).
- `GET /accounts/:id/cfd_tunnel/:tid/connections` — active connections (colo, client version).
- `GET /accounts/:id/cfd_tunnel/:tid/configurations` — ingress rules (public hostname → service).
- `DELETE /accounts/:id/cfd_tunnel/:tid?cascade=true` — delete a tunnel.
- `GET /accounts/:id/access/apps` · `/access/service_tokens` · `/devices` — Zero Trust (Phase 4).
- `GET /zones/:id/rulesets` (+ phases) — WAF/custom rules (Phase 5).
- `GET /accounts/:id/workers/scripts` · `/pages/projects` · `/r2/buckets`, `GET /zones/:id/load_balancers` — bonus kinds (Phase 6).
- `POST /graphql` — analytics (requests/threats/bandwidth), plan-gated (Phase 5).

## Auth

A single **scoped API token** (Cloudflare dashboard → My Profile → API Tokens →
Create Token). Grant only what you use — least-privilege by capability:

| Capability | Token permission |
|-----------|------------------|
| List zones, DNS read | `Zone → Zone → Read`, `Zone → DNS → Read` |
| Edit DNS / purge cache | `Zone → DNS → Edit`, `Zone → Cache Purge → Purge` |
| Zone settings (dev mode / security level) | `Zone → Zone Settings → Edit` |
| Certs | `Zone → SSL and Certificates → Read` |
| Tunnels | `Account → Cloudflare Tunnel → Read` (`Edit` to delete) |
| Zero Trust | `Account → Access: Apps and Policies → Read`, `Account → Access: Service Tokens → Read`, `Account → Zero Trust → Read` (WARP devices) |
| Firewall (WAF) | `Zone → Zone WAF → Read` (`Edit` to toggle rules) |
| Analytics | `Account → Account Analytics → Read`, `Zone → Analytics → Read` |
| Workers / Pages / R2 / LB | `Account → Workers Scripts → Read`, `Account → Pages → Read` (`Edit` to retry deploys), `Account → Workers R2 Storage → Read`, `Zone → Load Balancers → Read` |

The connector works with whatever the token grants — endpoints the token can't reach
return a friendly "insufficient token scope" and the affected kind/metric simply shows
empty rather than failing the whole connector (mirrors HA's admin-vs-normal token
degradation).

`configFields`:
| key | type | notes |
|-----|------|-------|
| `apiToken` | password (secret) | scoped API token (Bearer) |
| `accountId` | text (optional) | auto-resolved when the token sees exactly one account; required only for multi-account tokens |

No `verifyTls` field — the endpoint is always `api.cloudflare.com` over TLS.

## ⚠️ testConnection / overview cost gotcha

Per the connector rules, `testConnection` runs **every minute** (connection-monitor
cron) and `overview` runs on the throttled poll **plus** every minute via
resource-monitor. There's no dollar cost, but the 1,200-req/5-min limit and general
politeness mean we keep both cheap and cache anything heavy:

- `testConnection` → `GET /user/tokens/verify` only (one tiny call; also confirms the token isn't expired/revoked). Never list zones/tunnels here.
- `overview` → **two** cheap list calls (`GET /zones`, `GET /accounts/:id/cfd_tunnel`) for the tunnel/zone counts, computed in memory.
- **Everything per-zone or GraphQL goes behind a per-instance TTL cache** — same idea as
  AWS's `costCache`/`COST_TTL_MS`. There are three, each keyed by `instanceId` and cleared
  by `invalidateCache()`:
  - `certCache` (**1h**) — cert-expiry, a per-zone fan-out.
  - `ztCache` (**5min**) — Zero Trust apps/tokens/devices (account-scoped).
  - `analyticsCache` (**1h**) — GraphQL traffic totals; **it also caches the _miss_**, so a
    free-plan / no-scope failure isn't retried on every poll.
  The overview reads these caches (`fresh:false`); opening a tab fetches fresh and refreshes
  the cache. `accountCache` (**1h**) memoizes the resolved account id.

---

## Resource kinds (the tabs)

All **12** kinds, as built. "Phase" is when each landed.

| kind id | label | actions / ops | phase | notes |
|---------|-------|---------|-------|-------|
| `tunnel` | Tunnels | delete | 1/2 | status healthy/degraded/down/inactive; conns + client version in detail |
| `zone` | Zones | purge cache (action); security-level, dev-mode, purge-URLs (ops) | 1/2 | status active/pending/paused; plan; name servers |
| `dns_record` | DNS Records | proxy on/off (actions); create, edit (ops); delete | 1/2 | type/name/content/ttl/proxied; grouped by zone |
| `certificate` | Certificates | *(read)* | 3 | edge cert packs; earliest `expires_on` → expiry alert |
| `access_app` | Access Apps | *(read)* | 4 | Zero Trust apps (type, domain, AUD) |
| `service_token` | Service Tokens | *(read)* | 4 | Zero Trust; `expires_at` → status active/expired + expiry alert |
| `warp_device` | WARP Devices | *(read)* | 4 | Zero Trust enrolled devices (revoked → `deleted`) |
| `firewall_rule` | Firewall Rules | enable / disable | 5 | WAF custom rules (the `http_request_firewall_custom` entry-point ruleset) |
| `worker` | Workers | *(read)* | 6 | script name, usage model, last modified |
| `pages_project` | Pages | retry-deploy (op) | 6 | latest deployment status (success/failure/idle) |
| `r2_bucket` | R2 Buckets | *(read)* | 6 | name, location, created |
| `load_balancer` | Load Balancers | *(read)* | 6 | enabled, pool count, fallback |

Each object normalizes to `ConnectorResource`:
- `id` = the Cloudflare object id, **except where an action needs more than one id to act**.
  Those use a composite id the connector splits back apart:
  - `dns_record` → `zoneId:recordId`
  - `certificate` → `zoneId:packId`
  - `firewall_rule` → `zoneId:rulesetId:ruleId`
  - `load_balancer` → `zoneId:lbId`
  - `pages_project` → the project **name** (the API's path param)
- `name` = human name (tunnel/zone/record/app name, cert hostnames, rule description).
- `status` = the natural status string (`healthy`/`down`, `active`/`paused`, `proxied`/`dns_only`, `enabled`/`disabled`, `active`/`expired`, `success`/`failure`, …).
- `details` = the useful fields per kind.
- `tags` = structured labels for filter/group — **`{ zone }`** on DNS records, certs, firewall rules, and load balancers (list groups by zone with zero frontend work, like HA's area tag); plus `{ type }` on DNS records, `{ user }` on devices, `{ environment }` on Pages, `{ location }` on R2, and `{ status }`/`{ action }`/`{ plan }` where useful.

`statusBadgeColor` (`apps/web/src/lib/utils.ts`) was extended with the Cloudflare-specific
statuses so the badges color correctly:
- **green:** `healthy`, `proxied`, `deployed`, `success`
- **red:** `down`, `degraded`, `expired`, `deactivated`, `failure`
- **grey:** `inactive`, `dns_only`, `deleted`, `canceled`
(`active`/`enabled`/`paused` etc. were already mapped.)

## Actions & operations

**Actions** (mutating, `showWhenStatus`-gated where it makes sense):
- `zone`: **Purge cache** (everything; `confirm`, `intent:'destructive'`).
- `dns_record`: **Proxy on** (`showWhenStatus: ['dns_only']`) / **Proxy off** (`['proxied']`) via `PATCH`; proxy-on refuses non-proxiable types (TXT/MX/…) *before* writing, and forces `ttl:1` (proxied records must be automatic). Delete via `deleteResource` (typed-name drawer delete).
- `tunnel`: delete via `deleteResource` (`?cascade=true`).
- `firewall_rule`: **Enable** (`['disabled']`) / **Disable** (`['enabled']`) — re-sends the rule's `action`+`expression`+`description` with the flipped `enabled` (the rules API requires the core fields).

**Operations** (`manifest.operations[]`, form dialogs — 6 total):
- `create-dns-record` (scope `create`, kind `dns_record`): zone (select via `resolveOptions` source `cf-zones`), type, name, content, ttl, proxied → `POST /dns_records`. Proxied → `ttl` forced to 1.
- `edit-dns-record` (scope `resource`, kind `dns_record`): prefilled from the record (`operationDefaults`), edit name/content/ttl/proxied → `PATCH`.
- `zone-security-level` (scope `resource`, kind `zone`): select `essentially_off … under_attack`, prefilled from the setting → `PATCH /settings/security_level`. (Replaces the planned separate under-attack action — one control covers every level.)
- `zone-dev-mode` (scope `resource`, kind `zone`): on/off, prefilled → `PATCH /settings/development_mode`.
- `zone-purge-urls` (scope `resource`, kind `zone`): textarea of URLs → `POST /purge_cache {files:[…]}` (trims + drops blank lines).
- `pages-retry-deploy` (scope `resource`, kind `pages_project`, no fields): looks up the project's latest deployment id → `POST …/deployments/:id/retry`.

## Overview (dashboard tiles)

Computed from the two cheap list calls, plus the cached heavy metrics. Each cached block is
best-effort — a missing scope/plan drops its tiles without failing the overview:

| metric key | label | source | notes |
|-----------|-------|--------|-------|
| `tunnelsTotal` | Tunnels | `cfd_tunnel` list | cheap |
| `tunnelsDown` | Tunnels down | `cfd_tunnel` list | status down/degraded/inactive → **alert** |
| `zonesTotal` | Zones | `zones` list | cheap |
| `zonesPaused` | Zones paused | `zones` list | paused or deactivated → **alert** |
| `certsExpiringSoon` | Certs expiring | cert packs (`certCache` 1h) | ≤ **30 days** (incl. already-expired) → **alert** |
| `accessAppsTotal` | Access apps | Zero Trust (`ztCache` 5min) | info |
| `warpDevicesTotal` | WARP devices | Zero Trust (`ztCache` 5min) | excludes revoked; info |
| `tokensExpiringSoon` | Tokens expiring | Zero Trust (`ztCache` 5min) | ≤ **14 days** (incl. expired) → **alert** |
| `requests24h` | Requests (24h) | GraphQL (`analyticsCache` 1h) | plan-gated |
| `bandwidthGb24h` | Bandwidth (24h) | GraphQL (`analyticsCache` 1h) | unit `GB`; plan-gated |
| `threats24h` | Threats (24h) | GraphQL (`analyticsCache` 1h) | plan-gated → **alert** (info) |

`guests` sample = tunnels + zones, problems-first (down tunnels, paused zones on top).

## Alerts

Wired into the **generic** `metric-threshold-monitor` + alert-registry, exactly like the
HA Phase 3 pattern (no monitor-code change — `overview` emits the metrics; the monitor fires
when `value >= threshold`, so a per-connector threshold of `≥ 1` alerts on any occurrence):
- `metric-thresholds.ts` — 5 defs: `cfTunnelsDown → tunnelsDown → cloudflare.tunnels_down`,
  `cfZonesPaused → zonesPaused → cloudflare.zones_paused`,
  `cfCertsExpiring → certsExpiringSoon → cloudflare.certs_expiring`,
  `cfTokensExpiring → tokensExpiringSoon → cloudflare.tokens_expiring`,
  `cfThreats → threats24h → cloudflare.threats`.
- `alert-registry.ts` — new **`Cloudflare`** category, all `connectorScoped`, email;
  tunnels-down / zones-paused / certs-expiring / tokens-expiring = **warning**, threats = **info**.
- `ConnectorAlerts.tsx` — mirrors the 5 threshold defs. The Alerts UI already scopes threshold
  rows to connectors that report the metricKey, so these show only on Cloudflare connectors.

The single most valuable alert: **a tunnel going down.** Tunnels-down + cert-expiry
alone justify the connector.

## No live-update phase

Cloudflare has no push/WebSocket for these objects, so there's no SSE/`subscribeLive`
phase (unlike HA). Polling on the standard refresh interval is the model. `manifest.live`
stays unset.

## Phasing (all delivered)

| Phase | Scope | Status |
|-------|-------|--------|
| **1** | Read-only core: `tunnel`, `zone`, `dns_record` kinds; token-verify `testConnection`; overview (tunnels/zones counts); `describeResource`; account auto-resolve. | ✅ done (v0.1.0) |
| **2** | Write actions: DNS create/edit/delete + proxy toggle; zone purge-cache / dev-mode / security-level; tunnel delete. | ✅ done (v0.2.0) |
| **3** | `certificate` kind + expiry; alerts wiring (Cloudflare category: tunnels-down, zones-paused, certs-expiring). | ✅ done (v0.3.0) |
| **4** | Zero Trust: `access_app`, `service_token` (+ expiry alert), `warp_device`. | ✅ done (v0.4.0) |
| **5** | Analytics (GraphQL overview tiles, cached) + `firewall_rule` kind (enable/disable) + threats alert. | ✅ done (v0.5.0) |
| **6** | Bonus kinds: `worker`, `pages_project` (+ retry-deploy op), `r2_bucket`, `load_balancer`. | ✅ done (v0.6.0) |

The one deliberate deviation from the plan: the planned separate "under-attack" zone action
became the **`zone-security-level`** operation, which sets any security level (including
`under_attack`) — strictly more capable. As planned, there is **no live-update phase**.

## File layout (mirrors HA/AWS)

```
apps/server/src/connectors/cloudflare/
  cf-api.ts               # dependency-free HTTPS client. rawJson() shares the HTTP mechanics;
                          # request() unwraps the REST envelope, graphql() handles {data,errors};
                          # CfApiError friendly mapping (incl. auth codes 6003/6111/9109/…)
  cloudflare.connector.ts # the Connector class (manifest + lifecycle methods + the caches)
```
Registered in `connectors.module.ts` → `onModuleInit()` → `this.registry.register(new CloudflareConnector())`.

**Frontend touches** (the generic UI renders tabs/drawer/actions/operations/alerts from the
manifest, so these are the only web-side edits):
- `apps/web/src/components/ConnectorIcon.tsx` — `case 'cloudflare': return <CloudCog … />`.
- `apps/web/src/lib/utils.ts` — the Cloudflare statuses added to `statusBadgeColor`'s sets (see above).
- `apps/web/src/pages/connectors/ConnectorAlerts.tsx` — the 5 threshold defs mirrored for the Alerts UI.

**Build note (dev):** `nest build` uses `tsconfig.build.json` with `deleteOutDir` + an incremental
`tsconfig.build.tsbuildinfo`. Running the server build twice with no source change can leave an empty
`dist` (it deletes, then the incremental step emits nothing). Harmless for Docker (always a clean build);
for a local rebuild, `rm apps/server/tsconfig.build.tsbuildinfo` first.

## Reference links (for `help.referenceLinks`)

- API v4: https://developers.cloudflare.com/api/
- Create API token: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
- Cloudflare Tunnel API: https://developers.cloudflare.com/api/operations/cloudflare-tunnel-list-cloudflare-tunnels
- DNS records API: https://developers.cloudflare.com/api/operations/dns-records-for-a-zone-list-dns-records
- GraphQL Analytics: https://developers.cloudflare.com/analytics/graphql-api/
- Rate limits: https://developers.cloudflare.com/fundamentals/api/reference/limits/
