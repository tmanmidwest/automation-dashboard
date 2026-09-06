# Changelog

All notable changes to Cerebro are documented here. This file is the source of
truth for the version shown in the UI (Settings → About).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added — Shared vault credentials + connector references
- **Create secrets directly in the vault** (Settings → Secrets Vault → *New secret*) — a shared
  credential (e.g. an SSH password) with a key, label, and category.
- **Reference a vault secret from a connector.** Each secret field on a connector's setup form now
  offers *Enter value* or *Use vault secret* — pick a shared secret instead of pasting the value.
  One credential can back many connectors (e.g. the same SSH password across several Docker hosts):
  rotate it once in the vault and every connector using it picks up the change. The connector
  stores only a reference, not a copy.

### Added — Docker connector (monitor + manage)
- **Docker connector** (v0.2.0) — monitor and manage a Docker host, toward a Portainer
  replacement. Lists **stacks** (grouped by Compose project), **containers** (state + health),
  **images**, **volumes**, **networks**, and the **host**; drill from a stack into its
  containers.
- **Overview tiles**: containers running / stopped / **unhealthy**, image count, disk used
  (`/system/df`), host RAM / CPU (`/info`). A container's CPU/memory sample shows on its detail
  page (fetched on demand, never polled).
- **Manage**: start / stop / restart / pause / unpause / **kill** and remove containers; remove
  images, volumes, and networks; **pull an image** (streamed progress via a background job); and
  **prune** dangling images, stopped containers, unused volumes, and networks (each behind an
  explicit confirm). All actions are audited and appear in the timeline.
- **Live + logs + shell**: container rows update live from the Docker event stream (no polling
  lag); a **Logs** view tails a container's output; and a **Shell** opens an interactive
  `exec` terminal (bash/sh) right in the browser. Opening a shell or log stream is audited.
- **Health alerts**: a new **Docker** alert category on the threshold monitor — alert when
  unhealthy containers, stopped containers, or Docker disk usage cross a per-connector limit.
  (Host-unreachable is already covered by the baseline connection monitor.)
- **Compose stacks**: deploy and manage Compose stacks from Cerebro. Cerebro is the versioned
  store for each stack's compose file and runs the host's own `docker compose` over **SSH** —
  no agent, full Compose fidelity. **Deploy** (create/update), **Edit & redeploy**, **Redeploy**,
  and **Stop (compose down)** operations on the Stacks tab; managed stacks show even when stopped.
  SSH host/user/**password or key** (secret in the vault) are optional connector settings — leave
  them blank to keep a connector monitor/manage-only.
- **Stack lifecycle for *any* stack**: **Start / Stop / Restart** a whole stack — including ones
  created outside Cerebro — by acting on its containers via the Engine API (matched by the
  Compose project label; no compose file or SSH needed). Compose editing still applies only to
  stacks Cerebro stores; deploying an existing stack's compose here "adopts" it for full management.
- **Deploy history + rollback**: each successful stack deploy is snapshotted (compose + env, last
  10 kept), and a **Roll back to previous** action redeploys the version that ran before the last
  change. Managed stacks show a version count.
- **Interactive shell resize**: the in-browser `exec` terminal now resizes with the window
  (wired to `POST /exec/{id}/resize`), so `vim`/`htop`/wide output render correctly instead of
  being stuck at 80×24.
- **Richer container detail**: the container drawer now shows the command, created time, a scrubbed
  **Environment** section (secret-looking values masked), and **published ports as clickable links**
  to the host (when one can be derived from the SSH/endpoint host).
- **Restart-loop alert**: a new Docker alert fires when the number of containers stuck restarting
  (a crash loop) crosses a per-connector threshold.
- **Image-update detection**: Cerebro checks each running container's image against its registry
  (Docker Hub, GHCR, lscr.io, … via anonymous pull tokens) and flags when a newer version is
  available — shown per container, counted in the overview, and alertable per connector. Results
  are cached (6 h) and refreshed in the background, so registry rate limits are never a concern.
  Apply updates with the existing redeploy "Pull newer images" option.
- **Stack detail view**: opening a stack now shows its status, member containers (image · ports ·
  state), deploy history, and the stored **compose + `.env`** as read-only code blocks — alongside
  the existing deploy/edit/redeploy/rollback/start/stop actions. Detail views can now include
  copyable code blocks (a new connector capability).

- **Stack environment (`.env`) + deploy options**: a Compose stack now has an **Environment**
  editor (`KEY=value` lines) written to a `.env` beside the compose for `${VAR}` interpolation,
  stored and prefilled on edit. Redeploy exposes **Pull newer images**, **Force recreate**, and
  **Remove orphans** toggles, and deploys are **validated** (`docker compose config`) before
  applying, with the full `docker compose` output shown in the result.

### Fixed
- Editing a field in a connector operation form (notably the Docker stack compose / `.env` editor)
  is no longer interrupted by background refreshes — live updates and the active-job poll now pause
  while a form dialog is open, so text selection and typing aren't disrupted every few seconds.
- Operation forms with a multi-line field (e.g. a stack's compose / `.env` editor) now render a
  large, resizable, monospaced text box in a wider dialog (Tab inserts spaces for YAML), instead
  of a cramped 3-line box; command output is shown with line breaks preserved.
- Docker container port lists no longer show each mapping twice (Docker reports an IPv4 and IPv6
  binding per published port) — deduped to one entry each.
- **Transport**: mutual **TLS** to `tcp://host:2376` by default (client key in the secrets
  vault), a **socket-proxy** option (`http://…`) for per-endpoint scoping — with a copy-paste
  compose snippet on the setup screen — and a local `unix://` socket mode. Plaintext `2375` is
  refused without an explicit override. The API is called unversioned, so it works across Docker
  daemon versions (no fixed API-version pin).

## [0.2.0] — 2026-09-06
### Added — Secrets vault
- **Secrets Vault** at `/settings/secrets` — a managed view over Cerebro's encrypted secret
  store. Every stored credential (connector tokens, SMTP and SMS keys, SSO client secrets, the
  OAuth signing key) is listed with its category, age, last-used time, and health, and can be
  **rotated** or deleted in place. Values are write-only: the vault can set a new value but
  **never displays or returns an existing one**.
- **Metadata + policies**: label, description, an optional "rotate after N days" policy, and an
  optional hard expiry per secret. A `SecretMeta` sidecar table holds this — the ciphertext is
  untouched. Existing secrets are backfilled with inferred metadata on startup.
- **Rotation reminders**: a daily job raises a `secret.rotation_due` (or `secret.expired`) alert
  through the existing notification pipeline — a new **Secrets** alert category.
- **Auditing + last-used**: administrative set/rotate/delete are recorded to the audit trail
  (and so appear in the timeline); reads stamp a throttled last-used time so an unused connector
  credential stands out. New `secrets:read` / `secrets:write` permissions, granted to
  Administrators and **never** exposed as an API-token scope — the vault is session-only.

### Added — Event timeline ("Ship's Log")
- **Unified event timeline** at `/timeline` — a single chronological, filterable stream of
  everything that happens in Cerebro: audit events, warn/error system logs, alert deliveries,
  connector job outcomes, and monitor up/down transitions. It's a read-model that unions the
  existing tables (no new source-of-truth), gated by `logs:read`; the who-did-what audit
  stream additionally requires `audit:read`.
- **Filters + search**: toggle by kind and severity, full-text search, and infinite "load
  older" paging via a time cursor. Every row deep-links to its origin (connector / monitor).
- **Live tail**: new events stream in over Server-Sent Events (`/api/timeline/live`) and
  surface as a "new events" pill so the list you're reading never jumps.
- **Wider coverage**: background connector jobs now record their outcome
  (`connectors.operation_succeeded` / `_failed`) and job cancellations are audited, so both
  appear in the timeline.

### Added — Cloudflare connector
- **Cloudflare connector** (v0.6.0): monitor and manage a Cloudflare account from the UI,
  authenticated with a single **scoped API token** (encrypted at rest — never the legacy
  Global API Key). The account id is auto-detected for single-account tokens. The Cloudflare
  API is free (no per-call cost); the connector keeps the every-minute health poll cheap by
  caching per-zone and GraphQL data behind short TTLs.
- **12 resource kinds**: Cloudflare Tunnels, DNS zones, DNS records, SSL certificates,
  Zero Trust Access apps, service tokens, and WARP devices, WAF firewall rules, Workers,
  Pages projects, R2 buckets, and load balancers.
- **Management actions & forms**: add / edit / delete DNS records and toggle their proxy
  (orange cloud); purge cache (everything or specific URLs); set a zone's security level
  (including "I'm Under Attack!") and development mode; enable / disable WAF firewall rules;
  retry a Pages deployment; and delete tunnels. Editing features degrade gracefully — a token
  missing a scope fails that action with a clear message while read-only views keep working.
- **Health overview + alerts**: dashboard tiles for tunnels down, paused zones, expiring
  certificates and service tokens, and (plan-permitting) 24h requests / bandwidth / threats.
  A new **Cloudflare** alert category raises email alerts when tunnels-down, zones-paused,
  certs-expiring, tokens-expiring, or threats cross a per-connector threshold — wired into
  the generic threshold monitor, so they show only on Cloudflare connectors.
- Traffic tiles use Cloudflare's **GraphQL Analytics** API; everything else uses REST v4.
  No new frontend beyond the connector icon, a few status-badge colors, and the alert mirror —
  the generic manifest-driven UI renders all tabs, forms, and drawers.

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
