import type { TopoEdge, TopoEdgeType, TopoNode, TopologyGraph } from '@cerebro/shared';

/**
 * Turns the server's one big graph into what a single map view shows: which nodes,
 * which ones nest inside which (groups), and which links — with links to hidden or
 * collapsed nodes re-pointed at the nearest visible ancestor.
 */

export type MapView = 'network' | 'compute' | 'apps';

export interface ViewOptions {
  /** Show phones / IoT / other plain clients (network view). */
  showClients: boolean;
  /** Draw firewall allow / block links (network view). */
  showFirewall: boolean;
  /** Show addresses no connector knows (network view); otherwise they're only counted. */
  showUnknown: boolean;
  /** Group ids the user collapsed (or, for default-collapsed groups, expanded). */
  toggled: Set<string>;
  /** Drill-in: only this group, its contents and what links to them. */
  focus?: string | null;
}

export interface VNode {
  node: TopoNode;
  parent?: string;
  isGroup: boolean;
  collapsed: boolean;
  /** Visible + hidden descendants, for the collapsed badge. */
  childCount: number;
  /** Faded context node around a drill-in. */
  context?: boolean;
  /** Roll-up for a collapsed group's tile. */
  summary?: GroupSummary;
}

export interface GroupSummary {
  machines: number;
  down: number;
  warn: number;
  /** Reachable from the Internet (port forward / tunnel / proxy target). */
  exposed: number;
  /** Addresses inside it that no connector knows. */
  unknown: number;
}

/** One row of the side tree: every member of the view, collapsed or not. */
export interface TreeItem {
  node: TopoNode;
  parent?: string;
  depth: number;
}

export interface VEdge {
  id: string;
  source: string;
  target: string;
  type: TopoEdgeType;
  label?: string;
  notes: string[];
}

export interface ViewResult {
  nodes: VNode[];
  edges: VEdge[];
  /** Links not drawn by default (firewall layer off): shown only for the selected node. */
  extraEdges: VEdge[];
  /** Everything in the view as a tree (parents before children), for the side panel. */
  tree: TreeItem[];
}

export const VIEW_LABEL: Record<MapView, string> = { network: 'Network', compute: 'Compute', apps: 'Apps & ingress' };

/**
 * Groups that start collapsed until the user opens them: the overview shows each VLAN /
 * Docker host / stack as one summary tile, and you open the one you care about.
 */
export function collapsedByDefault(view: MapView, n: TopoNode): boolean {
  if (view === 'network') return n.type === 'network';
  if (view === 'compute') return n.type === 'stack' || n.type === 'host';
  return false;
}

/** No connector reported it: only a proxy, port forward or firewall rule named the address. */
export const isUnknown = (n: TopoNode) => n.type === 'host' && n.sources.length === 0;

const isVm = (n: TopoNode) => n.roles.includes('VM') || n.roles.includes('LXC');
const isDockerHost = (n: TopoNode) => n.roles.includes('Docker host');

/** Which nodes a view includes, and each one's parent inside that view. */
function membership(view: MapView, g: TopologyGraph, opts: ViewOptions): Map<string, string | undefined> {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out = new Map<string, string | undefined>();
  if (view === 'network') {
    for (const n of g.nodes) {
      if (['internet', 'gateway', 'switch', 'ap', 'network'].includes(n.type)) out.set(n.id, undefined);
      else if ((n.type === 'host' || n.type === 'pve_node') && (n.infra || opts.showClients) && (opts.showUnknown || !isUnknown(n))) {
        out.set(n.id, n.parent && byId.get(n.parent)?.type === 'network' ? n.parent : undefined);
      }
    }
  } else if (view === 'compute') {
    for (const n of g.nodes) {
      if (n.type === 'pve_node') out.set(n.id, undefined);
      else if (n.type === 'host' && (isVm(n) || isDockerHost(n))) out.set(n.id, undefined);
      else if (n.type === 'stack' || n.type === 'container') out.set(n.id, n.parent);
    }
  } else {
    // Apps: everything on an ingress path — names, the proxies they hit, and the targets.
    const keep = new Set<string>(['internet']);
    for (const e of g.edges) {
      if (e.type === 'resolves' || e.type === 'forwards') { keep.add(e.source); keep.add(e.target); }
    }
    for (const id of keep) if (byId.has(id)) out.set(id, undefined);
  }
  return out;
}

export function buildView(view: MapView, g: TopologyGraph, opts: ViewOptions): ViewResult {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const member = membership(view, g, opts);

  const children = new Map<string, string[]>();
  for (const [id, p] of member) {
    if (p && member.has(p)) {
      if (!children.has(p)) children.set(p, []);
      children.get(p)!.push(id);
    }
  }
  const parentOf = (id: string) => {
    const p = member.get(id);
    return p && member.has(p) ? p : undefined;
  };
  const isCollapsed = (id: string) => {
    const n = byId.get(id)!;
    const def = collapsedByDefault(view, n);
    return opts.toggled.has(id) ? !def : def;
  };
  const countDesc = (id: string): number => (children.get(id) ?? []).reduce((s, c) => s + 1 + countDesc(c), 0);

  // A node is shown unless an ancestor is collapsed.
  const hiddenByCollapse = (id: string): boolean => {
    let p = parentOf(id);
    while (p) {
      if (children.has(p) && isCollapsed(p)) return true;
      p = parentOf(p);
    }
    return false;
  };
  /** Nearest shown node for an id in this view (itself, or the collapsed group holding it). */
  const shownFor = (id: string): string | undefined => {
    if (!member.has(id)) {
      // Not in this view: climb the graph's own parents (container → stack → host…).
      let p = byId.get(id)?.parent;
      while (p && !member.has(p)) p = byId.get(p)?.parent;
      if (!p) return undefined;
      id = p;
    }
    let cur: string | undefined = id;
    let shown: string = id;
    while (cur) {
      const parent = parentOf(cur);
      if (parent && isCollapsed(parent)) shown = parent;
      cur = parent;
    }
    return shown;
  };

  let visible = [...member.keys()].filter((id) => !hiddenByCollapse(id));

  // Edges for this view.
  const edgeTypes: Record<MapView, TopoEdgeType[]> = {
    network: ['uplink', 'routes', 'forwards', 'fw_allow', 'fw_block'],
    compute: ['runs_on'],
    apps: ['resolves', 'forwards'],
  };
  const allowed = new Set(edgeTypes[view]);
  const edges = new Map<string, VEdge>();
  const extra = new Map<string, VEdge>();
  const addEdge = (e: TopoEdge) => {
    if (!allowed.has(e.type)) return;
    // Network view: host → switch-port uplinks are drawer-only (they'd criss-cross every VLAN box).
    if (view === 'network' && e.type === 'uplink') {
      const s = byId.get(e.source)?.type;
      if (s === 'host' || s === 'pve_node') return;
    }
    // Network view: internet exposure is drawn from port forwards only; proxy hops live in Apps.
    if (view === 'network' && e.type === 'forwards' && e.source !== 'internet') return;
    // Uplinks and runs-on point child → parent in the data; draw them parent → child so
    // the layered layout reads top-down (Internet → gateway → switch → AP, node → VMs).
    const flip = e.type === 'uplink' || e.type === 'runs_on';
    const s = shownFor(flip ? e.target : e.source);
    const t = shownFor(flip ? e.source : e.target);
    if (!s || !t || s === t) return;
    // Firewall links are many: with the layer off they're kept aside (drawn only for the
    // selected node, and never fed to the layout).
    const bucket = (e.type === 'fw_allow' || e.type === 'fw_block') && !opts.showFirewall ? extra : edges;
    const id = `${e.type}:${s}>${t}`;
    const prev = bucket.get(id);
    if (prev) {
      for (const n of e.notes ?? []) if (!prev.notes.includes(n)) prev.notes.push(n);
      if (prev.label !== e.label) prev.label = undefined;
      return;
    }
    bucket.set(id, { id, source: s, target: t, type: e.type, label: e.label, notes: [...(e.notes ?? [])] });
  };
  for (const e of g.edges) addEdge(e);

  // Drill-in: the focused group, everything inside, and one hop of context.
  let context = new Set<string>();
  if (opts.focus && member.has(opts.focus)) {
    const inside = new Set<string>([opts.focus]);
    const walk = (id: string) => (children.get(id) ?? []).forEach((c) => { inside.add(c); walk(c); });
    walk(opts.focus);
    for (const e of edges.values()) {
      if (inside.has(e.source) && !inside.has(e.target)) context.add(e.target);
      if (inside.has(e.target) && !inside.has(e.source)) context.add(e.source);
    }
    // Context nodes are shown flat (outside their own groups).
    context = new Set([...context].filter((id) => !inside.has(id)));
    visible = visible.filter((id) => inside.has(id) || context.has(id));
  }
  const visibleSet = new Set(visible);

  const nodes: VNode[] = visible.map((id) => {
    const n = byId.get(id)!;
    const group = children.has(id);
    const p = parentOf(id);
    return {
      node: n,
      parent: context.has(id) ? undefined : p && visibleSet.has(p) ? p : undefined,
      isGroup: group && !isCollapsed(id),
      collapsed: group && isCollapsed(id),
      childCount: group ? countDesc(id) : 0,
      context: context.has(id) || undefined,
    };
  });
  // Tile roll-ups: count from the full graph so hidden clients / unknowns still show up.
  const exposedIds = new Set<string>();
  for (const e of g.edges) {
    if ((e.type === 'forwards' || e.type === 'resolves') && (e.source === 'internet' || byId.get(e.source)?.type === 'dns_name')) {
      let t: string | undefined = e.target;
      while (t) { exposedIds.add(t); t = byId.get(t)?.parent; }
    }
  }
  const graphKids = new Map<string, TopoNode[]>();
  for (const n of g.nodes) if (n.parent) { if (!graphKids.has(n.parent)) graphKids.set(n.parent, []); graphKids.get(n.parent)!.push(n); }
  const summarize = (id: string): GroupSummary => {
    const sum: GroupSummary = { machines: 0, down: 0, warn: 0, exposed: 0, unknown: 0 };
    const walk = (pid: string) => {
      for (const c of graphKids.get(pid) ?? []) {
        if (c.type === 'host' || c.type === 'pve_node' || c.type === 'container') {
          if (isUnknown(c)) sum.unknown++;
          else if (c.infra || opts.showClients || view !== 'network') sum.machines++;
          else continue;
          if (c.status === 'down') sum.down++;
          if (c.status === 'warn') sum.warn++;
          if (exposedIds.has(c.id) && (c.type !== 'container' || view !== 'network')) sum.exposed++;
        }
        walk(c.id);
      }
    };
    walk(id);
    return sum;
  };
  for (const v of nodes) if (v.collapsed || v.node.type === 'network') v.summary = summarize(v.node.id);

  // Empty network boxes (no hosts shown) read as clutter: show them as plain nodes.
  for (const v of nodes) if (v.isGroup && !nodes.some((c) => c.parent === v.node.id)) v.isGroup = false;

  return {
    nodes,
    edges: [...edges.values()].filter((e) => visibleSet.has(e.source) && visibleSet.has(e.target)),
    extraEdges: [...extra.values()].filter((e) => visibleSet.has(e.source) && visibleSet.has(e.target)),
    tree: buildTree(),
  };

  function buildTree(): TreeItem[] {
    const out: TreeItem[] = [];
    const roots = [...member.keys()].filter((id) => !parentOf(id));
    const order = (ids: string[]) => ids
      .map((id) => byId.get(id)!)
      .sort((a, b) => TREE_RANK[a.type] - TREE_RANK[b.type] || a.label.localeCompare(b.label, undefined, { numeric: true }));
    const walk = (ids: string[], depth: number, parent?: string) => {
      for (const n of order(ids)) {
        out.push({ node: n, parent, depth });
        walk(children.get(n.id) ?? [], depth + 1, n.id);
      }
    };
    walk(roots, 0);
    return out;
  }
}

const TREE_RANK: Record<TopoNode['type'], number> = {
  internet: 0, gateway: 1, switch: 2, ap: 3, pve_node: 4, network: 5, host: 6, stack: 7, container: 8, dns_name: 9, proxy: 10, port_forward: 11,
};

/** Which view to jump to so a search hit is on screen. */
export function viewFor(n: TopoNode): MapView {
  if (n.type === 'stack' || n.type === 'container') return 'compute';
  if (n.type === 'dns_name' || n.type === 'proxy' || n.type === 'port_forward') return 'apps';
  return 'network';
}

export function matches(n: TopoNode, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return false;
  return (
    n.label.toLowerCase().includes(s) ||
    (n.sublabel ?? '').toLowerCase().includes(s) ||
    n.ips.some((ip) => ip.startsWith(s)) ||
    n.macs.some((m) => m.includes(s)) ||
    n.roles.some((r) => r.toLowerCase().includes(s))
  );
}
