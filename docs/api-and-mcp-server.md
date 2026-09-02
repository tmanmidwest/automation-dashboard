# Programmatic API + MCP Server — Design Note

Status: **Phase 1 deployed & verified. Phase 2 (MCP) built, awaiting deploy.** Last updated 2026-09-02.

> **Phase 1 is live and smoke-tested.** Backend: `ApiToken` model + migration
> `0005_api_tokens`, `auth/token-auth.service.ts`, combined `auth.guard.ts` (session or
> bearer), `@SessionOnly()` decorator, `tokens/` module (`GET/POST/DELETE /api/tokens`).
> Frontend: `settings/ApiTokens.tsx` + route + Settings card. Verified on the dev box:
> valid token → 200 on a real route, bogus/no-auth → 401, token hitting `/api/tokens` → 403
> (`@SessionOnly`). NestJS gotcha confirmed along the way: **guards run only on a matched
> route**, so an unknown path 404s *before* auth — always test against a real endpoint
> (e.g. `/api/connectors/instances`, `/api/monitors`), not the bare `/api/connectors`.

## Goal

Let external clients query Cerebro (and, later, drive it) — including from an MCP
client such as Claude. Two consumers, two credential types, one authorization model:

- **API tokens** — static bearer credentials for scripts, services, and simple MCP setups.
- **OAuth 2.1** — the "Connect" flow modern MCP clients use, so no token is pasted by hand.

Read-only first; full action capability later. Single operator today, but multiple
named tokens / multiple client sources from day one.

## The key leverage: scopes *are* permissions

Cerebro already models authorization as data — a `Permission` string union in
[`packages/shared/src/rbac.ts`](../packages/shared/src/rbac.ts), checked by
`PermissionsGuard` against `req.user.permissions`. We reuse it verbatim:

- A **token/OAuth scope is a `Permission` string** (`connectors:read`, `monitors:read`, …).
- A credential's effective permissions are **`granted ∩ owner's-role permissions`**,
  recomputed at each request — so narrowing a user's role also narrows their tokens.
- The bearer auth layer builds a normal `SessionUser`-shaped `req.user` carrying those
  permissions. **Every existing `@RequirePermissions(...)` controller therefore becomes
  token-accessible with scope enforcement, with no per-endpoint change.**

Consequence: "build the API" is mostly an **auth** problem, not a new-controllers problem.
The read surface (`/api/connectors`, `/api/monitors`, …) already exists; we harden and
document it.

Read-only-now / actions-later is free: a token simply cannot be granted `connectors:action`
until Phase 4. The same guard gates it when we flip it on.

## Architecture

One Nest process, one port. The MCP server runs in-app under `/mcp`; because it needs only
the API surface + a JWT signing key, extracting it to its own container/port later is
configuration, not a rewrite.

```
                       ┌─────────────── Nest app (one process, one port) ───────────────┐
 MCP client (Claude) ──┤  /mcp             → MCP module (Streamable HTTP), tools→services │
 Script / service   ───┤  /api/*           → existing controllers, now bearer-accessible  │
                       │  /oauth/*          → OAuth 2.1 AS (authorize / token / register)  │
                       │  /.well-known/*    → protected-resource + AS metadata             │
                       │                                                                   │
                       │  AuthGuard: session OR bearer → builds req.user (Permission[])    │
                       │             → existing PermissionsGuard unchanged                 │
                       └───────────────────────────────────────────────────────────────┘
```

Both credential types resolve to the same principal model: *(principal, effective
`Permission[]`)*. The global authenticate step accepts a session **or** a bearer credential;
permission enforcement downstream is untouched.

## Decisions locked

1. **Access-token format: signed JWT** (stateless, resource server validates locally),
   over opaque + introspection.
2. **API-token hashing: SHA-256 + short lookup prefix.** Tokens are already high-entropy,
   so a fast hash is correct here; bcrypt's slowness / 72-byte cap is the wrong tool for
   per-request validation. (Reuse `createHash`/`randomBytes` from
   [`common/crypto.service.ts`](../apps/server/src/common/crypto.service.ts).)
3. **MCP location: same process/port (`/mcp`) now,** kept extractable to its own container later.

## Phases (each independently shippable)

- **Phase 1 — Bearer auth + API tokens.** `ApiToken` model; combined `AuthGuard`
  (session-or-bearer); token CRUD (multiple, named per source, scopes ⊆ owner, revoke,
  `lastUsedAt`); reveal-once UI. Outcome: `curl -H "Authorization: Bearer …" /api/connectors`.
  This *is* the "API first" foundation; everything else stacks on it.
- **Phase 2 — MCP server (read-only). BUILT (2026-09-02), not yet deployed.** In-app MCP
  module at `/mcp` (Streamable HTTP, stateless), authed by Phase 1 bearer tokens via the
  global guard. Tools call services directly and are registered per-connection only when the
  caller holds the required scope. Tool set: `list_connectors`, `get_overview`,
  `get_connector_overview`, `list_resources` (`connectors:read`); `list_monitors`,
  `get_monitor`, `get_monitor_stats` (`monitors:read`). Files: `mcp/mcp.module.ts`,
  `mcp/mcp.controller.ts` (`@All()`, `@Res()`, stateless transport per request),
  `mcp/mcp-server.factory.ts`. New deps: `@modelcontextprotocol/sdk`, `zod` (server
  `dependencies`). No DB change. Verified via an in-memory client↔server round trip:
  scope-gating (7 tools full vs 3 monitors-only), tool output shapes, and error handling.
  > **Build gotcha (worth remembering):** the server compiles with classic `Node10`
  > resolution, which rejects bare deep imports into a package that declares `exports`
  > (the SDK). Fix: import the exports-valid runtime specifier
  > (`@modelcontextprotocol/sdk/server/mcp.js`) and add a `paths` mapping in
  > `apps/server/tsconfig.json` redirecting *type* resolution to the physical CJS `.d.ts`.
  > tsc leaves the runtime specifier untouched in emit. Also cast the SDK's deeply-generic
  > `registerTool` call to dodge TS2589. And note the `deleteOutDir` + `incremental` quirk:
  > a warm `.tsbuildinfo` can skip re-emitting unchanged files — a clean container build is
  > unaffected.
- **Phase 3 — OAuth 2.1.** Protected-resource + AS metadata discovery, Dynamic Client
  Registration, authorize (reuses existing login for consent), token/refresh. Modern MCP
  clients add Cerebro via the OAuth "Connect" flow.
- **Phase 4 — Actions.** Add `*:action` scopes to tokens/consent and expose write/action
  tools. Guard work already done; this is tool definitions + a confirmation/safety posture.

## Grounding notes (current code)

- Global guards: `SessionAuthGuard` then `PermissionsGuard`, wired via `APP_GUARD` in
  [`app.module.ts`](../apps/server/src/app.module.ts).
- `SessionUser` shape produced by `AuthService.buildSessionUser` and consumed everywhere:
  `{ id, email, displayName, roleSlug, roleName, permissions, authProvider }`.
- Sessions are cookie/`express-session` (`req.session.userId`), Redis-backed — no `Session`
  table. Bearer auth is orthogonal and adds no session.
- Ids are cuid; secrets vault (`Secret`) is AES-256-GCM via `CryptoService`.
