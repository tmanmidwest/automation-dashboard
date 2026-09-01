# Backblaze B2 Backup connector (restic)

Cerebro **owns off-siting** your Proxmox `vzdump` backups to a Backblaze B2 **restic**
repository. It backs up the **NAS dump folder** to B2 on a schedule you pick (frequency +
day + time — no cron), prunes old backups by age, lets you browse snapshots, and restores
a chosen backup back into the dump folder — from which Proxmox restores it natively.

Proxmox still *creates* the vzdump files on the NAS; Cerebro handles getting them to B2 and
back. (The old Proxmox-side restic→B2 job has been retired — Cerebro is the writer now.)

```
  ┌───────────┐  vzdump   ┌──────────────┐  restic backup   ┌─────────────┐
  │  Proxmox  │ ─────────▶│ UNAS Pro     │◀───────┐         │ Backblaze   │
  │           │  writes   │ dump/ (mount)│        │         │ B2 (restic  │
  └───────────┘           └──────┬───────┘   ┌────┴─────┐   │  repository)│
        ▲                        │           │ Cerebro  │──▶│             │
        │            restic dump │           │ (restic) │◀──│  (backup +  │
        │            restore ◀───┘           └──────────┘   │   prune)    │
        └──────  restore the file via the Proxmox UI  ◀──   └─────────────┘
```

## Why restic changes things

Restic doesn't store your `vzdump-*.vma.zst` files in B2 as-is — it stores them as
**encrypted, deduplicated chunks**. So the bucket can't be browsed as files; the only way
to read backups is *through restic*, using the **repository password**. That's why this
connector needs the restic password (read-only) in addition to a B2 key.

---

## Prerequisites

- Your Proxmox backups already going to a B2 restic repo (you have `RESTIC_REPOSITORY`
  and its password in `/root/backup-configs/b2-credentials.env`).
- Access to the Cerebro stack on your Docker host to add the NAS mount.

---

## Step 1 — Credentials (read-only)

1. **B2 key (read + write).** In Backblaze → **Account → Application Keys → Add a New
   Application Key**, scoped to your backup bucket, with **`listFiles`, `readFiles`,
   `writeFiles`** (add **`deleteFiles`** if you'll use retention). Copy the `keyID` and
   `applicationKey`. *(Cerebro is the backup writer now, so it needs write; delete is only
   for pruning old snapshots.)*
2. **Dedicated restic password (recommended).** On the Proxmox host, add a separate repo
   key for Cerebro so it's independently revocable:
   ```bash
   source /root/backup-configs/b2-credentials.env
   restic key add          # prompts for a new password — use a fresh one for Cerebro
   ```
   (You can also just reuse the existing `RESTIC_PASSWORD`, but a dedicated key is cleaner.)
3. Note your **repository string** (e.g. `b2:trevor-homelab-offsite:/`) from that same env
   file.

---

## Step 2 — Mount the NAS dump folder into the Cerebro container

Restored backups are written to the NAS `dump/` folder so Proxmox can see them, so the
container needs that share mounted. On the Docker host install the CIFS helper once:

```bash
sudo apt update && sudo apt install -y cifs-utils
```

Add a CIFS volume to your `docker-compose.yml`. On the `app` service:

```yaml
    volumes:
      - dump:/mnt/dump
```

At the bottom, alongside the other volumes:

```yaml
  dump:
    driver: local
    driver_opts:
      type: cifs
      device: "//${NAS_HOST}/${NAS_SHARE}"
      o: "username=${NAS_USER},password=${NAS_PASS},vers=3.0,uid=0,gid=0,file_mode=0664,dir_mode=0775,nobrl"
```

And in `.env`:

```dotenv
NAS_HOST=192.168.10.216      # UNAS Pro IP
NAS_SHARE=Backups            # SMB share name
NAS_USER=cerebro-backup      # UNAS user with read/write
NAS_PASS=your-smb-password
```

Bring it up and verify the container sees the dump folder:

```bash
docker compose up -d
```
```bash
docker exec cerebro-app ls -la /mnt/dump
```

If your backups are in a `dump/` subfolder of the share, either point `NAS_SHARE` at it or
set the connector's **Local dump path** to `/mnt/dump/dump`.

> The container runs as root, so `uid=0,gid=0` is correct. If the mount fails, try
> `vers=3.1.1` or `vers=2.1`. Avoid a **comma** in the SMB password (it breaks the option
> string).

---

## Step 3 — Add the connector

**Connectors → Add connector → Backblaze B2 Backups**, then:

| Field | Value |
|---|---|
| B2 Application Key ID | the read+write B2 `keyID` |
| B2 Application Key | the B2 `applicationKey` (stored encrypted) |
| Restic repository | e.g. `b2:trevor-homelab-offsite:/` |
| Restic repository password | the dedicated (or existing) repo password (stored encrypted) |
| Local dump path | `/mnt/dump` |
| Automatic backup | Off / Daily / Weekly / Monthly |
| Day of week / Day of month | used for Weekly / Monthly |
| Time — hour / minute | when the backup runs (server time) |
| Delete backups older than (days) | retention; blank/0 = keep everything |

Click **Test**. A healthy result looks like:
`Repo: OK — 14 snapshots, latest yesterday. Mount: OK — read/write. Backup: Weekly on Sunday at 04:00 (server time).`

- **Repo FAILED** → check the B2 key, repository string, and restic password.
- **Mount FAILED / READ-ONLY** → the share isn't mounted or the user lacks write
  (see [Troubleshooting](#troubleshooting)).

Both secrets are stored **encrypted at rest** (AES-256-GCM) and are never shown back in the
UI.

---

## Using it

### Automatic backups

Pick a **frequency** (Daily / Weekly / Monthly), the **day** (for weekly/monthly), and a
**time** — all dropdowns, no cron. Cerebro backs up the dump folder to B2 on that schedule
and, if you set **Delete backups older than (days)**, prunes snapshots older than that
afterward (the latest is always kept). The **Test** result shows the schedule in plain
language. Times are the **container's local time** — set a `TZ` env on the app service
(e.g. `TZ=America/Chicago`) if you want a specific zone.

Click **Back up now** (on the Snapshots tab) to run the same backup immediately. Every
backup — scheduled or manual — is logged in **Restore history** (status, when, duration,
what happened), durable across restarts.

### Browse, restore & delete

- **Snapshots** tab — every restic snapshot (date, host, age), newest first. Each snapshot
  is a point-in-time backup of the *whole* dump folder, so it contains **all your VMs at
  once** (that's why a row is a date + id, not a single VM).
- **Click a snapshot** to open its drawer: it shows **Backups: N**, **Total size**, and the
  list of VM/CT archives inside (each labelled `VM 100 · 12.3 GB · date`). VM label is the
  **VMID + type** from the filename — not the friendly VM name, which isn't stored in the
  backup file.
- On a backup, click **Restore to NAS** → Cerebro streams it (via `restic dump`) into the
  dump folder, with live progress, verified against the expected size and written
  atomically (temp file → rename) so Proxmox never sees a half-written file. Tick
  **Overwrite** to replace an existing local copy.
- **Delete a snapshot** — open it and use **Delete** (confirm by typing its id). This runs
  `restic forget`; the space is reclaimed on the next retention prune / scheduled backup.
- **Restore history** tab — a durable record of every backup and restore (status, when,
  duration), surviving restarts.

Then, in Proxmox: open that storage → **Backups**, select the file → **Restore**.

---

## Disaster recovery — "I lost Proxmox"

1. Rebuild Proxmox and re-add the NAS backup storage (**Datacenter → Storage**) pointing at
   the same dump folder.
2. In Cerebro → Backblaze connector → **Snapshots** → open the latest → **Restore to NAS**
   for each VM you need.
3. In the Proxmox UI, restore each from that storage's **Backups**.

> Cerebro runs on your Docker host (not on Proxmox), so losing Proxmox doesn't take Cerebro
> with it. The only thing a restore needs is the NAS (the landing spot) being up.
>
> **Cerebro-independent fallback:** any Linux box with restic + the repo password can pull
> a file directly:
> ```bash
> export B2_ACCOUNT_ID=... B2_ACCOUNT_KEY=... RESTIC_PASSWORD=...
> export RESTIC_REPOSITORY=b2:trevor-homelab-offsite:/
> restic dump latest /mnt/pve/Backups/dump/vzdump-qemu-100-….vma.zst > ./vzdump-qemu-100.vma.zst
> ```

---

## Security

- Cerebro now **owns backups**, so it uses a **read + write** B2 key (plus delete for
  retention). That's a deliberate step up from read-only — it can write and prune the repo.
- Both the B2 key and the restic password are stored **encrypted** (AES-256-GCM) in
  Cerebro's vault and never shown back in the UI. Worst case (full host compromise incl.
  `APP_ENCRYPTION_KEY`) an attacker could read, write, or delete backups — so keep
  `APP_ENCRYPTION_KEY` strong and out of the repo (`.env`, `chmod 600`), and use a
  **dedicated restic key + dedicated B2 key** so both are revocable independently.
- Because Cerebro can now prune, retention deletes are real deletions in B2 (subject to any
  bucket lifecycle/versioning you have).

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Repo test: *could not decrypt* | Wrong restic repository password. |
| Repo test: *no repository found* | Wrong repository string or bucket. |
| Repo test: *Backblaze rejected credentials* | Wrong B2 keyID/applicationKey, or key not scoped to the bucket. |
| Repo test: *restic binary not installed* | Rebuild the Cerebro image (restic is bundled via the Dockerfile). |
| Mount says **READ-ONLY** | SMB user lacks write, or `file_mode`/`dir_mode` too strict. Use `file_mode=0664,dir_mode=0775`. |
| `does not exist inside the container` | Volume not mounted / wrong path. `docker exec cerebro-app ls /mnt/dump`, fix the compose volume, redeploy. |
| Mount fails at deploy | Try a different `vers=` (3.1.1 / 3.0 / 2.1); confirm the UNAS IP/share and SMB enabled. |
| No backups under a snapshot | The snapshot may not contain the dump path, or filenames aren't `vzdump-*`. Open a newer snapshot. |
| Large-file SMB errors | Add `nobrl` to the mount options. |

---

## Notes

- Cerebro now **schedules the backups and prunes** the B2 repo (you retired the Proxmox
  systemd job). Proxmox still *creates* the vzdump files on the NAS on its own schedule;
  Cerebro backs those up to B2 and restores them back.
- Backups run in the **container's local time** — set `TZ` on the app service for a specific
  timezone.
- The restore writes the single backup file flat into the dump folder (via `restic dump`),
  not restic's full path tree — so it lands exactly where Proxmox expects it.
