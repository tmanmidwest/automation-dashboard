# Stack backup & restore

> **Status: FEATURE-COMPLETE — Phases 1–6 all BUILT (P1 2026-09-26; P2–P6 2026-09-30)** — targets,
> capture, manual and scheduled backups, retention, staleness alerts, run history, snapshot browsing
> and single-file download, the review-then-execute restore wizard with bind remapping and port
> preflight, vault binding discovery with `reference` mode, consistency modes with dump hooks,
> verify-restore, relay transfer for hosts without SSH, and MCP/assistant tools. Nothing here is
> committed or deployed (this repo's edit-only workflow: the user commits, builds, and deploys).

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

**`relay` (built).** For a host with **no SSH** or **no outbound network**: Cerebro pulls the data
through the Engine API and runs restic itself.

The trick that makes this work with nothing installed on the host is that it creates **no container
at all**. Every volume is already mounted by one of the stack's own containers, and
`GET /containers/{id}/archive` streams a path out of a container whether or not it is running — so
a relay backup reads each volume through whatever container already mounts it. A volume nothing
mounts is genuinely unreachable this way and is reported as skipped rather than silently missing.

The stream is extracted straight into a staging tree with `tar --strip-components=1` (Docker wraps
the contents in a directory named after the path's basename), giving exactly the shape a direct
capture produces. Then restic runs locally against the staging root.

**The cost is real and the UI says so:** every byte crosses the network twice and lands on Cerebro's
disk in between. Before staging, the run compares the daemon's own volume accounting against free
space and refuses rather than discovering the problem halfway through a 200 GB copy. Staging is
deleted in a `finally` — a full copy of a stack's data must never be left lying around.

> **Why staging lives at one stable path.** restic records absolute paths, so a per-run staging
> directory would make every snapshot a fresh tree and throw away the dedup that makes incremental
> backups cheap. There is therefore one staging root (`STACK_BACKUP_RELAY_DIR`, default
> `/data/stack-relay`), and relay runs are serialized on it.

Because the paths differ from a direct capture, every snapshot records `capture.root` in its
manifest — `/data` for direct, the staging root for relay — and restore derives its mount
destinations and `--include` patterns from that. Snapshots taken before this defaulted to `/data`,
which is what they were.

**What relay cannot do**, all of which needs a shell on the host and is refused rather than
silently skipped: dump hooks, reading an unmanaged stack's compose file, capturing credential
files, and restoring bind paths. Quiescing still works — it goes through the Engine API.

**Relay restore** reverses it: restic restores into staging on Cerebro, then each volume is pushed
into the host with `PUT /containers/{id}/archive` through a throwaway container created from **an
image the stack itself uses** (read from the snapshot's manifest), so there is still nothing extra
to pull. The container is never started. Writing the compose file and running `docker compose` do
need SSH, so a relay host supports a **data-only** restore — the plan says so rather than failing
halfway.

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

1. **Known** — read from `ReplicatorDeployment.secretVars` / `extraSecretVars` and
   `DockerStack.gitCredKey`. Authoritative, no guessing, no vault reads.
2. **Inferred** — `SecretsService.digestAll()` returns a keyed digest of every vault value (digest →
   the keys holding it); each of the stack's live environment values is digested the same way and
   matched. This is what answers "has our vault been used for this stack?" for stacks Cerebro never
   deployed, with no plaintext compared and nothing leaving `SecretsService`. It deliberately does
   **not** stamp `lastUsedAt` — a scan touching every secret would make them all look freshly used
   and turn the rotation metadata into noise — and it is cached against the vault's own shape (row
   count + newest write) so a per-backup scan costs one aggregate rather than N decryptions.
3. **Declared** — the operator maps a var to a vault key in the stack's secrets view. Doubles as a
   **promote** action: read the live value off the running stack, write it into the vault under
   `stack:<stack>:<var>`, and record the binding. This is the migration path from "a password
   somebody typed into an `.env` on a bare host" to something a restore can re-materialize.

Precedence is deliberate: **declared** (the operator's word) outranks **replicator** (what Cerebro
actually stored), which outranks **inferred** (strong evidence, but the same value could legitimately
appear in two places).

Stored as `StackSecretBinding(connectorInstanceId, stackName, varName, vaultKey?, origin,
valueDigest, secretish, lastSeenAt)`. The digest is what later detects *the vault value changed since
this snapshot*, and the table doubles as the vault's reverse index.

### What the snapshot stores — `secretMode`

- **`reference`** — `.env` captured with bound vars replaced by `${vault:<key>}` (non-secret-looking
  values stay literal), plus `secrets.json` mapping var → key → digest. **No secret value is written
  anywhere.** Restore resolves from the live vault. Only offered when every credential-looking var
  is bound *and* none are written literally inside the compose file; the policy form disables it
  otherwise and says which variables are in the way.
- **`embed`** (Phase 1, default) — values included but sealed in `secrets.sealed` under an operator
  passphrase via the existing `system-backup/bundle.ts` scrypt+AES-256-GCM container. Survives total
  loss of Cerebro, and whoever holds the restic repo key still does not get the credentials.
- **`raw`** (Phase 1, opt-in) — `.env` verbatim, protected only by restic's own encryption.

`embed` remains the default: it is the only mode that works with no prior setup and still survives
losing Cerebro. `reference` is the strongest option once a stack's credentials are actually in the
vault — nothing secret reaches the repository at all — at the cost of needing this Cerebro's vault
back before the stack can be restored.

### Credentials that aren't in the `.env`

Two cases would otherwise slip past whatever `secretMode` promised:

- **Literal values inside the compose file** (`- DB_PASSWORD=hunter2`). The compose is captured in
  every mode, so in `embed`/`reference` these are lifted out into the sealed payload and replaced
  with a marker, then substituted back verbatim on restore. The scan is a conservative line pass —
  the same pragmatic approach the App Replicator's compose introspector takes — touching only
  credential-looking names with a literal value, never a `${VAR}` interpolation. A false positive is
  harmless because the exact original text is restored. `reference` mode refuses outright, since a
  vault reference has nothing to point at.
- **Credentials in host files** — compose `secrets:`/`configs:` with a `file:` source, and the
  `*_FILE` convention. These usually live outside the stack's volumes, so Phase 5 reads them into
  the **sealed/raw payload** (never in the clear, and never over 256 KB — anything bigger is not a
  credential). A compose `file:` path is read on the host; a `*_FILE` path is a *container* path, so
  it is read through `docker exec` in whichever container declares it. `reference` mode does not
  capture them, having nowhere to put them. Writing them back on restore is **not** automatic — the
  restore plan says which files the snapshot holds and that they need restoring by hand; automatic
  write-back belongs with Phase 6's path remapping, since it means writing arbitrary host paths.

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

## Consistency (Phase 5 — built)

Per-policy `quiesce` mode, because a hot tar of a live Postgres or SQLite volume is not a backup:

| Mode | Behaviour |
|---|---|
| `hot` | no interruption; the policy form says plainly that it is not crash-consistent |
| `pause` | freeze the project's running containers for the capture window |
| `stop` | stop them for the capture, start them again afterwards |

**Ordering.** Compose creates a stack's dependencies first, so container creation time approximates
dependency order: quiescing goes newest-first (dependents before what they depend on) and resuming
goes in reverse. Only containers that were actually running are touched, and only those are brought
back.

**The window is as small as it can be.** Inspecting, resolving the compose, capturing secrets and
staging metadata all happen *before* quiescing, so a `stop` policy's downtime is the restic run and
nothing else.

**Resuming is guaranteed and idempotent.** The resume runs in a `finally` around the helper, so a
failed or timed-out backup never leaves a stack paused or stopped — that outcome is far worse than
the failed backup. If quiescing itself fails partway, whatever was already stopped is started again
before the error propagates, rather than capturing a half-frozen stack.

### Dump hooks

`preHooks` / `postHooks` are `{service | container, cmd, captureTo?}`, run via `docker exec … sh -c`
so redirects and pipes work the way an operator expects when they write:

```
pg_dump -U postgres app > /var/lib/postgresql/data/cerebro-dump.sql
```

That is the recommended shape: redirect into a path inside a volume that is already being captured,
and the dump rides along with no size limit and no buffering. `captureTo` additionally saves the
command's **stdout** into the snapshot's meta directory, capped at 8 MB — fine for a config dump,
wrong for a database.

A failing **pre**-hook fails the backup: the whole point is that the snapshot contains the dump, and
a snapshot missing its dump is a backup that looks fine and isn't. A failing **post**-hook only
warns — by then the data is already captured. Pre-hooks run before quiescing, so a dump has a live
database to talk to.

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

**Bind remapping and port preflight (Phase 6).** Each captured bind path gets an editable
destination, so a stack whose data lives at `/srv/appdata` on one host restores to `/opt/data` on
another; the plan says whether each destination already exists. Published host ports are read out of
the snapshot's manifest and checked against the destination with the App Replicator's own
`PortAllocatorService.usedPorts` — one definition of "what is taken on this host", not two. A clash
is a warning rather than a hard stop, because when restoring in place over a stopped stack the port
is "in use" only because the old container still holds the binding.

**Credential-file write-back (Phase 6).** Opt-in, and only for files that came from a real *host*
path (a compose `secrets: file:` source). A `*_FILE` path was read from inside a container, so the
same path on the host means something else entirely — those stay listed as "restore by hand".

**Single-file download (Phase 6).** `restic dump` of one path out of a snapshot, straight to the
browser from the snapshot browser. This is the everyday case — "I need yesterday's config" — which
does not warrant restoring a whole volume. Capped at 16 MB, since it is buffered through the server,
and gated on `backup:restore` because it hands back stack data.

## Verify restore (Phase 6 — built)

Every other signal in this feature tells you a backup was **written**. This is the only one that
tells you it can be **read back into a working stack**.

A verify brings the snapshot up under a throwaway name (`<stack>-verify-<snapshot>`), waits for it
to report healthy, and removes it along with everything it created.

**The sandbox publishes no host ports.** The original design said "offset the ports", but stripping
them is strictly better: each `ports:` entry is rewritten to its container side only, which in
Compose means "publish on a random free host port". Nothing can collide with the real stack, there
is no offset to choose or get wrong, and the healthchecks that actually answer the question run
inside the container anyway. Volumes are renamed onto the sandbox project by the same
rename-aware machinery a normal copy-restore uses, so the trial never touches the real data.

**Healthy means healthy twice.** Every container must be running, and every container that declares
a healthcheck must report `healthy` — on two consecutive polls, so a stack that comes up and
immediately crash-loops is not counted as a pass. A container that exited cleanly (a migration or
init job) counts as fine rather than as a failure.

**Teardown is guarded and unconditional.** `assertSandbox` refuses to tear down anything whose name
does not end in `-verify-<id>`, only volumes prefixed with the sandbox's own project name are
removed, and the cleanup runs even when the trial itself throws — a failed verify must not leave a
second copy of the data lying around. `keep: true` skips it deliberately when you want to poke at
the result.

## Scheduling and retention (Phase 4 — built)

Structured dropdowns, never cron. The semantics now live in `common/backup-schedule.ts` — `isDue`,
`describeSchedule`, `nextRunAt`, `intervalMs` — shared with the Backblaze connector so "weekly on
Sunday at 04:00" means the same thing in both places.

`StackBackupScheduler` runs three deliberately separate cadences:

| Cadence | Job |
|---|---|
| every minute | fire due policies |
| 02:30 nightly | apply retention, then prune |
| hourly | notice backups that have silently stopped |

**The minute tick** is guarded three ways: an in-memory minute slot (one tick cannot double-fire), a
durable "did a run for this policy already start this minute" check against `StackBackupRun` so a
redeploy mid-minute does not re-run, and a per-repository busy set. That last one matters because
concurrent backups into one restic repo spend their time fighting over the repository lock instead
of moving data — a deferred stack is logged and picked up on its next slot.

**Retention** runs `forget` per policy and `prune` once per repository. Per policy, so each stack
keeps its own N snapshots rather than N shared across every stack; and split, because `forget` is
metadata-only while `prune` is the expensive, lock-taking part. Both use the **full** credential —
hosts only ever hold the append-only one.

> **A trap worth recording:** retention filters with `--tag policy:<id>` and keeps restic's default
> `--group-by host,paths`. Grouping by *tags* would be wrong — every snapshot carries a unique
> `run:<id>` tag, so each would land in its own group and nothing would ever be forgotten. (Renaming
> a Docker connector instance changes the restic `--host` and so splits a policy's history into two
> groups, each keeping N until the older group ages out.)

**Nothing is deleted unless retention is configured.** A target with every keep-field blank never
forgets anything — accumulating snapshots is a cost problem, deleting the wrong ones is a data
problem.

**Staleness.** A backup that silently stops is worse than one that fails loudly: nothing alerts, and
the gap is discovered only when it is needed. The hourly sweep raises `backup.stale` when a policy's
last success is older than 2.5× its own interval, so a daily backup is chased after two and a half
days while a monthly one is not, with no extra threshold to configure. Deduped per policy per day.

### Scheduling a sealed backup

A sealed backup needs a passphrase, and a scheduler has nobody to ask. So a policy can hold a
**stored sealing passphrase** in the vault (`stack-backup:policy:<id>:passphrase`), and arming a
schedule on an `embed` policy without one is refused rather than left to fail every night at 03:00.

This is an honest trade and the UI says so at the point of entry: with the passphrase in the vault,
a sealed backup is only as recoverable-without-Cerebro as the operator's own copy of it. What it
still buys is that the restic repository alone never yields credentials. A manual run reuses the
stored passphrase rather than asking again for something Cerebro already holds.

Not built: the periodic `restic check --read-data-subset` integrity pass. It downloads repository
metadata (and a sample of data) on every run, which is a real egress cost against B2, and the P6
verify-restore is the stronger check of the same property.

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

Phase 2 (migration `0033_stack_secret_bindings`) adds `StackSecretBinding` (above). Phase 3
(migration `0032_stack_restore`) adds:

```
StackRestoreRun     id, snapshotId, targetId, sourceStackName, destInstanceId, destStackName,
                    mode, status, message, volumes, binds, deployed, durationMs, log, timestamps
```

Append-only on purpose: a restore overwrites data, so the record of what went where should outlive
the policy and even the destination host. The Backblaze connector's existing `BackupRun` table is
left alone — it means something different.

Repository credentials live in the vault, never in these rows:
`stack-backup:<targetId>:password` (the restic repo password) and
`stack-backup:<targetId>:provider` (JSON — `{keyId, appKey}` for B2, `{accessKeyId, secretAccessKey}`
for S3), with `…:provider-host` for the append-only key handed to hosts.

## Integration points

- **Timeline** — `StackBackupRun` and `StackRestoreRun` are unioned into the existing `job` kind
  (alongside the connector-level `BackupRun`), so Ship's Log shows them with no new event kind
- **Notifications** — reuses the existing `backup.failure` / `backup.success` / `restore.failure` /
  `restore.success` / `retention.failure` alert types, plus a new `backup.stale`. Dispatch happens in
  the single place every run ends, so a scheduled run and a manual one notify identically
- **Automations** — trigger `stack.backup.failed`; action `backup stack now` / `restore stack`
- **Monitors** — an optional `backup-age` probe type
- **Tool catalog** (`tools/tool-catalog.service.ts`) — `list_stack_backups`,
  `list_stack_backup_runs`, `list_stack_snapshots`, `list_stack_backup_targets`, `get_stack_secrets`
  (read); `backup_stack_now` and `verify_stack_backup` (confirm-gated actions, passphrases redacted
  from the audit trail); `plan_stack_restore` (a dry run, so it is a read). Executing a restore is
  deliberately **not** a tool — it overwrites data and belongs behind the wizard's review step
- **Vault UI** — `/settings/secrets` shows "used by N stacks" per key from the binding map, and
  deleting a referenced key warns which stacks reference it. That matters most for `reference`-mode
  snapshots, which rebuild their `.env` *from* the vault: delete the key and those snapshots stop
  being restorable

## Full-disaster ordering

Worth stating because it is the thing people get wrong: **system backup first, stack backups
second.** `docs/system-backup.md` restores Cerebro and its vault (re-keying to the target's
`APP_ENCRYPTION_KEY`); stack backups then restore the stacks, and `reference` mode resolves because
the vault came back first. `embed` mode is the escape hatch for when that ordering cannot hold.

## Phases

| Phase | Scope | Status |
|---|---|---|
| **P1** | Targets + vault creds + repo probe/init; SSH helper runner; manual backup (`hot`, named volumes + compose + manifest, `raw`/`embed` secrets, known bindings); runs + log; `/backups` screen | **BUILT** |
| **P2** | Binding discovery (inferred via keyed digests + declared), `StackSecretBinding`, `reference` mode, promote-to-vault, compose-literal redaction, vault reverse index | **BUILT** |
| **P3** | Snapshot listing + browsing, restore plan/execute (any host, rename-aware), per-volume and per-bind selection, secret resolution, restore history | **BUILT** |
| **P4** | Scheduling (minute tick, restart-safe, per-repo serialized), per-policy retention + nightly prune, stored sealing passphrase, staleness alerts, timeline + notification wiring | **BUILT** |
| **P5** | Quiesce (`pause`/`stop`) with guaranteed resume, pre/post dump hooks, exclude patterns UI, file-based credential capture, `relay` transfer (backup + restore) | **BUILT** |
| **P6** | Bind remapping + port preflight on restore, verify-restore sandbox, single-file download, credential-file write-back, MCP/assistant tools | **BUILT** |

## Known sharp edges

- **Socket-proxy-only hosts** have no SSH, so the helper cannot run there — they need `relay`
  transfer, which the policy form selects for them automatically and cannot be switched away from.
- **Relay needs staging space on Cerebro** equal to the stack's data. It checks first, but the
  daemon's volume accounting is an estimate and bind mounts are not counted at all.
- **Relay restore is data-only.** Writing compose and running `docker compose` need a shell; a host
  with no SSH can have its volumes restored but not its configuration.
- **Foreign stacks with a missing compose file** — `config_files` can point at a path that no longer
  exists. The manifest is captured regardless, and a degraded "reconstruct compose from inspect"
  path is Phase 3 work.
- **`.env` restores as plaintext** on the destination host. The repo is encrypted; the host is not.
- **Volume plugin drivers** (NFS/CIFS) tar fine, but a restore must recreate them with the same
  driver options — hence capturing `Driver` + `Options` in the manifest.
- **Helper image availability** — `restic/restic` must be pullable on each host. The tag is
  configurable per target so it can point at a local registry, and it should be pinned in production.
- **Repo locking** — concurrent backups to one repository are serialized per target. A killed run can
  leave a stale lock, which surfaces as a `retention.failure` alert telling the operator to run
  `restic unlock`; automatic unlocking is deliberately not done, since a "stale" lock may be a live
  run on another machine.
- **Single-process scheduling.** The minute tick assumes one Cerebro instance. Running replicas would
  need the lock moved into Postgres or Redis (both already in the stack).
- **`stop` mode restarts containers, it does not re-run compose.** Ordering is inferred from
  creation time, which matches compose's own creation order in practice but is not the same as
  reading `depends_on`. A stack whose services cannot tolerate a brief out-of-order start relies on
  its restart policy to settle.
- **Hooks run as whatever the container runs as.** `docker exec` inherits the image's user, so a
  `pg_dump` hook needs a user that can read the database — the same constraint as running it by hand.
- **Inline flow-mapping ports survive a sandbox.** `unpublishPorts` handles the string form and the
  long block form, but `- {target: 80, published: 8080}` on one line is left alone, so a verify of a
  stack written that way can still collide. Rare enough to be a known limit rather than a parser.
- **Verify needs the stack to be self-contained.** A sandbox with no published ports cannot be
  reached from outside, and a stack that depends on an external network or a fixed host port will
  not come up healthy in one. That is a true negative about restorability in isolation, but worth
  knowing before reading it as a broken backup.
- **restic exit 3** means the snapshot was written but some source files could not be read (a
  permission-denied corner of a bind mount, a socket). That is recorded as a success with a warning
  in the run message, not as a failure — throwing away a snapshot that exists would be worse.
- **Long silent runs** — with `RESTIC_PROGRESS_FPS=0` a large backup writes nothing for minutes at a
  time, so `docker-ssh.ts` sends SSH keepalives; without them an idle NAT or `ClientAliveInterval`
  kills the channel and the backup dies half-done.
- **Swarm/compose `secrets:` and `configs:`**, and the `*_FILE` convention, point at files on the
  host that are themselves credentials. They are detected and reported but **not captured** —
  reading arbitrary host paths is Phase 5 work.
- **Inference is evidence, not proof.** A digest match means the stack's value equals a vault value;
  if the same password legitimately sits under two keys, the first is picked. An operator can always
  override with a declared binding, which outranks it.
- **Bind paths restore to the path they were captured from.** Restoring a stack whose binds live
  under a path that does not exist (or means something else) on the destination host needs the
  remapping Phase 6 adds; until then the plan shows the exact paths and each one is opt-in.
- **`container_name:` survives a rename.** It is global to the host, so a renamed copy collides with
  the original if both run there. The plan warns when the compose file pins it.
