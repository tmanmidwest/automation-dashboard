import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Puzzle, Users as UsersIcon, Activity, Cpu, Radar } from 'lucide-react';
import type { VersionInfo, ConnectorInstanceSummary } from '@cerebro/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { cn } from '@/lib/utils';

function useCountUp(target: number, ms = 900) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      setN(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return n;
}

function uptimeSince(iso?: string): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

interface Blip { id: string; name: string; sub: string; on: boolean; x: number; y: number }

function RadarScope({ blips, hovered }: { blips: Blip[]; hovered: string | null }) {
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
        {blips.map((b, i) => {
          const hot = hovered === b.id;
          const color = b.on ? 'hsl(var(--primary))' : 'hsl(var(--accent) / 0.7)';
          return (
            <g key={b.id}>
              {hot && <circle cx={b.x} cy={b.y} r="10" fill="none" stroke={color} strokeWidth="1" opacity="0.8" />}
              <circle cx={b.x} cy={b.y} r={hot ? 6 : b.on ? 4.5 : 3} fill={color}
                className={hot ? '' : 'cb-ping'} style={{ animationDelay: `${(i * 0.45) % 3.6}s`, filter: b.on || hot ? `drop-shadow(0 0 6px ${color})` : undefined }}>
                <title>{b.name} — {b.on ? 'online' : 'disabled'}</title>
              </circle>
            </g>
          );
        })}
        <circle cx="150" cy="150" r="4" fill="hsl(var(--accent))" style={{ filter: 'drop-shadow(0 0 6px hsl(var(--accent)))' }} />
      </svg>
    </div>
  );
}

export function Dashboard() {
  const { user } = useAuth();
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [connectors, setConnectors] = useState<ConnectorInstanceSummary[]>([]);
  const [userCount, setUserCount] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const startedRef = useRef(Date.now());
  const [, force] = useState(0);

  useEffect(() => {
    api.get<VersionInfo>('/api/version').then(setVersion).catch(() => {});
    api.get<ConnectorInstanceSummary[]>('/api/connectors/instances').then(setConnectors).catch(() => {});
    api.get<Array<unknown>>('/api/users').then((u) => setUserCount(u.length)).catch(() => {});
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const enabled = connectors.filter((c) => c.enabled).length;
  const linkedN = useCountUp(connectors.length);
  const opsN = useCountUp(userCount);

  const blips: Blip[] = connectors.map((c, i) => {
    const ang = (i * 137.5 * Math.PI) / 180;
    const rad = 34 + ((i * 41) % 100);
    return { id: c.id, name: c.name, sub: c.connectorName, on: c.enabled, x: 150 + Math.cos(ang) * rad, y: 150 + Math.sin(ang) * rad };
  });

  const stats = [
    { icon: Puzzle, label: 'Linked systems', value: String(linkedN), sub: `${enabled} online` },
    { icon: UsersIcon, label: 'Operators', value: String(opsN), sub: 'authorized' },
    { icon: Activity, label: 'Core uptime', value: uptimeSince(version?.builtAt ?? new Date(startedRef.current).toISOString()), sub: 'this session' },
    { icon: Cpu, label: 'Cerebro core', value: version ? `v${version.version}` : '—', sub: version?.gitSha && version.gitSha !== 'dev' ? version.gitSha.slice(0, 7) : 'online' },
  ];

  return (
    <div className="animate-fade-in">
      <div className="mb-4">
        <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-[0.3em] text-accent/80">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> Scanning
        </div>
        <h1 className="text-2xl font-bold tracking-tight mt-1">
          Welcome back, <span className="bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">{user?.displayName?.split(' ')[0] ?? 'Operator'}</span>
        </h1>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* Radar */}
        <div className="relative overflow-hidden rounded-2xl border border-border/60 cerebro-aurora">
          <div className="absolute inset-0 pointer-events-none opacity-[0.12] cb-gridfloor" />
          <div className="relative grid place-items-center py-6 min-h-[340px]">
            <RadarScope blips={blips} hovered={hovered} />
          </div>
        </div>

        {/* Detected signals */}
        <div className="rounded-2xl border border-border/60 bg-card/70 backdrop-blur p-4 flex flex-col">
          <div className="flex items-center gap-2 mb-3">
            <Radar className="h-4 w-4 text-accent" />
            <span className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground">Detected signals</span>
            <span className="ml-auto text-xs text-muted-foreground">{connectors.length}</span>
          </div>
          {connectors.length === 0 ? (
            <div className="flex-1 grid place-items-center text-center text-sm text-muted-foreground py-8">
              <div>
                <p>No systems linked.</p>
                <Link to="/connectors" className="text-primary hover:underline">Add a connector →</Link>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5 overflow-y-auto max-h-[280px] pr-1">
              {connectors.map((c) => (
                <Link key={c.id} to={`/connectors/${c.id}`}
                  onMouseEnter={() => setHovered(c.id)} onMouseLeave={() => setHovered(null)}
                  className="flex items-center gap-3 rounded-md px-2.5 py-2 hover:bg-muted/50 transition-colors">
                  <span className={cn('h-2 w-2 rounded-full shrink-0', c.enabled ? 'bg-primary shadow-[0_0_6px_hsl(var(--primary))]' : 'bg-muted-foreground/50')} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{c.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{c.connectorName}</p>
                  </div>
                  <span className={cn('ml-auto text-[10px] font-mono uppercase tracking-wider', c.enabled ? 'text-emerald-400' : 'text-muted-foreground')}>
                    {c.enabled ? 'online' : 'off'}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* HUD stat row */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="relative overflow-hidden rounded-xl border border-border/60 bg-card/70 p-4 backdrop-blur">
            <div className="absolute left-0 top-0 h-full w-0.5 bg-gradient-to-b from-primary to-accent" />
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground">{s.label}</span>
              <s.icon className="h-4 w-4 text-accent/70" />
            </div>
            <div className="mt-2 text-2xl font-semibold tabular-nums">{s.value}</div>
            <div className="text-xs text-muted-foreground">{s.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
