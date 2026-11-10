import type { HealthAvailability, HealthMachine, HealthRole, HealthStatus } from '@cerebro/shared';
import { Laptop, Server } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Health UI helpers shared by the fleet list and the machine page. */

export const STATUS_STYLE: Record<HealthStatus, { label: string; dot: string; text: string }> = {
  ok: { label: 'Healthy', dot: 'bg-emerald-400', text: 'text-emerald-400' },
  warning: { label: 'Warning', dot: 'bg-amber-400', text: 'text-amber-400' },
  critical: { label: 'Critical', dot: 'bg-red-500', text: 'text-red-400' },
  offline: { label: 'Offline', dot: 'bg-muted-foreground/50', text: 'text-muted-foreground' },
  unknown: { label: 'No data', dot: 'bg-sky-400/60', text: 'text-sky-300' },
};

export function StatusDot({ status, className }: { status: HealthStatus; className?: string }) {
  return <span className={cn('inline-block h-2.5 w-2.5 rounded-full shrink-0', STATUS_STYLE[status].dot, className)} title={STATUS_STYLE[status].label} />;
}

export function osLabel(os?: string | null): string {
  switch ((os ?? '').toLowerCase()) {
    case 'linux': return 'Linux';
    case 'darwin': return 'macOS';
    case 'windows': return 'Windows';
    default: return os || 'Unknown';
  }
}

export function RoleIcon({ role, className }: { role: HealthRole; className?: string }) {
  const Icon = role === 'workstation' ? Laptop : Server;
  return <Icon className={cn('h-4 w-4', className)} />;
}

export function roleLabel(role: HealthRole): string {
  return role === 'workstation' ? 'Workstation' : 'Server';
}

/** Color for a used-% value against warn/crit limits. */
export function pctTone(pct: number | null | undefined, warn = 85, crit = 95): string {
  if (pct == null) return 'bg-muted-foreground/30';
  if (pct >= crit) return 'bg-red-500';
  if (pct >= warn) return 'bg-amber-400';
  return 'bg-emerald-400';
}

export function PctBar({ pct, warn, crit, className }: { pct: number | null | undefined; warn?: number; crit?: number; className?: string }) {
  return (
    <div className={cn('h-1.5 w-full rounded-full bg-muted overflow-hidden', className)}>
      <div className={cn('h-full rounded-full transition-all', pctTone(pct, warn, crit))} style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} />
    </div>
  );
}

export function fmtPct(v: number | null | undefined): string {
  return v == null ? '—' : `${Math.round(v)}%`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/** Bytes/s as bits/s, the way people read network speed. */
export function fmtBitRate(bps: number | null | undefined): string {
  if (bps == null) return '—';
  const bits = bps * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(1)} Gb/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb/s`;
  if (bits >= 1e3) return `${Math.round(bits / 1e3)} kb/s`;
  return `${Math.round(bits)} b/s`;
}

export function fmtByteRate(bps: number | null | undefined): string {
  return bps == null ? '—' : `${fmtBytes(bps)}/s`;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60 ? `${m % 60}m` : ''}`.trim();
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24 ? `${h % 24}h` : ''}`.trim();
}

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return 'just now';
  return `${fmtDuration(s)} ago`;
}

export function worstDisk(m: HealthMachine) {
  const ds = m.latest?.disks ?? [];
  return ds.length ? ds.reduce((a, b) => (b.pct > a.pct ? b : a)) : null;
}

/** "Online 31h · offline 137h" style summary for one window. */
export function AvailabilityLine({ a, label }: { a: HealthAvailability; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground w-20 shrink-0">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden" title={a.pct == null ? 'No data yet' : `${a.pct}% online`}>
        <div className="h-full bg-emerald-400/80" style={{ width: `${a.pct ?? 0}%` }} />
      </div>
      <span className="tabular-nums text-xs w-44 text-right shrink-0">
        <span className="text-emerald-400">{fmtDuration(a.onlineSec)}</span>
        <span className="text-muted-foreground"> on · </span>
        <span>{fmtDuration(a.offlineSec)}</span>
        <span className="text-muted-foreground"> off</span>
      </span>
    </div>
  );
}

/** Tiny 24 h trend line (values 0–100). */
export function Sparkline({ values, className, tone = 'stroke-primary' }: { values: (number | null)[]; className?: string; tone?: string }) {
  const W = 80;
  const H = 22;
  // A single reading (a brand-new machine) is drawn as a flat line rather than nothing.
  const vals = values.length === 1 ? [values[0], values[0]] : values;
  const pts = vals.map((v, i) => ({ v, x: vals.length > 1 ? (i / (vals.length - 1)) * W : W / 2 }));
  const segs: string[] = [];
  let cur: string[] = [];
  for (const p of pts) {
    if (p.v == null) { if (cur.length) segs.push(cur.join(' ')); cur = []; continue; }
    const y = H - 1 - (Math.min(100, Math.max(0, p.v)) / 100) * (H - 2);
    cur.push(`${cur.length ? 'L' : 'M'}${p.x.toFixed(1)},${y.toFixed(1)}`);
  }
  if (cur.length) segs.push(cur.join(' '));
  if (!segs.length) return <span className={cn('inline-block', className)} style={{ width: W, height: H }} />;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className={cn('overflow-visible', className)} aria-hidden>
      {segs.map((d, i) => <path key={i} d={d} fill="none" className={tone} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />)}
    </svg>
  );
}
