import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, MarkerType, useReactFlow,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertTriangle, ChevronRight, Crosshair, ExternalLink, RefreshCw, Search, X } from 'lucide-react';
import type { TopoEdgeType, TopoNode, TopologyGraph } from '@cerebro/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { buildView, matches, viewFor, VIEW_LABEL, type MapView } from '@/components/topology/views';
import { layout } from '@/components/topology/layout';
import { nodeTypes, iconFor, STATUS_DOT, TYPE_LABEL, type TopoFlowNode } from '@/components/topology/nodes';

const REFRESH_MS = 2 * 60_000;
const VIEWS: MapView[] = ['network', 'compute', 'apps'];

const EDGE_STYLE: Record<TopoEdgeType, { stroke: string; dash?: string; animated?: boolean; name: string }> = {
  uplink: { stroke: 'hsl(var(--muted-foreground))', name: 'Physical link' },
  routes: { stroke: 'hsl(var(--secondary))', dash: '6 4', name: 'Gateway routes VLAN' },
  runs_on: { stroke: 'hsl(var(--secondary))', name: 'Runs on' },
  hosts: { stroke: 'hsl(var(--muted-foreground))', name: 'Hosts' },
  resolves: { stroke: 'hsl(var(--muted-foreground))', dash: '2 4', name: 'Name points to' },
  forwards: { stroke: 'hsl(var(--accent))', animated: true, name: 'Traffic forwarded' },
  fw_allow: { stroke: 'rgb(52 211 153)', dash: '5 4', name: 'Firewall allows' },
  fw_block: { stroke: 'rgb(239 68 68)', dash: '5 4', name: 'Firewall blocks' },
};

const EDGE_LEGEND: Record<MapView, TopoEdgeType[]> = {
  network: ['uplink', 'routes', 'forwards', 'fw_allow', 'fw_block'],
  compute: ['runs_on'],
  apps: ['resolves', 'forwards'],
};

function sourceHref(s: TopoNode['sources'][number]): string | null {
  if (s.instanceId) return `/connectors/${s.instanceId}`;
  if (s.connectorId === 'fabric') return '/fabric';
  if (s.connectorId === 'replicator') return '/replicator';
  return null;
}

export function ArchitectureMap() {
  return (
    <ReactFlowProvider>
      <MapInner />
    </ReactFlowProvider>
  );
}

function MapInner() {
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.includes(params.get('view') as MapView) ? params.get('view') : 'network') as MapView;
  const focus = params.get('focus');
  const setView = (v: MapView) => setParams((p) => { p.set('view', v); p.delete('focus'); return p; });
  const setFocus = (id: string | null) => setParams((p) => { if (id) p.set('focus', id); else p.delete('focus'); return p; });

  const [graph, setGraph] = useState<TopologyGraph | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showClients, setShowClients] = useState(false);
  const [showFirewall, setShowFirewall] = useState(false);
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [flowNodes, setFlowNodes] = useState<TopoFlowNode[]>([]);
  const [laying, setLaying] = useState(false);
  const pendingCenter = useRef<string | null>(null);
  const rf = useReactFlow();

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      setGraph(await api.get<TopologyGraph>(`/api/topology${manual ? '?refresh=1' : ''}`));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load the map.');
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => { load(); const t = setInterval(() => load(), REFRESH_MS); return () => clearInterval(t); }, [load]);

  const byId = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);
  const onToggle = useCallback((id: string) => setToggled((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);

  const v = useMemo(
    () => (graph ? buildView(view, graph, { showClients, showFirewall, toggled, focus }) : null),
    [graph, view, showClients, showFirewall, toggled, focus],
  );

  // Lay out whenever the visible structure changes (not on selection).
  useEffect(() => {
    if (!v) return;
    let cancelled = false;
    setLaying(true);
    layout(view, v)
      .then((pos) => {
        if (cancelled) return;
        const nodes: TopoFlowNode[] = [];
        // Parents must precede their children for React Flow.
        const depth = (id: string): number => { const p = pos.get(id)?.parent; return p ? 1 + depth(p) : 0; };
        const ordered = [...v.nodes].sort((a, b) => depth(a.node.id) - depth(b.node.id));
        for (const vn of ordered) {
          const p = pos.get(vn.node.id);
          if (!p) continue;
          nodes.push({
            id: vn.node.id,
            type: vn.isGroup ? 'group' : 'card',
            position: { x: p.x, y: p.y },
            parentId: p.parent,
            width: p.width,
            height: p.height,
            style: { width: p.width, height: p.height },
            zIndex: vn.isGroup ? 0 : 1,
            draggable: true,
            data: { v: vn, title: titleFor(vn.node, view, byId), selected: false, dimmed: false, onToggle },
          });
        }
        setFlowNodes(nodes);
        requestAnimationFrame(() => {
          const c = pendingCenter.current;
          pendingCenter.current = null;
          if (c && nodes.some((n) => n.id === c)) rf.fitView({ nodes: [{ id: c }], maxZoom: 1.1, duration: 400 });
          else rf.fitView({ padding: 0.12, duration: 300 });
        });
      })
      .catch((e) => !cancelled && setErr(`Layout failed: ${e instanceof Error ? e.message : e}`))
      .finally(() => !cancelled && setLaying(false));
    return () => { cancelled = true; };
  }, [v, view, byId, onToggle, rf]);

  // Neighbourhood of the selection, for highlighting.
  const neighbours = useMemo(() => {
    if (!selected || !v) return null;
    const s = new Set<string>([selected]);
    for (const e of [...v.edges, ...v.extraEdges]) {
      if (e.source === selected) s.add(e.target);
      if (e.target === selected) s.add(e.source);
    }
    return s;
  }, [selected, v]);

  const nodes = useMemo(
    () => flowNodes.map((n) => ({
      ...n,
      data: { ...n.data, selected: n.id === selected, dimmed: !!neighbours && !neighbours.has(n.id) && n.type !== 'group' },
    })),
    [flowNodes, selected, neighbours],
  );

  const edges: Edge[] = useMemo(() => {
    if (!v) return [];
    const shown = new Set(flowNodes.map((n) => n.id));
    const extra = selected ? v.extraEdges.filter((e) => e.source === selected || e.target === selected) : [];
    return [...v.edges, ...extra].filter((e) => shown.has(e.source) && shown.has(e.target)).map((e) => {
      const st = EDGE_STYLE[e.type];
      const touches = !!selected && (e.source === selected || e.target === selected);
      const faded = !!selected && !touches;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: view === 'apps' ? 'r' : undefined,
        targetHandle: view === 'apps' ? 'l' : undefined,
        type: e.type === 'uplink' || e.type === 'routes' || e.type === 'runs_on' ? 'smoothstep' : 'default',
        animated: st.animated && !faded,
        // Short labels only (ports, "served by NPM"); firewall rule names live in the drawer.
        label: touches && e.label ? e.label : undefined,
        labelStyle: { fill: 'hsl(var(--foreground))', fontSize: 11 },
        labelBgStyle: { fill: 'hsl(var(--card))' },
        style: { stroke: st.stroke, strokeDasharray: st.dash, strokeWidth: touches ? 2.2 : 1.4, opacity: faded ? 0.15 : 0.85 },
        markerEnd: e.type === 'uplink' || e.type === 'routes' ? undefined : { type: MarkerType.ArrowClosed, color: st.stroke, width: 14, height: 14 },
        zIndex: 2,
      };
    });
  }, [v, flowNodes, selected, view]);

  const hits = useMemo(() => (graph && q.trim() ? graph.nodes.filter((n) => matches(n, q)).slice(0, 12) : []), [graph, q]);

  /** Jump to any node: switch view, open its collapsed ancestors, select and centre it. */
  const goTo = (n: TopoNode) => {
    const target = viewFor(n);
    if (n.type === 'host' && !n.infra) setShowClients(true);
    const open = new Set(toggled);
    let p = n.parent;
    while (p) {
      const pn = byId.get(p);
      if (pn?.type === 'stack' && !open.has(p)) open.add(p); // stacks default collapsed
      p = pn?.parent;
    }
    setToggled(open);
    setSelected(n.id);
    setQ('');
    pendingCenter.current = n.id;
    if (target !== view || focus) setParams((pp) => { pp.set('view', target); pp.delete('focus'); return pp; });
  };

  const sel = selected ? byId.get(selected) : undefined;
  const badFeeds = graph?.feeds.filter((f) => !f.ok) ?? [];

  return (
    <>
      <PageHeader
        title="Architecture Map"
        description="Everything Cerebro can see, joined into one map: network, compute, and how names reach your apps."
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

      {/* Control bar */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="inline-flex rounded-md border border-border overflow-hidden text-sm">
          {VIEWS.map((vw) => (
            <button key={vw} onClick={() => setView(vw)}
              className={cn('px-3 py-1.5', view === vw ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {VIEW_LABEL[vw]}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Find a host, IP, MAC, container, hostname…" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) goTo(hits[0]); if (e.key === 'Escape') setQ(''); }} />
          {q && <button onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>}
          {hits.length > 0 && (
            <div className="absolute z-30 mt-1 w-full rounded-md border border-border bg-card shadow-xl max-h-80 overflow-y-auto">
              {hits.map((n) => {
                const Icon = iconFor(n);
                return (
                  <button key={n.id} onClick={() => goTo(n)} className="w-full text-left px-3 py-2 hover:bg-muted flex items-center gap-2">
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
        {view === 'network' && (
          <>
            <Toggle on={showClients} onClick={() => setShowClients((x) => !x)}>Clients &amp; IoT</Toggle>
            <Toggle on={showFirewall} onClick={() => setShowFirewall((x) => !x)}>Firewall rules</Toggle>
          </>
        )}
        {laying && <span className="text-xs text-muted-foreground">Laying out…</span>}
      </div>


      <div className="relative flex gap-3 h-[calc(100dvh-15rem)] min-h-[480px]">
        <div className="relative flex-1 min-w-0 rounded-xl border border-border bg-background overflow-hidden">
          {!graph && !err && <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">Building the map from your connectors…</div>}
          {focus && (
            <div className="absolute left-3 top-3 z-10 flex items-center gap-1 text-sm rounded-md border border-border bg-card/90 px-3 py-1.5">
              <button className="text-accent hover:underline" onClick={() => setFocus(null)}>{VIEW_LABEL[view]}</button>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-medium">{byId.get(focus)?.label ?? focus}</span>
              <span className="text-xs text-muted-foreground ml-2">Faded cards are what it connects to.</span>
            </div>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => setSelected(n.id)}
            onNodeDoubleClick={(_, n) => { if ((n as TopoFlowNode).data.v.isGroup || (n as TopoFlowNode).data.v.collapsed) setFocus(n.id); }}
            onPaneClick={() => setSelected(null)}
            nodesConnectable={false}
            minZoom={0.05}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            colorMode={document.documentElement.classList.contains('light') ? 'light' : 'dark'}
            style={{ background: 'hsl(var(--background))' }}
          >
            <Background gap={24} size={1} color="hsl(var(--border))" />
            <Controls showInteractive={false} />
            <MiniMap position="top-right" pannable zoomable nodeColor={(n) => ((n as TopoFlowNode).data?.v?.isGroup ? 'hsl(var(--muted))' : 'hsl(var(--muted-foreground))')} maskColor="rgba(0,0,0,0.5)" style={{ background: 'hsl(var(--card))' }} />
          </ReactFlow>
          <Legend view={view} />
        </div>

        {sel && graph && (
          <Drawer node={sel} graph={graph} byId={byId} onClose={() => setSelected(null)} onGo={goTo}
            onFocus={v?.nodes.some((x) => x.node.id === sel.id && (x.isGroup || x.collapsed)) ? () => setFocus(sel.id) : undefined} />
        )}
      </div>
    </>
  );
}

function titleFor(n: TopoNode, view: MapView, byId: Map<string, TopoNode>): string {
  if (n.type === 'container' && view !== 'compute') {
    const stack = n.parent ? byId.get(n.parent)?.label : undefined;
    return stack ? `${stack} / ${n.label}` : n.label;
  }
  return n.label;
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={cn('rounded-md border px-2.5 py-1.5 text-sm', on ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
      <span className={cn('inline-block h-2 w-2 rounded-full mr-1.5', on ? 'bg-primary' : 'bg-muted-foreground/40')} />
      {children}
    </button>
  );
}

function Legend({ view }: { view: MapView }) {
  return (
    <div className="absolute left-14 bottom-2 z-10 rounded-md border border-border bg-card/90 px-3 py-2 text-[11px] flex flex-wrap gap-x-4 gap-y-1 max-w-[70%]">
      {EDGE_LEGEND[view].map((t) => (
        <span key={t} className="flex items-center gap-1.5">
          <svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" stroke={EDGE_STYLE[t].stroke} strokeWidth="2" strokeDasharray={EDGE_STYLE[t].dash} /></svg>
          {EDGE_STYLE[t].name}
        </span>
      ))}
      <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-400" />up</span>
      <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-400" />warning</span>
      <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-red-500" />down</span>
      <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-muted-foreground/50" />off</span>
    </div>
  );
}

const EDGE_PHRASE: Record<TopoEdgeType, [string, string]> = {
  // [this node is the source, this node is the target]
  uplink: ['Connected to', 'Connected from'],
  routes: ['Routes', 'Routed by'],
  runs_on: ['Runs on', 'Runs'],
  hosts: ['Hosts', 'Hosted on'],
  resolves: ['Points to', 'Named by'],
  forwards: ['Forwards to', 'Receives from'],
  fw_allow: ['Firewall allows to', 'Firewall allows from'],
  fw_block: ['Firewall blocks to', 'Firewall blocks from'],
};

function Drawer({ node, graph, byId, onClose, onGo, onFocus }: {
  node: TopoNode;
  graph: TopologyGraph;
  byId: Map<string, TopoNode>;
  onClose: () => void;
  onGo: (n: TopoNode) => void;
  onFocus?: () => void;
}) {
  const Icon = iconFor(node);
  const links = useMemo(() => {
    const out: { phrase: string; other: TopoNode; label?: string; notes?: string[] }[] = [];
    for (const e of graph.edges) {
      const mine = e.source === node.id ? 0 : e.target === node.id ? 1 : -1;
      if (mine < 0) continue;
      const other = byId.get(mine === 0 ? e.target : e.source);
      if (other) out.push({ phrase: EDGE_PHRASE[e.type][mine as 0 | 1], other, label: e.label, notes: e.notes });
    }
    const kids = graph.nodes.filter((n) => n.parent === node.id);
    for (const k of kids.slice(0, 60)) out.push({ phrase: 'Contains', other: k });
    const parent = node.parent ? byId.get(node.parent) : undefined;
    if (parent) out.unshift({ phrase: 'Inside', other: parent });
    return out;
  }, [node, graph, byId]);

  const grouped = useMemo(() => {
    const m = new Map<string, typeof links>();
    for (const l of links) { if (!m.has(l.phrase)) m.set(l.phrase, []); m.get(l.phrase)!.push(l); }
    return [...m.entries()];
  }, [links]);

  return (
    <aside className="w-[360px] shrink-0 rounded-xl border border-border bg-card flex flex-col overflow-hidden max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-20 max-md:w-[92%]">
      <div className="flex items-start gap-3 p-4 border-b border-border">
        <div className="h-9 w-9 rounded-md bg-muted grid place-items-center shrink-0"><Icon className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold leading-tight break-words">{node.label}</h2>
          <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
            <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[node.status])} />
            {TYPE_LABEL[node.type]}{node.statusText ? ` · ${node.statusText}` : ''}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
        {(node.roles.length > 0 || onFocus) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {node.roles.map((r) => <span key={r} className="rounded-full bg-muted px-2 py-0.5 text-xs">{r}</span>)}
            {onFocus && <Button size="sm" variant="outline" className="ml-auto h-7" onClick={onFocus}><Crosshair className="h-3.5 w-3.5" /> Drill in</Button>}
          </div>
        )}
        {(node.ips.length > 0 || node.macs.length > 0) && (
          <dl className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 text-xs">
            {node.ips.length > 0 && <><dt className="text-muted-foreground">IP</dt><dd className="font-mono break-all">{node.ips.join(', ')}</dd></>}
            {node.macs.length > 0 && <><dt className="text-muted-foreground">MAC</dt><dd className="font-mono break-all">{node.macs.join(', ')}</dd></>}
          </dl>
        )}

        {grouped.length > 0 && (
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">Connections</h3>
            <div className="space-y-2">
              {grouped.map(([phrase, items]) => (
                <div key={phrase}>
                  <p className="text-xs text-muted-foreground">{phrase}</p>
                  <ul className="mt-0.5 space-y-0.5">
                    {items.map((l, i) => (
                      <li key={i}>
                        <button onClick={() => onGo(l.other)} className="text-left hover:text-accent flex items-center gap-1.5 w-full">
                          <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', STATUS_DOT[l.other.status])} />
                          <span className="truncate">{l.other.label}</span>
                          {l.label && <span className="text-xs text-muted-foreground truncate">{l.label}</span>}
                        </button>
                        {l.notes?.map((n) => <p key={n} className="text-[11px] text-muted-foreground ml-3 break-words">{n}</p>)}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        )}

        {node.details.map((d, i) => (
          <section key={i}>
            <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">{d.source}</h3>
            <dl className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-1 text-xs">
              {d.items.map((it) => (
                <div key={it.label} className="contents">
                  <dt className="text-muted-foreground truncate">{it.label}</dt>
                  <dd className="break-words">{it.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}

        {node.sources.length > 0 && (
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">Seen by</h3>
            <ul className="space-y-1">
              {node.sources.map((s, i) => {
                const href = sourceHref(s);
                return (
                  <li key={i} className="text-xs">
                    {href ? <Link to={href} className="text-accent hover:underline inline-flex items-center gap-1">{s.name}<ExternalLink className="h-3 w-3" /></Link> : s.name}
                    {s.kind && <span className="text-muted-foreground"> · {s.kind}</span>}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}

export default ArchitectureMap;
