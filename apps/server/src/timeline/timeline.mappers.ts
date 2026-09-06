import type { TimelineEvent, TimelineSeverity } from '@cerebro/shared';

// Pure row → TimelineEvent mappers, shared by the query read-model
// (timeline.service.ts) and the live bus publishers (AuditService,
// LoggingService, notifications) so both paths emit an identical shape.

/** Minimal row shapes — loosely typed to avoid importing Prisma model types. */
interface AuditRow {
  id: string;
  createdAt: Date;
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  target?: string | null;
  meta?: unknown;
}
interface AppLogRow {
  id: string;
  createdAt: Date;
  level: string;
  context: string;
  message: string;
  meta?: unknown;
}
interface NotificationRow {
  id: string;
  createdAt: Date;
  title: string;
  severity: string;
  status: string;
  channel: string;
  recipients: number;
  connectorId?: string | null;
  source?: string | null;
  detail?: string | null;
  alertKey?: string | null;
}
interface BackupRunRow {
  id: string;
  startedAt: Date;
  finishedAt?: Date | null;
  connectorInstanceId: string;
  trigger: string;
  status: string;
  message?: string | null;
}
interface MonitorHeartbeatRow {
  id: number;
  at: Date;
  monitorId: string;
  status: string;
  latencyMs?: number | null;
  message?: string | null;
}

export function mapAuditRow(r: AuditRow): TimelineEvent {
  const meta = (r.meta as Record<string, unknown> | null) ?? null;
  return {
    id: `audit:${r.id}`,
    ts: r.createdAt.toISOString(),
    kind: 'audit',
    severity: auditSeverity(r.action),
    title: humanizeAction(r.action) + (r.target ? ` — ${r.target}` : ''),
    detail: null,
    actor: r.actorId || r.actorEmail ? { id: r.actorId, email: r.actorEmail } : null,
    source: (meta?.connectorId as string | undefined) ?? null,
    meta,
  };
}

export function mapAppLogRow(r: AppLogRow): TimelineEvent {
  return {
    id: `app_log:${r.id}`,
    ts: r.createdAt.toISOString(),
    kind: 'app_log',
    severity: r.level === 'error' ? 'critical' : 'warning',
    title: `${r.context}: ${r.message}`,
    detail: null,
    actor: null,
    source: r.context,
    meta: (r.meta as Record<string, unknown> | null) ?? null,
  };
}

export function mapNotificationRow(r: NotificationRow): TimelineEvent {
  return {
    id: `notification:${r.id}`,
    ts: r.createdAt.toISOString(),
    kind: 'notification',
    severity:
      r.status === 'failed'
        ? 'critical'
        : r.severity === 'critical'
          ? 'critical'
          : r.severity === 'warning'
            ? 'warning'
            : 'info',
    title: r.title,
    detail: r.detail ?? `${r.channel} · ${r.status}`,
    actor: null,
    source: r.connectorId ?? r.source ?? null,
    meta: { channel: r.channel, status: r.status, recipients: r.recipients, alertKey: r.alertKey },
  };
}

export function mapBackupRunRow(r: BackupRunRow): TimelineEvent {
  return {
    id: `job:${r.id}`,
    ts: r.startedAt.toISOString(),
    kind: 'job',
    severity: r.status === 'error' ? 'critical' : r.status === 'success' ? 'success' : 'info',
    title: `${capitalize(r.trigger)} job ${r.status}`,
    detail: r.message ?? null,
    actor: null,
    source: r.connectorInstanceId,
    meta: { trigger: r.trigger, status: r.status, finishedAt: r.finishedAt?.toISOString() ?? null },
  };
}

export function mapMonitorHeartbeatRow(r: MonitorHeartbeatRow, monitorName?: string): TimelineEvent {
  return {
    id: `monitor:${r.id}`,
    ts: r.at.toISOString(),
    kind: 'monitor',
    severity: r.status === 'down' ? 'critical' : r.status === 'up' ? 'success' : 'info',
    title: `${monitorName ?? 'Monitor'} is ${r.status}`,
    detail: r.message ?? null,
    actor: null,
    source: r.monitorId,
    meta: { status: r.status, latencyMs: r.latencyMs },
  };
}

// ── shared severity/label helpers ─────────────────────────────────

export function auditSeverity(action: string): TimelineSeverity {
  const a = action.toLowerCase();
  if (a.includes('fail') || a.includes('denied') || a.includes('error')) return 'warning';
  if (a.includes('delete') || a.includes('revoke')) return 'warning';
  return 'info';
}

/** "connectors.instance_deleted" → "Connectors instance deleted". */
export function humanizeAction(action: string): string {
  const s = action.replace(/[._]/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
