import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUp, ChevronRight, X } from 'lucide-react';
import type {
  ConnectorInstanceSummary,
  TimelineEvent,
  TimelineEventDetail,
  TimelineKind,
  TimelinePage,
  TimelineSeverity,
} from '@cerebro/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { eventHintLinks, eventSourceLink, type ConnectorRef } from '@/lib/event-links';

// Kept in lockstep with @cerebro/shared's TIMELINE_KINDS / TIMELINE_SEVERITIES.
// Defined locally because the web layer imports only *types* from shared (its
// CJS build can't surface named runtime exports to Rollup).
const KINDS: TimelineKind[] = ['audit', 'app_log', 'notification', 'job', 'monitor'];
const SEVERITIES: TimelineSeverity[] = ['info', 'success', 'warning', 'critical'];

const KIND_LABEL: Record<TimelineKind, string> = {
  audit: 'Audit',
  app_log: 'System',
  notification: 'Alert',
  job: 'Job',
  monitor: 'Monitor',
};

// LCARS severity accents. `spine` colors the left rail; `text` the badge.
const SEVERITY: Record<TimelineSeverity, { spine: string; text: string; label: string }> = {
  info: { spine: 'bg-accent', text: 'text-accent', label: 'Info' },
  success: { spine: 'bg-emerald-400', text: 'text-emerald-400', label: 'OK' },
  warning: { spine: 'bg-amber-400', text: 'text-amber-400', label: 'Warn' },
  critical: { spine: 'bg-destructive', text: 'text-destructive', label: 'Crit' },
};

export function Timeline() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const focusId = params.get('event');
  const [connectors, setConnectors] = useState<ConnectorRef[]>([]);
  useEffect(() => {
    if (!can('connectors:read')) return;
    api.get<ConnectorInstanceSummary[]>('/api/connectors/instances').then(setConnectors).catch(() => {});
  }, [can]);
  const focus = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('event', id);
    else next.delete('event');
    setParams(next);
    if (id) window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const allKinds = KINDS.filter((k) => k !== 'audit' || can('audit:read'));
  const [kinds, setKinds] = useState<Set<TimelineKind>>(new Set());
  const [severities, setSeverities] = useState<Set<TimelineSeverity>>(new Set());
  const [text, setText] = useState('');
  const [query, setQuery] = useState(''); // debounced/applied text

  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [pending, setPending] = useState<TimelineEvent[]>([]); // live events awaiting flush
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const buildParams = useCallback(
    (before?: string) => {
      const p = new URLSearchParams();
      if (kinds.size) p.set('kinds', [...kinds].join(','));
      if (severities.size) p.set('severities', [...severities].join(','));
      if (query.trim()) p.set('text', query.trim());
      if (before) p.set('before', before);
      p.set('limit', '100');
      return p.toString();
    },
    [kinds, severities, query],
  );

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      try {
        const page = await api.get<TimelinePage>(`/api/timeline?${buildParams(before)}`);
        setEvents((prev) => (before ? [...prev, ...page.events] : page.events));
        setCursor(page.nextCursor);
      } catch {
        /* swallow — surfaced as empty state */
      } finally {
        setLoading(false);
      }
    },
    [buildParams],
  );

  // Reload from the top whenever filters change; drop any buffered live events.
  useEffect(() => {
    setPending([]);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kinds, severities, query]);

  // Live tail: subscribe to the SSE stream with the current filters. New events
  // are buffered (shown as a "new events" pill) so they never yank the list the
  // user is reading. Reconnects whenever the filters change.
  useEffect(() => {
    const p = new URLSearchParams();
    if (kinds.size) p.set('kinds', [...kinds].join(','));
    if (severities.size) p.set('severities', [...severities].join(','));
    if (query.trim()) p.set('text', query.trim());
    const es = new EventSource(`/api/timeline/live?${p.toString()}`);
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as TimelineEvent;
        setPending((prev) => (prev.some((e) => e.id === event.id) ? prev : [event, ...prev]));
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kinds, severities, query]);

  const flush = () => {
    setEvents((prev) => {
      const seen = new Set(prev.map((e) => e.id));
      return [...pending.filter((e) => !seen.has(e.id)), ...prev];
    });
    setPending([]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const toggle = <T,>(set: Set<T>, val: T, setter: (s: Set<T>) => void) => {
    const next = new Set(set);
    next.has(val) ? next.delete(val) : next.add(val);
    setter(next);
  };

  return (
    <>
      <PageHeader title="Ship's Log" description="Every event across Cerebro, newest first." />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {allKinds.map((k) => (
          <FilterPill key={k} active={kinds.has(k)} onClick={() => toggle(kinds, k, setKinds)}>
            {KIND_LABEL[k]}
          </FilterPill>
        ))}
        <span className="w-px h-5 bg-border mx-1" />
        {SEVERITIES.map((s) => (
          <FilterPill
            key={s}
            active={severities.has(s)}
            onClick={() => toggle(severities, s, setSeverities)}
            className={severities.has(s) ? undefined : SEVERITY[s].text}
          >
            {SEVERITY[s].label}
          </FilterPill>
        ))}
        <form
          className="ml-auto"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(text);
          }}
        >
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search…"
            className="h-8 w-52"
          />
        </form>
      </div>

      {focusId && <FocusedEvent id={focusId} connectors={connectors} onClose={() => focus(null)} onFocus={focus} />}

      {pending.length > 0 && (
        <div className="flex justify-center mb-3">
          <button
            onClick={flush}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold bg-primary text-primary-foreground shadow-lg hover:opacity-90 transition-opacity"
          >
            <ArrowUp className="h-3.5 w-3.5" />
            {pending.length} new event{pending.length > 1 ? 's' : ''}
          </button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="divide-y divide-border/50">
            {events.map((e) => {
              const sev = SEVERITY[e.severity];
              const target = eventSourceLink(e, connectors)?.to ?? null;
              const isOpen = expanded.has(e.id);
              return (
                <div
                  key={e.id}
                  className={cn(
                    'flex gap-3 px-3 py-2.5 items-start',
                    e.detail && 'cursor-pointer hover:bg-muted/40 transition-colors',
                    e.id === focusId && 'bg-primary/10',
                  )}
                  onClick={() => {
                    if (e.detail) toggle(expanded, e.id, setExpanded);
                  }}
                >
                  {/* severity spine */}
                  <span className={cn('mt-1 w-1 self-stretch rounded-full shrink-0', sev.spine)} aria-hidden />
                  <span className="text-muted-foreground shrink-0 w-36 text-xs tabular-nums pt-0.5">
                    {new Date(e.ts).toLocaleString()}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 w-16 text-[0.65rem] uppercase tracking-wider font-semibold pt-0.5',
                      sev.text,
                    )}
                  >
                    {KIND_LABEL[e.kind]}
                  </span>
                  <div className="flex-1 min-w-0">
                    {/* Inline flow (not a flex row) so a long title wraps and the actor
                        drops to the next line instead of being clipped on narrow widths. */}
                    <div className="text-sm break-words">
                      {e.title}
                      {e.actor?.email && (
                        <span className="text-xs text-muted-foreground whitespace-nowrap"> · {e.actor.email}</span>
                      )}
                    </div>
                    {isOpen && e.detail && (
                      <p className="mt-1 text-xs text-muted-foreground break-words font-mono">{e.detail}</p>
                    )}
                  </div>
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation();
                      focus(e.id);
                    }}
                    className="shrink-0 text-xs text-muted-foreground hover:text-foreground hover:underline pt-0.5"
                  >
                    details
                  </button>
                  {target && (
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation();
                        navigate(target);
                      }}
                      className="shrink-0 text-xs text-accent hover:underline pt-0.5"
                    >
                      open →
                    </button>
                  )}
                </div>
              );
            })}
            {events.length === 0 && !loading && (
              <div className="px-4 py-12 text-center text-muted-foreground">No events match these filters.</div>
            )}
          </div>

          {(cursor || loading) && (
            <div className="p-3 text-center border-t border-border/50">
              <Button variant="ghost" size="sm" disabled={loading} onClick={() => cursor && load(cursor)}>
                {loading ? 'Loading…' : 'Load older'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

/**
 * The entry a link landed on (`/timeline?event=<id>`, e.g. from a dashboard "Needs attention"
 * row): full text, structured fields, where the condition lives, and what the same source
 * logged around it — for an auth rejection, that's the reason line written just before.
 */
function FocusedEvent({
  id,
  connectors,
  onClose,
  onFocus,
}: {
  id: string;
  connectors: ConnectorRef[];
  onClose: () => void;
  onFocus: (id: string) => void;
}) {
  const [data, setData] = useState<TimelineEventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api
      .get<TimelineEventDetail>(`/api/timeline/event/${encodeURIComponent(id)}`)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e instanceof Error ? e.message : 'Could not load this entry.'));
    return () => {
      alive = false;
    };
  }, [id]);

  const e = data?.event;
  const source = e ? eventSourceLink(e, connectors) : null;
  const hints = e ? eventHintLinks(e) : [];
  const metaEntries = Object.entries(e?.meta ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '');

  return (
    <Card className="mb-4 border-primary/40">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start gap-3">
          {e && <span className={cn('mt-1 w-1 self-stretch rounded-full shrink-0', SEVERITY[e.severity].spine)} aria-hidden />}
          <div className="flex-1 min-w-0">
            {e ? (
              <>
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span className={cn('uppercase tracking-wider font-semibold', SEVERITY[e.severity].text)}>
                    {KIND_LABEL[e.kind]} · {SEVERITY[e.severity].label}
                  </span>
                  <span className="tabular-nums">{new Date(e.ts).toLocaleString()}</span>
                  {e.source && <span>· source <span className="font-mono">{e.source}</span></span>}
                  {e.actor?.email && <span>· {e.actor.email}</span>}
                </div>
                <p className="mt-1 text-sm break-words">{e.title}</p>
                {e.detail && <p className="mt-1 text-xs text-muted-foreground break-words font-mono">{e.detail}</p>}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{error ?? 'Loading entry…'}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {e && metaEntries.length > 0 && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-xs pl-4">
            {metaEntries.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="font-mono break-all">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
              </div>
            ))}
          </dl>
        )}

        {e && (
          <div className="pl-4 flex flex-wrap items-center gap-2 text-xs">
            {source ? (
              <Link
                to={source.to}
                className="inline-flex items-center gap-1 rounded-md border border-accent/40 px-2.5 py-1 text-accent hover:bg-accent/10"
              >
                Go to {source.label} <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            ) : (
              <span className="text-muted-foreground">
                {hints.length > 0
                  ? 'This came from a request to Cerebro, not from a connector or monitor, so this entry is where it lives. Related settings:'
                  : 'This has no page of its own; this entry and the lines around it are the full record.'}
              </span>
            )}
            {hints.map((h) => (
              <Link
                key={h.to}
                to={h.to}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-muted-foreground hover:text-foreground hover:bg-muted/40"
              >
                {h.label} <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            ))}
          </div>
        )}

        {data && data.related.length > 0 && (
          <div className="pl-4">
            <p className="text-[0.65rem] uppercase tracking-wider font-semibold text-muted-foreground mb-1">
              Around the same time from {e?.source ?? 'this source'}
            </p>
            <div className="divide-y divide-border/40 rounded-md border border-border/50">
              {data.related.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onFocus(r.id)}
                  className="w-full flex gap-3 px-2 py-1.5 text-left text-xs hover:bg-muted/40"
                >
                  <span className="text-muted-foreground tabular-nums shrink-0 w-20">{new Date(r.ts).toLocaleTimeString()}</span>
                  <span className={cn('shrink-0 w-10 uppercase font-semibold', SEVERITY[r.severity].text)}>{SEVERITY[r.severity].label}</span>
                  <span className="flex-1 min-w-0 break-words">{r.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FilterPill({
  active,
  onClick,
  className,
  children,
}: {
  active: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-3 py-1 rounded-full text-xs font-medium border transition-colors',
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-card border-border text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}
