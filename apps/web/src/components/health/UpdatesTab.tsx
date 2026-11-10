import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, Camera, Download, Loader2, Pencil, Play, RefreshCw, RotateCw, Search, X } from 'lucide-react';
import type { OsUpdateMachine, OsUpdateOverview, OsUpdateRun, OsUpdateSchedule } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { RoleIcon, fmtAgo, osLabel } from './health-ui';
import {
  InstallDialog, RebootDialog, REBOOT_LABEL, RunDialog, RunStatus, SCOPE_LABEL, ScheduleDialog, SigningNote, UpdatesChip, daysSince, managerLabel, runWhat, runWhen,
} from './updates-ui';

const REFRESH_MS = 15_000;
type Filter = 'updates' | 'security' | 'restart' | null;

/** Health → Updates: pending OS updates on every agent machine, installs, restarts and schedules. docs/os-updates.md */
export function UpdatesTab() {
  const { can } = useAuth();
  const manage = can('fabric:manage');
  const navigate = useNavigate();
  const [data, setData] = useState<OsUpdateOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [install, setInstall] = useState<OsUpdateMachine[] | null>(null);
  const [reboot, setReboot] = useState<OsUpdateMachine[] | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [editSched, setEditSched] = useState<OsUpdateSchedule | 'new' | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setData(await api.get<OsUpdateOverview>('/api/os-updates'));
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load updates.');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); const t = setInterval(load, REFRESH_MS); return () => clearInterval(t); }, []);

  const query = q.trim().toLowerCase();
  const visible = useMemo(() => (data?.machines ?? [])
    .filter((m) => (!filter || (filter === 'updates' ? m.total > 0 : filter === 'security' ? m.security > 0 : m.rebootRequired)))
    .filter((m) => !query || m.name.toLowerCase().includes(query))
    .sort((a, b) => b.security - a.security || Number(b.rebootRequired) - Number(a.rebootRequired) || b.total - a.total || a.name.localeCompare(b.name)), [data, filter, query]);
  const selected = (data?.machines ?? []).filter((m) => sel.has(m.agentId));

  async function checkNow(m: OsUpdateMachine) {
    try {
      const r = await api.post<{ requested: boolean }>(`/api/os-updates/machines/${m.agentId}/check`);
      setNote(r.requested ? `Checking ${m.name} for updates… this can take a minute or two.` : `${m.name} is offline.`);
      setTimeout(load, 4000);
    } catch (e) { setNote(e instanceof ApiError ? e.message : 'Check failed.'); }
  }
  async function runNow(s: OsUpdateSchedule) {
    try {
      const r = await api.post<{ runs: number }>(`/api/os-updates/schedules/${s.id}/run-now`);
      setNote(`"${s.name}" opened its window now: ${r.runs} run${r.runs === 1 ? '' : 's'} queued.`);
      load();
    } catch (e) { setNote(e instanceof ApiError ? e.message : 'Run failed.'); }
  }
  const started = (runs: OsUpdateRun[]) => { setSel(new Set()); load(); if (runs.length === 1) setRunId(runs[0].id); };

  const tot = data?.totals;
  const tiles: { label: string; value: number; key: Filter; tone?: string }[] = tot ? [
    { label: 'Machines', value: tot.machines, key: null },
    { label: 'Have updates', value: tot.withUpdates, key: 'updates' },
    { label: 'Security', value: tot.withSecurity, key: 'security', tone: tot.withSecurity ? 'text-amber-400' : undefined },
    { label: 'Need restart', value: tot.needRestart, key: 'restart', tone: tot.needRestart ? 'text-amber-400' : undefined },
    { label: 'Failed · 7d', value: tot.failedRuns, key: null, tone: tot.failedRuns ? 'text-red-400' : undefined },
  ] : [];

  return (
    <>
      {err && <div className="mb-4 text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">{err}</div>}
      {!data && !err && <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>}
      {data && <SigningNote mode={data.signing.mode} message={data.signing.message} />}
      {note && (
        <div className="mb-4 text-sm rounded-md px-3 py-2 border border-border bg-muted/30 flex justify-between gap-2">
          <span>{note}</span><button onClick={() => setNote(null)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-4">
            {tiles.map((tile) => {
              const active = filter === tile.key && tile.key !== null;
              return (
                <button key={tile.label} onClick={() => setFilter(active || tile.key === null ? null : tile.key)}
                  className={cn('rounded-lg border px-3 py-2 text-left transition-colors', active ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-primary/40')}>
                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{tile.label}</p>
                  <p className={cn('text-xl font-semibold tabular-nums', tile.tone)}>{tile.value}</p>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-8" placeholder="Search machines…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {manage && (
              <>
                <Button disabled={!selected.length} onClick={() => setInstall(selected)}><Download className="h-4 w-4" /> Install{selected.length ? ` (${selected.length})` : ''}</Button>
                <Button variant="outline" disabled={!selected.length} onClick={() => setReboot(selected)}><RotateCw className="h-4 w-4" /> Restart</Button>
              </>
            )}
            <Button variant="outline" onClick={load} disabled={loading}><RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /></Button>
          </div>

          <div className="hidden md:block rounded-lg border border-border overflow-x-auto mb-6">
            <table className="w-full text-sm min-w-[720px]">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  {manage && (
                    <th className="w-8 px-3 py-2">
                      <input type="checkbox" aria-label="Select all" checked={!!visible.length && visible.every((m) => sel.has(m.agentId))}
                        onChange={(e) => setSel(e.target.checked ? new Set(visible.map((m) => m.agentId)) : new Set())} />
                    </th>
                  )}
                  <th className="text-left font-medium px-3 py-2">Machine</th>
                  <th className="text-left font-medium px-3 py-2">Pending</th>
                  <th className="text-left font-medium px-3 py-2">Checked</th>
                  <th className="text-left font-medium px-3 py-2">Last run</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {visible.map((m) => (
                  <tr key={m.agentId} className="border-t border-border hover:bg-muted/30 align-middle">
                    {manage && <td className="px-3 py-2"><input type="checkbox" aria-label={`Select ${m.name}`} checked={sel.has(m.agentId)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(m.agentId); else n.delete(m.agentId); setSel(n); }} /></td>}
                    <td className="px-3 py-2 cursor-pointer" onClick={() => navigate(`/health/${m.agentId}`)}>
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={cn('h-2 w-2 rounded-full shrink-0', m.online ? 'bg-emerald-400' : 'bg-muted-foreground/50')} title={m.online ? 'Online' : 'Offline'} />
                        <RoleIcon role={m.role} className="text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <div className="font-medium truncate">{m.name}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            {osLabel(m.os)}{m.manager ? ` · ${managerLabel(m.manager)}` : ''}{m.proxmoxGuest ? ` · ${m.proxmoxGuest.kind === 'lxc' ? 'CT' : 'VM'} ${m.proxmoxGuest.vmid}` : ''}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {m.agentTooOld ? <span className="text-muted-foreground">Agent {m.agentVersion} (updating itself)</span> : <UpdatesChip u={m} />}
                      {m.security > 0 && (daysSince(m.securitySince) ?? 0) > 0 && <div className="text-[11px] text-muted-foreground">security waiting {daysSince(m.securitySince)}d</div>}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{m.checking ? 'checking…' : m.checkedAt ? fmtAgo(m.checkedAt) : '—'}</td>
                    <td className="px-3 py-2 text-xs">
                      {m.lastRun ? (
                        <button onClick={() => setRunId(m.lastRun!.id)} className="text-left hover:underline">
                          <RunStatus r={m.lastRun} /> <span className="text-muted-foreground">{runWhen(m.lastRun)}</span>
                        </button>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <Button variant="ghost" size="sm" onClick={() => checkNow(m)} disabled={!m.online || m.agentTooOld} title="Check for updates now">Check</Button>
                      {manage && <Button variant="ghost" size="sm" onClick={() => setInstall([m])} disabled={m.agentTooOld || m.mode !== 'on' || !!m.installing}>Install…</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visible.length && <p className="p-4 text-sm text-muted-foreground">{data.machines.length ? 'Nothing matches.' : 'No machines with the Cerebro agent yet.'}</p>}
          </div>

          {/* Phone: cards */}
          <div className="md:hidden grid gap-2 mb-6">
            {visible.map((m) => (
              <div key={m.agentId} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-start gap-2">
                  {manage && <input type="checkbox" className="mt-1" aria-label={`Select ${m.name}`} checked={sel.has(m.agentId)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(m.agentId); else n.delete(m.agentId); setSel(n); }} />}
                  <button className="min-w-0 flex-1 text-left" onClick={() => navigate(`/health/${m.agentId}`)}>
                    <div className="font-medium truncate flex items-center gap-1.5">
                      <span className={cn('h-2 w-2 rounded-full shrink-0', m.online ? 'bg-emerald-400' : 'bg-muted-foreground/50')} />{m.name}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{osLabel(m.os)}{m.manager ? ` · ${managerLabel(m.manager)}` : ''}{m.checkedAt ? ` · checked ${fmtAgo(m.checkedAt)}` : ''}</div>
                  </button>
                </div>
                <div className="mt-2 text-xs">{m.agentTooOld ? <span className="text-muted-foreground">Agent {m.agentVersion} (updating itself)</span> : <UpdatesChip u={m} />}</div>
                {m.lastRun && (
                  <button onClick={() => setRunId(m.lastRun!.id)} className="mt-1 text-xs text-left"><RunStatus r={m.lastRun} /> <span className="text-muted-foreground">{runWhen(m.lastRun)}</span></button>
                )}
                <div className="mt-2 flex gap-1">
                  <Button variant="outline" size="sm" onClick={() => checkNow(m)} disabled={!m.online || m.agentTooOld}>Check</Button>
                  {manage && <Button variant="outline" size="sm" onClick={() => setInstall([m])} disabled={m.agentTooOld || m.mode !== 'on' || !!m.installing}>Install…</Button>}
                </div>
              </div>
            ))}
            {!visible.length && <p className="text-sm text-muted-foreground">{data.machines.length ? 'Nothing matches.' : 'No machines with the Cerebro agent yet.'}</p>}
          </div>

          <div className="flex items-center justify-between gap-2 mb-2">
            <h2 className="font-lcars text-lg flex items-center gap-2"><CalendarClock className="h-4 w-4" /> Schedules</h2>
            {manage && <Button variant="outline" size="sm" onClick={() => setEditSched('new')}>New schedule</Button>}
          </div>
          {data.schedules.length === 0 ? (
            <Card className="mb-6"><CardContent className="pt-6 text-sm text-muted-foreground">
              No schedules yet. A schedule installs updates on its own in a maintenance window, for example security updates every Sunday at 03:00. Rings let a few machines go first and the rest a day later.
            </CardContent></Card>
          ) : (
            <div className="grid gap-2 mb-6">
              {data.schedules.map((s) => {
                const count = s.rings.reduce((n, r) => n + r.agentIds.length, 0);
                return (
                  <div key={s.id} className="rounded-lg border border-border bg-card px-3 py-2.5 flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">{s.name} {!s.enabled && <span className="text-xs text-muted-foreground font-normal">· off</span>}</p>
                      <p className="text-xs text-muted-foreground">
                        {s.description} · {SCOPE_LABEL[s.scope].toLowerCase()} · {REBOOT_LABEL[s.reboot].toLowerCase()} · {count} machine{count === 1 ? '' : 's'}
                        {s.rings.length > 1 ? ` in ${s.rings.length} rings` : ''}{s.snapshot ? ' · snapshot first' : ''}
                      </p>
                      <p className="text-xs text-muted-foreground">{s.enabled && s.nextRunAt ? `Next: ${new Date(s.nextRunAt).toLocaleString()}` : 'Not scheduled'}{s.lastFiredAt ? ` · last ${fmtAgo(s.lastFiredAt)}` : ''}</p>
                    </div>
                    {manage && (
                      <div className="flex gap-1">
                        <Button variant="ghost" size="sm" onClick={() => runNow(s)} title="Open the window now"><Play className="h-4 w-4" /> Run now</Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditSched(s)}><Pencil className="h-4 w-4" /> Edit</Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <h2 className="font-lcars text-lg mb-2">Recent runs</h2>
          {data.runs.length === 0 ? <p className="text-sm text-muted-foreground">No installs or restarts yet.</p> : (
            <div className="rounded-lg border border-border divide-y divide-border">
              {data.runs.slice(0, 40).map((r) => (
                <button key={r.id} onClick={() => setRunId(r.id)} className="w-full text-left px-3 py-2 hover:bg-muted/30 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-sm">
                  <span className="w-28 shrink-0 text-xs"><RunStatus r={r} /></span>
                  <span className="font-medium">{r.agentName}</span>
                  <span className="text-xs text-muted-foreground">{runWhat(r)}{r.snapshotName ? <Camera className="inline h-3 w-3 ml-1" /> : null}</span>
                  <span className="text-xs text-muted-foreground">{r.scheduleName ? `${r.scheduleName}${r.ring != null ? ` · ring ${r.ring + 1}` : ''}` : r.requestedBy ?? ''}</span>
                  <span className="text-xs text-muted-foreground ml-auto">{runWhen(r)}</span>
                  {r.message && !['succeeded'].includes(r.status) && <span className="basis-full text-xs text-muted-foreground truncate">{r.message}</span>}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {install && <InstallDialog machines={install} onClose={() => setInstall(null)} onDone={started} />}
      {reboot && <RebootDialog machines={reboot} onClose={() => setReboot(null)} onDone={started} />}
      {runId && <RunDialog runId={runId} canManage={manage} onClose={() => setRunId(null)} onChanged={load} />}
      {editSched && data && (
        <ScheduleDialog schedule={editSched === 'new' ? null : editSched} machines={data.machines} onClose={() => setEditSched(null)} onSaved={() => { setEditSched(null); load(); }} />
      )}
    </>
  );
}
