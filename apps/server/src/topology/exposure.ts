import type { ExposureEntry, ExposureFlag, ExposureHop, ExposurePath, PostureFinding, PostureSeverity, TopologyGraph, TopoNode } from '@cerebro/shared';

/**
 * Exposure paths: every way in from the internet (WAN port forwards, Cloudflare tunnels) and
 * everything each one reaches, hop by hop, with the posture findings on each hop. Built from
 * the map's own edges after the findings are computed, so it never disagrees with the map.
 * Pure; see docs/architecture-map.md#exposure-paths.
 */

const RANK: Record<PostureSeverity | 'none', number> = { high: 3, medium: 2, low: 1, none: 0 };
const worst = (xs: (PostureSeverity | 'none')[]): PostureSeverity | 'none' => xs.reduce<PostureSeverity | 'none'>((a, b) => (RANK[b] > RANK[a] ? b : a), 'none');

export function buildExposure(graph: TopologyGraph, findings: PostureFinding[], guards: Map<string, { lan: boolean; marked?: boolean; notes: string[] }> = new Map()): ExposureEntry[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const flagsOn = new Map<string, ExposureFlag[]>();
  for (const f of findings) {
    if (f.snoozedUntil) continue;
    for (const a of f.affected) {
      if (!a.nodeId) continue;
      const list = flagsOn.get(a.nodeId) ?? [];
      if (!list.some((x) => x.findingId === f.id)) list.push({ findingId: f.id, severity: f.severity, category: f.category, title: f.title });
      flagsOn.set(a.nodeId, list);
    }
  }
  /** Findings on a node plus what it runs on (stack, VM / host), but not the network it's on. */
  const flagsFor = (id: string): ExposureFlag[] => {
    const out = [...(flagsOn.get(id) ?? [])];
    const seen = new Set<string>([id]);
    let p = byId.get(id)?.parent;
    while (p && !seen.has(p)) {
      seen.add(p);
      const n = byId.get(p);
      if (!n || n.type === 'network') break;
      for (const f of flagsOn.get(p) ?? []) if (!out.some((x) => x.findingId === f.findingId)) out.push({ ...f, on: n.label });
      p = n.parent;
    }
    return out.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  };
  const hop = (id: string, via?: string): ExposureHop => ({ nodeId: id, label: byId.get(id)?.label ?? id, via, flags: flagsFor(id) });
  const ancestors = (id: string): string[] => {
    const out: string[] = [];
    let p = byId.get(id)?.parent;
    while (p && !out.includes(p)) { out.push(p); p = byId.get(p)?.parent; }
    return out;
  };
  const mkPath = (id: string, hops: ExposureHop[], notes?: string[], name?: string): ExposurePath => ({ id, hops, severity: worst(hops.flatMap((h) => h.flags.map((f) => f.severity))), notes: notes?.length ? notes : undefined, name });

  // NPM: public name → proxy ("served by NPM"), proxy → backend (labelled "name → :port").
  const servedBy = graph.edges.filter((e) => e.type === 'resolves' && e.label === 'served by NPM');
  const proxies = new Set(servedBy.map((e) => e.target));
  const proxyFor = (target: string): string | null => {
    if (proxies.has(target)) return target;
    // A forward to the proxy's host reaches the proxy container on it.
    for (const p of proxies) if (ancestors(p).includes(target)) return p;
    return null;
  };
  const backendsOf = (from: string, name: string) =>
    graph.edges.filter((e) => e.type === 'forwards' && e.source === from && (e.label ?? '').startsWith(`${name} →`));

  const entries: ExposureEntry[] = [];

  // 1. WAN port forwards, grouped by the machine they land on.
  const forwards = graph.edges.filter((e) => e.type === 'forwards' && e.source === 'internet');
  const byTarget = new Map<string, typeof forwards>();
  for (const e of forwards) byTarget.set(e.target, [...(byTarget.get(e.target) ?? []), e]);
  for (const [target, es] of byTarget) {
    const ports = [...new Set(es.flatMap((e) => [e.label ?? '', ...(e.notes ?? [])]).map((t) => /WAN :(\d+)/.exec(t)?.[1]).filter(Boolean) as string[])].sort((a, b) => Number(a) - Number(b));
    const notes = es.flatMap((e) => e.notes ?? []);
    const proxy = proxyFor(target);
    const paths: ExposurePath[] = [];
    const hidden: NonNullable<ExposureEntry['hidden']> = [];
    if (proxy) {
      const ph = hop(proxy);
      for (const e of servedBy.filter((x) => x.target === proxy)) {
        const name = byId.get(e.source);
        if (!name) continue;
        const g = guards.get(name.id);
        // LAN-only access list (or marked internal): internet requests are turned away, not a way in.
        if (g?.lan) { hidden.push({ name: name.label, reason: g.marked ? 'marked' : 'lan' }); continue; }
        const bes = backendsOf(proxy, name.label);
        if (!bes.length) paths.push(mkPath(`${target}>${name.id}`, [ph, hop(name.id)], g?.notes, name.label));
        for (const be of bes) paths.push(mkPath(`${target}>${name.id}>${be.target}`, [ph, hop(name.id), hop(be.target, be.label?.replace(/^.*?→\s*/, '→ '))], g?.notes, name.label));
      }
    } else {
      paths.push(mkPath(target, [hop(target, es[0].label?.replace(/^WAN :\S+\s*/, ''))]));
    }
    entries.push({
      id: `pf:${target}`,
      kind: 'port_forward',
      label: `WAN ${ports.map((p) => `:${p}`).join(', ')}`,
      nodeId: proxy ?? target,
      notes,
      paths: sortPaths(paths),
      severity: worst(paths.map((p) => p.severity)),
      hidden: hidden.length ? hidden : undefined,
    });
  }

  // 2. Cloudflare tunnels: internet → public name (label "tunnel X") → backend.
  const tunnelEdges = graph.edges.filter((e) => e.type === 'resolves' && e.source === 'internet' && (e.label ?? '').startsWith('tunnel '));
  const byTunnel = new Map<string, typeof tunnelEdges>();
  for (const e of tunnelEdges) byTunnel.set(e.label!, [...(byTunnel.get(e.label!) ?? []), e]);
  for (const [label, es] of byTunnel) {
    const paths: ExposurePath[] = [];
    const hidden: NonNullable<ExposureEntry['hidden']> = [];
    for (const e of es) {
      const nm = byId.get(e.target)?.label ?? e.target;
      if (guards.get(e.target)?.lan) { hidden.push({ name: nm, reason: 'marked' }); continue; }
      const bes = graph.edges.filter((x) => x.type === 'forwards' && x.source === e.target);
      if (!bes.length) paths.push(mkPath(`${label}>${e.target}`, [hop(e.target)], undefined, nm));
      for (const be of bes) paths.push(mkPath(`${label}>${e.target}>${be.target}`, [hop(e.target), hop(be.target, be.label ? `→ ${be.label}` : undefined)], undefined, nm));
    }
    entries.push({
      id: `tunnel:${label.slice(7)}`,
      kind: 'tunnel',
      label: `Cloudflare ${label}`,
      notes: [],
      paths: sortPaths(paths),
      severity: worst(paths.map((p) => p.severity)),
      hidden: hidden.length ? hidden : undefined,
    });
  }

  return entries.sort((a, b) => RANK[b.severity] - RANK[a.severity] || b.paths.length - a.paths.length);
}

function sortPaths(ps: ExposurePath[]): ExposurePath[] {
  return ps.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.hops.map((h) => h.label).join().localeCompare(b.hops.map((h) => h.label).join()));
}

/**
 * Combination findings: a path from the internet where problems of different kinds stack up
 * (say plain HTTP + an image with critical CVEs + an old backup). Each problem already has
 * its own finding; this one ranks the paths where they meet.
 */
export function comboFindings(entries: ExposureEntry[], byId: Map<string, TopoNode>): PostureFinding[] {
  type Hit = { entry: ExposureEntry; path: ExposurePath; flags: ExposureFlag[]; cats: Set<string> };
  const hits: Hit[] = [];
  for (const entry of entries)
    for (const path of entry.paths) {
      const flags: ExposureFlag[] = [];
      // The proxy every path of a forward goes through is shared; its own problems are its own
      // findings, so look at what's behind it.
      const hops = entry.kind === 'port_forward' && path.hops.length > 1 ? path.hops.slice(1) : path.hops;
      for (const h of hops) for (const f of h.flags) if (RANK[f.severity] >= 2 && !flags.some((x) => x.findingId === f.findingId)) flags.push(f);
      const cats = new Set(flags.map((f) => f.category));
      // Two or more kinds of Medium-or-worse problem on the same path.
      if (cats.size >= 2) hits.push({ entry, path, flags, cats });
    }
  if (!hits.length) return [];
  const sevOf = (h: Hit): PostureSeverity => (h.flags.some((f) => f.severity === 'high') || h.cats.size >= 3 ? 'high' : 'medium');
  hits.sort((a, b) => RANK[sevOf(b)] - RANK[sevOf(a)] || b.cats.size - a.cats.size);
  const CAT: Record<string, string> = { exposure: 'exposure', encryption: 'no encryption', backups: 'backups', patching: 'unpatched', hygiene: 'hygiene' };
  const last = (p: ExposurePath) => p.hops[p.hops.length - 1];
  return [
    {
      id: 'exposure-combos',
      severity: hits.some((h) => sevOf(h) === 'high') ? 'high' : 'medium',
      category: 'exposure',
      title: `${hits.length === 1 ? '1 path' : `${hits.length} paths`} from the internet ${hits.length === 1 ? 'stacks' : 'stack'} several kinds of problem`,
      why: 'Each problem has its own finding, but where they line up on one path an attacker only needs the first to get to the rest (for example an unencrypted login in front of a container with critical CVEs and an old backup). Fix these paths first.',
      fix: 'Start with the first hop on each path: closing the way in (HTTPS, an access list, or removing the forward) makes the problems behind it much harder to reach. Then work through the rest.',
      affected: hits.map((h) => ({
        label: `${h.entry.label} → ${h.path.hops.map((x) => x.label).join(' → ')}`,
        nodeId: byId.has(last(h.path).nodeId) ? last(h.path).nodeId : undefined,
        note: [...h.cats].map((c) => CAT[c] ?? c).join(' + ') + ' · ' + h.flags.slice(0, 4).map((f) => (f.on ? `${f.title} (on ${f.on})` : f.title)).join('; '),
      })),
      alsoOn: ['internet'],
      source: 'Exposure paths',
    },
  ];
}
