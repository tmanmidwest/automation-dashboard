# Act Now

**Act Now** (sidebar, right under Dashboard) is one worst-first list of what to fix today. It
gathers the urgent items from three pages into one place:

- **Health → Updates**: Patch-now and Critical OS updates, and restarts still needed to finish them.
- **Posture**: known-exploited findings of any severity, and other high-severity findings.
- **Stack Backups**: broken repositories, failing backups, failed test restores, stale scheduled
  backups, new stacks with no backup, failed Backblaze system backups, and Proxmox VMs whose
  vzdump backup is missing or stale (a Posture finding, shown under Backups).

Each row says why it's on the list and links to the page where you fix it. Act Now never
installs, backs up or changes anything itself.

The Dashboard shows an **Act Now** tile with the count per tier and the top three items, and the
sidebar entry carries a count badge coloured by the worst tier.

## Tiers

Every item gets one tier. The tier decides the order; nothing jumps tiers.

| Tier | What lands here | Overdue after |
| --- | --- | --- |
| 1 · Exploited & exposed | A CISA KEV problem on something reachable from the internet: a KEV posture finding with an internet-facing item, or a Patch-now update on a machine on an [exposure path](architecture-map.md#exposure-paths). | 1 day |
| 2 · Known exploited | Patch-now updates, KEV posture findings with no internet path, restarts still needed to finish a Patch-now install. | 2 days |
| 3 · Backups broken | A backup repository that can't be reached or failed its data check; a stack backup whose last run failed; a failed scheduled test restore; a failed Backblaze system backup. | 1 day |
| 4 · Critical / high | Critical updates (and restarts for them); other high-severity posture findings; a scheduled backup that has gone stale (2.5× its interval with no success); a new stack with no backup past the 1-hour grace; missing or stale vzdump backups. | 7 days |

Inside a tier: overdue first, then the highest EPSS, the highest CVSS, the longest wait, and how
many things the item touches. An item is **overdue** when it has been open longer than its tier's
limit (counted from first seen, waiting since, or the first failure after the last good backup).

One item is one thing you fix in one place: one machine (all its urgent packages), one posture
finding (its open affected items in the detail), one stack, or one repository.

**Internet-facing** comes from the Architecture Map: a machine counts when it is a hop on an
exposure path, or runs one (a container's stack and host are its parents). Machines are matched
to their map node through the Fabric agent (`fabric` source with the agent id). Posture items also
carry `exposed` / `kev` flags set by the checks that know them (WAN vulnerabilities, the image CVE
scan, firmware CVEs).

## Left out on purpose

- Important, Security and Regular updates (Health → Updates has them).
- Medium and low posture findings that aren't known-exploited.
- Posture's own OS-update findings (`os-security-updates`, `os-known-exploited-updates`,
  `os-restart-pending`): the update items say the same per machine with CVE detail.
- Stacks that were already there when Cerebro first scanned the host and still have no backup;
  backups that are manual, disabled, or for a stack that's gone.
- Machines with OS updates switched off (`CEREBRO_OS_UPDATES=off`).
- Connector-down and sign-in events: those stay in the Dashboard's Needs Attention banner.

The list's footer counts what was left out, with a link to each page.

## Snooze

- **Updates and backups** snooze in Act Now itself (1, 3, 7 or 30 days, up to 90 through the API),
  stored in the `ActNowState` table. A snoozed item comes back early if it gets worse: a worse tier
  (say a machine becomes internet-facing), or a known-exploited CVE it didn't have.
  Needs `fabric:manage` for updates, `backup:write` for backups.
- **Posture items** snooze through Posture's own per-item snooze (`connectors:action`), so both
  pages agree. A finding with every item snoozed or accepted shows under **Snoozed**.
- **A new stack with no backup** offers **This stack needs no backup…**, the same "no backup on
  purpose" flag as Stack Backups.

## Who sees what

The page shows for anyone with at least one of `fabric:read` (updates), `connectors:read`
(posture) or `backup:read` (backups), and only the sources they can read.

## Refresh

The server builds the list from database rows and the cached posture build only: no SSH to Docker
hosts and no outside lookups (KEV, CVSS and EPSS are what Posture and Health → Updates already
cached). It keeps the result for 60 seconds. The page reloads every 60 seconds and when you come
back to the tab; **Refresh** rebuilds it now. The badge and Dashboard tile check every 2 minutes.

If a source can't be read, the rest still show and a banner names the missing one. Right after a
restart the posture build may not be ready yet; the list says so and fills in within a minute or two.

## API

| Call | What |
| --- | --- |
| `GET /api/act-now` (`?refresh=1`) | The list: `items`, `snoozed`, `sources` (allowed / ok / as of), `hidden` counts, `counts` per tier. |
| `GET /api/act-now/summary` | Total, counts per tier, overdue count, top three. |
| `POST /api/act-now/snooze` | `{ key, days, note? }` for an update or backup item. Audited. |
| `DELETE /api/act-now/snooze/:key` | Put it back on the list. Audited. |

MCP: `list_act_now` (any of the three read scopes) returns the same list. See
[API + MCP server](api-and-mcp-server.md).

The rules live in `apps/server/src/act-now/act-now.logic.ts` (pure, no I/O); the service only
reads the records.
