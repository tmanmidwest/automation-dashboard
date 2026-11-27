import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Clock, ExternalLink, Globe, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  ACT_NOW_SOURCE_LABEL,
  ACT_NOW_TIER_LABEL,
  ACT_NOW_TIERS,
  type ActNowItem,
  type ActNowList,
  type ActNowSource,
  type ActNowTier,
  type Permission,
} from '@cerebro/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Button, buttonVariants } from '@/components/ui/button';
import { TIER_DOT, TIER_STRIPE, TIER_TEXT } from '@/components/ActNowTile';

/**
 * Act Now: one worst-first list of what to fix today, gathered from Health → Updates,
 * Posture and Stack Backups. Rows open a detail with the reason, evidence and a link to
 * the page where it's fixed; snoozing goes through each source's own snooze where it has
 * one. Built by apps/server/src/act-now (rules in act-now.logic.ts). See docs/act-now.md.
 */

const REFRESH_MS = 60_000;
type Filter = 'all' | ActNowSource | 'snoozed';

function age(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function ActNowPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const filter = (params.get('show') || 'all') as Filter;
  const selected = params.get('item');
  const set = useCallback((patch: Record<string, string | null>) => setParams((pp) => {
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') pp.delete(k);
      else pp.set(k, v);
    }
    return pp;
  }, { replace: true }), [setParams]);

  const [data, setData] = useState<ActNowList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      setData(await api.get<ActNowList>(`/api/act-now${manual ? '?refresh=1' : ''}`));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load the list.');
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => load(), REFRESH_MS);
    const onFocus = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onFocus);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onFocus); };
  }, [load]);

  const items = useMemo(() => data?.items ?? [], [data]);
  const snoozed = useMemo(() => data?.snoozed ?? [], [data]);
  const shown = filter === 'snoozed' ? snoozed : filter === 'all' ? items : items.filter((i) => i.source === filter);
  const all = useMemo(() => [...items, ...snoozed], [items, snoozed]);
  const sel = all.find((i) => i.key === selected) ?? (typeof window !== 'undefined' && window.innerWidth >= 1024 ? shown[0] : undefined);
  const pick = (key: string) => { set({ item: key }); setMobileOpen(true); };
  const bySource = (s: ActNowSource) => items.filter((i) => i.source === s).length;
  const allowed = (data?.sources ?? []).filter((s) => s.allowed);
  const failed = allowed.filter((s) => !s.ok);

  return (
    <>
      <PageHeader
        title="Act Now"
        description="What to fix today, worst first: known-exploited problems, broken backups, then critical updates and high-severity findings. Each row links to the page where you fix it."
        actions={
          <div className="flex items-center gap-2">
            {data && <span className="text-xs text-muted-foreground hidden sm:inline">Updated {age(data.generatedAt)}</span>}
            <Button variant="outline" onClick={() => load(true)} disabled={refreshing}>
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} /> Refresh
            </Button>
          </div>
        }
      />
      {err && <div className="mb-3 text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">{err}</div>}
      {!data && !err && <p className="text-sm text-muted-foreground">Gathering updates, security findings and backups…</p>}

      {data && (
        <div className="flex flex-col gap-4">
          <div className="grid gap-2.5 grid-cols-2 lg:grid-cols-4">
            {ACT_NOW_TIERS.map((t) => (
              <div key={t} className="rounded-lg border border-border bg-card px-3.5 py-2.5 flex flex-col gap-0.5 min-w-0">
                <span className={cn('text-[26px] font-bold tabular-nums leading-none', data.counts[t] ? TIER_TEXT[t] : 'text-muted-foreground')}>{data.counts[t]}</span>
                <span className="text-xs text-muted-foreground truncate flex items-center gap-1.5"><span className={cn('h-2 w-2 rounded-full', TIER_DOT[t])} />{ACT_NOW_TIER_LABEL[t]}</span>
              </div>
            ))}
          </div>

          {failed.map((s) => (
            <div key={s.source} className="text-sm rounded-md px-3 py-2 border border-amber-500/40 bg-amber-500/10 flex gap-2 items-start">
              <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
              <span><b className="font-medium">{ACT_NOW_SOURCE_LABEL[s.source]} not included.</b> {s.message}</span>
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            {([
              ['all', 'All', items.length],
              ...allowed.map((s) => [s.source, ACT_NOW_SOURCE_LABEL[s.source], bySource(s.source)] as [Filter, string, number]),
              ['snoozed', 'Snoozed', snoozed.length],
            ] as [Filter, string, number][]).map(([k, label, n]) => (
              <button key={k} aria-pressed={filter === k} onClick={() => set({ show: k === 'all' ? null : k, item: null })}
                className={cn('rounded-md border px-3 py-1.5', filter === k ? 'border-primary bg-primary/10 font-medium' : 'border-border text-muted-foreground hover:text-foreground')}>
                {label} <span className="ml-0.5 tabular-nums">{n}</span>
              </button>
            ))}
            <span className="ml-auto text-xs text-muted-foreground hidden md:inline">
              {allowed.filter((s) => s.ok && s.asOf).map((s) => `${ACT_NOW_SOURCE_LABEL[s.source]} ${age(s.asOf)}`).join(' · ')}
            </span>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] items-start">
            <ItemList items={shown} grouped={filter !== 'snoozed'} selectedKey={sel?.key} onPick={pick} hidden={filter === 'all' ? data.hidden : []} snoozedView={filter === 'snoozed'} />
            {sel && (
              <div className={cn('lg:sticky lg:top-3 lg:block', mobileOpen ? 'fixed inset-0 z-40 overflow-y-auto bg-background p-4 lg:static lg:p-0 lg:bg-transparent' : 'hidden')}>
                <Detail key={sel.key} item={sel} can={can} onBack={() => setMobileOpen(false)} onChanged={() => load(true)} />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function ItemList({ items, grouped, selectedKey, onPick, hidden, snoozedView }: {
  items: ActNowItem[]; grouped: boolean; selectedKey?: string; onPick: (key: string) => void; hidden: ActNowList['hidden']; snoozedView: boolean;
}) {
  if (!items.length) {
    return (
      <div className="rounded-lg border border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-emerald-500" />
        {snoozedView ? 'Nothing is snoozed.' : 'Nothing urgent right now.'}
        {!!hidden.length && <Hidden hidden={hidden} />}
      </div>
    );
  }
  const groups: [ActNowTier | null, ActNowItem[]][] = grouped
    ? ACT_NOW_TIERS.map((t) => [t, items.filter((i) => i.tier === t)] as [ActNowTier, ActNowItem[]]).filter(([, xs]) => xs.length)
    : [[null, items]];
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {groups.map(([t, xs], gi) => (
        <div key={t ?? 'all'}>
          {t && (
            <div className={cn('flex justify-between px-3.5 py-1.5 bg-muted/50 text-[11px] uppercase tracking-wider text-muted-foreground', gi > 0 && 'border-t border-border')}>
              <span>{ACT_NOW_TIER_LABEL[t]}</span><span className="tabular-nums">{xs.length}</span>
            </div>
          )}
          {xs.map((i) => <Row key={i.key} item={i} on={i.key === selectedKey} onPick={onPick} />)}
        </div>
      ))}
      {!!hidden.length && <div className="border-t border-border px-3.5 py-2.5 text-xs text-muted-foreground"><Hidden hidden={hidden} /></div>}
    </div>
  );
}

function Hidden({ hidden }: { hidden: ActNowList['hidden'] }) {
  return (
    <span>
      Not shown:{' '}
      {hidden.map((h, i) => (
        <span key={h.to}>
          {i > 0 && ', '}
          <Link to={h.to} className="text-accent hover:underline">{h.count} {h.label}</Link>
        </span>
      ))}
      .
    </span>
  );
}

function Row({ item, on, onPick }: { item: ActNowItem; on: boolean; onPick: (key: string) => void }) {
  return (
    <button onClick={() => onPick(item.key)} aria-current={on || undefined}
      className={cn('w-full grid grid-cols-[4px_minmax(0,1fr)_auto] gap-x-3 border-t border-border first:border-t-0 pr-3.5 py-2.5 text-left items-center hover:bg-muted/60', on && 'bg-primary/10 hover:bg-primary/10')}>
      <span className={cn('self-stretch rounded-r', TIER_STRIPE[item.tier])} />
      <span className="min-w-0">
        <span className="block text-sm font-medium leading-snug">
          {item.title}
          {item.overdue && <span className="ml-2 align-[1px] rounded-full bg-red-500/15 text-red-600 dark:text-red-400 px-1.5 text-[10.5px] font-semibold">Overdue</span>}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{item.reason}</span>
        {item.staleNote && <span className="mt-0.5 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"><Clock className="h-3 w-3" />{item.staleNote}</span>}
        {item.snoozed && <span className="mt-0.5 block text-xs text-violet-500 dark:text-violet-300">Snoozed{item.snoozed.until ? ` until ${day(item.snoozed.until)}` : ''}{item.snoozed.by ? ` by ${item.snoozed.by}` : ''}</span>}
      </span>
      <span className="text-[11px] text-muted-foreground uppercase tracking-wider whitespace-nowrap">{ACT_NOW_SOURCE_LABEL[item.source]}</span>
    </button>
  );
}

function snoozePerm(item: ActNowItem): Permission {
  switch (item.snooze.kind) {
    case 'act-now': return item.snooze.permission;
    case 'posture': return 'connectors:action';
    case 'stack-ignore': return 'backup:write';
  }
}

function Detail({ item, can, onBack, onChanged }: { item: ActNowItem; can: (p: Permission) => boolean; onBack: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ignoring, setIgnoring] = useState(false);
  const [reason, setReason] = useState('');
  const canSnooze = can(snoozePerm(item));
  const v = item.snooze;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setIgnoring(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };
  const snooze = (days: number) => run(() => v.kind === 'posture'
    ? api.post(`/api/posture/findings/${encodeURIComponent(v.findingId)}/items`, { action: 'snooze', labels: v.labels, days })
    : api.post('/api/act-now/snooze', { key: item.key, days }));
  const reopen = () => run(() => v.kind === 'posture'
    ? api.post(`/api/posture/findings/${encodeURIComponent(v.findingId)}/items`, { action: 'reopen', labels: v.labels })
    : api.delete(`/api/act-now/snooze/${encodeURIComponent(item.key)}`));
  const ignore = () => v.kind === 'stack-ignore' && run(() =>
    api.put(`/api/stack-backup/coverage/${v.instanceId}/${encodeURIComponent(v.stackName)}/ignore`, { ignored: true, reason: reason.trim() || undefined }));

  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-4 lg:max-h-[calc(100vh-1.5rem)] lg:overflow-y-auto">
      <div className="flex flex-col gap-1.5">
        <Button variant="ghost" size="sm" className="self-start -ml-2 lg:hidden" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Back to list</Button>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className={cn('inline-flex items-center gap-1.5 font-semibold', TIER_TEXT[item.tier])}><span className={cn('h-2 w-2 rounded-full', TIER_DOT[item.tier])} />{ACT_NOW_TIER_LABEL[item.tier]}</span>
          <span>{ACT_NOW_SOURCE_LABEL[item.source]}</span>
          {item.overdue && <span className="rounded-full bg-red-500/15 text-red-600 dark:text-red-400 px-1.5 font-semibold">Overdue</span>}
          {item.exposed && <span className="inline-flex items-center gap-1"><Globe className="h-3 w-3" />Internet-facing</span>}
        </div>
        <h2 className="text-lg font-semibold leading-snug [text-wrap:balance]">{item.title}</h2>
        <p className="text-xs text-muted-foreground">{item.reason}</p>
        {item.staleNote && <p className="text-xs text-amber-600 dark:text-amber-400">{item.staleNote}</p>}
      </div>

      <section className="flex flex-col gap-1">
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Why it’s here</h3>
        <p className="text-sm leading-relaxed max-w-prose">{item.why}</p>
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">How to fix</h3>
        <p className="text-sm leading-relaxed max-w-prose">{item.fix}</p>
      </section>

      {!!item.kevCves.length && (
        <section className="flex flex-col gap-1">
          <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Known-exploited CVEs</h3>
          <div className="flex flex-wrap gap-1.5">
            {item.kevCves.slice(0, 20).map((c) => (
              <a key={c} href={`https://nvd.nist.gov/vuln/detail/${encodeURIComponent(c)}`} target="_blank" rel="noreferrer"
                className="rounded border border-red-500/40 px-1.5 text-xs font-mono text-red-600 dark:text-red-400 hover:underline">{c}</a>
            ))}
            {item.kevCves.length > 20 && <span className="text-xs text-muted-foreground">+{item.kevCves.length - 20} more</span>}
          </div>
        </section>
      )}

      {!!item.evidence.length && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Details</h3>
          <div className="rounded-md border border-border divide-y divide-border">
            {item.evidence.map((e, i) => {
              const inner = (
                <>
                  <span className="text-sm font-medium break-words">{e.label}{e.kev && <span className="ml-1.5 text-[10.5px] font-semibold text-red-600 dark:text-red-400">KEV</span>}{e.exposed && <Globe className="inline ml-1.5 h-3 w-3 text-muted-foreground" aria-label="internet-facing" />}</span>
                  {e.note && <span className="block text-xs text-muted-foreground break-words whitespace-pre-line">{e.note}</span>}
                </>
              );
              return (
                <div key={`${e.label}-${i}`} className="px-3 py-2 min-w-0">
                  {e.url ? (
                    e.url.startsWith('/') ? <Link to={e.url} className="block hover:bg-muted/50 -m-1 p-1 rounded">{inner}</Link>
                      : <a href={e.url} target="_blank" rel="noreferrer" className="block hover:bg-muted/50 -m-1 p-1 rounded">{inner}</a>
                  ) : inner}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div className="flex flex-wrap gap-2">
        {item.links.map((l, i) => (
          <Link key={l.to} to={l.to} className={buttonVariants({ variant: i === 0 ? 'default' : 'outline', size: 'sm' })}>
            {l.label} {i === 0 && <ExternalLink className="h-3.5 w-3.5" />}
          </Link>
        ))}
      </div>

      {canSnooze && (
        <section className="flex flex-col gap-1.5 border-t border-border pt-3">
          {item.snoozed ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Snoozed{item.snoozed.until ? ` until ${day(item.snoozed.until)}` : ''}{item.snoozed.note ? ` · ${item.snoozed.note}` : ''}</span>
              <Button size="sm" variant="outline" disabled={busy} onClick={reopen}>Put it back on the list</Button>
            </div>
          ) : v.kind === 'stack-ignore' ? (
            ignoring ? (
              <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); ignore(); }}>
                <label htmlFor="act-now-ignore-reason" className="sr-only">Why it needs no backup</label>
                <input id="act-now-ignore-reason" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it needs no backup (optional)"
                  className="h-8 flex-1 min-w-0 rounded border border-border bg-background px-2 text-sm" />
                <Button size="sm" type="submit" disabled={busy}>Mark as no backup needed</Button>
                <Button size="sm" type="button" variant="ghost" onClick={() => setIgnoring(false)}>Cancel</Button>
              </form>
            ) : (
              <Button size="sm" variant="outline" className="self-start" disabled={busy} onClick={() => setIgnoring(true)}>This stack needs no backup…</Button>
            )
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground mr-1">Snooze</span>
              {[1, 3, 7, 30].map((d) => (
                <Button key={d} size="sm" variant="outline" className="h-8 px-3 text-xs" disabled={busy} onClick={() => snooze(d)}>{d === 1 ? '1 day' : `${d} days`}</Button>
              ))}
              <span className="text-xs text-muted-foreground basis-full">It comes back sooner if it gets worse.</span>
            </div>
          )}
          {err && <div className="text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">{err}</div>}
        </section>
      )}
    </div>
  );
}

export default ActNowPage;
