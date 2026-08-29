# Changelog

All notable changes to Cerebro are documented here. This file is the source of
truth for the version shown in the UI (Settings → About).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
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
