# Backblaze B2 Backup connector

Sync Proxmox `vzdump` backups between your **NAS dump folder** and a **Backblaze B2**
bucket, and pull them back when you need to restore. The connector talks to exactly
two things — the B2 bucket and a local (mounted) filesystem path. It **never contacts
Proxmox**. Proxmox keeps making its own backups to the NAS; Cerebro just moves those
files to/from B2, and Proxmox restores them natively from the same dump folder.

```
  ┌───────────┐   vzdump (weekly)   ┌──────────────┐   mounted into    ┌──────────┐   S3 API   ┌─────────────┐
  │  Proxmox  │ ──────────────────▶ │  UNAS Pro    │ ◀───────────────▶ │ Cerebro  │ ─────────▶ │ Backblaze   │
  │  (PVE)    │   writes .vma.zst   │  dump/ share │   as /mnt/dump    │ container│  push/pull │ B2 bucket   │
  └───────────┘                     └──────────────┘                   └──────────┘            └─────────────┘
        ▲                                                                                              │
        └──────────────────────────  restore: pull lands back in dump/, restore via PVE UI  ──────────┘
```

> **Feature-complete.** The connector gives you **visibility** (what's in B2, what's
> staged on the NAS, what hasn't been uploaded), a `Test` that verifies **B2, the mount,
> and the schedule**, the two transfer actions **Upload pending to B2** (push) and
> **Restore to NAS** (pull), a **Bucket browser with manual delete**, and **automatic
> scheduled sync** with a durable **Sync history**.

---

## Prerequisites

- A Backblaze account with a **private B2 bucket** for your Proxmox backups.
- Your **UNAS Pro** exposing the Proxmox `dump` folder over **SMB** (this is almost
  certainly how Proxmox already mounts it — confirm in **Datacenter → Storage**).
- Access to the **Cerebro stack** in Portainer (or wherever you run `docker compose`)
  so you can add a volume mount.

---

## Step 1 — Backblaze B2

1. **Bucket.** In Backblaze → **B2 Cloud Storage → Buckets**, use your existing backup
   bucket (or create one, **Private**). Note its name, e.g. `proxmox-backups`.
2. **Endpoint.** On the bucket's page, copy the **Endpoint**, e.g.
   `s3.us-west-004.backblazeb2.com`. In Cerebro you enter it with the scheme:
   `https://s3.us-west-004.backblazeb2.com`. The region (`us-west-004`) is read from it
   automatically.
3. **Application key.** Go to **Account → Application Keys → Add a New Application Key**:
   - **Name:** `cerebro`
   - **Allow access to Bucket(s):** restrict to your backup bucket only.
   - **Capabilities:** at minimum `listBuckets`, `listFiles`, `readFiles`. Add
     `writeFiles` and `deleteFiles` now if you want it ready for the Phase 2 upload.
   - Click **Create** and **copy both values immediately** — the `keyID` and the
     `applicationKey` (the secret is shown only once).

> Use a **bucket-scoped** key, not your master key. If you ever rotate it, just paste
> the new `applicationKey` into the connector's edit form.

---

## Step 2 — UNAS Pro share

You need a user the container can use to mount the SMB share holding the `dump` folder.

1. In the **UNAS Pro** UI, find the shared folder Proxmox writes backups to (the one
   whose `dump/` subfolder holds the `vzdump-*.vma.zst` files).
2. Create (or reuse) a **service user**, e.g. `cerebro-backup`, and grant it
   **read/write** on that share. (Read-only is enough for Phase 1 viewing, but you'll
   want read/write for uploads and restores.)
3. Note the UNAS Pro **IP address**, the **share name**, and this user's credentials.

> **Match Proxmox.** Whatever server/share path Proxmox uses for this storage
> (**Datacenter → Storage → your NAS entry**), mount the *same* share into Cerebro so
> both see identical files. If Proxmox points at `//10.0.0.20/backups` and restores land
> in `dump/`, mount `//10.0.0.20/backups` and point Cerebro's dump path at its `dump/`
> subfolder.

---

## Step 3 — Mount the share into the Cerebro container

This is the one piece of host-side setup. The Cerebro container can't see the NAS until
you give it a volume. The container process runs as **root**, so a straightforward CIFS
mount with default ownership works.

### Portainer / docker-compose

Add a named CIFS volume and mount it into the `app` service. In your Cerebro stack:

```yaml
services:
  app:
    # ...existing config...
    volumes:
      - dump:/mnt/dump          # ← add this line to the app service

volumes:
  cerebro_db:
  cerebro_redis:
  dump:                          # ← add this volume definition
    driver: local
    driver_opts:
      type: cifs
      device: "//10.0.0.20/backups"        # UNAS Pro IP + share name
      o: "username=cerebro-backup,password=CHANGE_ME,vers=3.0,uid=0,gid=0,file_mode=0664,dir_mode=0775,nobrl"
```

Notes on the options:

- `vers=3.0` — UNAS Pro speaks SMB3. If the mount fails, try `vers=3.1.1` or `vers=2.1`.
- `uid=0,gid=0` — the container runs as root, so files are owned by root inside it.
- `file_mode`/`dir_mode` — make mounted files writable so uploads/restores can work.
- `nobrl` — avoids byte-range-lock errors some SMB servers throw on large files.
- Keep the password out of the file where you can: in Portainer set it via a stack
  environment variable and reference it, or use a Docker secret.

Redeploy the stack. Then confirm the container can see the backups:

```bash
docker exec cerebro-app ls -la /mnt/dump
```

You should see the `vzdump-*.vma.zst` files (and their `.log` / `.notes` sidecars). If
your share's root contains a `dump/` subfolder rather than the backups directly, either
mount the subfolder (`device: "//10.0.0.20/backups/dump"`) **or** set the connector's
**Local dump path** to `/mnt/dump/dump`.

### Host-mount alternative

If you'd rather mount on the Docker host (e.g. via `/etc/fstab`) and bind it in, that
works too — replace the volume block with a bind mount:

```yaml
    volumes:
      - /mnt/nas-backups:/mnt/dump
```

...and mount `//10.0.0.20/backups` at `/mnt/nas-backups` on the host with your usual
`cifs` fstab entry.

---

## Step 4 — Add the connector in Cerebro

1. **Connectors → Add connector → Backblaze B2 Backups.**
2. Fill in:
   | Field | Value |
   |---|---|
   | Application Key ID | the B2 `keyID` from Step 1 |
   | Application Key | the B2 `applicationKey` (stored encrypted, never shown again) |
   | S3 Endpoint | `https://s3.us-west-004.backblazeb2.com` |
   | Bucket | `proxmox-backups` |
   | Key prefix | optional — e.g. `dump/` if your backups live under a folder in the bucket |
   | Local dump path | `/mnt/dump` (the mount target from Step 3) |
   | Sync schedule | optional cron for automatic sync, e.g. `0 4 * * 0` (Sundays 4am). Blank = manual only. |
3. Click **Test**. A healthy result looks like:
   `B2: OK — 12 backups (48.3 GB) in "proxmox-backups". Mount: OK — 12 backups staged, read/write.`
   (with the schedule's next run time shown in the details when one is set).
   - **B2 FAILED** → check the keyID/applicationKey, endpoint, and the key's bucket scope.
   - **Mount FAILED / READ-ONLY** → the share isn't mounted, the path is wrong, or the
     SMB user lacks write. See [Troubleshooting](#troubleshooting).

---

## Using it

Open the connector to see four tabs:

- **Backups in B2** — every `vzdump` archive in the bucket, parsed into guest (VM/CT),
  VMID, size, and when it was taken. Click a row for full details (B2 key, ETag, etc.).
- **Local dump (NAS)** — what's staged in the dump folder, each flagged **synced** (also
  in B2) or **pending** (not uploaded yet).
- **Bucket browser** — a raw list of *every* object under the prefix (archives plus
  `.log`/`.notes` sidecars and anything else), grouped by folder, for manual pruning.
- **Buckets** — the buckets this key can see (your configured one is marked active).

The dashboard also gets tiles: backups in B2, total B2 size, staged on NAS, and — when
any exist — a **Pending upload** count, so you can tell at a glance whether your latest
backups have made it off-site.

### Upload backups off-site (push)

On the **Local dump (NAS)** tab, click **Upload pending to B2**. It uploads every local
archive that isn't already in the bucket, with live progress. It is **additive** — it
never deletes or overwrites anything in B2. Tick **Preview only** first to see exactly
what would be uploaded without transferring anything. Each upload is verified by size
before it counts as done. (Needs `writeFiles` on the B2 key.)

### Restore a backup (pull)

On the **Backups in B2** tab, click **Restore to NAS**, pick the backup, and Cerebro
downloads it into the dump folder. The download goes to a temp file and is size-verified
before being atomically renamed into place, so Proxmox never sees a half-written file. By
default it won't overwrite a file that already exists locally — tick **Overwrite** to
replace it. Once it lands, open the storage in the **Proxmox UI → Backups**, select the
file, and **Restore**.

> Uploads/restores run as background jobs tracked in-memory (single-instance). If the
> Cerebro container restarts mid-transfer the progress record is lost; just re-run the
> action — uploads skip what's already in B2, and a restore's temp file is cleaned up.
> Durable run history arrives with the scheduler in Phase 4.

### Browse & delete objects

The **Bucket browser** tab lists every object in the bucket (under the prefix), not just
parsed backups — so you can see and remove old archives, orphaned `.log`/`.notes`
sidecars, or anything else. Open an object and use **Delete** (you confirm by typing the
filename). You can also delete a single archive directly from the **Backups in B2** tab —
note that deletes the archive only, not its sidecars, which is why the browser exists.

Deletion is **manual and explicit** — the automatic scheduler will never delete anything.
It needs `deleteFiles` on the B2 application key. On a bucket with lifecycle rules that
keep prior versions, B2 applies its own retention to the deleted object.

### Automatic scheduled sync & history

Set a cron in the connector's **Sync schedule** field and Cerebro runs the push (upload
pending → B2) automatically on that cadence — no Proxmox-side script needed. Examples:

| Cron | When |
|---|---|
| `0 4 * * 0` | Sundays at 04:00 |
| `0 3 * * *` | every day at 03:00 |
| `30 2 * * 1-5` | weekdays at 02:30 |

Runs are recorded in the **Sync history** tab (status, trigger, start, duration, and the
result message), newest first — durable across restarts. The scheduler:

- checks every minute and fires when a cron slot is due;
- **never overlaps** a run for the same connector (a long sync just delays the next);
- is **restart-safe** — it won't re-fire a slot it already recorded;
- only ever **uploads** — it never deletes or overwrites, same as the manual push.

> **Once this is working, remove your Proxmox-side Backblaze upload script** so the two
> don't both push. Proxmox keeps *making* the backups on its own schedule; Cerebro now
> owns getting them off-site. If a scheduled run fails (mount down, B2 unreachable), it's
> logged as an **error** run in the history and retried on the next scheduled slot.

An invalid cron expression is ignored (automatic sync stays off) and flagged by the
**Test** button and in the logs — the manual actions keep working regardless.

---

## Disaster recovery — "I lost Proxmox"

1. Rebuild Proxmox and re-add the NAS backup storage (**Datacenter → Storage**), or any
   directory storage with **Backup** content enabled, pointing at the same dump folder.
2. In Cerebro, open the Backblaze connector → **Backups in B2** → **Restore to NAS**, and
   pull the backup(s) you need into the dump folder.
3. In the Proxmox UI, open that storage → **Backups**, select the file → **Restore**.

> **DR caveat.** If Cerebro itself runs on the infrastructure that failed, it can't help
> until it's back up. Keep the B2 `keyID`/`applicationKey` (and this runbook) somewhere
> independent of that box. As a Cerebro-independent fallback you can always pull straight
> onto a node with rclone/the B2 CLI into that storage's `dump/` directory, e.g.:
> ```bash
> rclone copy b2:proxmox-backups/vzdump-qemu-100-2026_08_31-03_00_00.vma.zst \
>   /mnt/pve/nas-backups/dump/
> ```

---

## Possible future enhancements

- Sync `.log`/`.notes` sidecars alongside archives (today only the archive itself is
  pushed/pulled — sufficient for a restore).
- Per-schedule retention (auto-prune B2 beyond N copies) — deliberately omitted for now;
  use a **B2 lifecycle rule** instead so automatic deletion is governed by Backblaze.
- Direct-to-Proxmox restore (stream a pull into a live node) — the current dump-folder
  approach is simpler and more robust for large files.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Mount test says **READ-ONLY** | SMB user lacks write on the share, or `file_mode`/`dir_mode` too restrictive. Grant read/write in UNAS Pro; keep `file_mode=0664,dir_mode=0775`. |
| `does not exist inside the container` | Volume not mounted or wrong path. `docker exec cerebro-app ls /mnt/dump` and check the compose volume + redeploy. |
| `No permission to read` | uid/gid mismatch. Container runs as root — use `uid=0,gid=0` in the mount options. |
| Mount fails at deploy | Try a different `vers=` (3.1.1 / 3.0 / 2.1); confirm the UNAS Pro IP/share and that SMB is enabled. |
| B2 test: *keyID not recognized* | Wrong `keyID`, or you pasted the key **name** instead of the ID. |
| B2 test: *Access denied* | The application key isn't scoped to this bucket, or lacks `listFiles`/`readFiles`. |
| B2 test: *bucket does not exist* | Bucket name typo, or the key can't see it (scope). |
| No backups listed but files exist | Backups may be under a bucket folder — set **Key prefix** (e.g. `dump/`); or the dump path points above the actual files — set it to the `dump/` subfolder. |
| Large-file SMB errors | Add `nobrl` to the mount options. |
| Delete fails: *Access denied* | The B2 application key lacks `deleteFiles`. Recreate the key with that capability. |
| Deleted file still shows in B2 | The bucket keeps prior versions (lifecycle). Delete hides the current version; adjust the bucket's lifecycle rules to hard-delete. |
