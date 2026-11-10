import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, CheckCircle2, Cpu, FlaskConical, Loader2, Play, Server, TriangleAlert, XCircle } from 'lucide-react';
import type {
  BackupHost, HostRestoreInput, HostRestoreJob, HostRestorePlan, StackBackupPolicy, VerifySchedule, VerifyScheduleStatus,
} from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';

const selectCls = 'mt-1 w-full h-9 rounded-md border border-input bg-background/60 px-2 text-sm';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function errText(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

function fmtWhen(iso?: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString();
}

const VERIFY_LABEL: Record<string, { text: string; cls: string }> = {
  success: { text: 'passed', cls: 'text-emerald-400' },
  error: { text: 'FAILED', cls: 'text-destructive' },
  skipped: { text: 'skipped', cls: 'text-muted-foreground' },
  never: { text: 'not tested', cls: 'text-muted-foreground' },
};

// ── Scheduled test restores ─────────────────────────────────────────────────

/**
 * The test-restore rotation: when it runs, where, and how every stack fared the
 * last time it came round. A test brings the latest backup up in a throwaway
 * copy with no published ports, waits for it to be healthy, then removes it.
 */
export function TestRestoresCard({ policies, hosts, canRestore, onChanged, onError }: {
  policies: StackBackupPolicy[];
  hosts: BackupHost[];
  canRestore: boolean;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [status, setStatus] = useState<VerifyScheduleStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setStatus(await api.get<VerifyScheduleStatus>('/api/stack-backup/verify-schedule')); }
    catch { /* card just stays in its loading state */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // While a rotation runs, follow it — each finished stack updates its row.
  useEffect(() => {
    if (!status?.running) return;
    const t = setInterval(() => { void load(); onChanged(); }, 5000);
    return () => clearInterval(t);
  }, [status?.running, load, onChanged]);

  const sorted = useMemo(
    () => [...policies].sort((a, b) =>
      (a.verifyStatus === 'error' ? 0 : 1) - (b.verifyStatus === 'error' ? 0 : 1) || a.stackName.localeCompare(b.stackName)),
    [policies],
  );
  const failed = policies.filter((p) => p.verifyStatus === 'error').length;
  const tested = policies.filter((p) => p.verifyStatus === 'success').length;

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    try { await fn(); await load(); onChanged(); }
    catch (e) { onError(errText(e, 'Could not start the test restore.')); }
    finally { setBusy(null); }
  }

  if (!policies.length) return null;

  return (
    <Card className="mb-6">
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2"><FlaskConical className="h-4 w-4" /> Test restores</CardTitle>
            <CardDescription>
              A backup only counts once it has been restored. Each run brings the latest backup of the stacks tested
              longest ago up in a throwaway copy (no published ports), checks it comes up healthy, then removes it.
            </CardDescription>
          </div>
          {canRestore && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy || status?.running}
                onClick={() => run('rot', () => api.post('/api/stack-backup/verify-schedule/run'))}
              >
                {status?.running || busy === 'rot' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
                Run now
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={!status}>Schedule</Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {status && (
          <div className="mb-3 text-sm flex items-center gap-2 flex-wrap">
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
            {status.enabled ? (
              <span>
                {status.frequency === 'daily' ? 'Daily' : `Weekly on ${DAY_NAMES[status.dayOfWeek]}`} at{' '}
                {String(status.hour).padStart(2, '0')}:{String(status.minute).padStart(2, '0')},{' '}
                {status.stacksPerRun} stack(s) per run, on{' '}
                {status.scratchHostName ? <strong>{status.scratchHostName}</strong> : 'each stack’s own host'}
                {status.nextRunAt && <span className="text-muted-foreground"> · next {fmtWhen(status.nextRunAt)}</span>}
              </span>
            ) : (
              <span className="text-muted-foreground">Not scheduled — use “Schedule” to turn it on, or test one stack with its button.</span>
            )}
            <span className="text-muted-foreground">· {tested} of {policies.length} passed{failed ? `, ${failed} failed` : ''}</span>
          </div>
        )}
        {status?.lastRunMessage && (
          <div className="mb-3 text-xs text-muted-foreground">Last run {fmtWhen(status.lastRunAt)}: {status.lastRunMessage}</div>
        )}
        <div className="divide-y divide-border">
          {sorted.map((p) => {
            const label = VERIFY_LABEL[p.verifyStatus] ?? VERIFY_LABEL.never;
            return (
              <div key={p.id} className="py-2 flex items-center gap-3 flex-wrap">
                {p.verifyStatus === 'success' ? <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                  : p.verifyStatus === 'error' ? <XCircle className="h-4 w-4 text-destructive shrink-0" />
                  : <FlaskConical className="h-4 w-4 text-muted-foreground shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">
                    {p.stackName}<span className="text-muted-foreground"> on {p.hostName ?? p.connectorInstanceId}</span>
                  </div>
                  {p.verifyMessage && (
                    <div className="text-xs text-muted-foreground truncate" title={p.verifyMessage}>{p.verifyMessage}</div>
                  )}
                </div>
                <div className="text-xs text-right w-44">
                  <div className={label.cls}>{label.text}</div>
                  <div className="text-muted-foreground">{p.verifiedAt ? fmtWhen(p.verifiedAt) : '—'}</div>
                </div>
                {canRestore && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!!busy || p.lastStatus !== 'success'}
                    title={p.lastStatus !== 'success' ? 'Needs a successful backup first' : 'Test-restore the latest backup now'}
                    onClick={() => run(`v:${p.id}`, () => api.post(`/api/stack-backup/policies/${p.id}/verify`))}
                  >
                    {busy === `v:${p.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Test now'}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
      {editing && status && (
        <VerifyScheduleDialog
          status={status}
          hosts={hosts}
          onClose={() => setEditing(false)}
          onSaved={(s) => { setStatus(s); setEditing(false); }}
        />
      )}
    </Card>
  );
}

function VerifyScheduleDialog({ status, hosts, onClose, onSaved }: {
  status: VerifyScheduleStatus;
  hosts: BackupHost[];
  onClose: () => void;
  onSaved: (s: VerifyScheduleStatus) => void;
}) {
  const [form, setForm] = useState<VerifySchedule>({
    enabled: status.enabled,
    frequency: status.frequency,
    dayOfWeek: status.dayOfWeek,
    hour: status.hour,
    minute: status.minute,
    scratchInstanceId: status.scratchInstanceId,
    stacksPerRun: status.stacksPerRun,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof VerifySchedule>(k: K, v: VerifySchedule[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true); setErr(null);
    try { onSaved(await api.put<VerifyScheduleStatus>('/api/stack-backup/verify-schedule', form)); }
    catch (e) { setErr(errText(e, 'Could not save the schedule.')); }
    finally { setSaving(false); }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Test restore schedule"
      description="Every run tests the stacks whose last test is oldest, so all of them come round in turn."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Save
          </Button>
        </>
      }
    >
      {err && <div className="mb-3 text-sm text-destructive">{err}</div>}
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Run test restores on a schedule
        </label>
        <fieldset disabled={!form.enabled} className="space-y-3 disabled:opacity-60">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>How often</Label>
              <select className={selectCls} value={form.frequency} onChange={(e) => set('frequency', e.target.value as VerifySchedule['frequency'])}>
                <option value="weekly">Weekly</option>
                <option value="daily">Daily</option>
              </select>
            </div>
            {form.frequency === 'weekly' && (
              <div>
                <Label>Day</Label>
                <select className={selectCls} value={form.dayOfWeek} onChange={(e) => set('dayOfWeek', Number(e.target.value))}>
                  {DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select>
              </div>
            )}
            <div>
              <Label>Time</Label>
              <Input
                type="time"
                className="mt-1"
                value={`${String(form.hour).padStart(2, '0')}:${String(form.minute).padStart(2, '0')}`}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(':').map(Number);
                  setForm((f) => ({ ...f, hour: h || 0, minute: m || 0 }));
                }}
              />
            </div>
          </div>
          <div>
            <Label>Stacks per run</Label>
            <Input type="number" min={1} max={10} value={form.stacksPerRun} onChange={(e) => set('stacksPerRun', Number(e.target.value) || 1)} />
          </div>
        </fieldset>
        <div>
          <Label>Run the test copies on</Label>
          <select
            className={selectCls}
            value={form.scratchInstanceId ?? ''}
            onChange={(e) => set('scratchInstanceId', e.target.value || null)}
          >
            <option value="">Each stack’s own host</option>
            {hosts.filter((h) => h.enabled).map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
          <p className="text-xs text-muted-foreground mt-1">
            A spare Docker host keeps the extra load off the real ones and also proves the backup restores somewhere
            else. It needs the same CPU type as the hosts it tests (a Pi’s arm images will not run on x86, and the other
            way round), and room for the largest stack’s data.
          </p>
        </div>
      </div>
    </Dialog>
  );
}

// ── Whole-host restore ──────────────────────────────────────────────────────

const STACK_STATUS: Record<string, { text: string; cls: string }> = {
  ready: { text: 'ready', cls: 'text-emerald-400' },
  warning: { text: 'read warnings', cls: 'text-amber-400' },
  blocked: { text: 'cannot restore', cls: 'text-destructive' },
  'no-snapshot': { text: 'no backup', cls: 'text-muted-foreground' },
};

/**
 * Restore every backed-up stack from one host onto another (or onto the same host
 * after it was rebuilt). The plan shows every per-stack check up front; the run
 * restores the chosen stacks one at a time and carries on past a failure.
 */
export function HostRestoreDialog({ hosts, policies, onClose, onStarted }: {
  hosts: BackupHost[];
  policies: StackBackupPolicy[];
  onClose: () => void;
  onStarted: (job: HostRestoreJob) => void;
}) {
  const sources = useMemo(() => {
    const ids = new Set(policies.map((p) => p.connectorInstanceId));
    return hosts.filter((h) => ids.has(h.id));
  }, [hosts, policies]);
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [destId, setDestId] = useState(sources[0]?.id ?? hosts[0]?.id ?? '');
  const [plan, setPlan] = useState<HostRestorePlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [deploy, setDeploy] = useState(true);
  const [includeBinds, setIncludeBinds] = useState(true);
  const [imageVersion, setImageVersion] = useState<'pinned' | 'tag'>('pinned');
  const [confirmHost, setConfirmHost] = useState('');
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!sourceId || !destId) return;
    let cancelled = false;
    setPlanning(true); setErr(null); setPlan(null);
    api.post<HostRestorePlan>('/api/stack-backup/host-restore/plan', { sourceInstanceId: sourceId, destInstanceId: destId })
      .then((p) => {
        if (cancelled) return;
        setPlan(p);
        setChosen(p.stacks.filter((s) => s.status === 'ready' || s.status === 'warning').map((s) => s.policyId));
      })
      .catch((e) => { if (!cancelled) setErr(errText(e, 'Could not build the plan.')); })
      .finally(() => { if (!cancelled) setPlanning(false); });
    return () => { cancelled = true; };
  }, [sourceId, destId]);

  const selected = plan?.stacks.filter((s) => chosen.includes(s.policyId)) ?? [];
  const overwrites = selected.flatMap((s) => s.overwrites.map((o) => `${s.stackName}: ${o}`));
  const needsConfirm = overwrites.length > 0;
  const cpuDiffers = plan?.sourcePlatform && plan.destPlatform && plan.sourcePlatform !== plan.destPlatform;

  async function start() {
    if (!plan) return;
    setStarting(true); setErr(null);
    try {
      const body: HostRestoreInput = {
        sourceInstanceId: plan.sourceInstanceId,
        destInstanceId: plan.destInstanceId,
        stacks: selected.map((s) => ({ policyId: s.policyId, snapshotId: s.snapshotId! })),
        deploy,
        includeBinds,
        imageVersion,
        confirmHost: needsConfirm ? confirmHost : undefined,
      };
      onStarted(await api.post<HostRestoreJob>('/api/stack-backup/host-restore', body));
    } catch (e) {
      setErr(errText(e, 'Could not start the restore.'));
    } finally {
      setStarting(false);
    }
  }

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title="Restore a whole host"
      description="Every stack backed up from one Docker host, restored one after another — onto a replacement host, or onto the same one after a rebuild."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => void start()}
            disabled={!plan || planning || starting || !selected.length || (needsConfirm && confirmHost.trim() !== plan.destHostName)}
          >
            {starting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Restore {selected.length} stack(s)
          </Button>
        </>
      }
    >
      {err && <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</div>}
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Stacks backed up from</Label>
            <select className={selectCls} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {sources.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>
          <div>
            <Label>Restore onto</Label>
            <select className={selectCls} value={destId} onChange={(e) => setDestId(e.target.value)}>
              {hosts.filter((h) => h.enabled).map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>
        </div>

        {planning && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" /> Checking every stack against the destination…
          </div>
        )}

        {plan && (
          <>
            {cpuDiffers && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300 flex gap-2">
                <Cpu className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  Different CPU: these backups came from a {plan.sourcePlatform} host and {plan.destHostName} is{' '}
                  {plan.destPlatform}. Stacks whose images have no {plan.destPlatform} build are flagged below.
                </span>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between">
                <Label>Stacks</Label>
                <span className="text-xs text-muted-foreground">Restored in this order. A failure does not stop the rest.</span>
              </div>
              <div className="mt-1 divide-y divide-border rounded-md border border-border">
                {plan.stacks.map((s) => {
                  const st = STACK_STATUS[s.status];
                  const pickable = s.status === 'ready' || s.status === 'warning';
                  const notes = [...s.conflicts, ...s.imageProblems, ...s.warnings];
                  return (
                    <label key={s.policyId} className={`flex items-start gap-3 px-3 py-2 ${pickable ? 'cursor-pointer' : 'opacity-70'}`}>
                      <input
                        type="checkbox"
                        className="mt-1"
                        disabled={!pickable}
                        checked={chosen.includes(s.policyId)}
                        onChange={(e) => setChosen((c) => (e.target.checked ? [...c, s.policyId] : c.filter((x) => x !== s.policyId)))}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm flex items-center gap-2 flex-wrap">
                          <span className="font-medium">{s.stackName}</span>
                          <span className={`text-xs ${st.cls}`}>{st.text}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {s.snapshotId
                            ? <>backup {s.snapshotShortId} · {fmtWhen(s.snapshotTime)} · {s.volumes} volume(s), {s.binds} folder(s) · {s.targetName}{!s.hasCompose && ' · data only'}</>
                            : 'No successful backup yet'}
                        </div>
                        {notes.length > 0 && (
                          <ul className="mt-1 space-y-0.5">
                            {notes.map((n, i) => (
                              <li key={i} className={`text-xs ${s.conflicts.includes(n) ? 'text-destructive' : 'text-amber-300'}`}>{n}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={deploy} onChange={(e) => setDeploy(e.target.checked)} />
                Start each stack after restoring it
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={includeBinds} onChange={(e) => setIncludeBinds(e.target.checked)} />
                Restore backed-up folders too
              </label>
            </div>
            <div>
              <Label>Image versions</Label>
              <select className={selectCls} value={imageVersion} onChange={(e) => setImageVersion(e.target.value as 'pinned' | 'tag')}>
                <option value="pinned">The exact versions that were backed up (recommended)</option>
                <option value="tag">The current version of each tag</option>
              </select>
            </div>

            {needsConfirm && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
                <div className="text-sm font-medium flex items-center gap-2">
                  <TriangleAlert className="h-4 w-4 text-amber-400" /> This overwrites existing data on {plan.destHostName}
                </div>
                <ul className="text-xs text-muted-foreground font-mono max-h-28 overflow-auto">
                  {overwrites.map((o) => <li key={o}>{o}</li>)}
                </ul>
                <p className="text-xs text-muted-foreground">
                  Each stack takes a safety copy of what it overwrites first, so every one can be undone from the Restores list.
                </p>
                <div>
                  <Label>Type <span className="font-mono">{plan.destHostName}</span> to confirm</Label>
                  <Input className="mt-1" value={confirmHost} onChange={(e) => setConfirmHost(e.target.value)} />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

const JOB_ITEM_CLS: Record<string, string> = {
  success: 'text-emerald-400',
  error: 'text-destructive',
  running: 'text-amber-400',
  pending: 'text-muted-foreground',
  skipped: 'text-muted-foreground',
};

/** Recent whole-host restores, each with its stacks. Polls while one is running. */
export function HostRestoreJobsCard({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const [jobs, setJobs] = useState<HostRestoreJob[]>([]);
  const load = useCallback(async () => {
    try { setJobs(await api.get<HostRestoreJob[]>('/api/stack-backup/host-restores')); } catch { /* optional card */ }
  }, []);
  useEffect(() => { void load(); }, [load, refreshKey]);
  const running = jobs.some((j) => j.status === 'running');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { void load(); onChanged(); }, 4000);
    return () => clearInterval(t);
  }, [running, load, onChanged]);

  if (!jobs.length) return null;
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Server className="h-4 w-4" /> Whole-host restores</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {jobs.slice(0, 5).map((j) => (
          <div key={j.id} className="rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-sm font-medium">{j.sourceHostName} → {j.destHostName}</div>
              <div className={`text-xs inline-flex items-center gap-1 ${JOB_ITEM_CLS[j.status === 'partial' ? 'running' : j.status] ?? ''}`}>
                {j.status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
                {j.status} · {fmtWhen(j.startedAt)}
              </div>
            </div>
            {j.message && <div className="text-xs text-muted-foreground mt-0.5">{j.message}</div>}
            <ul className="mt-2 space-y-1">
              {j.items.map((it) => (
                <li key={it.policyId} className="text-xs flex items-center gap-2">
                  <span className={`w-16 shrink-0 ${JOB_ITEM_CLS[it.status] ?? ''}`}>
                    {it.status === 'running' ? <Loader2 className="h-3 w-3 animate-spin inline" /> : it.status}
                  </span>
                  <span className="font-medium">{it.stackName}</span>
                  {it.message && <span className="text-muted-foreground truncate" title={it.message}>{it.message}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
