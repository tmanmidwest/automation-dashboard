# Unified event timeline ("Ship's Log")

Design + implementation plan for a single, chronological, filterable stream of everything that
happens in Cerebro — the "ship's log." Today the events already exist but live in four
**siloed** tables, each with its own view. This feature is an **aggregation + UI layer** over
those tables, plus filling the gaps where important events are never recorded. It does **not**
introduce a new source-of-truth table; the existing tables stay authoritative.

## What already exists (and what's missing)

| Source | Table | Written by | In the timeline today? |
| --- | --- | --- | --- |
| Who-did-what | `AuditLog` | `AuditService.record` — connectors, OAuth, monitors, auth/MFA, viewscreen | Its own `/api/logs/audit` list |
| Diagnostic logs | `AppLog` | `LoggingService` (also stdout) | Its own `/api/logs/app` list (Logs screen) |
| Alert deliveries | `NotificationLog` | notifications pipeline | Notifications history view |
| Durable job history | `BackupRun` | Backblaze / job runners | Connector detail only |
| Monitor up/down | `MonitorHeartbeat` (transitions) | monitor probes | Monitor detail only |

**Gaps to close (events that happen silently):**
- Connector **actions** dispatched (start/stop VM, HA service calls, etc.) — no audit entry.
- **Job** lifecycle from the in-memory `JobService` (`finish`) — not persisted to audit.
- **Alerts fired** (as distinct from *delivered*) — only the delivery is logged.

## Design decisions (resolved)

| Decision | Choice | Why |
| --- | --- | --- |
| New table? | **No.** Timeline is a read-model **union** over existing tables | Avoids dual-write, drift, and a migration of historical data. Each table stays the authority for its own domain. |
| Normalization | A single `TimelineEvent` DTO the service maps every source into | The UI consumes one shape; sources can be added later without UI churn. |
| Pagination | **Time-cursor** (`before` timestamp + `id` tiebreak), not offset | Union across tables can't use SQL `OFFSET` cleanly; cursor on `createdAt` is stable and cheap given every table already indexes `createdAt`. |
| Live tail | Reuse the `@Sse` + `subscribeLive` pattern built for Home Assistant | The contract already exists (`ConnectorManifest.live`, `@Sse /live`). Timeline exposes `/api/timeline/live`. |
| Permissions | Requires **both** `logs:read` **and** `audit:read` | The stream mixes diagnostic and actor events; a viewer without `audit:read` sees the diagnostic subset only (audit rows filtered out server-side). |
| Relationship to Logs screen | Timeline is a **new** `/timeline` route; the existing `/logs` screen stays as the raw app-log/audit tabs | Keeps the low-level debug view; timeline is the curated "what happened" story. |
| Retention | Per-source, unchanged. Timeline never deletes | Each table keeps its own lifecycle; audit stays append-only forever. |

## The normalized event shape

New in `packages/shared/src/timeline.ts`:

```ts
export type TimelineKind =
  | 'audit'          // actor did something (from AuditLog)
  | 'app_log'        // diagnostic (from AppLog, warn/error only by default)
  | 'notification'   // an alert was delivered (from NotificationLog)
  | 'job'            // a connector job/run started or finished (from BackupRun)
  | 'monitor';       // a monitor changed state (from MonitorHeartbeat transitions)

export type TimelineSeverity = 'info' | 'warning' | 'critical' | 'success';

export interface TimelineEvent {
  /** Stable composite id: `${kind}:${row.id}` — unique across sources. */
  id: string;
  ts: string;                    // ISO8601, the sort key
  kind: TimelineKind;
  severity: TimelineSeverity;
  /** Short human title, e.g. "Started VM pve-01" or "Backup failed". */
  title: string;
  /** Optional longer detail / error text. */
  detail?: string;
  /** Who, when known. */
  actor?: { id?: string; email?: string } | null;
  /** Where it originated: connectorId, monitor id, 'auth', 'system', … */
  source?: string | null;
  /** Freeform structured extras (never secret material). */
  meta?: Record<string, unknown>;
}

export interface TimelineQuery {
  kinds?: TimelineKind[];
  severities?: TimelineSeverity[];
  source?: string;          // connectorId / monitor id / 'auth'
  actorId?: string;
  text?: string;            // substring over title/detail
  before?: string;          // ISO cursor
  limit?: number;           // default 100, max 500
}
```

---

## Phase 1 — Aggregation service (read-only, no gaps closed yet)

Ships the timeline over what's *already recorded*. Immediately useful.

**New module** `apps/server/src/timeline/`:

- `timeline.service.ts` — `query(q: TimelineQuery): Promise<TimelineEvent[]>`.
  Strategy: fetch `limit` most-recent rows *from each* eligible source older than `before`,
  map each to `TimelineEvent`, merge-sort by `ts` desc, slice to `limit`. Because every
  source table already has a `createdAt` index, each per-source query is a cheap
  `orderBy createdAt desc take limit`. The next cursor is the `ts` of the last returned event.
- `timeline.controller.ts` — `@Get('api/timeline')` guarded by `@RequirePermissions('logs:read')`;
  strips `kind:'audit'` events when the caller lacks `audit:read` (checked from the request user).
- `timeline.module.ts` — imports `PrismaService`, reused by `AppModule`.

**Mapping rules** (per source → `TimelineEvent`):

| Source row | severity | title |
| --- | --- | --- |
| `AuditLog` | `info` (or `warning` if `action` endswith `_failed`/`denied`) | humanized `action` + `target` |
| `AppLog` (warn/error only) | `warn→warning`, `error→critical` | `context`: `message` |
| `NotificationLog` | mirror `severity`; `failed`→`critical` | `title` + `channel`/`status` |
| `BackupRun` | `error→critical`, `success→success`, `running→info` | trigger + status + `message` |
| `MonitorHeartbeat` transition | down→`critical`, up→`success` | "Monitor X went up/down" |

> **Note on `AppLog`:** include only `warn`/`error` by default (the timeline is a *story*, not
> a debug firehose). `info`/`debug` stay on the `/logs` screen.

## Phase 2 — Close the silent-event gaps

Backfill `audit.record` / a new persisted job record at the ~6 spots that currently act
silently, so the timeline is *complete*, not just aggregated:

1. **Connector action dispatch** — in the connectors action path
   (`apps/server/src/connectors/connectors.controller.ts`, action/operation endpoints), record
   `action: 'connector.action'`, `target: <resource>`, `meta: { op, connectorId }`. The MCP
   path (`via:'mcp'`) already tags itself; ensure it flows through the same `audit.record`.
2. **Job lifecycle** — when `JobService.finish` resolves, emit an audit row (or extend
   `BackupRun` usage) so non-backup jobs also land in history. Decision: reuse `BackupRun`'s
   pattern via a small generic `JobRun` mapping, or just `audit.record` — **start with
   `audit.record`** to avoid a schema change; promote to a table only if volume warrants.
3. **Alert fired** — in the notifications pipeline, record the *decision to fire* (not only the
   per-channel delivery) as `kind:'notification'` severity from the alert.

No schema change in Phase 2 if we lean on `AuditLog`. This is the "reach" half of the feature.

## Phase 3 — LCARS "Ship's Log" screen

**Route** in `apps/web/src/App.tsx`:

```tsx
<Route path="/timeline" element={<Protected><RequirePerm perm="logs:read"><Timeline /></RequirePerm></Protected>} />
```

**`apps/web/src/pages/Timeline.tsx`** — single scrolling stream:
- A left rail of **filter pills** (kind, severity, source, actor) in the LCARS elbow style.
- Each row: a severity-colored spine (LCARS accent by severity), timestamp, actor chip, title,
  expandable detail. Rows are **clickable** through to their origin (connector detail, monitor
  detail, notification history) — consistent with the "all items clickable" LCARS rule.
- Infinite scroll via the time cursor; a text search box maps to `TimelineQuery.text`.

## Phase 4 — Live tail (optional, reuses HA plumbing)

- `@Sse('api/timeline/live')` on the controller, mirroring the HA `/live` endpoint. On each
  newly written audit/log/notification row, push the mapped `TimelineEvent`.
- Simplest emitter: a lightweight in-process `EventEmitter` that `AuditService.record`,
  `LoggingService.write`, and the notifications pipeline publish to; the SSE endpoint
  subscribes and filters by the client's `TimelineQuery`. No DB polling.
- The screen prepends live events when the user is scrolled to top; otherwise shows a
  "N new events" pill (standard tail UX).

---

## Files touched (summary)

| File | Change |
| --- | --- |
| `packages/shared/src/timeline.ts` (new) | `TimelineEvent`, `TimelineKind`, `TimelineQuery` |
| `packages/shared/src/index.ts` | export the above |
| `apps/server/src/timeline/*` (new module) | service + controller + module |
| `apps/server/src/app.module.ts` | register `TimelineModule` |
| `apps/server/src/connectors/connectors.controller.ts` | Phase 2: audit action dispatch |
| notifications pipeline | Phase 2: record "alert fired"; Phase 4: emit to live bus |
| `apps/web/src/pages/Timeline.tsx` (new) | the Ship's Log screen |
| `apps/web/src/App.tsx` + nav | `/timeline` route + nav entry |

## Open questions

1. **Should the timeline replace the `/logs` screen** or sit beside it? Plan assumes *beside*
   (logs = raw/debug tabs, timeline = curated). Easy to fold `/logs` into a "Raw" tab of
   timeline later.
2. **Job history table vs. audit rows** for Phase 2 job events — start with audit, promote to a
   `JobRun` table only if we want per-job status transitions and durations as first-class.
3. **Live bus scope** — a single in-process `EventEmitter` is fine for the current
   single-instance deployment; if Cerebro ever runs multi-replica, this needs Redis pub/sub
   (Redis is already in the stack).
