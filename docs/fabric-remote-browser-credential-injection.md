# Cerebro Fabric — Remote Browser credential injection (web autofill)

> **Status: P1 BUILT (2026-10-01) — green, NOT committed / not live-tested.** This is the
> buildable spec for adding **web credential injection** to the Fabric **Remote Browser**
> (the ephemeral Chromium-in-a-container jump, formerly "Web Jump"). It extends the existing
> Remote Browser broker (`remote-browser.service.ts`) and reuses the vault,
> `secretRef`-on-target model, four-eyes gate, audit, and `/fabric` UI. The genuinely new
> infrastructure is an **in-container autofill helper driven over CDP** and a **one-shot
> credential redemption** path to feed it.
>
> **P1 as built (shared/server/web compile clean; `docker build` + image rebuild needed):**
> `web` secret kind + `WebCredential`/`LoginRecipe` (`packages/shared/src/secrets.ts`);
> `secretRef` + `webAutofill` on `web` routes (migration `0035_fabric_web_autofill`, forced-null
> lifted in `normalizeRoute`); broker resolves the credential inside the gate closure, mints a
> single-use redemption token, passes `AUTOFILL_REDEEM_URL` + enables CDP on loopback
> (`remote-browser.service.ts`); `POST /api/fabric/remote-browser/:token/inject` (manual arm)
> + `@Public() POST /api/fabric/internal/autofill/:token` (one-shot, IP-scoped redemption);
> in-container `autofill-helper.js` (dependency-free CDP client) + entrypoint/Dockerfile wiring
> (`docker/remote-browser/`); route-dialog credential picker + autofill selector and an
> **"Inject login"** button in the Remote Browser viewer (`apps/web/src/pages/Fabric.tsx`).
> Heuristic fill only (no auto-submit); recipes (P2) and TOTP (P3) not yet wired — the helper
> logs and falls back to heuristic when a recipe is present. **Decisions (2026-10-01): HTTP
> redemption endpoint; `manual` default.** Default autofill mode stays at `fabric:connect`
> (the credential never reaches the operator's client). Needs the Remote Browser image to
> rebuild (its context fingerprint changed → auto-rebuilds on next use) so Node + the helper land.

This is the web analogue of the credential injection Fabric already does for SSH / RDP / VNC
(see `docs/fabric-waypoints.md` and `docs/fabric-remote-access.md`). It is deliberately
designed so that, unlike VNC, **the plaintext web credential never leaves the server's trust
boundary** — it is injected *inside* the container the operator only sees pixels of.

---

## 1. Why web is the hard case

RDP / SSH / VNC each have a **protocol-level auth handshake** — a defined moment where the
server consumes the credential, and that is exactly where Cerebro injects it today:

| Protocol | Injection point | Where in code |
|---|---|---|
| SSH | `ssh2` `conn.connect({ username, password, privateKey })` (server-side) | `apps/server/src/fabric/fabric-session.service.ts:203` |
| RDP | guacd connect args in the synchronous `resolveConnection` callback | `apps/server/src/fabric/fabric-guac.service.ts:177` |
| VNC | resolved creds returned in the ticket; noVNC auto-sends on `credentialsrequired` | `apps/web/src/pages/Fabric.tsx:3448` |

**Web login has no handshake.** "Logging in" is a human typing into whatever form a site
renders — different field selectors, single-step vs. multi-step SSO, iframes, SPAs, MFA.
There is no universal injection point. That reality drives every decision below.

### 1.1 The architectural advantage we exploit

The Remote Browser is a **full Chromium in a container Cerebro owns**
(`apps/server/src/fabric/remote-browser.service.ts`, `docker/remote-browser/`). Two
consequences make this cleaner and *safer* than the VNC autofill we already ship:

1. **Drive Chromium over CDP (Chrome DevTools Protocol), not fake keystrokes.** We can
   locate fields and set values programmatically — robust against SPAs, shadow DOM, and
   iframes in a way `xdotool`-style keystroke injection never is.
2. **The plaintext credential never reaches the operator.** For VNC, the resolved password
   is sent *to the operator's browser* in the ticket, which is why saved-VNC-creds require
   `fabric:manage` (`fabric.service.ts:307`). For Remote Browser, injection happens **inside
   the container the operator only sees as pixels** — so the secret stays server-side. This
   is the central security property of this design.

---

## 2. Locked decisions (recommended secure options)

These are the "best secure option" choices this doc commits to. Rationale in §5–§6.

1. **Injection mechanism: CDP from an in-container autofill helper.** Chromium launches with
   `--remote-debugging-port=9222` bound to **`127.0.0.1` inside the container only**. A small
   helper process in the same container connects to it and fills/submits. CDP is **never**
   exposed on the Docker network, through the SOCKS bridge, or over VNC.
2. **Credential delivery: one-shot redemption from inside the container.** The helper redeems
   a **single-use, short-TTL token** against the broker over the internal Docker network and
   receives the resolved credential once; the broker invalidates it immediately. **No secret
   in env vars, on disk, or in any URL.** The secret lives only in the helper's process memory
   and is zeroed after fill. (Fallback if a control channel is undesirable: `putArchive` a
   file into a **tmpfs** mount, read-then-unlink — documented in §6.3, not the default.)
3. **RBAC stays at `fabric:connect`.** Because the operator never receives the plaintext,
   web autofill does **not** require the `fabric:manage` escalation that saved-VNC-creds do.
   Attaching/editing the credential on a route still requires `fabric:manage` (route config),
   exactly like every other `secretRef`.
4. **Field strategy is tiered, shipped incrementally:** heuristic + **manual "Inject"
   trigger** first (P1), per-target **recipes** second (P2), **TOTP** auto-entry third (P3).
5. **New vault secret kind `web`** holding `{ username, password, totpSecret?, loginRecipe? }`,
   `category: 'fabric'`, stored as JSON plaintext like the other Fabric kinds.
6. **Recording is suppressed during the inject step** (P3) so the keystroke/field value is not
   captured in the session recording.

---

## 3. Data model & contracts

### 3.1 Vault — new `web` credential kind

`packages/shared/src/secrets.ts`:
- Add `'web'` to `SecretKind` (currently `'generic'|'git'|'ssh'|'rdp'|'vnc'`).
- New shape alongside `SshCredential` / `RdpCredential` / `VncCredential`:

```ts
export interface WebCredential {
  username: string;
  password: string;
  /** Optional base32 TOTP seed; broker computes the current code at inject time (P3). */
  totpSecret?: string;
  /** Optional per-credential login recipe override (P2). */
  loginRecipe?: LoginRecipe;
}
```

- `LoginRecipe` (P2) — an ordered step list the helper executes:

```ts
export type LoginStep =
  | { op: 'fill'; selector: string; value: 'username' | 'password' | 'totp' }
  | { op: 'click'; selector: string }
  | { op: 'waitFor'; selector: string; timeoutMs?: number }
  | { op: 'submit'; selector?: string };

export interface LoginRecipe {
  /** Optional: only run if the current URL matches (origin or glob). */
  matchUrl?: string;
  steps: LoginStep[];
}
```

### 3.2 Fabric routes — allow `secretRef` + autofill config on `web`

Today `normalizeRoute` **forces `secretRef: null` for `web` routes**
(`apps/server/src/fabric/fabric.service.ts:785`). Lift that for `web`:
- `FabricTargetDto` / `FabricRouteInput` (`packages/shared/src/fabric.ts`): allow `secretRef`
  on `web`; `hasCredential` already means "a vault credential is attached."
- Add optional `webAutofill?: 'off' | 'auto' | 'manual'` to the `web` route (default `manual`):
  - `off` — never inject.
  - `auto` — attempt heuristic/recipe fill on page load.
  - `manual` — only when the operator clicks **Inject** in the viewer (recommended default).
- `secretRef` must reference a **`web`-kind** secret (validated in `normalizeRoute` /
  `saveTargetCredential`, mirroring the kind check in `revealCredential`,
  `fabric.service.ts:530`).

**Migration:** `AgentTarget.secretRef` already exists; `webAutofill` is one new nullable
column → **one small migration** (next number in sequence). The vault secret itself needs no
migration (JSON value under `SecretMeta`, `kind='web'`).

### 3.3 Launch & inject surface

- `POST /api/fabric/agents/:id/targets/:targetId/remote-browser-session`
  (`openRemoteBrowser`, `fabric.controller.ts:600`) — unchanged signature; the broker now
  resolves `target.secretRef` (if present and `webAutofill != 'off'`) at launch and arms the
  redemption token.
- **New** `POST .../remote-browser/:token/inject` — the manual trigger (P1). Gated
  `fabric:connect` + `@SessionOnly()`, scoped to the caller's own live session token. Causes
  the broker to signal the in-container helper to run a fill against the *currently visible*
  page.
- Ticket return is unchanged (`FabricVncSessionTicket { token, wsPath, password }`) — the VNC
  transport password is independent of web creds.

---

## 4. End-to-end flow (recommended design)

```
Operator clicks "Open Remote Browser" (route has a web secretRef, webAutofill=manual)
  │
  ▼
openRemoteBrowser (controller)  →  openRemoteBrowserSession (service)
  │  gate(...) four-eyes if agent.requireApproval  (cred resolved AFTER gate, as today)
  ▼
remoteBrowser.launch({ ..., secretRef, webAutofill })
  │  • revealCredential(secretRef, 'web')  → WebCredential (held in broker memory only)
  │  • mint one-shot redemptionToken (single-use, ~60s TTL) bound to this session
  │  • create container (START_URL, CHROME_PROXY, VNC_PASSWORD as today)
  │       + CDP on 127.0.0.1:9222 (never published, never on SOCKS/VNC)
  │       + AUTOFILL_REDEEM_URL = http://<callbackHost>:<brokerPort>/internal/autofill/<redemptionToken>
  ▼
Container boots: Xvfb → x11vnc → chromium(--remote-debugging-port=9222 ...) + autofill-helper
  │  helper: GET AUTOFILL_REDEEM_URL  (over internal docker network, single use)
  │          broker returns { username, password, totp?, recipe? } ONCE, then invalidates
  │  helper connects CDP 127.0.0.1:9222
  │  • webAutofill=auto  → attempt fill now (recipe if present, else heuristic)
  │  • webAutofill=manual→ wait; fill when broker signals /inject
  ▼
Operator sees pixels over noVNC (reused VncViewer). Plaintext never left the container.
```

Credential resolution precedence mirrors the existing flow
(`input.secretRef || (useSaved ? target.secretRef : undefined)` — `fabric.service.ts:226/300/490`).

### 4.1 The field strategy (the "which fields / when" problem)

- **Heuristic (P1):** find `input[type=password]`, the nearest preceding text/email input,
  and the enclosing form's submit control. Covers the majority of single-form logins. On
  multi-step SSO it fills what's visible and stops.
- **Manual trigger (P1):** operator navigates to the login page themselves, clicks **Inject**;
  the helper fills the *currently visible* form. This sidesteps detection/timing for the long
  tail and is the recommended default (`webAutofill=manual`).
- **Recipes (P2):** per-credential/per-route `LoginRecipe` runs an explicit step sequence
  (`fill #user → click Next → waitFor #pass → fill #pass → submit`) for Google/Microsoft/Okta
  style flows.
- **TOTP (P3):** if `totpSecret` is set, the broker computes the current code at inject time
  (reuse the MFA TOTP crypto — see `docs/mfa-totp.md`) and the helper fills it as a `value:
  'totp'` step. Push/hardware-key MFA is finished by the operator by hand.

---

## 5. Security model

- **Plaintext containment.** The credential is revealed in the broker, delivered once to the
  in-container helper, injected via CDP, and zeroed. It is **never** placed in env, on disk,
  in a URL, or in the ticket returned to the operator's browser. This is strictly stronger
  than the VNC path.
- **CDP is an RCE surface — keep it internal.** `--remote-debugging-port=9222` binds
  `127.0.0.1` inside the container. The SOCKS bridge (`remote-browser-proxy.ts`) already
  scopes allowed host/ports (`allowHost`, `{allowPort,80,443}`, `remote-browser-proxy.ts:60`);
  **9222 must never be added to that allow-list**, and the container must not publish it.
- **One-shot token.** Single-use, short TTL, bound to the session; redeemable only from the
  container's network identity (`resolveContainerIp`, `remote-browser.service.ts:382`).
  Compromise after redemption yields nothing.
- **RBAC.** Launch + inject at `fabric:connect`; attaching/editing the route credential at
  `fabric:manage` (route config). No new "reveal to human" path, so no step-up re-auth needed
  (contrast `revealForActor`, `secrets.service.ts:63`).
- **Audit.** Emit `fabric.remoteBrowser.autofill` (session id, target, actor, recipe-or-
  heuristic, success/fail) alongside the existing `fabric.remoteBrowser.launched`. **Never log
  the credential value.**
- **Recording leakage (P3).** Remote Browser sessions record a `FabricSession`
  (`targetKind:'web'`). Suppress recording for the inject window, or redact, so the field
  value isn't captured.
- **Four-eyes.** Unchanged — `gate` runs before cred resolution; the credential lives only in
  the mint closure until approved (`fabric-approval.service.ts`), consistent with today.

---

## 6. Roadblocks & how this design handles them

| Roadblock | Handling |
|---|---|
| No universal injection point | Tiered: heuristic + manual trigger (P1) → recipes (P2). Manual trigger covers the long tail cheaply. |
| Credential delivery leaks (env in `docker inspect` / `/proc/1/environ`) | One-shot redemption from inside the container; secret in helper RAM only, zeroed after fill. |
| CDP = remote code execution | Bound to `127.0.0.1` in-container; never on SOCKS/VNC/published; one-shot token. |
| Multi-step SSO | Recipes (P2) with `waitFor` + ordered steps. |
| MFA beyond TOTP (push, hardware keys) | TOTP automated (P3, reuse MFA crypto); other factors finished by the operator — UX degrades gracefully. |
| Secret visible on screen / in recording | Recording suppression during inject (P3); CDP `insertText` avoids on-wire keystrokes. |
| Bot/automation detection | CDP dispatches real input events; occasional long-tail failures fall back to manual typing by the operator. |
| Per-launch / ad-hoc login URL | `openRemoteBrowserSession` uses the stored `webUrl` today (`fabric.service.ts:352`); an ad-hoc URL is a separate, optional net-new input (out of scope for P1). |

### 6.3 Delivery fallback (not the default)

If the one-shot redemption endpoint is undesirable, deliver via **tmpfs**: `putArchive`
(`PUT /containers/{id}/archive`, via `DockerApi`) a `0400` file into a `tmpfs` mount after
create; the helper reads then `unlink`s it. Secret stays in RAM (tmpfs) and dies with the
container (`AutoRemove: true`). Rejected as default because it briefly materializes the secret
as a file and spreads it across the Docker API surface; the redemption path keeps it in-process.

---

## 7. Phased build plan

**P1 — Heuristic + manual inject (smallest working slice). ✅ BUILT 2026-10-01.**
- ✅ `web` secret kind + `WebCredential`/`LoginRecipe` (`packages/shared/src/secrets.ts`).
- ✅ Allow `secretRef` + `webAutofill` on `web` routes; forced-null lifted in `normalizeRoute`;
  migration `0035_fabric_web_autofill`.
- ✅ Broker: resolve `secretRef` inside the gate closure, mint redemption token, pass
  `AUTOFILL_REDEEM_URL` + enable CDP (`remote-browser.service.ts`); `POST internal/autofill/:token`
  (one-shot, IP-scoped); `POST remote-browser/:token/inject` (manual arm).
- ✅ Container: `autofill-helper.js` (dependency-free CDP client) + CDP flag/helper launch in
  `entrypoint.sh`, Node added to the `Dockerfile` (image auto-rebuilds via context fingerprint).
- ✅ UI: credential picker + autofill selector on the `web` route dialog (`kind=web`); **Inject
  login** button in the Remote Browser viewer (`Fabric.tsx`, both overlay + new-tab paths).
- ✅ Audit event `fabric.remoteBrowser.autofill` + this doc.
- ⏳ Not done in P1: auto-submit (deliberately off), recipes (P2), TOTP (P3), live test.

**P2 — Recipes.** `LoginRecipe` type + per-route/per-cred editor; helper executes step
sequences; a few built-in templates (Google / Microsoft / Okta).

**P3 — TOTP + recording hardening.** Compute TOTP at inject (reuse MFA crypto); suppress/redact
recording during the inject window.

---

## 8. File index (anticipated touch-list)

| Concern | File |
|---|---|
| `web` secret kind + shapes + `LoginRecipe` | `packages/shared/src/secrets.ts` |
| Route contracts (`secretRef`/`webAutofill` on `web`) | `packages/shared/src/fabric.ts` |
| Lift forced-null, resolve cred, mint token, inject endpoint | `apps/server/src/fabric/fabric.service.ts` (`normalizeRoute` :739/:785, `openRemoteBrowserSession` :339, `revealCredential` :530) |
| Launch wiring (CDP flag, redeem URL), inject signal, redemption endpoint | `apps/server/src/fabric/remote-browser.service.ts` (`launch` :147) |
| Controller routes (`/inject`, internal redeem) | `apps/server/src/fabric/fabric.controller.ts` (`openRemoteBrowser` :600) |
| SOCKS scope guard (ensure 9222 excluded) | `apps/server/src/fabric/remote-browser-proxy.ts` (:60) |
| Container: autofill helper + CDP flag | `docker/remote-browser/Dockerfile`, `docker/remote-browser/entrypoint.sh`, new helper script |
| Vault reveal (reused) | `apps/server/src/secrets/secrets.service.ts` (`reveal` :49) |
| TOTP compute (P3, reuse) | MFA TOTP service — see `docs/mfa-totp.md` |
| UI: cred picker + Inject button | `apps/web/src/pages/Fabric.tsx` (`openRemoteBrowser` :285, routes dialog ~:1754, `VncViewer` :3385) |
| Migration (`webAutofill` column) | `apps/server/src/.../migrations/00XX-*` |

---

## 9. Open questions

1. ~~**Redemption transport**~~ **RESOLVED (2026-10-01): dedicated `/internal/autofill/:token`
   HTTP endpoint** on the broker — maps to the one-shot ticket model used everywhere.
2. ~~**`webAutofill` default**~~ **RESOLVED (2026-10-01): `manual`** (operator clicks Inject).
3. **Credential scope** — one `web` secret per route, or a small set selectable at launch (an
   operator picks which login to inject)? P1 = one per route; selectable can follow.
4. **CDP vs. injected content script** — pure CDP (`Runtime.evaluate` + `Input`) vs. a
   bundled extension/content script. CDP keeps the image minimal; revisit if sites block it.
5. **Ad-hoc Remote Browser URL** — worth pairing with this, or keep separate? Out of scope here.
