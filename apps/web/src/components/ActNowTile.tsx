import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, ListChecks, ShieldCheck } from 'lucide-react';
import { ACT_NOW_SOURCE_LABEL, ACT_NOW_TIER_LABEL, ACT_NOW_TIERS, type ActNowSummary, type ActNowTier, type Permission } from '@cerebro/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Act Now (docs/act-now.md): tier colours, the summary hook behind the sidebar badge, and the Dashboard tile. */

/* eslint-disable react-refresh/only-export-components */
export const TIER_STRIPE: Record<ActNowTier, string> = { 1: 'bg-red-600', 2: 'bg-orange-500', 3: 'bg-violet-500', 4: 'bg-amber-400' };
export const TIER_DOT = TIER_STRIPE;
export const TIER_TEXT: Record<ActNowTier, string> = {
  1: 'text-red-600 dark:text-red-400',
  2: 'text-orange-600 dark:text-orange-400',
  3: 'text-violet-600 dark:text-violet-300',
  4: 'text-amber-600 dark:text-amber-300',
};
/** Anyone who can read at least one source sees Act Now. */
export const ACT_NOW_PERMS: Permission[] = ['fabric:read', 'connectors:read', 'backup:read'];

const POLL_MS = 2 * 60_000;
type Listener = (s: ActNowSummary | null) => void;
let last: ActNowSummary | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<Listener>();
const fetchSummary = () => api.get<ActNowSummary>('/api/act-now/summary').then((s) => { last = s; listeners.forEach((l) => l(s)); }).catch(() => undefined);

/** One shared poll (every 2 minutes) for the sidebar badge and the Dashboard tile. */
export function useActNowSummary(enabled: boolean): ActNowSummary | null {
  const [s, setS] = useState<ActNowSummary | null>(last);
  useEffect(() => {
    if (!enabled) return;
    listeners.add(setS);
    if (!timer) {
      void fetchSummary();
      timer = setInterval(fetchSummary, POLL_MS);
    } else if (last) setS(last);
    return () => {
      listeners.delete(setS);
      if (!listeners.size && timer) { clearInterval(timer); timer = null; }
    };
  }, [enabled]);
  return enabled ? s : null;
}
/* eslint-enable react-refresh/only-export-components */

/** Dashboard tile: counts per tier and the top three items. */
export function ActNowTile() {
  const s = useActNowSummary(true);
  if (!s) return null;
  if (!s.total)
    return (
      <Link to="/act-now" className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-4 py-2.5 hover:border-primary/60">
        <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
        <span className="font-lcars text-sm tracking-[0.14em]">ACT NOW</span>
        <span className="text-sm text-muted-foreground">Nothing urgent to fix.</span>
        <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
      </Link>
    );
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <ListChecks className="h-4 w-4 text-primary shrink-0" />
        <h3 className="font-lcars text-sm font-semibold tracking-[0.14em]">ACT NOW</h3>
        <span className="flex flex-wrap gap-1.5 text-xs">
          {ACT_NOW_TIERS.filter((t) => s.counts[t]).map((t) => (
            <span key={t} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 tabular-nums">
              <span className={cn('h-2 w-2 rounded-full', TIER_DOT[t])} />{s.counts[t]} {ACT_NOW_TIER_LABEL[t].toLowerCase()}
            </span>
          ))}
          {!!s.overdue && <span className="rounded-full bg-red-500/15 text-red-600 dark:text-red-400 px-2 py-0.5 font-semibold tabular-nums">{s.overdue} overdue</span>}
        </span>
        <Link to="/act-now" className="ml-auto text-xs text-accent hover:underline whitespace-nowrap">See all {s.total}</Link>
      </div>
      <div className="flex flex-col divide-y divide-border rounded-md border border-border">
        {s.top.map((i) => (
          <Link key={i.key} to={`/act-now?item=${encodeURIComponent(i.key)}`} className="grid grid-cols-[4px_minmax(0,1fr)_auto] gap-x-3 pr-3 py-2 hover:bg-muted/60">
            <span className={cn('self-stretch rounded-r', TIER_STRIPE[i.tier])} />
            <span className="min-w-0">
              <span className="block text-sm font-medium truncate">{i.title}</span>
              <span className="block text-xs text-muted-foreground truncate">{i.reason}</span>
            </span>
            <span className="self-center text-[11px] uppercase tracking-wider text-muted-foreground">{ACT_NOW_SOURCE_LABEL[i.source]}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
