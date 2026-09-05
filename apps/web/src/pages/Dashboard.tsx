import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Server, Boxes, Network, Cpu, Users as UsersIcon, Activity, Clock, DollarSign, TrendingUp, CalendarDays, Archive, HardDrive, ShieldCheck, ShieldAlert, HeartPulse, Gauge, Radio, ChevronRight, RefreshCw } from 'lucide-react';
import type { VersionInfo, DashboardOverview, OverviewGuest, AuditLogEntry, MonitorSummary, MonitorStatus } from '@cerebro/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { cn, formatMoney, shortDateTime } from '@/lib/utils';

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

/** Colour a signal dot by what it actually is — provider + resource kind. */
function guestColor(kind: string): string {
  if (kind === 'ec2') return 'hsl(32 95% 56%)';       // AWS EC2 — amber
  if (kind === 'lxc') return 'hsl(var(--accent))';     // Proxmox container — teal
  if (kind === 'qemu') return 'hsl(var(--primary))';   // Proxmox VM — cyan
  return 'hsl(var(--accent) / 0.7)';
}

/** Where tapping a live signal takes you (its kind's overview scope). */
function guestTo(kind: string): string {
  if (kind === 'qemu') return '/overview/vm';
  if (kind === 'lxc') return '/overview/container';
  return '/connectors';
}

function monitorColor(status: MonitorStatus): string {
  if (status === 'up') return 'hsl(160 84% 55%)';
  if (status === 'down') return 'hsl(var(--destructive))';
  if (status === 'pending') return 'hsl(43 96% 56%)';
  return 'hsl(var(--muted-foreground) / 0.6)';
}

const SEGMENTS = 20;

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

/** LCARS segmented readout — the functional replacement for the radar. */
function Meter({ name, pct, polarity = 'load' }: { name: string; pct: number; polarity?: Polarity }) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const on = Math.round((clamped / 100) * SEGMENTS);
  const col = toneColor(clamped, polarity);
  return (
    <div className="lcars-meter">
      <span className="lcars-meter__name">{name}</span>
      <div className="lcars-track">
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <span key={i} className="flex-1 rounded-[2px]"
            style={{ background: i < on ? col : 'hsl(var(--secondary))', opacity: i < on ? 1 : 0.28 }} />
        ))}
      </div>
      <span className="lcars-meter__val" style={{ color: col }}>{clamped}%</span>
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

export function Dashboard() {
  const { user, can } = useAuth();
  const canMonitors = can('monitors:read');
  const [monitors, setMonitors] = useState<MonitorSummary[] | null>(null);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [audit, setAudit] = useState<AuditLogEntry[]>([]);
  const [userCount, setUserCount] = useState(0);
  const startedRef = useRef(Date.now());
  const lastPollRef = useRef(Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [, tick] = useState(0);

  // Core telemetry (connectors + activity) — the fast 5s loop.
  const pollCore = useCallback(async () => {
    await Promise.all([
      api.get<DashboardOverview>('/api/connectors/overview').then((data) => {
        lastPollRef.current = Date.now();
        setOverview((prev) => {
          const empty = data.metrics.length === 0 && data.guests.length === 0;
          // Keep the last good telemetry if a poll momentarily returns nothing.
          if (empty && prev && (prev.metrics.length > 0 || prev.guests.length > 0)) {
            return { ...prev, connectors: data.connectors };
          }
          return data;
        });
      }).catch(() => {}),
      api.get<AuditLogEntry[]>('/api/logs/audit?limit=14').then(setAudit).catch(() => {}),
    ]);
  }, []);

  // Uptime monitors — their own slower 10s loop (the list endpoint aggregates history).
  const loadMonitors = useCallback(async () => {
    if (!canMonitors) return;
    await api.get<MonitorSummary[]>('/api/monitors').then(setMonitors).catch(() => {});
  }, [canMonitors]);

  // Manual "Refresh" — pulls connectors, activity and monitors at once.
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
    const t = setInterval(() => { pollCore(); tick((x) => x + 1); }, 5000);
    const clock = setInterval(() => tick((x) => x + 1), 1000);
    return () => { clearInterval(t); clearInterval(clock); };
  }, [pollCore]);

  useEffect(() => {
    if (!canMonitors) return;
    loadMonitors();
    const t = setInterval(loadMonitors, 10000);
    return () => clearInterval(t);
  }, [canMonitors, loadMonitors]);

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
  const guests = overview?.guests ?? [];

  const sources = overview?.sources ?? [];
  const offline = sources.filter((s) => !s.ok);
  const secsSinceScan = Math.floor((Date.now() - lastPollRef.current) / 1000);
  const stale = secsSinceScan > 15;
  const runningGuests = guests.filter((g) => g.status === 'running').length;
  const idleGuests = guests.length - runningGuests;
  const connOk = overview?.connectors.ok ?? 0;
  const connTotal = overview?.connectors.total ?? 0;

  const vms = useCountUp(metric('vmsRunning'));
  const cts = useCountUp(metric('ctsRunning'));
  const nodes = useCountUp(metric('nodes'));
  const ops = useCountUp(userCount);

  // System readout meters — all derived from real telemetry.
  const readout: { name: string; pct: number; polarity: Polarity }[] = [
    { name: 'Cluster CPU', pct: metric('cpuPct'), polarity: 'load' },
    { name: 'Cluster RAM', pct: metric('memPct'), polarity: 'load' },
    { name: 'Systems Online', pct: connTotal ? (connOk / connTotal) * 100 : 0, polarity: 'health' },
    { name: 'Signals Active', pct: guests.length ? (runningGuests / guests.length) * 100 : 0, polarity: 'neutral' },
  ];
  if (monitors && monitors.length > 0) {
    const denom = monitors.length - monPaused;
    readout.push({ name: 'Monitors Up', pct: denom ? (monUp / denom) * 100 : 100, polarity: 'health' });
  }

  return (
    <div className="animate-fade-in space-y-4">
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
        <Button
          variant="outline"
          size="sm"
          className="ml-auto mt-1"
          onClick={() => refreshAll()}
          disabled={refreshing}
          aria-label="Refresh telemetry now"
        >
          <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* System readout + live signals */}
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <Panel
          title="System Readout"
          accent="accent"
          tag={stale ? 'signal lost' : `${secsSinceScan}s ago`}
          className={cn(offline.length > 0 && 'border-amber-500/40')}
        >
          <div className="py-1">
            {readout.map((r) => <Meter key={r.name} name={r.name} pct={r.pct} polarity={r.polarity} />)}
          </div>
          <div className="mt-3 pt-3 border-t border-border/50 grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="font-lcars text-2xl font-semibold text-emerald-400 tabular-nums">{runningGuests}</div>
              <div className="text-[11px] text-muted-foreground">active</div>
            </div>
            <div>
              <div className="font-lcars text-2xl font-semibold text-amber-400 tabular-nums">{idleGuests}</div>
              <div className="text-[11px] text-muted-foreground">idle</div>
            </div>
            <div>
              <div className={cn('font-lcars text-2xl font-semibold tabular-nums', offline.length ? 'text-destructive' : 'text-emerald-400')}>{offline.length}</div>
              <div className="text-[11px] text-muted-foreground">offline</div>
            </div>
          </div>
        </Panel>

        <Panel title="Live Signals" to="/connectors" tag={<span className="tabular-nums">{guests.length}</span>}>
          {guests.length === 0 ? (
            <div className="grid place-items-center text-center text-sm text-muted-foreground py-10">No signals detected.</div>
          ) : (
            <div className="space-y-1.5 overflow-y-auto max-h-[300px] pr-1">
              {guests.map((g, i) => (
                <Link
                  key={i}
                  to={guestTo(g.kind)}
                  className="flex items-center gap-3 rounded-md px-2.5 py-2 min-h-[44px] hover:bg-muted/60 transition-colors"
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={g.status === 'running'
                      ? { background: guestColor(g.kind), boxShadow: `0 0 6px ${guestColor(g.kind)}` }
                      : { background: 'hsl(var(--muted-foreground) / 0.5)' }}
                  />
                  {g.kind === 'lxc'
                    ? <Boxes className="h-4 w-4 shrink-0" style={{ color: guestColor(g.kind) }} />
                    : <Server className="h-4 w-4 shrink-0" style={{ color: guestColor(g.kind) }} />}
                  <span className="text-sm truncate">{g.name}</span>
                  <span className="ml-auto font-lcars text-xs tracking-wider text-muted-foreground shrink-0">{g.node}</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground/60 shrink-0" />
                </Link>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* Uptime monitors — clickable list */}
      {monitors && monitors.length > 0 && (
        <Panel title="Monitors" to="/monitors" tag={<span className="tabular-nums">{monUp}/{monitors.length - monPaused} up</span>} accent="primary">
          <div className="grid gap-1.5 sm:grid-cols-2">
            {[...monitors].sort((a, b) => rank(a.status) - rank(b.status)).map((m) => (
              <Link
                key={m.id}
                to={`/monitors/${m.id}`}
                className="flex items-center gap-3 rounded-md px-2.5 py-2 min-h-[44px] hover:bg-muted/60 transition-colors"
              >
                <span
                  className="h-2.5 w-2.5 rotate-45 shrink-0"
                  style={m.status === 'paused'
                    ? { border: `1px solid ${monitorColor(m.status)}` }
                    : { background: monitorColor(m.status), boxShadow: m.status !== 'pending' ? `0 0 6px ${monitorColor(m.status)}` : undefined }}
                />
                <span className={cn('text-sm truncate', m.status === 'down' && 'text-destructive')}>{m.name}</span>
                <span className="ml-auto font-lcars text-xs tracking-wider text-muted-foreground shrink-0">
                  {m.status === 'up' && m.lastLatencyMs != null ? `${m.lastLatencyMs} ms` : m.status}
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground/60 shrink-0" />
              </Link>
            ))}
          </div>
        </Panel>
      )}

      {/* Telemetry tiles */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile icon={Server} label="VMs running" value={String(vms)} sub={`${metric('vmsTotal')} total`} to="/overview/vm" />
        <StatTile icon={Boxes} label="Containers" value={String(cts)} sub={`${metric('ctsTotal')} total`} to="/overview/container" />
        <StatTile icon={Network} label="Nodes online" value={String(nodes)} sub="cluster" to="/overview/nodes" />
        <GaugeTile icon={Cpu} label="Cluster CPU" pct={metric('cpuPct')} to="/overview/nodes" />
        <GaugeTile icon={Activity} label="Cluster RAM" pct={metric('memPct')} to="/overview/nodes" />
        <StatTile icon={Clock} label="Core uptime" value={uptimeSince(version?.builtAt ?? new Date(startedRef.current).toISOString())} sub={version ? `v${version.version}` : 'online'} />
      </div>

      {/* Uptime monitor summary tiles */}
      {monitors && monitors.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2 font-lcars text-xs tracking-[0.14em] text-muted-foreground">
            <HeartPulse className="h-3.5 w-3.5 text-accent" /> Monitors
          </div>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
            <StatTile
              icon={HeartPulse}
              label="Monitors up"
              value={`${monUp} / ${monitors.length - monPaused}`}
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
      )}

      {/* Cloud spend — its own row so it doesn't crowd the telemetry tiles */}
      {costMtd && (
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
      )}

      {/* Backups — Backblaze B2, shown only when a backup connector is configured */}
      {hasBackblaze && (
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
      )}

      {/* Activity feed */}
      <Panel title="Activity Feed" tag={<span className="flex items-center gap-1.5"><UsersIcon className="h-3.5 w-3.5" /> {ops} operators</span>}>
        <div className="font-mono text-xs max-h-[240px] overflow-y-auto -mx-1">
          {audit.length === 0 ? (
            <div className="text-center text-muted-foreground py-6">No recent activity.</div>
          ) : (
            audit.map((a) => (
              <div key={a.id} className="flex gap-3 px-2 py-1 animate-fade-in">
                <span className="text-muted-foreground/70 shrink-0 w-36">{new Date(a.createdAt).toLocaleTimeString()}</span>
                <span className="text-accent shrink-0 w-52 truncate">{a.action}</span>
                <span className="text-muted-foreground truncate">{a.actorEmail ?? 'system'}{a.target ? ` → ${a.target}` : ''}</span>
              </div>
            ))
          )}
        </div>
      </Panel>

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
