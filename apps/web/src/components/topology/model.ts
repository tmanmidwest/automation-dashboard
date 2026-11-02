import type { PostureFinding, PostureSeverity, TopoEdge, TopoNode, TopoNodeType, TopoStatus, TopologyGraph } from '@cerebro/shared';
import { isUnknownHost, TYPE_LABEL } from './meta';

/**
 * Turns the server's one big graph into what the overview page shows: lanes of tiles,
 * what each tile contains (for the row that opens under it), counts, and "reached from".
 *
 * Items are real graph nodes, or virtual groups (an app entry point, a VLAN's unknown
 * addresses, a needs-attention bucket) whose ids start with "grp:".
 */

export type Tone = 'plain' | 'down' | 'warn' | 'exposed' | 'unknown' | 'allow';

export interface Chip {
  text: string;
  tone: Tone;
}

export interface Item {
  id: string;
  label: string;
  sub: string;
  status: TopoStatus;
  /** The graph node, when the item is one. */
  node?: TopoNode;
  /** Icon / type for virtual groups. */
  type: TopoNodeType | 'group';
}

export interface Lane {
  key: 'edge' | 'networks' | 'compute' | 'apps';
  title: string;
  sub: string;
  items: Item[];
}

export interface Attention {
  id: string;
  count: number;
  title: string;
  sub: string;
  tone: Tone;
}

const RANK: Partial<Record<TopoNodeType, number>> = { internet: 0, gateway: 1, switch: 2, ap: 3 };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byLabel = (a: { label: string }, b: { label: string }) => collator.compare(a.label, b.label);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isVm = (n: TopoNode) => n.roles.includes('VM') || n.roles.includes('LXC');

/** "VLAN44-DMZ" before "VLAN104"; the untagged "Default" first. */
function networkOrder(a: TopoNode, b: TopoNode): number {
  const v = (n: TopoNode) => {
    if (/^default$/i.test(n.label)) return -1;
    const m = /vlan\s*(\d+)/i.exec(n.label) ?? /(\d+)/.exec(n.label);
    return m ? Number(m[1]) : 1e9;
  };
  return v(a) - v(b) || byLabel(a, b);
}

/** A detail value from any source, e.g. "Vendor". */
export function detailOf(n: TopoNode, label: string): string | undefined {
  for (const d of n.details) for (const i of d.items) if (i.label === label) return i.value;
  return undefined;
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

export class TopoModel {
  readonly byId: Map<string, TopoNode>;
  private kids = new Map<string, TopoNode[]>();
  private inc = new Map<string, TopoEdge[]>();
  private out = new Map<string, TopoEdge[]>();
  /** Public hostnames (NPM, Cloudflare) and internal DNS names landing on a node or inside it. */
  private publicAt = new Map<string, Set<string>>();
  private internalAt = new Map<string, Set<string>>();
  /** Internet port forwards landing on a node or inside it. */
  private forwardsAt = new Map<string, TopoEdge[]>();
  /** Where each hostname ends up (proxy, then target). */
  readonly endpoints = new Map<string, string[]>();
  private laneIds = new Set<string>();
  private virtual = new Map<string, { item: Item; members: () => Item[] }>();
  readonly lanes: Lane[];

  constructor(readonly graph: TopologyGraph, readonly showClients: boolean) {
    this.byId = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const n of graph.nodes) {
      if (!n.parent) continue;
      if (!this.kids.has(n.parent)) this.kids.set(n.parent, []);
      this.kids.get(n.parent)!.push(n);
    }
    for (const e of graph.edges) {
      if (!this.out.has(e.source)) this.out.set(e.source, []);
      this.out.get(e.source)!.push(e);
      if (!this.inc.has(e.target)) this.inc.set(e.target, []);
      this.inc.get(e.target)!.push(e);
    }
    this.indexExposure();
    this.lanes = this.buildLanes();
    for (const l of this.lanes) for (const i of l.items) this.laneIds.add(i.id);
  }

  // ---- basics -------------------------------------------------------------

  private ancestors(id: string): string[] {
    const out: string[] = [];
    let p = this.byId.get(id)?.parent;
    while (p && !out.includes(p)) { out.push(p); p = this.byId.get(p)?.parent; }
    return out;
  }

  /** Shown on the overview: infrastructure, or every client when the toggle is on. */
  private visible(n: TopoNode): boolean {
    return n.infra || this.showClients;
  }

  private descendants(id: string): TopoNode[] {
    const out: TopoNode[] = [];
    const walk = (p: string) => (this.kids.get(p) ?? []).forEach((k) => { out.push(k); walk(k.id); });
    walk(id);
    return out;
  }

  private indexExposure() {
    const add = (map: Map<string, Set<string>>, at: string, name: string) => {
      for (const id of [at, ...this.ancestors(at)]) {
        if (!map.has(id)) map.set(id, new Set());
        map.get(id)!.add(name);
      }
    };
    for (const d of this.graph.nodes) {
      if (d.type !== 'dns_name') continue;
      const ends: string[] = [];
      for (const e of this.out.get(d.id) ?? []) {
        if (e.type === 'resolves' && e.label === 'served by NPM') {
          ends.push(e.target);
          for (const f of this.out.get(e.target) ?? []) {
            if (f.type === 'forwards' && f.label?.startsWith(`${d.label} →`)) ends.push(f.target);
          }
        } else if (e.type === 'resolves' || e.type === 'forwards') {
          ends.push(e.target);
        }
      }
      this.endpoints.set(d.id, ends);
      const isPublic = d.roles.includes('NPM proxy host') || d.roles.includes('Cloudflare tunnel');
      for (const t of ends) add(isPublic ? this.publicAt : this.internalAt, t, d.id);
    }
    for (const e of this.out.get('internet') ?? []) {
      if (e.type !== 'forwards') continue;
      for (const id of [e.target, ...this.ancestors(e.target)]) {
        if (!this.forwardsAt.has(id)) this.forwardsAt.set(id, []);
        this.forwardsAt.get(id)!.push(e);
      }
    }
  }

  private exposedCount(id: string): number {
    return (this.publicAt.get(id)?.size ?? 0) + (this.forwardsAt.get(id)?.length ?? 0);
  }

  /** Containers read as "stack / service" outside their own stack. */
  nameOf(n: TopoNode): string {
    if (n.type === 'container' && n.parent) return `${this.byId.get(n.parent)?.label ?? ''} / ${n.label}`;
    return n.label;
  }

  // ---- items --------------------------------------------------------------

  asItem(n: TopoNode, sub?: string): Item {
    return { id: n.id, label: n.label, sub: sub ?? this.subFor(n), status: this.rollup(n), node: n, type: n.type };
  }

  item(id: string): Item | undefined {
    const v = this.virtual.get(id);
    if (v) return v.item;
    const n = this.byId.get(id);
    return n ? this.asItem(n) : undefined;
  }

  /** A group's dot turns amber when something inside it is down. */
  private rollup(n: TopoNode): TopoStatus {
    if (n.status === 'down' || !['network', 'host', 'pve_node', 'stack'].includes(n.type)) return n.status;
    const inside = n.type === 'pve_node' ? this.vmsOf(n.id) : this.descendants(n.id);
    if (inside.some((k) => this.visible(k) && (k.status === 'down' || k.status === 'warn'))) return 'warn';
    return n.status;
  }

  private vmsOf(id: string): TopoNode[] {
    return (this.inc.get(id) ?? []).filter((e) => e.type === 'runs_on').map((e) => this.byId.get(e.source)).filter((n): n is TopoNode => !!n);
  }

  private subFor(n: TopoNode): string {
    switch (n.type) {
      case 'internet': {
        const pf = (this.out.get('internet') ?? []).filter((e) => e.type === 'forwards').length;
        const tun = (this.out.get('internet') ?? []).filter((e) => e.type === 'resolves').length;
        return [pf && plural(pf, 'port forward'), tun && plural(tun, 'tunnel name')].filter(Boolean).join(' · ') || 'Nothing forwarded in';
      }
      case 'network':
        return n.sublabel ?? n.id.replace(/^net:/, '');
      case 'dns_name': {
        const ends = this.endpoints.get(n.id) ?? [];
        const last = ends[ends.length - 1];
        const ln = this.byId.get(last);
        return last ? `→ ${ln ? this.nameOf(ln) : last}` : n.roles.join(' · ');
      }
      case 'stack':
        return plural((this.kids.get(n.id) ?? []).length, 'container');
      default: {
        if (isUnknownHost(n)) return 'Not seen by any connector';
        // Roles say what a server is; for a plain client, its type (or who made it) says more than "Host".
        const what = n.roles.filter((r) => r !== 'Fabric agent').join(' · ') || n.deviceType?.name || detailOf(n, 'Vendor') || (n.type === 'host' ? '' : TYPE_LABEL[n.type]);
        const bits = [n.ips[0], what].filter(Boolean);
        return n.sublabel && !n.ips[0] ? n.sublabel : bits.join(' · ');
      }
    }
  }

  // ---- lanes --------------------------------------------------------------

  private group(id: string, label: string, sub: string, members: () => Item[], status: TopoStatus = 'ok'): Item {
    const item: Item = { id, label, sub, status, type: 'group' };
    this.virtual.set(id, { item, members });
    return item;
  }

  private buildLanes(): Lane[] {
    const nodes = this.graph.nodes;
    const edge = nodes
      .filter((n) => RANK[n.type] !== undefined)
      .sort((a, b) => RANK[a.type]! - RANK[b.type]! || byLabel(a, b))
      .map((n) => this.asItem(n));

    const networks = nodes.filter((n) => n.type === 'network').sort(networkOrder).map((n) => this.asItem(n));

    const compute = new Map<string, TopoNode>();
    for (const n of nodes) {
      if (n.type === 'pve_node') compute.set(n.id, n);
      else if (n.type === 'host' && (n.roles.includes('Docker host') || (this.kids.get(n.id) ?? []).some((k) => k.type === 'stack'))) compute.set(n.id, n);
      else if (n.type === 'host' && n.roles.some((r) => /server|proxy/i.test(r))) compute.set(n.id, n);
    }
    const computeItems = [...compute.values()]
      .sort((a, b) => (a.type === 'pve_node' ? 0 : 1) - (b.type === 'pve_node' ? 0 : 1) || byLabel(a, b))
      .map((n) => this.asItem(n));

    // Apps: hostnames grouped by how they come in.
    const dns = nodes.filter((n) => n.type === 'dns_name');
    const viaProxy = new Map<string, TopoNode[]>();
    const tunnel: TopoNode[] = [];
    const internal: TopoNode[] = [];
    for (const d of dns) {
      const proxy = (this.out.get(d.id) ?? []).find((e) => e.type === 'resolves' && e.label === 'served by NPM')?.target;
      if (proxy) {
        if (!viaProxy.has(proxy)) viaProxy.set(proxy, []);
        viaProxy.get(proxy)!.push(d);
      } else if (d.roles.includes('Cloudflare tunnel')) tunnel.push(d);
      else internal.push(d);
    }
    const names = (list: TopoNode[]) => () => [...list].sort(byLabel).map((d) => this.asItem(d));
    const apps: Item[] = [];
    for (const [proxy, list] of viaProxy) {
      const p = this.byId.get(proxy);
      const host = p?.type === 'container' ? this.ancestors(proxy).map((a) => this.byId.get(a)).find((a) => a?.type === 'host') : p;
      apps.push(this.group(`grp:apps:proxy:${proxy}`, 'Via Nginx Proxy Manager', host ? `Runs on ${host.label}` : (p?.label ?? proxy), names(list)));
    }
    if (tunnel.length) apps.push(this.group('grp:apps:tunnel', 'Via Cloudflare tunnel', 'Public names, no open port', names(tunnel)));
    const pf = (this.out.get('internet') ?? []).filter((e) => e.type === 'forwards');
    if (pf.length) {
      apps.push(this.group('grp:apps:pf', 'Direct port forwards', 'Router forwards straight to a machine', () =>
        pf.map((e) => { const t = this.byId.get(e.target); return t ? this.asItem(t, e.label ?? '') : undefined; }).filter((i): i is Item => !!i)));
    }
    if (internal.length) apps.push(this.group('grp:apps:dns', 'Internal DNS only', 'Technitium records, LAN only', names(internal)));

    // Needs-attention buckets (virtual, opened like any tile).
    const infraNodes = nodes.filter((n) => n.infra && !isUnknownHost(n) && n.type !== 'dns_name');
    const down = infraNodes.filter((n) => n.status === 'down');
    const warn = infraNodes.filter((n) => n.status === 'warn');
    const unknown = nodes.filter(isUnknownHost);
    const publicNames = dns.filter((d) => d.roles.includes('NPM proxy host') || d.roles.includes('Cloudflare tunnel'));
    this.group('grp:attn:down', 'Down', 'Machines and services reporting down', () => down.sort(byLabel).map((n) => this.asItem(n)), 'down');
    this.group('grp:attn:warn', 'Warnings', 'Unhealthy, updates, partial', () => warn.sort(byLabel).map((n) => this.asItem(n)), 'warn');
    this.group('grp:attn:exposed', 'Exposed to the internet', 'Public hostnames and port forwards', () => [
      ...publicNames.sort(byLabel).map((d) => this.asItem(d)),
      ...pf.map((e) => { const t = this.byId.get(e.target); return t ? this.asItem(t, `Port forward ${e.label ?? ''}`) : undefined; }).filter((i): i is Item => !!i),
    ]);
    this.group('grp:attn:unknown', 'Unknown addresses', 'Named in a rule or proxy, seen by nothing', () => unknown.sort((a, b) => collator.compare(a.label, b.label)).map((n) => this.asItem(n)), 'unknown');
    this.attentionCounts = { down: down.length, warn: warn.length, exposed: publicNames.length + pf.length, unknown: unknown.length };

    return [
      { key: 'edge', title: 'Edge', sub: 'Internet, gateway, switching and Wi-Fi', items: edge },
      { key: 'networks', title: 'Networks', sub: 'One tile per VLAN', items: networks },
      { key: 'compute', title: 'Compute', sub: 'Hypervisors, Docker hosts and servers', items: computeItems },
      { key: 'apps', title: 'Apps', sub: 'How names reach your services', items: apps },
    ];
  }

  private attentionCounts = { down: 0, warn: 0, exposed: 0, unknown: 0 };

  attention(): Attention[] {
    const c = this.attentionCounts;
    return [
      { id: 'grp:attn:down', count: c.down, title: 'Down', sub: c.down ? 'Click to see which' : 'Nothing down', tone: 'down' },
      { id: 'grp:attn:warn', count: c.warn, title: 'Warnings', sub: c.warn ? 'Unhealthy or needs updates' : 'No warnings', tone: 'warn' },
      { id: 'grp:attn:exposed', count: c.exposed, title: 'Exposed to the internet', sub: 'Public names and port forwards', tone: 'exposed' },
      { id: 'grp:attn:unknown', count: c.unknown, title: 'Unknown addresses', sub: 'Named in rules, seen by nothing', tone: 'unknown' },
    ];
  }

  // ---- what a tile holds -------------------------------------------------

  children(id: string): Item[] {
    const v = this.virtual.get(id);
    if (v) return v.members();
    const n = this.byId.get(id);
    if (!n) return [];
    const nodesOf = (list: (TopoNode | undefined)[]) => list.filter((x): x is TopoNode => !!x);
    switch (n.type) {
      case 'internet': {
        const out = this.out.get('internet') ?? [];
        return [
          ...out.filter((e) => e.type === 'forwards').map((e) => { const t = this.byId.get(e.target); return t && this.asItem(t, `Port forward ${e.label ?? ''}`); }),
          ...out.filter((e) => e.type === 'resolves').map((e) => { const t = this.byId.get(e.target); return t && this.asItem(t, `Cloudflare ${e.label ?? 'tunnel'}`); }),
        ].filter((i): i is Item => !!i);
      }
      case 'gateway':
        return nodesOf((this.out.get(id) ?? []).filter((e) => e.type === 'routes').map((e) => this.byId.get(e.target))).sort(networkOrder).map((k) => this.asItem(k));
      case 'switch':
      case 'ap': {
        // Everything plugged in or associated, phones and IoT included: that's what an AP or switch is for,
        // so the "Phones & IoT clients" toggle doesn't hide them here.
        const down = nodesOf((this.inc.get(id) ?? []).filter((e) => e.type === 'uplink').map((e) => this.byId.get(e.source)));
        return down.sort((a, b) => (RANK[a.type] ?? 9) - (RANK[b.type] ?? 9) || byLabel(a, b)).map((k) => this.asItem(k, (this.inc.get(id) ?? []).find((e) => e.source === k.id)?.label ?? undefined));
      }
      case 'network': {
        const members = (this.kids.get(id) ?? []).filter((k) => this.visible(k));
        const known = members.filter((k) => !isUnknownHost(k)).sort(byLabel).map((k) => this.asItem(k));
        const unknown = members.filter(isUnknownHost);
        if (unknown.length) {
          known.push(this.group(`grp:unknown:${id}`, plural(unknown.length, 'unknown address', 'unknown addresses'), 'Named in a rule or proxy, seen by nothing',
            () => unknown.sort((a, b) => collator.compare(a.label, b.label)).map((k) => this.asItem(k)), 'unknown'));
        }
        return known;
      }
      case 'pve_node':
      case 'host': {
        const vms = this.vmsOf(id).sort(byLabel).map((k) => this.asItem(k));
        const stacks = (this.kids.get(id) ?? []).filter((k) => k.type === 'stack').sort(byLabel).map((k) => this.asItem(k));
        return [...vms, ...stacks];
      }
      case 'stack':
        return (this.kids.get(id) ?? []).sort(byLabel).map((k) => this.asItem(k));
      default:
        return [];
    }
  }

  /** Counts shown on a tile and at the top of its open row. */
  summary(id: string): Chip[] {
    const chips: Chip[] = [];
    const v = this.virtual.get(id);
    if (v) {
      const m = v.members();
      const unit = id.startsWith('grp:apps') ? (id === 'grp:apps:pf' ? 'forward' : 'hostname') : id.startsWith('grp:unknown') ? 'address' : 'item';
      chips.push({ text: plural(m.length, unit, unit === 'address' ? 'addresses' : `${unit}s`), tone: id.startsWith('grp:apps') && id !== 'grp:apps:dns' ? 'exposed' : 'plain' });
      return chips;
    }
    const n = this.byId.get(id);
    if (!n) return chips;
    const issues = (list: TopoNode[]) => {
      const d = list.filter((k) => k.status === 'down').length;
      const w = list.filter((k) => k.status === 'warn').length;
      if (d) chips.push({ text: `${d} down`, tone: 'down' });
      if (w) chips.push({ text: plural(w, 'warning'), tone: 'warn' });
    };
    const exposed = this.exposedCount(id);
    switch (n.type) {
      case 'internet': {
        const pf = (this.out.get('internet') ?? []).filter((e) => e.type === 'forwards').length;
        if (pf) chips.push({ text: plural(pf, 'port forward'), tone: 'exposed' });
        const ips = n.details.flatMap((d) => d.items).find((i) => i.label === 'IPS deny-list rules');
        if (ips) chips.push({ text: ips.value, tone: 'plain' });
        break;
      }
      case 'gateway': {
        const nets = (this.out.get(id) ?? []).filter((e) => e.type === 'routes').length;
        if (nets) chips.push({ text: plural(nets, 'network'), tone: 'plain' });
        break;
      }
      case 'switch':
      case 'ap': {
        const c = (this.inc.get(id) ?? []).filter((e) => e.type === 'uplink' && this.byId.get(e.source)).length;
        chips.push({ text: `${c} connected`, tone: 'plain' });
        break;
      }
      case 'network': {
        const members = (this.kids.get(id) ?? []).filter((k) => this.visible(k));
        const known = members.filter((k) => !isUnknownHost(k));
        chips.push({ text: plural(known.length, 'machine'), tone: 'plain' });
        issues(known);
        if (exposed) chips.push({ text: `${exposed} exposed`, tone: 'exposed' });
        const unk = members.length - known.length;
        if (unk) chips.push({ text: `${unk} unknown`, tone: 'unknown' });
        const hidden = (this.kids.get(id) ?? []).filter((k) => !k.infra).length;
        if (hidden && !this.showClients) chips.push({ text: `${hidden} clients hidden`, tone: 'unknown' });
        break;
      }
      case 'pve_node': {
        const vms = this.vmsOf(id);
        chips.push({ text: plural(vms.length, 'VM'), tone: 'plain' });
        const off = vms.filter((k) => k.status === 'off' || k.status === 'down').length;
        if (off) chips.push({ text: `${off} stopped`, tone: 'down' });
        break;
      }
      case 'host': {
        const stacks = (this.kids.get(id) ?? []).filter((k) => k.type === 'stack');
        const ctrs = this.descendants(id).filter((k) => k.type === 'container');
        if (stacks.length) chips.push({ text: plural(stacks.length, 'stack'), tone: 'plain' });
        if (ctrs.length) chips.push({ text: plural(ctrs.length, 'container'), tone: 'plain' });
        issues(ctrs);
        if (!stacks.length && isVm(n)) chips.push({ text: n.statusText ?? n.status, tone: n.status === 'ok' ? 'plain' : 'down' });
        if (exposed) chips.push({ text: `${exposed} exposed`, tone: 'exposed' });
        break;
      }
      case 'stack': {
        const ctrs = this.kids.get(id) ?? [];
        chips.push({ text: plural(ctrs.length, 'container'), tone: 'plain' });
        issues(ctrs);
        if (exposed) chips.push({ text: `${exposed} exposed`, tone: 'exposed' });
        break;
      }
      case 'container':
        if (n.statusText) chips.push({ text: n.statusText, tone: n.status === 'ok' ? 'plain' : n.status === 'warn' ? 'warn' : 'down' });
        if (exposed) chips.push({ text: `${exposed} exposed`, tone: 'exposed' });
        break;
      case 'dns_name':
        chips.push({ text: n.roles.includes('DNS record') && n.roles.length === 1 ? 'internal' : 'public', tone: n.roles.length === 1 && n.roles[0] === 'DNS record' ? 'plain' : 'exposed' });
        break;
    }
    return chips;
  }

  /** What reaches this thing from outside it: forwards, names, firewall rules. */
  reach(id: string): Chip[] {
    const n = this.byId.get(id);
    if (!n) return [];
    const inside = new Set([id, ...this.descendants(id).map((d) => d.id)]);
    const out: Chip[] = [];
    const seen = new Set<string>();
    const push = (key: string, c: Chip) => { if (!seen.has(key)) { seen.add(key); out.push(c); } };
    for (const e of this.forwardsAt.get(id) ?? []) {
      const t = this.byId.get(e.target);
      push(`pf:${e.id}`, { text: `Internet ${e.label ?? ''}${t && t.id !== id ? ` → ${this.nameOf(t)}` : ''}`.trim(), tone: 'exposed' });
    }
    const pub = this.publicAt.get(id)?.size ?? 0;
    const int = this.internalAt.get(id)?.size ?? 0;
    if (pub) push('pub', { text: plural(pub, 'public hostname'), tone: 'exposed' });
    if (int) push('int', { text: plural(int, 'internal DNS name'), tone: 'plain' });
    for (const m of inside) {
      for (const e of this.inc.get(m) ?? []) {
        if ((e.type !== 'fw_allow' && e.type !== 'fw_block') || inside.has(e.source)) continue;
        const s = this.byId.get(e.source);
        if (!s) continue;
        push(`${e.type}:${s.id}`, { text: `${s.label}: ${e.type === 'fw_allow' ? 'allowed' : 'blocked'}`, tone: e.type === 'fw_allow' ? 'allow' : 'down' });
      }
    }
    return out;
  }

  /** What it hangs off: the switch port or AP it's connected through, the hypervisor it runs on. */
  via(id: string): Chip[] {
    const out: Chip[] = [];
    for (const e of this.out.get(id) ?? []) {
      const t = this.byId.get(e.target);
      if (!t) continue;
      if (e.type === 'runs_on') out.push({ text: `Runs on ${t.label}`, tone: 'plain' });
      if (e.type === 'uplink') out.push({ text: e.label === 'Wi-Fi' ? `${t.label} (Wi-Fi)` : `${t.label}${e.label ? ` ${e.label}` : ''}`, tone: 'plain' });
    }
    return out;
  }

  /** Tile → … → node, so search and links can open the right row at the right depth. */
  pathTo(id: string): string[] {
    if (this.laneIds.has(id)) return [id];
    const n = this.byId.get(id);
    if (!n) return this.virtual.has(id) ? [id] : [];
    if (n.type === 'dns_name') {
      const grp = this.lanes.find((l) => l.key === 'apps')?.items.find((g) => this.children(g.id).some((c) => c.id === id));
      return grp ? [grp.id, id] : [id];
    }
    if (isUnknownHost(n) && n.parent) return [n.parent, `grp:unknown:${n.parent}`, id];
    const chain = [id, ...this.ancestors(id)];
    const top = chain.findIndex((c) => this.laneIds.has(c));
    if (top >= 0) return chain.slice(0, top + 1).reverse();
    const pve = (this.out.get(id) ?? []).find((e) => e.type === 'runs_on')?.target;
    if (pve && this.laneIds.has(pve)) return [pve, id];
    return [id];
  }

  // ---- posture findings ---------------------------------------------------

  private findingsAt: Map<string, PostureFinding[]> | null = null;

  /** Open (not snoozed) findings about an item, or anything inside it. Worst first. */
  findingsFor(id: string): PostureFinding[] {
    if (!this.findingsAt) {
      const at = new Map<string, PostureFinding[]>();
      for (const f of this.graph.findings ?? []) {
        if (f.snoozedUntil) continue;
        const on = new Set<string>();
        for (const nid of [...f.affected.map((a) => a.nodeId), ...(f.alsoOn ?? [])]) {
          if (!nid || !this.byId.has(nid)) continue;
          const under = new Set([nid, ...this.pathTo(nid), ...this.ancestors(nid)]);
          if (f.affected.some((a) => a.nodeId === nid)) for (const x of under) this.hereCount.set(`${x}\u0000${f.id}`, (this.hereCount.get(`${x}\u0000${f.id}`) ?? 0) + 1);
          for (const x of under) on.add(x);
        }
        for (const x of on) {
          if (!at.has(x)) at.set(x, []);
          at.get(x)!.push(f);
        }
      }
      this.findingsAt = at;
    }
    return this.findingsAt.get(id) ?? [];
  }

  private hereCount = new Map<string, number>();

  /** How many of a finding's affected items sit in this item (0 when it is only badged via alsoOn). */
  affectedIn(id: string, f: PostureFinding): number {
    this.findingsFor(id);
    return this.hereCount.get(`${id}\u0000${f.id}`) ?? 0;
  }

  /** The tile badge: worst severity and how many findings have it. */
  worst(id: string): { severity: PostureSeverity; count: number; total: number } | null {
    const fs = this.findingsFor(id);
    if (!fs.length) return null;
    const severity = (['high', 'medium', 'low'] as const).find((s) => fs.some((f) => f.severity === s))!;
    return { severity, count: fs.filter((f) => f.severity === severity).length, total: fs.length };
  }

  /** The lane a top-level tile sits in (virtual attention groups have none). */
  laneOf(id: string): Lane['key'] | undefined {
    return this.lanes.find((l) => l.items.some((i) => i.id === id))?.key;
  }
}
