import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Server, Boxes, Activity, HeartPulse, Radio, Play, Pause, LogOut, ChevronRight, ShieldAlert, ShieldCheck, RefreshCw,
} from 'lucide-react';
import type { DashboardOverview, MonitorSummary, MonitorStatus, AuditLogEntry, VersionInfo } from '@cerebro/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { cn } from '@/lib/utils';

/* ── kiosk config ── */
const CYCLE_MS = 12000;
type ViewId = 'ops' | 'signals' | 'monitors' | 'activity';
const VIEWS: { id: ViewId; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'ops', label: 'Ops', icon: Radio },
  { id: 'signals', label: 'Signals', icon: Server },
  { id: 'monitors', label: 'Monitors', icon: HeartPulse },
  { id: 'activity', label: 'Activity', icon: Activity },
];

function guestColor(kind: string): string {
  if (kind === 'ec2') return 'hsl(32 95% 56%)';
  if (kind === 'lxc') return 'hsl(var(--accent))';
  if (kind === 'qemu') return 'hsl(var(--primary))';
  return 'hsl(var(--accent) / 0.7)';
}

/** Compute resources whose running/stopped state is meaningful for the "active" ratio. */
const COMPUTE_KINDS = new Set(['qemu', 'lxc', 'ec2']);

/** Reduce any connector's status string to up / down / idle for the status dot. */
function signalState(status: string): 'up' | 'down' | 'idle' {
  const s = status.toLowerCase();
  if (['running', 'on', 'active', 'available', 'in-use', 'enabled', 'playing', 'home', 'online', 'up', 'ok', 'success', 'backed up', 'healthy'].includes(s)) return 'up';
  if (['error', 'failed', 'down', 'unavailable', 'unreachable', 'critical', 'stopped-error'].includes(s)) return 'down';
  return 'idle';
}
function signalDotColor(status: string): string {
  const t = signalState(status);
  return t === 'up' ? 'hsl(160 84% 55%)' : t === 'down' ? 'hsl(var(--destructive))' : 'hsl(var(--muted-foreground) / 0.5)';
}
/** List order: problems first (down, then idle/stopped), running last. */
function signalRank(status: string): number {
  return { down: 0, idle: 1, up: 2 }[signalState(status)] ?? 1;
}
function guestTo(kind: string): string {
  if (kind === 'qemu') return '/overview/vm';
  if (kind === 'lxc') return '/overview/container';
  return '/connectors';
}
function monitorColor(s: MonitorStatus): string {
  if (s === 'up') return 'hsl(160 84% 55%)';
  if (s === 'down') return 'hsl(var(--destructive))';
  if (s === 'pending') return 'hsl(43 96% 56%)';
  return 'hsl(var(--muted-foreground) / 0.6)';
}
function rank(s: MonitorStatus): number {
  return { down: 0, pending: 1, up: 2, paused: 3 }[s] ?? 4;
}

const SEGMENTS = 24;

/**
 * Semantic direction of a meter:
 *  - `load`   — higher is worse (CPU, RAM, disk, temp, spend)
 *  - `health` — higher is better (systems online, monitors up)
 *  - `neutral`— no good/bad reading (e.g. active vs idle signals)
 */
type Polarity = 'load' | 'health' | 'neutral';

const GREEN = 'hsl(160 84% 55%)';
const AMBER = 'hsl(38 92% 55%)';
const RED = 'hsl(var(--destructive))';
const CYAN = 'hsl(var(--accent))';

/** Traffic-light colour for a value, respecting the metric's polarity. */
function toneColor(pct: number, polarity: Polarity): string {
  if (polarity === 'neutral') return CYAN;
  const sev = polarity === 'load'
    ? (pct > 85 ? 2 : pct > 70 ? 1 : 0)   // higher = worse
    : (pct >= 90 ? 0 : pct >= 60 ? 1 : 2); // higher = better
  return sev === 2 ? RED : sev === 1 ? AMBER : GREEN;
}

/** Large glanceable readout meter for the kiosk. */
function BigMeter({ name, pct, polarity = 'load' }: { name: string; pct: number; polarity?: Polarity }) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const on = Math.round((clamped / 100) * SEGMENTS);
  const col = toneColor(clamped, polarity);
  return (
    <div className="grid grid-cols-[minmax(150px,220px)_1fr_84px] items-center gap-4">
      <span className="font-lcars text-xl text-muted-foreground">{name}</span>
      <div className="h-6 rounded-lg bg-muted flex gap-[3px] p-[3px] overflow-hidden">
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <span key={i} className="flex-1 rounded-[2px]"
            style={{ background: i < on ? col : 'hsl(var(--secondary))', opacity: i < on ? 1 : 0.28 }} />
        ))}
      </div>
      <span className="font-lcars text-2xl font-semibold tabular-nums text-right" style={{ color: col }}>{clamped}%</span>
    </div>
  );
}

function KioskStat({ n, label, tone }: { n: string; label: string; tone: 'ok' | 'info' | 'warn' | 'crit' }) {
  const color = tone === 'ok' ? 'hsl(160 84% 55%)' : tone === 'warn' ? 'hsl(38 92% 55%)' : tone === 'crit' ? 'hsl(var(--destructive))' : 'hsl(var(--accent))';
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-card/70 p-5">
      <div className="absolute left-0 top-0 h-full w-1.5" style={{ background: color }} />
      <div className="font-lcars text-6xl font-bold tabular-nums leading-none" style={{ color }}>{n}</div>
      <div className="font-lcars text-sm tracking-[0.14em] text-muted-foreground mt-2">{label}</div>
    </div>
  );
}

export function Panel() {
  const { user, can } = useAuth();
  const canMonitors = can('monitors:read');
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [monitors, setMonitors] = useState<MonitorSummary[] | null>(null);
  const [audit, setAudit] = useState<AuditLogEntry[]>([]);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [view, setView] = useState<ViewId>('ops');
  const [auto, setAuto] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const lastPollRef = useRef(Date.now());

  // Core telemetry (connectors + activity) — the fast 5s loop.
  const pollCore = useCallback(async () => {
    await Promise.all([
      api.get<DashboardOverview>('/api/connectors/overview').then((d) => { lastPollRef.current = Date.now(); setOverview(d); }).catch(() => {}),
      api.get<AuditLogEntry[]>('/api/logs/audit?limit=20').then(setAudit).catch(() => {}),
    ]);
  }, []);

  // Monitors — their own slower 10s loop.
  const loadMonitors = useCallback(async () => {
    if (!canMonitors) return;
    await api.get<MonitorSummary[]>('/api/monitors').then(setMonitors).catch(() => {});
  }, [canMonitors]);

  // Manual "Refresh now" — pulls everything at once.
  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([pollCore(), loadMonitors()]);
    } finally {
      // Keep the spin visible briefly even on a fast response, so the tap registers.
      setTimeout(() => setRefreshing(false), 350);
    }
  }, [pollCore, loadMonitors]);

  // Fast loop: connectors + activity every 5s.
  useEffect(() => {
    api.get<VersionInfo>('/api/version').then(setVersion).catch(() => {});
    pollCore();
    const t = setInterval(pollCore, 5000);
    return () => clearInterval(t);
  }, [pollCore]);

  // Slow loop: monitors every 10s.
  useEffect(() => {
    if (!canMonitors) return;
    loadMonitors();
    const t = setInterval(loadMonitors, 10000);
    return () => clearInterval(t);
  }, [canMonitors, loadMonitors]);

  // Clock.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Auto-cycle the views.
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => {
      setView((v) => {
        const avail = VIEWS.filter((x) => x.id !== 'monitors' || canMonitors);
        const idx = avail.findIndex((x) => x.id === v);
        return avail[(idx + 1) % avail.length].id;
      });
    }, CYCLE_MS);
    return () => clearInterval(t);
  }, [auto, canMonitors]);

  const metric = (k: string) => overview?.metrics.find((m) => m.key === k)?.value ?? 0;
  const guests = overview?.guests ?? [];
  const computeGuests = guests.filter((g) => COMPUTE_KINDS.has(g.kind));
  const running = computeGuests.filter((g) => g.status === 'running').length;
  const connOk = overview?.connectors.ok ?? 0;
  const connTotal = overview?.connectors.total ?? 0;
  const offline = (overview?.sources ?? []).filter((s) => !s.ok);
  const stale = Math.floor((Date.now() - lastPollRef.current) / 1000) > 15;

  const monUp = monitors?.filter((m) => m.status === 'up').length ?? 0;
  const monDown = monitors?.filter((m) => m.status === 'down') ?? [];
  const monPaused = monitors?.filter((m) => m.status === 'paused').length ?? 0;
  const monDenom = monitors ? monitors.length - monPaused : 0;

  const readout: { name: string; pct: number; polarity: Polarity }[] = [
    { name: 'Cluster CPU', pct: metric('cpuPct'), polarity: 'load' },
    { name: 'Cluster RAM', pct: metric('memPct'), polarity: 'load' },
    { name: 'Systems Online', pct: connTotal ? (connOk / connTotal) * 100 : 0, polarity: 'health' },
    { name: 'Signals Active', pct: computeGuests.length ? (running / computeGuests.length) * 100 : 0, polarity: 'neutral' },
  ];
  if (monitors && monitors.length > 0) readout.push({ name: 'Monitors Up', pct: monDenom ? (monUp / monDenom) * 100 : 100, polarity: 'health' });

  const activeTitle = VIEWS.find((v) => v.id === view)?.label ?? 'Ops';

  return (
    <div className="fixed inset-0 flex flex-col p-3 gap-3 bg-background text-foreground select-none">
      {/* Header: elbow + sweep */}
      <header className="flex gap-3 h-[72px] shrink-0">
        <div className="w-52 shrink-0 lcars-elbow flex items-end justify-end pr-5 pb-3">
          <span className="font-lcars font-bold leading-none text-3xl">CEREBRO</span>
        </div>
        <div className="lcars-sweep flex-1 flex items-center gap-4 px-6 rounded-tr-xl">
          <span className="font-lcars text-3xl font-semibold text-[hsl(210_40%_96%)]">{activeTitle}</span>
          <div className="ml-auto flex items-center gap-3">
            <span className={cn('flex items-center gap-2 lcars-chip', stale && '!text-[hsl(var(--destructive))]')}>
              <span className={cn('h-2 w-2 rounded-full', stale ? 'bg-destructive animate-pulse' : 'bg-emerald-400 animate-pulse')} />
              {stale ? 'SIGNAL LOST' : `${connOk}/${connTotal} LINKED`}
            </span>
            <button
              onClick={() => refreshAll()}
              disabled={refreshing}
              className="lcars-chip inline-flex items-center gap-2 h-9 hover:brightness-125 disabled:opacity-70 transition"
              title="Refresh now"
              aria-label="Refresh telemetry now"
            >
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
              <span className="hidden md:inline">Refresh</span>
            </button>
            <span className="lcars-chip tabular-nums text-base">{now.toLocaleTimeString('en-GB')}</span>
          </div>
        </div>
      </header>

      {/* Body: big rail + content */}
      <div className="flex-1 flex gap-3 min-h-0">
        <nav className="w-52 shrink-0 flex flex-col gap-2.5">
          {VIEWS.filter((v) => v.id !== 'monitors' || canMonitors).map((v) => (
            <button
              key={v.id}
              onClick={() => { setView(v.id); setAuto(false); }}
              className="lcars-pill !min-h-[72px] !text-2xl justify-between"
              data-active={view === v.id}
              style={view === v.id ? { background: 'hsl(var(--primary))', color: 'hsl(222 47% 8%)' } : undefined}
            >
              <v.icon className="h-6 w-6 shrink-0" />
              <span>{v.label}</span>
            </button>
          ))}

          <div className="flex-1" />

          <button
            onClick={() => setAuto((a) => !a)}
            className="lcars-pill !min-h-[60px] !text-xl justify-between"
            style={{ background: auto ? 'hsl(var(--accent))' : 'hsl(var(--secondary))', color: auto ? 'hsl(222 47% 8%)' : undefined }}
          >
            {auto ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
            <span>{auto ? 'Auto' : 'Paused'}</span>
          </button>
          <Link to="/" className="lcars-pill !min-h-[60px] !text-xl justify-between" style={{ background: 'hsl(var(--secondary))' }}>
            <LogOut className="h-5 w-5" />
            <span>Exit</span>
          </Link>
        </nav>

        {/* Auto-cycle progress + content */}
        <main className="flex-1 min-w-0 flex flex-col gap-2">
          <div className="h-1 rounded-full bg-muted overflow-hidden shrink-0">
            {auto && <div key={view} className="h-full bg-accent/70" style={{ animation: `cb-kiosk-progress ${CYCLE_MS}ms linear` }} />}
          </div>

          <div className="flex-1 min-h-0 rounded-2xl border border-border/60 bg-card/30 p-5 overflow-auto">
            {/* ── OPS ── */}
            {view === 'ops' && (
              <div className="flex flex-col gap-5 h-full">
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <KioskStat n={`${connOk}/${connTotal}`} label="Systems online" tone={offline.length ? 'warn' : 'ok'} />
                  <KioskStat n={`${running}`} label="Signals active" tone="info" />
                  {monitors && <KioskStat n={`${monUp}/${monDenom}`} label="Monitors up" tone={monDown.length ? 'crit' : 'ok'} />}
                  <KioskStat n={offline.length ? `${offline.length}` : 'OK'} label={offline.length ? 'Systems offline' : 'All nominal'} tone={offline.length ? 'crit' : 'ok'} />
                </div>
                <div className="flex-1 rounded-xl border border-border/50 bg-card/60 p-6 flex flex-col justify-center gap-4">
                  <div className="font-lcars text-sm tracking-[0.16em] text-muted-foreground mb-1">System Readout</div>
                  {readout.map((r) => <BigMeter key={r.name} name={r.name} pct={r.pct} polarity={r.polarity} />)}
                </div>
              </div>
            )}

            {/* ── SIGNALS ── */}
            {view === 'signals' && (
              computeGuests.length === 0
                ? <Empty label="No signals detected" />
                : <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
                    {[...computeGuests].sort((a, b) => signalRank(a.status) - signalRank(b.status)).map((g, i) => (
                      <Link key={i} to={guestTo(g.kind)} title={g.status}
                        className="rounded-xl border border-border/60 bg-card/70 p-4 flex items-center gap-3 hover:border-primary/50 transition-colors"
                        style={{ borderLeft: `5px solid ${signalDotColor(g.status)}` }}>
                        <span className="h-3 w-3 rounded-full shrink-0"
                          style={{ background: signalDotColor(g.status), boxShadow: signalState(g.status) === 'up' ? `0 0 8px ${signalDotColor(g.status)}` : undefined }} />
                        {g.kind === 'lxc' ? <Boxes className="h-5 w-5 shrink-0" style={{ color: guestColor(g.kind) }} /> : <Server className="h-5 w-5 shrink-0" style={{ color: guestColor(g.kind) }} />}
                        <div className="min-w-0">
                          <div className="font-lcars text-lg truncate">{g.name}</div>
                          <div className="text-xs text-muted-foreground truncate">{g.node} · {g.kind}</div>
                        </div>
                      </Link>
                    ))}
                  </div>
            )}

            {/* ── MONITORS ── */}
            {view === 'monitors' && (
              !monitors || monitors.length === 0
                ? <Empty label="No monitors configured" />
                : <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
                    {[...monitors].sort((a, b) => rank(a.status) - rank(b.status)).map((m) => (
                      <Link key={m.id} to={`/monitors/${m.id}`}
                        className="rounded-xl border border-border/60 bg-card/70 p-4 hover:border-primary/50 transition-colors"
                        style={{ borderLeft: `5px solid ${monitorColor(m.status)}` }}>
                        <div className="flex items-center gap-2.5">
                          <span className="h-3 w-3 rotate-45 shrink-0" style={{ background: monitorColor(m.status), boxShadow: `0 0 8px ${monitorColor(m.status)}` }} />
                          <span className="font-lcars text-lg truncate flex-1">{m.name}</span>
                          <ChevronRight className="h-5 w-5 text-muted-foreground/50" />
                        </div>
                        <div className="flex items-center justify-between mt-2 text-sm">
                          <span className="font-lcars uppercase tracking-wide" style={{ color: monitorColor(m.status) }}>{m.status}</span>
                          <span className="text-muted-foreground tabular-nums">
                            {m.status === 'up' && m.lastLatencyMs != null ? `${m.lastLatencyMs} ms` : m.uptime24h != null ? `${(m.uptime24h * 100).toFixed(1)}%` : '—'}
                          </span>
                        </div>
                      </Link>
                    ))}
                  </div>
            )}

            {/* ── ACTIVITY ── */}
            {view === 'activity' && (
              audit.length === 0
                ? <Empty label="No recent activity" />
                : <div className="font-mono text-sm flex flex-col gap-1">
                    {audit.map((a) => (
                      <div key={a.id} className="flex gap-4 px-3 py-2 rounded-lg odd:bg-muted/20">
                        <span className="text-muted-foreground/70 shrink-0 w-24 tabular-nums">{new Date(a.createdAt).toLocaleTimeString('en-GB')}</span>
                        <span className="text-accent shrink-0 w-64 truncate">{a.action}</span>
                        <span className="text-muted-foreground truncate">{a.actorEmail ?? 'system'}{a.target ? ` → ${a.target}` : ''}</span>
                      </div>
                    ))}
                  </div>
            )}
          </div>
        </main>
      </div>

      {/* Bottom status strip */}
      <footer className="h-9 shrink-0 flex gap-3">
        <div className="w-52 shrink-0 rounded-bl-[2rem] bg-primary flex items-center justify-end pr-5 font-lcars text-sm text-[hsl(222_47%_8%)]">
          Cerebro Core
        </div>
        <div className="flex-1 rounded-br-xl bg-secondary/70 flex items-center gap-6 px-6 font-lcars text-sm tracking-wide text-[hsl(210_40%_96%)]">
          <span className="flex items-center gap-2">
            {offline.length ? <ShieldAlert className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
            {offline.length ? `${offline.length} offline` : 'Nominal'}
          </span>
          <span className="hidden sm:block">Operator · {user?.displayName ?? '—'}</span>
          {version && <span className="hidden md:block">v{version.version}</span>}
          <span className="ml-auto opacity-70">Kiosk · {auto ? 'auto-cycling' : 'pinned'}</span>
        </div>
      </footer>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <div className="h-full grid place-items-center text-center font-lcars text-2xl text-muted-foreground">{label}</div>;
}
