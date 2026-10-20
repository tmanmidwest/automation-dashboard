import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Server, Boxes, Network, Cpu, Users as UsersIcon, Activity, Clock, DollarSign, TrendingUp, CalendarDays, Archive, HardDrive, ShieldCheck, ShieldAlert, HeartPulse, Gauge, Radio, RefreshCw, AlertTriangle, GripVertical, Eye, EyeOff, Settings2, RotateCcw, Siren, BellOff, X } from 'lucide-react';
import type { VersionInfo, DashboardOverview, MonitorSummary, MonitorStatus, TimelineEvent, TimelineKind, TimelineSeverity, TimelinePage } from '@cerebro/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { cn, formatMoney, shortDateTime } from '@/lib/utils';

// Timeline presentation — web imports only *types* from shared (its CJS build can't
// surface named runtime exports to Rollup), so the label/accent tables live here, in
// lockstep with @cerebro/shared's TIMELINE_KINDS / TIMELINE_SEVERITIES.
const TL_KINDS: TimelineKind[] = ['audit', 'app_log', 'notification', 'job', 'monitor'];
const TL_KIND_LABEL: Record<TimelineKind, string> = {
  audit: 'Audit',
  app_log: 'System',
  notification: 'Alert',
  job: 'Job',
  monitor: 'Monitor',
};
const TL_SEVERITY: Record<TimelineSeverity, { spine: string; text: string; dot: string }> = {
  info: { spine: 'bg-accent', text: 'text-accent', dot: 'hsl(var(--accent))' },
  success: { spine: 'bg-emerald-400', text: 'text-emerald-400', dot: 'hsl(160 84% 55%)' },
  warning: { spine: 'bg-amber-400', text: 'text-amber-400', dot: 'hsl(43 96% 56%)' },
  critical: { spine: 'bg-destructive', text: 'text-destructive', dot: 'hsl(var(--destructive))' },
};

/** Where a timeline row links to, if anywhere (mirrors the Ship's Log). */
function timelineTarget(e: TimelineEvent): string | null {
  if (!e.source) return null;
  if (e.kind === 'monitor') return `/monitors/${e.source}`;
  if (e.kind === 'job' || e.kind === 'notification' || e.kind === 'audit') return `/connectors/${e.source}`;
  return null;
}

function useCountUp(target: number, ms = 700) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const from = n;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      setN(Math.round(from + (target - from) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return n;
}

function uptimeSince(iso?: string): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

function monitorColor(status: MonitorStatus): string {
  if (status === 'up') return 'hsl(160 84% 55%)';
  if (status === 'down') return 'hsl(var(--destructive))';
  if (status === 'pending') return 'hsl(43 96% 56%)';
  return 'hsl(var(--muted-foreground) / 0.6)';
}

/** One compact row in the Monitors / Connectors status panels. */
function StatusRow({ to, title, name, shape, color, glow, hollow, meta, alert }: Omit<StatusItem, 'key' | 'healthy'>) {
  return (
    <Link
      to={to}
      title={title}
      className="flex items-center gap-2.5 rounded-md px-2 py-1 min-h-[40px] sm:min-h-[30px] hover:bg-muted/60 transition-colors"
    >
      <Glyph shape={shape} color={color} glow={glow} hollow={hollow} />
      <span className={cn('text-sm truncate', alert && 'text-destructive')}>{name}</span>
      <span className="ml-auto font-lcars text-[11px] tracking-wider text-muted-foreground shrink-0 tabular-nums">
        {meta}
      </span>
    </Link>
  );
}

/** One entry in a status panel, normalized across monitors and connectors. */
type StatusItem = {
  key: string;
  to: string;
  name: string;
  title?: string;
  shape: 'diamond' | 'dot';
  color: string;
  glow?: boolean;
  hollow?: boolean;
  meta: string;
  /** Healthy items collapse into the glyph strip; the rest stay as full rows. */
  healthy: boolean;
  alert?: boolean;
};

/** The dot/diamond used by both the rows and the collapsed strip. */
function Glyph({ shape, color, glow, hollow }: Pick<StatusItem, 'shape' | 'color' | 'glow' | 'hollow'>) {
  return (
    <span
      className={cn('h-2 w-2 shrink-0', shape === 'diamond' ? 'rotate-45' : 'rounded-full')}
      style={hollow
        ? { border: `1px solid ${color}` }
        : { background: color, boxShadow: glow ? `0 0 6px ${color}` : undefined }}
    />
  );
}

/** Remembers a boolean across reloads; falls back to in-memory if storage is unavailable. */
function usePersistedFlag(key: string, initial = false) {
  const [on, setOn] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? initial : v === '1';
    } catch {
      return initial;
    }
  });
  const set = useCallback((next: boolean) => {
    setOn(next);
    try {
      localStorage.setItem(key, next ? '1' : '0');
    } catch {
      /* private mode / storage disabled — the toggle just won't persist */
    }
  }, [key]);
  return [on, set] as const;
}

/**
 * Status list that collapses the healthy majority into a strip of glyphs, leaving
 * only what needs attention as readable rows. Expandable back to the full list.
 */
function StatusList({ items, storageKey, nominal, unitPlural }: {
  items: StatusItem[];
  storageKey: string;
  /** Shown when nothing needs attention. */
  nominal: string;
  /** e.g. "monitors" — used in the expand affordance. */
  unitPlural: string;
}) {
  const [showAll, setShowAll] = usePersistedFlag(storageKey);
  const attention = items.filter((i) => !i.healthy);
  const healthy = items.filter((i) => i.healthy);

  return (
    <div className="space-y-2">
      {showAll ? (
        <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2 content-start overflow-y-auto max-h-[268px] pr-1">
          {items.map(({ key, healthy: _h, ...row }) => (
            <StatusRow key={key} {...row} />
          ))}
        </div>
      ) : attention.length > 0 ? (
        <div className={cn('grid gap-x-4 gap-y-0.5 content-start', attention.length > 3 && 'sm:grid-cols-2')}>
          {attention.map(({ key, healthy: _h, ...row }) => (
            <StatusRow key={key} {...row} />
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2 px-2 py-1 min-h-[30px] text-sm text-muted-foreground">
          <ShieldCheck className="h-4 w-4 text-emerald-400/80" />
          {nominal}
        </div>
      )}

      <div className="flex items-center gap-2">
        {!showAll && healthy.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {healthy.map((i) => (
              <Link
                key={i.key}
                to={i.to}
                title={i.title ?? `${i.name} · ${i.meta}`}
                aria-label={`${i.name} — ${i.meta}`}
                className="grid h-5 w-5 place-items-center rounded transition-colors hover:bg-muted/60"
              >
                <Glyph shape={i.shape} color={i.color} glow={i.glow} hollow={i.hollow} />
              </Link>
            ))}
          </div>
        )}
        {items.length > attention.length && (
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            className="ml-auto shrink-0 font-lcars text-[11px] tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground"
          >
            {showAll ? 'Collapse ‹' : `All ${items.length} ${unitPlural} ›`}
          </button>
        )}
      </div>
    </div>
  );
}

/** Card shell with the LCARS accent header. */
function Panel({ title, tag, to, accent = 'secondary', children, className }: {
  title: string;
  tag?: React.ReactNode;
  to?: string;
  accent?: 'primary' | 'secondary' | 'accent';
  children: React.ReactNode;
  className?: string;
}) {
  const bar = accent === 'primary' ? 'hsl(var(--primary))' : accent === 'accent' ? 'hsl(var(--accent))' : 'hsl(var(--secondary))';
  return (
    <div className={cn('rounded-xl border border-border/60 bg-card/70 backdrop-blur p-4', className)}>
      <div className="flex items-center gap-2.5 mb-3">
        <span className="h-4 w-2.5 rounded-sm" style={{ background: bar }} aria-hidden />
        <h3 className="font-lcars text-sm font-semibold text-muted-foreground tracking-[0.12em]">{title}</h3>
        {tag && <span className="ml-auto font-lcars text-xs text-muted-foreground tracking-wide">{tag}</span>}
        {to && !tag && (
          <Link to={to} className="ml-auto font-lcars text-xs text-muted-foreground hover:text-foreground tracking-wide">
            View all ›
          </Link>
        )}
      </div>
      {children}
    </div>
  );
}

function StatTile({ icon: Icon, label, value, sub, to }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string; to?: string }) {
  const inner = (
    <>
      <div className="absolute left-0 top-0 h-full w-1 bg-gradient-to-b from-primary to-accent" />
      <div className="flex items-center justify-between">
        <span className="font-lcars text-xs tracking-[0.14em] text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-accent/70" />
      </div>
      <div className="mt-2 font-lcars text-3xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </>
  );
  const base = 'relative overflow-hidden rounded-xl border border-border/60 bg-card/70 p-4 backdrop-blur';
  return to ? (
    <Link to={to} className={cn(base, 'block transition-all hover:border-primary/50 hover:bg-card')}>{inner}</Link>
  ) : (
    <div className={base}>{inner}</div>
  );
}

function GaugeTile({ icon: Icon, label, pct, to }: { icon: React.ComponentType<{ className?: string }>; label: string; pct: number; to?: string }) {
  const color = pct >= 85 ? 'bg-destructive' : pct >= 60 ? 'bg-amber-500' : 'bg-gradient-to-r from-primary to-accent';
  const inner = (
    <>
      <div className="flex items-center justify-between">
        <span className="font-lcars text-xs tracking-[0.14em] text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-accent/70" />
      </div>
      <div className="mt-2 font-lcars text-3xl font-semibold tabular-nums">{pct}%</div>
      <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div className={cn('h-full rounded-full transition-all duration-700', color)} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </>
  );
  const base = 'relative overflow-hidden rounded-xl border border-border/60 bg-card/70 p-4 backdrop-blur';
  return to ? (
    <Link to={to} className={cn(base, 'block transition-all hover:border-primary/50 hover:bg-card')}>{inner}</Link>
  ) : (
    <div className={base}>{inner}</div>
  );
}

/** A single actionable item in the Attention zone (a down connector/monitor, or a recent
 *  warning/critical event). `key` is stable so it can be acknowledged; `critical` drives the
 *  banner colour and the Red Alert klaxon. */
type AttnItem = { key: string; color: string; label: string; detail?: string; to: string | null; critical: boolean };

/** One line in the "Needs attention" banner, with an acknowledge (dismiss) control. */
function AttnRow({ color, label, detail, to, onAck }: { color: string; label: string; detail?: string; to: string | null; onAck?: () => void }) {
  const inner = (
    <>
      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}` }} aria-hidden />
      <span className="text-sm truncate">{label}</span>
      {detail && <span className="ml-auto pl-2 text-xs text-muted-foreground truncate max-w-[40%] shrink-0">{detail}</span>}
    </>
  );
  const cls = 'flex items-center gap-2.5 rounded-md px-2 py-1.5 min-h-[34px] flex-1 min-w-0';
  return (
    <div className="flex items-center gap-1">
      {to ? (
        <Link to={to} className={cn(cls, 'hover:bg-background/40 transition-colors')}>{inner}</Link>
      ) : (
        <div className={cls}>{inner}</div>
      )}
      {onAck && (
        <button
          type="button"
          onClick={onAck}
          title="Acknowledge — hide until it recurs"
          aria-label="Acknowledge"
          className="shrink-0 rounded p-1 text-muted-foreground/70 transition-colors hover:bg-background/40 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// ── Customizable layout (P2 / P2.5) ─────────────────────────────────────────
// The dashboard body is a list of reorderable, hideable widgets. The Attention banner is
// NOT one of them — it stays pinned on top. Order + hidden set persist PER USER on the
// server (GET/PUT /api/account/preferences/dashboard-layout), so the layout follows the
// user across devices rather than living in one browser.
type WidgetId = 'status' | 'activity' | 'telemetry' | 'monitorsSummary' | 'spend' | 'backups';
const DEFAULT_ORDER: WidgetId[] = ['status', 'activity', 'telemetry', 'monitorsSummary', 'spend', 'backups'];
type DashLayout = { order: WidgetId[]; hidden: WidgetId[] };
const LAYOUT_PREF_KEY = 'dashboard-layout';
const DEFAULT_LAYOUT: DashLayout = { order: [...DEFAULT_ORDER], hidden: [] };

/** Coerce a stored (untrusted) preference value into a valid layout, dropping unknown ids and
 *  appending any widgets missing from the saved order (so a newly-added widget never vanishes). */
function normalizeLayout(raw: unknown): DashLayout {
  if (!raw || typeof raw !== 'object') return { order: [...DEFAULT_ORDER], hidden: [] };
  const parsed = raw as Partial<DashLayout>;
  const saved = (parsed.order ?? []).filter((id): id is WidgetId => DEFAULT_ORDER.includes(id as WidgetId));
  const order = [...saved, ...DEFAULT_ORDER.filter((id) => !saved.includes(id))];
  const hidden = (parsed.hidden ?? []).filter((id): id is WidgetId => DEFAULT_ORDER.includes(id as WidgetId));
  return { order, hidden };
}

// ── Refresh cadence (P3) ────────────────────────────────────────────────────
// The widgets don't each have their own feed: telemetry/connectors/spend/backups all come
// from the `overview` poll, monitorsSummary+status share the `monitors` poll, and Activity is
// live SSE. So cadence is tunable per *feed* (what actually hits the API), persisted per-user.
// ms = 0 means "manual only" (just the Refresh button). Stored under `dashboard-cadence`.
type Cadence = { overviewMs: number; monitorsMs: number };
const DEFAULT_CADENCE: Cadence = { overviewMs: 5000, monitorsMs: 10000 };
const CADENCE_PREF_KEY = 'dashboard-cadence';
const OVERVIEW_OPTS: { label: string; ms: number }[] = [
  { label: '5s', ms: 5000 }, { label: '15s', ms: 15000 }, { label: '30s', ms: 30000 }, { label: '60s', ms: 60000 }, { label: 'Manual', ms: 0 },
];
const MONITOR_OPTS: { label: string; ms: number }[] = [
  { label: '10s', ms: 10000 }, { label: '30s', ms: 30000 }, { label: '60s', ms: 60000 }, { label: 'Manual', ms: 0 },
];

function normalizeCadence(raw: unknown): Cadence {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CADENCE };
  const r = raw as Partial<Cadence>;
  const pick = (v: unknown, fallback: number, opts: { ms: number }[]) =>
    typeof v === 'number' && opts.some((o) => o.ms === v) ? v : fallback;
  return {
    overviewMs: pick(r.overviewMs, DEFAULT_CADENCE.overviewMs, OVERVIEW_OPTS),
    monitorsMs: pick(r.monitorsMs, DEFAULT_CADENCE.monitorsMs, MONITOR_OPTS),
  };
}

/** A labelled row of cadence choices (pills) for one feed. */
function CadenceRow({ label, opts, value, onChange }: { label: string; opts: { label: string; ms: number }[]; value: number; onChange: (ms: number) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-lcars text-xs tracking-[0.12em] text-muted-foreground w-44 shrink-0">{label}</span>
      {opts.map((o) => (
        <button
          key={o.ms}
          type="button"
          onClick={() => onChange(o.ms)}
          className={cn(
            'px-2.5 py-0.5 rounded-full text-xs font-medium border transition-colors',
            value === o.ms ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Wraps a dashboard widget. In edit mode it adds a drag handle + hide toggle and becomes a
 *  drag/drop target; otherwise it renders its children transparently. */
function WidgetFrame({ title, editing, hidden, onToggleHidden, onDragStart, onDropOn, children }: {
  title: string;
  editing: boolean;
  hidden: boolean;
  onToggleHidden: () => void;
  onDragStart: () => void;
  onDropOn: () => void;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  if (!editing) return <>{children}</>;
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onDropOn(); }}
      className={cn('rounded-xl border-2 border-dashed p-2 transition-colors', over ? 'border-primary bg-primary/5' : 'border-border/50', hidden && 'opacity-45')}
    >
      <div className="flex items-center gap-2 mb-2 px-1">
        <GripVertical className="h-4 w-4 text-muted-foreground cursor-grab active:cursor-grabbing" />
        <span className="font-lcars text-xs tracking-[0.14em] text-muted-foreground">{title}</span>
        <button
          type="button"
          onClick={onToggleHidden}
          className="ml-auto text-muted-foreground transition-colors hover:text-foreground"
          title={hidden ? 'Show on dashboard' : 'Hide from dashboard'}
        >
          {hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      <div className={cn(hidden && 'pointer-events-none')}>{children}</div>
    </div>
  );
}

export function Dashboard() {
  const { user, can } = useAuth();
  const navigate = useNavigate();
  const canMonitors = can('monitors:read');
  const canAudit = can('audit:read');
  const [monitors, setMonitors] = useState<MonitorSummary[] | null>(null);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [userCount, setUserCount] = useState(0);
  // Live event feed (Ship's Log over SSE): seeded with recent history, then tailed live.
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [live, setLive] = useState(false);
  const startedRef = useRef(Date.now());
  const lastPollRef = useRef(Date.now());
  const gotDataRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [, tick] = useState(0);
  const FEED_CAP = 60;

  // Customizable layout (P2 / P2.5): widget order + hidden set, persisted server-side so it
  // follows the user across devices. The initial GET seeds `layout`; only user actions PUT.
  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState<DashLayout>(DEFAULT_LAYOUT);
  const layoutLoaded = useRef(false);
  const dragId = useRef<WidgetId | null>(null);
  useEffect(() => {
    layoutLoaded.current = false;
    api.get<{ value: unknown }>(`/api/account/preferences/${LAYOUT_PREF_KEY}`)
      .then((r) => setLayout(normalizeLayout(r.value)))
      .catch(() => setLayout(DEFAULT_LAYOUT))
      .finally(() => { layoutLoaded.current = true; });
  }, [user?.id]);
  const persistLayout = useCallback((next: DashLayout) => {
    setLayout(next);
    // Don't echo the server's own value back before the initial load has landed.
    if (layoutLoaded.current) api.put(`/api/account/preferences/${LAYOUT_PREF_KEY}`, { value: next }).catch(() => {});
  }, []);
  const resetLayout = useCallback(() => persistLayout({ order: [...DEFAULT_ORDER], hidden: [] }), [persistLayout]);
  const toggleHidden = useCallback((id: WidgetId) => {
    setLayout((prev) => {
      const next = { ...prev, hidden: prev.hidden.includes(id) ? prev.hidden.filter((x) => x !== id) : [...prev.hidden, id] };
      if (layoutLoaded.current) api.put(`/api/account/preferences/${LAYOUT_PREF_KEY}`, { value: next }).catch(() => {});
      return next;
    });
  }, []);
  const moveWidget = useCallback((from: WidgetId, to: WidgetId) => {
    if (from === to) return;
    setLayout((prev) => {
      const order = prev.order.filter((x) => x !== from);
      const idx = order.indexOf(to);
      order.splice(idx < 0 ? order.length : idx, 0, from);
      const next = { ...prev, order };
      if (layoutLoaded.current) api.put(`/api/account/preferences/${LAYOUT_PREF_KEY}`, { value: next }).catch(() => {});
      return next;
    });
  }, []);

  // P3: acknowledged attention items (session-scoped — hide the current noise; a new
  // occurrence re-surfaces) and the Red Alert klaxon's silence toggle.
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const ackItem = useCallback((key: string) => setAcked((prev) => new Set(prev).add(key)), []);
  const [alarmSilenced, setAlarmSilenced] = useState(false);

  // P3: per-feed refresh cadence, persisted server-side alongside the layout.
  const [cadence, setCadence] = useState<Cadence>(DEFAULT_CADENCE);
  const cadenceLoaded = useRef(false);
  useEffect(() => {
    cadenceLoaded.current = false;
    api.get<{ value: unknown }>(`/api/account/preferences/${CADENCE_PREF_KEY}`)
      .then((r) => setCadence(normalizeCadence(r.value)))
      .catch(() => setCadence(DEFAULT_CADENCE))
      .finally(() => { cadenceLoaded.current = true; });
  }, [user?.id]);
  const setCadencePref = useCallback((next: Cadence) => {
    setCadence(next);
    if (cadenceLoaded.current) api.put(`/api/account/preferences/${CADENCE_PREF_KEY}`, { value: next }).catch(() => {});
  }, []);

  // Core telemetry (connectors + stats) — the fast 5s loop. Activity no longer polls here;
  // it rides the live SSE stream below.
  const pollCore = useCallback(async () => {
    await api.get<DashboardOverview>('/api/connectors/overview').then((data) => {
      lastPollRef.current = Date.now();
      setOverview((prev) => {
        const empty = data.metrics.length === 0 && data.guests.length === 0;
        if (!empty) gotDataRef.current = true;
        // Keep the last good telemetry if a poll momentarily returns nothing.
        if (empty && prev && (prev.metrics.length > 0 || prev.guests.length > 0)) {
          return { ...prev, connectors: data.connectors };
        }
        return data;
      });
    }).catch(() => {});
  }, []);

  // Uptime monitors — their own slower 10s loop (the list endpoint aggregates history).
  const loadMonitors = useCallback(async () => {
    if (!canMonitors) return;
    await api.get<MonitorSummary[]>('/api/monitors').then(setMonitors).catch(() => {});
  }, [canMonitors]);

  // Manual "Refresh" — pulls connectors and monitors at once (the feed is already live).
  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([pollCore(), loadMonitors()]);
    } finally {
      // Keep the spin visible briefly even on a fast response, so the tap registers.
      setTimeout(() => setRefreshing(false), 350);
    }
  }, [pollCore, loadMonitors]);

  useEffect(() => {
    api.get<VersionInfo>('/api/version').then(setVersion).catch(() => {});
    api.get<Array<unknown>>('/api/users').then((u) => setUserCount(u.length)).catch(() => {});
    pollCore();
    // Fast catch-up retries so a transient first-load failure (e.g. the session cookie
    // still settling right after login) recovers in under a second, not on the next tick.
    const retries = [700, 1600, 3000].map((ms) => setTimeout(() => { if (!gotDataRef.current) pollCore(); }, ms));
    // 1s clock drives the relative-time / stale indicator re-renders (independent of the poll).
    const clock = setInterval(() => tick((x) => x + 1), 1000);
    return () => { clearInterval(clock); retries.forEach(clearTimeout); };
  }, [pollCore]);

  // Overview poll — cadence-tunable (0 = manual only, i.e. just the Refresh button).
  useEffect(() => {
    if (cadence.overviewMs <= 0) return;
    const t = setInterval(() => pollCore(), cadence.overviewMs);
    return () => clearInterval(t);
  }, [pollCore, cadence.overviewMs]);

  useEffect(() => {
    if (!canMonitors) return;
    loadMonitors();
    if (cadence.monitorsMs <= 0) return;
    const t = setInterval(loadMonitors, cadence.monitorsMs);
    return () => clearInterval(t);
  }, [canMonitors, loadMonitors, cadence.monitorsMs]);

  // Live activity: backfill recent events, then tail the SSE stream. Audit events are only
  // requested when the operator may read them (the server enforces this too).
  useEffect(() => {
    const kinds = TL_KINDS.filter((k) => k !== 'audit' || canAudit);
    const kindsParam = kinds.join(',');
    let closed = false;

    const backfill = new URLSearchParams({ kinds: kindsParam, limit: '40' });
    api.get<TimelinePage>(`/api/timeline?${backfill.toString()}`)
      .then((pg) => { if (!closed) setEvents(pg.events.slice(0, FEED_CAP)); })
      .catch(() => {});

    const es = new EventSource(`/api/timeline/live?${new URLSearchParams({ kinds: kindsParam }).toString()}`);
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as TimelineEvent;
        setEvents((prev) => (prev.some((e) => e.id === ev.id) ? prev : [ev, ...prev].slice(0, FEED_CAP)));
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => { closed = true; es.close(); };
  }, [canAudit]);

  const monUp = monitors?.filter((m) => m.status === 'up').length ?? 0;
  const monDown = monitors?.filter((m) => m.status === 'down') ?? [];
  const monPending = monitors?.filter((m) => m.status === 'pending').length ?? 0;
  const monPaused = monitors?.filter((m) => m.status === 'paused').length ?? 0;
  const monActive = monitors?.filter((m) => m.enabled && m.uptime24h !== null) ?? [];
  const monAvgUptime = monActive.length > 0 ? monActive.reduce((a, m) => a + (m.uptime24h ?? 0), 0) / monActive.length : null;

  const metric = (k: string) => overview?.metrics.find((m) => m.key === k)?.value ?? 0;
  const costLast = overview?.metrics.find((m) => m.key === 'costLastMonth');
  const costMtd = overview?.metrics.find((m) => m.key === 'costMtd');
  const costEst = overview?.metrics.find((m) => m.key === 'costForecast');
  // Backblaze backup connector tiles (only when a backup connector is present).
  const b2Snapshots = overview?.metrics.find((m) => m.key === 'snapshots');
  const b2Size = overview?.metrics.find((m) => m.key === 'repoSizeGb');
  const b2Cost = overview?.metrics.find((m) => m.key === 'b2CostMonthly');
  const b2LastOk = overview?.metrics.find((m) => m.key === 'b2LastBackupOk');
  const hasBackblaze = !!(b2Snapshots || b2Size || b2LastOk);
  const sources = overview?.sources ?? [];
  const offline = sources.filter((s) => !s.ok);
  const secsSinceScan = Math.floor((Date.now() - lastPollRef.current) / 1000);
  // Only flag "signal lost" when auto-refresh is on, scaled to the chosen cadence so a slow
  // 60s poll doesn't look like an outage at 15s. Manual mode never shows as stale.
  const stale = cadence.overviewMs > 0 && secsSinceScan > Math.max(15, Math.round(cadence.overviewMs / 1000) * 2 + 5);
  const connOk = overview?.connectors.ok ?? 0;
  const connTotal = overview?.connectors.total ?? 0;

  // ── Attention: what needs the operator NOW, surfaced above everything else ──
  // Down connectors + down monitors + recent warning/critical events (auth failures,
  // connector/app errors, delivered alerts). Monitor-kind events are omitted here because
  // down monitors are already listed explicitly, to avoid double-counting.
  const nowMs = Date.now();
  const attnEvents = events
    .filter((e) => e.kind !== 'monitor')
    .filter((e) => (e.severity === 'critical' || e.severity === 'warning') && nowMs - new Date(e.ts).getTime() < 30 * 60_000)
    .slice(0, 6);
  // Unified attention list so each item can be acknowledged (session-scoped) and counted once.
  const attnItemsAll: AttnItem[] = [
    ...offline.map((s): AttnItem => ({ key: `conn:${s.name}`, color: 'hsl(var(--destructive))', label: `Connector offline · ${s.name}`, detail: s.message ?? 'unreachable', to: '/connectors', critical: true })),
    ...monDown.map((m): AttnItem => ({ key: `mon:${m.id}`, color: 'hsl(var(--destructive))', label: `Monitor down · ${m.name}`, detail: m.lastLatencyMs != null ? `${m.lastLatencyMs} ms` : 'no response', to: `/monitors/${m.id}`, critical: true })),
    ...attnEvents.map((e): AttnItem => ({ key: `ev:${e.id}`, color: TL_SEVERITY[e.severity].dot, label: e.title, detail: e.actor?.email ?? TL_KIND_LABEL[e.kind], to: timelineTarget(e), critical: e.severity === 'critical' })),
  ];
  const attnItems = attnItemsAll.filter((i) => !acked.has(i.key));
  const attnCount = attnItems.length;
  const hasCritical = attnItems.some((i) => i.critical);
  // Red Alert: a page-level klaxon when anything critical is unacknowledged. Auto-clears (and
  // re-arms) as criticals come and go; the operator can silence the current alarm.
  useEffect(() => { if (!hasCritical) setAlarmSilenced(false); }, [hasCritical]);
  const redAlert = hasCritical && !alarmSilenced;

  // Normalized rows for the two status panels; healthy entries collapse to glyphs.
  const monitorItems: StatusItem[] = (monitors ?? [])
    .slice()
    .sort((a, b) => rank(a.status) - rank(b.status))
    .map((m) => ({
      key: m.id,
      to: `/monitors/${m.id}`,
      name: m.name,
      title: `${m.name} · ${m.status}${m.lastLatencyMs != null ? ` · ${m.lastLatencyMs} ms` : ''}`,
      shape: 'diamond',
      color: monitorColor(m.status),
      glow: m.status !== 'pending' && m.status !== 'paused',
      hollow: m.status === 'paused',
      meta: m.status === 'up' && m.lastLatencyMs != null ? `${m.lastLatencyMs} ms` : m.status,
      healthy: m.status === 'up' || m.status === 'paused',
      alert: m.status === 'down',
    }));

  const connectorItems: StatusItem[] = sources
    .map((src, i) => ({ src, i }))
    .sort((a, b) => Number(a.src.ok) - Number(b.src.ok))
    .map(({ src, i }) => ({
      key: String(i),
      to: '/connectors',
      name: src.name,
      title: src.message ?? `${src.name} · ${src.ok ? 'online' : 'unreachable'}`,
      shape: 'dot',
      color: src.ok ? 'hsl(160 84% 55%)' : 'hsl(var(--destructive))',
      glow: src.ok,
      meta: src.ok ? 'online' : 'offline',
      healthy: src.ok,
      alert: !src.ok,
    }));

  const vms = useCountUp(metric('vmsRunning'));
  const cts = useCountUp(metric('ctsRunning'));
  const nodes = useCountUp(metric('nodes'));
  const ops = useCountUp(userCount);

  // ── Widget registry — the reorderable body. `available` hides a widget whose data is
  // absent (e.g. no cloud spend). Order + visibility come from `layout`. ──
  const widgets: Record<WidgetId, { title: string; available: boolean; node: React.ReactNode }> = {
    status: {
      title: 'Monitors & Connectors',
      available: true,
      node: (
        <div className={cn('grid gap-4', canMonitors && 'lg:grid-cols-2')}>
          {canMonitors && (
            <Panel
              title="Monitors"
              to="/monitors"
              accent="primary"
              tag={monitors && monitors.length > 0 ? (
                <span className="tabular-nums">
                  {monDown.length > 0 && <span className="text-destructive">{monDown.length} down · </span>}
                  {monUp}/{monitors.length - monPaused} up
                </span>
              ) : undefined}
            >
              {monitorItems.length > 0 ? (
                <StatusList
                  items={monitorItems}
                  storageKey="cerebro.dash.monitors.showAll"
                  nominal="All monitors reporting."
                  unitPlural="monitors"
                />
              ) : (
                <div className="grid place-items-center text-center text-sm text-muted-foreground py-8">
                  {monitors ? 'No monitors configured.' : 'Loading monitors…'}
                </div>
              )}
            </Panel>
          )}

          <Panel
            title="Connectors"
            to="/connectors"
            accent="accent"
            tag={<span className="tabular-nums">{offline.length > 0 && <span className="text-destructive">{offline.length} down · </span>}{connOk}/{connTotal} up</span>}
            className={cn(offline.length > 0 && 'border-amber-500/40')}
          >
            {connectorItems.length === 0 ? (
              <div className="grid place-items-center text-center text-sm text-muted-foreground py-8">
                {overview ? 'No connectors configured.' : 'Scanning…'}
              </div>
            ) : (
              <StatusList
                items={connectorItems}
                storageKey="cerebro.dash.connectors.showAll"
                nominal="All connectors online."
                unitPlural="connectors"
              />
            )}
          </Panel>
        </div>
      ),
    },

    activity: {
      title: 'Live Activity',
      available: true,
      node: (
        <Panel
          title="Live Activity"
          accent="primary"
          tag={
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1.5">
                <span className={cn('h-1.5 w-1.5 rounded-full', live ? 'bg-emerald-400 animate-pulse' : 'bg-muted-foreground')} />
                {live ? 'LIVE' : 'OFFLINE'}
              </span>
              <span className="flex items-center gap-1.5"><UsersIcon className="h-3.5 w-3.5" /> {ops}</span>
              <Link to="/timeline" className="hover:text-foreground">View all ›</Link>
            </span>
          }
        >
          <div className="max-h-[320px] overflow-y-auto -mx-1">
            {events.length === 0 ? (
              <div className="text-center text-muted-foreground py-6 text-sm">Waiting for events…</div>
            ) : (
              <div className="divide-y divide-border/40">
                {events.map((e) => {
                  const sev = TL_SEVERITY[e.severity];
                  const target = timelineTarget(e);
                  return (
                    <div
                      key={e.id}
                      className={cn('flex gap-2.5 px-2 py-1.5 items-start animate-fade-in', target && 'cursor-pointer hover:bg-muted/40 transition-colors')}
                      onClick={target ? () => navigate(target) : undefined}
                    >
                      <span className={cn('mt-0.5 w-1 self-stretch rounded-full shrink-0', sev.spine)} aria-hidden />
                      <span className="text-muted-foreground/70 shrink-0 w-[4.5rem] text-xs tabular-nums pt-0.5">
                        {new Date(e.ts).toLocaleTimeString()}
                      </span>
                      <span className={cn('shrink-0 w-14 text-[0.6rem] uppercase tracking-wider font-semibold pt-1', sev.text)}>
                        {TL_KIND_LABEL[e.kind]}
                      </span>
                      <div className="flex-1 min-w-0 text-sm break-words">
                        {e.title}
                        {e.actor?.email && <span className="text-xs text-muted-foreground"> · {e.actor.email}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Panel>
      ),
    },

    telemetry: {
      title: 'Infrastructure',
      available: true,
      node: (
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <StatTile icon={Server} label="VMs running" value={String(vms)} sub={`${metric('vmsTotal')} total`} to="/overview/vm" />
          <StatTile icon={Boxes} label="Containers" value={String(cts)} sub={`${metric('ctsTotal')} total`} to="/overview/container" />
          <StatTile icon={Network} label="Nodes online" value={String(nodes)} sub="cluster" to="/overview/nodes" />
          <GaugeTile icon={Cpu} label="Cluster CPU" pct={metric('cpuPct')} to="/overview/nodes" />
          <GaugeTile icon={Activity} label="Cluster RAM" pct={metric('memPct')} to="/overview/nodes" />
          <StatTile icon={Clock} label="Core uptime" value={uptimeSince(version?.builtAt ?? new Date(startedRef.current).toISOString())} sub={version ? `v${version.version}` : 'online'} />
        </div>
      ),
    },

    monitorsSummary: {
      title: 'Monitor summary',
      available: !!(monitors && monitors.length > 0),
      node: (
        <div>
          <div className="flex items-center gap-2 mb-2 font-lcars text-xs tracking-[0.14em] text-muted-foreground">
            <HeartPulse className="h-3.5 w-3.5 text-accent" /> Monitors
          </div>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
            <StatTile
              icon={HeartPulse}
              label="Monitors up"
              value={`${monUp} / ${(monitors?.length ?? 0) - monPaused}`}
              sub={[monPending > 0 ? `${monPending} pending` : null, monPaused > 0 ? `${monPaused} paused` : null].filter(Boolean).join(' · ') || 'all checks reporting'}
              to="/monitors"
            />
            <StatTile
              icon={monDown.length > 0 ? ShieldAlert : ShieldCheck}
              label="Down now"
              value={monDown.length === 0 ? 'None' : String(monDown.length)}
              sub={monDown.length === 0 ? 'nothing failing' : monDown.slice(0, 3).map((m) => m.name).join(', ') + (monDown.length > 3 ? ` +${monDown.length - 3} more` : '')}
              to={monDown.length === 1 ? `/monitors/${monDown[0].id}` : '/monitors'}
            />
            <StatTile
              icon={Gauge}
              label="Uptime 24h"
              value={monAvgUptime === null ? '—' : `${(monAvgUptime * 100).toFixed(monAvgUptime >= 0.9995 ? 0 : 2)}%`}
              sub={monActive.length > 0 ? `average across ${monActive.length} monitor${monActive.length === 1 ? '' : 's'}` : 'no history yet'}
              to="/monitors"
            />
          </div>
        </div>
      ),
    },

    spend: {
      title: 'Cloud spend',
      available: !!costMtd,
      node: costMtd ? (
        <div>
          <div className="flex items-center gap-2 mb-2 font-lcars text-xs tracking-[0.14em] text-muted-foreground">
            <DollarSign className="h-3.5 w-3.5 text-accent" /> Cloud spend
            {costMtd.asOf && <span className="ml-auto normal-case tracking-normal text-muted-foreground/60 font-sans">as of {shortDateTime(costMtd.asOf)}</span>}
          </div>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
            {costLast && (
              <StatTile icon={CalendarDays} label="Last month" value={formatMoney(costLast.value, costLast.unit)} sub="previous month total" to="/connectors" />
            )}
            <StatTile icon={DollarSign} label="Spend so far" value={formatMoney(costMtd.value, costMtd.unit)} sub="month to date" to="/connectors" />
            {costEst && (
              <StatTile icon={TrendingUp} label="Est. this month" value={formatMoney(costEst.value, costEst.unit)} sub="forecast" to="/connectors" />
            )}
          </div>
        </div>
      ) : null,
    },

    backups: {
      title: 'Backups',
      available: hasBackblaze,
      node: (
        <div>
          <div className="flex items-center gap-2 mb-2 font-lcars text-xs tracking-[0.14em] text-muted-foreground">
            <Archive className="h-3.5 w-3.5 text-accent" /> Backups
            {b2LastOk?.asOf && <span className="ml-auto normal-case tracking-normal text-muted-foreground/60 font-sans">as of {shortDateTime(b2LastOk.asOf)}</span>}
          </div>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
            <StatTile
              icon={b2LastOk ? (b2LastOk.value ? ShieldCheck : ShieldAlert) : Archive}
              label="Last backup"
              value={b2LastOk?.asOf ? shortDateTime(b2LastOk.asOf) : '—'}
              sub={b2LastOk ? (b2LastOk.value ? 'succeeded' : 'FAILED — check the connector') : 'no backups yet'}
              to="/connectors"
            />
            <StatTile
              icon={HardDrive}
              label="Backup size"
              value={b2Size ? `${b2Size.value} GB` : '—'}
              sub={b2Snapshots ? `${b2Snapshots.value} snapshot${b2Snapshots.value === 1 ? '' : 's'} in B2` : 'in Backblaze B2'}
              to="/connectors"
            />
            {b2Cost && (
              <StatTile icon={DollarSign} label="Est. monthly cost" value={formatMoney(b2Cost.value, b2Cost.unit)} sub="B2 storage, estimated" to="/connectors" />
            )}
          </div>
        </div>
      ),
    },
  };

  // Auto-bubble (P3): a widget with an active problem floats to the top in view mode, without
  // disturbing the user's saved order. Edit mode shows the raw saved order so drag is predictable.
  const widgetHasIssue = (id: WidgetId): boolean => {
    if (id === 'status') return offline.length > 0 || monDown.length > 0;
    if (id === 'monitorsSummary') return monDown.length > 0;
    if (id === 'backups') return !!b2LastOk && b2LastOk.value === false;
    return false;
  };
  const renderOrder = editing
    ? layout.order
    : [...layout.order.filter(widgetHasIssue), ...layout.order.filter((id) => !widgetHasIssue(id))];

  return (
    <div className="animate-fade-in space-y-4">
      {/* Red Alert (P3): a pulsing red vignette + klaxon bar whenever something critical is
          unacknowledged. Silenceable; re-arms when a new critical appears. */}
      {redAlert && (
        <div
          className="pointer-events-none fixed inset-0 z-40 animate-pulse"
          style={{ boxShadow: 'inset 0 0 120px hsl(var(--destructive) / 0.35)' }}
          aria-hidden
        />
      )}
      {redAlert && (
        <div className="flex items-center gap-2.5 rounded-xl border border-destructive/60 bg-destructive/10 px-4 py-2.5 animate-pulse">
          <Siren className="h-5 w-5 text-destructive shrink-0" />
          <span className="font-lcars text-sm font-semibold tracking-[0.2em] text-destructive">RED ALERT</span>
          <span className="font-lcars text-xs tracking-[0.14em] text-destructive/80 tabular-nums">
            {attnItems.filter((i) => i.critical).length} critical
          </span>
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => setAlarmSilenced(true)}>
            <BellOff className="h-4 w-4" />
            Silence
          </Button>
        </div>
      )}
      <div className="flex items-start gap-3">
        <span className="lcars-accentbar mt-2" aria-hidden />
        <div>
          <div className="flex items-center gap-2 font-lcars text-xs tracking-[0.24em] text-accent/80">
            <span className={cn('h-1.5 w-1.5 rounded-full', stale ? 'bg-destructive animate-pulse' : 'bg-emerald-400 animate-pulse')} />
            {stale ? 'Signal lost' : 'Scanning'} · {connOk}/{connTotal} systems linked
          </div>
          <h1 className="font-lcars text-3xl font-semibold leading-none mt-1">
            Welcome back, {user?.displayName?.split(' ')[0] ?? 'Operator'}
          </h1>
        </div>
        <div className="ml-auto mt-1 flex items-center gap-2">
          {editing && (
            <Button variant="ghost" size="sm" onClick={resetLayout} aria-label="Reset dashboard layout">
              <RotateCcw className="h-4 w-4" />
              Reset
            </Button>
          )}
          <Button
            variant={editing ? 'default' : 'outline'}
            size="sm"
            onClick={() => setEditing((v) => !v)}
            aria-label={editing ? 'Finish editing layout' : 'Edit dashboard layout'}
          >
            <Settings2 className="h-4 w-4" />
            {editing ? 'Done' : 'Edit layout'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refreshAll()}
            disabled={refreshing}
            aria-label="Refresh telemetry now"
          >
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {editing && (
        <div className="space-y-3">
          <p className="rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Drag the <GripVertical className="inline h-3.5 w-3.5 align-text-bottom" /> handle to reorder panels, or use the eye to hide one. The Attention banner always stays on top. Changes save automatically for your account.
          </p>
          <div className="rounded-lg border border-border/50 bg-muted/20 p-3 space-y-2">
            <div className="font-lcars text-xs tracking-[0.16em] text-muted-foreground">REFRESH RATES</div>
            <CadenceRow
              label="Telemetry & connectors"
              opts={OVERVIEW_OPTS}
              value={cadence.overviewMs}
              onChange={(ms) => setCadencePref({ ...cadence, overviewMs: ms })}
            />
            <CadenceRow
              label="Monitors"
              opts={MONITOR_OPTS}
              value={cadence.monitorsMs}
              onChange={(ms) => setCadencePref({ ...cadence, monitorsMs: ms })}
            />
            <p className="text-xs text-muted-foreground">Live Activity streams in real time (SSE) — no polling to tune. "Manual" refreshes only via the Refresh button.</p>
          </div>
        </div>
      )}

      {/* ── Attention zone — always first; the sensitive/important content up top ── */}
      {attnCount === 0 ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-2.5">
          <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
          <span className="font-lcars text-sm tracking-[0.14em] text-emerald-300/90">ALL SYSTEMS NOMINAL</span>
          <span className="ml-auto flex items-center gap-1.5 font-lcars text-[11px] tracking-[0.14em] text-muted-foreground">
            <span className={cn('h-1.5 w-1.5 rounded-full', live ? 'bg-emerald-400 animate-pulse' : 'bg-muted-foreground')} />
            {live ? 'LIVE' : 'RECONNECTING'}
          </span>
        </div>
      ) : (
        <div className={cn('rounded-xl border p-4', hasCritical ? 'border-destructive/50 bg-destructive/5' : 'border-amber-500/40 bg-amber-500/5')}>
          <div className="flex items-center gap-2.5 mb-2">
            <AlertTriangle className={cn('h-4 w-4 shrink-0', hasCritical ? 'text-destructive' : 'text-amber-400')} />
            <h3 className="font-lcars text-sm font-semibold tracking-[0.14em]">NEEDS ATTENTION</h3>
            <span className="ml-auto flex items-center gap-2 font-lcars text-[11px] tracking-[0.14em] text-muted-foreground tabular-nums">
              <span className="flex items-center gap-1.5">
                <span className={cn('h-1.5 w-1.5 rounded-full', live ? 'bg-emerald-400 animate-pulse' : 'bg-muted-foreground')} />
                {live ? 'LIVE' : 'RECONNECTING'}
              </span>
              · {attnCount} item{attnCount > 1 ? 's' : ''}
            </span>
          </div>
          <div className="grid gap-1 sm:grid-cols-2">
            {attnItems.map((i) => (
              <AttnRow key={i.key} color={i.color} label={i.label} detail={i.detail} to={i.to} onAck={() => ackItem(i.key)} />
            ))}
          </div>
        </div>
      )}

      {/* ── Reorderable widget body (auto-bubbles problem widgets up in view mode) ── */}
      {renderOrder.map((id) => {
        const w = widgets[id];
        if (!w || !w.available) return null;
        const hidden = layout.hidden.includes(id);
        if (hidden && !editing) return null;
        return (
          <WidgetFrame
            key={id}
            title={w.title}
            editing={editing}
            hidden={hidden}
            onToggleHidden={() => toggleHidden(id)}
            onDragStart={() => { dragId.current = id; }}
            onDropOn={() => { if (dragId.current) moveWidget(dragId.current, id); dragId.current = null; }}
          >
            {w.node}
          </WidgetFrame>
        );
      })}

      <div className="flex items-center justify-center gap-2 pt-1 text-[11px] font-lcars tracking-[0.2em] text-muted-foreground/50">
        <Radio className="h-3 w-3" /> Cerebro Core · LCARS
      </div>
    </div>
  );
}

/** Down first, then pending, up, paused. */
function rank(s: MonitorStatus): number {
  return { down: 0, pending: 1, up: 2, paused: 3 }[s] ?? 4;
}
