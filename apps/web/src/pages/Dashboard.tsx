import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Server, Boxes, Network, Cpu, Users as UsersIcon, Radar, Activity, Clock, DollarSign, TrendingUp, CalendarDays, Archive, HardDrive, ShieldCheck, ShieldAlert, HeartPulse, Gauge } from 'lucide-react';
import type { VersionInfo, DashboardOverview, OverviewGuest, AuditLogEntry, MonitorSummary } from '@cerebro/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { cn, formatMoney, shortDateTime } from '@/lib/utils';
import { Brand } from '@/components/Brand';
import { MonitorRadar } from '@/components/MonitorRadar';

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

const SWEEP_SECONDS = 3.6; // must match .cb-sweep / .cb-spin duration in index.css

/** Colour a blip by what it actually is — provider + resource kind. */
function guestColor(kind: string): string {
  if (kind === 'ec2') return 'hsl(32 95% 56%)';       // AWS EC2 — amber
  if (kind === 'lxc') return 'hsl(var(--accent))';     // Proxmox container — teal
  if (kind === 'qemu') return 'hsl(var(--primary))';   // Proxmox VM — cyan
  return 'hsl(var(--accent) / 0.7)';
}

/** Short provider tag from a resource kind, for the sector rim label. */
function providerTag(kind: string): string {
  if (kind === 'ec2') return 'AWS';
  if (kind === 'qemu' || kind === 'lxc') return 'PROXMOX';
  return 'SYS';
}

interface Blip { g: OverviewGuest; i: number; x: number; y: number; aDeg: number }

function RadarScope({ guests, hovered, onHover }: { guests: OverviewGuest[]; hovered: number | null; onHover: (i: number | null) => void }) {
  // Group the real systems by connector so each provider owns an angular wedge
  // of the scope — AWS clusters in one arc, Proxmox in another — instead of a
  // meaningless scatter. Original indices are preserved for hover-sync with the
  // "Live signals" list.
  const items = guests.slice(0, 30).map((g, i) => ({ g, i }));
  const order: string[] = [];
  const byConn = new Map<string, { g: OverviewGuest; i: number }[]>();
  for (const it of items) {
    const key = it.g.connector || 'system';
    if (!byConn.has(key)) { byConn.set(key, []); order.push(key); }
    byConn.get(key)!.push(it);
  }
  const C = order.length || 1;

  const blips: Blip[] = [];
  const sectors: { conn: string; tag: string; midDeg: number; startDeg: number }[] = [];
  order.forEach((conn, ci) => {
    const arr = byConn.get(conn)!;
    const secStart = -90 + ci * (360 / C);
    const secWidth = 360 / C;
    const pad = Math.min(14, secWidth * 0.1);
    const aStart = secStart + pad;
    const aEnd = secStart + secWidth - pad;
    sectors.push({ conn, tag: providerTag(arr[0]?.g.kind ?? ''), midDeg: secStart + secWidth / 2, startDeg: secStart });
    const n = arr.length;
    arr.forEach((it, j) => {
      const frac = n > 1 ? j / (n - 1) : 0.5;
      const aDeg = C === 1 ? aStart + (j / Math.max(1, n)) * (aEnd - aStart) : aStart + frac * (aEnd - aStart);
      const radius = 46 + ((j % 4) * 22) + (Math.floor(j / 4) % 2) * 11; // stagger so they don't sit on one arc
      const a = (aDeg * Math.PI) / 180;
      blips.push({ g: it.g, i: it.i, x: 150 + Math.cos(a) * radius, y: 150 + Math.sin(a) * radius, aDeg });
    });
  });

  return (
    <div className="relative h-[300px] w-[300px]">
      <div className="absolute inset-2 rounded-full cb-sweep"
        style={{ WebkitMaskImage: 'radial-gradient(circle, black 68%, transparent 69%)', maskImage: 'radial-gradient(circle, black 68%, transparent 69%)' }} />
      <svg viewBox="0 0 300 300" className="absolute inset-0">
        {[142, 104, 66, 28].map((r) => <circle key={r} cx="150" cy="150" r={r} fill="none" stroke="hsl(var(--accent) / 0.22)" strokeWidth="1" />)}
        <line x1="8" y1="150" x2="292" y2="150" stroke="hsl(var(--accent) / 0.14)" strokeWidth="1" />
        <line x1="150" y1="8" x2="150" y2="292" stroke="hsl(var(--accent) / 0.14)" strokeWidth="1" />

        {/* Spokes + rim labels delineate each connector's wedge. */}
        {C > 1 && sectors.map((s) => {
          const a = (s.startDeg * Math.PI) / 180;
          return <line key={`spoke-${s.conn}`} x1="150" y1="150" x2={150 + Math.cos(a) * 142} y2={150 + Math.sin(a) * 142} stroke="hsl(var(--accent) / 0.12)" strokeWidth="1" strokeDasharray="2 4" />;
        })}
        {sectors.map((s) => {
          const a = (s.midDeg * Math.PI) / 180;
          const lx = 150 + Math.cos(a) * 128;
          const ly = 150 + Math.sin(a) * 128;
          return (
            <text key={`lbl-${s.conn}`} x={lx} y={ly} textAnchor="middle" dominantBaseline="middle"
              className="fill-muted-foreground" style={{ fontSize: 8, letterSpacing: '0.12em', opacity: 0.75 }}>
              {s.tag}
            </text>
          );
        })}

        <g className="cb-spin" style={{ transformOrigin: 'center' }}>
          <line x1="150" y1="150" x2="150" y2="10" stroke="hsl(var(--accent))" strokeWidth="1.5" style={{ filter: 'drop-shadow(0 0 4px hsl(var(--accent)/0.8))' }} />
        </g>

        {blips.map(({ g, i, x, y, aDeg }) => {
          const on = g.status === 'running';
          const hot = hovered === i;
          const color = guestColor(g.kind);
          const isContainer = g.kind === 'lxc';
          // Ping in phase with the sweep: fire as the sweep line passes this angle.
          const delay = ((((aDeg + 90) % 360) + 360) % 360) / 360 * SWEEP_SECONDS;
          const r = hot ? 6 : on ? 4.5 : 3;
          const glow = on || hot ? `drop-shadow(0 0 6px ${color})` : undefined;
          return (
            <g key={i} onMouseEnter={() => onHover(i)} onMouseLeave={() => onHover(null)} style={{ cursor: 'pointer' }}>
              {hot && <circle cx={x} cy={y} r="10" fill="none" stroke={color} strokeWidth="1" opacity="0.8" />}
              {isContainer ? (
                <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={1.5} fill={on ? color : 'transparent'} stroke={color} strokeWidth={on ? 0 : 1.4}
                  className={on && !hot ? 'cb-ping' : ''} style={{ animationDelay: `${delay}s`, filter: glow, transformBox: 'fill-box', transformOrigin: 'center' }}>
                  <title>{g.name} · {g.kind} · {g.node} · {g.status}</title>
                </rect>
              ) : (
                <circle cx={x} cy={y} r={r} fill={on ? color : 'transparent'} stroke={color} strokeWidth={on ? 0 : 1.4}
                  className={on && !hot ? 'cb-ping' : ''} style={{ animationDelay: `${delay}s`, filter: glow }}>
                  <title>{g.name} · {g.kind} · {g.node} · {g.status}</title>
                </circle>
              )}
            </g>
          );
        })}
        <circle cx="150" cy="150" r="4" fill="hsl(var(--accent))" style={{ filter: 'drop-shadow(0 0 6px hsl(var(--accent)))' }} />
      </svg>
    </div>
  );
}

function HudBox({ pos, children }: { pos: string; children: React.ReactNode }) {
  return <div className={cn('absolute z-10 hidden md:block font-mono text-[11px] uppercase tracking-[0.18em] leading-relaxed', pos)}>{children}</div>;
}

function StatTile({ icon: Icon, label, value, sub, to }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string; to?: string }) {
  const inner = (
    <>
      <div className="absolute left-0 top-0 h-full w-0.5 bg-gradient-to-b from-primary to-accent" />
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-accent/70" />
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
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
        <span className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-accent/70" />
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{pct}%</div>
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
  const [hovered, setHovered] = useState<number | null>(null);
  const startedRef = useRef(Date.now());
  const lastPollRef = useRef(Date.now());
  const [, tick] = useState(0);

  useEffect(() => {
    api.get<VersionInfo>('/api/version').then(setVersion).catch(() => {});
    api.get<Array<unknown>>('/api/users').then((u) => setUserCount(u.length)).catch(() => {});
    const poll = () => {
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
      }).catch(() => {});
      api.get<AuditLogEntry[]>('/api/logs/audit?limit=14').then(setAudit).catch(() => {});
    };
    poll();
    const t = setInterval(() => { poll(); tick((x) => x + 1); }, 5000);
    const clock = setInterval(() => tick((x) => x + 1), 1000);
    return () => { clearInterval(t); clearInterval(clock); };
  }, []);

  // Uptime monitors — polled on their own cadence (the list endpoint aggregates history).
  useEffect(() => {
    if (!canMonitors) return;
    const load = () => api.get<MonitorSummary[]>('/api/monitors').then(setMonitors).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [canMonitors]);

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
  const alert = offline.length > 0 || stale;

  const vms = useCountUp(metric('vmsRunning'));
  const cts = useCountUp(metric('ctsRunning'));
  const nodes = useCountUp(metric('nodes'));
  const linked = useCountUp(overview?.connectors.total ?? 0);
  const ops = useCountUp(userCount);

  return (
    <div className="animate-fade-in space-y-4">
      <div>
        <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-[0.3em] text-accent/80">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> Scanning · {overview?.connectors.ok ?? 0}/{overview?.connectors.total ?? 0} systems linked
        </div>
        <h1 className="text-2xl font-bold tracking-tight mt-1">
          Welcome back, <span className="bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">{user?.displayName?.split(' ')[0] ?? 'Operator'}</span>
        </h1>
      </div>

      {/* Radar + live signals */}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className={cn('relative overflow-hidden rounded-2xl border cerebro-aurora transition-colors', alert ? 'border-amber-500/40' : 'border-border/60')}>
          <div className="absolute inset-0 pointer-events-none opacity-[0.12] cb-gridfloor" />
          {alert && <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(circle at 50% 55%, transparent 45%, hsl(var(--destructive) / 0.10))' }} />}

          {/* Cerebro logo, top-centre — always visible on the radar even with the nav collapsed. */}
          <Brand className="absolute top-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none" />

          <HudBox pos="top-4 left-5">
            <div className="text-muted-foreground/70">Systems online</div>
            <div className={cn('text-sm', offline.length ? 'text-amber-400' : 'text-emerald-400')}>
              {overview?.connectors.ok ?? 0}/{overview?.connectors.total ?? 0}
            </div>
          </HudBox>

          <HudBox pos="top-4 right-5 text-right">
            <div className="text-muted-foreground/70">Last scan</div>
            {stale ? <div className="text-destructive animate-pulse">Signal lost</div> : <div className="text-accent/90">{secsSinceScan}s ago</div>}
          </HudBox>

          <HudBox pos="bottom-4 left-5">
            {offline.length > 0 ? (
              <div className="space-y-0.5">
                {offline.slice(0, 3).map((s) => (
                  <div key={s.name} className="text-destructive flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-destructive animate-pulse" /> {s.name} · unreachable
                  </div>
                ))}
                {offline.length > 3 && <div className="text-destructive/70">+{offline.length - 3} more</div>}
              </div>
            ) : (
              <div className="text-emerald-400 flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> All systems nominal</div>
            )}
          </HudBox>

          <HudBox pos="bottom-4 right-5 text-right">
            <div className="text-muted-foreground/70">Signals</div>
            <div className="text-primary">{runningGuests} active</div>
            {idleGuests > 0 && <div className="text-amber-400/80">{idleGuests} idle</div>}
          </HudBox>

          <div className="relative grid place-items-center py-6 min-h-[340px]">
            <RadarScope guests={guests} hovered={hovered} onHover={setHovered} />
          </div>
        </div>

        <div className="rounded-2xl border border-border/60 bg-card/70 backdrop-blur p-4 flex flex-col">
          <div className="flex items-center gap-2 mb-3">
            <Radar className="h-4 w-4 text-accent" />
            <span className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground">Live signals</span>
            <span className="ml-auto text-xs text-muted-foreground">{guests.length}</span>
          </div>
          {guests.length === 0 ? (
            <div className="flex-1 grid place-items-center text-center text-sm text-muted-foreground py-8">No signals detected.</div>
          ) : (
            <div className="space-y-1 overflow-y-auto max-h-[280px] pr-1">
              {guests.map((g, i) => (
                <div key={i} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}
                  className={cn('flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors', hovered === i ? 'bg-muted/60' : 'hover:bg-muted/40')}>
                  <span className="h-2 w-2 rounded-full shrink-0"
                    style={g.status === 'running'
                      ? { background: guestColor(g.kind), boxShadow: `0 0 6px ${guestColor(g.kind)}` }
                      : { background: 'hsl(var(--muted-foreground) / 0.5)' }} />
                  {g.kind === 'lxc'
                    ? <Boxes className="h-3.5 w-3.5 shrink-0" style={{ color: guestColor(g.kind) }} />
                    : <Server className="h-3.5 w-3.5 shrink-0" style={{ color: guestColor(g.kind) }} />}
                  <span className="text-sm truncate">{g.name}</span>
                  <span className="ml-auto text-[10px] font-mono uppercase tracking-wider text-muted-foreground shrink-0">{g.node}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Monitor radar — its own scope so monitor status never competes with the connector blips */}
      {monitors && monitors.length > 0 && <MonitorRadar monitors={monitors} />}

      {/* Telemetry tiles */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile icon={Server} label="VMs running" value={String(vms)} sub={`${metric('vmsTotal')} total`} to="/overview/vm" />
        <StatTile icon={Boxes} label="Containers" value={String(cts)} sub={`${metric('ctsTotal')} total`} to="/overview/container" />
        <StatTile icon={Network} label="Nodes online" value={String(nodes)} sub="cluster" to="/overview/nodes" />
        <GaugeTile icon={Cpu} label="Cluster CPU" pct={metric('cpuPct')} to="/overview/nodes" />
        <GaugeTile icon={Activity} label="Cluster RAM" pct={metric('memPct')} to="/overview/nodes" />
        <StatTile icon={Clock} label="Core uptime" value={uptimeSince(version?.builtAt ?? new Date(startedRef.current).toISOString())} sub={version ? `v${version.version}` : 'online'} />
      </div>

      {/* Uptime monitors — shown once at least one monitor exists */}
      {monitors && monitors.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2 text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
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
          <div className="flex items-center gap-2 mb-2 text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
            <DollarSign className="h-3.5 w-3.5 text-accent" /> Cloud spend
            {costMtd.asOf && <span className="ml-auto normal-case tracking-normal text-muted-foreground/60">as of {shortDateTime(costMtd.asOf)}</span>}
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
          <div className="flex items-center gap-2 mb-2 text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
            <Archive className="h-3.5 w-3.5 text-accent" /> Backups
            {b2LastOk?.asOf && <span className="ml-auto normal-case tracking-normal text-muted-foreground/60">as of {shortDateTime(b2LastOk.asOf)}</span>}
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
      <div className="rounded-2xl border border-border/60 bg-card/70 backdrop-blur">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
          <Activity className="h-4 w-4 text-accent" />
          <span className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground">Activity feed</span>
          <UsersIcon className="h-3.5 w-3.5 text-muted-foreground ml-auto" />
          <span className="text-xs text-muted-foreground">{ops} operators</span>
        </div>
        <div className="p-2 font-mono text-xs max-h-[240px] overflow-y-auto">
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
      </div>
    </div>
  );
}
