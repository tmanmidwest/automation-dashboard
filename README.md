# 🧠 Cerebro

A self-hosted management platform with a modern web UI and pluggable connectors.
Log in, configure everything from the UI, and (in later phases) connect to systems
like **Proxmox**, **AWS**, and **Entra** to view and manage VMs and containers.

> Phase 1 — the core skeleton — is in place: auth, RBAC, settings, secrets vault,
> email, logging/audit, versioning, and the connector host seam.

## Architecture

| Layer | Tech |
|------|------|
| Frontend | React + Vite + Tailwind + shadcn-style components |
| Backend | NestJS (TypeScript) |
| Database | PostgreSQL (Prisma) |
| Sessions / jobs | Redis |
| Packaging | Docker — one app image + Postgres + Redis |

```
apps/
  server/    NestJS API (also serves the built UI in production)
  web/       React single-page app
packages/
  shared/    Types shared across server & web (connector contract, RBAC, DTOs)
```

## Quick start (Docker Desktop)

```bash
cp .env.example .env
# then edit .env — at minimum set APP_ENCRYPTION_KEY and SESSION_SECRET:
#   openssl rand -base64 32
docker compose up -d --build
```

Open <http://localhost:3000> and complete the first-run setup wizard to create your
administrator account.

## Deploying with Portainer

1. In Portainer: **Stacks → Add stack**.
2. Paste the contents of `docker-compose.yml`.
3. Under **Environment variables**, set `APP_ENCRYPTION_KEY`, `SESSION_SECRET`,
   `APP_URL` (your public URL), and a strong `POSTGRES_PASSWORD`.
4. Deploy. Cerebro runs migrations automatically on start.

> **Keep `APP_ENCRYPTION_KEY` safe and stable.** It encrypts all stored secrets;
> changing it makes previously stored credentials unreadable.

## Local development

Requires Node 20+, plus a local Postgres and Redis (or run just those two from the
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
later without a schema change.

## Roadmap

- **Phase 1 — Core skeleton** ✅ (this release)
- **Phase 2 — Platform services** — polish OIDC, email templates, richer log filtering.
- **Phase 3 — Extension host** — example connector proving the plumbing.
- **Phase 4 — Connectors** — Proxmox first, then AWS and Entra.
- **Later** — public API and MCP server.
