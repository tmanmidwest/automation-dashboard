# Posture

**Posture** (sidebar, `/posture`, needs `connectors:read`) is where you work through the
security findings Cerebro works out from your connectors. The checks themselves are
described in [Architecture Map → Posture findings](architecture-map.md#posture-findings);
this page is about narrowing them down and deciding what to do with each one.

## The page

- **Summary tiles**: open High / Medium / Low, findings that are new since your last visit,
  findings fixed in the last 7 days, and items you snoozed or accepted. Clicking a tile
  filters the list to it.
- **Tabs**: *Findings*, *Exposed to the internet* (the exposure paths, also on the map's
  Internet tile), and *Unknown addresses* (each address no connector knows, with the rule,
  group or DNS record that still names it).
- **Filters**: search (titles, hosts, item names, IPs, notes), severity, category, host,
  source, status (needs action, snoozed, accepted risk, fixed in the last 30 days,
  everything) and grouping (severity, category, host, none). Every filter lives in the URL,
  so a filtered page can be bookmarked or sent.
- **Views**: a few built-in ones (High only, Internet-facing, Patching) plus your own:
  *Save this view* stores the current filters under a name (per user, server side, in the
  `posture-views` preference).
- **List and detail**: the list shows each finding with how many items are still open and
  how old it is. The detail shows why it matters, how to fix it, each affected item on one
  line, and the finding's history. On a phone the detail opens full screen.

"Host" is the machine a finding is about: each affected item's VM, server, gateway, switch
or access point on the map. Findings about things that aren't one machine (a domain, the
WAN address) group under *No single machine*.

"New since your last visit" compares against the visit before this one (`posture-last-visit`
preference, per user).

## Per-item decisions

Each affected item has a **⋯** menu (`connectors:action`):

- **Snooze 7 / 30 days**: hidden until then. *Snooze all open 7 days* does every open item.
- **Accept risk…**: with a note saying why (shown on the item and in the history). It lasts
  until the finding gets worse than when you accepted it, or the item goes away and comes
  back, or optionally for 90 days.
- **Reopen**: undo either.
- **Show on map**: opens the Architecture Map at that item (`/map?node=<id>`).

A finding counts as open while any item is open. A new item on a finding you'd set aside
shows up open on its own; the rest stay as you left them. The map's finding cards still have
*Snooze 7 days* / *30 days* / *Reopen* for the whole finding, and a link to open it here.

## History and "fixed"

Cerebro records each finding (by its stable id) and each affected item when a map build
first finds it, and notes when they go away. A finding a build no longer finds is marked
**fixed** and listed under *Fixed (last 30 days)*; if it comes back, it is open again and
any snooze or acceptance on its items is cleared. A build where any connector failed to
answer can't tell "fixed" from "missing", so it marks nothing fixed (new findings and items
are still recorded). Switching a check off (for example outside-in checks) also makes its
findings show as fixed.

The history lists: first seen, items added / fixed / back again, severity changes, snoozes
and acceptances (with who and the note), snoozes running out, and acceptances reopened
because the finding got worse. The last 200 entries per finding are kept.

Tables: `PostureFindingRecord`, `PostureItemRecord`, `PostureEvent` (migration
`0054_posture_tracking`). Finding-level snoozes from before (setting `posture.snoozes`) are
turned into item snoozes on the first build after upgrading, then the setting is emptied.

## API

| Call | Permission | What it does |
|---|---|---|
| `GET /api/topology` | `connectors:read` | Open findings, each with `status`, `firstSeenAt`, `hosts` and per-item `status`, `until`, `reason`, `setBy`, `firstSeenAt` |
| `GET /api/posture/fixed?days=30` | `connectors:read` | Findings fixed in the last `days` days, as they last looked |
| `GET /api/posture/findings/:id/history` | `connectors:read` | The finding's history, newest first |
| `POST /api/posture/findings/:id/items {action, labels?, days?, note?}` | `connectors:action` | `action` is `snooze`, `accept` or `reopen`; `labels` empty means every open item (or every set-aside one, to reopen). Audited as `posture.snoozed`, `posture.risk_accepted`, `posture.reopened` |
| `POST/DELETE /api/topology/findings/:id/snooze` | `connectors:action` | Older whole-finding snooze, kept for the map's cards |

Code: `apps/server/src/topology/posture-tracking.ts` (pure: what changed between builds),
`posture-tracking.service.ts`, `posture.controller.ts`; page `apps/web/src/pages/Posture.tsx`.
