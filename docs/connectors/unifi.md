# UniFi Network connector

**Status:** built (connector `v0.1.0`), tested against a mocked UniFi API only. Not yet
live-tested against the real UDM SE.

> **History.** A first Integration-API-only version was built and shelved on 2026-09-06
> because the Cerebro host could not reach the UDM's management interface
> (`192.168.10.1:443`). A `curl` from the host timed out too, so the cause was the network
> path (cross-VLAN access to the gateway blocked), not the code. **That path still has to be
> open** for this connector to work: allow the Cerebro host → console on TCP 443 in the
> UniFi firewall, or run Cerebro on a subnet that can reach it. Until then the connector
> shows "Console unreachable".

Monitors and manages a UniFi OS console (built for the **UDM SE**; works with UDM / UDM Pro /
UCG / UDR / UXG running the Network application).

## Files

| File | What |
| --- | --- |
| `apps/server/src/connectors/unifi/unifi-api.ts` | Dependency-free HTTP client: API key or local login, CSRF, self-signed TLS, Integration-API fallback |
| `apps/server/src/connectors/unifi/unifi.connector.ts` | Manifest + `Connector` implementation |
| `apps/server/src/connectors/connectors.module.ts` | Registration |
| `apps/server/src/notifications/alerts/metric-thresholds.ts` + `alert-registry.ts` | UniFi threshold alerts |
| `apps/web/src/pages/connectors/ConnectorAlerts.tsx` | Mirror of the threshold defs |
| `apps/web/src/components/ConnectorIcon.tsx` | `unifi` → lucide `Wifi` |
| `apps/web/src/lib/utils.ts` | Status colors: `up` good; `heartbeat_missed`/`adopt_failed`/`isolated` bad; `no_link` idle |

## Transport and auth

The connector talks to the Network application's **classic controller API** through the
console's reverse proxy: `https://<console>/proxy/network/api/s/<site>/…`. That surface has
far more than the official Integration API: health, WAN/ISP, per-port PoE, radios, alarms,
events, config, and commands.

| Field | Secret | Notes |
| --- | --- | --- |
| `baseUrl` | no | `https://192.168.10.1`, the console's web UI address |
| `apiKey` | yes | Recommended. Network → Settings → Control Plane → Integrations. Sent as `X-API-KEY`. |
| `username` / `password` | password yes | Alternative: a **local-only** admin. `POST /api/auth/login` → `TOKEN` cookie + `X-CSRF-Token`; session cached 30 min (keyed by console + user + password hash), refreshed on 401. |
| `site` | no | Site short name, default `default` |
| `verifyTls` | no | Default **off** (consoles ship a self-signed cert) |

**Integration-API fallback.** If the classic API rejects the API key with 401/403, the client
switches to `/proxy/network/integration/v1` (sites → devices + `statistics/latest` → clients).
Devices and clients still list, with CPU/mem/uptime, but WAN health, ports, alarms, config and all
actions need the classic API, so they return empty or tell the user to use a username/password.
The connection test reports which mode is active.

## Endpoints used

| Purpose | Endpoint |
| --- | --- |
| Console + app version | `GET stat/sysinfo` |
| Subsystem health (wan, www, lan, wlan, vpn) | `GET stat/health` |
| Devices (ports, radios, WAN, temps, storage, speed test) | `GET stat/device` |
| Connected clients | `GET stat/sta` |
| Known clients (blocked list) | `GET rest/user` |
| Networks / Wi-Fi / port forwards | `GET rest/networkconf`, `rest/wlanconf`, `rest/portforward` |
| Alarms | `GET list/alarm` (archived filtered client-side). Current UDM SE firmware (UniFi OS 5.x) answers both alarm endpoints with 400 `api.err.InvalidObject`; then the Alarms tab shows the system log's high/very_high/critical entries (not archivable). |
| Events (24h) | `POST /proxy/network/v2/api/site/<site>/system-log/all` `{timestampFrom, timestampTo, pageNumber, pageSize}`; message templates filled from `parameters`. Falls back to `GET stat/event?within=24` on older firmware (current firmware returns nothing there). |
| Device restart / locate / upgrade / PoE power-cycle / speed test | `POST cmd/devmgr` |
| Client reconnect / block / unblock | `POST cmd/stamgr` |
| Archive alarm(s) | `POST cmd/evtmgr` |
| Wi-Fi / port-forward enable/disable | `PUT rest/wlanconf/<id>`, `rest/portforward/<id>` |

## Resource kinds

| Kind | Actions | Notes |
| --- | --- | --- |
| `device` | locate, stop locating, restart, upgrade firmware | Detail: health (CPU, mem, every temp sensor, fan), traffic, uplink, each WAN link, speed test, console versions, radios, port summary, storage. **Ports** sub-collection with speed, PoE draw, who's plugged in (clients + LLDP + downstream devices), errors; item action **Power-cycle PoE**. |
| `client` | reconnect, block | IP, MAC, wired/Wi-Fi, SSID + 802.11 standard, AP or switch port, signal, live rates, uptime, vendor. Tags: connection, network, ssid, guest. |
| `blocked_client` | unblock | From `rest/user` where `blocked`. |
| `wan` | — | Each enabled WAN slot (UDM SE: WAN1 RJ45, WAN2 SFP+). Up/down, IP, ISP, link, live rates, latency, availability, primary. Create-scope op **Run speed test** (background; polls ~2 min for the result). |
| `network` | — | Purpose, subnet, VLAN, DHCP range. |
| `wlan` | enable, disable | Clients per SSID, security, bands, network. |
| `port_forward` | enable, disable | |
| `alarm` | archive | Create-scope op **Archive all alarms**. On firmware without classic alarms: high-severity system-log entries, read-only. |
| `event` | — | Last 24h. |

`listNodes` returns the gateway (CPU, memory, uptime).

## Overview metrics

Keys are prefixed `unifi` so they never merge into another connector's dashboard tile
(`cpuPct`, `nodes`, … are Proxmox's).

`unifiDevices`, `unifiDevicesOffline`, `unifiFirmwareUpdates`, `unifiAps`, `unifiSwitches`,
`unifiClients`, `unifiClientsWireless`, `unifiClientsWired`, `unifiGuests`, `unifiWanDown`,
`unifiWanLatencyMs`, `unifiWanDownMbps`, `unifiWanUpMbps`, `unifiWanAvailabilityPct`,
`unifiSpeedtestDownMbps`, `unifiSpeedtestUpMbps`, `unifiWanDrops`, `unifiGatewayCpuPct`,
`unifiGatewayMemPct`, `unifiGatewayTempC`, `unifiStoragePct`, `unifiPoeWatts`, `unifiVpnUsers`,
`unifiAlarms` (classic alarms only), `unifiHighEvents24h`, `unifiThreats24h` (IPS blocks), `unifiFirewallBlocks24h`. A metric is omitted when the console doesn't report it.

The overview's guest list is every device, offline ones first.

## Alerts (metric thresholds, category "UniFi Network")

| Alert | Metric |
| --- | --- |
| `unifi.devices_offline` | `unifiDevicesOffline` |
| `unifi.wan_down` | `unifiWanDown` (set 1 to alert on any down link) |
| `unifi.wan_latency` | `unifiWanLatencyMs` |
| `unifi.gateway_cpu` / `gateway_mem` / `gateway_temp` | gateway CPU %, memory %, hottest sensor °C |
| `unifi.storage` | `unifiStoragePct` |
| `unifi.alarms` | `unifiAlarms` |
| `unifi.firmware_updates` | `unifiFirmwareUpdates` |
| `unifi.high_events` | `unifiHighEvents24h` |
| `unifi.threats` | `unifiThreats24h` |

The whole console going unreachable is covered by the baseline connection monitor.

## To verify live

Field names come from the community-documented classic API and are read defensively (all
optional), so a mismatch blanks a value rather than breaking a list. Check against the real
UDM SE: `speedtest-status` after a run, WAN2's ISP/latency (empty in `uptime_stats` on the live console), and the system-log severity values.

Possible follow-ups: live updates over the console's WebSocket event stream (`subscribeLive`),
throughput history from `stat/report/*`, DPI/traffic by app, and UniFi Protect / UNAS (separate
applications on the console).
