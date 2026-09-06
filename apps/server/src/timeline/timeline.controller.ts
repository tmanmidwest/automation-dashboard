import { Controller, Get, MessageEvent, Query, Sse } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { TimelineService } from './timeline.service';
import { TimelineBus } from './timeline-bus';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { hasPermission, TIMELINE_KINDS } from '@cerebro/shared';
import type {
  SessionUser,
  TimelineKind,
  TimelinePage,
  TimelineQuery,
  TimelineSeverity,
} from '@cerebro/shared';

@Controller('api/timeline')
export class TimelineController {
  constructor(
    private readonly timeline: TimelineService,
    private readonly bus: TimelineBus,
  ) {}

  @Get()
  @RequirePermissions('logs:read')
  async list(
    @CurrentUser() user: SessionUser | undefined,
    @Query('kinds') kinds?: string,
    @Query('severities') severities?: string,
    @Query('source') source?: string,
    @Query('actorId') actorId?: string,
    @Query('text') text?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ): Promise<TimelinePage> {
    const q = this.buildQuery(user, { kinds, severities, source, actorId, text, before, limit });
    return this.timeline.query(q);
  }

  /**
   * Live tail. Server-Sent Events stream of new timeline events as they are
   * written, filtered per client by the same params as the query endpoint. The
   * audit gate is enforced here too: 'audit' is dropped for callers without
   * audit:read. See docs/event-timeline.md.
   */
  @Sse('live')
  @RequirePermissions('logs:read')
  live(
    @CurrentUser() user: SessionUser | undefined,
    @Query('kinds') kinds?: string,
    @Query('severities') severities?: string,
    @Query('source') source?: string,
    @Query('actorId') actorId?: string,
    @Query('text') text?: string,
  ): Observable<MessageEvent> {
    const q = this.buildQuery(user, { kinds, severities, source, actorId, text });
    return this.bus.stream(q).pipe(map((event) => ({ data: event })));
  }

  /** Parse raw query params into a TimelineQuery, applying the audit:read gate. */
  private buildQuery(
    user: SessionUser | undefined,
    raw: {
      kinds?: string;
      severities?: string;
      source?: string;
      actorId?: string;
      text?: string;
      before?: string;
      limit?: string;
    },
  ): TimelineQuery {
    let requestedKinds = csv(raw.kinds).filter((k): k is TimelineKind =>
      (TIMELINE_KINDS as string[]).includes(k),
    );

    // Audit events are gated: a caller with logs:read but not audit:read never
    // sees the who-did-what stream. Enforced by dropping 'audit' from the kinds.
    if (!hasPermission(user?.permissions, 'audit:read')) {
      const base = requestedKinds.length ? requestedKinds : (TIMELINE_KINDS as TimelineKind[]);
      requestedKinds = base.filter((k) => k !== 'audit');
    }

    return {
      kinds: requestedKinds.length ? requestedKinds : undefined,
      severities: csv(raw.severities) as TimelineSeverity[],
      source: raw.source || undefined,
      actorId: raw.actorId || undefined,
      text: raw.text || undefined,
      before: raw.before || undefined,
      limit: raw.limit ? parseInt(raw.limit, 10) : undefined,
    };
  }
}

/** Split a repeated/CSV query param into a trimmed, non-empty string array. */
function csv(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
