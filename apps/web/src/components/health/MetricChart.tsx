import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface ChartSeries {
  key: string;
  label: string;
  /** Tailwind stroke + fill classes, e.g. 'stroke-sky-400' / 'bg-sky-400'. */
  stroke: string;
  swatch: string;
  values: (number | null)[];
  dashed?: boolean;
}

const H = 180;
const PAD = { top: 10, right: 12, bottom: 22, left: 52 };

/**
 * Multi-series line chart over time with a crosshair tooltip. `unit: 'pct'`
 * pins the y-axis to 0–100; otherwise it scales to the data and labels values
 * with `format`. Gaps (null) break the line instead of bridging an outage.
 */
export function MetricChart({
  times,
  series,
  unit = 'pct',
  format,
  className,
  limits,
}: {
  times: string[];
  series: ChartSeries[];
  unit?: 'pct' | 'value';
  format?: (v: number) => string;
  className?: string;
  /** Horizontal reference lines (e.g. warn/crit thresholds). */
  limits?: { value: number; tone: 'warn' | 'crit' }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => {
      const w = Math.round(e[0]?.contentRect.width ?? 0);
      if (w > 0) setW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fmt = format ?? ((v: number) => (unit === 'pct' ? `${Math.round(v)}%` : String(Math.round(v))));

  const model = useMemo(() => {
    if (!times.length) return null;
    const ts = times.map((t) => new Date(t).getTime());
    const t0 = ts[0];
    const t1 = Math.max(ts[ts.length - 1], t0 + 1);
    let yMax = 100;
    if (unit !== 'pct') {
      const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
      yMax = niceCeil(Math.max(1, ...all));
    }
    const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
    const y = (v: number) => PAD.top + (1 - Math.min(v, yMax) / yMax) * (H - PAD.top - PAD.bottom);
    // Break lines where samples are further apart than 3× the typical spacing (an outage).
    const gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
    const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    const paths = series.map((s) => {
      const segs: string[] = [];
      let cur: string[] = [];
      s.values.forEach((v, i) => {
        const broken = i > 0 && typical > 0 && ts[i] - ts[i - 1] > typical * 3;
        if (v == null || broken) { if (cur.length) segs.push(cur.join(' ')); cur = []; }
        if (v == null) return;
        cur.push(`${cur.length ? 'L' : 'M'}${x(ts[i]).toFixed(1)},${y(v).toFixed(1)}`);
      });
      if (cur.length) segs.push(cur.join(' '));
      return segs;
    });
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: yMax * f, y: y(yMax * f) }));
    const span = t1 - t0;
    const xLabels = [0, 0.5, 1].map((f) => ({ x: x(t0 + span * f), label: fmtTime(t0 + span * f, span) }));
    return { ts, x, y, paths, ticks, xLabels };
  }, [times, series, W, unit]);

  if (!model) {
    return <div className={cn('h-[180px] grid place-items-center text-sm text-muted-foreground', className)}>No data in this range yet.</div>;
  }

  function onMove(e: React.MouseEvent) {
    const el = ref.current;
    if (!el || !model) return;
    const rect = el.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestD = Infinity;
    model.ts.forEach((t, i) => { const d = Math.abs(model.x(t) - px); if (d < bestD) { bestD = d; best = i; } });
    setHover(best);
  }
  const hx = hover != null ? model.x(model.ts[hover]) : null;

  return (
    <div className={cn('w-full', className)}>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mb-1 text-xs text-muted-foreground">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className={cn('inline-block h-0.5 w-3 rounded', s.swatch)} />{s.label}
          </span>
        ))}
      </div>
      <div ref={ref} className="relative select-none" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full">
          {model.ticks.map((t, i) => (
            <g key={i}>
              <line x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} className="stroke-border/60" strokeWidth={1} />
              <text x={PAD.left - 6} y={t.y + 3} textAnchor="end" className="fill-muted-foreground" fontSize={10}>{fmt(t.v)}</text>
            </g>
          ))}
          {limits?.map((l, i) => (
            <line key={`l${i}`} x1={PAD.left} x2={W - PAD.right} y1={model.y(l.value)} y2={model.y(l.value)}
              className={l.tone === 'crit' ? 'stroke-red-500/60' : 'stroke-amber-400/60'} strokeWidth={1} strokeDasharray="4 4" />
          ))}
          {model.xLabels.map((l, i) => (
            <text key={i} x={l.x} y={H - 6} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} className="fill-muted-foreground" fontSize={10}>{l.label}</text>
          ))}
          {model.paths.map((segs, si) => segs.map((d, i) => (
            <path key={`${si}-${i}`} d={d} fill="none" className={series[si].stroke} strokeWidth={1.75}
              strokeDasharray={series[si].dashed ? '3 3' : undefined} strokeLinejoin="round" strokeLinecap="round" />
          )))}
          {hx != null && <line x1={hx} x2={hx} y1={PAD.top} y2={H - PAD.bottom} className="stroke-foreground/40" strokeWidth={1} strokeDasharray="3 3" />}
        </svg>
        {hover != null && (
          <div className="pointer-events-none absolute top-1 rounded-md border border-border bg-card/95 px-2.5 py-1.5 text-xs shadow-lg z-10"
            style={{ left: `${Math.min(70, Math.max(0, ((hx ?? 0) / W) * 100))}%` }}>
            <div className="text-muted-foreground">{new Date(model.ts[hover]).toLocaleString()}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-1.5">
                <span className={cn('inline-block h-2 w-2 rounded-full', s.swatch)} />
                <span className="text-muted-foreground">{s.label}</span>
                <span className="ml-auto pl-3 tabular-nums">{s.values[hover] == null ? '—' : fmt(s.values[hover]!)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
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
