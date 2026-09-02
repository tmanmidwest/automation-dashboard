import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Trash2, Pause, Play, RefreshCw, Loader2, ShieldCheck, ShieldAlert } from 'lucide-react';
import type { MonitorChart, MonitorChartRange, MonitorDetail as Detail, MonitorHeartbeat } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { HeartbeatBar } from '@/components/HeartbeatBar';
import { LatencyChart } from '@/components/LatencyChart';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn, shortDateTime, timeAgo } from '@/lib/utils';
import { MonitorAlerts } from './MonitorAlerts';
import { STATUS, StatusBadge, ms, pct, pctColor } from './monitor-ui';

const POLL_MS = 10_000;
const RANGES: { id: MonitorChartRange; label: string }[] = [
  { id: '1h', label: '1h' }, { id: '24h', label: '24h' }, { id: '7d', label: '7d' }, { id: '30d', label: '30d' },
];

export function MonitorDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const writable = can('monitors:write');

  const [m, setM] = useState<Detail | null>(null);
  const [events, setEvents] = useState<MonitorHeartbeat[]>([]);
  const [range, setRange] = useState<MonitorChartRange>('24h');
  const [chart, setChart] = useState<MonitorChart | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, ev, ch] = await Promise.all([
        api.get<Detail>(`/api/monitors/${id}`),
        api.get<MonitorHeartbeat[]>(`/api/monitors/${id}/events?limit=50`),
        api.get<MonitorChart>(`/api/monitors/${id}/chart?range=${range}`),
      ]);
      setM(d); setEvents(ev); setChart(ch);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load');
    }
  }, [id, range]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Action failed' });
    } finally {
      setBusy(null);
    }
  }

  async function checkNow() {
    await act('check', async () => {
      const r = await api.post<{ ok: boolean; message: string; latencyMs?: number }>(`/api/monitors/${id}/check`);
      setMsg({ ok: r.ok, text: r.message });
    });
  }

  async function remove() {
    if (!m || !confirm(`Delete monitor "${m.name}"? Its history will be removed too.`)) return;
    await act('delete', async () => {
      await api.delete(`/api/monitors/${id}`);
      navigate('/monitors');
    });
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!m) return null;

  const s = STATUS[m.status];
  const since = m.lastChangeAt ? timeAgo(m.lastChangeAt) : null;

  return (
    <>
      <Link to="/monitors" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-3">
        <ArrowLeft className="h-4 w-4" /> Monitors
      </Link>
      <PageHeader
        title={m.name}
        description={`${m.typeLabel} · ${m.target} · every ${m.intervalSec}s`}
        actions={writable && (
          <>
            <Button variant="outline" size="sm" onClick={checkNow} disabled={!!busy || !m.enabled}>
              {busy === 'check' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Check now
            </Button>
            <Button variant="outline" size="sm" disabled={!!busy}
              onClick={() => act('toggle', () => api.patch(`/api/monitors/${id}/enabled`, { enabled: !m.enabled }))}>
              {m.enabled ? <><Pause className="h-4 w-4" /> Pause</> : <><Play className="h-4 w-4" /> Resume</>}
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate(`/monitors/${id}/edit`)}><Pencil className="h-4 w-4" /> Edit</Button>
            <Button variant="ghost" size="sm" className="text-destructive" onClick={remove} disabled={!!busy}><Trash2 className="h-4 w-4" /></Button>
          </>
        )}
      />

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <StatusBadge status={m.status} />
        {since && m.status !== 'pending' && <span className="text-sm text-muted-foreground">{s.label.toLowerCase()} since {shortDateTime(m.lastChangeAt)} ({since})</span>}
        {m.lastMessage && <span className="text-sm text-muted-foreground truncate max-w-xl" title={m.lastMessage}>· {m.lastMessage}</span>}
        {msg && <span className={cn('text-sm', msg.ok ? 'text-emerald-400' : 'text-destructive')}>{msg.text}</span>}
      </div>

      <div className="grid gap-3 grid-cols-2 md:grid-cols-4 xl:grid-cols-5 mb-6">
        <Stat label="Response" value={m.status === 'paused' ? '—' : ms(m.lastLatencyMs)} sub={m.lastCheckAt ? `checked ${timeAgo(m.lastCheckAt)}` : 'not checked yet'} />
        <Stat label="Avg response (24h)" value={ms(m.avgLatency24hMs)} />
        <Stat label="Uptime (24h)" value={pct(m.uptime24h)} valueClass={pctColor(m.uptime24h)} />
        <Stat label="Uptime (30d)" value={pct(m.uptime30d)} valueClass={pctColor(m.uptime30d)} />
        {m.type === 'http' && (
          <Stat
            label="Certificate"
            value={m.certDaysLeft === null ? '—' : m.certDaysLeft < 0 ? 'Expired' : `${m.certDaysLeft} days`}
            valueClass={m.certDaysLeft === null ? '' : m.certDaysLeft < 0 ? 'text-red-400' : m.certDaysLeft <= 14 ? 'text-amber-400' : 'text-emerald-400'}
            sub={m.certExpiresAt ? `expires ${new Date(m.certExpiresAt).toLocaleDateString()}` : 'no TLS data'}
            icon={m.certDaysLeft !== null && m.certDaysLeft <= 14 ? <ShieldAlert className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
          />
        )}
      </div>

      <Card className="mb-6">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70">Recent checks</p>
            <p className="text-xs text-muted-foreground">{m.recentBeats.length} shown · newest right</p>
          </div>
          <HeartbeatBar beats={m.recentBeats} slots={100} barClassName="h-8" />
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Response time</CardTitle>
            <CardDescription>Red ticks on the baseline are failed checks.</CardDescription>
          </div>
          <div className="flex rounded-md border border-border overflow-hidden">
            {RANGES.map((r) => (
              <button key={r.id} type="button" onClick={() => setRange(r.id)}
                className={cn('px-3 py-1 text-xs', range === r.id ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted/40')}>
                {r.label}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <LatencyChart points={chart?.points ?? []} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Events</CardTitle>
            <CardDescription>Status changes, newest first.</CardDescription>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No status changes recorded yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr className="text-left border-b border-border">
                      <th className="py-2 pr-3 font-medium">When</th>
                      <th className="py-2 pr-3 font-medium">Status</th>
                      <th className="py-2 pr-3 font-medium">Latency</th>
                      <th className="py-2 font-medium">Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e, i) => (
                      <tr key={i} className="border-b border-border/50 last:border-0">
                        <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground" title={e.at}>{shortDateTime(e.at)}</td>
                        <td className="py-2 pr-3"><StatusBadge status={e.status} /></td>
                        <td className="py-2 pr-3 tabular-nums">{ms(e.latencyMs)}</td>
                        <td className="py-2 text-muted-foreground">{e.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <MonitorAlerts monitorId={id} />
          {(m.description || m.tags.length > 0) && (
            <Card>
              <CardHeader><CardTitle className="text-base">About</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {m.description && <p className="text-sm text-muted-foreground whitespace-pre-wrap">{m.description}</p>}
                {m.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {m.tags.map((t) => <span key={t} className="text-xs rounded-full bg-muted px-2 py-0.5">{t}</span>)}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, sub, valueClass, icon }: { label: string; value: string; sub?: string; valueClass?: string; icon?: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70 flex items-center gap-1.5">{icon}{label}</p>
        <p className={cn('text-xl font-semibold tabular-nums mt-1', valueClass)}>{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

