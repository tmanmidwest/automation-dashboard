# Changelog

All notable changes to Cerebro are documented here. This file is the source of
truth for the version shown in the UI (Settings → About).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added — Interactive console (Phase D)
- **noVNC (graphical) console** and **serial console** (xterm.js) for running VMs and
  containers — pick either from the guest's detail drawer. The serial console is handy
  for cloud images. Graphical console has a Ctrl+Alt+Del button.
- The backend relays a WebSocket to Proxmox's VNC endpoint — attaching the API-token
  auth and honoring the connector's TLS setting — so the browser never talks to Proxmox
  directly. Access is gated by `connectors:action`, brokered with one-time tokens, and
  the console open is audit-logged.
- New connector-contract capability: `openConsole` + a per-kind `console` flag.

### Added — Proxmox: migrate & backup (Phase D)
- **Migrate** a VM or container to another node (live/online for running VMs, restart
  migration for containers), with an option to move local disks.
- **Backup** (vzdump) a guest to a backup storage, choosing mode (snapshot/suspend/stop)
  and compression. Both run as tracked jobs.
- Operation forms can now resolve dynamic options from injected context (the guest's node),
  powering the migration-target and backup-storage dropdowns.

### Added — Editable VM ID
- Create VM, Create LXC, Deploy from template, and Build template now show a **VM ID**
  field, pre-filled with the next free ID from the cluster and overridable to any value.

### Added — Form pre-fill
- Operation forms can now pre-fill from live data: **Edit CPU / RAM** opens with the
  guest's current cores/memory, and **Deploy from template** fills CPU/RAM/disk size
  from the selected template (updating when you change the template).

### Added / Changed — Proxmox: SSD flags, sorting, grouping
- **SSD emulation + discard/TRIM** option (default on) when creating VMs, building
  templates, and deploying from a template — sets `discard=on,ssd=1` on the disk.
- **Sortable columns** in the VM/container/template lists (Name, ID, Node, Status).
- **Grouping** — group the list by Proxmox **tag**, **pool**, node, or status
  (e.g. tag VMs `prod` / `docker` in Proxmox and Cerebro groups them).
- **VLAN tag** option added to Create VM and Create LXC (previously only on Deploy).

### Added / Changed — Proxmox refinements
- **Templates** now have their own tab and are no longer listed as startable VMs.
- **Deploy from template** gained options: grow the disk (GB), override CPU cores and
  memory, choose the network bridge, and set a VLAN tag.
- **Edit CPU / RAM** — change an existing VM or container's cores and memory from its
  detail drawer (a reboot may be needed for a running guest).

### Added — Proxmox: build template from cloud image (Phase C2)
- **Build template from image** — give a cloud image URL (e.g. an Ubuntu cloud image) and
  Cerebro downloads it, imports it as a disk, adds a cloud-init drive, and converts it to a
  reusable template — entirely over the Proxmox API (no SSH). The new template then appears
  in "Deploy from template". Runs as a tracked job with step-by-step progress.
- Requires Proxmox 8.x (uses the config `import-from` disk-import API) and node internet access.

### Added — Proxmox create wizards (Phase C1)
- **Create VM** — a streamlined wizard: name, node, OS type, installation ISO, disk
  storage/size, cores, memory, network bridge, BIOS (SeaBIOS/UEFI), and start-on-create.
- **Create container (LXC)** — hostname, node, OS template, root-fs storage/size, cores,
  memory/swap, root password and/or SSH key, bridge, DHCP or static IP, unprivileged, start.
- New dynamic option sources (live from the cluster): ISOs, container templates, root-fs
  storages, and network bridges — all cascade off the chosen node.
- Both run as tracked async jobs, reusing the Phase B operations engine.

### Added — Proxmox snapshots (Phase B2)
- **Snapshots** in the VM/LXC detail drawer: list existing snapshots (with time and
  description), **take** a new one (optionally including RAM), **roll back**, or **delete**.
- Each snapshot operation runs as a tracked async job (Proxmox snapshot ops are async).
- New connector-contract concept: **sub-resources** — a resource kind can declare nested
  collections (like snapshots) with their own create operation and per-item actions.

### Added — Connector operations engine + Deploy-from-template (Phase B)
- New connector-contract capability: **parameterized operations** with form schemas,
  **cascading dynamic dropdowns** (a field's options are fetched live from the connector
  and refresh when the fields they depend on change), conditional fields, and
  **async background jobs** with live progress the UI polls.
- **Proxmox "Deploy from template"** — the AWS-style flow: pick a cloud-init template,
  name the VM, choose node + storage, set the cloud-init user / SSH key / IP (DHCP or
  static), and deploy. Runs as a tracked job (clone → cloud-init config → start) with
  step-by-step progress. Leaving the cloud-init fields blank makes it a plain clone.
- Dynamic option sources for Proxmox: cluster nodes, VM templates, and per-node disk storages.

### Added — Proxmox connector: management depth (Phase A)
- More power actions: **suspend, resume, reset** (in addition to start/shutdown/reboot/stop).
- Actions are now **status-aware** — the UI only offers what's valid for a guest's current state.
- **Resource detail drawer**: click a VM/container to see its config (CPU, memory, disks,
  network) and, via the guest agent, its **IP addresses**.
- **Delete** a VM/LXC from the detail drawer, guarded by a type-the-name confirmation
  (requires the `connectors:action` permission; recorded in the audit log).
- Connector contract grew status-aware actions, optional `describeResource`, and
  optional `deleteResource` — reusable by future connectors.

### Added — Proxmox connector (first connector)
- **Proxmox VE connector**: add one or more Proxmox servers/clusters from the UI,
  list virtual machines and LXC containers, and start / shutdown / reboot / stop them.
- Uses API-token auth (no account password stored); the token secret is encrypted at rest.
- Connectors can now ship **reference material** shown on their setup screen —
  overview, setup steps, required permissions, doc links, and cautions. The Proxmox
  connector documents exactly which token roles/privileges it needs (PVEAuditor,
  VM.PowerMgmt) and links to the relevant Proxmox docs.
- Full connector-instance management API + dynamic, manifest-driven config forms.
- Power actions require the `connectors:action` permission and are recorded in the audit log.

### Changed — Multiple SSO providers
- Authentication now supports **multiple** identity providers, each independently
  labeled, enabled/disabled, and reorderable (Google, Microsoft Entra, Authentik,
  and any generic OpenID Connect provider).
- New `IdentityProvider` and `UserIdentity` tables (a user can link several
  external identities); replaced the single `oidcSubject` column.
- Per-provider provisioning policy: auto-create toggle, default role, and an
  optional allowed-email-domains allowlist.
- Account-linking by email only occurs when the provider marks the email verified.
- Login screen renders one button per enabled provider; each provider has its own
  callback URL and a built-in discovery **Test** action.

## [0.1.0] — 2026-08-28
### Added — Phase 1: the core skeleton
- Monorepo scaffold (npm workspaces): `apps/server`, `apps/web`, `packages/shared`.
- Docker stack (`docker-compose.yml`) — app + Postgres + Redis, importable into Portainer.
- NestJS backend: Prisma/Postgres, Redis-backed sessions.
- Authentication: local accounts (bcrypt), pluggable OIDC single sign-on, first-run admin setup wizard.
- RBAC modeled as data with built-in **Viewer** (view only) and **Administrator** (full control) roles.
- Encrypted secrets vault (AES-256-GCM) for SMTP/OIDC/connector credentials.
- Outbound email (SMTP) configuration with a test-send, all from the UI.
- Application logs + immutable audit trail, both viewable in the UI and streamed to stdout.
- Connector (extension) contract and host seam — ready for Proxmox/AWS/Entra.
- Version endpoint + About screen (semver + git SHA).
- React + Vite + Tailwind + shadcn-style UI with the Cerebro theme.
