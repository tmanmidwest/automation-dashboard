import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Camera, CheckCircle2, Clock, Loader2, Plus, RotateCw, ShieldAlert, Trash2, XCircle } from 'lucide-react';
import type {
  OsUpdateMachine,
  OsUpdateReboot,
  OsUpdateRun,
  OsUpdateRunStatus,
  OsUpdateSchedule,
  OsUpdateScheduleInput,
  OsUpdateScope,
  OsUpdateStatus,
} from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { fmtAgo } from './health-ui';

/** OS updates UI pieces shared by the Health pages. docs/os-updates.md */

export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const RUN_STYLE: Record<OsUpdateRunStatus, { label: string; text: string }> = {
  scheduled: { label: 'Scheduled', text: 'text-sky-300' },
  snapshot: { label: 'Taking snapshot', text: 'text-sky-300' },
  sent: { label: 'Starting', text: 'text-sky-300' },
  running: { label: 'Installing', text: 'text-sky-300' },
  succeeded: { label: 'Done', text: 'text-emerald-400' },
  failed: { label: 'Failed', text: 'text-red-400' },
  refused: { label: 'Refused', text: 'text-red-400' },
  missed: { label: 'Missed', text: 'text-amber-400' },
  cancelled: { label: 'Cancelled', text: 'text-muted-foreground' },
  unknown: { label: 'No answer', text: 'text-amber-400' },
};

export const ACTIVE: OsUpdateRunStatus[] = ['scheduled', 'snapshot', 'sent', 'running'];

export const SCOPE_LABEL: Record<OsUpdateScope, string> = { security: 'Security only', all: 'All updates' };
export const REBOOT_LABEL: Record<OsUpdateReboot, string> = { never: "Don't restart", 'if-needed': 'Restart if needed', always: 'Always restart' };

export function managerLabel(m: string | null | undefined): string {
  switch (m) {
    case 'apt': return 'apt';
    case 'windows-update': return 'Windows Update';
    case 'softwareupdate': return 'Software Update';
    default: return m ?? '';
  }
}

export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/** Compact "12 · 3 security" chip with a restart marker. */
export function UpdatesChip({ u, className }: { u: OsUpdateStatus | null | undefined; className?: string }) {
  if (!u) return <span className={cn('text-muted-foreground', className)}>—</span>;
  if (u.mode === 'off') return <span className={cn('text-muted-foreground', className)}>Off</span>;
  if (!u.checkedAt) return <span className={cn('text-muted-foreground', className)}>{u.checking ? 'Checking…' : 'Not checked yet'}</span>;
  if (u.error && !u.total) return <span className={cn('text-amber-400', className)} title={u.error}>Check failed</span>;
  const secDays = daysSince(u.securitySince);
  return (
    <span className={cn('inline-flex items-center gap-1.5 flex-wrap', className)}>
      {u.installing ? (
        <span className="text-sky-300 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Installing</span>
      ) : u.total === 0 && u.security === 0 ? (
        <span className="text-emerald-400">Up to date</span>
      ) : (
        <>
          <span className="tabular-nums">{u.total}</span>
          {u.security > 0 && (
            <span className={cn('tabular-nums', (secDays ?? 0) >= 7 ? 'text-red-400' : 'text-amber-400')} title={secDays != null ? `Waiting ${secDays} day${secDays === 1 ? '' : 's'}` : undefined}>
              · {u.security} security
            </span>
          )}
        </>
      )}
      {u.rebootRequired && <span className="text-amber-400 inline-flex items-center gap-0.5" title={u.rebootReason ?? 'Restart needed'}><RotateCw className="h-3 w-3" /> restart</span>}
    </span>
  );
}

export function RunStatus({ r }: { r: OsUpdateRun }) {
  const s = RUN_STYLE[r.status];
  return (
    <span className={cn('inline-flex items-center gap-1', s.text)}>
      {ACTIVE.includes(r.status) && r.status !== 'scheduled' ? <Loader2 className="h-3 w-3 animate-spin" /> : r.status === 'succeeded' ? <CheckCircle2 className="h-3 w-3" /> : ['failed', 'refused'].includes(r.status) ? <XCircle className="h-3 w-3" /> : r.status === 'scheduled' ? <Clock className="h-3 w-3" /> : null}
      {s.label}
    </span>
  );
}

export function runWhen(r: OsUpdateRun): string {
  if (r.status === 'scheduled' && r.scheduledFor && new Date(r.scheduledFor).getTime() > Date.now()) return `at ${new Date(r.scheduledFor).toLocaleString()}`;
  if (r.finishedAt) return fmtAgo(r.finishedAt);
  if (r.startedAt) return `started ${fmtAgo(r.startedAt)}`;
  return fmtAgo(r.createdAt);
}

export function runWhat(r: OsUpdateRun): string {
  if (r.kind === 'reboot') return 'Restart';
  return `${SCOPE_LABEL[r.scope]}${r.reboot !== 'never' ? ` · ${REBOOT_LABEL[r.reboot].toLowerCase()}` : ''}`;
}

function Err({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return <div className="text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">{msg}</div>;
}

function WhenPicker({ later, setLater, at, setAt }: { later: boolean; setLater: (v: boolean) => void; at: string; setAt: (v: string) => void }) {
  return (
    <div>
      <Label>When</Label>
      <div className="flex flex-wrap items-center gap-3 mt-1 text-sm">
        <label className="flex items-center gap-1.5"><input type="radio" checked={!later} onChange={() => setLater(false)} /> Now</label>
        <label className="flex items-center gap-1.5"><input type="radio" checked={later} onChange={() => setLater(true)} /> Later</label>
        {later && <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="w-56" />}
      </div>
      {later && <p className="text-xs text-muted-foreground mt-1">A machine that's offline then gets up to 4 hours to come back before the run counts as missed.</p>}
    </div>
  );
}

function defaultLater(): string {
  const d = new Date(Date.now() + 86_400_000);
  d.setHours(3, 0, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

type Skipped = { agentId: string; name: string; reason: string }[];

/** Install updates on one or more machines. */
export function InstallDialog({ machines, onClose, onDone }: { machines: OsUpdateMachine[]; onClose: () => void; onDone: (runs: OsUpdateRun[]) => void }) {
  const anySecurity = machines.some((m) => m.security > 0);
  const [scope, setScope] = useState<OsUpdateScope>(anySecurity ? 'security' : 'all');
  const [reboot, setReboot] = useState<OsUpdateReboot>('if-needed');
  const guests = machines.filter((m) => m.proxmoxGuest);
  const [snapshot, setSnapshot] = useState(guests.length > 0);
  const [later, setLater] = useState(false);
  const [at, setAt] = useState(defaultLater());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Skipped | null>(null);
  const noSecurityKnown = machines.filter((m) => m.checkedAt && !m.securityKnown);
  const servers = machines.filter((m) => m.role === 'server' && (m.rebootRequired || reboot === 'always'));

  async function go() {
    setBusy(true); setErr(null);
    try {
      const res = await api.post<{ runs: OsUpdateRun[]; skipped: Skipped }>('/api/os-updates/install', {
        agentIds: machines.map((m) => m.agentId), scope, reboot, snapshot, ...(later ? { at: new Date(at).toISOString() } : {}),
      });
      if (res.skipped.length) {
        setSkipped(res.skipped);
        if (res.runs.length) onDone(res.runs);
        return;
      }
      onDone(res.runs);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Request failed.');
    } finally { setBusy(false); }
  }

  const title = machines.length === 1 ? `Install updates on ${machines[0].name}` : `Install updates on ${machines.length} machines`;
  return (
    <Dialog open onClose={onClose} title={title} description="The agent runs the machine's own package manager (or Windows Update) and streams its output here."
      footer={skipped ? <Button onClick={onClose}>Close</Button> : <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={go} disabled={busy || (later && !at)}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} {later ? 'Schedule' : 'Install now'}</Button></>}>
      <div className="space-y-4 text-sm">
        <Err msg={err} />
        {skipped && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 space-y-1">
            <p className="font-medium text-amber-300">{skipped.length} machine{skipped.length === 1 ? ' was' : 's were'} skipped:</p>
            {skipped.map((s) => <p key={s.agentId} className="text-xs"><span className="font-medium">{s.name}:</span> {s.reason}</p>)}
          </div>
        )}
        {!skipped && (
          <>
            {machines.length > 1 && <p className="text-xs text-muted-foreground">{machines.map((m) => m.name).join(', ')}</p>}
            <div>
              <Label>What to install</Label>
              <div className="flex flex-wrap gap-3 mt-1">
                {(['security', 'all'] as OsUpdateScope[]).map((s) => (
                  <label key={s} className="flex items-center gap-1.5"><input type="radio" checked={scope === s} onChange={() => setScope(s)} /> {SCOPE_LABEL[s]}</label>
                ))}
              </div>
              {scope === 'security' && noSecurityKnown.length > 0 && (
                <p className="text-xs text-amber-300 mt-1">{noSecurityKnown.map((m) => m.name).join(', ')} can't tell security updates apart (Arch / Alpine), so nothing will be installed there. Pick All updates for {noSecurityKnown.length === 1 ? 'it' : 'them'}.</p>
              )}
            </div>
            <div>
              <Label>Afterwards</Label>
              <select value={reboot} onChange={(e) => setReboot(e.target.value as OsUpdateReboot)} className="mt-1 h-9 w-full rounded-md border border-border bg-card px-2">
                {(['if-needed', 'never', 'always'] as OsUpdateReboot[]).map((r) => <option key={r} value={r}>{REBOOT_LABEL[r]}</option>)}
              </select>
              <p className="text-xs text-muted-foreground mt-1">A restart starts about a minute after the install finishes, and only if it succeeded.</p>
              {reboot !== 'never' && servers.length > 0 && (
                <p className="text-xs text-amber-300 mt-1 flex gap-1"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" /> {servers.map((m) => m.name).join(', ')} will go down briefly. Anything running on {servers.length === 1 ? 'it' : 'them'} (containers, VMs on a Proxmox host) restarts too.</p>
              )}
            </div>
            {guests.length > 0 && (
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={snapshot} onChange={(e) => setSnapshot(e.target.checked)} className="mt-1" />
                <span>
                  <span className="flex items-center gap-1"><Camera className="h-3.5 w-3.5" /> Take a Proxmox snapshot first</span>
                  <span className="block text-xs text-muted-foreground">{guests.map((m) => `${m.name} (${m.proxmoxGuest!.kind === 'lxc' ? 'CT' : 'VM'} ${m.proxmoxGuest!.vmid})`).join(', ')}. If the snapshot fails, nothing is installed. Cerebro keeps its last 2 snapshots per guest.</span>
                </span>
              </label>
            )}
            <WhenPicker later={later} setLater={setLater} at={at} setAt={setAt} />
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Restart one or more machines. */
export function RebootDialog({ machines, onClose, onDone }: { machines: OsUpdateMachine[]; onClose: () => void; onDone: (runs: OsUpdateRun[]) => void }) {
  const [later, setLater] = useState(false);
  const [at, setAt] = useState(defaultLater());
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Skipped | null>(null);
  const word = machines.length === 1 ? machines[0].name : 'restart';
  async function go() {
    setBusy(true); setErr(null);
    try {
      const res = await api.post<{ runs: OsUpdateRun[]; skipped: Skipped }>('/api/os-updates/reboot', {
        agentIds: machines.map((m) => m.agentId), ...(later ? { at: new Date(at).toISOString() } : {}),
      });
      if (res.runs.length) onDone(res.runs);
      if (res.skipped.length) { setSkipped(res.skipped); return; }
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Request failed.');
    } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title={machines.length === 1 ? `Restart ${machines[0].name}` : `Restart ${machines.length} machines`}
      description="The machine restarts about a minute after it gets the command."
      footer={skipped ? <Button onClick={onClose}>Close</Button> : <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={go} disabled={busy || confirm.trim() !== word || (later && !at)}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} {later ? 'Schedule restart' : 'Restart now'}</Button></>}>
      <div className="space-y-4 text-sm">
        <Err msg={err} />
        {skipped ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 space-y-1">
            {skipped.map((s) => <p key={s.agentId} className="text-xs"><span className="font-medium">{s.name}:</span> {s.reason}</p>)}
          </div>
        ) : (
          <>
            {machines.length > 1 && <p className="text-xs text-muted-foreground">{machines.map((m) => m.name).join(', ')}</p>}
            <WhenPicker later={later} setLater={setLater} at={at} setAt={setAt} />
            <div>
              <Label htmlFor="rbconfirm">Type <span className="font-mono">{word}</span> to confirm</Label>
              <Input id="rbconfirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="mt-1" autoComplete="off" />
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** One run: status, options and the live output while it's going. */
export function RunDialog({ runId, canManage, onClose, onChanged }: { runId: string; canManage: boolean; onClose: () => void; onChanged?: () => void }) {
  const [run, setRun] = useState<OsUpdateRun | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const r = await api.get<OsUpdateRun>(`/api/os-updates/runs/${runId}`);
        if (stop) return;
        setRun(r);
        setErr(null);
        if (ACTIVE.includes(r.status)) timer = setTimeout(load, 2000);
        else onChanged?.();
      } catch (e) {
        if (!stop) setErr(e instanceof ApiError ? e.message : 'Failed to load.');
      }
    };
    load();
    return () => { stop = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);
  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [run?.log?.length]);

  async function cancel() {
    setBusy(true);
    try { setRun(await api.post<OsUpdateRun>(`/api/os-updates/runs/${runId}/cancel`)); onChanged?.(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Cancel failed.'); } finally { setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose} size="lg" title={run ? `${run.kind === 'reboot' ? 'Restart' : 'Updates'} · ${run.agentName}` : 'Update run'}
      description={run ? `${runWhat(run)}${run.scheduleName ? ` · ${run.scheduleName}${run.ring != null ? `, ring ${run.ring + 1}` : ''}` : run.requestedBy ? ` · by ${run.requestedBy}` : ''}` : undefined}
      footer={<>{canManage && run?.status === 'scheduled' && <Button variant="outline" onClick={cancel} disabled={busy}>Cancel run</Button>}<Button onClick={onClose}>Close</Button></>}>
      <div className="space-y-3 text-sm">
        <Err msg={err} />
        {!run && !err && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>}
        {run && (
          <>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <span><RunStatus r={run} /></span>
              <span className="text-muted-foreground">{runWhen(run)}</span>
              {run.installed != null && run.installed > 0 && <span>{run.installed} installed</span>}
              {run.pendingBefore != null && <span className="text-muted-foreground">{run.pendingBefore} pending before</span>}
              {run.rebooting && <span className="text-amber-300 inline-flex items-center gap-1"><RotateCw className="h-3.5 w-3.5" /> restarting</span>}
            </div>
            {run.message && <p className={cn(['failed', 'refused'].includes(run.status) ? 'text-red-300' : 'text-foreground')}>{run.message}</p>}
            {(run.snapshotNote || run.snapshotName) && <p className="text-xs text-muted-foreground flex items-center gap-1"><Camera className="h-3.5 w-3.5" /> {run.snapshotNote ?? run.snapshotName}</p>}
            {run.kind === 'install' && (
              <pre ref={logRef} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
                className="h-80 overflow-auto rounded-md border border-border bg-black/40 p-3 text-xs font-mono whitespace-pre-wrap break-words">
                {run.log && run.log.length ? run.log.join('\n') : run.status === 'scheduled' ? 'Waiting to start…' : ACTIVE.includes(run.status) ? 'Waiting for output…' : 'No output.'}
              </pre>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Create / edit an update schedule (maintenance window with rings). */
export function ScheduleDialog({ schedule, machines, onClose, onSaved }: { schedule: OsUpdateSchedule | null; machines: OsUpdateMachine[]; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState<OsUpdateScheduleInput>(() => schedule ? {
    name: schedule.name, enabled: schedule.enabled, days: schedule.days, hour: schedule.hour, minute: schedule.minute, windowHours: schedule.windowHours,
    scope: schedule.scope, reboot: schedule.reboot, snapshot: schedule.snapshot, rings: schedule.rings.map((r) => ({ ...r, agentIds: [...r.agentIds] })), stopOnFailure: schedule.stopOnFailure,
  } : {
    name: 'Weekly security updates', enabled: true, days: [0], hour: 3, minute: 0, windowHours: 4, scope: 'security', reboot: 'if-needed', snapshot: true,
    rings: [{ agentIds: [], delayHours: 0 }], stopOnFailure: true,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (p: Partial<OsUpdateScheduleInput>) => setV((x) => ({ ...x, ...p }));
  const inRing = new Map<string, number>();
  v.rings.forEach((r, i) => r.agentIds.forEach((a) => inRing.set(a, i)));
  const time = `${String(v.hour).padStart(2, '0')}:${String(v.minute).padStart(2, '0')}`;

  function toggleMachine(ring: number, id: string) {
    setV((x) => ({
      ...x,
      rings: x.rings.map((r, i) => ({ ...r, agentIds: i === ring ? (r.agentIds.includes(id) ? r.agentIds.filter((a) => a !== id) : [...r.agentIds, id]) : r.agentIds.filter((a) => a !== id) })),
    }));
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (schedule) await api.put(`/api/os-updates/schedules/${schedule.id}`, v);
      else await api.post('/api/os-updates/schedules', v);
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Save failed.');
    } finally { setBusy(false); }
  }
  async function remove() {
    if (!schedule) return;
    setBusy(true);
    try { await api.delete(`/api/os-updates/schedules/${schedule.id}`); onSaved(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Delete failed.'); setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose} size="lg" title={schedule ? 'Edit update schedule' : 'New update schedule'}
      description="Installs updates on its own in a maintenance window. Rings let a few machines go first; later rings wait and are held back if an earlier ring fails."
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <div>{schedule && (confirmDelete
            ? <span className="flex items-center gap-2 text-sm">Delete it? <Button variant="outline" size="sm" onClick={remove} disabled={busy}>Delete</Button><Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>No</Button></span>
            : <Button variant="ghost" onClick={() => setConfirmDelete(true)}><Trash2 className="h-4 w-4" /> Delete</Button>)}</div>
          <div className="flex gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Save</Button></div>
        </div>
      }>
      <div className="space-y-4 text-sm">
        <Err msg={err} />
        <div className="grid sm:grid-cols-[1fr_auto] gap-3 items-end">
          <div><Label htmlFor="sn">Name</Label><Input id="sn" value={v.name} onChange={(e) => set({ name: e.target.value })} className="mt-1" /></div>
          <label className="flex items-center gap-2 h-9"><input type="checkbox" checked={v.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Turned on</label>
        </div>
        <div>
          <Label>Days</Label>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {DAY_SHORT.map((d, i) => (
              <button key={d} type="button" onClick={() => set({ days: v.days.includes(i) ? v.days.filter((x) => x !== i) : [...v.days, i].sort() })}
                className={cn('h-8 w-12 rounded-md border text-xs', v.days.includes(i) ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:border-primary/40')}>{d}</button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <Label htmlFor="st">Starts at</Label>
            <Input id="st" type="time" value={time} onChange={(e) => { const [h, m] = e.target.value.split(':').map(Number); if (Number.isFinite(h) && Number.isFinite(m)) set({ hour: h, minute: m }); }} className="mt-1" />
          </div>
          <div>
            <Label htmlFor="sw">Window (hours)</Label>
            <Input id="sw" type="number" min={1} max={24} value={v.windowHours} onChange={(e) => set({ windowHours: Number(e.target.value) })} className="mt-1" />
          </div>
          <div>
            <Label>Install</Label>
            <select value={v.scope} onChange={(e) => set({ scope: e.target.value as OsUpdateScope })} className="mt-1 h-9 w-full rounded-md border border-border bg-card px-2">
              <option value="security">{SCOPE_LABEL.security}</option><option value="all">{SCOPE_LABEL.all}</option>
            </select>
          </div>
          <div>
            <Label>Afterwards</Label>
            <select value={v.reboot} onChange={(e) => set({ reboot: e.target.value as OsUpdateReboot })} className="mt-1 h-9 w-full rounded-md border border-border bg-card px-2">
              {(['if-needed', 'never', 'always'] as OsUpdateReboot[]).map((r) => <option key={r} value={r}>{REBOOT_LABEL[r]}</option>)}
            </select>
          </div>
        </div>
        <p className="text-xs text-muted-foreground -mt-2">Server time. A machine that's offline when its ring starts (a laptop that's asleep) gets until the window closes.</p>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex items-center gap-2"><input type="checkbox" checked={v.snapshot} onChange={(e) => set({ snapshot: e.target.checked })} /> Proxmox snapshot first (VMs and containers Cerebro can match)</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={v.stopOnFailure} onChange={(e) => set({ stopOnFailure: e.target.checked })} /> Hold back later rings if one fails</label>
        </div>

        <div className="space-y-3">
          {v.rings.map((r, i) => (
            <div key={i} className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="font-medium">Ring {i + 1} <span className="text-muted-foreground font-normal">· {r.agentIds.length} machine{r.agentIds.length === 1 ? '' : 's'}</span></p>
                <div className="flex items-center gap-2">
                  {i > 0 && (
                    <span className="flex items-center gap-1 text-xs">starts
                      <Input type="number" min={0} max={336} value={r.delayHours} onChange={(e) => setV((x) => ({ ...x, rings: x.rings.map((rr, j) => j === i ? { ...rr, delayHours: Number(e.target.value) } : rr) }))} className="h-7 w-16" />
                      h after ring 1</span>
                  )}
                  {i > 0 && <Button variant="ghost" size="icon" onClick={() => setV((x) => ({ ...x, rings: x.rings.filter((_, j) => j !== i) }))} aria-label="Remove ring"><Trash2 className="h-4 w-4" /></Button>}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {machines.map((m) => {
                  const here = r.agentIds.includes(m.agentId);
                  const other = inRing.get(m.agentId);
                  return (
                    <button key={m.agentId} type="button" onClick={() => toggleMachine(i, m.agentId)}
                      title={other != null && other !== i ? `In ring ${other + 1}; click to move it here` : undefined}
                      className={cn('rounded-full border px-2.5 py-1 text-xs', here ? 'border-primary bg-primary/15' : other != null ? 'border-border text-muted-foreground/50 line-through' : 'border-border text-muted-foreground hover:border-primary/40')}>
                      {m.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {v.rings.length < 5 && (
            <Button variant="outline" size="sm" onClick={() => setV((x) => ({ ...x, rings: [...x.rings, { agentIds: [], delayHours: (x.rings[x.rings.length - 1]?.delayHours ?? 0) + 24 }] }))}>
              <Plus className="h-4 w-4" /> Add ring
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Banner when Cerebro can't sign install commands. */
export function SigningNote({ mode, message }: { mode: 'off' | 'vault' | 'offline'; message?: string }) {
  if (mode === 'vault' || !message) return null;
  return (
    <div className={cn('mb-4 text-xs rounded-md px-3 py-2 border flex gap-2', mode === 'offline' ? 'border-amber-500/40 bg-amber-500/10 text-amber-200' : 'border-border bg-muted/30 text-muted-foreground')}>
      <ShieldAlert className="h-4 w-4 shrink-0" /> <span>{message}</span>
    </div>
  );
}
