# Cerebro Stack Migrator — move a Compose stack between Docker hosts

> **Status: P1–P4 BUILT (2026-10-11) — green full build, NOT committed / not live-tested.** New
> module `apps/server/src/stack-migrate/` + shared `app-replicator/ingress-ops.service.ts` +
> web `/migrate` page; Prisma migrations `0036`/`0037`; `DockerApi.exportImage`/`loadImages`.
> P1 cold migrate + host-built image save/load + manual complete/rollback. P2 automated cutover
> (ingress flip via shared IngressOps) + rollback. P3 warm pre-copy (seed repo + move images
> before quiesce → quiesced phase is a fast delta). P4 live-ish (pre-restore warm snapshot to the
> target while the source serves → stop-window is just a delta restore). `warmPrecopy`/`preRestore`
> default on; restic file-level (not block-level). Also built: a **pre-flight readiness checklist**
> in the plan step (source/target SSH, compose readable, `docker compose` on the target, target disk
> vs. data size, repo reachable, arch match, external-volume / host-specific-compose / healthcheck
> warnings — a `fail` blocks Start), **App Replicator re-point** (migrating a replicator-managed stack
> updates its deployment record + ingress routes to the target on cutover instead of orphaning it —
> else a replicator redeploy would resurrect the app on the old host), bind-path + credential-file
> opt-ins, `embed` secret default, and a rollback-staleness warning. Migrations `0036`–`0038`.
> The phase/§ notes below are the original spec.
>
> **Status: DESIGN (2026-10-11).** Buildable spec for a **stack migrator**: move a
> Docker Compose stack from one Docker-host connector to another through Cerebro, data and all.
> The headline: this is **~80% composition of existing features** — `StackRestoreService` already
> restores a snapshot onto an *arbitrary* target host. The genuinely net-new work is (1) an
> **orchestrator** that chains capture → transfer → restore → verify → cutover → teardown with
> progress and rollback, (2) **image transfer for locally-built images** (there is no
> `docker save`/`load` anywhere today — this is required, not deferred), (3) decoupling the
> **ingress** wiring from App Replicator rows, and (4) explicit **rollback** logic.

Builds directly on [[stack-backup]] (`docs/stack-backup.md`), the Docker connector
(`docs/connectors/` + `connectors/docker/`), and the App Replicator (`docs/app-replicator.md`).

---

## 1. What "migrate a stack" means here

Move a running Compose stack from **source host** (a Docker connector instance) to **target host**
(another instance), preserving:
- the **compose definition** + `.env`,
- all **named volume data** (and opt-in **bind-mount** paths),
- **secrets/env** (re-materialized on the target),
- the **images** each service runs — including images **built on the source host** that exist in
  no registry.

**v1 is a *cold* migration** (locked decision, §2): quiesce the source, copy the final volume state,
bring the stack up on the target, health-check, flip ingress, then (optionally) tear the source
down. Cold = a defined downtime window, but it's the only way to move a database volume
*consistently*. "Live-ish" (incremental pre-sync + a short final stop-the-world pass) is a later
phase.

```
PLAN ──▶ PREFLIGHT ──▶ CAPTURE(source) ──▶ TRANSFER ──▶ RESTORE+DEPLOY(target)
 │          │ ports/volumes/images/binds      │ restic repo        │ incl. image pull/build/load
 │          │ arch/resource/ingress checks     │ (+ image save/load) │
 │          ▼                                                        ▼
 │      (abort cleanly, source untouched)                   VERIFY (health gate, sandbox or real)
 │                                                                   │
 └───────────────────────────── CUTOVER ◀───────────────────────────┘
          quiesce source ▶ final volume sync ▶ start target ▶ flip ingress (CF/NPM)
                                   │
                                   ▼
                       TEARDOWN source (opt) / KEEP as rollback
```

---

## 2. Locked decisions

1. **Cold migration is the v1 default.** Source is quiesced (`quiesceStack`) before the *final*
   volume copy so volume state is consistent. Live/incremental is P4.
2. **Transfer rides the existing restic path**: backup source → repo, restore repo → target (two
   restic operations), reusing both `direct` (SSH helper container on the host) and `relay`
   (host → Cerebro → repo) modes already in [[stack-backup]]. No new transport for *volumes*.
3. **Images are handled per-service, three ways, all in v1** (§4): pull from registry → rebuild on
   target from Git context → **`docker save`/`load`** for locally-built images. The save/load path
   is net-new and **required**.
4. **Keep the source by default.** Migration ends with the source stack **stopped but present**, as
   a one-click rollback, until the operator explicitly confirms teardown. No data is destroyed
   implicitly.
5. **Session-only, `backup:restore` + `backup:write`.** Migration reads a source and writes/overwrites
   a target, so it reuses the restore gate (not token-grantable). Optional new `migrate:run` scope.
6. **Target selection is explicit.** The operator picks the destination connector; nothing is tied
   to the snapshot's origin host.

---

## 3. What's reused vs. net-new

| Migration step | Reuses (exists today) | Net-new |
|---|---|---|
| Capture source stack | `StackBackupService.execute()` (direct/relay), `inspectStack()` (labels+inspect — works for unmanaged/foreign stacks), `SecretCaptureService` | — |
| Transfer volumes host→host | restic repo (backup then restore) + relay streaming | — |
| **Transfer images** | — | **`docker save`/`load` (or Engine `GET /images/get` → `POST /images/load`)** |
| Restore to target host | `StackRestoreService.plan/execute` w/ `destInstanceId`, volume rename, `bindMap`, port preflight (`PortAllocatorService`), secret re-materialization (`resolveSnapshotSecrets`: embed/raw/reference) | — |
| Deploy on target | `DockerStackService.deploy()` / `deployGit()` (SSH + `docker compose`) | image-source wiring (pin by digest) |
| Pre-cutover health check | `runVerify()` / `waitHealthy()` sandbox | wire as a gate |
| Cutover (ingress flip) | `IngressService.add()/teardown()` (CF tunnel route / NPM proxy host) | **decouple from `replicatorDeployment` rows** |
| Teardown source | `quiesceStack`, `DockerStackService.down()/remove()/purgeDir()` | orchestration + rollback policy |
| Orchestration & progress | run-row + background `void execute()` + `phase`/`log` pattern; `@Cron` scheduler | **`StackMigrationRun` model + step state machine** |
| Two-host addressing | `hostAccess(ctxSource)` + `hostAccess(ctxTarget)` simultaneously | — |

---

## 4. Image handling (the "built on the host" requirement)

Confirmed in code: **no `docker save`/`load`/export exists anywhere** (`docker-api.ts` has
`buildImage`/`pullImage` but no save/load; `getArchive`/`putArchive` are for *container paths*, not
images). So a stack whose images were built on the source host and pushed to no registry has
**nothing moving the image today**. The migrator classifies each service's image at plan time and
picks a strategy:

**A. Pullable registry image** → the target pulls it.
- Detection: the image ref has a resolvable registry/repo:tag (or digest). Confirm by attempting a
  manifest/pull check on the *target* (so private-registry creds on the target are honored).
- Deploy: `DockerStackService.deploy(..., { pull: true })` (`--pull always`), pinned by digest where
  known so a moving tag can't swap the image mid-migration.

**B. Git-backed build context** → rebuild on the target. ✅ BUILT (opt-in "Rebuild on target").
- Detection (`plan.buildServices`): the compose service has a `build:` context **and** Cerebro knows
  a Git source for the stack — a replicator app's repo (`ReplicatorApp.gitUrl`), or a git-deployed
  `DockerStack` (`source='git'`). `rebuildAvailable` flags the option in the UI.
- Mechanism: `DockerStackService.buildGitImages(target, gitSource, builds)` — a **build-only** step
  (NOT `deployGit`, which would `up` prematurely over the not-yet-restored volumes). It shallow-clones
  the repo into a scratch dir on the target and `docker build -t <ref> -f <dockerfile> <context>` for
  each build service, tagging exactly the refs the restored compose references, so the restore's own
  `docker compose up` finds them locally. Runs in step 1 (source still up — the clone is from Git, not
  the source host, so it adds no downtime); the build-service images are then skipped by
  `ensureImagesOnTarget` (already present) instead of being save/load-copied.
- **This is the cross-arch fix.** A save/load (path C) moves the source's architecture-locked binary;
  rebuilding from source on the target produces a native image. Gated behind the operator's
  `rebuildImages` toggle (defaulted off; the UI recommends it when the arch pre-flight warns). The
  target host must be able to reach the Git repo.
- Requires the compose/build context to come from Git — the migrator's snapshot carries the compose
  text + volumes + secrets, **not** the build context, so a non-Git `build:` stack can't be rebuilt
  (it still falls to path C with the arch warning).

**C. Locally built, not pullable, not Git-backed** → **save/load transfer (net-new, required).**
- Detection: image is present in the *source* host's local image store, resolves to no registry, and
  has no usable build context on the target. This is the "built on the host" case.
- Transfer, mirroring the volume `direct`/`relay` split:
  - **SSH path** (hosts Cerebro reaches over SSH): on the source, `docker save <ref> | gzip` →
    streamed to the target's `docker load`. Brokered by Cerebro (host → Cerebro → host) so no
    host-to-host trust is required.
  - **Engine-API path**: new `DockerApi.exportImage(ref)` (`GET /images/{name}/get`, tar stream) →
    `DockerApi.loadImages(stream)` (`POST /images/load`) on the target.
- **New `DockerApi` methods:** `exportImage(ref): Readable` and `loadImages(tar): Promise<void>`.
  Both must **stream** (images are large) and must be **exempt from the 32 MB response cap** that
  guards monitored-host JSON (same exemption already made for the Remote Browser image build).
- Record each transferred image's **ID/digest** in the migration manifest and reference it in the
  target compose so the loaded image is the one that runs (avoid tag ambiguity).
- **Arch guard:** compare source vs. target `docker info` architecture; refuse (or loudly warn) a
  save/load across architectures (an amd64 image won't run on arm64).
- Keep transfers small: only save/load images that **cannot** be pulled or rebuilt; never sweep the
  whole image store.

Plan output lists, per service, which strategy applies and the estimated transfer size, so the
operator approves before any bytes move.

---

## 5. The migration flow (orchestrator)

A single background worker, modeled on `StackBackupService.startBackup()` / `DeploymentService.runDeployment()`
(Prisma run-row + `void execute()` + `phase`/`log`, UI polls).

1. **Plan** (`MigrateService.plan(input)`) — read-only. Resolve source + target `hostAccess`;
   `inspectStack` the source; classify images (§4); run target **port preflight**
   (`PortAllocatorService`), **volume-name** and **bind-path** checks, **arch** check, resource
   headroom, and ingress presence. Return a plan + conflicts (mirrors `StackRestoreService.plan()`,
   which already surfaces port/secret conflicts).
2. **Preflight gate** — abort cleanly on unresolved conflicts; **source untouched**.
3. **Capture** — `StackBackupService.execute()` against the source into the chosen restic repo
   (volumes + compose + secrets). For cold consistency the *final* capture runs **after** quiesce;
   an optional *warm pre-copy* before quiesce shortens the downtime window (P4).
4. **Image transfer** (§4) for any class-C images.
5. **Restore + deploy** — `StackRestoreService.execute({ destInstanceId, destStackName, mode:'full',
   deploy:true })`: recreate volumes (renamed for the target project), re-materialize secrets, write
   compose, `docker compose up` with the right image strategy per service.
6. **Verify** — `waitHealthy()` gate (optionally a `runVerify()` sandbox first on big migrations).
   Failure here → **rollback** (source still running; tear down the half-built target).
7. **Cutover** — quiesce source → final volume delta sync → start target → **flip ingress**
   (`IngressService`: repoint the CF tunnel route / NPM proxy host from source to target).
8. **Teardown / keep** — leave the source **stopped but present** by default; explicit confirm to
   `down()/remove()/purgeDir()` it.

### Rollback policy (net-new, no framework today)
Rollback is bespoke per step and leans on existing pieces (`quiesceStack`/`Resume`, `waitHealthy`,
`stacks.down()/remove()`):
- Before cutover: any failure just removes the target attempt; **source never touched** → safe.
- At/after cutover: if the target is unhealthy, **re-point ingress back to source**, `Resume` the
  source, remove the target. Because the source is only *stopped* (not removed) until final confirm,
  rollback is "start source + flip ingress back."

---

## 6. Data model

New `StackMigrationRun` (same shape as `StackRestoreRun`, plus step state):
- `sourceInstanceId`, `sourceStackName`, `destInstanceId`, `destStackName`
- `repoTarget` (which restic repo brokered the transfer), `snapshotId`
- `imagePlan` (JSON: per-service strategy pull|build|load + digest + bytes)
- `step` (enum: `planned|capturing|transferring-images|restoring|verifying|cutover|done|failed|rolled_back`),
  `status`, `phase`, `log` (trimmed text, UI polls), `startedAt`/`finishedAt`
- `keepSource` (bool), `ingressFlipped` (bool) — for rollback bookkeeping

Reuses `DockerStack` / `DockerStackRevision` (the migrated stack is stored as a managed stack on the
target, with revisions for ordinary rollback afterward).

---

## 7. Decouple ingress from the replicator

`IngressService.add()/teardown()` drive the Cloudflare / NPM connector operations correctly, but are
written against `replicatorDeployment` / `replicatorIngress` rows (FK `deploymentId`, reads
`dep.ports`/`dep.dockerInstanceId`). Two options:
- **(a)** Lift the op-driving core (`runResourceOperationAwait` + the CF `tunnel-add-route` / NPM
  `create-proxy-host` calls) into a small shared `IngressOps` service that takes
  `{ instanceId, ports, hostname }` directly; both the replicator and the migrator call it. **Preferred.**
- **(b)** Register the migrated stack *as* a replicator deployment so the existing `IngressService`
  applies unchanged. Simpler to build, but conflates "migrated stack" with "replicator-owned
  instance" and drags replicator lifecycle in. Rejected unless (a) proves heavy.

---

## 8. Phased plan

> **All four phases below are BUILT (2026-10-11), green, not yet committed or live-tested.**

**P1 — cold migration, all three image strategies, manual cutover. ✅ BUILT**
`MigrateService` (plan/preflight/capture/transfer/restore/verify) + `StackMigrationRun` + the new
`DockerApi.exportImage`/`loadImages` + image classification. Cutover and teardown are operator-driven
buttons; source kept. UI: a "Migrate" action on a stack in Docker Fleet / the stack detail, a target
picker, the plan/conflict review, live progress.

**P2 — automated cutover + ingress flip + one-click rollback. ✅ BUILT** Decoupled `IngressOps`; the
cutover repoints the hostname (CF `tunnel-edit-route` / NPM `edit-proxy-host`, upsert) to the target
before tearing down the source; rollback flips it back.

**P3 — warm pre-copy. ✅ BUILT** Image transfer + a warm restic capture run before quiesce, so the
quiesced phase is just a fast delta. `warmPrecopy`, default on when quiescing.

**P4 — live-ish migration. ✅ BUILT** The warm snapshot is pre-restored to the target (data-only,
`restoreDataToTarget`) while the source still serves, so the stop-the-world window is just the delta
capture + a fast delta restore over the seeded volumes. `preRestore`, default on with warm pre-copy.
Caveat: restic restore is file-level (not block-level) and `--delete` isn't exposed, so files orphaned
between the warm and delta snapshots aren't removed — fine for append-mostly data, a caveat for churny
stacks. True block-level sync remains future work.

---

## 9. File index (anticipated)

| Concern | File |
|---|---|
| Capture (reused) | `apps/server/src/stack-backup/stack-backup.service.ts`, `stack-inspect.ts`, `secret-capture.ts` |
| Restore to arbitrary host (reused) | `apps/server/src/stack-backup/stack-restore.service.ts` (`plan`/`execute`, `destInstanceId`, `bindMap`, `resolveSnapshotSecrets`) |
| Deploy on target (reused) | `apps/server/src/connectors/docker/docker-stack.service.ts` (`deploy`, `deployGit`, `composeUpFlags`) |
| Port preflight (reused) | `apps/server/src/app-replicator/port-allocator.service.ts` |
| Ingress (decouple) | `apps/server/src/app-replicator/ingress.service.ts` → new shared `ingress-ops` |
| Engine client + **new image save/load** | `apps/server/src/connectors/docker/docker-api.ts` (`exportImage`, `loadImages`) |
| Host access (reused) | `apps/server/src/stack-backup/docker-host.ts` (`hostAccess`), `connectors/docker/docker-ssh.ts`, `docker-hostkey.ts` |
| Quiesce / health (reused) | `apps/server/src/stack-backup/quiesce.ts`, `stack-restore.service.ts` (`waitHealthy`) |
| **New orchestrator** | `apps/server/src/stack-migrate/stack-migrate.service.ts` + controller + module |
| **New model** | `StackMigrationRun` (Prisma migration, next number) |
| Perms | `packages/shared/src/rbac.ts` (reuse `backup:restore`+`backup:write`, or add `migrate:run`) |
| UI | `apps/web/src/pages/DockerFleet.tsx` / stack detail — Migrate action + progress |

---

## 10. Roadblocks & open questions

1. **Locally-built images** — handled (§4), the one true net-new transport; watch the streaming +
   response-cap exemption and the cross-arch guard.
2. **Bind mounts / host paths** — named volumes travel; bind-mount *host paths* are opt-in
   (`includeBinds`) and need `bindMap` remapping on the target (path may not exist there). Surface
   every bind in the plan.
3. **Data consistency** — cold migration (quiesce before final copy) is the safe default; databases
   especially must not be hot-copied. Document the downtime window per migration.
4. **IP / hostname change** — ingress repoint covers external access; **other stacks that reference
   this one by host/IP** are out of scope for v1 (detect and warn).
5. **Ingress coupling** — resolve via the `IngressOps` extraction (§7) before P2.
6. **Registry auth on the target** — pull strategy needs the target's registry creds; reuse the
   connector's existing auth, don't assume anonymous pulls.
7. **Open: new `migrate:run` scope vs. reuse `backup:restore`+`backup:write`?** Leaning reuse for v1
   (keeps it session-only, no new RBAC surface), add a dedicated scope only if migration needs to be
   delegated independently of backup/restore.
8. **Open: repo requirement.** v1 brokers transfer through a restic repo (reusing stack-backup). A
   future direct host→Cerebro→host path (no repo) would avoid needing a configured repo just to
   migrate — deferred.
