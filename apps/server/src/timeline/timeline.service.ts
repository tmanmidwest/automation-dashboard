import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { TimelineEvent, TimelineKind, TimelinePage, TimelineQuery } from '@cerebro/shared';
import {
  mapAppLogRow,
  mapAuditRow,
  mapBackupRunRow,
  mapMonitorHeartbeatRow,
  mapNotificationRow,
} from './timeline.mappers';

/**
 * Read-model over the existing event tables (AuditLog, AppLog, NotificationLog,
 * BackupRun, MonitorHeartbeat). It owns no table of its own — see
 * docs/event-timeline.md. Each source is queried for its most-recent page older
 * than the cursor, mapped to a normalized TimelineEvent, then merge-sorted.
 */
@Injectable()
export class TimelineService {
  constructor(private readonly prisma: PrismaService) {}

  async query(q: TimelineQuery): Promise<TimelinePage> {
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    const before = q.before ? new Date(q.before) : undefined;
    const wants = (k: TimelineKind) => !q.kinds?.length || q.kinds.includes(k);
    // An actor filter only ever matches audit events; skip the other sources.
    const actorScoped = !!q.actorId;

    const batches = await Promise.all([
      wants('audit') ? this.fromAudit(q, before, limit) : [],
      wants('app_log') && !actorScoped ? this.fromAppLog(q, before, limit) : [],
      wants('notification') && !actorScoped ? this.fromNotifications(q, before, limit) : [],
      wants('job') && !actorScoped ? this.fromJobs(q, before, limit) : [],
      wants('monitor') && !actorScoped ? this.fromMonitors(q, before, limit) : [],
    ]);

    const byTs = (a: TimelineEvent, b: TimelineEvent) =>
      a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : a.id < b.id ? 1 : -1;

    const raw = batches.flat().sort(byTs);
    // A source that returned a full page may still have older rows behind it, so
    // there is more to fetch even if the severity filter empties this page.
    const anyCapped = batches.some((b) => b.length >= limit);

    let events = raw;
    if (q.severities?.length) {
      events = raw.filter((e) => q.severities!.includes(e.severity));
    }
    const page = events.slice(0, limit);

    const hasMore = anyCapped || events.length > limit;
    // Advance the cursor by the oldest event we actually looked at (raw, not the
    // filtered page) so a filtered-empty page still pages backwards in time.
    const nextCursor = hasMore ? (page[page.length - 1]?.ts ?? raw[raw.length - 1]?.ts ?? null) : null;
    return { events: page, nextCursor };
  }

  // ── Per-source fetchers (map via the shared mappers) ────────────

  private textWhere(text: string | undefined, fields: string[]) {
    if (!text) return {};
    return { OR: fields.map((f) => ({ [f]: { contains: text, mode: 'insensitive' } })) };
  }

  private async fromAudit(q: TimelineQuery, before: Date | undefined, limit: number): Promise<TimelineEvent[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        actorId: q.actorId,
        createdAt: before ? { lt: before } : undefined,
        ...this.textWhere(q.text, ['action', 'target', 'actorEmail']),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(mapAuditRow).filter((e) => matchesSource(e, q.source));
  }

  private async fromAppLog(q: TimelineQuery, before: Date | undefined, limit: number): Promise<TimelineEvent[]> {
    const rows = await this.prisma.appLog.findMany({
      where: {
        // The timeline tells a story, not a debug firehose: warn/error only.
        level: { in: ['warn', 'error'] },
        context: q.source ? { contains: q.source, mode: 'insensitive' } : undefined,
        createdAt: before ? { lt: before } : undefined,
        ...this.textWhere(q.text, ['message', 'context']),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(mapAppLogRow);
  }

  private async fromNotifications(q: TimelineQuery, before: Date | undefined, limit: number): Promise<TimelineEvent[]> {
    const rows = await this.prisma.notificationLog.findMany({
      where: {
        OR: q.source
          ? [
              { connectorId: { contains: q.source, mode: 'insensitive' } },
              { source: { contains: q.source, mode: 'insensitive' } },
            ]
          : undefined,
        createdAt: before ? { lt: before } : undefined,
        ...this.textWhere(q.text, ['title', 'detail']),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(mapNotificationRow);
  }

  private async fromJobs(q: TimelineQuery, before: Date | undefined, limit: number): Promise<TimelineEvent[]> {
    const rows = await this.prisma.backupRun.findMany({
      where: {
        connectorInstanceId: q.source ? { contains: q.source, mode: 'insensitive' } : undefined,
        startedAt: before ? { lt: before } : undefined,
        ...this.textWhere(q.text, ['message', 'trigger']),
      },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
    return rows.map(mapBackupRunRow);
  }

  private async fromMonitors(q: TimelineQuery, before: Date | undefined, limit: number): Promise<TimelineEvent[]> {
    const rows = await this.prisma.monitorHeartbeat.findMany({
      where: {
        important: true, // transitions only
        monitorId: q.source ? { contains: q.source, mode: 'insensitive' } : undefined,
        at: before ? { lt: before } : undefined,
        ...this.textWhere(q.text, ['message']),
      },
      orderBy: { at: 'desc' },
      take: limit,
      include: { monitor: { select: { name: true } } },
    });
    return rows.map((r) => mapMonitorHeartbeatRow(r, r.monitor?.name));
  }
}

/** Post-filter for sources whose match can't be pushed into the DB query (audit). */
function matchesSource(e: TimelineEvent, source: string | undefined): boolean {
  if (!source) return true;
  return (e.source ?? '').toLowerCase().includes(source.toLowerCase());
}
