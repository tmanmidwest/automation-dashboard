import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, Minus } from 'lucide-react';
import type { TopologyProgress, TopologyStep } from '@cerebro/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * "Checking your connectors": a radar sweep with a blip per step, and the step list beside it,
 * driven by GET /api/topology/progress while a map build runs. Every step shown is a real one
 * (each connector the map reads, then Cerebro's own checks); the bar is steps finished out of
 * all steps, nudged forward within the running step by how long the last build took.
 */

/** Polls the build's progress while `active`. */
export function useBuildProgress(active: boolean): TopologyProgress | null {
  const [p, setP] = useState<TopologyProgress | null>(null);
  useEffect(() => {
    if (!active) return;
    let stop = false;
    const tick = () => api.get<TopologyProgress>('/api/topology/progress').then((x) => { if (!stop) setP(x); }).catch(() => undefined);
    tick();
    const t = window.setInterval(tick, 500);
    return () => { stop = true; window.clearInterval(t); };
  }, [active]);
  return active ? p : null;
}

const finished = (s: TopologyStep) => s.state === 'done' || s.state === 'failed' || s.state === 'skipped';

function percent(p: TopologyProgress | null, now: number): number {
  if (!p?.steps.length) return 0;
  const done = p.steps.filter(finished).length;
  let frac = done / p.steps.length;
  // Inside the running steps, creep forward by elapsed time against the last build's length.
  if (p.running && p.startedAt && p.lastDurationMs) {
    const byTime = Math.min(0.95, (now - new Date(p.startedAt).getTime()) / p.lastDurationMs);
    frac = Math.max(frac, Math.min(byTime, (done + 1) / p.steps.length - 0.01));
  }
  return Math.round(Math.min(1, frac) * 100);
}

const BLIP: Record<TopologyStep['state'], string> = {
  waiting: 'fill-muted-foreground opacity-30',
  running: 'fill-accent',
  done: 'fill-emerald-500',
  failed: 'fill-amber-400',
  skipped: 'fill-muted-foreground opacity-50',
};

function Radar({ steps, pct, size }: { steps: TopologyStep[]; pct: number; size: number }) {
  const c = 100;
  // Blips sit on two rings, connectors outside and Cerebro's checks inside, spread round the dial.
  const outer = steps.filter((s) => s.kind !== 'check');
  const inner = steps.filter((s) => s.kind === 'check');
  const place = (list: TopologyStep[], r: number, offset: number) =>
    list.map((s, i) => {
      const a = ((i / Math.max(1, list.length)) * 2 * Math.PI) + offset;
      return { s, x: c + r * Math.cos(a), y: c + r * Math.sin(a) };
    });
  const blips = [...place(outer, 78, -Math.PI / 2), ...place(inner, 46, -Math.PI / 2 + 0.4)];
  return (
    <svg viewBox="0 0 200 200" width={size} height={size} className="shrink-0 max-w-full" role="img" aria-label={`Checking, ${pct}% done`}>
      <defs>
        <linearGradient id="cerebro-sweep" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="hsl(var(--accent))" stopOpacity="0" />
          <stop offset="100%" stopColor="hsl(var(--accent))" stopOpacity="0.45" />
        </linearGradient>
      </defs>
      {[94, 78, 62, 46, 30].map((r) => (
        <circle key={r} cx={c} cy={c} r={r} className="fill-none stroke-border" strokeWidth={r === 94 ? 1.5 : 1} />
      ))}
      <line x1={c} y1={6} x2={c} y2={194} className="stroke-border" strokeWidth={0.75} />
      <line x1={6} y1={c} x2={194} y2={c} className="stroke-border" strokeWidth={0.75} />
      {/* Progress arc round the outside. */}
      <circle cx={c} cy={c} r={94} fill="none" stroke="hsl(var(--primary))" strokeWidth={3} strokeLinecap="round"
        strokeDasharray={`${(pct / 100) * 2 * Math.PI * 94} ${2 * Math.PI * 94}`} transform={`rotate(-90 ${c} ${c})`}
        className="transition-[stroke-dasharray] duration-500" />
      <g className="cerebro-sweep" style={{ transformOrigin: '100px 100px' }}>
        <path d={`M${c},${c} L${c + 94},${c} A94,94 0 0,0 ${c + 94 * Math.cos(-0.9)},${c + 94 * Math.sin(-0.9)} Z`} fill="url(#cerebro-sweep)" />
        <line x1={c} y1={c} x2={c + 94} y2={c} stroke="hsl(var(--accent))" strokeWidth={1.5} />
      </g>
      {blips.map(({ s, x, y }) => (
        <g key={s.key}>
          {s.state === 'running' && <circle cx={x} cy={y} r={5} className="fill-accent cerebro-ping" style={{ transformOrigin: `${x}px ${y}px` }} />}
          <circle cx={x} cy={y} r={s.kind === 'check' ? 3 : 4.5} className={cn(BLIP[s.state], 'transition-colors duration-300')}>
            <title>{s.label}</title>
          </circle>
        </g>
      ))}
      <circle cx={c} cy={c} r={20} className="fill-card stroke-border" />
      <text x={c} y={c + 5} textAnchor="middle" className="fill-foreground font-lcars" fontSize={15} fontWeight={600}>{pct}%</text>
    </svg>
  );
}

function StepIcon({ s }: { s: TopologyStep }) {
  if (s.state === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />;
  if (s.state === 'done') return <Check className="h-3.5 w-3.5 text-emerald-500" />;
  if (s.state === 'failed') return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />;
  if (s.state === 'skipped') return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
  return <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />;
}

export function CheckingView({ progress, title = 'Checking your connectors', compact = false }: { progress: TopologyProgress | null; title?: string; compact?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 250); return () => window.clearInterval(t); }, []);
  const steps = progress?.steps ?? [];
  const pct = percent(progress, now);
  const running = steps.find((s) => s.state === 'running');
  const elapsed = progress?.startedAt ? Math.max(0, Math.round((now - new Date(progress.startedAt).getTime()) / 1000)) : 0;
  const done = steps.filter(finished).length;
  return (
    <div className={cn('rounded-xl border border-border bg-card flex flex-wrap items-center gap-x-8 gap-y-4', compact ? 'p-4' : 'p-6 my-4')} aria-live="polite">
      <style>{`
        @keyframes cerebro-sweep { to { transform: rotate(360deg); } }
        @keyframes cerebro-ping { 0% { transform: scale(1); opacity: .9 } 100% { transform: scale(2.6); opacity: 0 } }
        .cerebro-sweep { animation: cerebro-sweep 2.4s linear infinite; }
        .cerebro-ping { animation: cerebro-ping 1.2s ease-out infinite; }
        @media (prefers-reduced-motion: reduce) { .cerebro-sweep, .cerebro-ping { animation: none; } }
      `}</style>
      <Radar steps={steps} pct={pct} size={compact ? 132 : 200} />
      <div className="flex-[1_1_280px] min-w-0 flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="font-lcars text-lg uppercase tracking-wider">{title}</span>
          <span className="text-sm text-muted-foreground">
            {steps.length ? <>{done} of {steps.length} steps · {elapsed}s{progress?.lastDurationMs ? ` · last check took ${Math.max(1, Math.round(progress.lastDurationMs / 1000))}s` : ''}</> : 'Starting…'}
          </span>
          <div className="mt-1.5 h-1.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
        {compact ? (
          <span className="text-sm truncate">{running ? <>Now: <b className="font-medium">{running.label}</b></> : 'Finishing up…'}</span>
        ) : (
          <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2 text-sm">
            {steps.map((s) => (
              <li key={s.key} className={cn('flex items-start gap-2 min-w-0', s.state === 'waiting' && 'text-muted-foreground')}>
                <span className="mt-0.5 h-4 w-4 grid place-items-center shrink-0"><StepIcon s={s} /></span>
                <span className="min-w-0">
                  <span className="block truncate">{s.label}</span>
                  {s.detail && s.state !== 'waiting' && <span className={cn('block text-xs truncate', s.state === 'failed' ? 'text-amber-600 dark:text-amber-300' : 'text-muted-foreground')}>{s.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
