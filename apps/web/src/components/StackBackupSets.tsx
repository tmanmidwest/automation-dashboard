import { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock, ChevronDown, ChevronRight, Cpu, EyeOff, FolderTree, HardDriveDownload, Layers, Loader2, Lock,
  Plus, RefreshCw, ShieldAlert, ShieldCheck, Trash2, TriangleAlert, Unplug,
} from 'lucide-react';
import type {
  AddSetMembersInput, BackupFrequency, BackupHost, CoverageReport, CoverageStatus, QuiesceMode, RunSetResult,
  SaveBackupSetInput, SecretMode, StackBackupCandidate, StackBackupPolicy, StackBackupSet, StackBackupTarget,
  StackCoverageRow, TransferMode,
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

// ── Coverage ────────────────────────────────────────────────────────────────

const STATUS_META: Record<CoverageStatus, { label: string; cls: string; hint: string }> = {
  protected: { label: 'protected', cls: 'text-emerald-400 border-emerald-500/40', hint: 'Scheduled, and the last success is recent.' },
  pending: { label: 'no backup yet', cls: 'text-sky-400 border-sky-500/40', hint: 'Scheduled, but no backup of it has succeeded yet.' },
  manual: { label: 'manual only', cls: 'text-sky-400 border-sky-500/40', hint: 'A backup exists, but nothing runs it on a schedule.' },
  stale: { label: 'overdue', cls: 'text-amber-400 border-amber-500/40', hint: 'Scheduled, but no success for well past its interval.' },
  failing: { label: 'failing', cls: 'text-destructive border-destructive/50', hint: 'The last backup failed.' },
  disabled: { label: 'switched off', cls: 'text-muted-foreground border-border', hint: 'The backup exists but is turned off.' },
  unprotected: { label: 'no backup', cls: 'text-destructive border-destructive/50', hint: 'Nothing backs this stack up.' },
  ignored: { label: 'ignored', cls: 'text-muted-foreground border-border', hint: 'Marked as not needing a backup.' },
  missing: { label: 'not on host', cls: 'text-amber-400 border-amber-500/40', hint: 'A backup is configured, but the stack is no longer on this host. Its runs will fail.' },
};

const ATTENTION: CoverageStatus[] = ['unprotected', 'failing', 'stale', 'missing'];

function StatusChip({ status }: { status: CoverageStatus }) {
  const m = STATUS_META[status];
  return (
    <span title={m.hint} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap ${m.cls}`}>
      {m.label}
    </span>
  );
}

/**
 * Every compose stack on every Docker host and how well it is backed up — the
 * question a list of configured backups cannot answer: what has NO backup?
 */
export function CoverageCard({ canWrite, sets, refreshKey, onBackUp, onChanged }: {
  canWrite: boolean;
  sets: StackBackupSet[];
  /** Bump to reload after something elsewhere on the page changed. */
  refreshKey: number;
  onBackUp: (connectorInstanceId: string, stackName: string) => void;
  onChanged: () => void;
}) {
  const [report, setReport] = useState<CoverageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [ignoreFor, setIgnoreFor] = useState<StackCoverageRow | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try { setReport(await api.get<CoverageReport>('/api/stack-backup/coverage')); }
    catch (e) { setErr(errText(e, 'Could not check coverage.')); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [refreshKey]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key); setErr(null);
    try { await fn(); await load(); onChanged(); }
    catch (e) { setErr(errText(e, 'Action failed.')); }
    finally { setBusy(null); }
  }

  const attentionCount = report ? ATTENTION.reduce((n, s) => n + report.totals[s], 0) : 0;

  return (
    <Card className="mb-6">
      <CardHeader>
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <CardTitle>Coverage</CardTitle>
            <CardDescription>
              Every compose stack Cerebro can see, and whether anything backs it up. New stacks that still have no
              backup an hour after they appear raise a “New stack with no backup” alert.
            </CardDescription>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={onlyAttention} onChange={(e) => setOnlyAttention(e.target.checked)} />
            Only what needs attention
          </label>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Rescan
          </Button>
        </div>
        {report && (
          <div className="flex gap-2 flex-wrap mt-2 text-xs">
            {(Object.keys(STATUS_META) as CoverageStatus[]).filter((s) => report.totals[s] > 0).map((s) => (
              <span key={s} className="inline-flex items-center gap-1"><StatusChip status={s} /> {report.totals[s]}</span>
            ))}
            {attentionCount === 0 && (
              <span className="inline-flex items-center gap-1 text-emerald-400"><ShieldCheck className="h-3.5 w-3.5" /> nothing needs attention</span>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent>
        {err && <div className="mb-3 text-sm text-destructive">{err}</div>}
        {!report ? (
          <div className="py-6 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></div>
        ) : !report.hosts.length ? (
          <p className="py-4 text-sm text-muted-foreground">No enabled Docker hosts.</p>
        ) : (
          <div className="space-y-3">
            {report.hosts.map((h) => {
              const rows = onlyAttention ? h.stacks.filter((r) => ATTENTION.includes(r.status)) : h.stacks;
              if (onlyAttention && !rows.length && h.reachable) return null;
              const open = !collapsed.has(h.connectorInstanceId);
              const hostAttention = h.stacks.filter((r) => ATTENTION.includes(r.status)).length;
              const setsForHost = sets.filter((s) => !s.connectorInstanceId || s.connectorInstanceId === h.connectorInstanceId);
              return (
                <div key={h.connectorInstanceId} className="rounded-md border border-border">
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/40"
                    onClick={() => setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(h.connectorInstanceId)) next.delete(h.connectorInstanceId); else next.add(h.connectorInstanceId);
                      return next;
                    })}
                  >
                    {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    <span className="font-medium">{h.hostName}</span>
                    {h.architecture && (
                      <span className="text-xs text-muted-foreground inline-flex items-center gap-1"><Cpu className="h-3 w-3" />{h.architecture}</span>
                    )}
                    <span className="text-xs text-muted-foreground">{h.stacks.length} stack(s)</span>
                    {hostAttention > 0 && <span className="text-xs text-amber-400">{hostAttention} need attention</span>}
                    {!h.reachable && (
                      <span className="text-xs text-destructive inline-flex items-center gap-1" title={h.error ?? undefined}>
                        <Unplug className="h-3 w-3" /> unreachable
                      </span>
                    )}
                  </button>
                  {open && (
                    <div className="divide-y divide-border border-t border-border">
                      {!h.reachable && (
                        <p className="px-3 py-2 text-xs text-muted-foreground">
                          Could not list stacks: {h.error}. Only stacks that already have a backup are shown.
                        </p>
                      )}
                      {rows.map((r) => (
                        <div key={r.stackName} className="px-3 py-2 flex items-center gap-3 flex-wrap">
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium truncate flex items-center gap-2">
                              {r.stackName}
                              <StatusChip status={r.status} />
                              {r.setName && (
                                <span className="text-xs text-muted-foreground font-normal inline-flex items-center gap-1"><Layers className="h-3 w-3" />{r.setName}</span>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap mt-0.5">
                              {r.policyId && <span>last success {fmtWhen(r.lastSuccessAt)}</span>}
                              {r.scheduleText && <><span>·</span><span>{r.scheduleText}</span></>}
                              {r.status === 'ignored' && r.ignoreReason && <span>“{r.ignoreReason}”</span>}
                              {r.managed && <><span>·</span><span>Cerebro-managed</span></>}
                              {r.uncapturedBinds.length > 0 && (
                                <span
                                  className="inline-flex items-center gap-1 text-amber-400"
                                  title={`Not captured:\n${r.uncapturedBinds.join('\n')}\n\nBind paths are opt-in per path — edit the stack's backup to include the ones holding data.`}
                                >
                                  <FolderTree className="h-3 w-3" /> {r.uncapturedBinds.length} bind path(s) not captured
                                </span>
                              )}
                            </div>
                          </div>
                          {canWrite && r.status === 'unprotected' && (
                            <div className="flex items-center gap-2">
                              <Button size="sm" variant="outline" onClick={() => onBackUp(r.connectorInstanceId, r.stackName)}>
                                <HardDriveDownload className="h-4 w-4" /> Back up
                              </Button>
                              {setsForHost.length > 0 && (
                                <select
                                  className="h-9 rounded-md border border-input bg-background/60 px-2 text-xs"
                                  value=""
                                  disabled={busy === `add:${r.stackName}`}
                                  onChange={(e) => {
                                    const setId = e.target.value;
                                    if (!setId) return;
                                    const body: AddSetMembersInput = { stacks: [{ connectorInstanceId: r.connectorInstanceId, stackName: r.stackName }] };
                                    void act(`add:${r.stackName}`, () => api.post(`/api/stack-backup/sets/${setId}/members`, body));
                                  }}
                                >
                                  <option value="">Add to set…</option>
                                  {setsForHost.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                                </select>
                              )}
                              <Button size="sm" variant="ghost" title="This stack does not need a backup" onClick={() => setIgnoreFor(r)}>
                                <EyeOff className="h-4 w-4" />
                              </Button>
                            </div>
                          )}
                          {canWrite && r.status === 'ignored' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy === `unign:${r.stackName}`}
                              onClick={() => void act(`unign:${r.stackName}`, () =>
                                api.put(`/api/stack-backup/coverage/${r.connectorInstanceId}/${encodeURIComponent(r.stackName)}/ignore`, { ignored: false }))}
                            >
                              Stop ignoring
                            </Button>
                          )}
                        </div>
                      ))}
                      {h.reachable && !rows.length && <p className="px-3 py-2 text-xs text-muted-foreground">No compose stacks on this host.</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
      {ignoreFor && (
        <IgnoreDialog
          row={ignoreFor}
          onClose={() => setIgnoreFor(null)}
          onConfirm={(reason) => {
            const r = ignoreFor;
            setIgnoreFor(null);
            void act(`ign:${r.stackName}`, () =>
              api.put(`/api/stack-backup/coverage/${r.connectorInstanceId}/${encodeURIComponent(r.stackName)}/ignore`, { ignored: true, reason }));
          }}
        />
      )}
    </Card>
  );
}

function IgnoreDialog({ row, onClose, onConfirm }: { row: StackCoverageRow; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Don't back up ${row.stackName}?`}
      description="It stays listed as ignored, never raises the no-backup alert, and auto-include sets skip it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onConfirm(reason)}>Ignore</Button>
        </>
      }
    >
      <Label>Why <span className="text-muted-foreground font-normal">(optional)</span></Label>
      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Stateless — rebuilt from its image" />
    </Dialog>
  );
}

// ── Sets ────────────────────────────────────────────────────────────────────

const OVERRIDE_LABEL: Record<string, string> = {
  target: 'repository', schedule: 'schedule', quiesce: 'consistency', transfer: 'transfer', secretMode: 'secrets', excludes: 'excludes',
};

/** Backup sets: shared settings for a group of stacks, optionally every stack on a host. */
export function SetsCard({ sets, targets, hosts, policies, canWrite, onEdit, onChanged, onError }: {
  sets: StackBackupSet[];
  targets: StackBackupTarget[];
  hosts: BackupHost[];
  policies: StackBackupPolicy[];
  canWrite: boolean;
  onEdit: (set: StackBackupSet | 'new') => void;
  onChanged: () => void;
  onError: (m: string | null) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [addFor, setAddFor] = useState<StackBackupSet | null>(null);
  const [removeFor, setRemoveFor] = useState<{ set: StackBackupSet; policyId: string; stackName: string } | null>(null);
  const [deleteFor, setDeleteFor] = useState<StackBackupSet | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key); onError(null); setNotice(null);
    try { await fn(); onChanged(); }
    catch (e) { onError(errText(e, 'Action failed.')); }
    finally { setBusy(null); }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <CardTitle>Backup sets</CardTitle>
            <CardDescription>
              Group stacks under one schedule and one set of settings — for example everything on a Raspberry Pi.
              A stack can override any setting for itself; bind paths and dump hooks are always per stack.
            </CardDescription>
          </div>
          {canWrite && (
            <Button size="sm" onClick={() => onEdit('new')} disabled={!targets.length}>
              <Plus className="h-4 w-4" /> New set
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {notice && <div className="mb-3 text-sm text-muted-foreground">{notice}</div>}
        {!sets.length ? (
          <p className="py-2 text-sm text-muted-foreground">No sets yet. Stacks can still be backed up one at a time.</p>
        ) : (
          <div className="divide-y divide-border">
            {sets.map((s) => {
              const isOpen = open.has(s.id);
              const failing = s.members.filter((m) => m.lastStatus === 'error').length;
              return (
                <div key={s.id} className="py-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      className="flex items-center gap-2 min-w-0 flex-1 text-left"
                      onClick={() => setOpen((prev) => {
                        const next = new Set(prev);
                        if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                        return next;
                      })}
                    >
                      {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                      <div className="min-w-0">
                        <div className="font-medium truncate">
                          {s.name}
                          <span className="text-muted-foreground font-normal"> · {s.members.length} stack(s){s.hostName ? ` on ${s.hostName}` : ' across hosts'}</span>
                          {failing > 0 && <span className="text-destructive font-normal text-xs ml-2">{failing} failing</span>}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                          <span>→ {s.targetName}</span>
                          <span>·</span>
                          <span className="inline-flex items-center gap-1"><CalendarClock className="h-3 w-3" />{s.frequency === 'off' ? 'manual only' : s.scheduleText}</span>
                          <span>·</span>
                          <span className="inline-flex items-center gap-1">
                            {s.secretMode === 'raw' ? <TriangleAlert className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                            {s.secretMode === 'embed' ? 'secrets sealed' : s.secretMode === 'reference' ? 'vault reference' : 'secrets raw'}
                          </span>
                          <span>·</span>
                          <span>{s.quiesce === 'hot' ? 'hot' : s.quiesce === 'pause' ? 'paused for capture' : 'stopped for capture'}</span>
                          {s.autoInclude && <><span>·</span><span className="text-sky-400">auto-includes new stacks</span></>}
                        </div>
                      </div>
                    </button>
                    {canWrite && (
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          disabled={busy === `run:${s.id}` || !s.members.length}
                          onClick={() => void act(`run:${s.id}`, async () => {
                            const r = await api.post<RunSetResult>(`/api/stack-backup/sets/${s.id}/run`, {});
                            setNotice(
                              `Queued ${r.queued.length} stack(s) — they run one at a time per repository.`
                              + (r.skipped.length ? ` Skipped: ${r.skipped.map((x) => `${x.stackName} (${x.reason})`).join('; ')}.` : ''),
                            );
                          })}
                        >
                          {busy === `run:${s.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDriveDownload className="h-4 w-4" />}
                          Back up all
                        </Button>
                        {s.autoInclude && (
                          <Button
                            size="sm"
                            variant="outline"
                            title="Look for new stacks on the host now (also runs hourly)"
                            disabled={busy === `sync:${s.id}`}
                            onClick={() => void act(`sync:${s.id}`, async () => {
                              const r = await api.post<StackBackupSet>(`/api/stack-backup/sets/${s.id}/sync`, {});
                              setNotice(`${r.name}: ${r.lastSyncMessage ?? 'scanned.'}`);
                            })}
                          >
                            {busy === `sync:${s.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Scan host
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => setAddFor(s)}><Plus className="h-4 w-4" /> Stacks</Button>
                        <Button size="sm" variant="ghost" onClick={() => onEdit(s)}>Edit</Button>
                        <Button size="icon" variant="ghost" aria-label="Delete set" onClick={() => setDeleteFor(s)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                  {isOpen && (
                    <div className="mt-2 ml-6 rounded-md border border-border divide-y divide-border">
                      {s.autoInclude && (
                        <div className="px-3 py-2 text-xs text-muted-foreground">
                          Last scan {fmtWhen(s.lastSyncAt)}{s.lastSyncMessage ? ` — ${s.lastSyncMessage}` : ''}
                          {s.excludedStacks.length > 0 && <> · never re-added: {s.excludedStacks.join(', ')}</>}
                        </div>
                      )}
                      {!s.members.length && <div className="px-3 py-2 text-xs text-muted-foreground">No stacks in this set yet.</div>}
                      {s.members.map((m) => (
                        <div key={m.policyId} className="px-3 py-2 flex items-center gap-3 text-sm">
                          <div className="min-w-0 flex-1">
                            <span className="font-medium">{m.stackName}</span>
                            {!s.connectorInstanceId && <span className="text-muted-foreground"> on {m.hostName}</span>}
                            {m.setOverrides.length > 0 && (
                              <span className="text-xs text-amber-400 ml-2">own {m.setOverrides.map((o) => OVERRIDE_LABEL[o] ?? o).join(', ')}</span>
                            )}
                          </div>
                          <span className={`text-xs ${m.lastStatus === 'success' ? 'text-emerald-400' : m.lastStatus === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
                            {m.lastStatus}
                          </span>
                          <span className="text-xs text-muted-foreground hidden sm:inline">{fmtWhen(m.lastRunAt)}</span>
                          {canWrite && (
                            <Button size="sm" variant="ghost" onClick={() => setRemoveFor({ set: s, policyId: m.policyId, stackName: m.stackName })}>
                              Remove
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
      {addFor && (
        <AddMembersDialog
          set={addFor}
          policies={policies}
          onClose={() => setAddFor(null)}
          onAdd={async (stacks) => {
            await api.post(`/api/stack-backup/sets/${addFor.id}/members`, { stacks } satisfies AddSetMembersInput);
            setAddFor(null);
            setOpen((prev) => new Set(prev).add(addFor.id));
            onChanged();
          }}
        />
      )}
      {removeFor && (
        <Dialog
          open
          onClose={() => setRemoveFor(null)}
          title={`Remove ${removeFor.stackName} from ${removeFor.set.name}?`}
          description={removeFor.set.autoInclude ? 'The set will remember this and not add it back on its next scan.' : undefined}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRemoveFor(null)}>Cancel</Button>
              <Button
                variant="outline"
                onClick={() => { const r = removeFor; setRemoveFor(null); void act(`rm:${r.policyId}`, () => api.delete(`/api/stack-backup/sets/${r.set.id}/members/${r.policyId}`)); }}
              >
                Keep its backup
              </Button>
              <Button
                variant="destructive"
                onClick={() => { const r = removeFor; setRemoveFor(null); void act(`rm:${r.policyId}`, () => api.delete(`/api/stack-backup/sets/${r.set.id}/members/${r.policyId}?mode=delete`)); }}
              >
                Stop backing it up
              </Button>
            </>
          }
        >
          <p className="text-sm text-muted-foreground">
            <strong>Keep its backup</strong> leaves it as a standalone backup with the same settings and schedule.
            <strong> Stop backing it up</strong> removes its backup configuration. Snapshots already taken are never deleted here.
          </p>
        </Dialog>
      )}
      {deleteFor && (
        <Dialog
          open
          onClose={() => setDeleteFor(null)}
          title={`Delete set ${deleteFor.name}?`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleteFor(null)}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={() => { const d = deleteFor; setDeleteFor(null); void act(`del:${d.id}`, () => api.delete(`/api/stack-backup/sets/${d.id}`)); }}
              >
                Delete set
              </Button>
            </>
          }
        >
          <p className="text-sm text-muted-foreground">
            Its {deleteFor.members.length} stack(s) keep backing up on their current schedule as standalone backups, and
            any that sealed with the set's passphrase get their own copy of it. No snapshots are deleted.
          </p>
        </Dialog>
      )}
    </Card>
  );
}

function AddMembersDialog({ set, policies, onClose, onAdd }: {
  set: StackBackupSet;
  policies: StackBackupPolicy[];
  onClose: () => void;
  onAdd: (stacks: { connectorInstanceId: string; stackName: string }[]) => Promise<void>;
}) {
  const [candidates, setCandidates] = useState<StackBackupCandidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.get<StackBackupCandidate[]>('/api/stack-backup/candidates')
      .then(setCandidates)
      .catch((e) => { setErr(errText(e, 'Could not list stacks.')); setCandidates([]); });
  }, []);

  const policyOf = useMemo(
    () => new Map(policies.map((p) => [`${p.connectorInstanceId}/${p.stackName}`, p])),
    [policies],
  );
  const list = (candidates ?? []).filter((c) => !set.connectorInstanceId || c.connectorInstanceId === set.connectorInstanceId);

  async function save() {
    setSaving(true); setErr(null);
    try {
      await onAdd([...picked].map((k) => {
        const i = k.indexOf('/');
        return { connectorInstanceId: k.slice(0, i), stackName: k.slice(i + 1) };
      }));
    } catch (e) {
      setErr(errText(e, 'Could not add stacks.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Add stacks to ${set.name}`}
      description="New stacks take every setting from the set. A stack that already has a backup keeps its bind paths and dump hooks, and takes the set's schedule and other settings."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving || !picked.size}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Add {picked.size || ''}
          </Button>
        </>
      }
    >
      {err && <div className="mb-3 text-sm text-destructive">{err}</div>}
      {candidates === null ? (
        <div className="py-4"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : !list.length ? (
        <p className="text-sm text-muted-foreground">No stacks found{set.hostName ? ` on ${set.hostName}` : ''}.</p>
      ) : (
        <div className="space-y-1.5 max-h-[50vh] overflow-auto">
          {list.map((c) => {
            const key = `${c.connectorInstanceId}/${c.stackName}`;
            const p = policyOf.get(key);
            const inThis = p?.setId === set.id;
            const inOther = !!p?.setId && !inThis;
            return (
              <label key={key} className={`flex items-start gap-2 text-sm ${inThis || inOther ? 'opacity-60' : ''}`}>
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={inThis || inOther}
                  checked={picked.has(key)}
                  onChange={(e) => setPicked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(key); else next.delete(key);
                    return next;
                  })}
                />
                <span>
                  {!set.connectorInstanceId && <span className="text-muted-foreground">{c.hostName} — </span>}
                  {c.stackName}
                  <span className="text-xs text-muted-foreground block">
                    {inThis ? 'already in this set'
                      : inOther ? `in set “${p?.setName}” — remove it there first`
                      : p ? 'has its own backup — joins with its bind paths and hooks kept'
                      : 'no backup yet'}
                    {c.requiresRelay ? ' · relay only (no SSH)' : ''}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}

export function SetDialog({ set, targets, hosts, onClose, onSaved }: {
  set: StackBackupSet | null;
  targets: StackBackupTarget[];
  hosts: BackupHost[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(set?.name ?? '');
  const [description, setDescription] = useState(set?.description ?? '');
  const [hostId, setHostId] = useState(set?.connectorInstanceId ?? '');
  const [autoInclude, setAutoInclude] = useState(set?.autoInclude ?? false);
  const [targetId, setTargetId] = useState(set?.targetId ?? targets[0]?.id ?? '');
  const [enabled, setEnabled] = useState(set?.enabled ?? true);
  const [frequency, setFrequency] = useState<BackupFrequency>(set?.frequency ?? 'daily');
  const [dayOfWeek, setDayOfWeek] = useState(set?.dayOfWeek ?? 0);
  const [dayOfMonth, setDayOfMonth] = useState(set?.dayOfMonth ?? 1);
  const [hour, setHour] = useState(set?.hour ?? 3);
  const [minute, setMinute] = useState(set?.minute ?? 0);
  const [quiesce, setQuiesce] = useState<QuiesceMode>(set?.quiesce ?? 'hot');
  const [transfer, setTransfer] = useState<TransferMode>(set?.transfer ?? 'direct');
  const [secretMode, setSecretMode] = useState<SecretMode>(set?.secretMode ?? 'embed');
  const [excludes, setExcludes] = useState((set?.excludes ?? []).join('\n'));
  const [excludedStacks, setExcludedStacks] = useState<string[]>(set?.excludedStacks ?? []);
  const [sealPassphrase, setSealPassphrase] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const needsStoredPass = frequency !== 'off' && secretMode === 'embed' && !set?.hasSealPassphrase && !sealPassphrase;
  const strays = set && hostId ? set.members.filter((m) => m.connectorInstanceId !== hostId) : [];

  async function save() {
    const body: SaveBackupSetInput = {
      name, description, connectorInstanceId: hostId || null, autoInclude: !!hostId && autoInclude, targetId, enabled,
      frequency, dayOfWeek, dayOfMonth, hour, minute, quiesce, transfer, secretMode,
      excludes: excludes.split('\n').map((x) => x.trim()).filter(Boolean),
      excludedStacks,
      ...(sealPassphrase ? { sealPassphrase } : {}),
    };
    setSaving(true); setErr(null);
    try {
      if (set) await api.put(`/api/stack-backup/sets/${set.id}`, body);
      else await api.post('/api/stack-backup/sets', body);
      onSaved();
    } catch (e) {
      setErr(errText(e, 'Could not save.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={set ? `Edit ${set.name}` : 'New backup set'}
      description="Settings here are written onto every stack in the set, except the ones a stack overrides for itself."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving || !name.trim() || !targetId || needsStoredPass || strays.length > 0}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </Button>
        </>
      }
    >
      {err && <div className="mb-3 text-sm text-destructive">{err}</div>}
      <div className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="pi01 stacks" />
          </div>
          <div>
            <Label>Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>

        <div className="rounded-md border border-border p-3 space-y-2">
          <Label>Host</Label>
          <select className={selectCls} value={hostId} onChange={(e) => setHostId(e.target.value)}>
            <option value="">Any host — add stacks by hand</option>
            {hosts.map((h) => <option key={h.id} value={h.id}>{h.name}{h.enabled ? '' : ' (disabled)'}</option>)}
          </select>
          {strays.length > 0 && (
            <p className="text-xs text-destructive">
              This set has stacks on other hosts ({strays.map((m) => m.stackName).join(', ')}). Remove them first to limit it to one host.
            </p>
          )}
          {hostId && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={autoInclude} onChange={(e) => setAutoInclude(e.target.checked)} />
              <span>
                Auto-include every stack on this host
                <span className="text-xs text-muted-foreground block">
                  Checked hourly. Stacks that already have a backup, are ignored, or that you removed from this set are
                  left alone. Bind paths are never included automatically — add them per stack.
                </span>
              </span>
            </label>
          )}
          {autoInclude && hostId && excludedStacks.length > 0 && (
            <div className="text-xs text-muted-foreground">
              Never re-added:{' '}
              {excludedStacks.map((n) => (
                <button
                  key={n}
                  className="mr-2 underline hover:text-foreground"
                  title="Let auto-include pick this stack up again"
                  onClick={() => setExcludedStacks((prev) => prev.filter((x) => x !== n))}
                >
                  {n} ✕
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <Label>Repository</Label>
          <select className={selectCls} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>

        <div className="rounded-md border border-border p-3">
          <div className="flex items-center gap-3">
            <Label className="flex-1">Schedule</Label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
            </label>
          </div>
          <div className="flex items-end gap-2 flex-wrap mt-1">
            <select className={`${selectCls} w-auto`} value={frequency} onChange={(e) => setFrequency(e.target.value as BackupFrequency)}>
              <option value="off">Manual only</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
            {frequency === 'weekly' && (
              <select className={`${selectCls} w-auto`} value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
                {DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            )}
            {frequency === 'monthly' && (
              <select className={`${selectCls} w-auto`} value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>Day {d}</option>)}
              </select>
            )}
            {frequency !== 'off' && (
              <>
                <select className={`${selectCls} w-auto`} value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                  {Array.from({ length: 24 }, (_, i) => i).map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}</option>)}
                </select>
                <span className="pb-2">:</span>
                <select className={`${selectCls} w-auto`} value={minute} onChange={(e) => setMinute(Number(e.target.value))}>
                  {[0, 15, 30, 45].map((m) => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
                </select>
              </>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Server local time. Stacks sharing a repository run one after another, so the whole set finishes later than
            the start time.{!enabled && ' Turning the set off pauses every stack that takes its schedule from it.'}
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <Label>Transfer</Label>
            <select className={selectCls} value={transfer} onChange={(e) => setTransfer(e.target.value as TransferMode)}>
              <option value="direct">Direct — helper on the host</option>
              <option value="relay">Relay — through Cerebro</option>
            </select>
            <p className="text-xs text-muted-foreground mt-1">Hosts without SSH always use relay, whatever this says.</p>
          </div>
          <div>
            <Label>Consistency</Label>
            <select className={selectCls} value={quiesce} onChange={(e) => setQuiesce(e.target.value as QuiesceMode)}>
              <option value="hot">Hot — never interrupt</option>
              <option value="pause">Pause for the capture</option>
              <option value="stop">Stop for the capture</option>
            </select>
            <p className="text-xs text-muted-foreground mt-1">Databases on hot: add a dump hook on that stack.</p>
          </div>
        </div>

        <div>
          <Label>Secrets</Label>
          <select className={selectCls} value={secretMode} onChange={(e) => setSecretMode(e.target.value as SecretMode)}>
            <option value="embed">Sealed — values encrypted with a passphrase</option>
            <option value="raw">Raw — values stored as-is (restic encryption only)</option>
          </select>
          <p className="text-xs text-muted-foreground mt-1">
            Vault-reference mode depends on each stack's own secrets, so it is chosen per stack (override secrets on that stack).
          </p>
        </div>

        {secretMode === 'embed' && (
          <div className={needsStoredPass ? 'rounded-md border border-amber-500/40 bg-amber-500/10 p-3' : ''}>
            <Label>
              Set sealing passphrase
              {set?.hasSealPassphrase && <span className="text-muted-foreground font-normal"> (set — leave blank to keep)</span>}
            </Label>
            <Input
              type="password"
              value={sealPassphrase}
              onChange={(e) => setSealPassphrase(e.target.value)}
              autoComplete="new-password"
              placeholder={set?.hasSealPassphrase ? '••••••••' : ''}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Used by every stack in the set that has no passphrase of its own, including ones auto-include adds later.
              {needsStoredPass ? ' Required for a scheduled sealed set.' : ' Write it down outside Cerebro.'}
            </p>
          </div>
        )}

        <div>
          <Label>Exclude patterns <span className="text-muted-foreground font-normal">(one per line)</span></Label>
          <textarea
            className="mt-1 w-full min-h-16 rounded-md border border-input bg-background/60 px-2 py-1.5 text-sm font-mono"
            value={excludes}
            onChange={(e) => setExcludes(e.target.value)}
            placeholder={'*.tmp\n**/cache/**'}
          />
        </div>

        {!set && (
          <p className="text-xs text-muted-foreground inline-flex items-start gap-1">
            <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            After saving, add stacks with “Stacks”, or from the Coverage list. Nothing is backed up until a stack is in the set.
          </p>
        )}
      </div>
    </Dialog>
  );
}
