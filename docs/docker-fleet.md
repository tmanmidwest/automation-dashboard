# Docker Fleet — one control plane for every Docker host

A top-level `/docker-fleet` screen that aggregates **all** enabled Docker connector
instances into a single view, so you manage every host, stack, and container from one place
instead of visiting each connector separately.

## Layout

- **Fleet summary strip** — aggregate tiles across all hosts: Hosts (online/total), Running,
  Unhealthy (red), Stopped, Stacks, Updates (amber), Disk. The Running/Unhealthy/Stopped/Updates
  tiles are **click-to-filter** (focus the whole view on that set).
- **Control bar** — search (name / image / stack across all hosts), a **Stacks ⇄ Containers**
  view toggle, and a clear-filter chip.
- **Fleet bulk actions** — `Restart unhealthy (N)` and `Update outdated (N)` (recreate each
  outdated container pulling its latest image) run across the whole fleet; multi-select adds
  Start / Stop / Restart on the selected containers.
- **Stacks view (default)** — a **host accordion**: each host is a collapsible card with its
  online dot, container counts, and CPU/MEM/DISK telemetry in the header; under it, its stacks
  (status, `N/M`, amber updates chip, and Redeploy / Rollback / Drift / Stop for managed stacks).
  Expand a stack → its member containers with per-container Start/Stop · Restart · Recreate ·
  Shell · Logs and the amber "update" marker.
- **Containers view** — one flat, filterable table of every container across all hosts
  (Host · Stack · Image · Status · actions) with the same row actions + checkboxes.

## Architecture

- **Read**: one aggregate endpoint `GET /api/docker/fleet` (`DockerFleetModule`) fans out over
  every enabled `connectorId === 'docker'` instance and reuses each connector's existing
  `overview` + `stack`/`container` resource lists — so image-update chips, host telemetry, and
  stack grouping all carry over with no connector changes. Shape: `DockerFleet` in
  `packages/shared/src/docker-fleet.ts` (hosts → stacks → members, plus fleet totals).
- **Control** reuses the normal per-instance endpoints, keyed by each item's `instanceId`:
  - container actions → `POST /api/connectors/instances/:id/resources/container/:cid/actions/:action`
  - recreate / stack ops → `POST /api/connectors/instances/:id/operations/:op`
  - shell / logs → navigates to the existing `/connectors/:id/console/container/:cid?mode=…` route.
- **Refresh**: 30s poll + manual Refresh. Per-host live SSE is a natural fast-follow (each Docker
  connector already exposes `subscribeLive`).
- **Permissions**: view = `connectors:read`; every control = `connectors:action` (unchanged).

## Not yet built / future

- Per-host live SSE (currently polled).
- Fleet-wide stack bulk ops (e.g. redeploy-all-with-pull) and a select-all.
- Group-by (status / stack) in the containers view; host-level deploy-stack / prune shortcuts.
- Engine version + host uptime in the host header.
