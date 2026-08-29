import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Server, Boxes, Network, Cpu, Users as UsersIcon, Radar, Activity, Clock } from 'lucide-react';
import type { VersionInfo, DashboardOverview, OverviewGuest, AuditLogEntry } from '@cerebro/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { cn } from '@/lib/utils';

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

function RadarScope({ guests, hovered, onHover }: { guests: OverviewGuest[]; hovered: number | null; onHover: (i: number | null) => void }) {
  const blips = guests.slice(0, 30).map((g, i) => {
    const ang = (i * 137.5 * Math.PI) / 180;
    const rad = 30 + ((i * 43) % 108);
    return { g, i, x: 150 + Math.cos(ang) * rad, y: 150 + Math.sin(ang) * rad };
  });
  return (
    <div className="relative h-[300px] w-[300px]">
      <div className="absolute inset-2 rounded-full cb-sweep"
        style={{ WebkitMaskImage: 'radial-gradient(circle, black 68%, transparent 69%)', maskImage: 'radial-gradient(circle, black 68%, transparent 69%)' }} />
      <svg viewBox="0 0 300 300" className="absolute inset-0">
        {[142, 104, 66, 28].map((r) => <circle key={r} cx="150" cy="150" r={r} fill="none" stroke="hsl(var(--accent) / 0.22)" strokeWidth="1" />)}
        <line x1="8" y1="150" x2="292" y2="150" stroke="hsl(var(--accent) / 0.14)" strokeWidth="1" />
        <line x1="150" y1="8" x2="150" y2="292" stroke="hsl(var(--accent) / 0.14)" strokeWidth="1" />
        <g className="cb-spin" style={{ transformOrigin: 'center' }}>
          <line x1="150" y1="150" x2="150" y2="10" stroke="hsl(var(--accent))" strokeWidth="1.5" style={{ filter: 'drop-shadow(0 0 4px hsl(var(--accent)/0.8))' }} />
        </g>
        {blips.map(({ g, i, x, y }) => {
          const on = g.status === 'running';
          const hot = hovered === i;
          const color = on ? 'hsl(var(--primary))' : 'hsl(var(--accent) / 0.65)';
          return (
            <g key={i} onMouseEnter={() => onHover(i)} onMouseLeave={() => onHover(null)} style={{ cursor: 'pointer' }}>
              {hot && <circle cx={x} cy={y} r="10" fill="none" stroke={color} strokeWidth="1" opacity="0.8" />}
              <circle cx={x} cy={y} r={hot ? 6 : on ? 4.5 : 3} fill={color} className={on && !hot ? 'cb-ping' : ''}
                style={{ animationDelay: `${(i * 0.4) % 3.6}s`, filter: on || hot ? `drop-shadow(0 0 6px ${color})` : undefined }}>
                <title>{g.name} · {g.kind} · {g.node} · {g.status}</title>
              </circle>
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
  const { user } = useAuth();
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

  const metric = (k: string) => overview?.metrics.find((m) => m.key === k)?.value ?? 0;
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
                  <span className={cn('h-2 w-2 rounded-full shrink-0', g.status === 'running' ? 'bg-primary shadow-[0_0_6px_hsl(var(--primary))]' : 'bg-muted-foreground/50')} />
                  {g.kind === 'lxc' ? <Boxes className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <Server className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                  <span className="text-sm truncate">{g.name}</span>
                  <span className="ml-auto text-[10px] font-mono uppercase tracking-wider text-muted-foreground shrink-0">{g.node}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Telemetry tiles */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile icon={Server} label="VMs running" value={String(vms)} sub={`${metric('vmsTotal')} total`} to="/overview/vm" />
        <StatTile icon={Boxes} label="Containers" value={String(cts)} sub={`${metric('ctsTotal')} total`} to="/overview/container" />
        <StatTile icon={Network} label="Nodes online" value={String(nodes)} sub="cluster" to="/overview/nodes" />
        <GaugeTile icon={Cpu} label="Cluster CPU" pct={metric('cpuPct')} to="/overview/nodes" />
        <GaugeTile icon={Activity} label="Cluster RAM" pct={metric('memPct')} to="/overview/nodes" />
        <StatTile icon={Clock} label="Core uptime" value={uptimeSince(version?.builtAt ?? new Date(startedRef.current).toISOString())} sub={version ? `v${version.version}` : 'online'} />
      </div>

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
