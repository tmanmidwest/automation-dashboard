# Health monitoring

The **Health** page (`/health`) shows how every machine running the Cerebro agent is doing: CPU,
memory, each filesystem, disk I/O, network, uptime and how long it has been online. It works on
Linux, macOS and Windows, on physical machines and VMs, and it doesn't need any port opened on the
machine.

Health comes from the same agent Fabric uses (`agent/`). Any machine already in Fabric starts
reporting once its agent updates itself to 0.6.0, which it does on its next connect. To add a
machine, use **Fabric → Add machine**.

## What's collected

| Metric | Detail | Notes |
| --- | --- | --- |
| CPU | Average and peak % over each report window, load 1/5/15 (Linux/macOS) | Peak comes from ~10 s sub-samples, so short spikes show up |
| Memory | Used % (total − available, so cache counts as free), swap used % | |
| Filesystems | Used %, free, size, filesystem type, device, inodes % (Linux) | Virtual filesystems (tmpfs, overlay, snap, Docker layers, macOS system volumes) are skipped. Bind mounts of one device are listed once |
| Disk I/O | Read and write bytes/s across physical disks | Partitions and stacked devices aren't double-counted |
| Network | Download and upload across real interfaces | Loopback, Docker, veth and VPN tunnels are skipped |
| Uptime, processes | Seconds since boot and process count | |
| Inventory | OS and version, kernel, CPU model and cores, RAM, VM or physical, battery, MACs and IPs | Sent on connect and every 6 h |

Anything a machine doesn't expose is left out rather than shown as zero.

## How it reports

- The agent pushes a `health` frame over its existing outbound WebSocket. Cerebro never connects to
  the machine.
- The default is one report every **30 s**. You can change it under **Health → Settings**, from 5 s to
  10 min, or 0 to switch reporting off. A change reaches every connected agent right away.
- When the connection drops, the agent keeps up to 120 reports (about 1 h at 30 s) and sends them
  once it reconnects, so an outage of Cerebro itself doesn't leave a gap.
- **Refresh now** on a machine's page asks its agent for a fresh report immediately.
- History is kept raw for 48 h, as 5-minute averages for 14 days and hourly for about 13 months.
  Rollups are rebuilt every 5 minutes (`HealthRetentionService`). The newest buckets are computed from
  raw samples on the fly, so charts are never behind.

## Health score and status

Each machine gets a status and a 0–100 score: 100, minus 40 per critical issue and 15 per warning.

| Issue | Default | Severity |
| --- | --- | --- |
| Filesystem full | ≥ 85% warning, ≥ 95% critical | Warning / Critical |
| Inodes | ≥ 90% warning, ≥ 98% critical (Linux) | Warning / Critical |
| Memory | Above 90% (warning) or 97% (critical) for 15 min straight | Warning / Critical |
| CPU | Above 95% for 15 min straight | Warning |
| Server offline | Not connected for 3 min | Critical |
| Stale | Connected, but no report for 4 intervals | Warning |

The memory and CPU limits only count when every report in the window is over the limit and the
reports cover most of the window. One spike, or one sample right after a reconnect, never counts.

## Servers and workstations

Every machine is treated as one of two kinds:

- **Server:** going offline is a problem. It marks the machine critical and Fabric's "agent
  offline" alert fires.
- **Workstation** (laptops, desktops): going offline is normal. The machine shows as *Offline* with
  no score and raises no alert. It is counted as offline time instead (24 h / 7 d / 30 d).

The kind is detected automatically: a battery, macOS, or desktop Windows means workstation; a VM or
Windows Server means server; anything else is a server. Change it per machine on its Health page.
The change is stored in `Agent.healthRole`, and "Auto" clears it.

## Alerts

`HealthAlertsService` checks every minute, using the same assessment the page shows:

- **Disk filling up** (`health.disk`), **Memory pressure** (`health.memory`) and **CPU pinned**
  (`health.cpu`) fire once when an issue opens, and again if it goes from warning to critical.
- **Health issue cleared** (`health.recovered`) is off by default.
- Offline isn't alerted here. Fabric's existing `fabric.agent_offline` covers it, and both it and
  `fabric.agent_online` skip workstations.
- While a machine is offline or has no data, its open issues are left alone. A laptop closing its
  lid never reads as "recovered".
- Open issues are saved in Settings (`health.alertState`), so a redeploy doesn't re-send them.

Routing, severity and channels are set in **Settings → Notifications** like any other alert.

## API

All endpoints are under `/api/machine-health`. `/api/health` is the container liveness probe and is
not part of this API.

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/machine-health` | `fabric:read` (fleet + totals + settings) |
| GET | `/api/machine-health/:agentId` | `fabric:read` |
| GET | `/api/machine-health/:agentId/series?range=1h\|24h\|7d\|30d` | `fabric:read` |
| PATCH | `/api/machine-health/:agentId` `{ "role": "server" \| "workstation" \| null }` | `fabric:manage` |
| POST | `/api/machine-health/:agentId/refresh` | `fabric:read` |
| GET / PUT | `/api/machine-health/settings` | read `fabric:read`, write `fabric:manage` |

## Protocol

| Direction | Frame | Purpose |
| --- | --- | --- |
| broker → agent | `hello-ack.healthIntervalMs` | Cadence on connect (0 = off) |
| broker → agent | `{ t: "health-config", healthIntervalMs }` | Live cadence change |
| broker → agent | `{ t: "health-now" }` | Report immediately |
| agent → broker | `{ t: "health", samples: HealthSample[], inventory?: HealthInventory }` | Queued samples (a backlog after a reconnect) and inventory when due |

Types are in `packages/shared/src/health.ts`. The server clamps and validates every field
(`health-assess.ts`). It drops samples older than 24 h or more than 1 min in the future, and limits
how much time one sample can claim.

## Code map

- Agent: `agent/health.go` (collector built on gopsutil), `agent/health_{linux,darwin,windows}.go`
  (battery detection).
- Server: `apps/server/src/health/`, including `health-assess.ts` (pure scoring and role logic),
  `health.service.ts` (ingest and read side), `health-retention.service.ts` and
  `health-alerts.service.ts`. Fabric hands health frames over through hooks set on
  `AgentRegistryService`, so Fabric doesn't depend on Health.
- Tables: `AgentHealth` (latest snapshot + inventory), `AgentHealthSample` (raw) and
  `AgentHealthRollup` (5m/1h). Migration `0055_agent_health`.
- Web: `apps/web/src/pages/Health.tsx`, `HealthDetail.tsx`, `components/health/`.
