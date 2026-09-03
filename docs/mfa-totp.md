# Native TOTP MFA for local users

Design + implementation plan for adding time-based one-time-password (TOTP) multi-factor
authentication to Cerebro **local** accounts. SSO/OIDC accounts are out of scope (their
second factor belongs to the identity provider). Bearer API tokens and OAuth clients are
unaffected — they never traverse interactive login.

## Design decisions (resolved)

| Decision | Choice | Why |
| --- | --- | --- |
| Which accounts | Only accounts with a non-null `passwordHash` | Matches the existing local-vs-SSO gate in `validateLocal`. SSO users get MFA at their IdP. |
| Secret at rest | **Encrypted** via existing `CryptoService.encrypt()` | `apps/server/src/common/crypto.service.ts` already does AES-256-GCM. No plaintext-in-DB tradeoff to make. |
| Enrollment state | Persisted immediately with `totpEnabledAt = null` | Avoids in-memory enrollment state. MFA is only *enforced* once `totpEnabledAt` is set. |
| Recovery codes | Separate table, bcrypt-hashed, single-use | A lost authenticator must not lock out a local admin. |
| TOTP library | `otplib` (`authenticator`) + `qrcode` | Pure-JS, no native modules; `qrcode` renders a server-side data-URL. |
| Login model | Two-step, gated at the `login_` session seam | The whole interactive auth funnels through `AuthController.login_`; that is the single interception point. |
| Step-up for enable/disable | Require a valid TOTP code to disable; re-verify a fresh code to enable | Prevents an unattended session from silently turning MFA off. |

## The interception seam

Interactive login already funnels through one private method
([auth.controller.ts:61](../apps/server/src/auth/auth.controller.ts)):

```ts
private login_(req: Request, userId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;           // ← promotes to a full session
      req.session.save((err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}
```

The plan: on a correct password, if the user has `totpEnabledAt`, regenerate the session but
set `req.session.pendingMfa = { userId, expiresAt, attempts }` **instead of** `userId`, and
return `{ mfaRequired: true }`. A second endpoint verifies the code and only then calls the
real `login_`. `SessionAuthGuard` already treats a session without `userId` as
unauthenticated, so a half-authenticated session cannot reach any protected route — no guard
changes needed.

---

## Phase 1 — Schema & dependencies

**Deps** (`apps/server/package.json`): add `otplib` and `qrcode` (+ `@types/qrcode`).

**Prisma** (`apps/server/prisma/schema.prisma`), add to `model User`:

```prisma
  /// AES-256-GCM ciphertext (CryptoService) of the TOTP shared secret. Null = no TOTP set up.
  totpSecret     String?
  /// Set when TOTP enrollment is confirmed; null while pending or disabled. Enforcement key.
  totpEnabledAt  DateTime?
  recoveryCodes  UserRecoveryCode[]
```

New model:

```prisma
/// One single-use TOTP recovery code. Only the bcrypt hash is stored; consumed codes are
/// kept (consumedAt set) for the audit trail until the user regenerates the set.
model UserRecoveryCode {
  id         String    @id @default(cuid())
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  userId     String
  codeHash   String
  consumedAt DateTime?
  createdAt  DateTime  @default(now())

  @@index([userId])
}
```

**Migration**: `apps/server/prisma/migrations/0008_user_totp/migration.sql` — `ALTER TABLE "User" ADD COLUMN …`
plus `CREATE TABLE "UserRecoveryCode"` with the FK `ON DELETE CASCADE` and the `userId` index
(mirror `0005_api_tokens`). Wire nothing else — `prisma:deploy` runs it in the container.

---

## Phase 2 — Server: TOTP service

New `apps/server/src/auth/totp.service.ts` (injected with `PrismaService`, `CryptoService`, `AuditService`):

- `getStatus(userId)` → `{ enabled: boolean, pending: boolean }` for the settings UI.
- `beginEnrollment(userId)` — reject if `!passwordHash` or already enabled. Generate a secret
  (`authenticator.generateSecret()`), store `totpSecret = crypto.encrypt(secret)` with
  `totpEnabledAt = null`, and return `{ otpauthUrl, qrDataUrl }`
  (`authenticator.keyuri(email, 'Cerebro', secret)` → `qrcode.toDataURL`). **Never** return the
  raw secret in a form the client persists beyond the QR.
- `confirmEnrollment(userId, code)` — decrypt the pending secret, `authenticator.verify`
  (default ±1 step window). On success set `totpEnabledAt = now()`, generate **10** recovery
  codes, store their bcrypt hashes, audit `auth.mfa_enrolled`, and return the plaintext codes
  **once**.
- `verifyForLogin(userId, code)` — accept either a TOTP code (decrypt + `authenticator.verify`)
  **or** an unconsumed recovery code (bcrypt-compare across the user's codes; mark
  `consumedAt`). Audit `auth.mfa_verified` / `auth.mfa_failed`.
- `disable(userId, code)` — require a valid TOTP/recovery code, then null out `totpSecret` +
  `totpEnabledAt` and delete recovery codes. Audit `auth.mfa_disabled`.
- `regenerateRecoveryCodes(userId, code)` — step-up verify, replace the set, return new codes.

Register `TotpService` in `apps/server/src/auth/auth.module.ts` (providers + exports).

**Audit actions** (free-form strings, see `AuditService`): `auth.mfa_enrolled`,
`auth.mfa_verified`, `auth.mfa_failed`, `auth.mfa_disabled`, `auth.mfa_recovery_used`,
`auth.mfa_admin_reset`.

---

## Phase 3 — Server: login flow

**Session shape** (`apps/server/src/auth/session.types.ts`) — add to `SessionData`:

```ts
    /** Half-authenticated state between password success and TOTP verification. */
    pendingMfa?: { userId: string; expiresAt: number; attempts: number };
```

**Controller** (`apps/server/src/auth/auth.controller.ts`):

- Change `login()` return type to `{ ok: true } | { mfaRequired: true }`. After a successful
  `validateLocal`, check `totpEnabledAt`:
  - not enabled → `login_(req, userId)` as today.
  - enabled → regenerate the session, set `req.session.pendingMfa` (TTL ~5 min, attempts 0),
    save, return `{ mfaRequired: true }`. **Do not** audit `auth.login` yet.
- New `@Public() @Post('login/totp')` `loginTotp(@Body() { code }, @Req() req)`:
  - read `req.session.pendingMfa`; reject if missing/expired/`attempts >= 5`.
  - `totp.verifyForLogin(pendingMfa.userId, code)`; on failure increment `attempts`, save, 401.
  - on success `login_(req, userId)` (clears pendingMfa via `regenerate`) and audit `auth.login`.

Add a small `LoginTotpDto { code: string }` in `apps/server/src/auth/dto.ts`.

> Rate limiting: reuse the in-memory attempt pattern from
> [account.service.ts](../apps/server/src/account/account.service.ts) — the `attempts` counter
> on `pendingMfa` (login) and the per-request checks in `TotpService` are enough for a
> self-hosted single-instance app. No new dependency.

---

## Phase 4 — Server: self-service + admin endpoints

**Account controller** (`apps/server/src/account/account.controller.ts`, self-service — no
`@RequirePermissions`, owner acts on themselves). Add:

- `GET  api/account/mfa` → `totp.getStatus(user.id)`
- `POST api/account/mfa/setup` → `totp.beginEnrollment(user.id)` → `{ qrDataUrl, otpauthUrl }`
- `POST api/account/mfa/enable` `{ code }` → `totp.confirmEnrollment` → `{ recoveryCodes }`
- `POST api/account/mfa/disable` `{ code }` → `totp.disable`
- `POST api/account/mfa/recovery-codes` `{ code }` → `totp.regenerateRecoveryCodes`

Mark these `@SessionOnly()` so an API token can't manage a human's MFA.

**Admin reset** (`apps/server/src/users/users.service.ts` + its controller, behind the existing
`users:write`/admin permission): `clearMfa(userId)` — nulls `totpSecret`/`totpEnabledAt`,
deletes recovery codes, audits `auth.mfa_admin_reset`. This is the lockout escape hatch. Also
surface `mfaEnabled` in the admin user `list()` projection.

**Optional** — add `mfaEnabled: boolean` to `SessionUser` (`@cerebro/shared`) and
`buildSessionUser` so the settings page can render state without an extra fetch.

---

## Phase 5 — Frontend

**Login** (`apps/web/src/pages/Login.tsx`): the `submit` handler currently does
`await api.post('/api/auth/login', …)` then `refresh()`. Change to inspect the response — if
`{ mfaRequired: true }`, switch the card to a second step (a 6-digit code input, "use a
recovery code" toggle) that POSTs `/api/auth/login/totp`, then `refresh()` + navigate on
success. Keep the existing `returnTo` handling on the final step.

**Account settings** (wherever the password-change UI lives — the account page that calls
`api/account/password/*`): add a "Two-factor authentication" section:
- disabled → "Set up" button → POST `mfa/setup`, render the returned `qrDataUrl` + manual
  `otpauthUrl` secret, code field → POST `mfa/enable` → **show the recovery codes once** with a
  copy/download affordance and a "I've saved these" confirm.
- enabled → show status, "Regenerate recovery codes" and "Disable" (each prompts for a current
  code).

**Admin users table**: an MFA column + a "Reset MFA" action calling the admin endpoint.

---

## Testing checklist

- [ ] Enroll: setup → scan → wrong code rejected → correct code enables → recovery codes shown once.
- [ ] Login with MFA on: password step returns `mfaRequired`; protected routes unreachable while `pendingMfa` is set; correct TOTP completes login; `auth.login` audited only after the second factor.
- [ ] Recovery code logs in once, then is rejected on reuse.
- [ ] Expired / >5-attempt `pendingMfa` forces restart of login.
- [ ] Disable requires a valid code; afterwards login is single-step again.
- [ ] SSO-only user (`passwordHash = null`) cannot enroll; setup rejects.
- [ ] Admin "Reset MFA" clears a locked-out user; audited.
- [ ] Bearer API token still authenticates unaffected; token cannot hit `api/account/mfa/*`.
- [ ] Secret round-trips through `CryptoService`; DB column is ciphertext, never base32.

## Effort

~1.5–2 days. No architectural changes, no infra, low-risk additive migration. The only files
touched at the auth core are `auth.controller.ts`, `session.types.ts`, and the new
`totp.service.ts`; everything else follows existing patterns
([account.service.ts](../apps/server/src/account/account.service.ts) for challenges,
[crypto.service.ts](../apps/server/src/common/crypto.service.ts) for secret storage,
`0005_api_tokens` for the migration + table shape).
