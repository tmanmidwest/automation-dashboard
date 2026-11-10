import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Crosshair, ExternalLink, MoreHorizontal, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import type { PostureAffected, PostureCategory, PostureEventView, PostureFinding, PostureSeverity, TopologyGraph } from '@cerebro/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CATEGORY_LABEL, ImageScanLine, OutsideInLine, SEV_LABEL, SevPill } from '@/components/topology/Posture';
import { ExposureSection } from '@/components/topology/Exposure';
import { CheckingView, useBuildProgress } from '@/components/topology/CheckingView';

/**
 * Posture: every security finding in one place, to narrow down and work through.
 * Summary tiles, a filter bar (all of it in the URL, so a view can be bookmarked or saved),
 * a list on the left and the selected finding on the right, with snooze / accept risk /
 * reopen per affected item and the finding's history. Findings come from GET /api/topology
 * (built in apps/server/src/topology/posture.ts); what you decided about each item and when
 * things were first seen and fixed is kept by posture-tracking. See docs/posture.md.
 */

type Status = 'open' | 'snoozed' | 'accepted' | 'fixed' | 'all';
type GroupBy = 'severity' | 'category' | 'host' | 'none';
type View = 'findings' | 'exposure' | 'unknown';
interface SavedView { name: string; query: string }

const SEVS: PostureSeverity[] = ['high', 'medium', 'low'];
const RANK: Record<PostureSeverity, number> = { high: 3, medium: 2, low: 1 };
const LAST_VISIT_KEY = 'posture-last-visit';
const VIEWS_KEY = 'posture-views';
const REFRESH_MS = 60_000;
/** Keys that make up a view; the selected finding and tab are not part of a saved view. */
const FILTER_KEYS = ['q', 'sev', 'cat', 'host', 'src', 'status', 'group', 'new'];
const BUILTIN_VIEWS: SavedView[] = [
  { name: 'High only', query: 'sev=high' },
  { name: 'Internet-facing', query: 'cat=exposure' },
  { name: 'Patching', query: 'cat=patching&group=host' },
];

const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
function age(iso?: string): string {
  if (!iso) return '';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? '1 day' : `${d} days`;
}
const isOpenItem = (a: PostureAffected) => !a.status || a.status === 'open';
const statusOf = (f: PostureFinding): Exclude<Status, 'all'> => f.status ?? (f.snoozedUntil ? 'snoozed' : 'open');

export function PosturePage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const view = (get('view') || 'findings') as View;
  const q = get('q');
  const sev = new Set(get('sev').split(',').filter(Boolean) as PostureSeverity[]);
  const cat = get('cat') as PostureCategory | '';
  const host = get('host');
  const src = get('src');
  const status = (get('status') || 'open') as Status;
  const group = (get('group') || 'severity') as GroupBy;
  const onlyNew = get('new') === '1';
  const selected = get('f');

  const set = useCallback((patch: Record<string, string | null>) => setParams((pp) => {
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') pp.delete(k);
      else pp.set(k, v);
    }
    return pp;
  }, { replace: true }), [setParams]);

  const [graph, setGraph] = useState<TopologyGraph | null>(null);
  const [fixed, setFixed] = useState<PostureFinding[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastVisit, setLastVisit] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedView[]>([]);
  const [mobileOpen, setMobileOpen] = useState(false);
  const progress = useBuildProgress((!graph && !err) || refreshing);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const [g, fx] = await Promise.all([
        api.get<TopologyGraph>(`/api/topology${manual ? '?refresh=1' : ''}`),
        api.get<PostureFinding[]>('/api/posture/fixed?days=30').catch(() => [] as PostureFinding[]),
      ]);
      setGraph(g);
      setFixed(fx);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load the findings.');
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => { load(); const t = setInterval(() => load(), REFRESH_MS); return () => clearInterval(t); }, [load]);

  // "New since your last visit" compares against the visit before this one; this visit is saved for next time.
  useEffect(() => {
    api.get<{ value: unknown }>(`/api/account/preferences/${LAST_VISIT_KEY}`)
      .then((r) => setLastVisit(typeof r.value === 'string' ? r.value : null))
      .catch(() => setLastVisit(null))
      .finally(() => { api.put(`/api/account/preferences/${LAST_VISIT_KEY}`, { value: new Date().toISOString() }).catch(() => {}); });
    api.get<{ value: unknown }>(`/api/account/preferences/${VIEWS_KEY}`)
      .then((r) => setSaved(Array.isArray(r.value) ? (r.value as SavedView[]).filter((v) => v && typeof v.name === 'string' && typeof v.query === 'string') : []))
      .catch(() => setSaved([]));
  }, []);
  const saveViews = (next: SavedView[]) => { setSaved(next); api.put(`/api/account/preferences/${VIEWS_KEY}`, { value: next }).catch(() => {}); };

  const current = useMemo(() => graph?.findings ?? [], [graph]);
  const isNew = useCallback((f: PostureFinding) => !!lastVisit && !!f.firstSeenAt && f.firstSeenAt > lastVisit, [lastVisit]);
  const all = useMemo(() => [...current, ...fixed.filter((x) => !current.some((c) => c.id === x.id))], [current, fixed]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((f) => {
        const s = statusOf(f);
        if (status !== 'all' && s !== status) return false;
        if (onlyNew && !(isNew(f) && s === 'open')) return false;
        if (sev.size && !sev.has(f.severity)) return false;
        if (cat && f.category !== cat) return false;
        if (host && !(f.hosts ?? []).includes(host)) return false;
        if (src && f.source !== src) return false;
        if (needle && ![f.title, f.source, f.why, CATEGORY_LABEL[f.category], ...(f.hosts ?? []), ...f.affected.flatMap((a) => [a.label, a.note ?? ''])]
          .join(' ').toLowerCase().includes(needle)) return false;
        return true;
      })
      .sort((a, b) => RANK[b.severity] - RANK[a.severity] || Number(isNew(b)) - Number(isNew(a)) || a.title.localeCompare(b.title));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, q, get('sev'), cat, host, src, status, onlyNew, isNew]);

  const sel = all.find((f) => f.id === selected) ?? (window.innerWidth >= 1024 ? shown[0] : undefined);

  const open = current.filter((f) => statusOf(f) === 'open');
  const counts = {
    high: open.filter((f) => f.severity === 'high').length,
    medium: open.filter((f) => f.severity === 'medium').length,
    low: open.filter((f) => f.severity === 'low').length,
    new: open.filter(isNew).length,
    fixedWeek: fixed.filter((f) => f.resolvedAt && Date.now() - new Date(f.resolvedAt).getTime() < 7 * 86_400_000).length,
    setAside: current.reduce((n, f) => n + f.affected.filter((a) => !isOpenItem(a)).length, 0),
  };
  const hosts = useMemo(() => [...new Set(all.flatMap((f) => f.hosts ?? []))].sort((a, b) => a.localeCompare(b)), [all]);
  const sources = useMemo(() => [...new Set(all.map((f) => f.source))].sort((a, b) => a.localeCompare(b)), [all]);
  const unknownFinding = current.find((f) => f.id === 'unknown-addresses');
  const filtered = FILTER_KEYS.some((k) => k !== 'group' && k !== 'status' && params.get(k)) || status !== 'open';
  const viewQuery = FILTER_KEYS.filter((k) => params.get(k)).map((k) => `${k}=${encodeURIComponent(params.get(k)!)}`).join('&');

  const applyView = (query: string) => setParams(() => {
    const next = new URLSearchParams(query);
    next.delete('f');
    return next;
  }, { replace: true });
  const clearFilters = () => applyView('');
  const pick = (id: string) => { set({ f: id }); setMobileOpen(true); };
  const showOnMap = (nodeId: string) => navigate(`/map?node=${encodeURIComponent(nodeId)}`);

  const tile = (key: string, n: number, label: string, tone: string, active: boolean, onClick: () => void) => (
    <button key={key} onClick={onClick} aria-pressed={active}
      className={cn('rounded-lg border bg-card px-3.5 py-2.5 flex flex-col items-start gap-0.5 text-left transition-colors hover:border-primary/70 min-w-0',
        active ? 'border-primary ring-1 ring-primary' : 'border-border')}>
      <span className={cn('text-[26px] font-bold tabular-nums leading-none', n ? tone : 'text-muted-foreground')}>{n}</span>
      <span className="text-xs text-muted-foreground truncate max-w-full">{label}</span>
    </button>
  );
  const onlySev = sev.size === 1 && status === 'open' && !onlyNew ? [...sev][0] : null;

  return (
    <>
      <PageHeader
        title="Posture"
        description="Security findings from your connectors, worst first. Narrow them down, then fix, snooze or accept each item."
        actions={
          <div className="flex items-center gap-2">
            {graph && <span className="text-xs text-muted-foreground hidden sm:inline">Checked {new Date(graph.generatedAt).toLocaleTimeString()}</span>}
            <Button variant="outline" onClick={() => load(true)} disabled={refreshing}>
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} /> Check now
            </Button>
          </div>
        }
      />
      {err && <div className="mb-3 text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">{err}</div>}
      {!graph && !err && <CheckingView progress={progress} />}

      {graph && (
        <div className="flex flex-col gap-4">
          {refreshing && <CheckingView progress={progress} title="Checking again" compact />}
          <div className="grid gap-2.5 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
            {tile('high', counts.high, 'High · needs action', 'text-red-500', onlySev === 'high', () => applyView('sev=high'))}
            {tile('medium', counts.medium, 'Medium', 'text-amber-500', onlySev === 'medium', () => applyView('sev=medium'))}
            {tile('low', counts.low, 'Low', 'text-slate-400', onlySev === 'low', () => applyView('sev=low'))}
            {tile('new', counts.new, lastVisit ? `New since ${day(lastVisit)}` : 'New since your last visit', 'text-accent', onlyNew, () => applyView('new=1'))}
            {tile('fixed', counts.fixedWeek, 'Fixed this week', 'text-emerald-500', status === 'fixed', () => applyView('status=fixed'))}
            {tile('aside', counts.setAside, 'Snoozed or accepted', 'text-violet-400', status === 'all', () => applyView('status=all'))}
          </div>

          <div className="flex gap-1 border-b border-border overflow-x-auto" role="tablist">
            {([
              ['findings', 'Findings', open.length],
              ['exposure', 'Exposed to the internet', graph.exposure?.length ?? 0],
              ['unknown', 'Unknown addresses', unknownFinding?.affected.length ?? 0],
            ] as [View, string, number][]).map(([k, label, n]) => (
              <button key={k} role="tab" aria-selected={view === k} onClick={() => set({ view: k === 'findings' ? null : k })}
                className={cn('px-3.5 py-2 text-sm whitespace-nowrap border-b-2 -mb-px', view === k ? 'border-primary text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')}>
                {label} <span className="ml-1 rounded-full bg-muted px-1.5 text-[11px] tabular-nums">{n}</span>
              </button>
            ))}
          </div>

          {view === 'exposure' && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">Every way in from the internet and what it reaches, with the problems found on each hop.</p>
              <ExposureSection entries={graph.exposure ?? []} onShow={showOnMap} onChanged={() => load()} />
            </div>
          )}

          {view === 'unknown' && <UnknownAddresses finding={unknownFinding} onShow={showOnMap} />}

          {view === 'findings' && (
            <>
              <div className="flex flex-col gap-1.5">
                <OutsideInLine info={graph.outsideIn} resolver={graph.publicDnsResolver} onChanged={() => load()} />
                <ImageScanLine info={graph.imageScan} onChanged={() => load()} />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-[1_1_240px] min-w-0">
                  <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input id="posture-q" className="pl-8" placeholder="Search findings, hosts, IPs, hostnames…" value={q} onChange={(e) => set({ q: e.target.value, f: null })} aria-label="Search findings" />
                  {q && <button onClick={() => set({ q: null })} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>}
                </div>
                <div className="flex gap-1">
                  {SEVS.map((s) => (
                    <button key={s} aria-pressed={sev.has(s)} onClick={() => { const n = new Set(sev); if (n.has(s)) n.delete(s); else n.add(s); set({ sev: [...n].join(','), new: null }); }}
                      className={cn('rounded-full border px-3 py-1.5 text-sm', sev.has(s) ? 'border-primary bg-primary/10' : 'border-border text-muted-foreground hover:text-foreground')}>
                      {SEV_LABEL[s]}
                    </button>
                  ))}
                </div>
                <Select id="posture-cat" label="Category" value={cat} onChange={(v) => set({ cat: v })} options={Object.entries(CATEGORY_LABEL).map(([k, l]) => [k, l])} />
                <Select id="posture-host" label="Host" value={host} onChange={(v) => set({ host: v })} options={hosts.map((h) => [h, h])} />
                <Select id="posture-src" label="Source" value={src} onChange={(v) => set({ src: v })} options={sources.map((h) => [h, h])} />
                <Select id="posture-status" label="Status" value={status === 'open' ? '' : status} allLabel="Needs action" onChange={(v) => set({ status: v, new: null })}
                  options={[['snoozed', 'Snoozed'], ['accepted', 'Accepted risk'], ['fixed', 'Fixed (last 30 days)'], ['all', 'Everything']]} />
                <Select id="posture-group" label="Group" value={group === 'severity' ? '' : group} allLabel="Severity" onChange={(v) => set({ group: v })}
                  options={[['category', 'Category'], ['host', 'Host'], ['none', 'None']]} />
              </div>

              <SavedViews builtin={BUILTIN_VIEWS} saved={saved} current={viewQuery} onApply={applyView} onSave={saveViews} filtered={filtered} onClear={clearFilters} />

              <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] items-start">
                <FindingList shown={shown} group={group} selectedId={sel?.id} isNew={isNew} onPick={pick} onClear={filtered ? clearFilters : undefined} />
                {sel && (
                  <div className={cn('lg:sticky lg:top-3 lg:block', mobileOpen ? 'fixed inset-0 z-40 overflow-y-auto bg-background p-4 lg:static lg:p-0 lg:bg-transparent' : 'hidden')}>
                    <Detail key={sel.id} f={sel} isNew={isNew(sel)} lastVisit={lastVisit} canAct={can('connectors:action')} onShow={showOnMap}
                      onBack={() => setMobileOpen(false)} onChanged={() => load()} />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

function Select({ id, label, value, options, onChange, allLabel = 'All' }: { id: string; label: string; value: string; options: [string, string][]; onChange: (v: string) => void; allLabel?: string }) {
  return (
    <select id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}
      className={cn('h-9 max-w-[14rem] rounded-md border bg-card px-2 text-sm', value ? 'border-primary' : 'border-border')}>
      <option value="">{label}: {allLabel}</option>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

function SavedViews({ builtin, saved, current, onApply, onSave, filtered, onClear }: {
  builtin: SavedView[]; saved: SavedView[]; current: string; onApply: (q: string) => void; onSave: (v: SavedView[]) => void; filtered: boolean; onClear: () => void;
}) {
  const [naming, setNaming] = useState<string | null>(null);
  const chip = (v: SavedView, mine: boolean) => (
    <span key={`${mine}-${v.name}`} className={cn('inline-flex items-center rounded-md border text-xs', v.query === current ? 'border-primary bg-primary/10' : 'border-border')}>
      <button className="px-2 py-1" onClick={() => onApply(v.query)}>{v.name}</button>
      {mine && <button className="pr-1.5 text-muted-foreground hover:text-foreground" aria-label={`Remove view ${v.name}`} onClick={() => onSave(saved.filter((s) => s !== v))}><X className="h-3 w-3" /></button>}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span>Views:</span>
      {builtin.map((v) => chip(v, false))}
      {saved.map((v) => chip(v, true))}
      {naming == null ? (
        current && !saved.some((s) => s.query === current) && !builtin.some((s) => s.query === current) && (
          <button className="rounded-md border border-dashed border-border px-2 py-1 hover:text-foreground" onClick={() => setNaming('')}>+ Save this view</button>
        )
      ) : (
        <form className="inline-flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); if (naming.trim()) onSave([...saved, { name: naming.trim().slice(0, 40), query: current }]); setNaming(null); }}>
          <label htmlFor="posture-view-name" className="sr-only">View name</label>
          <input id="posture-view-name" autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} placeholder="Name this view"
            className="h-7 w-40 rounded border border-border bg-background px-2 text-xs text-foreground" />
          <Button size="sm" type="submit" className="h-7 px-3 text-xs">Save</Button>
          <Button size="sm" type="button" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setNaming(null)}>Cancel</Button>
        </form>
      )}
      {filtered && <button className="text-accent hover:underline ml-1" onClick={onClear}>Clear filters</button>}
    </div>
  );
}

const STRIPE: Record<PostureSeverity, string> = { high: 'bg-red-500', medium: 'bg-amber-400', low: 'bg-slate-400' };

function FindingList({ shown, group, selectedId, isNew, onPick, onClear }: {
  shown: PostureFinding[]; group: GroupBy; selectedId?: string; isNew: (f: PostureFinding) => boolean; onPick: (id: string) => void; onClear?: () => void;
}) {
  if (!shown.length) {
    return (
      <div className="rounded-lg border border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-emerald-500" />
        {onClear ? <>Nothing matches these filters. <button className="text-accent hover:underline" onClick={onClear}>Clear filters</button></> : 'Nothing to fix right now.'}
      </div>
    );
  }
  const groups = new Map<string, PostureFinding[]>();
  const add = (k: string, f: PostureFinding) => { if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(f); };
  for (const f of shown) {
    if (group === 'severity') add(SEV_LABEL[f.severity], f);
    else if (group === 'category') add(CATEGORY_LABEL[f.category], f);
    else if (group === 'host') for (const h of f.hosts?.length ? f.hosts : ['No single machine']) add(h, f);
    else add('', f);
  }
  const ordered = group === 'severity' || group === 'none' ? [...groups] : [...groups].sort((a, b) => (a[0] === 'No single machine' ? 1 : b[0] === 'No single machine' ? -1 : a[0].localeCompare(b[0])));
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {ordered.map(([k, fs], gi) => (
        <div key={k || 'all'}>
          {k && (
            <div className={cn('flex justify-between px-3.5 py-1.5 bg-muted/50 text-[11px] uppercase tracking-wider text-muted-foreground', gi > 0 && 'border-t border-border')}>
              <span>{k}</span><span className="tabular-nums">{fs.length}</span>
            </div>
          )}
          {fs.map((f) => <Row key={`${k}-${f.id}`} f={f} on={f.id === selectedId} fresh={isNew(f)} onPick={onPick} />)}
        </div>
      ))}
    </div>
  );
}

function Row({ f, on, fresh, onPick }: { f: PostureFinding; on: boolean; fresh: boolean; onPick: (id: string) => void }) {
  const s = statusOf(f);
  const openN = f.affected.filter(isOpenItem).length;
  const total = f.affected.length;
  return (
    <button onClick={() => onPick(f.id)} aria-current={on || undefined}
      className={cn('w-full grid grid-cols-[4px_minmax(0,1fr)_auto] gap-x-3 border-t border-border first:border-t-0 pr-3.5 py-2.5 text-left items-center hover:bg-muted/60', on && 'bg-primary/10 hover:bg-primary/10')}>
      <span className={cn('self-stretch rounded-r', STRIPE[f.severity])} />
      <span className="min-w-0">
        <span className="block text-sm font-medium leading-snug">{f.title}</span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <SevPill severity={f.severity} />
          <span>{CATEGORY_LABEL[f.category]}{f.hosts?.length ? ` · ${f.hosts.length > 2 ? `${f.hosts.slice(0, 2).join(', ')} +${f.hosts.length - 2}` : f.hosts.join(', ')}` : ''}</span>
          {fresh && s === 'open' && <Tag tone="new">New</Tag>}
          {s === 'snoozed' && <Tag>Snoozed</Tag>}
          {s === 'accepted' && <Tag tone="acc">Accepted</Tag>}
          {s === 'fixed' && <Tag tone="fix">Fixed</Tag>}
          {s === 'open' && openN < total && <Tag>{total - openN} set aside</Tag>}
        </span>
      </span>
      <span className="flex flex-col items-end gap-1 text-[11.5px] text-muted-foreground whitespace-nowrap tabular-nums">
        <span>{s === 'open' ? `${openN} of ${total} open` : `${total} item${total === 1 ? '' : 's'}`}</span>
        <span>{s === 'fixed' ? `fixed ${day(f.resolvedAt)}` : f.firstSeenAt ? `${age(f.firstSeenAt)} old` : ''}</span>
      </span>
    </button>
  );
}

function Tag({ tone, children }: { tone?: 'new' | 'acc' | 'fix'; children: React.ReactNode }) {
  return (
    <span className={cn('rounded border px-1.5 text-[10.5px] leading-[1.15rem]',
      tone === 'new' ? 'border-accent text-accent font-semibold' : tone === 'acc' ? 'border-violet-400 text-violet-500 dark:text-violet-300' : tone === 'fix' ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400' : 'border-border text-muted-foreground')}>
      {children}
    </span>
  );
}

function Detail({ f, isNew, lastVisit, canAct, onShow, onBack, onChanged }: {
  f: PostureFinding; isNew: boolean; lastVisit: string | null; canAct: boolean; onShow: (nodeId: string) => void; onBack: () => void; onChanged: () => void;
}) {
  const [history, setHistory] = useState<PostureEventView[] | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const s = statusOf(f);
  const fixed = s === 'fixed';
  const openItems = f.affected.filter(isOpenItem);

  const loadHistory = useCallback(() => {
    api.get<PostureEventView[]>(`/api/posture/findings/${encodeURIComponent(f.id)}/history`).then(setHistory).catch(() => setHistory([]));
  }, [f.id]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const act = async (action: 'snooze' | 'accept' | 'reopen', labels: string[], extra: { days?: number; note?: string } = {}) => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/api/posture/findings/${encodeURIComponent(f.id)}/items`, { action, labels, ...extra });
      setMenu(null);
      setAccepting(null);
      onChanged();
      loadHistory();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-4 lg:max-h-[calc(100vh-1.5rem)] lg:overflow-y-auto">
      <div className="flex flex-col gap-1.5">
        <Button variant="ghost" size="sm" className="self-start -ml-2 lg:hidden" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Back to list</Button>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <SevPill severity={f.severity} /> <span>{CATEGORY_LABEL[f.category]}</span>
          {isNew && s === 'open' && <Tag tone="new">New since your last visit</Tag>}
          {fixed && <Tag tone="fix">Fixed {day(f.resolvedAt)}</Tag>}
        </div>
        <h2 className="text-lg font-semibold leading-snug [text-wrap:balance]">{f.title}</h2>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
          {!!f.hosts?.length && <span>Host <b className="font-medium text-foreground">{f.hosts.join(', ')}</b></span>}
          <span>Source <b className="font-medium text-foreground">{f.source}</b></span>
          {f.firstSeenAt && <span>First seen <b className="font-medium text-foreground">{day(f.firstSeenAt)}</b> ({age(f.firstSeenAt)} ago)</span>}
        </div>
      </div>

      <section className="flex flex-col gap-1">
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Why it matters</h3>
        <p className="text-sm leading-relaxed max-w-prose">{f.why}</p>
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">How to fix</h3>
        <p className="text-sm leading-relaxed max-w-prose">{f.fix}</p>
      </section>

      <section className="flex flex-col gap-1.5">
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
          {fixed ? `Affected (${f.affected.length})` : `Affected (${openItems.length} open of ${f.affected.length})`}
        </h3>
        <div className="rounded-md border border-border divide-y divide-border">
          {f.affected.map((a) => (
            <ItemRow key={a.label} a={a} fixed={fixed} canAct={canAct} busy={busy} fresh={!!lastVisit && !!a.firstSeenAt && a.firstSeenAt > lastVisit && !!f.firstSeenAt && a.firstSeenAt > f.firstSeenAt}
              menuOpen={menu === a.label} onMenu={() => { setMenu(menu === a.label ? null : a.label); setAccepting(null); }}
              accepting={accepting?.length === 1 && accepting[0] === a.label}
              onShow={onShow}
              onSnooze={(days) => act('snooze', [a.label], { days })}
              onAccept={() => { setAccepting([a.label]); setMenu(null); }}
              onReopen={() => act('reopen', [a.label])}
              acceptForm={<AcceptForm busy={busy} count={1} onCancel={() => setAccepting(null)} onSave={(note, days) => act('accept', [a.label], { note, days })} />} />
          ))}
        </div>
        {canAct && !fixed && openItems.length > 1 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Button size="sm" variant="outline" className="h-8 px-3 text-xs" disabled={busy} onClick={() => act('snooze', [], { days: 7 })}>Snooze all open 7 days</Button>
            <Button size="sm" variant="outline" className="h-8 px-3 text-xs" disabled={busy} onClick={() => setAccepting(openItems.map((a) => a.label))}>Accept all open…</Button>
          </div>
        )}
        {accepting && accepting.length > 1 && (
          <AcceptForm busy={busy} count={accepting.length} onCancel={() => setAccepting(null)} onSave={(note, days) => act('accept', [], { note, days })} />
        )}
        {err && <div className="text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">{err}</div>}
      </section>

      <section className="flex flex-col gap-1.5">
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">History</h3>
        {history == null ? <span className="text-xs text-muted-foreground">Loading…</span> : !history.length ? (
          <span className="text-xs text-muted-foreground">Nothing recorded yet.</span>
        ) : (
          <ol className="border-l-2 border-border ml-1">
            {history.map((h, i) => (
              <li key={i} className="relative pl-3.5 pb-2 text-xs text-muted-foreground">
                <span className="absolute -left-[6px] top-1 h-2.5 w-2.5 rounded-full border-2 border-border bg-card" />
                <span className="font-mono text-[11px] mr-1.5 tabular-nums">{new Date(h.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                <span className="text-foreground">{h.text}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function ItemRow({ a, fixed, canAct, busy, fresh, menuOpen, onMenu, accepting, onShow, onSnooze, onAccept, onReopen, acceptForm }: {
  a: PostureAffected; fixed: boolean; canAct: boolean; busy: boolean; fresh: boolean; menuOpen: boolean; onMenu: () => void; accepting: boolean;
  onShow: (nodeId: string) => void; onSnooze: (days: number) => void; onAccept: () => void; onReopen: () => void; acceptForm: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onMenu(); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen, onMenu]);
  const open = isOpenItem(a);
  const item = 'w-full text-left px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50';
  return (
    <div className={cn('px-3 py-1.5', !open && !fixed && 'opacity-70')}>
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex items-baseline gap-2.5 min-w-0 flex-1 whitespace-nowrap" title={[a.label, a.note].filter(Boolean).join(' · ')}>
          {a.url && !a.nodeId
            ? <a className="text-sm font-medium text-accent hover:underline truncate shrink-0 max-w-[60%] inline-flex items-center gap-1" href={a.url} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3 w-3 shrink-0" />{a.label}</a>
            : a.nodeId
              ? <button className="text-sm font-medium text-accent hover:underline truncate shrink-0 max-w-[60%] text-left" onClick={() => onShow(a.nodeId!)}>{a.label}</button>
              : <span className="text-sm font-medium truncate shrink-0 max-w-[60%]">{a.label}</span>}
          {a.note && <span className="font-mono text-[11.5px] text-muted-foreground truncate min-w-0">{a.note}</span>}
        </div>
        {fresh && open && <Tag tone="new">New</Tag>}
        {a.status === 'snoozed' && <Tag>Snoozed to {day(a.until)}</Tag>}
        {a.status === 'accepted' && <Tag tone="acc">Accepted{a.until ? ` to ${day(a.until)}` : ''}</Tag>}
        {canAct && !fixed && (
          <div className="relative" ref={ref}>
            <button onClick={onMenu} aria-label={`Actions for ${a.label}`} aria-expanded={menuOpen} disabled={busy}
              className={cn('rounded-md border px-1.5 py-0.5 text-muted-foreground hover:text-foreground', menuOpen ? 'border-border text-foreground' : 'border-transparent hover:border-border')}>
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 z-30 w-48 rounded-md border border-border bg-card shadow-xl py-1">
                {open ? (
                  <>
                    <button className={item} disabled={busy} onClick={() => onSnooze(7)}>Snooze 7 days</button>
                    <button className={item} disabled={busy} onClick={() => onSnooze(30)}>Snooze 30 days</button>
                    <button className={item} disabled={busy} onClick={onAccept}>Accept risk…</button>
                  </>
                ) : (
                  <button className={item} disabled={busy} onClick={onReopen}>Reopen</button>
                )}
                {a.nodeId && <button className={cn(item, 'inline-flex items-center gap-1.5')} onClick={() => onShow(a.nodeId!)}><Crosshair className="h-3.5 w-3.5" /> Show on map</button>}
              </div>
            )}
          </div>
        )}
      </div>
      {a.status === 'accepted' && a.reason && <div className="mt-0.5 text-xs text-violet-600 dark:text-violet-300">Accepted{a.setBy ? ` by ${a.setBy}` : ''}: {a.reason}</div>}
      {accepting && <div className="mt-1.5">{acceptForm}</div>}
    </div>
  );
}

function AcceptForm({ busy, count, onCancel, onSave }: { busy: boolean; count: number; onCancel: () => void; onSave: (note: string, days?: number) => void }) {
  const [note, setNote] = useState('');
  const [for90, setFor90] = useState(false);
  return (
    <form className="rounded-md bg-muted/60 p-2.5 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); onSave(note, for90 ? 90 : undefined); }}>
      <label htmlFor="posture-accept-note" className="text-xs">Why is this OK{count > 1 ? ` for all ${count} items` : ''}? Shown on the item and in its history.</label>
      <textarea id="posture-accept-note" autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2}
        className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" placeholder="e.g. Plex remote access needs the direct forward." />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <label className="inline-flex items-center gap-1.5"><input type="radio" name="posture-accept-until" checked={!for90} onChange={() => setFor90(false)} /> Until it gets worse or goes away and comes back</label>
        <label className="inline-flex items-center gap-1.5"><input type="radio" name="posture-accept-until" checked={for90} onChange={() => setFor90(true)} /> For 90 days</label>
      </div>
      <div className="flex gap-1.5">
        <Button size="sm" type="submit" className="h-8 px-3 text-xs" disabled={busy}>Accept risk</Button>
        <Button size="sm" type="button" variant="ghost" className="h-8 px-3 text-xs" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function UnknownAddresses({ finding, onShow }: { finding?: PostureFinding; onShow: (nodeId: string) => void }) {
  if (!finding) return <div className="text-sm text-muted-foreground flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-500" /> Every address in your rules and DNS records belongs to something a connector knows.</div>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground max-w-prose">{finding.fix}</p>
      <div className="rounded-lg border border-border bg-card overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="bg-muted/50 text-[11px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-semibold px-3.5 py-2">Address</th>
              <th className="text-left font-semibold px-3.5 py-2">Still named by</th>
              <th className="px-3.5 py-2" />
            </tr>
          </thead>
          <tbody>
            {finding.affected.map((a) => (
              <tr key={a.label} className="border-t border-border align-top">
                <td className="px-3.5 py-2 font-mono text-[12.5px] whitespace-nowrap">{a.label}</td>
                <td className="px-3.5 py-2 text-muted-foreground">{a.note || '—'}</td>
                <td className="px-3.5 py-2 text-right">{a.nodeId && <button className="text-accent hover:underline text-xs inline-flex items-center gap-1" onClick={() => onShow(a.nodeId!)}><Crosshair className="h-3 w-3" /> Show on map</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default PosturePage;
