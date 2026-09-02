# Programmatic API + MCP Server — Design Note

Status: **All phases built. Phase 1 deployed & verified; Phases 2, 3 (a/b/c), 4 (a/b) built and in-memory-verified, awaiting deploy.** The full arc — read-only MCP, OAuth "Connect", and guarded write actions — is code-complete. Last updated 2026-09-02.

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
- **Phase 3 — OAuth 2.1 (SCOPED 2026-09-02).** Cerebro becomes its own OAuth 2.1
  **Authorization Server** *and* **Resource Server**, so a browser-based MCP client connects
  via login + consent instead of a pasted token. See the dedicated section below.
- **Phase 4 — Actions (SCOPED 2026-09-02).** Expose the connectors' existing mutating
  capabilities over MCP, behind a layered safety posture. See the dedicated section below.

## Phase 3 — OAuth 2.1 (detailed scope)

Status: **Scoped, not built.** Cerebro plays both OAuth roles in one process: the
**Authorization Server** (issues tokens) and the **Resource Server** (`/mcp` + `/api`
validate them). API tokens (`cbro_`) and OAuth JWTs both resolve through the *same* bearer
guard to the same *(principal, scoped `Permission[]`)* — Phase 3 only adds a second branch
to the guard, everything downstream is untouched.

### Decisions (locked with the user)

- **Client registration: admin-gated — no open DCR.** Clients are pre-created in
  **Settings → OAuth Clients**; there is no `/oauth/register` and the AS metadata omits
  `registration_endpoint`. Consequence: each client is registered once by hand, and any MCP
  client that *only* supports DCR (can't accept a pre-issued `client_id`) won't connect.
  (Deferred alternative if this chafes: auto-register but land new clients **disabled** until
  an admin approves them — admin control without pre-registration friction.)
- **Loopback redirect URIs are port-flexible** (RFC 8252 §7.3): register `http://localhost/…`
  once, the AS matches any port — so desktop/CLI clients with a random callback port still
  work under admin-gating.
- **Consent is remembered per client.** First authorization for a (user, client, scopes)
  shows the consent screen; later ones with scopes ⊆ a stored grant skip it. Grants are
  listed and revocable in Settings.
- **Access token = HS256 JWT**, signing secret in the encrypted `Secret` vault. Clients treat
  the access token as opaque (only our RS validates it), so format is our call; HS256 in one
  process is the simple correct choice. RS256 + JWKS is a later swap if `/mcp` is split out.
- **Defaults:** access-token TTL 60 min; refresh TTL 30 days, **rotated on use**; PKCE **S256
  required** for public clients; JWT via **`jsonwebtoken`** (CJS — avoids the ESM-resolution
  pain from Phase 2). Scopes stay **read-only** until Phase 4.

### The flow

1. Client hits `/mcp` unauthenticated → **401 `WWW-Authenticate: Bearer resource_metadata=…`**.
2. Client reads `/.well-known/oauth-protected-resource` → AS → `/.well-known/oauth-authorization-server`.
3. Client opens `/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&scope=…&code_challenge=…&code_challenge_method=S256&state=…&resource=…`.
4. Cerebro: **no session → bounce to the existing login** (return-to back to authorize);
   **session → skip consent if a remembered grant covers the scopes, else show consent**.
   Requested scopes are clamped to what the user holds (read-only for now).
5. Approve → mint a short-lived, PKCE-bound **authorization code** → redirect to the client.
6. Client exchanges code + PKCE verifier at `POST /oauth/token` → **JWT access token** +
   rotating refresh token.
7. Client calls `/mcp` with the JWT; the bearer guard validates it and builds the scoped
   `req.user` exactly as for an API token.

### Endpoints

- `GET /.well-known/oauth-protected-resource`, `GET /.well-known/oauth-authorization-server`
  (no `registration_endpoint`).
- `GET /oauth/authorize`, `POST /oauth/authorize/decision` (consent approve/deny).
- `POST /oauth/token` (auth-code + refresh grants), `POST /oauth/revoke`.
- Admin CRUD `GET/POST/PATCH/DELETE /api/oauth/clients` + grant list/revoke (`settings:write`).
- 401 `WWW-Authenticate` header on `/mcp`.

### Data model (new)

- `OAuthClient` — clientId, name, redirectUris[], type `public|confidential`,
  clientSecretHash?, maxScopes?, disabled, timestamps. Admin-managed.
- `OAuthAuthorizationCode` — codeHash, clientId, userId, scopes[], redirectUri, codeChallenge,
  codeChallengeMethod, resource, expiresAt (~60s), consumedAt.
- `OAuthGrant` — (userId, clientId, scopes[]) consent memory; revocable.
- `OAuthRefreshToken` — tokenHash, clientId, userId, scopes[], expiresAt, revokedAt,
  rotatedFrom?. Access tokens are stateless JWTs, never stored.

### Frontend

- **Settings → OAuth Clients**: create/list/disable/delete clients (reveal confidential secret
  once), and view/revoke remembered grants.
- **`/oauth/consent`** React route reusing the login/return-to pattern; posts approve/deny.

### Ship in three slices

- **3a — BUILT (2026-09-02), not yet deployed.** `OAuthClient` model + migration
  `0006_oauth_clients`; `auth/oauth-token.service.ts` (HS256 JWT sign/verify, signing secret
  auto-generated in the `oauth:jwtSecret` vault key); `TokenAuthService.resolve` gained an
  OAuth-JWT branch (JWT-shaped bearer → verify → `buildSessionUser(sub)` → scopes ∩ role),
  converging with the `cbro_` path; `oauth/` module = `OAuthClientService` +
  `OAuthAdminController` (`/api/settings/oauth/clients`, `settings:read`/`write`, audited) +
  `OAuthMetadataController` (`@Public()` `/.well-known/oauth-authorization-server` &
  `/oauth-protected-resource`, **no** `registration_endpoint`). ServeStatic now also excludes
  `/oauth/(.*)` and `/.well-known/(.*)`. New dep `jsonwebtoken`. Frontend: Settings → OAuth
  Clients (register/list/enable-disable/delete, reveal client secret once). Verified via an
  in-memory suite (11/11): JWT branch intersection, tamper/foreign-sig/expired/unknown-user
  rejection, `cbro_` path intact; plus metadata shape. Server + web build clean.
- **3b — BUILT (2026-09-02), not yet deployed.** Full interactive flow. Migration
  `0007_oauth_flow` (`OAuthAuthorizationCode`, `OAuthGrant`, `OAuthRefreshToken`, all
  user-cascade). `oauth/oauth-flow.service.ts` — request validation, loopback-port-flexible
  redirect matching, PKCE **S256**, single-use codes (60s), remembered-grant check/upsert
  (merge-not-narrow), token issuance, and **refresh rotation with reuse-detection**.
  Controllers: `oauth-authorize.controller.ts` (`@Public` `GET /oauth/authorize` — validate →
  login-bounce (`/login?returnTo=`) → remembered-grant auto-approve → else `/consent`),
  `oauth-consent.controller.ts` (`@SessionOnly` `/api/oauth/consent-info` + `authorize/decision`),
  `oauth-token.controller.ts` (`@Public` `POST /oauth/token` — auth-code + refresh grants,
  client auth via `client_secret_post`/`client_secret_basic`). Frontend: `returnTo` in
  `Login.tsx` (same-origin only) + standalone `Consent.tsx` at `/consent`. **Pulled forward
  from 3c:** the 401 `WWW-Authenticate: Bearer resource_metadata=…` header (in `auth.guard.ts`)
  so MCP clients auto-discover the flow. Verified via an in-memory suite (20/20): PKCE
  happy/negative, single-use replay, redirect mismatch, confidential secret auth, refresh
  rotation + reuse rejection, remembered grants, scope intersection, validate-authorize error
  classification. Server + web build clean.
- **3c — BUILT (2026-09-02), not yet deployed.** `POST /oauth/revoke` (RFC 7009, client-authed,
  refresh-token revocation, always-200 semantics) in `oauth-token.controller.ts`; self-service
  `GET/DELETE /api/oauth/grants` (`oauth-grants.controller.ts`, `@SessionOnly`) where revoking a
  grant also kills that client's live refresh tokens; `OAuthFlowService.revokeToken` /
  `listUserGrants` / `revokeUserGrant`. Frontend: "Authorized applications" card on the OAuth
  Clients page (per-user, revoke). Verified in-memory (10/10): revoke prevents refresh reuse,
  wrong-client-secret rejected, cross-client revoke isolation, grant listing (name + active token
  count + scopes), grant revocation cascade, and per-user isolation. Server + web build clean.
  *(Access-token `aud`/resource enforcement intentionally deferred — single resource today.)*

## Phase 4 — Actions (detailed scope)

Status: **Scoped, not built.** Turns the read-only MCP server into one that can *change*
infrastructure, reusing the connectors' already self-describing action model and the
`connectors:action` / `monitors:write` permissions that already exist in RBAC.

### The action model we build on (already exists)

- **Resource actions** (`ConnectorAction`): start/stop/reboot etc. Each declares `mutating`,
  `intent: 'default' | 'destructive'`, `confirm` copy, and `showWhenStatus`. Invoked at
  `POST .../resources/:kind/:resourceId/actions/:actionId` (`connectors:action`).
- **Operations** (`ConnectorOperation`): parameterized create/deploy/backup with `fields[]`;
  async → return a `jobId`. Invoked at `POST .../operations/:operationId` (`connectors:action`).
- **Monitor writes**: pause/resume/check-now (`monitors:write`).

Because actions are connector-defined and dynamic, we expose **generic tools** driven by that
metadata rather than hand-authoring one tool per action.

### Decisions (locked with the user)

- **Safety posture:** MCP **annotations** (`readOnlyHint:false`, `destructiveHint`) on every
  action tool *and* a **required `confirm: true` argument on every mutating tool** (a cheap,
  client-agnostic second decision). Destructive actions always require it and carry
  `destructiveHint:true`.
- **Coverage:** expose **all** actions including destructive (stop/reboot/delete/terminate);
  destructive ones are annotated destructive and always require `confirm`.
- **Grantable write scopes:** `connectors:action` and `monitors:write` only. `connectors:write`
  (connector install/config) and `settings:*` / `users:*` stay **out** of MCP tokens/consent.
- **Audit:** MCP tools call services directly, which bypasses the controllers' audit — so the
  MCP action tools must record audit themselves, tagged `via: 'mcp'` with the token/OAuth
  client id and the acting user.

### 4a — Unlock action scopes in credentials — BUILT (2026-09-02), not yet deployed

- `GRANTABLE_TOKEN_SCOPES` + `isWriteScope()` centralized in `packages/shared/src/rbac.ts`
  (read scopes + `connectors:action`, `monitors:write`; deliberately excludes
  `connectors:write` and `settings:*`/`users:*` writes). Tokens, OAuth `effectiveScopes`,
  metadata `scopes_supported`, and the UI all reference it.
- `TokensService.validateScopes` now allows any grantable scope (still ⊆ owner) instead of
  read-only. `OAuthFlowService.effectiveScopes` filters by the grantable catalog ∩ user perms.
  Metadata `scopes_supported` = `GRANTABLE_TOKEN_SCOPES`.
- Frontend: API-Tokens picker offers the two write scopes with an amber "write" treatment + a
  warning line; consent screen flags write scopes with a warning icon + banner. (Web imports
  only *types* from the CJS-built shared package, so `isWriteScope` is inlined in `Consent.tsx`
  rather than imported — a runtime value export wouldn't survive rollup's CJS interop.)
- Verified in-memory (10/10): catalog membership, `effectiveScopes` keeps action / drops
  connector-config + unheld, and an action-scoped token authenticates with `connectors:action`.
  No DB change. No new deps.

### 4b — Action tools (MCP) with the safety posture — BUILT (2026-09-02), not yet deployed

Implemented in `mcp-server.factory.ts` via an `actionTool` helper: adds `confirm?: boolean` to
the schema (optional, so an omitted value reaches the handler for a clear refusal rather than a
raw schema error), refuses unless `confirm === true` (except `check_monitor_now`), sets
annotations `{ readOnlyHint:false, destructiveHint }`, and self-audits every successful call as
`mcp.<tool>` with `{ via:'mcp', tokenId|oauthClientId, userId, ...args }` (confirm stripped). The
factory now injects `AuditService` and takes an `McpOrigin` from the controller (`req.apiTokenId`
/ `req.oauthClientId`). Tools: `list_actions`/`get_job` (`connectors:read`); `run_action`,
`run_operation`, `cancel_job` (`connectors:action`, run_action/run_operation destructive-hinted);
`pause_monitor`/`resume_monitor` (confirm) + `check_monitor_now` (no confirm) (`monitors:write`).
Verified in-memory (21/21): scope-gated presence, destructive annotations, confirm-required
schema, the confirm guard (refused calls don't touch the service or audit), successful execution
+ audit with origin, and monitor writes. No DB change. No new deps.

*(Original 4b plan, for reference:)* New tools in `mcp-server.factory.ts`, scope-gated as today:
- `connectors:read` — `list_actions(instanceId, kind, resourceId?)` (surfaces each action's
  `mutating`/`intent`/`confirm`/`showWhenStatus` and each operation's `fields`); `get_job`.
- `connectors:action` — `run_action(instanceId, kind, resourceId, actionId, confirm)`,
  `run_operation(instanceId, operationId, resourceId?, values, confirm)`,
  `cancel_job(instanceId, jobId, confirm)`.
- `monitors:write` — `pause_monitor(monitorId, confirm)`, `resume_monitor(monitorId, confirm)`,
  `check_monitor_now(monitorId)` (a trigger, not a state change → no `confirm`).

Enforcement in the tool wrapper: mutating handlers reject with a clear `isError` message unless
`confirm === true`; annotations set per tool (`run_action`/`run_operation` →
`destructiveHint:true` conservatively, since a generic action may be destructive); every
successful action records audit (`AuditService` injected into the factory) with
`{ via:'mcp', clientId|tokenId, userId }`. Read-only stays the default — a token/grant only
gets these tools if it was explicitly granted the action scope.

**Open build-time checks:** enumerate resource actions for a kind (from the manifest — confirm
the accessor); confirm `startOperation`/`performAction`/`setEnabled`/`checkNow` service
signatures; decide whether static API tokens may hold action scopes (default: yes, for
automation like scheduled backups, but flagged) vs. OAuth-only.

**Sub-slices:** 4a (unlock scopes) → 4b (action tools). Each independently shippable.

## Grounding notes (current code)

- Global guards: `SessionAuthGuard` then `PermissionsGuard`, wired via `APP_GUARD` in
  [`app.module.ts`](../apps/server/src/app.module.ts).
- `SessionUser` shape produced by `AuthService.buildSessionUser` and consumed everywhere:
  `{ id, email, displayName, roleSlug, roleName, permissions, authProvider }`.
- Sessions are cookie/`express-session` (`req.session.userId`), Redis-backed — no `Session`
  table. Bearer auth is orthogonal and adds no session.
- Ids are cuid; secrets vault (`Secret`) is AES-256-GCM via `CryptoService`.
