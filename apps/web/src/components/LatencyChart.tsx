import { useEffect, useMemo, useRef, useState } from 'react';
import type { MonitorChartPoint } from '@cerebro/shared';
import { STATUS } from '@/pages/monitors/monitor-ui';
import { cn } from '@/lib/utils';

const H = 220;
const PAD = { top: 12, right: 12, bottom: 24, left: 44 };

/**
 * Single-series response-time line with a crosshair tooltip. Failed checks
 * (no latency) are drawn as red ticks on the baseline so outages stay visible
 * even though they have no y-value.
 */
export function LatencyChart({ points, className }: { points: MonitorChartPoint[]; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Draw in CSS pixels (measured via ResizeObserver) so text and strokes never stretch.
  const [W, setW] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w > 0) setW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const model = useMemo(() => {
    if (points.length === 0) return null;
    const t0 = new Date(points[0].at).getTime();
    const t1 = Math.max(new Date(points[points.length - 1].at).getTime(), t0 + 1);
    const maxY = Math.max(10, ...points.map((p) => p.latencyMs ?? 0));
    const yMax = niceCeil(maxY);
    const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
    const y = (v: number) => PAD.top + (1 - v / yMax) * (H - PAD.top - PAD.bottom);
    const pts = points.map((p) => ({ ...p, t: new Date(p.at).getTime(), x: x(new Date(p.at).getTime()), y: p.latencyMs == null ? null : y(p.latencyMs) }));
    // Break the line at gaps (failed checks) rather than bridging them.
    const segments: string[] = [];
    let cur: string[] = [];
    for (const p of pts) {
      if (p.y == null) { if (cur.length) segments.push(cur.join(' ')); cur = []; continue; }
      cur.push(`${cur.length ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    }
    if (cur.length) segments.push(cur.join(' '));
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: Math.round(yMax * f), y: y(yMax * f) }));
    const span = t1 - t0;
    const xLabels = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ x: x(t0 + span * f), label: fmtTime(t0 + span * f, span) }));
    return { pts, segments, ticks, xLabels, yMax, baseline: y(0) };
  }, [points, W]);

  if (!model) {
    return <div className={cn('h-[220px] grid place-items-center text-sm text-muted-foreground', className)}>No data in this range yet.</div>;
  }

  function onMove(e: React.MouseEvent) {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestD = Infinity;
    model!.pts.forEach((p, i) => { const d = Math.abs(p.x - px); if (d < bestD) { bestD = d; best = i; } });
    setHover(best);
  }

  const hp = hover != null ? model.pts[hover] : null;

  return (
    <div ref={ref} className={cn('relative w-full select-none', className)} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full">
        {model.ticks.map((t) => (
          <g key={t.v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} className="stroke-border/60" strokeWidth={1} />
            <text x={PAD.left - 6} y={t.y + 3} textAnchor="end" className="fill-muted-foreground" fontSize={10}>{t.v}</text>
          </g>
        ))}
        {model.xLabels.map((l, i) => (
          <text key={i} x={l.x} y={H - 6} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'} className="fill-muted-foreground" fontSize={10}>{l.label}</text>
        ))}
        {model.segments.map((d, i) => (
          <path key={i} d={d} fill="none" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {model.pts.filter((p) => p.status !== 'up').map((p, i) => (
          <rect key={i} x={p.x - 1.5} y={model.baseline - 8} width={3} height={8} className={p.status === 'down' ? 'fill-red-500' : 'fill-amber-400'} />
        ))}
        {hp && (
          <g>
            <line x1={hp.x} x2={hp.x} y1={PAD.top} y2={model.baseline} className="stroke-foreground/40" strokeWidth={1} strokeDasharray="3 3" />
            {hp.y != null && <circle cx={hp.x} cy={hp.y} r={4} className="fill-primary stroke-background" strokeWidth={2} />}
          </g>
        )}
      </svg>
      <div className="absolute left-11 top-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70">ms</div>
      {hp && (
        <div
          className="pointer-events-none absolute top-2 rounded-md border border-border bg-card/95 px-2.5 py-1.5 text-xs shadow-lg"
          style={{ left: `${Math.min(85, Math.max(0, (hp.x / W) * 100))}%` }}
        >
          <div className="text-muted-foreground">{new Date(hp.t).toLocaleString()}</div>
          <div className="flex items-center gap-1.5 font-medium">
            <span className={cn('inline-block h-2 w-2 rounded-full', STATUS[hp.status]?.dot)} />
            {STATUS[hp.status]?.label}{hp.latencyMs != null ? ` · ${hp.latencyMs} ms` : ''}
          </div>
        </div>
      )}
    </div>
  );
}

function niceCeil(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return m * p;
}

function fmtTime(t: number, span: number): string {
  const d = new Date(t);
  if (span > 2 * 86_400_000) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
