import { Globe, Radio, Plug, Search, CircleHelp } from 'lucide-react';
import type { MonitorStatus } from '@cerebro/shared';
import { cn } from '@/lib/utils';

/** Reserved status colours — up / down / pending / paused. Never reused for anything else. */
export const STATUS: Record<MonitorStatus, { label: string; dot: string; badge: string; bar: string }> = {
  up:      { label: 'Up',      dot: 'bg-emerald-400', badge: 'bg-emerald-500/15 text-emerald-400', bar: 'bg-emerald-400' },
  down:    { label: 'Down',    dot: 'bg-red-500',     badge: 'bg-red-500/15 text-red-400',         bar: 'bg-red-500' },
  pending: { label: 'Pending', dot: 'bg-amber-400',   badge: 'bg-amber-500/15 text-amber-400',     bar: 'bg-amber-400' },
  paused:  { label: 'Paused',  dot: 'bg-muted-foreground/50', badge: 'bg-muted text-muted-foreground', bar: 'bg-muted-foreground/40' },
};

export function StatusDot({ status, className }: { status: MonitorStatus; className?: string }) {
  const s = STATUS[status] ?? STATUS.pending;
  return (
    <span className={cn('relative inline-flex h-2.5 w-2.5 shrink-0', className)} aria-label={s.label}>
      {status === 'down' && <span className={cn('absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping', s.dot)} />}
      <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', s.dot)} />
    </span>
  );
}

export function StatusBadge({ status }: { status: MonitorStatus }) {
  const s = STATUS[status] ?? STATUS.pending;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium rounded-full px-2 py-0.5', s.badge)}>
      <StatusDot status={status} />
      {s.label}
    </span>
  );
}

/** Glyph per probe type. */
export function TypeIcon({ type, className = 'h-5 w-5' }: { type: string; className?: string }) {
  switch (type) {
    case 'http': return <Globe className={className} />;
    case 'ping': return <Radio className={className} />;
    case 'tcp': return <Plug className={className} />;
    case 'dns': return <Search className={className} />;
    default: return <CircleHelp className={className} />;
  }
}

/** 0.99987 → "99.99%"; null → "—". */
export function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const p = v * 100;
  return `${p >= 99.995 ? '100' : p.toFixed(2)}%`;
}

/** Latency for display. */
export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v} ms`;
}

/** Colour a percentage: green ≥ 99, amber ≥ 95, else red. */
export function pctColor(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'text-muted-foreground';
  if (v >= 0.99) return 'text-emerald-400';
  if (v >= 0.95) return 'text-amber-400';
  return 'text-red-400';
}
