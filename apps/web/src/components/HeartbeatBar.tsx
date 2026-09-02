import type { MonitorHeartbeat } from '@cerebro/shared';
import { STATUS } from '@/pages/monitors/monitor-ui';
import { cn } from '@/lib/utils';

/**
 * The Kuma-style strip of recent checks, oldest on the left, newest on the
 * right. Always renders `slots` bars so rows line up; missing history shows
 * as empty slots.
 */
export function HeartbeatBar({
  beats, slots = 40, className, barClassName = 'h-6',
}: {
  beats: MonitorHeartbeat[];
  slots?: number;
  className?: string;
  barClassName?: string;
}) {
  const shown = beats.slice(-slots);
  const empty = Math.max(0, slots - shown.length);
  return (
    <div className={cn('flex items-stretch gap-[2px]', className)} role="img" aria-label="Recent checks">
      {Array.from({ length: empty }).map((_, i) => (
        <span key={`e${i}`} className={cn('flex-1 min-w-[3px] rounded-sm bg-muted/40', barClassName)} />
      ))}
      {shown.map((b, i) => (
        <span
          key={`${b.at}-${i}`}
          className={cn('flex-1 min-w-[3px] rounded-sm transition-opacity hover:opacity-70', STATUS[b.status]?.bar ?? STATUS.pending.bar, barClassName)}
          title={`${new Date(b.at).toLocaleString()}\n${STATUS[b.status]?.label ?? b.status}${b.latencyMs != null ? ` · ${b.latencyMs} ms` : ''}${b.message ? `\n${b.message}` : ''}`}
        />
      ))}
    </div>
  );
}
