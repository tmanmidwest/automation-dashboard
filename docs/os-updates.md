# OS updates

**Health → Updates** shows the operating-system updates waiting on every machine that runs the
Cerebro agent. You can install them, restart machines, and set up schedules that patch machines
on their own in a maintenance window, a few machines first and the rest later.

It uses the same agent as Fabric and [Health](health-monitoring.md). Version 0.7.0 adds updates,
and agents already installed update themselves on their next connect.

## Finding updates

The agent asks the machine's own package manager, and changes nothing while it checks:

| System | How it checks | Security updates marked | Restart needed |
| --- | --- | --- | --- |
| Debian, Ubuntu, Raspberry Pi OS, Proxmox VE | `apt-get update`, then a simulated `dist-upgrade` and a simulated `upgrade --with-new-pkgs` (see *Held back* below) | Yes (from `*-security` origins) | `/var/run/reboot-required`, or a newer kernel in `/boot` than the one running |
| RHEL, Rocky, Alma, Fedora | `dnf` / `yum check-update` plus `updateinfo --security` | Yes, with severity | `needs-restarting -r`, or the newer-kernel check |
| openSUSE / SLES | `zypper list-updates` plus security patches | Yes (patches) | `zypper needs-rebooting` |
| Arch | `checkupdates` (from pacman-contrib) | No | Newer-kernel check |
| Alpine | `apk version` | No | No |
| Windows | Windows Update Agent (the API Settings → Windows Update uses) | Yes (Security / Critical, MSRC severity) | Windows' pending-restart flags |
| macOS | `softwareupdate --list` | Yes (titles with "Security") | Remembered after Cerebro installs a restart-requiring update |

- It checks about 90 seconds after the agent starts, then every 6 hours. **Check now** on a
  machine checks straight away.
- Cerebro remembers when security updates first appeared on a machine and when a restart first
  became necessary, so it can say how long they have been waiting.
- The agent sends at most 400 packages per machine, security updates first.
- **Newer kernel** means a higher kernel version of the same build as the running one. A Raspberry
  Pi has several builds of each kernel installed (`+rpt-rpi-2712` for a Pi 5, `+rpt-rpi-v8` for
  older Pis) and boots only one, so another build of the same version never asks for a restart
  (agent 0.8+; older agents could show a restart that never cleared on a Pi 5).

### Held back (apt)

Some upgrades need another package added or removed, for example when a library is renamed
(`libcamera0.6` → `libcamera0.8`). A regular upgrade (`apt-get upgrade --with-new-pkgs`, what
*All updates* runs) leaves those alone; only a full upgrade (`apt-get dist-upgrade`) installs them.
The agent (0.8+) simulates both and marks the difference as **held back**:

- The count and *security* count show what *All updates* / *Security only* will actually install.
  Held-back packages are optional: they're counted apart ("9 held back (optional)") and tagged in the
  package list, and a machine with only held-back packages shows **Up to date** and doesn't count in
  *Have updates*.
- To install them, tick **Include held-back (full upgrade)** in the Install dialog (with *All
  updates*). The dialog lists any packages the full upgrade would remove first. It's never on by
  default and schedules never do it.
- Proxmox VE always installs with `dist-upgrade`, so nothing is held back there.
- Agents before 0.8 count held-back packages in the total, as before; they update themselves.

## Severity and CVEs

Each pending update gets a **priority**, the CVEs it fixes with links to the advisories, and a
**known exploited** flag. The Updates list sorts machines worst-first and says why
("2 updates fix known-exploited CVEs (CVE-…) · 31 CVEs fixed").

| Priority | When |
| --- | --- |
| **Patch now** | Fixes a CVE on CISA's [Known Exploited Vulnerabilities](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) list |
| **Critical** | CVSS 9.0+, or the vendor / distro rates it Critical (MSRC, Red Hat, Ubuntu priority) |
| **Important** | CVSS 7.0–8.9, or vendor Important / High |
| **Security** | A security fix of lower or unknown severity |
| **Regular** | Not a security fix |

A machine takes the highest priority among its updates. Within a priority, packages sort by EPSS
(FIRST.org's chance of exploitation in the next 30 days), then CVSS. After a Patch now or Critical
update installs, the **restart** marker turns red until the machine restarts, because the old
kernel or library keeps running until then.

Where the CVEs come from:

| Manager | Source |
| --- | --- |
| dnf / yum | The agent runs `updateinfo list --security --with-cve` (agent 0.10+) |
| Windows Update | `CveIDs` and `SecurityBulletinIDs` on each update (agent 0.10+) |
| apt (Ubuntu, Debian, Raspberry Pi OS, Proxmox) | Cerebro asks [OSV.dev](https://osv.dev) which advisories affect the installed version and which affect the new one; the difference is what the update fixes. Needs the agent's distro and source package names (agent 0.10+). |
| zypper, pacman, apk, macOS | Not yet: security vs regular only |

Scores: CVSS and vendor priority come from the advisory (Ubuntu's per-CVE OSV records carry a CVSS
vector and Ubuntu's priority; Cerebro uses those for Debian, RHEL and Windows CVEs too). There is
no NVD lookup: its rate limit can't keep up with a fleet's CVEs.

Caching and privacy: OSV lookups are cached a day per (release, package, version), so machines on
the same release share them; advisory records and CVE scores a week; EPSS and KEV a day. Enrichment
runs in the background after each report and hourly; the page shows what's stored. A failed source
backs off for 3 hours (*Check now* retries at once) and the card says what's missing. Cerebro sends
only the release (e.g. `Ubuntu:22.04:LTS`), package names, versions and CVE ids: never hostnames
or addresses. All of it follows the **outside-in checks** toggle in Posture; with it off, you get
the CVEs dnf and Windows report and an already-downloaded KEV list, and no apt CVEs.

Known gaps: new packages (a new `linux-image-…`) have no installed version to compare, so a kernel
that arrives as a new package shows no CVEs on apt. Raspberry Pi archive packages aren't in OSV.

## Installing

Select machines on the Updates tab, or open one machine's page, and pick **Install…**:

- **What to install:** *Security only* or *All updates*, plus *Include held-back (full upgrade)*
  on apt machines that have held-back packages (see above).
- **Afterwards:** *Restart if needed* (the default), *Don't restart*, or *Always restart*. A restart
  happens about a minute after the install finishes, and only if the install succeeded.
- **Proxmox snapshot first:** shown for machines Cerebro can match to a Proxmox VM or container (by
  network card MAC). Cerebro takes a snapshot named `cerebro-pre-update-<date>-<time>` and keeps
  only its last 2 per guest. If the snapshot fails, nothing is installed.
- **When:** *Now* or *Later* at a date and time. A machine that's offline at that time gets up to
  4 hours to come back before the run is marked missed. A *Now* run waits 15 minutes.

The run's output streams into the run window while it installs. Afterwards the agent checks again,
so the counts are up to date right away.

What runs on each system:

| System | Security only | All updates |
| --- | --- | --- |
| apt | `apt-get install --only-upgrade <the security packages that aren't held back>` | `apt-get upgrade --with-new-pkgs`. On **Proxmox VE** this is `apt-get dist-upgrade`, which Proxmox requires. With *Include held-back*: `apt-get dist-upgrade`. |
| dnf / yum | `dnf upgrade --security` | `dnf upgrade` |
| zypper | `zypper patch --category security` | `zypper update` |
| pacman | Not possible (pick All) | `pacman -Syu` |
| apk | Not possible (pick All) | `apk upgrade` |
| Windows | Security and Critical updates | Every update that doesn't need someone at the PC |
| macOS | Updates with "Security" in the title | Everything that can be installed unattended |

apt always keeps your existing config files (`--force-confold`), and it waits up to 10 minutes when
another apt process holds the lock (for example unattended-upgrades). The run's output names the
process holding the lock (PID, command line, how long it has been running).

**Stuck apt (agent 0.9+).** If the lock holder has been running for 30 minutes or more, it's almost
always stuck (a package script waiting on something that never comes), so the install fails at once
with a message that names it instead of waiting 10 minutes and failing with "exit 100". The machine's
Updates card says so too, and also when dpkg was interrupted and left work unfinished.
**Repair…** on the card fixes both without SSH:

1. stops any `apt`, `apt-get`, `aptitude`, `dpkg` or unattended-upgrades process that has held the
   lock for 10 minutes or more, and its child processes (SIGTERM, then SIGKILL after 30 s). It refuses
   when the holder is newer than that, or isn't a package-manager process;
2. runs `dpkg --configure -a` (keeping config files) to finish half-done package setup;
3. runs `apt-get -f install` to fix broken dependencies, then checks again.

Every install and check command runs in its own process group. When the 3-hour install limit is hit,
the whole group (apt, dpkg and package scripts) is stopped, not just apt-get, so nothing is left
holding the lock. If a package script starts a service that keeps the output open, the agent stops
waiting 90 seconds after apt itself exits.

A failed run no longer reports an "installed" count; only finished installs do.

**macOS on Apple silicon:** Apple requires an owner's password to install macOS itself, so those
updates are shown as *needs someone at the Mac* and skipped. Safari, Command Line Tools and other
smaller updates install normally. On Intel Macs everything can install unattended.

**Restart:** use **Restart…** on a machine, or select several and pick *Restart*. You have to type
the machine's name (or "restart") to confirm. Restarts can also be scheduled for later.

## Schedules

A schedule is a maintenance window. It has days of the week, a start time (server time), how long
the window stays open, what to install, and whether to restart and snapshot.

- **Rings:** ring 1 starts when the window opens. Each later ring starts a set number of hours after
  ring 1, and also waits until the earlier rings have finished. When *Hold back later rings if one
  fails* is on (the default), a failure in an earlier ring cancels the later rings for that window.
- A machine that's offline when its ring starts, such as a laptop that's asleep, is patched if it
  comes back before the window closes. Otherwise the run is marked **missed**.
- Each machine has at most one open run, so overlapping schedules don't stack up.
- **Run now** opens the window immediately, which is handy for testing.
- A Waypoint that shares its machine with an endpoint agent isn't listed. If a schedule names it,
  the run goes to that endpoint agent instead. See *Waypoint and agent on one machine* in
  [health-monitoring.md](health-monitoring.md).

## Safety

- **Cerebro sends options, never commands.** The command says install with scope security, all or
  full (apt full upgrade, agent 0.8+),
  plus a restart choice, and the agent runs its own fixed commands for that. Cerebro can't make the
  agent run arbitrary shell.
- **Signed commands.** With update signing in **vault** mode (Fabric → Update signing), every
  install and restart command is signed. The signature covers the agent's credential, the time, the
  run id and the exact options. An agent that has pinned the signing key refuses anything unsigned,
  stale (more than an hour old) or altered, and the run shows as **Refused**.
  - With signing **off**, agents accept unsigned commands, and the Updates tab says so.
  - In **offline** signing mode Cerebro can't sign, so installs are refused. Checking still works.
- **Opt out on the machine.** Set `CEREBRO_OS_UPDATES` in the agent's `config.env` (or in its
  environment):
  - `on` (the default): checks and allows installs.
  - `report`: checks and reports, but refuses installs and restarts.
  - `off`: no update checks at all.
- **Permissions.** Viewing and *Check now* need `fabric:read`. Installs, restarts and schedules need
  `fabric:manage`, and each one is written to the audit log.
- The agent doesn't update itself while an install is running, and an install stops after 3 hours.

## Alerts and posture

- **Update install failed** (`updates.run_failed`, on by default) fires when an install or restart
  fails, is refused, gets no answer, or a scheduled run is missed.
- **Updates installed** (`updates.run_succeeded`) is off by default.
- **Security updates waiting** (`updates.security_waiting`, on by default) fires once per server when
  its security updates have waited more than 7 days.
- **Known-exploited CVE updates waiting** (`updates.known_exploited`, on by default, critical) fires
  once per machine (servers and workstations) when a Patch now update has waited more than 2 days.
- **Posture** adds three findings:
  - *Updates waiting that fix known-exploited vulnerabilities*: High, after 2 days.
  - *Security updates waiting over 7 days*: Medium, or High after 30 days.
  - *Restart needed to finish installing updates*: Low after 7 days, Medium when the installed
    fixes were Patch now or Critical.
  Each affected machine links to its Health page.

## API

Everything is under `/api/os-updates`:

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/` | `fabric:read` (machines, recent runs, schedules, signing state, totals) |
| GET | `/machines/:agentId` | `fabric:read` (status, packages, runs) |
| POST | `/machines/:agentId/check` | `fabric:read` |
| POST | `/install` `{ agentIds, scope, reboot, snapshot?, at? }` | `fabric:manage` |
| POST | `/reboot` `{ agentIds, at? }` | `fabric:manage` |
| POST | `/repair` `{ agentIds }` | `fabric:manage` (apt, agent 0.9+; runs now) |
| GET | `/runs/:id` | `fabric:read` (includes the output) |
| POST | `/runs/:id/cancel` | `fabric:manage` (runs that haven't started) |
| GET, POST | `/schedules` | read `fabric:read`, create `fabric:manage` |
| PUT, DELETE | `/schedules/:id` | `fabric:manage` |
| POST | `/schedules/:id/run-now` | `fabric:manage` |

The Health fleet API (`/api/machine-health`) also includes each machine's update summary as
`updates`.

## Protocol

| Direction | Frame | Purpose |
| --- | --- | --- |
| agent → broker | `{ t: "updates", report }` | Pending updates, restart flag, mode, the run in progress, and the last run's result. Sent after each check and on every connect. |
| agent → broker | `{ t: "updates-log", runId, lines[] }` | Install output, batched about once a second |
| agent → broker | `{ t: "updates-result", result }` | How an install or restart ended. It is also kept in `updates-last-run.json`, so a result from just before a restart still arrives. |
| broker → agent | `{ t: "updates-check" }` | Check now |
| broker → agent | `{ t: "updates-install", runId, scope, reboot, issuedAt?, sig? }` | Install. The signature covers `updates:<credHash>:<issuedAt>:<runId>:install:<scope>:<reboot>` |
| broker → agent | `{ t: "updates-reboot", runId, issuedAt?, sig? }` | Restart. The signature covers `updates:<credHash>:<issuedAt>:<runId>:reboot::` |
| broker → agent | `{ t: "updates-repair", runId, issuedAt?, sig? }` | Repair apt. The signature covers `updates:<credHash>:<issuedAt>:<runId>:repair::` |

Types are in `packages/shared/src/os-updates.ts`.

## Code map

- **Agent:**
  - `agent/updates.go`: check loop, install and restart, output batching, last-run file.
  - `agent/updates_{linux,windows,darwin}.go`: per-OS commands.
  - `agent/updates_parse.go`: output parsers, unit-tested in `agent/updates_test.go`.
  - `agent/main.go`: `updatesAuthorized` checks the signature.
- **Server:**
  - `apps/server/src/os-updates/os-updates.service.ts`: ingest, dispatch loop, schedules, Proxmox
    snapshots, alerts.
  - `apps/server/src/os-updates/os-updates.logic.ts`: pure logic (sanitizing, "waiting since",
    schedule timing, posture findings).
  - `apps/server/src/fabric/fabric-update-signing.service.ts`: `signUpdatesToken`.
  - `apps/server/src/os-updates/os-update-enrich.service.ts` + `os-updates.enrich.ts`: CVEs,
    scores and priority per update.
  - `apps/server/src/vuln-intel/`: shared CISA KEV (also used by Posture), OSV.dev, CVE scores + EPSS.
- **Tables:** `AgentUpdateStatus`, `AgentUpdateRun` and `UpdateSchedule`. Migration `0056_os_updates`; `0058_os_update_cves` adds the
  priority summary and the `OsVulnLookup` / `OsAdvisory` / `OsCve` caches.
- **Web:**
  - `apps/web/src/components/health/UpdatesTab.tsx`
  - `apps/web/src/components/health/UpdatesCard.tsx`, the card on a machine's page
  - `apps/web/src/components/health/updates-ui.tsx`, the dialogs
  - `apps/web/src/components/health/UpdatesPackages.tsx`, the package table with CVEs
