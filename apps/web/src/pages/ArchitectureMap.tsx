import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, ChevronRight, Crosshair, HelpCircle, Info, RefreshCw, Search, Share2, X,
} from 'lucide-react';
import type { TopologyGraph } from '@cerebro/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { iconFor, STATUS_DOT, TYPE_ICON, TYPE_LABEL } from '@/components/topology/meta';
import { matches, TopoModel, type Chip, type Item, type Lane, type Tone } from '@/components/topology/model';
import { NodeDetails } from '@/components/topology/NodeDetails';
import { FocusMap } from '@/components/topology/FocusMap';
import { BlockButton, BlockedDevicesRow, DeviceType, NewDevicesRow, type BlockedDevice, type DeviceList } from '@/components/topology/NewDevices';
import { ExposureSection } from '@/components/topology/Exposure';
import { FindingsSection, postureSummary, SEV_TINT, SevPill } from '@/components/topology/Posture';

/**
 * Architecture Map: a scrolling overview of tiles (Edge, Networks, Compute, Apps), where a
 * tile opens a full-width row right under itself, drilling deeper in place. "Show as map"
 * draws one thing and its connections. See docs/architecture-map.md.
 */

const REFRESH_MS = 2 * 60_000;
const TILE_MIN = 230;
const GRID_GAP = 10;
const SEP = '|';

const TONE: Record<Tone, string> = {
  plain: 'bg-muted text-foreground/80',
  down: 'bg-red-500/15 text-red-500 dark:text-red-400',
  warn: 'bg-amber-400/15 text-amber-600 dark:text-amber-300',
  exposed: 'bg-accent/15 text-accent',
  unknown: 'border border-dashed border-muted-foreground/50 text-muted-foreground',
  allow: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
};

function ItemIcon({ item, className }: { item: Item; className?: string }) {
  let Icon: React.ComponentType<{ className?: string }>;
  if (item.node) Icon = iconFor(item.node);
  else if (item.id.startsWith('grp:attn')) Icon = AlertTriangle;
  else if (item.id.startsWith('grp:unknown')) Icon = HelpCircle;
  else if (item.id.startsWith('grp:apps')) Icon = Share2;
  else Icon = TYPE_ICON.network;
  return <Icon className={className} />;
}

function Chips({ chips, className }: { chips: Chip[]; className?: string }) {
  if (!chips.length) return null;
  return (
    <span className={cn('flex flex-wrap gap-1.5', className)}>
      {chips.map((c, i) => <span key={i} className={cn('rounded px-1.5 py-1 text-[12px] leading-none whitespace-nowrap', TONE[c.tone])}>{c.text}</span>)}
    </span>
  );
}

/** How many equal columns of at least TILE_MIN fit, so the open row can go after the right one. */
function useColumns<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [cols, setCols] = useState(4);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setCols(Math.max(1, Math.floor((el.clientWidth + GRID_GAP) / (TILE_MIN + GRID_GAP))));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, cols];
}

export function ArchitectureMap() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const focus = params.get('focus');
  const path = useMemo(() => (params.get('open') ? params.get('open')!.split(SEP) : []), [params]);
  const setPath = useCallback((p: string[]) => setParams((pp) => {
    if (p.length) pp.set('open', p.join(SEP)); else pp.delete('open');
    pp.delete('focus');
    return pp;
  }, { replace: true }), [setParams]);
  const setFocus = useCallback((id: string | null) => setParams((pp) => { if (id) pp.set('focus', id); else pp.delete('focus'); return pp; }), [setParams]);

  const [graph, setGraph] = useState<TopologyGraph | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showClients, setShowClients] = useState(false);
  const [postureView, setPostureView] = useState(() => { try { return localStorage.getItem('map.postureView') === '1'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem('map.postureView', postureView ? '1' : '0'); } catch { /* private mode */ } }, [postureView]);
  const [q, setQ] = useState('');
  const [newDevices, setNewDevices] = useState<DeviceList | null>(null);
  const [blocked, setBlocked] = useState<BlockedDevice[] | null>(null);
  const unifiFeeds = useRef<{ id: string; name: string }[]>([]);
  const loadBlocked = useCallback(async (fresh = false) => {
    const feeds = unifiFeeds.current;
    if (!feeds.length) { setBlocked(null); return; }
    const lists = await Promise.all(feeds.map(async (f) => {
      try {
        const r = await api.get<{ resources: { id: string; name: string; details?: Record<string, unknown> }[] }>(
          `/api/connectors/instances/${encodeURIComponent(f.id)}/resources?kind=blocked_client${fresh ? '&refresh=1' : ''}`);
        const str = (v: unknown) => (v == null || v === '' ? null : String(v));
        return r.resources.map((x): BlockedDevice => ({
          instanceId: f.id, instanceName: f.name, mac: x.id, name: x.name,
          vendor: str(x.details?.vendor), lastSeen: str(x.details?.lastSeen), note: str(x.details?.note),
        }));
      } catch {
        return null;
      }
    }));
    setBlocked(lists.every((l) => l === null) ? null : lists.flatMap((l) => l ?? []));
  }, []);
  const loadDevices = useCallback((fresh = false) => {
    api.get<DeviceList>('/api/devices?status=new').then(setNewDevices).catch(() => setNewDevices(null));
    void loadBlocked(fresh);
  }, [loadBlocked]);
  const afterBlock = useCallback(() => loadDevices(true), [loadDevices]);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const g = await api.get<TopologyGraph>(`/api/topology${manual ? '?refresh=1' : ''}`);
      unifiFeeds.current = g.feeds.filter((f) => f.connectorId === 'unifi' && f.instanceId).map((f) => ({ id: f.instanceId!, name: f.name }));
      setGraph(g);
      setErr(null);
      loadDevices();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load the map.');
    } finally {
      setRefreshing(false);
    }
  }, [loadDevices]);
  useEffect(() => { load(); const t = setInterval(() => load(), REFRESH_MS); return () => clearInterval(t); }, [load]);

  const model = useMemo(() => (graph ? new TopoModel(graph, showClients) : null), [graph, showClients]);
  const hits = useMemo(() => (graph && q.trim() ? graph.nodes.filter((n) => matches(n, q)).slice(0, 12) : []), [graph, q]);

  const scrollTo = (id: string) => requestAnimationFrame(() => document.getElementById(`tile-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  const openPath = (p: string[]) => { setPath(p); if (p[0]) scrollTo(p[0]); };
  const goTo = (id: string) => {
    if (!model) return;
    const n = model.byId.get(id);
    if (n && !n.infra && !showClients) setShowClients(true);
    openPath(model.pathTo(id));
    setQ('');
  };

  // ?node=<id> (from the Posture page's "Show on map"): open the rows down to that item.
  const nodeParam = params.get('node');
  useEffect(() => {
    if (!model || !nodeParam) return;
    setParams((pp) => { pp.delete('node'); return pp; }, { replace: true });
    goTo(nodeParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, nodeParam]);

  const badFeeds = graph?.feeds.filter((f) => !f.ok) ?? [];

  return (
    <>
      <PageHeader
        title="Architecture Map"
        description="Everything Cerebro can see. Open a tile to see what's inside and what reaches it."
        actions={
          <div className="flex items-center gap-2">
            {graph && <span className="text-xs text-muted-foreground hidden sm:inline">Built {new Date(graph.generatedAt).toLocaleTimeString()}</span>}
            <Button variant="outline" onClick={() => load(true)} disabled={refreshing}>
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} /> Refresh
            </Button>
          </div>
        }
      />

      {err && <div className="mb-3 text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">{err}</div>}
      {badFeeds.length > 0 && (
        <div className="mb-3 text-xs rounded-md px-3 py-2 border border-amber-400/40 bg-amber-400/10 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
          <span>Partial data from {badFeeds.map((f) => f.name).join(', ')}. {badFeeds[0].message}</span>
        </div>
      )}
      {!graph && !err && <div className="py-16 text-center text-sm text-muted-foreground">Building the map from your connectors…</div>}

      {model && focus && (
        <FocusMap model={model} focusId={focus} onBack={() => setFocus(null)} onFocus={(id) => setFocus(id)} onOpen={(id) => goTo(id)} />
      )}

      {model && !focus && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div className="relative flex-1 min-w-[220px] max-w-md">
              <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-8" placeholder="Find a host, IP, MAC, container, hostname…" value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) goTo(hits[0].id); if (e.key === 'Escape') setQ(''); }} />
              {q && <button onClick={() => setQ('')} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>}
              {hits.length > 0 && (
                <div className="absolute z-30 mt-1 w-full rounded-md border border-border bg-card shadow-xl max-h-80 overflow-y-auto">
                  {hits.map((n) => {
                    const Icon = iconFor(n);
                    return (
                      <button key={n.id} onClick={() => goTo(n.id)} className="w-full text-left px-3 py-2 hover:bg-muted flex items-center gap-2">
                        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className={cn('h-2 w-2 rounded-full shrink-0', STATUS_DOT[n.status])} />
                        <span className="text-sm truncate">{n.label}</span>
                        <span className="text-xs text-muted-foreground truncate ml-auto">{TYPE_LABEL[n.type]}{n.ips[0] ? ` · ${n.ips[0]}` : ''}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <button onClick={() => setShowClients((x) => !x)} aria-pressed={showClients}
              className={cn('rounded-md border px-3 py-2 text-sm', showClients ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
              <span className={cn('inline-block h-2 w-2 rounded-full mr-1.5', showClients ? 'bg-primary' : 'bg-muted-foreground/40')} />
              Phones &amp; IoT clients
            </button>
            <button onClick={() => setPostureView((x) => !x)} aria-pressed={postureView} title="Tint every tile by its worst security finding"
              className={cn('rounded-md border px-3 py-2 text-sm', postureView ? 'border-red-500/70 bg-red-500/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
              <span className={cn('inline-block h-2 w-2 rounded-full mr-1.5', postureView ? 'bg-red-500' : 'bg-muted-foreground/40')} />
              Posture view
            </button>
          </div>

          <div className="flex flex-wrap gap-5 items-start">
            <Tree model={model} path={path} onPick={(id) => openPath([id])} />
            <main className="flex-[999_1_640px] min-w-0 flex flex-col gap-7">
              <section aria-label="Needs attention" className="flex flex-col gap-2.5">
                <div className="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(210px,1fr))]">
                  {[
                    ...(graph?.findings ? [(() => {
                      const open = graph.findings.filter((f) => !f.snoozedUntil);
                      const tone: Tone = open.some((f) => f.severity === 'high') ? 'down' : open.some((f) => f.severity === 'medium') ? 'warn' : 'plain';
                      return { id: 'grp:attn:posture', count: open.length, title: 'Posture findings', sub: postureSummary(graph.findings), tone, always: graph.findings.length > 0 };
                    })()] : []),
                    ...(newDevices ? [{ id: 'grp:attn:new', count: newDevices.devices.length, title: 'New devices', sub: newDevices.devices.length ? 'Not seen before. Review them' : 'Nothing new on the network', tone: 'warn' as Tone }] : []),
                    ...model.attention(),
                    ...(blocked ? [{ id: 'grp:attn:blocked', count: blocked.length, title: 'Blocked devices', sub: blocked.length ? 'Blocked on the UniFi gateway' : 'Nothing blocked', tone: 'plain' as Tone }] : []),
                  ].map((a) => (
                    <button key={a.id} id={`tile-${a.id}`} onClick={() => (a.id === 'grp:attn:posture' ? navigate('/posture') : setPath(path[0] === a.id ? [] : [a.id]))} disabled={!a.count && !('always' in a && a.always)}
                      className={cn('rounded-lg border bg-card px-4 py-3 flex items-center gap-3 text-left transition-colors enabled:hover:border-primary/70 disabled:opacity-60',
                        path[0] === a.id ? 'border-primary ring-1 ring-primary' : a.count && a.tone === 'down' ? 'border-red-500/50' : a.count && a.tone === 'warn' ? 'border-amber-400/50' : 'border-border')}>
                      <span className={cn('text-[26px] font-bold tabular-nums leading-none',
                        !a.count ? 'text-muted-foreground' : a.tone === 'down' ? 'text-red-500' : a.tone === 'warn' ? 'text-amber-500' : a.tone === 'exposed' ? 'text-accent' : 'text-foreground')}>{a.count}</span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold">{a.title}</span>
                        <span className="block text-xs text-muted-foreground truncate">{a.sub}</span>
                      </span>
                    </button>
                  ))}
                </div>
                {path[0] === 'grp:attn:new' && newDevices && (
                  <NewDevicesRow list={newDevices} onChanged={afterBlock} onClose={() => setPath([])}
                    onShow={(mac) => model.byId.has(`host:${mac}`) && goTo(`host:${mac}`)} />
                )}
                {path[0] === 'grp:attn:blocked' && blocked && (
                  <BlockedDevicesRow list={blocked} onChanged={afterBlock} onClose={() => setPath([])} />
                )}
                {path[0]?.startsWith('grp:attn') && !['grp:attn:new', 'grp:attn:blocked', 'grp:attn:posture'].includes(path[0]) && <OpenRow model={model} path={path} setPath={setPath} onMap={setFocus} onChanged={() => load()} onBlocked={afterBlock} />}
              </section>

              {model.lanes.map((lane) => lane.items.length > 0 && (
                <LaneGrid key={lane.key} lane={lane} model={model} path={path} setPath={setPath} onMap={setFocus} onChanged={() => load()} onBlocked={afterBlock} postureView={postureView} />
              ))}
            </main>
          </div>
        </>
      )}
    </>
  );
}

function Tile({ item, model, active, onClick, postureView }: { item: Item; model: TopoModel; active: boolean; onClick: () => void; postureView: boolean }) {
  const worst = model.worst(item.id);
  const top = postureView ? model.findingsFor(item.id)[0] : undefined;
  return (
    <button id={`tile-${item.id}`} onClick={onClick} aria-expanded={active}
      className={cn('rounded-lg border bg-card px-3.5 py-3 flex flex-col gap-2 text-left min-w-0 transition-colors hover:border-primary/70',
        active ? 'border-primary ring-1 ring-primary bg-primary/5'
          : postureView && worst ? SEV_TINT[worst.severity]
          : item.status === 'down' ? 'border-red-500/60' : item.status === 'warn' ? 'border-amber-400/60' : 'border-border')}>
      <span className="flex items-center gap-2 min-w-0 w-full">
        <ItemIcon item={item} className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className={cn('h-2 w-2 rounded-full shrink-0', STATUS_DOT[item.status])} />
        <span className="text-[15px] font-semibold truncate">{item.label}</span>
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {worst && <span title={`${worst.total} posture finding${worst.total === 1 ? '' : 's'}`}><SevPill severity={worst.severity} count={worst.count} /></span>}
          {postureView && !worst && <span className="text-[11px] text-emerald-600 dark:text-emerald-400">✓ clean</span>}
          <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform', active && 'rotate-90')} />
        </span>
      </span>
      <span className="text-[12px] text-muted-foreground truncate w-full">{item.sub}</span>
      {top ? <span className={cn('text-[12px] truncate w-full', top.severity === 'high' ? 'text-red-600 dark:text-red-400' : top.severity === 'medium' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>{(() => { const n = model.affectedIn(item.id, top); return n && n < top.affected.length && /^\d+\s/.test(top.title) ? `${n} here · ${top.title.replace(/^\d+\s+/, '')}` : top.title; })()}</span>
        : <Chips chips={model.summary(item.id)} />}
    </button>
  );
}

/** A lane's tiles, with the open row slotted in after the grid row that holds the open tile. */
function LaneGrid({ lane, model, path, setPath, onMap, onChanged, onBlocked, postureView }: { lane: Lane; model: TopoModel; path: string[]; setPath: (p: string[]) => void; onMap: (id: string) => void; onChanged: () => void; onBlocked: () => void; postureView: boolean }) {
  const [ref, cols] = useColumns<HTMLDivElement>();
  const openIdx = lane.items.findIndex((i) => i.id === path[0]);
  const rowEnd = openIdx >= 0 ? Math.min(lane.items.length - 1, Math.floor(openIdx / cols) * cols + cols - 1) : -1;
  return (
    <section aria-label={lane.title} className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-3">
        <h2 className="text-base font-semibold">{lane.title}</h2>
        <span className="text-sm text-muted-foreground">{lane.sub}</span>
      </div>
      <div ref={ref} className="grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: GRID_GAP }}>
        {lane.items.map((it, i) => (
          <FragmentWithRow key={it.id} after={i === rowEnd ? <div className="col-span-full"><OpenRow model={model} path={path} setPath={setPath} onMap={onMap} onChanged={onChanged} onBlocked={onBlocked} /></div> : null}>
            <Tile item={it} model={model} active={path[0] === it.id} onClick={() => setPath(path[0] === it.id ? [] : [it.id])} postureView={postureView} />
          </FragmentWithRow>
        ))}
      </div>
    </section>
  );
}

function FragmentWithRow({ children, after }: { children: React.ReactNode; after: React.ReactNode }) {
  return <>{children}{after}</>;
}

/** The full-width row under an open tile: breadcrumb, counts, what reaches it, and its contents. */
function OpenRow({ model, path, setPath, onMap, onChanged, onBlocked }: { model: TopoModel; path: string[]; setPath: (p: string[]) => void; onMap: (id: string) => void; onChanged: () => void; onBlocked: () => void }) {
  const current = path[path.length - 1];
  const item = model.item(current);
  const [details, setDetails] = useState(false);
  const [all, setAll] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setDetails(false); setAll(false); }, [current]);
  useEffect(() => { rowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [current]);

  if (!item) {
    return (
      <div className="rounded-xl border border-border p-4 text-sm">
        That item isn't in the latest map. <button className="text-accent hover:underline" onClick={() => setPath([])}>Close</button>
      </div>
    );
  }
  const kids = model.children(current);
  const shown = all ? kids : kids.slice(0, 60);
  const reach = item.node ? model.reach(current) : [];
  const via = item.node ? model.via(current) : [];
  const leaf = kids.length === 0;
  const unifiClient = item.node?.sources.find((s) => s.connectorId === 'unifi' && s.kind === 'client' && s.instanceId && s.resourceId);

  return (
    <div ref={rowRef} className="rounded-xl border border-primary/50 bg-primary/[0.04] p-4 flex flex-col gap-3.5 scroll-mt-4">
      {path.length > 1 && (
        <nav aria-label="Path" className="flex flex-wrap items-center gap-1 text-sm">
          {path.map((id, i) => {
            const it = model.item(id);
            const last = i === path.length - 1;
            return (
              <span key={id} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                {last ? <span className="font-medium">{it?.label ?? id}</span>
                  : <button className="text-accent hover:underline" onClick={() => setPath(path.slice(0, i + 1))}>{it?.label ?? id}</button>}
              </span>
            );
          })}
        </nav>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ItemIcon item={item} className="h-5 w-5 text-muted-foreground" />
        <span className={cn('h-2.5 w-2.5 rounded-full', STATUS_DOT[item.status])} />
        <h3 className="text-base font-semibold">{item.label}</h3>
        <span className="text-sm text-muted-foreground">{item.node ? `${TYPE_LABEL[item.node.type]} · ` : ''}{item.sub}</span>
        <Chips chips={model.summary(current)} />
        <span className="ml-auto flex flex-wrap gap-2">
          {item.node && !leaf && (
            <Button size="sm" variant="outline" onClick={() => setDetails((d) => !d)} aria-pressed={details}><Info className="h-3.5 w-3.5" /> {details ? 'Hide details' : 'Details'}</Button>
          )}
          {item.node && <Button size="sm" variant="outline" onClick={() => onMap(current)}><Crosshair className="h-3.5 w-3.5" /> Show as map</Button>}
          {unifiClient && <BlockButton key={unifiClient.resourceId} instanceId={unifiClient.instanceId!} mac={unifiClient.resourceId!} name={item.label} onDone={onBlocked} />}
          <Button size="sm" variant="ghost" onClick={() => setPath([])} aria-label="Close"><X className="h-4 w-4" /></Button>
        </span>
      </div>

      <FindingsSection key={`f-${current}`} findings={model.findingsFor(current)} onShow={(id) => setPath(model.pathTo(id))} onChanged={onChanged} />

      {(current === 'internet' || current === 'grp:attn:exposed') && model.graph.exposure && (
        <ExposureSection entries={model.graph.exposure} onShow={(id) => setPath(model.pathTo(id))} onChanged={onChanged} />
      )}

      {item.node && (unifiClient || item.node.deviceType) && (
        <DeviceType key={item.node.id} type={item.node.deviceType?.name} model={item.node.deviceType?.model} source={item.node.deviceType?.source}
          mac={unifiClient?.resourceId ?? item.node.macs[0] ?? ''} instanceId={unifiClient?.instanceId} onSaved={onChanged} />
      )}

      {reach.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-muted-foreground mr-1">Reached from</span>
          <Chips chips={reach.slice(0, 10)} />
          {reach.length > 10 && <span className="text-xs text-muted-foreground">+{reach.length - 10} more in details</span>}
        </div>
      )}

      {via.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-muted-foreground mr-1">Connected via</span>
          <Chips chips={via} />
        </div>
      )}

      {item.node && (leaf || details) && (
        <div className="rounded-lg border border-border bg-card p-4">
          <NodeDetails node={item.node} graph={model.graph} byId={model.byId} columns={3} onGo={(id) => setPath(model.pathTo(id))} />
        </div>
      )}

      {!leaf && (
        <>
          <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(210px,1fr))]">
            {shown.map((k) => (
              <button key={k.id} onClick={() => setPath([...path, k.id])}
                className={cn('rounded-lg border bg-card px-3 py-2.5 flex flex-col gap-1.5 text-left min-w-0 hover:border-primary/70',
                  k.status === 'down' ? 'border-red-500/60' : k.status === 'warn' ? 'border-amber-400/60' : k.type === 'group' && k.status === 'unknown' ? 'border-dashed border-muted-foreground/50' : 'border-border')}>
                <span className="flex items-center gap-2 min-w-0 w-full">
                  <ItemIcon item={k} className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className={cn('h-2 w-2 rounded-full shrink-0', STATUS_DOT[k.status])} />
                  <span className="text-sm font-medium truncate">{k.label}</span>
                  {(() => { const w = model.worst(k.id); return w ? <SevPill severity={w.severity} count={w.count} className="ml-auto shrink-0" /> : null; })()}
                </span>
                <span className="text-[12px] text-muted-foreground truncate w-full">{k.sub}</span>
                <Chips chips={model.summary(k.id).filter((c) => c.tone !== 'plain' || k.node?.type === 'host' || k.node?.type === 'stack' || k.node?.type === 'pve_node')} />
              </button>
            ))}
          </div>
          {kids.length > shown.length && (
            <button className="self-start text-sm text-accent hover:underline" onClick={() => setAll(true)}>Show all {kids.length}</button>
          )}
        </>
      )}
    </div>
  );
}

/** Left-hand index: every tile by lane, plus the open path. */
function Tree({ model, path, onPick }: { model: TopoModel; path: string[]; onPick: (id: string) => void }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  return (
    <nav aria-label="Browse" className="flex-[0_1_250px] min-w-[220px] rounded-xl border border-border bg-card p-3 text-sm lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] overflow-y-auto">
      {model.lanes.map((lane) => lane.items.length > 0 && (
        <div key={lane.key} className="mb-2">
          <button className="w-full flex items-center gap-1.5 px-1 py-1 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
            onClick={() => setClosed((s) => { const n = new Set(s); if (n.has(lane.key)) n.delete(lane.key); else n.add(lane.key); return n; })}
            aria-expanded={!closed.has(lane.key)}>
            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', !closed.has(lane.key) && 'rotate-90')} />
            {lane.title}
            <span className="ml-auto tabular-nums">{lane.items.length}</span>
          </button>
          {!closed.has(lane.key) && (
            <ul>
              {lane.items.map((it) => {
                const open = path[0] === it.id;
                return (
                  <li key={it.id}>
                    <button onClick={() => onPick(it.id)}
                      className={cn('w-full flex items-center gap-2 rounded-md px-2 py-1.5 pl-6 text-left hover:bg-muted', open && 'bg-muted font-medium')}>
                      <span className={cn('h-2 w-2 rounded-full shrink-0', STATUS_DOT[it.status])} />
                      <span className="truncate">{it.label}</span>
                    </button>
                    {open && path.length > 1 && (
                      <ul>
                        {path.slice(1).map((id, i) => (
                          <li key={id} className="text-muted-foreground truncate py-1" style={{ paddingLeft: 32 + i * 12 }}>{model.item(id)?.label ?? id}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
    </nav>
  );
}

export default ArchitectureMap;
