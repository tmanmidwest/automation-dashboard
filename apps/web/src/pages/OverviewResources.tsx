import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Server, Boxes, Network, ChevronRight } from 'lucide-react';
import type { ConnectorInstanceSummary, ConnectorResource, ConnectorNode } from '@cerebro/shared';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface Group { connector: ConnectorInstanceSummary; resources: ConnectorResource[]; nodes: ConnectorNode[] }

function statusColor(status?: string) {
  if (status === 'running' || status === 'online') return 'text-emerald-400 bg-emerald-500/15';
  if (status === 'stopped' || status === 'offline') return 'text-muted-foreground bg-muted';
  return 'text-amber-400 bg-amber-500/15';
}
function fmtBytes(n?: number) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function fmtUptime(s?: number) {
  if (!s) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

export function OverviewResources() {
  const { kind } = useParams();
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  const isNodes = kind === 'nodes';
  const isLxc = kind === 'lxc';
  const label = isNodes ? 'Nodes' : isLxc ? 'Containers' : 'Virtual machines';
  const Icon = isNodes ? Network : isLxc ? Boxes : Server;
  const filters = isNodes ? ['all', 'online', 'offline'] : ['all', 'running', 'stopped'];

  useEffect(() => {
    setFilter('all');
    async function load() {
      setLoading(true);
      try {
        const instances = await api.get<ConnectorInstanceSummary[]>('/api/connectors/instances');
        const enabled = instances.filter((i) => i.enabled);
        const results = await Promise.all(
          enabled.map(async (inst) => ({
            connector: inst,
            resources: isNodes ? [] : await api.get<ConnectorResource[]>(`/api/connectors/instances/${inst.id}/resources?kind=${kind}`).catch(() => []),
            nodes: isNodes ? await api.get<ConnectorNode[]>(`/api/connectors/instances/${inst.id}/nodes`).catch(() => []) : [],
          })),
        );
        setGroups(results.filter((g) => (isNodes ? g.nodes.length : g.resources.length) > 0));
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [kind, isNodes]);

  const match = (status?: string) => filter === 'all' || status === filter;
  const total = groups.reduce((s, g) => s + (isNodes ? g.nodes : g.resources).filter((x) => match(x.status)).length, 0);

  return (
    <>
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-3">
        <ArrowLeft className="h-4 w-4" /> Dashboard
      </Link>
      <PageHeader
        title={label}
        description={`${total} across ${groups.length} ${groups.length === 1 ? 'system' : 'systems'}`}
        actions={
          <div className="inline-flex rounded-lg border border-border p-1 bg-card">
            {filters.map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={cn('px-3 py-1 text-sm rounded-md capitalize transition-colors',
                  filter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {f}
              </button>
            ))}
          </div>
        }
      />

      {loading ? (
        <div className="text-center text-muted-foreground py-12"><Loader2 className="h-6 w-6 animate-spin inline" /></div>
      ) : groups.length === 0 ? (
        <Card><CardContent className="pt-10 pb-10 text-center text-muted-foreground">
          No {label.toLowerCase()} found. <Link to="/connectors" className="text-primary hover:underline">Manage connectors →</Link>
        </CardContent></Card>
      ) : (
        <div className="space-y-5">
          {groups.map(({ connector, resources, nodes }) => {
            const nodeRows = nodes.filter((n) => match(n.status));
            const resRows = resources.filter((r) => match(r.status));
            const count = isNodes ? nodeRows.length : resRows.length;
            if (count === 0) return null;
            return (
              <div key={connector.id}>
                <Link to={`/connectors/${connector.id}`} className="group inline-flex items-center gap-2 mb-2">
                  <Icon className="h-4 w-4 text-accent" />
                  <span className="font-medium group-hover:text-primary transition-colors">{connector.name}</span>
                  <span className="text-xs text-muted-foreground">{connector.connectorName} · {count}</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </Link>
                <Card>
                  <CardContent className="p-0">
                    {isNodes ? (
                      <table className="w-full text-sm">
                        <thead className="text-left text-muted-foreground border-b border-border">
                          <tr>
                            <th className="px-4 py-3 font-medium">Node</th>
                            <th className="px-4 py-3 font-medium">Status</th>
                            <th className="px-4 py-3 font-medium">CPU</th>
                            <th className="px-4 py-3 font-medium">Memory</th>
                            <th className="px-4 py-3 font-medium">vCPUs</th>
                            <th className="px-4 py-3 font-medium">Uptime</th>
                          </tr>
                        </thead>
                        <tbody>
                          {nodeRows.map((n) => {
                            const memPct = n.memTotalBytes ? Math.round(((n.memUsedBytes ?? 0) / n.memTotalBytes) * 100) : 0;
                            return (
                              <tr key={n.name} className="border-b border-border/50 last:border-0 hover:bg-muted/30">
                                <td className="px-4 py-3 font-medium">{n.name}</td>
                                <td className="px-4 py-3"><span className={cn('text-xs rounded-full px-2 py-0.5 capitalize', statusColor(n.status))}>{n.status}</span></td>
                                <td className="px-4 py-3 text-muted-foreground">{n.cpuPct}%</td>
                                <td className="px-4 py-3 text-muted-foreground">{fmtBytes(n.memUsedBytes)} / {fmtBytes(n.memTotalBytes)} <span className="text-xs">({memPct}%)</span></td>
                                <td className="px-4 py-3 text-muted-foreground">{n.vcpus ?? '—'}</td>
                                <td className="px-4 py-3 text-muted-foreground">{fmtUptime(n.uptimeSeconds)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    ) : (
                      <table className="w-full text-sm">
                        <thead className="text-left text-muted-foreground border-b border-border">
                          <tr>
                            <th className="px-4 py-3 font-medium">Name</th>
                            <th className="px-4 py-3 font-medium">ID</th>
                            <th className="px-4 py-3 font-medium">Node</th>
                            <th className="px-4 py-3 font-medium">Resources</th>
                            <th className="px-4 py-3 font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {resRows.map((r) => (
                            <tr key={r.id} className="border-b border-border/50 last:border-0 hover:bg-muted/30">
                              <td className="px-4 py-3"><Link to={`/connectors/${connector.id}`} className="font-medium hover:text-primary transition-colors">{r.name}</Link></td>
                              <td className="px-4 py-3 text-muted-foreground">{String(r.details?.vmid ?? r.id)}</td>
                              <td className="px-4 py-3 text-muted-foreground">{String(r.details?.node ?? '—')}</td>
                              <td className="px-4 py-3 text-muted-foreground">{[r.details?.cpu, r.details?.memory].filter(Boolean).join(' · ') || '—'}</td>
                              <td className="px-4 py-3"><span className={cn('text-xs rounded-full px-2 py-0.5 capitalize', statusColor(r.status))}>{r.status ?? 'unknown'}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </CardContent>
                </Card>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
