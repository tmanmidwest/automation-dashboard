# Azure + Microsoft 365 connectors

Two connectors that share **one authentication foundation**: a Microsoft Entra ID
(Azure AD) app registration and the OAuth2 **client-credentials** grant. Azure talks
to Azure Resource Manager (ARM); Microsoft 365 talks to Microsoft Graph.

Status: **P1 (read-only) BUILT** — not yet live-tested against a real tenant.

## Why a pair

They are deliberately built together because the hard part is identical for both:
getting a token from `login.microsoftonline.com`. That lives once in
`apps/server/src/connectors/entra/entra-auth.ts` (token exchange + process-wide
cache + sovereign-cloud endpoints). Each connector then only implements its own REST
calls on top.

```
app registration ──client-credentials──▶ login.microsoftonline.com ──token──▶  ARM   (Azure connector)
(tenant/client/secret, vault)                                          └─────▶ Graph (O365 connector)
```

Per the decision on 2026-10-11: **separate app registration per connector** (Azure
gets only ARM Reader; O365 gets only the Graph read scopes) for least privilege and a
cleaner audit trail. Auth is a **client secret** for now; certificate auth is a
planned follow-up.

## Auth foundation — `entra/entra-auth.ts`

- `getEntraToken(creds, audience)` — client-credentials token for an audience
  (`https://management.azure.com` or `https://graph.microsoft.com`), cached until
  ~5 min before expiry, keyed by cloud+tenant+client+scope. **Not** keyed on the
  secret, so a rotated secret is picked up on the next refresh (old token stays valid
  until it expires).
- `ENTRA_CLOUDS` — public / US Gov / China endpoints for authority + ARM + Graph.
- `armBase()` / `graphBase()` — the right base URL for the instance's cloud.
- Friendly `EntraError` mapping (bad creds, expired secret, unreachable endpoint).

Because the token endpoint is free and the token is cached, `testConnection` (which
the connection monitor runs **every minute** — see the cost gotcha in
[adding-a-connector]) stays cheap: at most one cached lookup plus one small read.

## Connector setup pages (the auth direction)

Everything an operator needs to wire up Microsoft auth lives in each connector's
`manifest.help` + per-field `help`, rendered on the Add/Configure screen — same
pattern as the Docker connector. Both pages spell out:

- **config fields**: Directory (tenant) ID, Application (client) ID, Client secret
  (vault-encrypted), cloud selector. Azure adds an optional Subscription ID.
- **setupSteps**: register the app → copy tenant/client IDs → create a client secret
  → grant access.
  - Azure: assign the built-in **Reader** RBAC role on the subscription(s) / mgmt group.
  - O365: add Graph **application** permissions, then **grant tenant admin consent**
    (the step people miss — without it every call 403s).
- **requiredPermissions**: least-privilege scopes, called out explicitly.
- **referenceLinks**: Microsoft Learn docs for each step.
- **notes**: secret-expiry/rotation reminder; writes intentionally excluded in P1.

## Azure connector (P1, read-only)

`apps/server/src/connectors/azure/` — `azure-api.ts` (ARM client) + `azure.connector.ts`.

Resource kinds: **subscriptions, resource groups, virtual machines** (with normalized
power state via `$expand=instanceView`), **App Services / Functions, storage accounts**.
Lists aggregate across every readable subscription unless one is pinned. Overview:
subscription count, VMs running/total, App Services, storage accounts.

Required access: Azure RBAC **Reader** (no Graph permissions).

## Microsoft 365 connector (P1, read-only)

`apps/server/src/connectors/o365/` — `graph-api.ts` (Graph client) + `o365.connector.ts`.

Resource kinds: **service health, service issues, Message Center, users, licenses**
(subscribed SKUs). Overview: services degraded, active issues, user count, Secure
Score %. Admin/security signals only — **never** mailbox or file content.

Required Graph **application** permissions (+ admin consent): `ServiceHealth.Read.All`,
`ServiceMessage.Read.All`, `User.Read.All`, `Organization.Read.All`,
`SecurityEvents.Read.All`.

## What's intentionally not here (follow-ups)

- **Writes**, all gated behind confirmation + RBAC when added:
  - Azure: start / stop / deallocate VM, restart App Service, scale.
  - O365: reset password, enable/disable account, revoke sessions, assign/remove
    license, create user — high blast radius, a candidate for Fabric-style four-eyes.
- **More Azure services**: AKS, Azure SQL, Resource/Service Health, Cost Management.
- **More O365 signals**: risky/failed sign-ins (`auditLogs/signIns`), mailbox/OneDrive/
  SharePoint usage reports, MFA-registration coverage.
- **Certificate auth** instead of a client secret.
- **Tool-catalog registration** so The Computer can answer "is any M365 service down?"
  / "which VMs are running?" (add to `apps/server/src/tools/tool-catalog.service.ts`).
- Throttling: ARM/Graph both throttle; current polling is modest and tokens cache. If
  overviews get heavier (adding services), put expensive fan-outs behind a TTL cache
  like the AWS cost cache.

## Verify

```bash
npm run build --workspace @cerebro/server
cd apps/web && npx tsc --noEmit -p tsconfig.json && npm run build --workspace @cerebro/web
```

The generic connectors UI needs no changes beyond the `azure` / `o365` icon keys in
`apps/web/src/components/ConnectorIcon.tsx`. Create an instance, paste a real app
registration's tenant/client/secret, and Test. Backend errors surface as friendly
`ok:false` messages (bad creds, missing Reader role, missing admin consent).
