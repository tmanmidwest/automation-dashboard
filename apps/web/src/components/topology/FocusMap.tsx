import { memo, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MarkerType, Handle, Position, useReactFlow,
  type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, Crosshair, LayoutGrid, X } from 'lucide-react';
import type { TopoEdge, TopoEdgeType, TopoNode } from '@cerebro/shared';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { iconFor, STATUS_DOT, TYPE_LABEL } from './meta';
import type { TopoModel } from './model';
import { NodeDetails } from './NodeDetails';

/**
 * "Show as map": one thing and what it connects to, drawn left to right at a readable
 * size. Left: what reaches it. Middle: it (and what's inside it). Right: what it reaches.
 * Laid out by hand in columns, so it never shrinks a whole environment onto one screen.
 */

const CARD_W = 250;
const CARD_H = 58;
const GAP = 14;
const COL_GAP = 140;
const GROUP_PAD = 16;
const GROUP_HEAD = 44;
const MAX_SIDE = 12;

const EDGE_STYLE: Record<TopoEdgeType, { stroke: string; dash?: string; animated?: boolean; name: string }> = {
  uplink: { stroke: 'hsl(var(--muted-foreground))', name: 'Physical link' },
  routes: { stroke: 'hsl(var(--secondary))', dash: '6 4', name: 'Gateway routes' },
  runs_on: { stroke: 'hsl(var(--secondary))', name: 'Runs on' },
  hosts: { stroke: 'hsl(var(--muted-foreground))', name: 'Hosts' },
  resolves: { stroke: 'hsl(var(--muted-foreground))', dash: '2 4', name: 'Name points to' },
  forwards: { stroke: 'hsl(var(--accent))', animated: true, name: 'Traffic forwarded' },
  fw_allow: { stroke: 'rgb(52 211 153)', dash: '5 4', name: 'Firewall allows' },
  fw_block: { stroke: 'rgb(239 68 68)', dash: '5 4', name: 'Firewall blocks' },
};

interface CardData extends Record<string, unknown> {
  label: string;
  sub: string;
  node?: TopoNode;
  more?: number;
  selected: boolean;
  dimmed: boolean;
}
type CardNode = Node<CardData>;

const hidden = '!opacity-0 !pointer-events-none';

const Card = memo(function Card({ data }: NodeProps<CardNode>) {
  const Icon = data.node ? iconFor(data.node) : LayoutGrid;
  return (
    <div className={cn(
      'h-full w-full rounded-lg border bg-card px-3 flex items-center gap-2.5 shadow-sm transition-opacity',
      data.node?.status === 'down' ? 'border-red-500/80' : data.node?.status === 'warn' ? 'border-amber-400/70' : 'border-border',
      !data.node?.sources.length && data.node?.type === 'host' && 'border-dashed',
      data.selected && 'ring-2 ring-primary border-primary',
      data.dimmed && 'opacity-30',
    )}>
      <Handle type="target" position={Position.Left} className={hidden} />
      <Handle type="source" position={Position.Right} className={hidden} />
      <div className="relative shrink-0">
        <div className="h-8 w-8 rounded-md bg-muted grid place-items-center"><Icon className="h-4 w-4" /></div>
        {data.node && <span className={cn('absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-card', STATUS_DOT[data.node.status])} />}
      </div>
      <div className="min-w-0 leading-tight">
        <p className="text-[14px] font-medium truncate">{data.label}</p>
        <p className="text-[12px] text-muted-foreground truncate">{data.sub}</p>
      </div>
    </div>
  );
});

const Group = memo(function Group({ data }: NodeProps<CardNode>) {
  const Icon = data.node ? iconFor(data.node) : LayoutGrid;
  return (
    <div className="h-full w-full rounded-xl border-2 border-secondary/70 bg-muted/20">
      <Handle type="target" position={Position.Left} className={hidden} />
      <Handle type="source" position={Position.Right} className={hidden} />
      <div className="flex items-center gap-2 px-3 h-11 border-b border-border/60">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {data.node && <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[data.node.status])} />}
        <span className="text-[14px] font-semibold truncate shrink-0 max-w-[65%]">{data.label}</span>
        <span className="text-[12px] text-muted-foreground truncate">{data.sub}</span>
      </div>
    </div>
  );
});

const nodeTypes = { card: Card, group: Group };

interface Plan {
  nodes: CardNode[];
  edges: (TopoEdge & { from: string; to: string })[];
  left: number;
  right: number;
}

function plan(model: TopoModel, focusId: string, showFirewall: boolean): Plan | null {
  const focus = model.byId.get(focusId);
  if (!focus) return null;
  const members = model.children(focusId).filter((i) => i.node).map((i) => i.node!);
  // Unknown addresses are a virtual group on the overview; draw them individually here.
  if (focus.type === 'network') {
    for (const k of model.graph.nodes) if (k.parent === focusId && !k.sources.length && !members.includes(k)) members.push(k);
  }
  const memberIds = new Set(members.map((m) => m.id));

  /** The card an id is drawn as: the focus, one of its members, or (outside) itself. */
  const inside = (id: string): string | null => {
    if (id === focusId) return members.length ? null : focusId;
    let cur: string | undefined = id;
    while (cur) {
      if (memberIds.has(cur)) return cur;
      if (cur === focusId) return members.length ? null : focusId;
      cur = model.byId.get(cur)?.parent;
    }
    return null;
  };
  const isWithin = (id: string) => {
    let cur: string | undefined = id;
    while (cur) { if (cur === focusId || memberIds.has(cur)) return true; cur = model.byId.get(cur)?.parent; }
    return false;
  };
  const center = members.length ? focusId : focusId;

  const inbound = new Map<string, TopoEdge[]>(); // outside id → edges into cards
  const outbound = new Map<string, TopoEdge[]>();
  const edges: Plan['edges'] = [];
  const seen = new Set<string>();
  for (const e of model.graph.edges) {
    if (!showFirewall && (e.type === 'fw_allow' || e.type === 'fw_block')) continue;
    const sIn = isWithin(e.source);
    const tIn = isWithin(e.target);
    if (sIn === tIn) continue;
    // Uplinks into a switch/AP are its children, not context; gateway routes likewise.
    if (e.type === 'uplink' && tIn && (focus.type === 'switch' || focus.type === 'ap')) continue;
    if (e.type === 'routes' && sIn && focus.type === 'gateway') continue;
    const card = inside(sIn ? e.source : e.target) ?? center;
    const other = sIn ? e.target : e.source;
    if (!model.byId.has(other)) continue;
    const key = `${e.type}:${sIn ? `${card}>${other}` : `${other}>${card}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bucket = sIn ? outbound : inbound;
    if (!bucket.has(other)) bucket.set(other, []);
    bucket.get(other)!.push(e);
    edges.push({ ...e, from: sIn ? card : other, to: sIn ? other : card });
  }

  const order = (ids: string[]) => ids.sort((a, b) => {
    const r = (id: string) => { const t = model.byId.get(id)!.type; return t === 'internet' ? 0 : t === 'dns_name' ? 1 : t === 'network' ? 2 : 3; };
    return r(a) - r(b) || model.byId.get(a)!.label.localeCompare(model.byId.get(b)!.label, undefined, { numeric: true });
  });
  const capSide = (ids: string[], side: 'in' | 'out') => {
    if (ids.length <= MAX_SIDE) return { shown: ids, more: [] as string[] };
    // Keep the internet and networks; fold the long tail (usually hostnames) into one card.
    const keep = ids.filter((id) => ['internet', 'network', 'gateway', 'switch', 'ap', 'pve_node'].includes(model.byId.get(id)!.type));
    const rest = ids.filter((id) => !keep.includes(id));
    const room = Math.max(MAX_SIDE - 1 - keep.length, 0);
    void side;
    return { shown: order([...keep, ...rest.slice(0, room)]), more: rest.slice(room) };
  };
  const left = capSide(order([...inbound.keys()]), 'in');
  const right = capSide(order([...outbound.keys()]), 'out');

  // Geometry.
  const cols = members.length > 10 ? 2 : 1;
  const rows = Math.ceil(members.length / cols);
  const groupW = members.length ? Math.max(cols * CARD_W + (cols - 1) * GAP + GROUP_PAD * 2, 360) : CARD_W;
  const groupH = members.length ? GROUP_HEAD + GROUP_PAD + rows * CARD_H + (rows - 1) * GAP + GROUP_PAD : CARD_H;
  const colH = (n: number) => (n ? n * CARD_H + (n - 1) * GAP : 0);
  const leftN = left.shown.length + (left.more.length ? 1 : 0);
  const rightN = right.shown.length + (right.more.length ? 1 : 0);
  const H = Math.max(groupH, colH(leftN), colH(rightN));
  const xC = leftN ? CARD_W + COL_GAP : 0;
  const xR = xC + groupW + COL_GAP;

  const nodes: CardNode[] = [];
  const card = (id: string, x: number, y: number, label: string, sub: string, node?: TopoNode, parentId?: string, more?: number): CardNode => ({
    id, type: 'card', position: { x, y }, parentId, extent: parentId ? 'parent' : undefined, width: CARD_W, height: CARD_H,
    style: { width: CARD_W, height: CARD_H }, draggable: false, data: { label, sub, node, more, selected: false, dimmed: false },
  });
  const subOf = (n: TopoNode) => model.asItem(n).sub;
  const labelOf = (n: TopoNode) => {
    if (n.type === 'container' && n.parent) return `${model.byId.get(n.parent)?.label ?? ''} / ${n.label}`;
    return n.label;
  };

  const yG = (H - groupH) / 2;
  if (members.length) {
    nodes.push({
      id: focusId, type: 'group', position: { x: xC, y: yG }, width: groupW, height: groupH, style: { width: groupW, height: groupH },
      draggable: false, zIndex: 0, data: { label: focus.label, sub: subOf(focus), node: focus, selected: false, dimmed: false },
    });
    members.forEach((m, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      nodes.push({ ...card(m.id, (groupW - (cols * CARD_W + (cols - 1) * GAP)) / 2 + c * (CARD_W + GAP), GROUP_HEAD + GROUP_PAD + r * (CARD_H + GAP), labelOf(m), subOf(m), m, focusId), zIndex: 1 });
    });
  } else {
    nodes.push(card(focusId, xC, yG, labelOf(focus), subOf(focus), focus));
  }
  const side = (list: { shown: string[]; more: string[] }, x: number, prefix: string) => {
    const n = list.shown.length + (list.more.length ? 1 : 0);
    let y = (H - colH(n)) / 2;
    for (const id of list.shown) {
      const o = model.byId.get(id)!;
      nodes.push(card(`${prefix}${id}`, x, y, labelOf(o), subOf(o), o));
      y += CARD_H + GAP;
    }
    if (list.more.length) nodes.push(card(`${prefix}more`, x, y, `+ ${list.more.length} more`, 'Listed on the overview', undefined, undefined, list.more.length));
  };
  side(left, 0, 'in:');
  side(right, xR, 'out:');

  // Re-point edges at the drawn side cards ("+ N more" for the folded tail).
  const leftShown = new Set(left.shown);
  const rightShown = new Set(right.shown);
  const drawn: Plan['edges'] = [];
  const dedupe = new Set<string>();
  for (const e of edges) {
    let from = e.from;
    let to = e.to;
    if (inbound.has(e.from) && from !== e.to) from = leftShown.has(e.from) ? `in:${e.from}` : 'in:more';
    if (outbound.has(e.to) && to !== e.from) to = rightShown.has(e.to) ? `out:${e.to}` : 'out:more';
    const k = `${e.type}:${from}>${to}`;
    if (dedupe.has(k)) continue;
    dedupe.add(k);
    drawn.push({ ...e, from, to });
  }
  return { nodes, edges: drawn, left: leftN, right: rightN };
}

export function FocusMap(props: { model: TopoModel; focusId: string; onBack: () => void; onFocus: (id: string) => void; onOpen: (id: string) => void }) {
  return (
    <ReactFlowProvider>
      <FocusInner {...props} />
    </ReactFlowProvider>
  );
}

function FocusInner({ model, focusId, onBack, onFocus, onOpen }: { model: TopoModel; focusId: string; onBack: () => void; onFocus: (id: string) => void; onOpen: (id: string) => void }) {
  const [showFirewall, setShowFirewall] = useState(false);
  const p = useMemo(() => plan(model, focusId, showFirewall), [model, focusId, showFirewall]);
  const [selected, setSelected] = useState<string | null>(null);
  const rf = useReactFlow();
  const focus = model.byId.get(focusId);
  useEffect(() => setSelected(null), [focusId]);
  useEffect(() => {
    const t = requestAnimationFrame(() => rf.fitView({ padding: 0.08, minZoom: 0.7, maxZoom: 1, duration: 250 }));
    return () => cancelAnimationFrame(t);
  }, [p, rf]);

  const realId = (id: string | null) => (id ? id.replace(/^(in|out):/, '') : null);
  const selNode = selected ? model.byId.get(realId(selected)!) : undefined;
  const neighbours = useMemo(() => {
    if (!selected || !p) return null;
    const s = new Set([selected]);
    for (const e of p.edges) { if (e.from === selected) s.add(e.to); if (e.to === selected) s.add(e.from); }
    return s;
  }, [selected, p]);

  const nodes = useMemo(() => (p?.nodes ?? []).map((n) => ({
    ...n,
    data: { ...n.data, selected: n.id === selected, dimmed: !!neighbours && n.type !== 'group' && !neighbours.has(n.id) },
  })), [p, selected, neighbours]);

  const edges: Edge[] = useMemo(() => (p?.edges ?? []).map((e) => {
    const st = EDGE_STYLE[e.type];
    const touches = !!selected && (e.from === selected || e.to === selected);
    const faded = !!selected && !touches;
    return {
      id: `${e.type}:${e.from}>${e.to}`,
      source: e.from,
      target: e.to,
      type: 'default',
      animated: st.animated && !faded,
      label: touches && e.label ? e.label : undefined,
      labelStyle: { fill: 'hsl(var(--foreground))', fontSize: 12 },
      labelBgStyle: { fill: 'hsl(var(--card))' },
      style: { stroke: st.stroke, strokeDasharray: st.dash, strokeWidth: touches ? 2.4 : 1.5, opacity: faded ? 0.12 : 0.85 },
      markerEnd: { type: MarkerType.ArrowClosed, color: st.stroke, width: 14, height: 14 },
      zIndex: 2,
    };
  }), [p, selected]);

  const used = useMemo(() => [...new Set((p?.edges ?? []).map((e) => e.type))], [p]);

  if (!focus || !p) {
    return (
      <div className="rounded-xl border border-border p-6 text-sm">
        That item isn't in the latest map. <button className="text-accent hover:underline" onClick={onBack}>Back to the overview</button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button variant="outline" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Overview</Button>
        <span className="font-semibold">{focus.label}</span>
        <span className="text-muted-foreground">{TYPE_LABEL[focus.type]}</span>
        <button onClick={() => setShowFirewall((x) => !x)} aria-pressed={showFirewall}
          className={cn('rounded-md border px-2.5 py-1.5 text-sm', showFirewall ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
          <span className={cn('inline-block h-2 w-2 rounded-full mr-1.5', showFirewall ? 'bg-primary' : 'bg-muted-foreground/40')} />
          Firewall rules
        </button>
        <span className="text-xs text-muted-foreground ml-auto hidden lg:inline">
          Left: what reaches it · Right: what it reaches · Double-click a card to map it instead
        </span>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-[999_1_640px] min-w-0 h-[calc(100dvh-15rem)] min-h-[460px] rounded-xl border border-border bg-background overflow-hidden">
          {p.left === 0 && p.right === 0 && (
            <div className="absolute top-3 left-3 z-10 text-xs rounded-md border border-border bg-card/90 px-3 py-1.5">Nothing outside this links to it.</div>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => setSelected(n.id === 'in:more' || n.id === 'out:more' ? null : n.id)}
            onNodeDoubleClick={(_, n) => { const id = realId(n.id); if (id && id !== focusId && model.byId.has(id)) onFocus(id); }}
            onPaneClick={() => setSelected(null)}
            nodesConnectable={false}
            nodesDraggable={false}
            panOnScroll
            zoomOnScroll={false}
            minZoom={0.4}
            maxZoom={1.6}
            proOptions={{ hideAttribution: true }}
            colorMode={document.documentElement.classList.contains('light') ? 'light' : 'dark'}
            style={{ background: 'hsl(var(--background))' }}
          >
            <Background gap={24} size={1} color="hsl(var(--border))" />
            <Controls showInteractive={false} />
          </ReactFlow>
          {used.length > 0 && (
            <div className="absolute left-14 bottom-2 z-10 rounded-md border border-border bg-card/90 px-3 py-2 text-[11px] flex flex-wrap gap-x-4 gap-y-1 max-w-[80%]">
              {used.map((t) => (
                <span key={t} className="flex items-center gap-1.5">
                  <svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" stroke={EDGE_STYLE[t].stroke} strokeWidth="2" strokeDasharray={EDGE_STYLE[t].dash} /></svg>
                  {EDGE_STYLE[t].name}
                </span>
              ))}
            </div>
          )}
        </div>
        {selNode && (
          <aside className="flex-[1_1_320px] max-w-full lg:max-w-[380px] rounded-xl border border-border bg-card p-4 flex flex-col gap-3 max-h-[calc(100dvh-15rem)] overflow-y-auto">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold break-words">{selNode.label}</h3>
                <p className="text-xs text-muted-foreground">{TYPE_LABEL[selNode.type]}{selNode.statusText ? ` · ${selNode.statusText}` : ''}</p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setSelected(null)} aria-label="Close"><X className="h-4 w-4" /></Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {selNode.id !== focusId && <Button size="sm" variant="outline" onClick={() => onFocus(selNode.id)}><Crosshair className="h-3.5 w-3.5" /> Map this instead</Button>}
              <Button size="sm" variant="outline" onClick={() => onOpen(selNode.id)}><LayoutGrid className="h-3.5 w-3.5" /> Show on overview</Button>
            </div>
            <NodeDetails node={selNode} graph={model.graph} byId={model.byId} onGo={(id) => setSelected(p.nodes.some((n) => n.id === id) ? id : p.nodes.some((n) => n.id === `in:${id}`) ? `in:${id}` : p.nodes.some((n) => n.id === `out:${id}`) ? `out:${id}` : null)} />
          </aside>
        )}
      </div>
    </div>
  );
}
