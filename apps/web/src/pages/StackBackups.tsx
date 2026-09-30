import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive, CalendarClock, CheckCircle2, Database, Download, Folder, FolderOpen, HardDriveDownload,
  HardDriveUpload, KeyRound, Loader2, Lock, Plus, RefreshCw, ScrollText, ShieldCheck, Trash2,
  TriangleAlert,
} from 'lucide-react';
import type {
  BackupFrequency, BackupHost, BackupTargetKind, SaveBackupPolicyInput, SaveBackupTargetInput, SecretMode,
  SnapshotEntry, StackBackupCandidate, StackBackupPolicy, StackBackupRun, StackBackupTarget,
  QuiesceMode, StackHook, StackRestoreRun, StackSecretsReport, StackSnapshot, TransferMode,
  VerifyRestoreInput,
} from '@cerebro/shared';
import { RestoreWizard } from '@/components/RestoreWizard';
import { StackSecretsDialog } from '@/components/StackSecretsDialog';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';

const selectCls = 'mt-1 w-full h-9 rounded-md border border-input bg-background/60 px-2 text-sm';

const STATUS_COLOR: Record<string, string> = {
  success: 'text-emerald-400',
  ok: 'text-emerald-400',
  running: 'text-amber-400',
  error: 'text-destructive',
  never: 'text-muted-foreground',
};

function fmtBytes(n?: number | null): string {
  if (n == null) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** "keeps 7 daily, 4 weekly" — or null when nothing is ever deleted. */
function describeRetention(t: StackBackupTarget): string | null {
  const parts = [
    t.keepLast ? `${t.keepLast} last` : null,
    t.keepDaily ? `${t.keepDaily} daily` : null,
    t.keepWeekly ? `${t.keepWeekly} weekly` : null,
    t.keepMonthly ? `${t.keepMonthly} monthly` : null,
    t.keepWithinDays ? `everything within ${t.keepWithinDays}d` : null,
  ].filter(Boolean);
  return parts.length ? `keeps ${parts.join(', ')}` : null;
}

function fmtWhen(iso?: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString();
}

function fmtDuration(ms?: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Stack backup & restore. Phase 1: configure restic repositories, say what to
 * capture for a stack, run it, and read the log. See docs/stack-backup.md.
 */
export function StackBackups() {
  const { can } = useAuth();
  const canWrite = can('backup:write');
  const canRestore = can('backup:restore');

  const [targets, setTargets] = useState<StackBackupTarget[]>([]);
  const [policies, setPolicies] = useState<StackBackupPolicy[] | null>(null);
  const [runs, setRuns] = useState<StackBackupRun[]>([]);
  const [hosts, setHosts] = useState<BackupHost[]>([]);
  const [restores, setRestores] = useState<StackRestoreRun[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [targetDialog, setTargetDialog] = useState<StackBackupTarget | 'new' | null>(null);
  const [policyDialog, setPolicyDialog] = useState<StackBackupPolicy | 'new' | null>(null);
  const [runPrompt, setRunPrompt] = useState<StackBackupPolicy | null>(null);
  const [logRun, setLogRun] = useState<StackBackupRun | null>(null);
  const [logRestore, setLogRestore] = useState<StackRestoreRun | null>(null);
  const [restoreFor, setRestoreFor] = useState<{ targetId: string; snapshot: StackSnapshot } | null>(null);
  const [browseFor, setBrowseFor] = useState<{ targetId: string; snapshot: StackSnapshot } | null>(null);
  const [secretsFor, setSecretsFor] = useState<StackBackupPolicy | null>(null);
  const [verifyFor, setVerifyFor] = useState<{ targetId: string; snapshot: StackSnapshot } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [t, p, r, h, rr] = await Promise.all([
        api.get<StackBackupTarget[]>('/api/stack-backup/targets'),
        api.get<StackBackupPolicy[]>('/api/stack-backup/policies'),
        api.get<StackBackupRun[]>('/api/stack-backup/runs?limit=25'),
        api.get<BackupHost[]>('/api/stack-backup/hosts'),
        api.get<StackRestoreRun[]>('/api/stack-backup/restores?limit=15'),
      ]);
      setTargets(t); setPolicies(p); setRuns(r); setHosts(h); setRestores(rr);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load.');
      setPolicies([]);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Follow a run in flight without making the user reload.
  const hasRunning = runs.some((r) => r.status === 'running') || restores.some((r) => r.status === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const t = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(t);
  }, [hasRunning, refresh]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key); setErr(null);
    try { await fn(); await refresh(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Action failed.'); }
    finally { setBusy(null); }
  }

  function startBackup(policy: StackBackupPolicy) {
    // A stored passphrase covers manual runs too — don't ask for what Cerebro holds.
    if (policy.secretMode === 'embed' && !policy.hasSealPassphrase) { setRunPrompt(policy); return; }
    void act(`run:${policy.id}`, () => api.post(`/api/stack-backup/policies/${policy.id}/run`, {}));
  }

  return (
    <div>
      <PageHeader
        title="Stack Backups"
        description="Capture a Compose stack — volumes, config and metadata — from any Docker host into a restic repository."
        actions={
          <>
            <Button variant="outline" onClick={() => void refresh()}>
              <RefreshCw className="h-4 w-4 mr-2" /> Refresh
            </Button>
            {canWrite && (
              <Button onClick={() => setPolicyDialog('new')} disabled={!targets.length}>
                <Plus className="h-4 w-4 mr-2" /> Back up a stack
              </Button>
            )}
          </>
        }
      />

      {err && (
        <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      )}

      {!targets.length && (
        <Card className="mb-6">
          <CardContent className="py-8 text-center">
            <Archive className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
            <p className="text-sm text-muted-foreground mb-4">
              No backup repository yet. A target is a restic repository — a B2 bucket or any S3-compatible
              endpoint — that every stack backup is written into.
            </p>
            {canWrite && <Button onClick={() => setTargetDialog('new')}><Plus className="h-4 w-4 mr-2" /> Add a target</Button>}
          </CardContent>
        </Card>
      )}

      {/* ── Configured stack backups ── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Stacks</CardTitle>
          <CardDescription>
            One backup configuration per stack. "Back up now" runs exactly what a scheduled run would.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {policies === null ? (
            <div className="py-6 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></div>
          ) : !policies.length ? (
            <p className="py-4 text-sm text-muted-foreground">
              No stacks configured yet{targets.length ? ' — use “Back up a stack”.' : '.'}
            </p>
          ) : (
            <div className="divide-y divide-border">
              {policies.map((p) => (
                <div key={p.id} className="py-3 flex items-center gap-4 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">
                      {p.stackName}
                      <span className="text-muted-foreground font-normal"> on {p.hostName ?? p.connectorInstanceId}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                      <span>→ {p.targetName}</span>
                      <span>·</span>
                      <span className="inline-flex items-center gap-1">
                        {p.secretMode === 'raw' ? <TriangleAlert className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                        {p.secretMode === 'embed' ? 'secrets sealed'
                          : p.secretMode === 'reference' ? 'secrets by vault reference'
                          : 'secrets raw'}
                      </span>
                      {p.includeBinds.length > 0 && <><span>·</span><span>{p.includeBinds.length} bind path(s)</span></>}
                      <span>·</span>
                      <span>{p.quiesce === 'hot' ? 'hot' : p.quiesce === 'pause' ? 'paused for capture' : 'stopped for capture'}</span>
                      {p.transfer === 'relay' && <><span>·</span><span>relay</span></>}
                      {p.preHooks.length + p.postHooks.length > 0 && (
                        <><span>·</span><span>{p.preHooks.length + p.postHooks.length} hook(s)</span></>
                      )}
                      <span>·</span>
                      <span className="inline-flex items-center gap-1">
                        <CalendarClock className="h-3 w-3" />
                        {p.frequency === 'off' ? 'manual only' : p.scheduleText}
                      </span>
                      {p.nextRunAt && <><span>·</span><span>next {fmtWhen(p.nextRunAt)}</span></>}
                    </div>
                  </div>
                  <div className="text-xs text-right">
                    <div className={STATUS_COLOR[p.lastStatus] ?? ''}>{p.lastStatus}</div>
                    <div className="text-muted-foreground">{fmtWhen(p.lastRunAt)}</div>
                  </div>
                  {canWrite && (
                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={() => startBackup(p)} disabled={busy === `run:${p.id}`}>
                        {busy === `run:${p.id}`
                          ? <Loader2 className="h-4 w-4 animate-spin" />
                          : <HardDriveDownload className="h-4 w-4 mr-2" />}
                        Back up now
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setSecretsFor(p)} title="What the vault knows about this stack">
                        <KeyRound className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setPolicyDialog(p)}>Edit</Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Remove"
                        onClick={() => act(`del:${p.id}`, () => api.delete(`/api/stack-backup/policies/${p.id}`))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Targets ── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Repositories</CardTitle>
          <CardDescription>
            Credentials are held in the vault. Deleting a target here never deletes its backups.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="divide-y divide-border">
            {targets.map((t) => (
              <div key={t.id} className="py-3 flex items-center gap-4 flex-wrap">
                <Database className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{t.name}</div>
                  <div className="text-xs text-muted-foreground font-mono truncate">{t.repository}</div>
                </div>
                <div className="text-xs text-right max-w-xs">
                  <div className={STATUS_COLOR[t.lastStatus] ?? ''}>{t.lastStatus}</div>
                  <div className="text-muted-foreground truncate" title={t.lastMessage ?? undefined}>
                    {describeRetention(t) ?? t.lastMessage ?? ''}
                  </div>
                </div>
                {canWrite && (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === `chk:${t.id}`}
                      onClick={() => act(`chk:${t.id}`, () => api.post(`/api/stack-backup/targets/${t.id}/check`))}
                    >
                      {busy === `chk:${t.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
                      Check
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === `init:${t.id}`}
                      onClick={() => act(`init:${t.id}`, () => api.post(`/api/stack-backup/targets/${t.id}/check?init=1`))}
                    >
                      Initialize
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setTargetDialog(t)}>Edit</Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Remove"
                      onClick={() => act(`delt:${t.id}`, () => api.delete(`/api/stack-backup/targets/${t.id}`))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {canWrite && (
            <Button variant="outline" className="mt-4" onClick={() => setTargetDialog('new')}>
              <Plus className="h-4 w-4 mr-2" /> Add target
            </Button>
          )}
        </CardContent>
      </Card>

      {/* ── Snapshots ── */}
      {targets.length > 0 && (
        <SnapshotBrowser
          targets={targets}
          canRestore={canRestore}
          onRestore={(targetId, snapshot) => setRestoreFor({ targetId, snapshot })}
          onBrowse={(targetId, snapshot) => setBrowseFor({ targetId, snapshot })}
          onVerify={(targetId, snapshot) => setVerifyFor({ targetId, snapshot })}
        />
      )}

      {/* ── Restores ── */}
      {restores.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Restores</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border">
              {restores.map((r) => (
                <button
                  key={r.id}
                  className="w-full py-3 flex items-center gap-4 text-left hover:bg-muted/40 px-2 -mx-2 rounded"
                  onClick={() => void openRestoreLog(r.id, setLogRestore, setErr)}
                >
                  <HardDriveUpload className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">
                      {r.sourceStackName} → {r.destStackName}
                      <span className="text-muted-foreground font-normal"> on {r.destHostName ?? r.destInstanceId}</span>
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{r.message ?? '—'}</div>
                  </div>
                  <div className="text-xs text-muted-foreground hidden sm:block">{r.volumes} vol · {r.binds} bind</div>
                  <div className="text-xs text-muted-foreground hidden sm:block">{r.deployed ? 'deployed' : 'not started'}</div>
                  <div className="text-xs text-right w-40">
                    <div className={`inline-flex items-center gap-1 ${STATUS_COLOR[r.status] ?? ''}`}>
                      {r.status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
                      {r.status}
                    </div>
                    <div className="text-muted-foreground">{fmtWhen(r.startedAt)}</div>
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Runs ── */}
      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
        </CardHeader>
        <CardContent>
          {!runs.length ? (
            <p className="py-4 text-sm text-muted-foreground">No backups have run yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {runs.map((r) => (
                <button
                  key={r.id}
                  className="w-full py-3 flex items-center gap-4 text-left hover:bg-muted/40 px-2 -mx-2 rounded"
                  onClick={() => void openLog(r.id, setLogRun, setErr)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">
                      {r.stackName} <span className="text-muted-foreground font-normal">on {r.hostName ?? r.connectorInstanceId}</span>
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{r.message ?? '—'}</div>
                  </div>
                  <div className="text-xs text-muted-foreground hidden sm:block">{r.volumes} vol · {r.binds} bind</div>
                  <div className="text-xs text-muted-foreground hidden sm:block">{fmtBytes(r.bytesAdded)} added</div>
                  <div className="text-xs text-muted-foreground">{fmtDuration(r.durationMs)}</div>
                  <div className="text-xs text-right w-40">
                    <div className={`inline-flex items-center gap-1 ${STATUS_COLOR[r.status] ?? ''}`}>
                      {r.status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
                      {r.status}
                    </div>
                    <div className="text-muted-foreground">{fmtWhen(r.startedAt)}</div>
                  </div>
                  <ScrollText className="h-4 w-4 text-muted-foreground shrink-0" />
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {targetDialog && (
        <TargetDialog
          target={targetDialog === 'new' ? null : targetDialog}
          onClose={() => setTargetDialog(null)}
          onSaved={() => { setTargetDialog(null); void refresh(); }}
        />
      )}
      {policyDialog && (
        <PolicyDialog
          targets={targets}
          policy={policyDialog === 'new' ? null : policyDialog}
          onClose={() => setPolicyDialog(null)}
          onSaved={() => { setPolicyDialog(null); void refresh(); }}
        />
      )}
      {runPrompt && (
        <PassphraseDialog
          policy={runPrompt}
          onClose={() => setRunPrompt(null)}
          onRun={async (passphrase) => {
            setRunPrompt(null);
            await act(`run:${runPrompt.id}`, () => api.post(`/api/stack-backup/policies/${runPrompt.id}/run`, { passphrase }));
          }}
        />
      )}
      {logRun && (
        <Dialog open onClose={() => setLogRun(null)} size="lg" title={`${logRun.stackName} — ${logRun.status}`} description={fmtWhen(logRun.startedAt)}>
          <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-background/60 border border-border rounded p-3 max-h-[60vh] overflow-auto">
            {logRun.log || 'No log recorded.'}
          </pre>
        </Dialog>
      )}
      {logRestore && (
        <Dialog
          open
          onClose={() => setLogRestore(null)}
          size="lg"
          title={`Restore ${logRestore.sourceStackName} → ${logRestore.destStackName} — ${logRestore.status}`}
          description={fmtWhen(logRestore.startedAt)}
        >
          <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-background/60 border border-border rounded p-3 max-h-[60vh] overflow-auto">
            {logRestore.log || 'No log recorded.'}
          </pre>
        </Dialog>
      )}
      {restoreFor && (
        <RestoreWizard
          targetId={restoreFor.targetId}
          snapshot={restoreFor.snapshot}
          hosts={hosts.filter((h) => h.enabled)}
          canRestore={canRestore}
          onClose={() => setRestoreFor(null)}
          onStarted={(run) => { setRestoreFor(null); setRestores((p) => [run, ...p]); void refresh(); }}
        />
      )}
      {secretsFor && (
        <StackSecretsDialog
          instanceId={secretsFor.connectorInstanceId}
          stackName={secretsFor.stackName}
          canWrite={canWrite}
          onClose={() => setSecretsFor(null)}
          onChanged={() => void refresh()}
        />
      )}
      {browseFor && (
        <SnapshotContents
          targetId={browseFor.targetId}
          snapshot={browseFor.snapshot}
          canRestore={canRestore}
          onClose={() => setBrowseFor(null)}
        />
      )}
      {verifyFor && (
        <VerifyDialog
          targetId={verifyFor.targetId}
          snapshot={verifyFor.snapshot}
          hosts={hosts.filter((h) => h.enabled)}
          onClose={() => setVerifyFor(null)}
          onStarted={(run) => { setVerifyFor(null); setRestores((p) => [run, ...p]); void refresh(); }}
        />
      )}
    </div>
  );
}

async function openRestoreLog(
  id: string,
  set: (r: StackRestoreRun) => void,
  onErr: (m: string) => void,
): Promise<void> {
  try {
    set(await api.get<StackRestoreRun>(`/api/stack-backup/restores/${id}`));
  } catch (e) {
    onErr(e instanceof ApiError ? e.message : 'Could not load the restore log.');
  }
}

/** Pick a repository and list its stack snapshots — the entry point to a restore. */
function SnapshotBrowser({ targets, canRestore, onRestore, onBrowse, onVerify }: {
  targets: StackBackupTarget[];
  canRestore: boolean;
  onRestore: (targetId: string, snapshot: StackSnapshot) => void;
  onBrowse: (targetId: string, snapshot: StackSnapshot) => void;
  onVerify: (targetId: string, snapshot: StackSnapshot) => void;
}) {
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '');
  const [stack, setStack] = useState('');
  const [snapshots, setSnapshots] = useState<StackSnapshot[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    if (!targetId) return;
    setLoading(true); setErr(null);
    try {
      const q = stack.trim() ? `?stack=${encodeURIComponent(stack.trim())}` : '';
      setSnapshots(await api.get<StackSnapshot[]>(`/api/stack-backup/targets/${targetId}/snapshots${q}`));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not list snapshots.');
      setSnapshots([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Snapshots</CardTitle>
        <CardDescription>Everything in a repository, newest first. Restoring writes to a host you choose.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-end gap-2 flex-wrap mb-4">
          <div className="min-w-48">
            <Label>Repository</Label>
            <select className={selectCls} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="min-w-48">
            <Label>Stack <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input value={stack} onChange={(e) => setStack(e.target.value)} placeholder="all stacks" />
          </div>
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            List snapshots
          </Button>
        </div>

        {err && <div className="mb-3 text-sm text-destructive">{err}</div>}

        {snapshots === null ? (
          <p className="text-sm text-muted-foreground">Choose a repository and list its snapshots.</p>
        ) : !snapshots.length ? (
          <p className="text-sm text-muted-foreground">No stack snapshots in this repository yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {snapshots.map((s) => (
              <div key={s.id} className="py-3 flex items-center gap-4 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">
                    {s.stackName ?? 'unknown stack'}
                    <span className="text-muted-foreground font-normal font-mono text-xs"> {s.shortId}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {fmtWhen(s.time)}{s.hostLabel ? ` · from ${s.hostLabel}` : s.hostname ? ` · from ${s.hostname}` : ''}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => onBrowse(targetId, s)}>
                  <FolderOpen className="h-4 w-4 mr-2" /> Browse
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canRestore}
                  onClick={() => onVerify(targetId, s)}
                  title="Bring it up in a throwaway sandbox and check it comes up healthy"
                >
                  <ShieldCheck className="h-4 w-4 mr-2" /> Verify
                </Button>
                <Button size="sm" variant="outline" disabled={!canRestore} onClick={() => onRestore(targetId, s)}>
                  <HardDriveUpload className="h-4 w-4 mr-2" /> Restore…
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Walk a snapshot's tree, one level at a time — proof the data is really in there. */
function SnapshotContents({ targetId, snapshot, canRestore, onClose }: {
  targetId: string;
  snapshot: StackSnapshot;
  canRestore: boolean;
  onClose: () => void;
}) {
  const [path, setPath] = useState('/data');
  const [entries, setEntries] = useState<SnapshotEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setEntries(null); setErr(null);
    api.get<SnapshotEntry[]>(`/api/stack-backup/targets/${targetId}/snapshots/${snapshot.id}/browse?path=${encodeURIComponent(path)}`)
      .then(setEntries)
      .catch((e) => { setErr(e instanceof ApiError ? e.message : 'Could not read the snapshot.'); setEntries([]); });
  }, [targetId, snapshot.id, path]);

  const up = path === '/data' ? null : path.slice(0, path.lastIndexOf('/')) || '/data';

  return (
    <Dialog open onClose={onClose} size="lg" title={`Snapshot ${snapshot.shortId}`} description={path}>
      {err && <div className="mb-3 text-sm text-destructive">{err}</div>}
      {up !== null && (
        <Button size="sm" variant="ghost" className="mb-2" onClick={() => setPath(up)}>← up</Button>
      )}
      {entries === null ? (
        <div className="py-6 text-center"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></div>
      ) : !entries.length ? (
        <p className="text-sm text-muted-foreground">Empty.</p>
      ) : (
        <div className="divide-y divide-border">
          {entries.map((e) => (
            <div key={e.path} className="py-1.5 flex items-center gap-2 text-sm">
              {e.type === 'dir'
                ? <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
                : <ScrollText className="h-4 w-4 text-muted-foreground shrink-0" />}
              {e.type === 'dir' ? (
                <button className="font-mono text-xs hover:underline text-left" onClick={() => setPath(e.path)}>{e.name}/</button>
              ) : (
                <span className="font-mono text-xs break-all">{e.name}</span>
              )}
              <span className="ml-auto text-xs text-muted-foreground shrink-0">{e.type === 'dir' ? '' : fmtBytes(e.size)}</span>
              {e.type !== 'dir' && canRestore && (
                <a
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  href={`/api/stack-backup/targets/${targetId}/snapshots/${snapshot.id}/file?path=${encodeURIComponent(e.path)}`}
                  title={`Download ${e.name}`}
                >
                  <Download className="h-4 w-4" />
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

async function openLog(
  id: string,
  set: (r: StackBackupRun) => void,
  onErr: (m: string) => void,
): Promise<void> {
  try {
    set(await api.get<StackBackupRun>(`/api/stack-backup/runs/${id}`));
  } catch (e) {
    onErr(e instanceof ApiError ? e.message : 'Could not load the run log.');
  }
}

/** Create or edit a restic repository target. */
function TargetDialog({ target, onClose, onSaved }: {
  target: StackBackupTarget | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<SaveBackupTargetInput>({
    name: target?.name ?? '',
    kind: (target?.kind ?? 'b2') as BackupTargetKind,
    repository: target?.repository ?? '',
    helperImage: target?.helperImage ?? 'restic/restic:latest',
    password: '',
    accessKeyId: '',
    secretAccessKey: '',
    hostAccessKeyId: '',
    hostSecretAccessKey: '',
    keepLast: target?.keepLast ?? null,
    keepDaily: target?.keepDaily ?? null,
    keepWeekly: target?.keepWeekly ?? null,
    keepMonthly: target?.keepMonthly ?? null,
    keepWithinDays: target?.keepWithinDays ?? null,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof SaveBackupTargetInput>(k: K, v: SaveBackupTargetInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true); setErr(null);
    try {
      const body = { ...form };
      // Blank credential fields on an edit mean "keep what's in the vault".
      if (target) {
        if (!body.password) delete body.password;
        if (!body.accessKeyId) { delete body.accessKeyId; delete body.secretAccessKey; }
        if (!body.hostAccessKeyId) { delete body.hostAccessKeyId; delete body.hostSecretAccessKey; }
      }
      if (target) await api.put(`/api/stack-backup/targets/${target.id}`, body);
      else await api.post('/api/stack-backup/targets', body);
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save the target.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={target ? `Edit ${target.name}` : 'Add backup target'}
      description="A restic repository. Credentials go straight into the vault and are never shown again."
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
        <div>
          <Label>Name</Label>
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Offsite stacks" />
        </div>
        <div>
          <Label>Storage</Label>
          <select className={selectCls} value={form.kind} onChange={(e) => set('kind', e.target.value as BackupTargetKind)}>
            <option value="b2">Backblaze B2</option>
            <option value="s3">S3-compatible (AWS, MinIO, …)</option>
          </select>
        </div>
        <div>
          <Label>Repository</Label>
          <Input
            value={form.repository}
            onChange={(e) => set('repository', e.target.value)}
            placeholder={form.kind === 'b2' ? 'b2:my-bucket:/stacks' : 's3:https://nas:9000/stacks'}
          />
        </div>
        <div>
          <Label>Repository password{target && <span className="text-muted-foreground font-normal"> (leave blank to keep)</span>}</Label>
          <Input type="password" value={form.password ?? ''} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{form.kind === 'b2' ? 'Key ID' : 'Access key id'}</Label>
            <Input value={form.accessKeyId ?? ''} onChange={(e) => set('accessKeyId', e.target.value)} autoComplete="off" />
          </div>
          <div>
            <Label>{form.kind === 'b2' ? 'Application key' : 'Secret access key'}</Label>
            <Input type="password" value={form.secretAccessKey ?? ''} onChange={(e) => set('secretAccessKey', e.target.value)} autoComplete="new-password" />
          </div>
        </div>
        <div className="rounded-md border border-border p-3">
          <div className="text-sm font-medium">Append-only credential for hosts <span className="text-muted-foreground font-normal">(optional)</span></div>
          <p className="text-xs text-muted-foreground mt-1 mb-2">
            Docker hosts get this key instead of the full one, so a compromised host can add snapshots
            but never delete backup history. Cerebro keeps the full key for pruning.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Input placeholder="Key ID" value={form.hostAccessKeyId ?? ''} onChange={(e) => set('hostAccessKeyId', e.target.value)} autoComplete="off" />
            <Input type="password" placeholder="Application key" value={form.hostSecretAccessKey ?? ''} onChange={(e) => set('hostSecretAccessKey', e.target.value)} autoComplete="new-password" />
          </div>
        </div>
        <div className="rounded-md border border-border p-3">
          <div className="text-sm font-medium">Retention</div>
          <p className="text-xs text-muted-foreground mt-1 mb-2">
            Applied per stack each night, then the repository is pruned. Leave every field blank and
            nothing is ever deleted — snapshots accumulate until you say otherwise.
          </p>
          <div className="grid grid-cols-3 gap-2">
            {([
              ['keepLast', 'Last'],
              ['keepDaily', 'Daily'],
              ['keepWeekly', 'Weekly'],
              ['keepMonthly', 'Monthly'],
              ['keepWithinDays', 'Within (days)'],
            ] as const).map(([key, label]) => (
              <div key={key}>
                <Label className="text-xs">{label}</Label>
                <Input
                  type="number"
                  min={0}
                  value={form[key] ?? ''}
                  onChange={(e) => set(key, e.target.value === '' ? null : Number(e.target.value))}
                />
              </div>
            ))}
          </div>
        </div>
        <div>
          <Label>Helper image</Label>
          <Input value={form.helperImage ?? ''} onChange={(e) => set('helperImage', e.target.value)} />
          <p className="text-xs text-muted-foreground mt-1">Run on each Docker host to do the capture. Pin a version in production.</p>
        </div>
      </div>
    </Dialog>
  );
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Pick a host + stack, see what would be captured, choose a schedule, and save. */
function PolicyDialog({ targets, policy, onClose, onSaved }: {
  targets: StackBackupTarget[];
  /** Editing an existing configuration, or null to add one. */
  policy?: StackBackupPolicy | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!policy;
  const [candidates, setCandidates] = useState<StackBackupCandidate[] | null>(null);
  const [selected, setSelected] = useState<string>(
    policy ? `${policy.connectorInstanceId}/${policy.stackName}` : '',
  );
  const [detail, setDetail] = useState<StackBackupCandidate | null>(null);
  const [secrets, setSecrets] = useState<StackSecretsReport | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [targetId, setTargetId] = useState(policy?.targetId ?? targets[0]?.id ?? '');
  const [secretMode, setSecretMode] = useState<SecretMode>(policy?.secretMode ?? 'embed');
  const [binds, setBinds] = useState<string[]>(policy?.includeBinds ?? []);
  const [quiesce, setQuiesce] = useState<QuiesceMode>(policy?.quiesce ?? 'hot');
  const [transfer, setTransfer] = useState<TransferMode>(policy?.transfer ?? 'direct');
  const [excludes, setExcludes] = useState((policy?.excludes ?? []).join('\n'));
  const [preHooks, setPreHooks] = useState<StackHook[]>(policy?.preHooks ?? []);
  const [postHooks, setPostHooks] = useState<StackHook[]>(policy?.postHooks ?? []);
  const [frequency, setFrequency] = useState<BackupFrequency>(policy?.frequency ?? 'off');
  const [dayOfWeek, setDayOfWeek] = useState(policy?.dayOfWeek ?? 0);
  const [dayOfMonth, setDayOfMonth] = useState(policy?.dayOfMonth ?? 1);
  const [hour, setHour] = useState(policy?.hour ?? 3);
  const [minute, setMinute] = useState(policy?.minute ?? 0);
  const [sealPassphrase, setSealPassphrase] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (editing) return; // the stack is fixed when editing — no need to list them all
    api.get<StackBackupCandidate[]>('/api/stack-backup/candidates')
      .then(setCandidates)
      .catch((e) => { setErr(e instanceof ApiError ? e.message : 'Could not list stacks.'); setCandidates([]); });
  }, [editing]);

  const available = useMemo(() => (candidates ?? []).filter((c) => !c.configured), [candidates]);

  useEffect(() => {
    if (!selected) { setDetail(null); setSecrets(null); return; }
    const [instanceId, stackName] = splitKey(selected);
    setLoadingDetail(true);
    if (!editing) setBinds([]);
    api.get<StackBackupCandidate>(`/api/stack-backup/candidates/${instanceId}/${encodeURIComponent(stackName)}`)
      .then((d) => { setDetail(d); if (d.requiresRelay) setTransfer('relay'); })
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not inspect that stack.'))
      .finally(() => setLoadingDetail(false));
    // Whether vault-reference mode is even possible depends on this stack's own
    // bindings, so the option is offered only when it would actually work.
    api.get<StackSecretsReport>(`/api/stack-backup/secrets/${instanceId}/${encodeURIComponent(stackName)}`)
      .then(setSecrets)
      .catch(() => setSecrets(null));
  }, [selected, editing]);

  // A scheduled sealed backup has nobody to prompt, so the passphrase has to be
  // stored first. The server enforces this; saying so here avoids a pointless round trip.
  const needsStoredPass =
    frequency !== 'off' && secretMode === 'embed' && !policy?.hasSealPassphrase && !sealPassphrase;

  async function save() {
    if (!selected || !targetId) return;
    const [connectorInstanceId, stackName] = splitKey(selected);
    const body: SaveBackupPolicyInput = {
      connectorInstanceId, stackName, targetId, secretMode, includeBinds: binds,
      quiesce, transfer,
      excludes: excludes.split('\n').map((x) => x.trim()).filter(Boolean),
      preHooks: preHooks.filter((h) => h.cmd.trim()),
      postHooks: postHooks.filter((h) => h.cmd.trim()),
      frequency, dayOfWeek, dayOfMonth, hour, minute,
      ...(sealPassphrase ? { sealPassphrase } : {}),
    };
    setSaving(true); setErr(null);
    try {
      await api.post('/api/stack-backup/policies', body);
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={editing ? `${policy!.stackName} backup` : 'Back up a stack'}
      description="Named volumes and the stack's config are always captured. Bind mounts are opt-in, one path at a time."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving || !selected || !targetId || needsStoredPass || detail?.backupable === false}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Save
          </Button>
        </>
      }
    >
      {err && <div className="mb-3 text-sm text-destructive">{err}</div>}
      <div className="space-y-4">
        <div>
          <Label>Stack</Label>
          {editing ? (
            <p className="text-sm mt-1">{policy!.stackName} <span className="text-muted-foreground">on {policy!.hostName}</span></p>
          ) : candidates === null ? (
            <div className="py-3"><Loader2 className="h-4 w-4 animate-spin" /></div>
          ) : (
            <select className={selectCls} value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">Choose a stack…</option>
              {available.map((c) => (
                <option key={`${c.connectorInstanceId}/${c.stackName}`} value={`${c.connectorInstanceId}/${c.stackName}`}>
                  {c.hostName} — {c.stackName}{c.managed ? ' (Cerebro-managed)' : ''}
                </option>
              ))}
            </select>
          )}
          {!editing && candidates !== null && !available.length && (
            <p className="text-xs text-muted-foreground mt-1">Every stack Cerebro can see already has a backup configured.</p>
          )}
        </div>

        {loadingDetail && <div className="text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Inspecting…</div>}

        {detail && !loadingDetail && (
          <>
            {!detail.backupable && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {detail.reason}
              </div>
            )}
            <div className="rounded-md border border-border p-3 text-sm">
              <div className="font-medium mb-1">{detail.containers} container(s)</div>
              <div className="text-muted-foreground text-xs">
                Named volumes captured: {detail.volumes.length ? detail.volumes.join(', ') : 'none'}
              </div>
            </div>

            {detail.binds.length > 0 && (
              <div>
                <Label>Bind mounts</Label>
                <p className="text-xs text-muted-foreground mb-2">
                  Host paths these containers mount. None are captured unless you tick them — a media
                  library would otherwise be swept into every snapshot.
                </p>
                <div className="space-y-1.5 max-h-40 overflow-auto">
                  {detail.binds.map((b) => (
                    <label key={b.path} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={binds.includes(b.path)}
                        onChange={(e) =>
                          setBinds((prev) => (e.target.checked ? [...prev, b.path] : prev.filter((p) => p !== b.path)))
                        }
                      />
                      <span className="min-w-0">
                        <span className="font-mono text-xs break-all">{b.path}</span>
                        <span className="text-xs text-muted-foreground block">
                          {b.containers.join(', ')}{b.readOnly ? ' · read-only' : ''}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        <div>
          <Label>Repository</Label>
          <select className={selectCls} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>

        {/* ── Schedule ── */}
        <div className="rounded-md border border-border p-3">
          <Label>Schedule</Label>
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
                  {Array.from({ length: 24 }, (_, i) => i).map((h) => (
                    <option key={h} value={h}>{String(h).padStart(2, '0')}</option>
                  ))}
                </select>
                <span className="pb-2">:</span>
                <select className={`${selectCls} w-auto`} value={minute} onChange={(e) => setMinute(Number(e.target.value))}>
                  {[0, 15, 30, 45].map((m) => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
                </select>
              </>
            )}
          </div>
          {frequency !== 'off' && (
            <p className="text-xs text-muted-foreground mt-2">Server local time. A scheduled run captures exactly what “Back up now” does.</p>
          )}
        </div>

        {/* ── Transfer ── */}
        <div className="rounded-md border border-border p-3">
          <Label>Transfer</Label>
          <select
            className={`${selectCls} mt-1`}
            value={transfer}
            onChange={(e) => setTransfer(e.target.value as TransferMode)}
          >
            <option value="direct" disabled={detail?.requiresRelay}>
              Direct — a helper container on the host writes to the repository{detail?.requiresRelay ? ' (needs SSH)' : ''}
            </option>
            <option value="relay">Relay — Cerebro pulls the data and writes the snapshot itself</option>
          </select>
          <p className="text-xs text-muted-foreground mt-1">
            {transfer === 'direct'
              ? 'Bulk data goes straight from the host to the repository and never touches Cerebro. The host needs SSH, outbound network, and to be able to pull the helper image.'
              : 'For a host with no SSH or no outbound network. Every byte crosses the network twice and is staged on Cerebro’s disk, and dump hooks, compose capture and credential files are unavailable.'}
          </p>
        </div>

        {/* ── Consistency ── */}
        <div className="rounded-md border border-border p-3">
          <Label>Consistency</Label>
          <select className={`${selectCls} mt-1`} value={quiesce} onChange={(e) => setQuiesce(e.target.value as QuiesceMode)}>
            <option value="hot">Hot — never interrupt the stack</option>
            <option value="pause">Pause — freeze the containers for the capture</option>
            <option value="stop">Stop — take the stack down for the capture</option>
          </select>
          <p className="text-xs text-muted-foreground mt-1">
            {quiesce === 'hot'
              ? 'Fastest, but a copy of a live database’s files is mid-write and may not restore. Pair it with a dump hook below.'
              : quiesce === 'pause'
                ? 'Processes are frozen, so on-disk state stops changing. Open connections survive; clients see a stall for the length of the capture.'
                : 'The cleanest copy, and real downtime: the stack is stopped for the capture and started again afterwards, whether or not the backup succeeds.'}
          </p>
        </div>

        {/* ── Hooks ── */}
        {detail && transfer === 'direct' && (
          <div className="rounded-md border border-border p-3 space-y-3">
            <div>
              <Label>Dump hooks</Label>
              <p className="text-xs text-muted-foreground mt-1">
                Commands run in the stack’s own containers, before and after the capture. The usual
                use is a database dump redirected into a path inside a captured volume, which is how
                a live database gets a consistent backup without stopping.
              </p>
            </div>
            <HookEditor
              label="Before the capture"
              hooks={preHooks}
              onChange={setPreHooks}
              placeholder="pg_dump -U postgres app > /var/lib/postgresql/data/cerebro-dump.sql"
            />
            <HookEditor
              label="After the capture"
              hooks={postHooks}
              onChange={setPostHooks}
              placeholder="rm -f /var/lib/postgresql/data/cerebro-dump.sql"
            />
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
          <p className="text-xs text-muted-foreground mt-1">Passed to restic as <code>--exclude</code>. Useful for caches and thumbnails inside a captured volume.</p>
        </div>

        <div>
          <Label>Secrets</Label>
          <select className={selectCls} value={secretMode} onChange={(e) => setSecretMode(e.target.value as SecretMode)}>
            <option value="embed">Sealed — values encrypted with a passphrase</option>
            <option value="reference" disabled={!secrets?.referenceReady}>
              Vault reference — store no values at all{secrets?.referenceReady ? '' : ' (not available for this stack)'}
            </option>
            <option value="raw">Raw — values stored as-is (restic encryption only)</option>
          </select>
          <p className="text-xs text-muted-foreground mt-1">
            {secretMode === 'embed'
              ? 'The stack can be restored even if Cerebro and its vault are gone, and the repository alone never yields credentials.'
              : secretMode === 'reference'
                ? 'The snapshot holds only vault keys, so it carries no credentials whatsoever — but restoring it needs this Cerebro’s vault, so restore the system backup first in a full disaster.'
                : 'Simplest to restore, but anyone who can read the repository can read the stack’s credentials.'}
          </p>
          {secrets && !secrets.referenceReady && (
            <p className="text-xs text-muted-foreground mt-1">
              Vault reference unavailable: {secrets.referenceBlockedBy} Open the stack’s secrets view to promote them into the vault.
            </p>
          )}
        </div>

        {secretMode === 'embed' && (
          <div className={needsStoredPass ? 'rounded-md border border-amber-500/40 bg-amber-500/10 p-3' : ''}>
            <Label>
              Stored sealing passphrase
              {policy?.hasSealPassphrase && <span className="text-muted-foreground font-normal"> (set — leave blank to keep)</span>}
            </Label>
            <Input
              type="password"
              value={sealPassphrase}
              onChange={(e) => setSealPassphrase(e.target.value)}
              autoComplete="new-password"
              placeholder={policy?.hasSealPassphrase ? '••••••••' : ''}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {needsStoredPass
                ? 'A scheduled sealed backup has nobody to prompt, so the passphrase must be stored in the vault first.'
                : 'Held in the vault so scheduled runs can seal unattended. Write it down somewhere outside Cerebro — it is what makes a sealed backup restorable when Cerebro itself is gone.'}
            </p>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** A small list editor for pre/post hooks. */
function HookEditor({ label, hooks, onChange, placeholder }: {
  label: string;
  hooks: StackHook[];
  onChange: (h: StackHook[]) => void;
  placeholder: string;
}) {
  const set = (i: number, patch: Partial<StackHook>) =>
    onChange(hooks.map((h, n) => (n === i ? { ...h, ...patch } : h)));

  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">{label}</div>
      {hooks.map((h, i) => (
        <div key={i} className="flex items-start gap-2 mb-1.5">
          <Input
            className="h-8 text-xs w-40 shrink-0"
            placeholder="service"
            value={h.service ?? ''}
            onChange={(e) => set(i, { service: e.target.value })}
          />
          <Input
            className="h-8 text-xs font-mono flex-1"
            placeholder={placeholder}
            value={h.cmd}
            onChange={(e) => set(i, { cmd: e.target.value })}
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label="Remove hook"
            onClick={() => onChange(hooks.filter((_, n) => n !== i))}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => onChange([...hooks, { service: '', cmd: '' }])}>
        <Plus className="h-3.5 w-3.5 mr-1.5" /> Add
      </Button>
    </div>
  );
}

/**
 * Trial-restore a snapshot. The sandbox runs with no published ports and is torn
 * down afterwards, so this is safe to run against a production host — but it does
 * start real containers, which is why it asks first.
 */
function VerifyDialog({ targetId, snapshot, hosts, onClose, onStarted }: {
  targetId: string;
  snapshot: StackSnapshot;
  hosts: BackupHost[];
  onClose: () => void;
  onStarted: (run: StackRestoreRun) => void;
}) {
  const [destInstanceId, setDestInstanceId] = useState(
    snapshot.hostId && hosts.some((h) => h.id === snapshot.hostId) ? snapshot.hostId : hosts[0]?.id ?? '',
  );
  const [passphrase, setPassphrase] = useState('');
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function start() {
    setBusy(true); setErr(null);
    const body: VerifyRestoreInput = {
      targetId, snapshotId: snapshot.id, destInstanceId,
      passphrase: passphrase || undefined, keep,
    };
    try {
      onStarted(await api.post<StackRestoreRun>('/api/stack-backup/restore/verify', body));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not start the trial restore.');
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Verify ${snapshot.stackName ?? 'stack'} · ${snapshot.shortId}`}
      description="Restores into a throwaway stack, waits for it to report healthy, then removes it and its volumes."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void start()} disabled={busy || !destInstanceId}>
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Start trial
          </Button>
        </>
      }
    >
      {err && <div className="mb-3 text-sm text-destructive">{err}</div>}
      <div className="space-y-3">
        <div>
          <Label>Run the trial on</Label>
          <select className={selectCls} value={destInstanceId} onChange={(e) => setDestInstanceId(e.target.value)}>
            {hosts.map((h) => (
              <option key={h.id} value={h.id} disabled={!h.backupable}>{h.name}{h.backupable ? '' : ' (no SSH)'}</option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground mt-1">
            The sandbox publishes no host ports, so it cannot collide with anything already running here.
          </p>
        </div>
        <div>
          <Label>Sealing passphrase <span className="text-muted-foreground font-normal">(only if this snapshot is sealed)</span></Label>
          <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" />
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          <span>
            Leave the sandbox running
            <span className="block text-xs text-muted-foreground">To poke at it yourself. Remember to remove it afterwards.</span>
          </span>
        </label>
      </div>
    </Dialog>
  );
}

/** Ask for the sealing passphrase before a sealed-secrets backup runs. */
function PassphraseDialog({ policy, onClose, onRun }: {
  policy: StackBackupPolicy;
  onClose: () => void;
  onRun: (passphrase: string) => void | Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = !!confirm && value !== confirm;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Back up ${policy.stackName}`}
      description="This backup seals the stack's secrets. You will need this passphrase to restore them — Cerebro does not store it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void onRun(value)} disabled={!value || mismatch}>Start backup</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <Label>Passphrase</Label>
          <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" />
        </div>
        <div>
          <Label>Confirm</Label>
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          {mismatch && <p className="text-xs text-destructive mt-1">The two entries differ.</p>}
        </div>
        <p className="text-xs text-muted-foreground">
          Use the same passphrase every time for this stack, or each snapshot will need its own.
        </p>
      </div>
    </Dialog>
  );
}

/** `instanceId/stackName` — the stack name may itself contain no slash (compose forbids it). */
function splitKey(key: string): [string, string] {
  const i = key.indexOf('/');
  return [key.slice(0, i), key.slice(i + 1)];
}
