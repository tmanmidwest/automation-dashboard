# 🧠 Cerebro

A self-hosted management platform with a modern web UI and pluggable connectors.
Log in, configure everything from the UI, and manage your whole homelab or estate
from one place — Proxmox, Docker, Cloudflare, and more — plus **agent-brokered
remote access** to any box with no inbound firewall rules.

> Cerebro is well past its skeleton phase: authentication + RBAC, an encrypted
> secrets vault, a unified event timeline, monitors, automations, a public API +
> MCP server, twelve first-class connectors, app deployment and stack backup /
> migration tooling, and agent-brokered remote access are all in place.

## Architecture

| Layer | Tech |
|------|------|
| Frontend | React + Vite + Tailwind + shadcn-style components (LCARS theme) |
| Backend | NestJS (TypeScript) |
| Database | PostgreSQL (Prisma) |
| Sessions / jobs | Redis |
| Packaging | Docker (Node 22) — one app image + Postgres + Redis |

```
apps/
  server/    NestJS API (also serves the built UI in production)
  web/       React single-page app
packages/
  shared/    Types shared across server & web (connector contract, RBAC, DTOs)
agent/       Go "Cerebro Agent" — dials out for Fabric remote access / Waypoints
cli/         Go `cerebro` CLI — `cerebro access <machine> ssh|rdp|vnc` over Fabric
docker/      Sidecar images (Remote Browser) + the `cerebro-admin` break-glass tool
docs/        Feature deep-dives (see the index below)
```

## What's inside

**Dashboard**
- **Bridge dashboard** — cross-connector summary tiles (VMs, containers, CPU/memory,
  spend, …), a **Connectors** box with live online/offline status, and **Needs
  Attention**, which shows one "Connector offline" row per down connector and stops
  re-showing alerts from before a recovery. Telemetry is persisted, so the dashboard
  paints instantly after a restart.
- **Command palette** (⌘K / Ctrl+K) — search every resource across connectors and run
  its actions from the keyboard.
- **Viewscreen** — a Home Assistant camera wall.

**Platform**
- **Auth & users** — local accounts (bcrypt) and multiple OIDC/SSO providers, a
  first-run admin wizard, invite-by-email, and native **MFA (TOTP + recovery codes)**.
- **Password sign-in IP policy** — limit email + password sign-in to your LAN/VPN
  CIDRs (or turn it off for SSO-only), with a `cerebro-admin` break-glass command.
- **RBAC** — permissions stored as data; built-in **Administrator** and **Viewer**
  roles, extensible without a schema change.
- **Secrets vault** — AES-256-GCM encrypted store with rotation policies, expiry,
  last-used tracking, and connector **secret references** (share one credential
  across many connectors). Values are write-only.
- **Ship's Log (timeline)** — one filterable, live-tailing stream unifying audit
  events, logs, alerts, connector jobs, and monitor transitions.
- **Monitors** — an Uptime-Kuma-style engine (HTTP/ping/TCP/DNS probes) with
  heartbeats, rollups, threshold alerts, and an Uptime Kuma import.
- **Alerts & notifications** — per-connector threshold alerts (an alerts matrix in
  Settings) delivered by Email / SMS / Signal, with a notification history.
- **Automations** — *when* something happens, *if* a condition holds, *do* actions
  across connectors; triggered off the timeline or a cron schedule.
- **The Computer** — an in-app LLM assistant over a shared tool catalog (Ollama /
  OpenAI-compatible / native Claude backends), with configurable **agent profiles**,
  external **MCP servers** as tool sources, per-agent tool controls, and optional
  registration in the Saviynt Zuma agent registry.
- **API + MCP server** — a scoped-token REST API, OAuth "Connect" clients, and a Model
  Context Protocol server; scopes reuse the RBAC permission model.
- **System backup/restore** — passphrase-encrypted bundle (pg_dump + secrets),
  re-keyed to the target on restore.

**Connectors** (each has a doc under [`docs/connectors/`](docs/connectors/))
- **Proxmox VE** — VM/LXC lifecycle, create and deploy-from-template wizards, cloud-image
  template builder, snapshots, migrate, backup, CPU/RAM edits, and browser consoles.
- **Docker** — a Portainer-style view over the Engine API: stacks, containers, images,
  logs, an in-browser shell, Compose deploy/rollback, and image-update detection.
- **AWS** — EC2 (incl. launch), EKS, ECS, RDS, EBS, Elastic IPs, S3, CloudFront and more,
  plus spend by service.
- **UniFi Network** (UDM SE) — WAN/ISP health, throughput, latency and speed tests;
  gateway health; every AP and switch with per-port PoE; clients; networks, Wi-Fi, port
  forwards; events, high-severity alarms, IPS threats and firewall blocks.
- **Cloudflare** — Tunnels, DNS, certificates, Zero Trust, WAF, and more.
- **Home Assistant**, **Jellyfin**, **Nginx Proxy Manager**, **Technitium DNS**.
- **Microsoft 365** and **Azure** — read-only, sharing one Entra ID app registration.
- **Backblaze B2** — off-sites Proxmox `vzdump` backups to a B2 restic repo on a schedule, with retention, snapshot browsing, and restore.

**Apps & stacks**
- **Docker Fleet** — one live screen across every Docker host: stacks, containers,
  fleet-wide bulk actions, and update detection.
- **App Replicator** — register a git repo and deploy copies of it to a Docker host or
  AWS ECS/Fargate, with generated config forms, port allocation, Cloudflare/NPM ingress,
  and update checks. Repos without a compose file get one generated (Dockerfile,
  WordPress, Node, PHP, static).
- **Stack Backup** — scheduled restic backups of Compose stacks (volumes + config +
  vault secret bindings) with restore and sandbox test-restores.
- **Stack Migrator** — move a Compose stack between Docker hosts with warm pre-copy,
  automated ingress cutover, and rollback.

**Fabric — agent-brokered remote access**
- A tiny **Cerebro Agent** dials *out* over TLS; Cerebro brokers **SSH, RDP, VNC**,
  and a **Remote Browser** back down it, in the browser — **zero inbound firewall
  rules**. Model: Cloudflare Tunnel + Teleport-lite, self-hosted.
- **Waypoints** — a gateway mode: install one agent on a segment and reach *any*
  host on it (RDP/SSH/VNC/Remote-Browser), governed by a pushed allow-list. Routes are
  grouped by type, sorted, collapsible, and searchable.
- Session tabs name the **endpoint** you're on (with the Waypoint as a "via" chip),
  and the browser tab is titled after it.
- SSH certificate authority (short-lived user + host certs), host-key pinning,
  vault-injected credentials (including Remote Browser web autofill), an SFTP browser,
  RDP session recording, a native `cerebro` CLI, per-session four-eyes approval, and
  **signed agent auto-updates** (ed25519, fail-closed).

## Documentation

| Area | Docs |
| --- | --- |
| Connectors | [Proxmox](docs/connectors/proxmox.md) · [Docker](docs/connectors/docker.md) · [AWS](docs/connectors/aws.md) · [UniFi](docs/connectors/unifi.md) · [Cloudflare](docs/connectors/cloudflare.md) · [Home Assistant](docs/connectors/home-assistant.md) · [Jellyfin](docs/connectors/jellyfin.md) · [Nginx Proxy Manager](docs/connectors/nginx-proxy-manager.md) · [Technitium](docs/connectors/technitium.md) · [Azure + Microsoft 365](docs/azure-o365-connectors.md) · [Backblaze](docs/connectors/backblaze-backup.md) · [Pi-hole (planned, not built)](docs/connectors/pihole.md) |
| Dashboard & UI | [Telemetry snapshots + connector status](docs/dashboard-telemetry-snapshots.md) · [Command palette](docs/command-palette.md) · [LCARS theme](docs/lcars-ui.md) |
| Apps & stacks | [Docker Fleet](docs/docker-fleet.md) · [App Replicator](docs/app-replicator.md) · [ECS target](docs/app-replicator-ecs-target.md) · [ECS live test](docs/app-replicator-ecs-live-test.md) · [Stack Backup](docs/stack-backup.md) · [Stack Migrator](docs/stack-migrator.md) |
| Fabric | [Remote access](docs/fabric-remote-access.md) · [Waypoints](docs/fabric-waypoints.md) · [Remote desktop](docs/fabric-remote-desktop.md) · [Remote Browser autofill](docs/fabric-remote-browser-credential-injection.md) · [Agent signing](docs/fabric-agent-signing.md) |
| Platform | [Secrets vault](docs/secrets-vault.md) · [MFA](docs/mfa-totp.md) · [Password sign-in policy](docs/local-login-policy.md) · [Ship's Log](docs/event-timeline.md) · [Automations](docs/automations.md) · [The Computer](docs/assistant-computer.md) · [API + MCP server](docs/api-and-mcp-server.md) · [System backup](docs/system-backup.md) |

`CHANGELOG.md` has the release history.

## Quick start (Docker Desktop)

```bash
cp .env.example .env
# then edit .env — at minimum set APP_ENCRYPTION_KEY and SESSION_SECRET:
#   openssl rand -base64 32
docker compose up -d --build
```

Open <http://localhost:3000> and complete the first-run setup wizard to create your
administrator account. Cerebro runs database migrations automatically on start.

## Deploying with Portainer

1. In Portainer: **Stacks → Add stack**.
2. Paste the contents of `docker-compose.yml`.
3. Under **Environment variables**, set `APP_ENCRYPTION_KEY`, `SESSION_SECRET`,
   `APP_URL` (your public URL), and a strong `POSTGRES_PASSWORD`.
4. Deploy. Cerebro runs migrations automatically on start.

> **Keep `APP_ENCRYPTION_KEY` safe and stable.** It encrypts all stored secrets;
> changing it makes previously stored credentials unreadable. It's the key your
> system backup is re-keyed *from* — back it up alongside your data.

## Local development

Requires Node 22+, plus a local Postgres and Redis (or run just those two from the
compose file). Then:

```bash
npm install
npm run prisma:generate
npm run prisma:migrate      # creates the schema in your dev database
npm run dev                 # server on :3000, web on :5173 (proxied)
```

Copy `.env.example` to `apps/server/.env` for the server in dev, pointing
`DATABASE_URL`/`REDIS_URL` at your local services.

## Roles

| Role | Capability |
|------|-----------|
| **Administrator** | Full control — all settings, users, connectors, actions. |
| **Viewer** | Read-only across the app. |

Roles are stored as data (permission lists), so finer-grained roles can be added
later without a schema change. API tokens carry a subset of these permissions as
scopes.

## Security

Cerebro is built to sit on a network you care about. Notable controls: an encrypted
secrets vault, a Redis-backed login throttle (per-IP and per-account lockout),
native security-response headers (CSP, HSTS, `X-Frame-Options`), SSRF guards on
outbound probes, git-protocol safety on repo operations, and fail-closed **signed
agent updates**. The version shown in **Settings → About** tracks `CHANGELOG.md`.
