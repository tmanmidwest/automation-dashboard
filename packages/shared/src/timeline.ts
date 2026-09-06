// Unified event timeline ("Ship's Log"). A read-model that unions the existing
// siloed event tables into one chronological stream. See docs/event-timeline.md.

export type TimelineKind =
  | 'audit' // an actor did something (from AuditLog)
  | 'app_log' // a diagnostic log line (from AppLog; warn/error only by default)
  | 'notification' // an alert was delivered (from NotificationLog)
  | 'job' // a connector job/run (from BackupRun)
  | 'monitor'; // a monitor changed state (from MonitorHeartbeat transitions)

export const TIMELINE_KINDS: TimelineKind[] = [
  'audit',
  'app_log',
  'notification',
  'job',
  'monitor',
];

export type TimelineSeverity = 'info' | 'success' | 'warning' | 'critical';

export const TIMELINE_SEVERITIES: TimelineSeverity[] = [
  'info',
  'success',
  'warning',
  'critical',
];

/** One normalized event. Every source table maps into this shape. */
export interface TimelineEvent {
  /** Stable composite id: `${kind}:${row.id}` — unique across sources. */
  id: string;
  /** ISO8601 timestamp; the sort key. */
  ts: string;
  kind: TimelineKind;
  severity: TimelineSeverity;
  /** Short human title, e.g. "Started VM pve-01" or "Backup failed". */
  title: string;
  /** Optional longer detail / error text. */
  detail?: string | null;
  /** Who, when known. */
  actor?: { id?: string | null; email?: string | null } | null;
  /** Where it originated: connectorId, monitor id, 'auth', 'system', … */
  source?: string | null;
  /** Freeform structured extras (never secret material). */
  meta?: Record<string, unknown> | null;
}

/** Query params accepted by GET /api/timeline. */
export interface TimelineQuery {
  kinds?: TimelineKind[];
  severities?: TimelineSeverity[];
  /** connectorId / monitor id / 'auth' — matched against an event's source. */
  source?: string;
  actorId?: string;
  /** Case-insensitive substring over title/detail. */
  text?: string;
  /** ISO cursor: return events strictly older than this. */
  before?: string;
  /** Default 100, max 500. */
  limit?: number;
}

/** GET /api/timeline response: a page plus the cursor for the next page. */
export interface TimelinePage {
  events: TimelineEvent[];
  /** Pass as `before` to fetch the next (older) page; null when exhausted. */
  nextCursor: string | null;
}
