import ELK from 'elkjs/lib/elk-api.js';
import type { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import type { MapView, ViewResult } from './views';

/** Card sizes the node components render at; ELK needs them up front. */
export const CARD_W = 232;
export const CARD_H = 60;
/** Summary tiles (a collapsed VLAN / host / stack) carry a second row of counts. */
export const TILE_W = 264;
export const TILE_H = 84;
export const GROUP_PAD_TOP = 44;

export interface Placed {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Relative to this parent (React Flow's parentId convention, same as ELK's). */
  parent?: string;
}

// Layout runs in a web worker so a big map never freezes the page.
let elk: InstanceType<typeof ELK> | null = null;
function engine() {
  if (!elk) elk = new ELK({ workerUrl: elkWorkerUrl });
  return elk;
}

/**
 * ELK only sees links between top-level boxes (a link into a VLAN box counts as a link to
 * the box). That steers the overall arrangement without cross-hierarchy routing, which
 * clashes with the packed layout inside groups; React Flow still draws every real link.
 */
function topLevelEdges(v: ViewResult): ElkExtendedEdge[] {
  const parent = new Map(v.nodes.map((n) => [n.node.id, n.parent]));
  const top = (id: string) => {
    let cur = id;
    while (parent.get(cur)) cur = parent.get(cur)!;
    return cur;
  };
  const seen = new Set<string>();
  const out: ElkExtendedEdge[] = [];
  for (const e of v.edges) {
    const s = top(e.source);
    const t = top(e.target);
    const key = `${s}>${t}`;
    if (s === t || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: `l:${key}`, sources: [s], targets: [t] });
  }
  return out;
}

export async function layout(view: MapView, v: ViewResult): Promise<Map<string, Placed>> {
  const kids = new Map<string | undefined, ElkNode[]>();
  const elkNodes = new Map<string, ElkNode>();
  for (const n of v.nodes) {
    const e: ElkNode = n.isGroup
      ? {
          id: n.node.id,
          layoutOptions: {
            'elk.padding': `[top=${GROUP_PAD_TOP},left=16,bottom=16,right=16]`,
            // Hosts inside a VLAN have few links between them: pack them in a grid.
            // (laid out on their own; links into them are drawn but don't steer the packing).
            ...(view === 'network' ? { 'elk.algorithm': 'rectpacking', 'elk.aspectRatio': '2.2', 'elk.hierarchyHandling': 'SEPARATE_CHILDREN', 'elk.spacing.nodeNode': '16' } : {}),
          },
          children: [],
        }
      : n.summary ? { id: n.node.id, width: TILE_W, height: TILE_H } : { id: n.node.id, width: CARD_W, height: CARD_H };
    elkNodes.set(n.node.id, e);
  }
  for (const n of v.nodes) {
    const list = kids.get(n.parent) ?? [];
    list.push(elkNodes.get(n.node.id)!);
    kids.set(n.parent, list);
  }
  for (const [p, list] of kids) if (p) elkNodes.get(p)!.children = list;

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': view === 'apps' ? 'RIGHT' : 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '72',
      'elk.spacing.nodeNode': '28',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children: kids.get(undefined) ?? [],
    edges: topLevelEdges(v),
  };

  let out: ElkNode;
  try {
    out = await engine().layout(graph);
  } catch {
    // Rectpacking groups can't take part in a cross-hierarchy layered run on some graphs; retry plainly.
    for (const n of elkNodes.values()) if (n.layoutOptions) delete n.layoutOptions['elk.algorithm'];
    out = await engine().layout(graph);
  }

  const placed = new Map<string, Placed>();
  const walk = (n: ElkNode, parent?: string) => {
    for (const c of n.children ?? []) {
      placed.set(c.id, { id: c.id, x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? CARD_W, height: c.height ?? CARD_H, parent });
      walk(c, c.id);
    }
  };
  walk(out);
  return placed;
}
