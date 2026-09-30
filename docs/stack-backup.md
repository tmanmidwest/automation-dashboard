# Stack backup & restore

> **Status: Phases 1 and 3 BUILT (P1 2026-09-26, P3 2026-09-30)** — targets, capture, manual backup,
> run history, snapshot browsing, and the review-then-execute restore wizard. P3 pulled snapshot
> listing/browsing forward from P2, since a restore cannot be driven without it. Phases 2, 4, 5 and 6
> are designed below and not yet built. Nothing here is committed or deployed (this repo's edit-only
> workflow: the user commits, builds, and deploys).

Back up a **Compose stack** — its data, its config, and everything needed to stand it up again —
from any Docker host Cerebro knows about, and restore it to the same host or a different one.
Fills the gap left by VM-level backup: several of the user's Docker hosts are bare metal with no
hypervisor snapshot underneath them, and even on the VMs a whole-VM restore is the wrong
granularity for "this one stack broke".

This is a **feature module** (`apps/server/src/stack-backup/`), not a connector. It consumes the
Docker connector the way `docker-fleet` and `app-replicator` do, because a backup is inherently
cross-host: the whole point is that a snapshot taken from host A restores onto host B.

```
                    ┌──────────────────────────── Cerebro ────────────────────────────┐
                    │  StackBackupPolicy ──▶ capture plan ──▶ run + log ──▶ timeline   │
                    │        │                    │                                   │
   Engine API ◀─────┼────────┘ (inspect the project: containers, volumes, mounts)      │
   SSH        ◀─────┼──────────────────┐ (write meta, run the helper, prune/forget)    │
                    └──────────────────┼────────────────────────────────────────────────┘
                                       │
   ┌───────────────── Docker host ─────▼──────────────────┐
   │  docker run --rm restic/restic backup /data          │        ┌──────────────┐
   │    -v stackvol_db:/data/volumes/stackvol_db:ro       │───────▶│ restic repo  │
   │    -v /srv/appdata:/data/binds/srv-appdata:ro        │  direct│  (B2 / S3)   │
   │    -v /var/tmp/cerebro-bk-<run>:/data/meta:ro        │        └──────────────┘
   └──────────────────────────────────────────────────────┘
```

## Why restic

The storage engine is [restic](https://restic.net), already vendored into the server image for the
Backblaze connector (`docs/connectors/backblaze-backup.md`). It gives us encryption at rest,
deduplication **across snapshots, stacks and hosts**, incremental transfer, file-level restore, and
retention — none of which is worth hand-rolling on top of tarballs.

One repository holds every stack backup, with snapshots distinguished by tags:

| Tag | Meaning |
|---|---|
| `cerebro` | written by Cerebro (shared with the Backblaze connector's convention) |
| `type:stack` | a stack backup (vs. a VM/dump backup) |
| `host:<connectorInstanceId>` | which Docker host it came from |
| `stack:<project>` | the compose project name |
| `policy:<id>` | the policy that produced it — retention filters on this |
| `run:<id>` | the `StackBackupRun` row, so a snapshot links back to its log |

Layout inside a snapshot:

```
/data/meta/manifest.json         every container/volume/network in the project, env VALUES stripped
/data/meta/compose.yaml          the compose file
/data/meta/secrets.json          the secret inventory: names + keyed digests + known vault bindings
/data/meta/secrets.sealed.b64    secretMode=embed — values sealed under the operator's passphrase
/data/meta/stack.env.redacted    secretMode=embed — the .env's shape, with values replaced
/data/meta/stack.env             secretMode=raw — the .env verbatim
/data/meta/secrets.raw.json      secretMode=raw — resolved container environment
/data/volumes/<name>/…           one directory per named volume
/data/binds/<slug>/…             one directory per included bind-mount host path
/data/dumps/<service>.…          pre-hook output (Phase 5)
```

`manifest.json` never carries an environment **value**, in any mode — only the variable
names. Container environment is resolved credentials as often as not, and duplicating it into an
unsealed file would quietly undo whatever the policy's `secretMode` was set up to achieve.

## What gets captured

For compose project `foo` on host H:

| Piece | Source |
|---|---|
| `manifest.json` | Engine API inspect of everything labelled `com.docker.compose.project=foo` — image refs **with digests**, ports, mounts, restart policies, networks, volume driver options, labels |
| `compose.yaml` + `.env` | the `DockerStack` row when Cerebro manages the stack; otherwise read over SSH from the path in the `com.docker.compose.project.config_files` label |
| Named volumes | every volume mounted by a project container, tarred through the helper |
| Bind mounts | opt-in **per path** — a media library bind must not be swept in by accident |
| DB dumps | Phase 5 pre-hooks (`pg_dump`, `mysqldump`, `sqlite3 .backup`) |

Bind mounts are opt-in rather than opt-out on purpose: the failure mode of silently backing up a
4 TB Jellyfin library is much worse than the failure mode of an operator ticking a box.

## How the data moves

Two transfer modes. Both are **agentless** — nothing is installed on the Docker hosts.

**`direct` (default, built in Phase 1).** Cerebro runs a short-lived `restic/restic` container on
the target host with every project volume and included bind path mounted **read-only** under
`/data`, plus a metadata directory it wrote over SSH. That container runs `restic backup /data`
straight to the repository. Bulk data never crosses Cerebro; dedup and incrementals work properly
because restic sees a stable directory tree from run to run.

The container is launched over SSH (`docker run --rm …`) rather than through the Engine API. SSH is
already required for stack deploys and host telemetry, it gives a single round-trip with a real
exit code and combined output for the run log, and it avoids managing a container lifecycle by
hand. Phase 5 adds an Engine-API launcher for hosts that have a socket-proxy but no SSH.

**Credentials never appear in `argv`.** The env file is streamed over the SSH channel into a
`mktemp` file created under `umask 077`, passed as `--env-file`, and removed in the same command
whatever the exit code. They are still visible via `docker inspect` on that host while the
container runs — unavoidable for any host-side execution, and mitigated by the credential split
below.

**`relay` (Phase 5).** For a host with no outbound internet or no registry access: the helper
container is created but not started, and Cerebro pulls `GET /containers/{id}/archive?path=/data`
as a tar stream into staging on its own volume, then runs restic locally. Needs a `requestStream`
helper on `docker-api.ts`, which today only does buffered JSON and NDJSON.

### Credential split

Hosts get an **append-only** repository key; Cerebro keeps the full key and is the only thing that
runs `forget --prune`. A compromised Docker host can then add snapshots but cannot delete backup
history — which is exactly the property you want when the reason you are restoring is that the host
was compromised. Prune is expensive and locks the repo anyway, so it belongs on a nightly
maintenance tick rather than on every run.

## Secrets — the hard part

A stack's secrets arrive by three different routes, and they need different handling:

| Route | Where the truth lives | Restore implication |
|---|---|---|
| Replicator deployment | vault, `deployment:<id>:<NAME>`; named in `ReplicatorDeployment.secretVars` / `extraSecretVars`; rendered into `.env` by `buildEnvMap` at deploy time | Cerebro can re-materialize — the binding is authoritative |
| Git stack | `DockerStack.gitCredKey` → vault `kind='git'` | not runtime env, but without it a redeploy cannot clone |
| Hand-rolled / foreign stack | plaintext in the host's `.env` or inline in compose | Cerebro **cannot** re-materialize; a vault-reference backup of this stack would be unrestorable |

That last row is the trap. A design that only references the vault silently produces useless
backups for exactly the bare-host stacks this feature exists to protect.

### Discovering which vault keys a stack uses

Three sources, merged into one binding map per stack:

1. **Known** (Phase 1) — read from `ReplicatorDeployment.secretVars` / `extraSecretVars` and
   `DockerStack.gitCredKey`. Authoritative, no guessing, no vault reads.
2. **Inferred** (Phase 2) — derive an HMAC subkey from `APP_ENCRYPTION_KEY`, HMAC every vault value
   once, HMAC every value in the stack's `.env` / compose environment / `*_FILE` targets, and match
   digests. This is what answers "has our vault been used for this stack?" for stacks Cerebro never
   deployed, without comparing plaintext or letting a value out of `SecretsService`. It needs a
   `digestAll()` read path that does **not** stamp `lastUsedAt`, otherwise every backup run marks
   every secret as used and the rotation metadata becomes noise.
3. **Declared** (Phase 2) — the operator maps a var to a vault key in the UI. Doubles as a
   **promote** action: write the plaintext into the vault, record the binding, and render that line
   from the vault on the next deploy. This is the migration path from "foreign stack" to "Cerebro
   knows its secrets".

Stored as `StackSecretBinding(connectorInstanceId, stackName, varName, vaultKey?, origin, valueHash,
lastSeenAt)`. The `valueHash` is what later detects *the vault value changed since this snapshot*.

### What the snapshot stores — `secretMode`

- **`reference`** (Phase 2) — `.env` captured with bound vars replaced by `${vault:<key>}`, plus
  `secrets.json` mapping var → key → hash. Restore resolves from the live vault. Only offered when
  **every** secret var has a binding; otherwise the UI blocks it and offers to promote the unbound
  ones first.
- **`embed`** (Phase 1, default) — values included but sealed in `secrets.sealed` under an operator
  passphrase via the existing `system-backup/bundle.ts` scrypt+AES-256-GCM container. Survives total
  loss of Cerebro, and whoever holds the restic repo key still does not get the credentials.
- **`raw`** (Phase 1, opt-in) — `.env` verbatim, protected only by restic's own encryption.

Defaults: `reference` for Cerebro-managed and replicator stacks once Phase 2 lands; `embed` for
everything else. Embedding is an audited action requiring `secrets:read` — it is a deliberate export
of credentials.

### Restore-time resolution (Phase 3)

The restore wizard resolves every secret var before writing anything:

- **resolved** — vault key present, hash matches the snapshot
- **drifted** — key present, value changed since the backup. Surfaced loudly, because restoring a
  database *volume* whose internal password is the old one alongside an `.env` carrying the new one
  produces a stack that comes up broken in a confusing way. Defaults to the snapshot's value when
  the volumes are being restored too.
- **missing** — prompt for it inline, with the option to write it into the vault as part of the restore
- **sealed** — needs the `embed` passphrase

Cross-host restore of a replicator deployment re-registers values under the **new**
`deployment:<id>:<NAME>` namespace and renders `.env` through the existing `buildEnvMap`, so the
restored stack is a first-class replicator deployment rather than an orphan.

## Consistency (Phase 5)

Per-policy `quiesce` mode, because a hot tar of a live Postgres or SQLite volume is not a backup:

| Mode | Behaviour |
|---|---|
| `hot` | no interruption; flagged in the UI as not crash-consistent (Phase 1 ships only this) |
| `pause` | `docker pause` the project's containers for the capture window |
| `stop` | `compose stop` → capture → `compose start`, with a downtime estimate from the last run |

Plus `preHooks` / `postHooks` — `{service, cmd[], captureTo}` exec'd in-container so a dump lands in
the capture set and the volumes can stay `hot`.

## Restore (Phase 3 — built)

A wizard, not a button — restore is the half that gets skipped and then does not work when needed.

1. **Snapshot** — list a repository's stack snapshots (tags decoded back into host/stack/policy/run)
   and walk the tree one level at a time with `restic ls --recursive=false`, so an operator can see
   the data really is in there before trusting it.
2. **Destination** — any Docker connector instance, so restoring to a different host is the same
   code path as restoring in place.
3. **Plan** — recomputed server-side whenever the destination changes, and it writes nothing. It
   reports every volume with where it would land and whether that already exists, the bind paths
   (opt-in, unticked), the secret resolution, plus conflicts and warnings.
4. **Execute** — create the volumes → run the helper with them mounted **rw** → restore the data →
   write the configuration through `DockerStackService` → optionally `docker compose up -d`.

**The mount trick that makes renaming work.** The helper mounts each *destination* volume at the
path the snapshot *stored* it under (`-v newproj_db:/data/volumes/oldproj_db`), so `restic restore
--target /` writes straight into it with no path rewriting. Renaming then falls out for free — and it
has to, because compose derives a volume's name from the project: restoring `oldproj_db` and
deploying a stack called `newproj` would leave the copy pointing at freshly created empty volumes
while the restored data sat in the old names. The plan renames any volume carrying the source
project's prefix and warns about the ones it cannot (external or anonymous volumes keep their name
and are therefore shared with the original).

**Hard stops vs. warnings.** A **running** stack under the destination name is a conflict — writing
into the volumes of a live database is how a restore corrupts the thing it was meant to rescue. A
*stopped* stack of that name, or an existing volume, is a warning plus an explicit
"restore anyway, overwriting what is already there" checkbox.

**Secrets come from the snapshot, not the vault.** The restored volumes hold whatever state those
values produced, so pairing them with a newer rotated credential is how a restore "succeeds" into a
stack that cannot start. Drift is surfaced in the plan (per variable: matches the vault / changed
since / key is gone / sealed / stored in the clear) rather than silently resolved.

**Restoring without starting.** A `full` restore can write the configuration and stop there —
`DockerStackService.store()` adopts the compose as a Cerebro-managed stack with a first revision but
touches no host — so a recovered stack can be reviewed before it comes up and starts talking to the
network. Ticking "bring the stack up" goes through the normal `deploy()` path instead.

Still to come: single-*file* restore, and **verify restore** — restore into a sandbox stack name with
offset ports, health-check it, tear it down. That is what turns a backup from a hope into a fact.

## Scheduling (Phase 4)

Structured dropdowns, not cron — the same `schedule-util.ts` shape the Backblaze connector uses
(frequency / day-of-week / day-of-month / hour / minute). A `StackBackupScheduler` with
`@Cron(EVERY_MINUTE)` walks the policy rows, serialized per target repository (restic locks),
overlap-guarded in memory, and restart-safe via a "has a run started this minute" check against
`StackBackupRun`. A separate nightly maintenance tick per target runs `forget --prune` with the full
key, plus a periodic `check --read-data-subset`.

## Data model

Phase 1 (migration `0031_stack_backup`):

```
StackBackupTarget   id, name, kind(b2|s3), repository, passwordKey, credKey,
                    hostCredKey?, keepLast/keepDaily/keepWeekly/keepMonthly/keepWithinDays,
                    helperImage, lastCheckedAt, lastStatus, lastMessage

StackBackupPolicy   id, connectorInstanceId, stackName, targetId, enabled,
                    frequency/dayOfWeek/dayOfMonth/hour/minute,
                    quiesce, transfer, secretMode, includeBinds[], excludes[],
                    lastRunAt, lastStatus, lastMessage      @@unique([connectorInstanceId, stackName])

StackBackupRun      id, policyId, connectorInstanceId, stackName, targetId, trigger, status,
                    snapshotId, bytesAdded, bytesTotal, filesNew, filesTotal, volumes, binds,
                    durationMs, message, log, startedAt, finishedAt
```

Phase 3 (migration `0032_stack_restore`) adds:

```
StackRestoreRun     id, snapshotId, targetId, sourceStackName, destInstanceId, destStackName,
                    mode, status, message, volumes, binds, deployed, durationMs, log, timestamps
```

Append-only on purpose: a restore overwrites data, so the record of what went where should outlive
the policy and even the destination host. Phase 2 adds `StackSecretBinding`. The Backblaze
connector's existing `BackupRun` table is left alone — it means something different.

Repository credentials live in the vault, never in these rows:
`stack-backup:<targetId>:password` (the restic repo password) and
`stack-backup:<targetId>:provider` (JSON — `{keyId, appKey}` for B2, `{accessKeyId, secretAccessKey}`
for S3), with `…:provider-host` for the append-only key handed to hosts.

## Integration points

- **Timeline** — `backup.stack.started|succeeded|failed`, `restore.stack.*` on the `TimelineBus`,
  so Ship's Log picks them up for free
- **Notifications** — failure alerts, plus a "no successful backup in N days" staleness alert
- **Automations** — trigger `stack.backup.failed`; action `backup stack now` / `restore stack`
- **Monitors** — an optional `backup-age` probe type
- **Tool catalog** (`tools/tool-catalog.service.ts`) — `list_stack_backups`, `backup_stack_now`,
  `list_snapshots`, `restore_stack` (confirm-gated), so The Computer and MCP get it
- **Vault UI** — a reverse index from the binding map: "used by `foo` on ubuportainer02", and a
  warning before deleting a key three stacks depend on

## Full-disaster ordering

Worth stating because it is the thing people get wrong: **system backup first, stack backups
second.** `docs/system-backup.md` restores Cerebro and its vault (re-keying to the target's
`APP_ENCRYPTION_KEY`); stack backups then restore the stacks, and `reference` mode resolves because
the vault came back first. `embed` mode is the escape hatch for when that ordering cannot hold.

## Phases

| Phase | Scope | Status |
|---|---|---|
| **P1** | Targets + vault creds + repo probe/init; SSH helper runner; manual backup (`hot`, named volumes + compose + manifest, `raw`/`embed` secrets, known bindings); runs + log; `/backups` screen | **BUILT** |
| **P2** | Binding discovery (inferred + declared), `StackSecretBinding`, `reference` mode, snapshot browser, promote-to-vault | planned |
| **P3** | Snapshot listing + browsing, restore plan/execute (any host, rename-aware), per-volume and per-bind selection, secret resolution, restore history | **BUILT** |
| **P4** | Scheduling, retention, nightly prune/check, timeline + notification wiring | planned |
| **P5** | Quiesce modes, pre/post hooks, bind include/exclude UI, `relay` transfer, Engine-API launcher | planned |
| **P6** | Bind-path remapping + port preflight on restore, verify-restore sandbox, single-file restore, MCP tools | planned |

## Known sharp edges

- **Socket-proxy-only hosts** have no SSH, so Phase 1's helper cannot run there. The policy form
  refuses them with a clear message; Phase 5's Engine-API launcher is the fix.
- **Foreign stacks with a missing compose file** — `config_files` can point at a path that no longer
  exists. The manifest is captured regardless, and a degraded "reconstruct compose from inspect"
  path is Phase 3 work.
- **`.env` restores as plaintext** on the destination host. The repo is encrypted; the host is not.
- **Volume plugin drivers** (NFS/CIFS) tar fine, but a restore must recreate them with the same
  driver options — hence capturing `Driver` + `Options` in the manifest.
- **Helper image availability** — `restic/restic` must be pullable on each host. The tag is
  configurable per target so it can point at a local registry, and it should be pinned in production.
- **Repo locking** — concurrent backups to one repository are serialized per target. A killed run can
  leave a stale lock; `restic unlock` runs from Cerebro before a retry.
- **restic exit 3** means the snapshot was written but some source files could not be read (a
  permission-denied corner of a bind mount, a socket). That is recorded as a success with a warning
  in the run message, not as a failure — throwing away a snapshot that exists would be worse.
- **Long silent runs** — with `RESTIC_PROGRESS_FPS=0` a large backup writes nothing for minutes at a
  time, so `docker-ssh.ts` sends SSH keepalives; without them an idle NAT or `ClientAliveInterval`
  kills the channel and the backup dies half-done.
- **Swarm/compose `secrets:` and `configs:`**, and the `*_FILE` convention, point at files on the
  host that are themselves credentials. They need the same three-mode treatment (Phase 2).
- **Bind paths restore to the path they were captured from.** Restoring a stack whose binds live
  under a path that does not exist (or means something else) on the destination host needs the
  remapping Phase 6 adds; until then the plan shows the exact paths and each one is opt-in.
- **`container_name:` survives a rename.** It is global to the host, so a renamed copy collides with
  the original if both run there. The plan warns when the compose file pins it.
