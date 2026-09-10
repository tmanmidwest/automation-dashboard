# Full system backup & restore

Back up **all of Cerebro** into one passphrase-encrypted file you can download and restore onto
another machine — a true "move it and go." Admin + session-only; never reachable by an API token.

## What's in a backup

| Piece | Source | Notes |
| --- | --- | --- |
| **Database** | `pg_dump` of the whole Postgres DB | Every table: connectors, the encrypted vault, users, monitors, automations, timeline, OAuth, tokens. |
| **Signal state** | `/data/signal` (signal-cli registration/keys) | So Signal notifications keep working on the new box with no re-linking. |
| **Manifest** | generated | App version, latest applied migration, timestamp, and the source `APP_ENCRYPTION_KEY` (+ its fingerprint). |

Redis sessions and restic caches are **not** backed up — they're ephemeral (users just log in again).

## The encryption-key problem (why the manifest carries the key)

Vault secrets and TOTP seeds are encrypted at rest with `APP_ENCRYPTION_KEY` (an env var). A raw DB
dump is therefore **useless on a machine with a different key**. So:

- The manifest carries the **source key**, and on restore every encrypted field (the whole `Secret`
  vault + each `User.totpSecret`) is **decrypted with the source key and re-encrypted with the
  target machine's own key**. The new box keeps its own `APP_ENCRYPTION_KEY`; secrets still work.
- Because the manifest holds the key, the **entire bundle is encrypted with a passphrase you supply**
  — that passphrase is the only thing protecting it. Choose a strong one and keep it safe; it is not
  stored anywhere and cannot be recovered.

## File format

```
magic "CBROBK" | version(1) | saltLen(1) | salt | ivLen(1) | iv | ciphertext‖GCM-tag
```

- Passphrase → 32-byte key via **scrypt** (N=2^15, r=8, p=1) with a random salt.
- Plaintext = `gzip(JSON({ manifest, database: <sql>, signal: { path: base64 } }))`.
- Encrypted with **AES-256-GCM** (random 12-byte IV; auth tag appended). Tamper/wrong-passphrase → the
  GCM tag fails to verify → restore refuses with a clear "wrong passphrase or corrupt file".

## Endpoints (admin, `settings:write`, `@SessionOnly`)

- `POST /api/system/backup` `{ passphrase }` → streams `cerebro-backup-<ts>.cbak` (attachment).
- `POST /api/system/restore` (multipart: `file` + `passphrase`) → decrypt → validate → load → re-key.
- `GET /api/system/backup/info` → whether pg tools are present, DB size estimate, current version.

## Restore flow & safety

Restore is **destructive** — it replaces the current database. Guardrails:

1. Decrypt with the passphrase (fails cleanly if wrong).
2. **Compatibility check** against the manifest's migration: a backup from a *newer* schema than this
   server's code is **refused** (can't safely downgrade code). Equal or older is allowed — a container
   restart re-runs `prisma migrate deploy` to reconcile.
3. `psql --single-transaction` loads the `pg_dump` (taken with `--clean --if-exists`, so it drops and
   recreates cleanly).
4. **Re-key** the vault + TOTP from the source key to this machine's key (skipped if the keys match).
5. Restore `/data/signal`.
6. All sessions are invalidated and the UI tells you to **restart the container and log back in**
   (the restart also applies any pending migrations).

The UI requires typing **RESTORE** to confirm, and warns that it overwrites everything.

## Image dependency

The runtime image gains **`postgresql-client-16`** (adds `pg_dump` / `psql`) from the official PGDG
apt repo — Debian bookworm's default client is v15, which **refuses to dump the `postgres:16`
server**. One-time rebuild. If the server's Postgres major ever changes, bump the client to match.

## Gotchas handled

- **`DATABASE_URL` query params.** Prisma's URL carries `?schema=public` (and can carry
  `connection_limit`, `pgbouncer`, …), which `pg_dump`/`psql` reject as "invalid URI query
  parameter". The service strips those Prisma-only params before shelling out (keeping libpq-valid
  ones like `sslmode`).
- **Wrong passphrase** decrypts to a GCM failure — surfaced as a clean `400` with a readable
  message, not a `500`.

*Verified end-to-end on a rebuilt test stack (2026-09-09):* backup → delete data → restore brings it
back byte-identical; restoring a backup onto a machine with a **different** `APP_ENCRYPTION_KEY`
re-keys the vault so secrets decrypt under the new key; wrong passphrase → 400.

## Not doing (yet)

- **Scheduled off-site self-backups to Backblaze B2** — planned follow-up, reusing the restic infra;
  v1 is on-demand download only.
- Selective/partial restore, and excluding history tables (heartbeats/logs) to shrink the file.
