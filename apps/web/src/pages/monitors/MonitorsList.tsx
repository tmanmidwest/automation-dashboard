import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, ChevronRight, Upload, Activity, Search } from 'lucide-react';
import type { MonitorSummary } from '@cerebro/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { HeartbeatBar } from '@/components/HeartbeatBar';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn, timeAgo } from '@/lib/utils';
import { KumaImportDialog } from './KumaImportDialog';
import { StatusDot, TypeIcon, ms, pct, pctColor } from './monitor-ui';

const POLL_MS = 15_000;

export function MonitorsList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const writable = can('monitors:write');
  const [monitors, setMonitors] = useState<MonitorSummary[] | null>(null);
  const [q, setQ] = useState('');
  const [importing, setImporting] = useState(false);

  const load = useCallback(() => api.get<MonitorSummary[]>('/api/monitors').then(setMonitors).catch(() => {}), []);
  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const counts = useMemo(() => {
    const c = { up: 0, down: 0, pending: 0, paused: 0 };
    for (const m of monitors ?? []) c[m.status] = (c[m.status] ?? 0) + 1;
    return c;
  }, [monitors]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = monitors ?? [];
    if (!needle) return list;
    return list.filter((m) =>
      m.name.toLowerCase().includes(needle) || m.target.toLowerCase().includes(needle) || m.tags.some((t) => t.toLowerCase().includes(needle)),
    );
  }, [monitors, q]);

  return (
    <>
      <PageHeader
        title="Monitors"
        description="Uptime checks for hosts, services and endpoints. Alerts fire on down and recovery."
        actions={writable && (
          <>
            <Button variant="outline" onClick={() => setImporting(true)}><Upload className="h-4 w-4" /> Import from Kuma</Button>
            <Button onClick={() => navigate('/monitors/new')}><Plus className="h-4 w-4" /> Add monitor</Button>
          </>
        )}
      />

      {monitors && monitors.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <Pill status="up" n={counts.up} />
          <Pill status="down" n={counts.down} />
          <Pill status="pending" n={counts.pending} />
          <Pill status="paused" n={counts.paused} />
          <div className="relative ml-auto w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, target, tag" className="pl-8 h-9" />
          </div>
        </div>
      )}

      {monitors === null ? null : monitors.length === 0 ? (
        <Card>
          <CardContent className="pt-10 pb-10 text-center">
            <div className="mx-auto h-12 w-12 rounded-xl bg-muted grid place-items-center mb-3">
              <Activity className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="font-medium">No monitors yet</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              {writable
                ? 'Add a ping, HTTP, TCP or DNS monitor, or import your existing list from an Uptime Kuma backup.'
                : 'Ask an administrator to add monitors.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((m) => (
            <Link key={m.id} to={`/monitors/${m.id}`} className="block">
              <Card className={cn('transition-all hover:border-primary/50', m.status === 'down' && 'border-red-500/40')}>
                <CardContent className="pt-3 pb-3 flex items-center gap-4">
                  <StatusDot status={m.status} className="ml-1" />
                  <div className="h-9 w-9 rounded-md bg-primary/15 text-primary grid place-items-center shrink-0">
                    <TypeIcon type={m.type} />
                  </div>
                  <div className="min-w-0 w-56 shrink-0">
                    <p className="font-medium truncate">{m.name}</p>
                    <p className="text-xs text-muted-foreground truncate" title={m.target}>{m.target}</p>
                  </div>
                  <div className="flex-1 min-w-0 hidden md:block">
                    <HeartbeatBar beats={m.recentBeats} slots={40} barClassName="h-5" />
                  </div>
                  <div className="text-right shrink-0 w-20 hidden sm:block">
                    <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70">Latency</p>
                    <p className="text-sm tabular-nums">{m.status === 'paused' ? '—' : ms(m.lastLatencyMs)}</p>
                  </div>
                  <div className="text-right shrink-0 w-20">
                    <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70">24h</p>
                    <p className={cn('text-sm tabular-nums', pctColor(m.uptime24h))}>{pct(m.uptime24h)}</p>
                  </div>
                  <div className="text-right shrink-0 w-20 hidden lg:block">
                    <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70">30d</p>
                    <p className={cn('text-sm tabular-nums', pctColor(m.uptime30d))}>{pct(m.uptime30d)}</p>
                  </div>
                  <div className="text-right shrink-0 w-20 hidden xl:block">
                    <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70">Checked</p>
                    <p className="text-xs text-muted-foreground" title={m.lastCheckAt ?? ''}>{timeAgo(m.lastCheckAt)}</p>
                  </div>
                  <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
                </CardContent>
              </Card>
            </Link>
          ))}
          {filtered.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">No monitors match “{q}”.</p>}
        </div>
      )}

      <KumaImportDialog open={importing} onClose={() => setImporting(false)} onImported={load} />
    </>
  );
}

function Pill({ status, n }: { status: MonitorSummary['status']; n: number }) {
  const label = { up: 'Up', down: 'Down', pending: 'Pending', paused: 'Paused' }[status];
  return (
    <span className={cn('inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-sm', n === 0 && 'opacity-50')}>
      <StatusDot status={status} />
      <span className="tabular-nums font-medium">{n}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}
