# 🧠 Cerebro

A self-hosted management platform with a modern web UI and pluggable connectors.
Log in, configure everything from the UI, and manage your whole homelab or estate
from one place — Proxmox, Docker, Cloudflare, and more — plus **agent-brokered
remote access** to any box with no inbound firewall rules.

> Cerebro is well past its skeleton phase: authentication + RBAC, an encrypted
> secrets vault, a unified event timeline, monitors, automations, a public API +
> MCP server, and a growing set of first-class connectors are all in place.

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
docker/      Sidecar images (e.g. the Remote Browser)
```

## What's inside

**Platform**
- **Auth & users** — local accounts (bcrypt) and multiple OIDC/SSO providers, a
  first-run admin wizard, invite-by-email, and native **MFA (TOTP + recovery codes)**.
- **RBAC** — permissions stored as data; built-in **Administrator** and **Viewer**
  roles, extensible without a schema change.
- **Secrets vault** — AES-256-GCM encrypted store with rotation policies, expiry,
  last-used tracking, and connector **secret references** (share one credential
  across many connectors). Values are write-only.
- **Ship's Log (timeline)** — one filterable, live-tailing stream unifying audit
  events, logs, alerts, connector jobs, and monitor transitions.
- **Monitors** — an Uptime-Kuma-style engine (HTTP/ping/TCP/DNS probes) with
  heartbeats, rollups, and threshold alerts.
- **Automations** — *when* something happens, *if* a condition holds, *do* actions
  across connectors; triggered off the timeline or a cron schedule.
- **Notifications** — outbound Email / SMS / Signal alerts.
- **The Computer** — an in-app LLM assistant over a shared tool catalog
  (pluggable Ollama / OpenAI-compatible / native Claude backend).
- **API + MCP server** — a scoped-token REST API and Model Context Protocol server;
  scopes reuse the RBAC permission model.
- **System backup/restore** — passphrase-encrypted bundle (pg_dump + secrets),
  re-keyed to the target on restore.

**Connectors**
- **Proxmox** — VMs/LXC lifecycle, create wizards, templates, snapshots, migrate,
  backup, and browser consoles.
- **Docker** — a Portainer-style view over the Engine API: stacks, containers,
  images, logs, an in-browser shell, Compose deploy/rollback, and image-update
  detection. A **Docker Fleet** screen aggregates every host.
- **Cloudflare** — Tunnels, DNS, certificates, Zero Trust, WAF, and more.
- **AWS**, **Backblaze** (restic backups), **Home Assistant** (+ a **Viewscreen**
  camera wall), **Jellyfin**, and **Nginx Proxy Manager**.

**Fabric — agent-brokered remote access**
- A tiny **Cerebro Agent** dials *out* over TLS; Cerebro brokers **SSH, RDP, VNC**,
  and a **Remote Browser** back down it, in the browser — **zero inbound firewall
  rules**. Model: Cloudflare Tunnel + Teleport-lite, self-hosted.
- **Waypoints** — a gateway mode: install one agent on a segment and reach *any*
  host on it (RDP/SSH/VNC/Remote-Browser), governed by a pushed allow-list.
- SSH certificate authority (short-lived user + host certs), host-key pinning,
  vault-injected credentials, an SFTP browser, a native `cerebro` CLI, per-session
  four-eyes approval, and **signed agent auto-updates** (ed25519, fail-closed).

See `docs/` for feature deep-dives (Fabric, Waypoints, agent signing, connectors,
automations, the vault, backup, and more), and `CHANGELOG.md` for release history.

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
