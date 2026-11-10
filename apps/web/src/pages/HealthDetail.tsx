import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, RefreshCw, Radio } from 'lucide-react';
import type { HealthMachine, HealthRange, HealthRole, HealthSeries, HealthSettings } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { MetricChart, type ChartSeries } from '@/components/health/MetricChart';
import { UpdatesCard } from '@/components/health/UpdatesCard';
import {
  AvailabilityLine, PctBar, RoleIcon, STATUS_STYLE, StatusDot, fmtAgo, fmtBitRate, fmtByteRate, fmtBytes, fmtDuration, fmtPct, osLabel,
} from '@/components/health/health-ui';

const RANGES: { key: HealthRange; label: string }[] = [
  { key: '1h', label: '1 hour' },
  { key: '24h', label: '24 hours' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
];

// One color per disk line, cycling.
const DISK_COLORS = [
  ['stroke-sky-400', 'bg-sky-400'],
  ['stroke-violet-400', 'bg-violet-400'],
  ['stroke-emerald-400', 'bg-emerald-400'],
  ['stroke-amber-400', 'bg-amber-400'],
  ['stroke-pink-400', 'bg-pink-400'],
  ['stroke-teal-400', 'bg-teal-400'],
];

/** One machine's health: issues, current numbers, charts, filesystems, availability. */
export function HealthDetail() {
  const { agentId = '' } = useParams();
  const { can } = useAuth();
  const [m, setM] = useState<HealthMachine | null>(null);
  const [settings, setSettings] = useState<HealthSettings | null>(null);
  const [series, setSeries] = useState<HealthSeries | null>(null);
  const [range, setRange] = useState<HealthRange>('24h');
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function loadMachine() {
    try {
      setM(await api.get<HealthMachine>(`/api/machine-health/${agentId}`));
      setErr(null);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed to load.'); }
  }
  async function loadSeries(r = range) {
    try { setSeries(await api.get<HealthSeries>(`/api/machine-health/${agentId}/series?range=${r}`)); } catch { /* chart shows empty */ }
  }
  useEffect(() => {
    loadMachine();
    api.get<HealthSettings>('/api/machine-health/settings').then(setSettings).catch(() => undefined);
    const t = setInterval(() => { loadMachine(); loadSeries(); }, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);
  useEffect(() => { loadSeries(range); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [agentId, range]);

  async function refreshNow() {
    setRefreshing(true);
    try {
      await api.post(`/api/machine-health/${agentId}/refresh`, {});
      await new Promise((r) => setTimeout(r, 2500)); // the agent reports within ~2 s
      await Promise.all([loadMachine(), loadSeries()]);
    } finally { setRefreshing(false); }
  }
  async function setRole(role: HealthRole | null) {
    try { setM(await api.patch<HealthMachine>(`/api/machine-health/${agentId}`, { role })); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not change role.'); }
  }

  const pts = series?.points ?? [];
  const times = pts.map((p) => p.at);
  const t = settings?.thresholds;
  const diskSeries = useMemo<ChartSeries[]>(() => {
    const mounts = [...new Set(pts.flatMap((p) => Object.keys(p.disks ?? {})))].sort();
    return mounts.slice(0, DISK_COLORS.length).map((mount, i) => ({
      key: mount, label: mount, stroke: DISK_COLORS[i][0], swatch: DISK_COLORS[i][1],
      values: pts.map((p) => p.disks?.[mount] ?? null),
    }));
  }, [series]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err && !m) return <div className="text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">{err}</div>;
  if (!m) return <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>;

  const s = m.latest;
  const inv = m.inventory;
  const live = m.status !== 'offline';

  return (
    <>
      <PageHeader title={`Health · ${m.name}`}
        description={`${osLabel(m.os)}${inv?.platform ? ` · ${inv.platform} ${inv.platformVersion ?? ''}` : ''}${m.localIp ? ` · ${m.localIp}` : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => history.back()}><ArrowLeft className="h-4 w-4" /> Back</Button>
            <Link to="/fabric"><Button variant="outline"><Radio className="h-4 w-4" /> Fabric</Button></Link>
            <Button variant="outline" onClick={refreshNow} disabled={refreshing || !m.online}>
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} /> Refresh now
            </Button>
          </div>
        } />
      {err && <div className="mb-4 text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">{err}</div>}

      {/* Status strip */}
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] mb-4">
        <Card>
          <CardContent className="pt-5 space-y-3">
            <div className="flex items-center gap-3">
              <StatusDot status={m.status} className="h-3.5 w-3.5" />
              <span className={cn('text-lg font-semibold', STATUS_STYLE[m.status].text)}>{STATUS_STYLE[m.status].label}</span>
              {m.score != null && <span className="ml-auto text-3xl font-semibold tabular-nums">{m.score}<span className="text-sm text-muted-foreground">/100</span></span>}
            </div>
            <div className="text-xs text-muted-foreground">
              {m.online ? `Last report ${fmtAgo(m.latestAt)}` : `Offline · last seen ${fmtAgo(m.lastSeenAt)}`}
              {s?.uptimeSec ? ` · up ${fmtDuration(s.uptimeSec)}` : ''}
            </div>
            <div className="flex items-center gap-2 text-sm">
              <RoleIcon role={m.role} className="text-muted-foreground" />
              {can('fabric:manage') ? (
                <select value={m.roleOverridden ? m.role : 'auto'} onChange={(e) => setRole(e.target.value === 'auto' ? null : (e.target.value as HealthRole))}
                  className="h-8 rounded-md border border-border bg-card px-2 text-sm">
                  <option value="auto">Auto ({m.roleOverridden ? 'detect' : m.role})</option>
                  <option value="server">Server — alert when offline</option>
                  <option value="workstation">Workstation — offline is normal</option>
                </select>
              ) : <span>{m.role === 'workstation' ? 'Workstation' : 'Server'}</span>}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            {m.issues.length ? (
              <ul className="space-y-1.5 text-sm">
                {m.issues.map((i, n) => (
                  <li key={n} className="flex items-start gap-2">
                    <span className={cn('mt-1.5 h-2 w-2 rounded-full shrink-0', i.severity === 'critical' ? 'bg-red-500' : 'bg-amber-400')} />
                    <span>{i.message}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {m.status === 'ok' ? 'No issues. Everything is within its limits.'
                  : m.status === 'offline' ? `Offline. That's normal for a ${m.role}: it doesn't alert, it's counted as offline time below.`
                  : m.online ? 'Waiting for the first health report. Agents older than 0.6 update themselves on their next connect.' : 'No data yet.'}
              </p>
            )}
            <div className="mt-4 space-y-2">
              <AvailabilityLine a={m.availability.day} label="24 hours" />
              <AvailabilityLine a={m.availability.week} label="7 days" />
              <AvailabilityLine a={m.availability.month} label="30 days" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Now */}
      {s && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2 mb-4">
          <Stat label="CPU" value={live ? fmtPct(s.cpuPct) : '—'} sub={s.cpuMaxPct != null && live ? `peak ${fmtPct(s.cpuMaxPct)}` : s.load1 != null ? `load ${s.load1}` : undefined} />
          <Stat label="Memory" value={live ? fmtPct(s.memPct) : '—'} sub={s.memTotal ? `${fmtBytes(s.memUsed)} of ${fmtBytes(s.memTotal)}` : undefined} />
          <Stat label="Swap" value={s.swapTotal ? fmtPct(s.swapPct) : 'none'} sub={s.swapTotal ? `${fmtBytes(s.swapUsed)} of ${fmtBytes(s.swapTotal)}` : undefined} />
          <Stat label="Network" value={live ? `↓ ${fmtBitRate(s.netRxBps)}` : '—'} sub={live ? `↑ ${fmtBitRate(s.netTxBps)}` : undefined} />
          <Stat label="Disk I/O" value={live ? `R ${fmtByteRate(s.diskReadBps)}` : '—'} sub={live ? `W ${fmtByteRate(s.diskWriteBps)}` : undefined} />
          <Stat label="Processes" value={s.procs != null ? String(s.procs) : '—'} sub={s.load1 != null ? `load ${s.load1} / ${s.load5} / ${s.load15}` : undefined} />
        </div>
      )}

      <UpdatesCard agentId={agentId} canManage={can('fabric:manage')} />

      {/* Charts */}
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-lcars text-lg">History</h2>
        <div className="inline-flex rounded-md border border-border overflow-hidden text-sm">
          {RANGES.map((r) => (
            <button key={r.key} onClick={() => setRange(r.key)}
              className={cn('px-3 py-1.5', range === r.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>{r.label}</button>
          ))}
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2 mb-4">
        <ChartCard title="CPU">
          <MetricChart times={times} limits={t ? [{ value: t.cpuWarnPct, tone: 'warn' }] : undefined} series={[
            { key: 'cpu', label: 'Average', stroke: 'stroke-sky-400', swatch: 'bg-sky-400', values: pts.map((p) => p.cpu) },
            { key: 'cpuMax', label: 'Peak', stroke: 'stroke-sky-400/40', swatch: 'bg-sky-400/40', values: pts.map((p) => p.cpuMax), dashed: true },
          ]} />
        </ChartCard>
        <ChartCard title="Memory">
          <MetricChart times={times} limits={t ? [{ value: t.memWarnPct, tone: 'warn' }, { value: t.memCritPct, tone: 'crit' }] : undefined} series={[
            { key: 'mem', label: 'Memory', stroke: 'stroke-violet-400', swatch: 'bg-violet-400', values: pts.map((p) => p.mem) },
            { key: 'swap', label: 'Swap', stroke: 'stroke-pink-400', swatch: 'bg-pink-400', values: pts.map((p) => p.swap), dashed: true },
          ]} />
        </ChartCard>
        <ChartCard title="Disk usage">
          <MetricChart times={times} series={diskSeries} limits={t ? [{ value: t.diskWarnPct, tone: 'warn' }, { value: t.diskCritPct, tone: 'crit' }] : undefined} />
        </ChartCard>
        <ChartCard title="Network">
          <MetricChart times={times} unit="value" format={fmtBitRate} series={[
            { key: 'rx', label: 'Download', stroke: 'stroke-emerald-400', swatch: 'bg-emerald-400', values: pts.map((p) => p.netRx) },
            { key: 'tx', label: 'Upload', stroke: 'stroke-amber-400', swatch: 'bg-amber-400', values: pts.map((p) => p.netTx) },
          ]} />
        </ChartCard>
        <ChartCard title="Disk I/O">
          <MetricChart times={times} unit="value" format={fmtByteRate} series={[
            { key: 'r', label: 'Read', stroke: 'stroke-teal-400', swatch: 'bg-teal-400', values: pts.map((p) => p.read) },
            { key: 'w', label: 'Write', stroke: 'stroke-orange-400', swatch: 'bg-orange-400', values: pts.map((p) => p.write) },
          ]} />
        </ChartCard>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Filesystems */}
        <Card>
          <CardHeader><CardTitle>Filesystems</CardTitle></CardHeader>
          <CardContent>
            {s?.disks?.length ? (
              <div className="space-y-3">
                {[...s.disks].sort((a, b) => b.pct - a.pct).map((d) => (
                  <div key={d.mount}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="font-mono truncate">{d.mount}</span>
                      <span className="tabular-nums">{Math.round(d.pct)}%</span>
                    </div>
                    <PctBar pct={d.pct} warn={t?.diskWarnPct} crit={t?.diskCritPct} className="my-1" />
                    <div className="text-xs text-muted-foreground">
                      {fmtBytes(Math.max(0, d.totalBytes - d.usedBytes))} free of {fmtBytes(d.totalBytes)}
                      {d.fs ? ` · ${d.fs}` : ''}{d.device ? ` · ${d.device}` : ''}
                      {d.inodesPct != null ? ` · inodes ${Math.round(d.inodesPct)}%` : ''}
                    </div>
                  </div>
                ))}
              </div>
            ) : <p className="text-sm text-muted-foreground">No filesystems reported yet.</p>}
          </CardContent>
        </Card>

        {/* Inventory */}
        <Card>
          <CardHeader><CardTitle>Machine</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              <Fact k="Hostname" v={inv?.hostname ?? m.hostname} />
              <Fact k="OS" v={inv ? `${inv.platform ?? osLabel(inv.os)} ${inv.platformVersion ?? ''}`.trim() : osLabel(m.os)} />
              <Fact k="Kernel" v={inv?.kernelVersion} />
              <Fact k="CPU" v={inv?.cpuModel ? `${inv.cpuModel}${inv.cpuCores ? ` · ${inv.cpuCores} cores` : ''}${inv.cpuThreads && inv.cpuThreads !== inv.cpuCores ? ` / ${inv.cpuThreads} threads` : ''}` : undefined} />
              <Fact k="Memory" v={inv?.memTotal ? fmtBytes(inv.memTotal) : undefined} />
              <Fact k="Architecture" v={inv?.arch} />
              <Fact k="Virtualization" v={inv?.virtRole ? `${inv.virtRole}${inv.virtSystem ? ` (${inv.virtSystem})` : ''}` : 'physical'} />
              <Fact k="Battery" v={inv ? (inv.hasBattery ? 'yes' : 'no') : undefined} />
              <Fact k="Booted" v={inv?.bootTime ? new Date(inv.bootTime * 1000).toLocaleString() : undefined} />
              <Fact k="IPs" v={inv?.ips?.join(', ')} />
              <Fact k="MACs" v={inv?.macs?.join(', ')} mono />
              <Fact k="Agent" v={m.agentVersion ?? undefined} />
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums truncate">{value}</p>
      {sub && <p className="text-xs text-muted-foreground truncate">{sub}</p>}
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="text-sm font-medium mb-1">{title}</p>
        {children}
      </CardContent>
    </Card>
  );
}

function Fact({ k, v, mono }: { k: string; v?: string | null; mono?: boolean }) {
  if (!v) return null;
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={cn('break-words', mono && 'font-mono text-xs')}>{v}</dd>
    </>
  );
}
