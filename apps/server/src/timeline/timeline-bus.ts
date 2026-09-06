import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { TimelineEvent, TimelineQuery } from '@cerebro/shared';

/**
 * In-process pub/sub for live timeline events. Writers (AuditService,
 * LoggingService, the notifications pipeline) publish already-mapped
 * TimelineEvents; the @Sse endpoint subscribes and filters per client.
 *
 * Single-instance only — fine for the current deployment. If Cerebro ever runs
 * multiple replicas this needs Redis pub/sub (already in the stack). See
 * docs/event-timeline.md.
 */
@Injectable()
export class TimelineBus {
  private readonly subject = new Subject<TimelineEvent>();

  /** Publish a mapped event. Never throws — a live-bus hiccup must not break a write. */
  publish(event: TimelineEvent): void {
    try {
      this.subject.next(event);
    } catch {
      /* swallow */
    }
  }

  /** A client's live stream, server-side filtered by the same rules as the query API. */
  stream(q: TimelineQuery): Observable<TimelineEvent> {
    return this.subject.asObservable().pipe(filter((e) => matches(e, q)));
  }
}

/** The live-side analogue of the query filters (kinds/severities/source/actor/text). */
function matches(e: TimelineEvent, q: TimelineQuery): boolean {
  if (q.kinds?.length && !q.kinds.includes(e.kind)) return false;
  if (q.severities?.length && !q.severities.includes(e.severity)) return false;
  if (q.actorId && e.actor?.id !== q.actorId) return false;
  if (q.source && !(e.source ?? '').toLowerCase().includes(q.source.toLowerCase())) return false;
  if (q.text) {
    const hay = `${e.title} ${e.detail ?? ''}`.toLowerCase();
    if (!hay.includes(q.text.toLowerCase())) return false;
  }
  return true;
}
