import { useState } from 'react';
import { Link } from 'react-router-dom';
import { HeartPulse } from 'lucide-react';
import type { MonitorSummary, MonitorStatus } from '@cerebro/shared';
import { Brand } from '@/components/Brand';
import { cn, timeAgo } from '@/lib/utils';
import { pct, pctColor } from '@/pages/monitors/monitor-ui';

const SWEEP_SECONDS = 3.6; // must match .cb-sweep / .cb-spin duration in index.css
const MAX_BLIPS = 40;

/** Reserved status colours — the same language as the Monitors pages, never reused for anything else. */
function statusColor(status: MonitorStatus): string {
  if (status === 'up') return 'hsl(160 84% 55%)';        // emerald
  if (status === 'down') return 'hsl(var(--destructive))';
  if (status === 'pending') return 'hsl(43 96% 56%)';    // amber
  return 'hsl(var(--muted-foreground) / 0.6)';           // paused
}

const TYPE_TAG: Record<string, string> = { http: 'HTTP', ping: 'PING', tcp: 'TCP', dns: 'DNS' };

interface Blip { m: MonitorSummary; x: number; y: number; aDeg: number }

/**
 * The monitors' own scope. Same look as the connector radar, but every blip is
 * an uptime monitor: wedges are probe types (HTTP / PING / TCP / DNS) instead
 * of connectors, and colour means status — green up, red down (pulsing halo),
 * amber pending, hollow paused.
 */
function MonitorScope({ monitors, hovered, onHover }: { monitors: MonitorSummary[]; hovered: string | null; onHover: (id: string | null) => void }) {
  // Down monitors always make the cut; the rest fill the remaining slots.
  const down = monitors.filter((m) => m.status === 'down');
  const shown = monitors.length <= MAX_BLIPS
    ? monitors
    : [...down, ...monitors.filter((m) => m.status !== 'down').slice(0, Math.max(0, MAX_BLIPS - down.length))];

  const order: string[] = [];
  const byType = new Map<string, MonitorSummary[]>();
  for (const m of shown) {
    if (!byType.has(m.type)) { byType.set(m.type, []); order.push(m.type); }
    byType.get(m.type)!.push(m);
  }
  const C = order.length || 1;

  const blips: Blip[] = [];
  const sectors: { type: string; midDeg: number; startDeg: number }[] = [];
  order.forEach((type, ci) => {
    const arr = byType.get(type)!;
    const secStart = -90 + ci * (360 / C);
    const secWidth = 360 / C;
    const pad = Math.min(14, secWidth * 0.1);
    const aStart = secStart + pad;
    const aEnd = secStart + secWidth - pad;
    sectors.push({ type, midDeg: secStart + secWidth / 2, startDeg: secStart });
    const n = arr.length;
    arr.forEach((m, j) => {
      const frac = n > 1 ? j / (n - 1) : 0.5;
      const aDeg = C === 1 ? aStart + (j / Math.max(1, n)) * (aEnd - aStart) : aStart + frac * (aEnd - aStart);
      const radius = 46 + ((j % 4) * 22) + (Math.floor(j / 4) % 2) * 11;
      const a = (aDeg * Math.PI) / 180;
      blips.push({ m, x: 150 + Math.cos(a) * radius, y: 150 + Math.sin(a) * radius, aDeg });
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

        {C > 1 && sectors.map((s) => {
          const a = (s.startDeg * Math.PI) / 180;
          return <line key={`spoke-${s.type}`} x1="150" y1="150" x2={150 + Math.cos(a) * 142} y2={150 + Math.sin(a) * 142} stroke="hsl(var(--accent) / 0.12)" strokeWidth="1" strokeDasharray="2 4" />;
        })}
        {sectors.map((s) => {
          const a = (s.midDeg * Math.PI) / 180;
          return (
            <text key={`lbl-${s.type}`} x={150 + Math.cos(a) * 128} y={150 + Math.sin(a) * 128} textAnchor="middle" dominantBaseline="middle"
              className="fill-muted-foreground" style={{ fontSize: 8, letterSpacing: '0.12em', opacity: 0.75 }}>
              {TYPE_TAG[s.type] ?? s.type.toUpperCase()}
            </text>
          );
        })}

        <g className="cb-spin" style={{ transformOrigin: 'center' }}>
          <line x1="150" y1="150" x2="150" y2="10" stroke="hsl(var(--accent))" strokeWidth="1.5" style={{ filter: 'drop-shadow(0 0 4px hsl(var(--accent)/0.8))' }} />
        </g>

        {blips.map(({ m, x, y, aDeg }) => {
          const hot = hovered === m.id;
          const color = statusColor(m.status);
          const up = m.status === 'up';
          const isDown = m.status === 'down';
          const r = hot ? 6.5 : isDown ? 5.5 : 4.5;
          const delay = ((((aDeg + 90) % 360) + 360) % 360) / 360 * SWEEP_SECONDS;
          const d = `M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z`;
          return (
            <g key={m.id} onMouseEnter={() => onHover(m.id)} onMouseLeave={() => onHover(null)} style={{ cursor: 'pointer' }}>
              {isDown && <circle cx={x} cy={y} r="9" fill="none" stroke={color} strokeWidth="1" className="cb-pulse-ring" />}
              {hot && <circle cx={x} cy={y} r="11" fill="none" stroke={color} strokeWidth="1" opacity="0.8" />}
              <path d={d} fill={m.status === 'paused' ? 'transparent' : color} stroke={color} strokeWidth={1.4}
                className={up && !hot ? 'cb-ping' : ''}
                style={{ animationDelay: `${delay}s`, filter: up || isDown || hot ? `drop-shadow(0 0 5px ${color})` : undefined, transformBox: 'fill-box', transformOrigin: 'center' }}>
                <title>{m.name} · {m.target} · {m.status}{m.lastLatencyMs != null && up ? ` · ${m.lastLatencyMs} ms` : ''}</title>
              </path>
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

/** Dashboard row: the monitor scope on the left, the hover-synced monitor list on the right. */
export function MonitorRadar({ monitors }: { monitors: MonitorSummary[] }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const down = monitors.filter((m) => m.status === 'down');
  const up = monitors.filter((m) => m.status === 'up').length;
  const pending = monitors.filter((m) => m.status === 'pending').length;
  const paused = monitors.filter((m) => m.status === 'paused').length;
  const active = monitors.length - paused;
  const withHistory = monitors.filter((m) => m.enabled && m.uptime24h !== null);
  const avgUptime = withHistory.length > 0 ? withHistory.reduce((a, m) => a + (m.uptime24h ?? 0), 0) / withHistory.length : null;
  const lastCheck = monitors.reduce<string | null>((acc, m) => (m.lastCheckAt && (!acc || m.lastCheckAt > acc) ? m.lastCheckAt : acc), null);
  const alert = down.length > 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className={cn('relative overflow-hidden rounded-2xl border cerebro-aurora transition-colors', alert ? 'border-destructive/40' : 'border-border/60')}>
        <div className="absolute inset-0 pointer-events-none opacity-[0.12] cb-gridfloor" />
        {alert && <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(circle at 50% 55%, transparent 45%, hsl(var(--destructive) / 0.10))' }} />}

        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none flex items-center gap-2">
          <Brand />
          <span className="font-mono text-[11px] uppercase tracking-[0.3em] text-muted-foreground">Monitors</span>
        </div>

        <HudBox pos="top-4 left-5">
          <div className="text-muted-foreground/70">Monitors up</div>
          <div className={cn('text-sm', down.length ? 'text-destructive' : 'text-emerald-400')}>{up}/{active}</div>
          {pending > 0 && <div className="text-amber-400/80">{pending} pending</div>}
        </HudBox>

        <HudBox pos="top-4 right-5 text-right">
          <div className="text-muted-foreground/70">Last check</div>
          <div className="text-accent/90">{lastCheck ? timeAgo(lastCheck) : '—'}</div>
        </HudBox>

        <HudBox pos="bottom-4 left-5">
          {down.length > 0 ? (
            <div className="space-y-0.5">
              {down.slice(0, 3).map((m) => (
                <Link key={m.id} to={`/monitors/${m.id}`} className="text-destructive flex items-center gap-1.5 hover:underline">
                  <span className="h-1.5 w-1.5 rounded-full bg-destructive animate-pulse" /> {m.name} · down
                </Link>
              ))}
              {down.length > 3 && <div className="text-destructive/70">+{down.length - 3} more</div>}
            </div>
          ) : (
            <div className="text-emerald-400 flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> All monitors passing</div>
          )}
        </HudBox>

        <HudBox pos="bottom-4 right-5 text-right">
          <div className="text-muted-foreground/70">Uptime 24h</div>
          <div className={pctColor(avgUptime)}>{pct(avgUptime)}</div>
          {paused > 0 && <div className="text-muted-foreground/70">{paused} paused</div>}
        </HudBox>

        <div className="relative grid place-items-center py-6 min-h-[340px]">
          <MonitorScope monitors={monitors} hovered={hovered} onHover={setHovered} />
        </div>
      </div>

      <div className="rounded-2xl border border-border/60 bg-card/70 backdrop-blur p-4 flex flex-col">
        <div className="flex items-center gap-2 mb-3">
          <HeartPulse className="h-4 w-4 text-accent" />
          <span className="text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground">Monitors</span>
          <Link to="/monitors" className="ml-auto text-xs text-muted-foreground hover:text-foreground">{monitors.length} · view all</Link>
        </div>
        <div className="space-y-1 overflow-y-auto max-h-[280px] pr-1">
          {[...monitors].sort((a, b) => rank(a.status) - rank(b.status)).map((m) => (
            <Link key={m.id} to={`/monitors/${m.id}`} onMouseEnter={() => setHovered(m.id)} onMouseLeave={() => setHovered(null)}
              className={cn('flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors', hovered === m.id ? 'bg-muted/60' : 'hover:bg-muted/40')}>
              <span className="h-2 w-2 rotate-45 shrink-0"
                style={m.status === 'paused'
                  ? { border: `1px solid ${statusColor(m.status)}` }
                  : { background: statusColor(m.status), boxShadow: m.status !== 'pending' ? `0 0 6px ${statusColor(m.status)}` : undefined }} />
              <span className={cn('text-sm truncate', m.status === 'down' && 'text-destructive')}>{m.name}</span>
              <span className="ml-auto text-[10px] font-mono uppercase tracking-wider shrink-0 text-muted-foreground">
                {m.status === 'up' && m.lastLatencyMs != null ? `${m.lastLatencyMs} ms` : m.status}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Down first, then pending, up, paused. */
function rank(s: MonitorStatus): number {
  return { down: 0, pending: 1, up: 2, paused: 3 }[s] ?? 4;
}
