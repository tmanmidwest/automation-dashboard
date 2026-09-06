# Secrets vault (first-class credential management)

> **Status: BUILT — Phases 1–3, plus shared credentials & connector references (2026-09-06).**
> Awaiting deploy (edit-only workflow). Phase 4 (master-key rotation utility) is deferred. This
> document is the original plan; the **What was built** column and the *Shared credentials &
> connector references* section at the end record what actually shipped and where it diverged.

Turned Cerebro's existing, invisible secret store into a **managed, auditable, first-class
vault**: a UI to see and rotate every credential, "last used" and age tracking, optional rotation
policies with reminder alerts, an audit trail of every administrative change, and — beyond the
original plan — **shared credentials you create in the vault and reference from connectors**. The
**encryption and storage already existed** — this was metadata, lifecycle, and surface, not new
cryptography.

## What existed, and what was built

| Piece | Status | Where |
| --- | --- | --- |
| AES-256-GCM encrypt/decrypt | pre-existing | `apps/server/src/common/crypto.service.ts` |
| Ciphertext store (`key` → `ciphertext`) | pre-existing | `Secret` model; `settings.service.ts` (now delegates to `SecretsService`) |
| Connector creds stored as `connector:<id>:<field>` | pre-existing | connectors write via `setSecret` |
| TOTP secrets encrypted | pre-existing | `auth/totp.service.ts` |
| Metadata (label, category, timestamps, policy) | **Built** | `SecretMeta` table + migration `0009` |
| Management UI | **Built** | `apps/web/src/pages/settings/Secrets.tsx` (`/settings/secrets`) |
| `lastUsedAt` tracking + audit of writes | **Built** | `SecretsService.reveal` (throttled stamp), audited set/rotate/delete |
| Rotation reminders | **Built** | `secret.rotation_due` / `secret.expired` alerts, daily cron |
| Shared credentials + connector references | **Built** | see the section at the end (beyond the original plan) |
| Master-key rotation utility | **Deferred** | Phase 4 below — not built |

## Design decisions (resolved)

| Decision | Choice | Why |
| --- | --- | --- |
| Store plaintext readable in UI? | **Never.** Set/replace only; the UI shows metadata, not values | A management console that can reveal every credential is the single worst breach target. Values flow *into* the vault and *into* connectors, never back to a screen. |
| Metadata location | New **`SecretMeta`** table keyed by the same `key` as `Secret` | Keeps ciphertext untouched (no re-encryption/migration); 1:1 sidecar row. |
| Access tracking | A single `SecretsService.reveal(key)` wrapper that stamps `lastUsedAt` | One choke point. Existing `getSecret` callers delegate to it; the plaintext path is unchanged. |

> **As built — reveal does NOT audit.** The plan had `reveal()` emit an audit event per read. In
> practice connector `buildContext` reveals secrets on *every* telemetry poll, so auditing reads
> would flood the log/timeline, and there is deliberately no reveal-to-UI endpoint (every reveal is
> a background/system read). So `reveal()` only stamps `lastUsedAt`, **throttled** (skipped if
> stamped within ~5 min); only administrative **writes** (set/rotate/delete via the API) are
> audited.
| Audit integration | Every reveal / set / rotate / delete → `AuditService.record` | Feeds straight into the [event timeline](./event-timeline.md); the two features join here. |
| Rotation reminders | A daily cron compares `expiresAt`/age → fires a new `secret.rotation_due` alert | Reuses the notification catalog + pipeline already built. New alert category "Secrets". |
| Permissions | `secrets:read` (list metadata) + `secrets:write` (set/rotate/delete) | New RBAC strings; **not** grantable as API-token scopes (never expose the vault to bearer tokens). |
| Master-key rotation | Offline-style re-encrypt-all utility, run explicitly by an admin | AES key change today silently breaks every secret; give it a safe migration path. |

## Schema

**New model** in `apps/server/prisma/schema.prisma` (sidecar to `Secret`, same `key`):

```prisma
/// Management metadata for a vault entry. 1:1 with Secret by key. Never holds secret material.
model SecretMeta {
  key             String   @id
  /// Human label, e.g. "Proxmox API token (home)".
  label           String
  description     String?
  /// Grouping: 'connector' | 'notification' | 'api' | 'manual'.
  category        String   @default("manual")
  /// The ConnectorInstance this belongs to, when category='connector'.
  owningConnectorId String?
  /// Optional rotation policy: warn when older than this many days (null = no policy).
  rotateAfterDays Int?
  /// Optional hard expiry (e.g. a token the provider expires).
  expiresAt       DateTime?
  /// Stamped by SecretsService.reveal — null until first read.
  lastUsedAt      DateTime?
  /// Set on every set/rotate.
  rotatedAt       DateTime @default(now())
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([category])
  @@index([owningConnectorId])
}
```

> Entries created before this feature (existing `connector:*` secrets) get a `SecretMeta`
> backfilled by a one-time seed step (Phase 1) inferring `category` and `owningConnectorId`
> from the `connector:<id>:<field>` key convention.

## Shared types

`packages/shared/src/secrets.ts` (new):

```ts
export type SecretCategory = 'connector' | 'notification' | 'api' | 'manual';

/** Metadata only — the ciphertext/value is never serialized to a client. */
export interface SecretSummary {
  key: string;
  label: string;
  description?: string;
  category: SecretCategory;
  owningConnectorId?: string | null;
  rotateAfterDays?: number | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  rotatedAt: string;
  createdAt: string;
  /** Derived server-side: 'ok' | 'due' | 'expired'. */
  health: 'ok' | 'due' | 'expired';
  ageDays: number;
}
```

---

## Phase 1 — `SecretsService` + metadata + backfill

**New** `apps/server/src/secrets/secrets.service.ts` — the single choke point. It **owns** the
`Secret` + `SecretMeta` pair; `settings.service.ts` secret methods are re-pointed here (or kept
as thin delegates).

```ts
@Injectable()
export class SecretsService {
  constructor(
    private prisma: PrismaService,
    private crypto: CryptoService,
    private audit: AuditService,
  ) {}

  /** Write/replace a value AND its metadata. Stamps rotatedAt. */
  async set(key: string, plaintext: string, meta: Partial<SecretMetaInput>, ctx: ActorCtx) { … }

  /** The ONLY read path. Stamps lastUsedAt + audits. Returns plaintext. */
  async reveal(key: string, ctx: ActorCtx): Promise<string | null> {
    const row = await this.prisma.secret.findUnique({ where: { key } });
    if (!row) return null;
    await this.prisma.secretMeta.updateMany({ where: { key }, data: { lastUsedAt: new Date() } });
    await this.audit.record({ ...ctx, action: 'secret.revealed', target: key });
    return this.crypto.decrypt(row.ciphertext);
  }

  async list(): Promise<SecretSummary[]> { /* meta only, compute health/ageDays */ }
  async remove(key: string, ctx: ActorCtx) { /* delete both + audit */ }
}
```

- **Migrate callers of `getSecret`** (connectors, TOTP verify, notifications) to
  `secrets.reveal(...)`. Where there is no interactive actor (background telemetry), pass a
  `system` actor ctx so the audit/`lastUsedAt` still records "who" as the system.
- **Backfill seed** (`apps/server/src/seed/…`): for every existing `Secret` with no
  `SecretMeta`, create one — parse `connector:<id>:<field>` → `category:'connector'`,
  `owningConnectorId:<id>`, `label` from the connector name + field.

## Phase 2 — RBAC + API + management UI

**RBAC** (`packages/shared/src/rbac.ts`): add `'secrets:read' | 'secrets:write'` to
`Permission`; grant both to the **Full Control** role, neither to Viewer by default; **exclude**
from `GRANTABLE_TOKEN_SCOPES` (vault stays session-only, never a bearer-token capability).

**Controller** `apps/server/src/secrets/secrets.controller.ts`:
- `GET /api/secrets` (`secrets:read`) → `SecretSummary[]` (metadata only).
- `PUT /api/secrets/:key` (`secrets:write`) → set/rotate value + metadata.
- `DELETE /api/secrets/:key` (`secrets:write`).
- **No GET that returns a value.** There is deliberately no reveal-to-UI endpoint.

**UI** `apps/web/src/pages/settings/Secrets.tsx`, route `/settings/secrets` (`secrets:read`):
- Grouped by category. Each row shows label, age ("rotated 84d ago"), `lastUsedAt`
  ("used 2h ago" / "never used" — a **never-used** connector secret is a useful smell), and a
  health badge (`ok`/`due`/`expired`) with LCARS severity color.
- Actions: **Rotate** (enter a new value — write-only field), **Edit metadata** (label,
  description, `rotateAfterDays`, `expiresAt`), **Delete** (guarded: warn if a connector still
  references it).
- Connector-owned secrets deep-link to the owning connector's detail page.

## Phase 3 — Rotation reminders (reuse notifications)

- **New alert type** in `apps/server/src/notifications/alerts/alert-registry.ts`:
  `key: 'secret.rotation_due'`, `category: 'Secrets'`, `defaultSeverity: 'warning'`.
  Add an `expired` companion (`secret.expired`, `critical`) or reuse severity escalation.
- **Daily cron** (`SecretsService.checkRotations`, `@Cron` daily): for each `SecretMeta` with a
  policy, compute health; if `due`/`expired` and not already alerted this cycle, dispatch through
  the existing notifications pipeline. Mute-per-secret optional (mirrors monitor mute).
- These alerts appear in the [timeline](./event-timeline.md) automatically via `NotificationLog`.

## Phase 4 — Master-key rotation utility (optional, safety net)

Today changing `APP_ENCRYPTION_KEY` silently invalidates every secret (decrypt fails). Provide a
guarded admin operation:

- `POST /api/secrets/rekey` (`secrets:write`, plus a re-auth/step-up), accepting the **old** key
  and the **new** key. It decrypts each `Secret` with the old key and re-encrypts with the new,
  in a transaction, then instructs the operator to update the env var. Alternatively a CLI
  `npm run secrets:rekey` for an offline run. Emits a single `secret.rekeyed` audit event
  (count only — never the keys or values).

## Shared credentials & connector references — BUILT (beyond the original plan)

The original plan made the vault a *view* over secrets that connectors already owned (one copy
per connector, written through its setup form). A follow-up added the missing half: **create a
credential in the vault once, then reference it from many connectors.** The motivating case was a
fleet of Docker connectors sharing one SSH password — without this you'd paste and rotate it once
per host.

**Two capabilities:**

1. **Create standalone secrets in the vault.** A *New secret* dialog on `/settings/secrets` (key,
   label, category, value). No new backend was needed — `PUT /api/secrets/:key` already upserts,
   so this is UI only.
2. **Reference a vault secret from a connector secret field.** Each secret field on a connector's
   setup form offers **Enter value** or **Use vault secret** (a dropdown of vault secrets, shown
   only to `secrets:read` holders).

**How a reference is stored and resolved:**

- A referenced field's value is the shape `{ $secretRef: '<vaultKey>' }`. The connector stores a
  **pointer, not a copy**: the reference lives in the instance's `config.secretRefs`
  (`field → vaultKey`, in the non-secret config JSON), and **no** `connector:<id>:<field>` secret
  is written for that field.
- `ConnectorInstanceService.buildContext` resolves at use-time: if `config.secretRefs[field]` is
  set, it reveals **that shared vault secret** (`SettingsService.getSecret(refKey)` →
  `SecretsService.reveal`, which stamps the shared secret's `lastUsedAt`); otherwise it reveals the
  connector's own `connector:<id>:<field>`. The internal `secretRefs` map is **stripped** from the
  config before it reaches the connector.
- `create`/`update` translate an incoming `{ $secretRef }` into `config.secretRefs` (and, on
  update, delete any connector-owned copy of that field); a literal value writes the own-secret and
  clears the reference. A blank value leaves whatever is currently set. `secretFieldsSet` reports a
  referenced field as "set", and `getOne` returns `secretRefs` so the edit form can pre-select.

**Payoffs:** rotate one vault secret and every connector that references it picks up the change;
the vault's `lastUsedAt` reflects real cross-connector usage; deleting a connector never deletes a
shared secret it only referenced.

> **Edge:** switching a field from *vault* back to *value* and saving it blank keeps the existing
> reference (blank means "leave unchanged"). To replace a reference with a literal, type the value.

**Files:** `packages/shared/src/dto.ts` (`SecretRefValue`, `ConnectorInstanceConfig.secretRefs`);
`connector-instance.service.ts` (`isSecretRef`, ref-aware `create`/`update`/`buildContext`/
`secretFieldsSet` + `secretRefs`); `connectors.controller.ts` (`getOne` returns `secretRefs`);
web `ConnectorSetup.tsx` (the per-field toggle + `SecretField` component) and `Secrets.tsx` (the
*New secret* dialog).

---

## Files touched (summary)

| File | Change |
| --- | --- |
| `apps/server/prisma/schema.prisma` | `SecretMeta` model (+ migration) |
| `packages/shared/src/secrets.ts` (new) + `index.ts` | `SecretSummary`, `SecretCategory` |
| `packages/shared/src/rbac.ts` | `secrets:read` / `secrets:write`; exclude from token scopes |
| `apps/server/src/secrets/*` (new module) | `SecretsService` + controller + module |
| `apps/server/src/settings/settings.service.ts` | re-point secret methods to `SecretsService` |
| connectors / `auth/totp.service.ts` / notifications | migrate `getSecret` → `secrets.reveal` |
| `apps/server/src/seed/*` | backfill `SecretMeta` for existing secrets |
| `apps/server/src/notifications/alerts/alert-registry.ts` | `secret.rotation_due` (+ `expired`) |
| `apps/web/src/pages/settings/Secrets.tsx` (new) + `App.tsx` | `/settings/secrets` screen + route |

## Open questions

1. **Reveal path for automation** — MCP/API callers must **never** read raw secrets; confirmed
   by excluding `secrets:*` from `GRANTABLE_TOKEN_SCOPES`. Any exception (e.g. an "inject into
   connector" flow) should hand the value connector→provider server-side, never to the client.
2. **Per-secret alert muting** — worth it, or is a global "Secrets" alert toggle enough for a
   home deployment? Start global; add per-secret mute if noisy.
3. **Rekey UX** — env-var swap requires a container restart anyway; is the API `/rekey` worth it
   over a documented CLI one-shot? Lean CLI-first (`npm run secrets:rekey`) and add the API later.
4. **Delete guard** — detecting "a connector still references this key" needs a reverse lookup
   from `connector:<id>:<field>` keys to live `ConnectorInstance` rows; cheap, worth doing to
   prevent foot-guns.
