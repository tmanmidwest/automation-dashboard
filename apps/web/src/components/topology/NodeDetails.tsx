import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import type { TopoEdgeType, TopoNode, TopologyGraph } from '@cerebro/shared';
import { cn } from '@/lib/utils';
import { STATUS_DOT } from './meta';

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

export function sourceHref(s: TopoNode['sources'][number]): string | null {
  if (s.instanceId) return `/connectors/${s.instanceId}`;
  if (s.connectorId === 'fabric') return '/fabric';
  if (s.connectorId === 'replicator') return '/replicator';
  return null;
}

/** Everything known about one node: addresses, connections, each source's details, links out. */
export function NodeDetails({ node, graph, byId, onGo, columns = 1 }: {
  node: TopoNode;
  graph: TopologyGraph;
  byId: Map<string, TopoNode>;
  onGo: (id: string) => void;
  /** Lay the sections out side by side (the wide row on the overview). */
  columns?: 1 | 3;
}) {
  const grouped = useMemo(() => {
    const m = new Map<string, { other: TopoNode; label?: string; notes?: string[] }[]>();
    const add = (phrase: string, l: { other: TopoNode; label?: string; notes?: string[] }) => {
      if (!m.has(phrase)) m.set(phrase, []);
      m.get(phrase)!.push(l);
    };
    const parent = node.parent ? byId.get(node.parent) : undefined;
    if (parent) add('Inside', { other: parent });
    for (const e of graph.edges) {
      const mine = e.source === node.id ? 0 : e.target === node.id ? 1 : -1;
      if (mine < 0) continue;
      const other = byId.get(mine === 0 ? e.target : e.source);
      if (other) add(EDGE_PHRASE[e.type][mine as 0 | 1], { other, label: e.label, notes: e.notes });
    }
    return [...m.entries()];
  }, [node, graph, byId]);

  return (
    <div className={cn('text-sm gap-5', columns === 3 ? 'grid md:grid-cols-3' : 'flex flex-col')}>
      <div className="space-y-4 min-w-0">
        {node.roles.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {node.roles.map((r) => <span key={r} className="rounded-full bg-muted px-2 py-0.5 text-xs">{r}</span>)}
          </div>
        )}
        {(node.ips.length > 0 || node.macs.length > 0) && (
          <dl className="grid grid-cols-[56px_1fr] gap-x-2 gap-y-1 text-xs">
            {node.ips.length > 0 && <><dt className="text-muted-foreground">IP</dt><dd className="font-mono break-all">{node.ips.join(', ')}</dd></>}
            {node.macs.length > 0 && <><dt className="text-muted-foreground">MAC</dt><dd className="font-mono break-all">{node.macs.join(', ')}</dd></>}
          </dl>
        )}
        {node.sources.length > 0 ? (
          <section>
            <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">Seen by</h4>
            <ul className="flex flex-wrap gap-1.5">
              {node.sources.map((s, i) => {
                const href = sourceHref(s);
                const text = `${s.name}${s.kind ? ` · ${s.kind}` : ''}`;
                return (
                  <li key={i} className="text-xs">
                    {href
                      ? <Link to={href} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-accent hover:bg-muted">{text}<ExternalLink className="h-3 w-3" /></Link>
                      : <span className="inline-flex rounded-md border border-border px-2 py-1">{text}</span>}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (
          <p className="text-xs text-muted-foreground">No connector reports this address. Something (a firewall rule, proxy host or port forward) points at it, so it may be stale or unmanaged.</p>
        )}
      </div>

      {grouped.length > 0 && (
        <section className="min-w-0">
          <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">Connections</h4>
          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {grouped.map(([phrase, items]) => (
              <div key={phrase}>
                <p className="text-xs text-muted-foreground">{phrase}</p>
                <ul className="mt-0.5 space-y-0.5">
                  {items.map((l, i) => (
                    <li key={i}>
                      <button onClick={() => onGo(l.other.id)} className="text-left hover:text-accent flex items-center gap-1.5 w-full min-w-0">
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

      {node.details.length > 0 && (
        <div className="space-y-4 min-w-0 max-h-80 overflow-y-auto pr-1">
          {node.details.map((d, i) => (
            <section key={i}>
              <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">{d.source}</h4>
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
        </div>
      )}
    </div>
  );
}
