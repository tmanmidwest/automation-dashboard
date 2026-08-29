# Changelog

All notable changes to Cerebro are documented here. This file is the source of
truth for the version shown in the UI (Settings → About).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
