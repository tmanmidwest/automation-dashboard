import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { HeartPulse, Loader2, RefreshCw, Search, Settings2, X } from 'lucide-react';
import type { HealthFleet, HealthMachine, HealthSettings, HealthStatus, HealthThresholds } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  PctBar, RoleIcon, Sparkline, STATUS_STYLE, StatusDot, fmtAgo, fmtDuration, fmtPct, osLabel, roleLabel, worstDisk,
} from '@/components/health/health-ui';

const REFRESH_MS = 30_000;
type Filter = HealthStatus | 'attention' | null;

/** Health — every machine running the Cerebro agent, worst first. docs/health-monitoring.md */
export function Health() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [fleet, setFleet] = useState<HealthFleet | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [os, setOs] = useState<string>('all');
  const [filter, setFilter] = useState<Filter>(null);
  const [showSettings, setShowSettings] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setFleet(await api.get<HealthFleet>('/api/machine-health'));
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load health.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); const t = setInterval(load, REFRESH_MS); return () => clearInterval(t); }, []);

  const t = fleet?.settings.thresholds;
  const oses = useMemo(() => [...new Set((fleet?.machines ?? []).map((m) => m.os ?? 'unknown'))].sort(), [fleet]);
  const query = q.trim().toLowerCase();
  const visible = (fleet?.machines ?? []).filter((m) =>
    (os === 'all' || (m.os ?? 'unknown') === os) &&
    (!filter || (filter === 'attention' ? m.status === 'warning' || m.status === 'critical' : m.status === filter)) &&
    (!query || [m.name, m.hostname, m.localIp, ...m.tags].some((v) => v?.toLowerCase().includes(query))),
  );

  const tot = fleet?.totals;
  const tiles: { label: string; value: number; key: Filter; tone?: string }[] = tot ? [
    { label: 'Machines', value: tot.machines, key: null },
    { label: 'Healthy', value: tot.ok, key: 'ok', tone: 'text-emerald-400' },
    { label: 'Warning', value: tot.warning, key: 'warning', tone: tot.warning ? 'text-amber-400' : undefined },
    { label: 'Critical', value: tot.critical, key: 'critical', tone: tot.critical ? 'text-red-400' : undefined },
    { label: 'Offline', value: tot.offline, key: 'offline' },
    { label: 'No data', value: tot.unknown, key: 'unknown' },
  ] : [];

  return (
    <>
      <PageHeader title="Health" description="CPU, memory, disks and uptime reported by the Cerebro agent on each machine. Worst first."
        actions={
          <div className="flex items-center gap-2">
            {can('fabric:manage') && (
              <Button variant="outline" onClick={() => setShowSettings(true)}><Settings2 className="h-4 w-4" /> Settings</Button>
            )}
            <Button variant="outline" onClick={load} disabled={loading}>
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /> Refresh
            </Button>
          </div>
        } />

      {err && <div className="mb-4 text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">{err}</div>}
      {!fleet && !err && <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>}

      {fleet && fleet.machines.length === 0 && (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground space-y-2">
          <p className="flex items-center gap-2 text-foreground"><HeartPulse className="h-4 w-4" /> No machines yet.</p>
          <p>Health comes from the Cerebro agent. Install it from <Link to="/fabric" className="underline">Fabric → Add machine</Link> on any Linux, macOS or Windows box and it shows up here within a minute. Machines already running the agent update themselves to the health-capable version automatically.</p>
        </CardContent></Card>
      )}

      {fleet && fleet.machines.length > 0 && (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-4">
            {tiles.map((tile) => {
              const active = filter === tile.key && tile.key !== null;
              return (
                <button key={tile.label} onClick={() => setFilter(active || tile.key === null ? null : tile.key)}
                  className={cn('rounded-lg border px-3 py-2 text-left transition-colors',
                    active ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-primary/40')}>
                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{tile.label}</p>
                  <p className={cn('text-xl font-semibold tabular-nums', tile.tone)}>{tile.value}</p>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-8" placeholder="Search name, host, IP, tag…" value={q} onChange={(e) => setQ(e.target.value)} />
              {q && <button onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>}
            </div>
            <select value={os} onChange={(e) => setOs(e.target.value)} className="h-9 rounded-md border border-border bg-card px-2 text-sm">
              <option value="all">All OS</option>
              {oses.map((o) => <option key={o} value={o}>{osLabel(o)}</option>)}
            </select>
            <Button variant={filter === 'attention' ? 'default' : 'outline'} size="sm" onClick={() => setFilter(filter === 'attention' ? null : 'attention')}>
              Needs attention
            </Button>
          </div>

          {/* Desktop: table */}
          <div className="hidden lg:block rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Machine</th>
                  <th className="text-left font-medium px-3 py-2 w-16">Score</th>
                  <th className="text-left font-medium px-3 py-2 w-48">CPU · 24h</th>
                  <th className="text-left font-medium px-3 py-2 w-48">Memory · 24h</th>
                  <th className="text-left font-medium px-3 py-2 w-40">Fullest disk</th>
                  <th className="text-left font-medium px-3 py-2 w-40">Online · 7d</th>
                  <th className="text-left font-medium px-3 py-2">Issues</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((m) => <Row key={m.agentId} m={m} t={t} onOpen={() => navigate(`/health/${m.agentId}`)} />)}
              </tbody>
            </table>
            {!visible.length && <p className="p-4 text-sm text-muted-foreground">Nothing matches.</p>}
          </div>

          {/* Mobile / tablet: cards */}
          <div className="lg:hidden grid gap-2">
            {visible.map((m) => <MobileCard key={m.agentId} m={m} t={t} onOpen={() => navigate(`/health/${m.agentId}`)} />)}
            {!visible.length && <p className="text-sm text-muted-foreground">Nothing matches.</p>}
          </div>
        </>
      )}

      {showSettings && fleet && (
        <SettingsDialog settings={fleet.settings} onClose={() => setShowSettings(false)} onSaved={() => { setShowSettings(false); load(); }} />
      )}
    </>
  );
}

function Identity({ m }: { m: HealthMachine }) {
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <StatusDot status={m.status} />
      <RoleIcon role={m.role} className="text-muted-foreground shrink-0" />
      <div className="min-w-0">
        <div className="font-medium truncate">{m.name}</div>
        <div className="text-xs text-muted-foreground truncate">
          {osLabel(m.os)}{m.hostname && m.hostname !== m.name ? ` · ${m.hostname}` : ''}{m.localIp ? ` · ${m.localIp}` : ''}
          {!m.online && ` · seen ${fmtAgo(m.lastSeenAt)}`}
        </div>
      </div>
    </div>
  );
}

function Score({ m }: { m: HealthMachine }) {
  return (
    <span className={cn('tabular-nums font-semibold', STATUS_STYLE[m.status].text)}>
      {m.score ?? '—'}
    </span>
  );
}

function IssueText({ m }: { m: HealthMachine }) {
  if (m.status === 'offline') return <span className="text-muted-foreground">Offline (normal for a {roleLabel(m.role).toLowerCase()})</span>;
  if (m.status === 'unknown') {
    return <span className="text-muted-foreground">{m.online ? `Waiting for first report${m.agentVersion ? ` (agent ${m.agentVersion} updates itself)` : ''}` : 'No data yet'}</span>;
  }
  if (!m.issues.length) return <span className="text-muted-foreground">—</span>;
  const [first, ...rest] = m.issues;
  return (
    <span className={first.severity === 'critical' ? 'text-red-400' : 'text-amber-400'}>
      {first.message}{rest.length ? <span className="text-muted-foreground"> +{rest.length} more</span> : null}
    </span>
  );
}

function Row({ m, t, onOpen }: { m: HealthMachine; t?: HealthThresholds; onOpen: () => void }) {
  const d = worstDisk(m);
  const live = m.status !== 'offline';
  return (
    <tr onClick={onOpen} className="border-t border-border hover:bg-muted/30 cursor-pointer align-middle">
      <td className="px-3 py-2.5 max-w-[280px]"><Identity m={m} /></td>
      <td className="px-3 py-2.5"><Score m={m} /></td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="w-10 tabular-nums text-right">{live ? fmtPct(m.latest?.cpuPct) : '—'}</span>
          <Sparkline values={m.spark.map((p) => p.cpu)} tone="stroke-sky-400" />
        </div>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="w-10 tabular-nums text-right">{live ? fmtPct(m.latest?.memPct) : '—'}</span>
          <Sparkline values={m.spark.map((p) => p.mem)} tone="stroke-violet-400" />
        </div>
      </td>
      <td className="px-3 py-2.5">
        {d ? (
          <div title={d.mount}>
            <div className="flex justify-between text-xs mb-1"><span className="truncate max-w-[90px] text-muted-foreground">{d.mount}</span><span className="tabular-nums">{Math.round(d.pct)}%</span></div>
            <PctBar pct={d.pct} warn={t?.diskWarnPct} crit={t?.diskCritPct} />
          </div>
        ) : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="px-3 py-2.5 text-xs tabular-nums">
        <span className="text-emerald-400">{fmtDuration(m.availability.week.onlineSec)}</span>
        <span className="text-muted-foreground"> on · {fmtDuration(m.availability.week.offlineSec)} off</span>
      </td>
      <td className="px-3 py-2.5 text-xs"><IssueText m={m} /></td>
    </tr>
  );
}

function MobileCard({ m, t, onOpen }: { m: HealthMachine; t?: HealthThresholds; onOpen: () => void }) {
  const d = worstDisk(m);
  const live = m.status !== 'offline';
  return (
    <button onClick={onOpen} className="text-left rounded-lg border border-border bg-card p-3 hover:border-primary/40">
      <div className="flex items-start justify-between gap-2">
        <Identity m={m} />
        <Score m={m} />
      </div>
      <div className="grid grid-cols-3 gap-3 mt-3 text-xs">
        <div><p className="text-muted-foreground">CPU</p><p className="tabular-nums">{live ? fmtPct(m.latest?.cpuPct) : '—'}</p></div>
        <div><p className="text-muted-foreground">Memory</p><p className="tabular-nums">{live ? fmtPct(m.latest?.memPct) : '—'}</p></div>
        <div>
          <p className="text-muted-foreground truncate">Disk {d?.mount ?? ''}</p>
          <p className="tabular-nums">{d ? `${Math.round(d.pct)}%` : '—'}</p>
          {d && <PctBar pct={d.pct} warn={t?.diskWarnPct} crit={t?.diskCritPct} className="mt-1" />}
        </div>
      </div>
      <div className="mt-2 text-xs"><IssueText m={m} /></div>
    </button>
  );
}

function SettingsDialog({ settings, onClose, onSaved }: { settings: HealthSettings; onClose: () => void; onSaved: () => void }) {
  const [interval, setIntervalSec] = useState(String(settings.intervalSec));
  const [th, setTh] = useState<Record<keyof HealthThresholds, string>>(
    Object.fromEntries(Object.entries(settings.thresholds).map(([k, v]) => [k, String(v)])) as Record<keyof HealthThresholds, string>,
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fields: { key: keyof HealthThresholds; label: string; suffix: string }[] = [
    { key: 'diskWarnPct', label: 'Disk warning', suffix: '%' },
    { key: 'diskCritPct', label: 'Disk critical', suffix: '%' },
    { key: 'memWarnPct', label: 'Memory warning', suffix: '%' },
    { key: 'memCritPct', label: 'Memory critical', suffix: '%' },
    { key: 'memMinutes', label: 'Memory must stay high for', suffix: 'min' },
    { key: 'cpuWarnPct', label: 'CPU warning', suffix: '%' },
    { key: 'cpuMinutes', label: 'CPU must stay high for', suffix: 'min' },
    { key: 'offlineMinutes', label: 'Server counts as offline after', suffix: 'min' },
  ];
  async function save() {
    setBusy(true); setErr(null);
    try {
      await api.put('/api/machine-health/settings', {
        intervalSec: Number(interval),
        thresholds: Object.fromEntries(Object.entries(th).map(([k, v]) => [k, Number(v)])),
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Save failed.');
    } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title="Health settings" description="Applies to every machine. Laptops and desktops never alert for being offline."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Save</Button></>}>
      <div className="space-y-4">
        {err && <div className="text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">{err}</div>}
        <div>
          <Label htmlFor="hi">Report every (seconds)</Label>
          <Input id="hi" type="number" min={0} max={600} value={interval} onChange={(e) => setIntervalSec(e.target.value)} className="mt-1 w-32" />
          <p className="text-xs text-muted-foreground mt-1">5–600 seconds. 0 turns health reporting off on every agent. Changes apply live.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {fields.map((f) => (
            <div key={f.key}>
              <Label htmlFor={f.key}>{f.label}</Label>
              <div className="flex items-center gap-2 mt-1">
                <Input id={f.key} type="number" value={th[f.key]} onChange={(e) => setTh({ ...th, [f.key]: e.target.value })} className="w-24" />
                <span className="text-xs text-muted-foreground">{f.suffix}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
