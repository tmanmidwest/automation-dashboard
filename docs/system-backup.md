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

## Migrating to a new server — checklist

Moving a live Cerebro to a new Docker host is **take a backup → stand up the new host → restore →
repoint DNS**. The bundle carries the whole DB (connectors, the encrypted vault incl. the Fabric SSH
CA + host-key pins, users/TOTP, monitors, automations, agents and their `credHash`) plus
`/data/signal`. Everything below is the stuff that lives *outside* the bundle and so needs a human.

**Pre-flight (old host)**
- [ ] Confirm the app image has the Postgres 16 client: `docker compose exec app pg_dump --version` → `16.x`.
- [ ] Confirm the running build actually contains the backup feature (and any other not-yet-committed work you depend on).
- [ ] Note the exact **public hostname** agents dial (`CEREBRO_URL`). Keep it identical across the move — that's what lets Fabric agents reconnect without re-enrollment.
- [ ] Take the backup (below) and store the `.cbak` **and its passphrase** safely. The passphrase is unrecoverable and is the only thing protecting the file (it embeds the source `APP_ENCRYPTION_KEY`).

**New host**
- [ ] Same-or-newer Cerebro version than the backup (restore refuses a *newer* schema than the code; equal/older is fine). Build the `app` image from the same `Dockerfile` (so it includes `postgresql-client-16` + signal-cli).
- [ ] Provide `docker-compose.yml` + `.env` / `docker-compose.override.yml` (none of this is in the bundle). Set a strong `APP_ENCRYPTION_KEY` — a **new** key is fine; restore re-keys the vault + TOTP to it.
- [ ] Build the Remote Browser image (`cerebro-remote-browser:latest`) — or let it auto-build on first use if the Docker socket is mounted.
- [ ] Bring the stack up and let it run `prisma migrate deploy` (automatic on container start).

**Restore**
- [ ] Complete the **first-run setup** screen to create a throwaway admin (the fresh DB has no users; you need an admin session to reach restore). This account is replaced by your real users after restore.
- [ ] Settings → System Backup → **Restore**, upload the `.cbak`, enter the passphrase, type `RESTORE`.
- [ ] **Restart the app container** (applies any pending migrations + picks up the re-keyed vault), then log in again with your **original** credentials.

**Cut over & verify**
- [ ] Repoint Cloudflare (DNS / tunnel) at the new host — hostname unchanged.
- [ ] Verify: Fabric agents show **online** again; a vault secret reveals; Signal notification sends; a monitor runs; Backblaze/stack-backup connectors still read their (remote) restic repos.

**Accept the known losses** (outside DB + `/data/signal`): Fabric/RDP **session recordings** (`/recordings` volume) and restic **caches** do not travel. Redis sessions are gone (just re-login). To carry recordings over, copy the volume by hand (step 6 of the runbook).

## Step-by-step runbook (exact commands)

Placeholders are in `<ANGLE_BRACKETS>`. Commands assume Docker Compose v2 and that you run them from
the repo root on the host in question. Service names follow `docker-compose.yml` (`app`, `db`).

### 0. Pre-flight (OLD host, still serving)

```bash
# the app image can actually dump a PG16 server
docker compose exec app pg_dump --version      # expect: pg_dump (PostgreSQL) 16.x

# sanity: pg tools present, DB size, current version (admin session cookie required)
# easier: just read it in the UI at Settings → System Backup
```

### 1. Take the backup (OLD host — via the UI, the supported path)

The backup/restore endpoints are **admin + session-only** (never an API token), so do this in a
logged-in browser — there is no clean headless/curl path.

1. Log in as an admin.
2. Go to **Settings → System Backup** (`/settings/backup`).
3. Enter a **strong passphrase (≥ 16 characters)**; confirm it.
4. Click **Download backup** → saves `cerebro-backup-<timestamp>.cbak`.
5. Put the `.cbak` somewhere safe and record the passphrase in your password manager. **Both are required to restore; neither can be recovered.**

### 2. Prepare the NEW host

```bash
# get the code (same or newer version than the backup)
git clone <YOUR_REPO_URL> cerebro && cd cerebro

# create the env file and set host-specific values
cp .env.example .env

# generate a fresh app encryption key (a NEW key is fine — restore re-keys to it)
openssl rand -base64 32
# → paste into .env as APP_ENCRYPTION_KEY=...  (must be ≥16 chars, or the app refuses to boot)
```

Edit `.env` / `docker-compose.override.yml` and set at least:
- `APP_ENCRYPTION_KEY` (from above)
- `DATABASE_URL` (point at the `db` service)
- `CEREBRO_URL` = the **same public hostname** agents already use
- Fabric / Remote Browser host vars as needed: `FABRIC_GUACD_CALLBACK_HOST`, `REMOTE_BROWSER_NETWORK`, `REMOTE_BROWSER_CALLBACK_HOST`, `FABRIC_RECORDING_DIR`, `SIGNAL_CLI_DATA_DIR`, `STACK_BACKUP_RELAY_DIR`

```bash
# build the Remote Browser image (or skip — it auto-builds on first use when docker.sock is mounted)
docker build -t cerebro-remote-browser:latest docker/remote-browser

# build + start the stack; migrations run automatically on app start
docker compose up -d --build

# confirm the app image has the PG16 client (restore shells out to psql)
docker compose exec app pg_dump --version      # expect 16.x
docker compose logs -f app                      # watch for "migrate deploy" + clean boot
```

### 3. Restore (NEW host)

1. Open the new site in a browser. You'll get the **first-run setup** screen (the DB is empty) — create a **temporary admin** (any email/password). This login is discarded after restore.
2. Go to **Settings → System Backup → Restore**.
3. Upload the `.cbak`, enter its **passphrase**, type **RESTORE** to confirm, submit.
4. Wait for the success message (it will tell you to restart and log back in).

```bash
# apply the restored schema's migrations + pick up the re-keyed vault
docker compose restart app
```

5. Log in again with your **original** (pre-migration) admin credentials. The temporary admin is gone.

### 4. Repoint Cloudflare

- Update the DNS record (or Cloudflare Tunnel origin) for your `CEREBRO_URL` hostname to the new host's IP. Keep the **hostname identical** — Fabric agents dial the hostname and reconnect on their own.

### 5. Verify

- [ ] `/fabric` — agents return to **online** within a minute or two.
- [ ] `/settings/secrets` — reveal a secret (proves the vault re-keyed correctly).
- [ ] Trigger a **Signal** test notification (proves `/data/signal` restored).
- [ ] A **monitor** runs and reports; **automations** list is intact.
- [ ] Backblaze / stack-backup connectors still browse their restic repos (they're remote; creds came from the vault).
- [ ] Log in as a normal user with **TOTP** (proves TOTP seeds re-keyed).

### 6. (Optional) carry over Fabric session recordings

Recordings are **not** in the backup. If you need the old videos:

```bash
# OLD host — export the recordings volume to a tarball
docker run --rm -v cerebro_fabric_recordings:/from -v "$PWD":/to alpine \
  tar czf /to/fabric-recordings.tgz -C /from .

# copy fabric-recordings.tgz to the NEW host, then import into the new volume
docker run --rm -v cerebro_fabric_recordings:/to -v "$PWD":/from alpine \
  tar xzf /from/fabric-recordings.tgz -C /to
```

> The named volume may be prefixed by your compose project name (e.g. `cerebro_fabric_recordings`).
> Check with `docker volume ls` and adjust the volume name in the commands above.

## Not doing (yet)

- **Scheduled off-site self-backups to Backblaze B2** — planned follow-up, reusing the restic infra;
  v1 is on-demand download only.
- Selective/partial restore, and excluding history tables (heartbeats/logs) to shrink the file.
