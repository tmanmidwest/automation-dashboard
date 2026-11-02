# Proxmox VE connector

View and manage the VMs and LXC containers on a Proxmox VE server or cluster: power actions,
create wizards, cloud-init templates, snapshots, migration, backups, hardware edits, and a browser
console. Connector `v1.0.0`, in live use against the lab cluster.

Code: `apps/server/src/connectors/proxmox/` (`proxmox-api.ts` client, `proxmox.connector.ts`
manifest + implementation).

## Connecting

| Field | Secret | Notes |
| --- | --- | --- |
| `baseUrl` | no | Web UI URL with port, e.g. `https://proxmox.example.com:8006` |
| `tokenId` | no | `user@realm!tokenname`, e.g. `cerebro@pve!dashboard` |
| `tokenSecret` | yes | Shown once when the API token is created |
| `verifyTls` | no | Default **off** (Proxmox ships a self-signed cert) |

Create the token under Datacenter → Permissions → API Tokens. With a non-root token, give it the
privileges for what you want Cerebro to do (VM.PowerMgmt, VM.Allocate, VM.Snapshot, VM.Migrate,
VM.Backup, Datastore.AllocateSpace, and so on). For **Build template from image**, enable the
"Import" content type on the staging storage (Datacenter → Storage → Edit → Content).

## Resource kinds

| Kind | Actions | Notes |
| --- | --- | --- |
| `qemu` (VMs) | start, shutdown, reboot, suspend, resume, reset, force stop | Snapshots sub-collection (rollback, delete). Browser console. Delete. |
| `lxc` (containers) | start, shutdown, reboot, force stop | Snapshots sub-collection. Browser console. Delete. |
| `template` | — | VM templates, used by **Deploy from template**. Delete. |

Actions only appear for the states they apply to (for example, Start only on a stopped guest).

## Operations

| Operation | Scope | What it does |
| --- | --- | --- |
| Deploy from template | create | Full-clones a cloud-init template into a new VM: name/ID, node, storage, disk size, cores/memory, bridge + VLAN, cloud-init user/password/SSH keys, optional `cicustom` snippet, DHCP or static IP |
| Create VM | create | New VM booting from an ISO (OS type, BIOS, disk, CPU/RAM, bridge/VLAN) |
| Create container | create | New LXC from a CT template (rootfs, CPU/RAM/swap, root password/SSH key, network, unprivileged) |
| Build template from image | create | Downloads a cloud image (`.img`/`.qcow2`) and turns it into a cloud-init VM template |
| Take / rollback / delete snapshot | resource | Optional RAM state for VMs |
| Migrate | resource | To another cluster node; live for VMs, restart migration for containers, optional local disks |
| Backup | resource | `vzdump` to a backup storage (snapshot/suspend/stop, zstd/gzip/none) |
| Edit CPU / RAM | resource | Change cores and memory (a running guest may need a reboot) |

## Overview metrics

`vmsRunning`, `vmsTotal`, `ctsRunning`, `ctsTotal`, `nodes` (online), `cpuPct` and `memPct`
(cluster-wide). The guest list shows up to 40 guests, running ones first. These keys are the
dashboard's default CPU/memory/node tiles, which is why other connectors prefix theirs.

Proxmox has no connector-specific threshold alerts. Reachability is covered by the baseline
connection monitor, and guest start/stop transitions raise `resource.started` / `resource.stopped`.
