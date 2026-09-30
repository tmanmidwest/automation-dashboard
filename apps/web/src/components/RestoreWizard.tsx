import { useCallback, useEffect, useRef, useState } from 'react';
import { HardDriveUpload, Loader2, ShieldAlert, TriangleAlert } from 'lucide-react';
import type {
  BackupHost, ExecuteRestoreInput, RestoreMode, RestorePlan, StackRestoreRun, StackSnapshot,
} from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';

const selectCls = 'mt-1 w-full h-9 rounded-md border border-input bg-background/60 px-2 text-sm';

const SECRET_STATE_TEXT: Record<string, string> = {
  resolved: 'matches the vault',
  drifted: 'the vault value changed since this backup',
  missing: 'the vault key is gone',
  sealed: 'comes from the sealed blob',
  plain: 'stored in the snapshot',
};
const SECRET_STATE_COLOR: Record<string, string> = {
  resolved: 'text-emerald-400',
  drifted: 'text-amber-400',
  missing: 'text-amber-400',
  sealed: 'text-muted-foreground',
  plain: 'text-muted-foreground',
};

/**
 * Review-then-execute restore. The plan is recomputed server-side whenever the
 * destination changes, and nothing is written until the operator confirms — a
 * restore overwrites data, so the expensive part of the UI is deliberately the
 * part that shows what is about to be overwritten.
 */
export function RestoreWizard({ targetId, snapshot, hosts, canRestore, onClose, onStarted }: {
  targetId: string;
  snapshot: StackSnapshot;
  hosts: BackupHost[];
  canRestore: boolean;
  onClose: () => void;
  onStarted: (run: StackRestoreRun) => void;
}) {
  const [destInstanceId, setDestInstanceId] = useState(
    snapshot.hostId && hosts.some((h) => h.id === snapshot.hostId) ? snapshot.hostId : hosts[0]?.id ?? '',
  );
  const [destStackName, setDestStackName] = useState('');
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [mode, setMode] = useState<RestoreMode>('full');
  const [deploy, setDeploy] = useState(false);
  const [volumes, setVolumes] = useState<string[]>([]);
  const [binds, setBinds] = useState<string[]>([]);
  const [passphrase, setPassphrase] = useState('');
  const [force, setForce] = useState(false);
  const [starting, setStarting] = useState(false);

  // Keep the very first plan's defaults without fighting the operator's edits.
  const seeded = useRef(false);
  /** The destination the current plan was built for — stops a redundant re-plan. */
  const plannedFor = useRef<string>('');

  const runPlan = useCallback(async (name: string) => {
    if (!destInstanceId) return;
    plannedFor.current = `${destInstanceId}/${name}`;
    setPlanning(true); setErr(null);
    try {
      const p = await api.post<RestorePlan>('/api/stack-backup/restore/plan', {
        targetId, snapshotId: snapshot.id, destInstanceId, destStackName: name || undefined,
      });
      setPlan(p);
      if (!seeded.current) {
        seeded.current = true;
        setDestStackName(p.destStackName);
        setVolumes(p.volumes.map((v) => v.source));
        if (!p.hasCompose) setMode('data');
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not build a restore plan.');
      setPlan(null);
    } finally {
      setPlanning(false);
    }
  }, [targetId, snapshot.id, destInstanceId]);

  useEffect(() => { void runPlan(destStackName); }, [runPlan]);

  // Re-plan on a settled stack name — every keystroke would hammer the repository.
  useEffect(() => {
    if (!seeded.current) return;
    const t = setTimeout(() => {
      if (plannedFor.current === `${destInstanceId}/${destStackName}`) return;
      void runPlan(destStackName);
    }, 600);
    return () => clearTimeout(t);
  }, [destStackName, destInstanceId, runPlan]);

  async function start() {
    if (!plan) return;
    const body: ExecuteRestoreInput = {
      targetId, snapshotId: snapshot.id, destInstanceId, destStackName,
      mode, volumes, binds, deploy: mode === 'full' && deploy,
      passphrase: passphrase || undefined,
      force,
    };
    setStarting(true); setErr(null);
    try {
      onStarted(await api.post<StackRestoreRun>('/api/stack-backup/restore', body));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Restore could not be started.');
      setStarting(false);
    }
  }

  const blocked = !!plan?.conflicts.length && !force;
  const needsPass = mode === 'full' && !!plan?.needsPassphrase && plan.hasEnv;

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={`Restore ${snapshot.stackName ?? 'stack'} · ${snapshot.shortId}`}
      description={`Taken ${new Date(snapshot.time).toLocaleString()}${snapshot.hostLabel ? ` from ${snapshot.hostLabel}` : ''}.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => void start()}
            disabled={!canRestore || !plan || planning || starting || blocked || (needsPass && !passphrase)}
          >
            {starting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <HardDriveUpload className="h-4 w-4 mr-2" />}
            Restore
          </Button>
        </>
      }
    >
      {err && <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</div>}

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Destination host</Label>
            <select className={selectCls} value={destInstanceId} onChange={(e) => setDestInstanceId(e.target.value)}>
              {hosts.map((h) => (
                <option key={h.id} value={h.id} disabled={!h.backupable}>
                  {h.name}{h.backupable ? '' : ' (no SSH)'}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>Stack name</Label>
            <Input value={destStackName} onChange={(e) => setDestStackName(e.target.value)} placeholder={plan?.sourceStackName} />
          </div>
        </div>

        {planning && !plan && (
          <div className="py-6 text-center text-muted-foreground text-sm">
            <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" /> Reading the snapshot…
          </div>
        )}

        {plan && (
          <>
            {plan.destStackName !== plan.sourceStackName && (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
                Restoring as a copy. Volumes named after the original stack are renamed to match
                <span className="font-mono"> {plan.destStackName}_…</span>, so the copy uses its own data.
              </div>
            )}

            {plan.conflicts.map((c) => (
              <div key={c} className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive flex gap-2">
                <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" /> <span>{c}</span>
              </div>
            ))}
            {plan.warnings.map((w) => (
              <div key={w} className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300 flex gap-2">
                <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" /> <span>{w}</span>
              </div>
            ))}

            <div>
              <Label>Restore</Label>
              <select className={selectCls} value={mode} onChange={(e) => setMode(e.target.value as RestoreMode)}>
                <option value="full" disabled={!plan.hasCompose}>
                  Everything — data plus the compose file and .env{plan.hasCompose ? '' : ' (no compose in this snapshot)'}
                </option>
                <option value="data">Data only — leave the stack’s configuration alone</option>
              </select>
              {mode === 'full' && (
                <label className="flex items-center gap-2 text-sm mt-2">
                  <input type="checkbox" checked={deploy} onChange={(e) => setDeploy(e.target.checked)} />
                  Bring the stack up afterwards (<span className="font-mono text-xs">docker compose up -d</span>)
                </label>
              )}
            </div>

            <div>
              <Label>Volumes</Label>
              {!plan.volumes.length ? (
                <p className="text-xs text-muted-foreground mt-1">This snapshot has no named volumes.</p>
              ) : (
                <div className="space-y-1.5 mt-1 max-h-40 overflow-auto">
                  {plan.volumes.map((v) => (
                    <label key={v.source} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={volumes.includes(v.source)}
                        onChange={(e) =>
                          setVolumes((p) => (e.target.checked ? [...p, v.source] : p.filter((x) => x !== v.source)))
                        }
                      />
                      <span className="min-w-0">
                        <span className="font-mono text-xs break-all">{v.source}</span>
                        {v.dest !== v.source && <span className="font-mono text-xs text-muted-foreground"> → {v.dest}</span>}
                        <span className="block text-xs text-muted-foreground">
                          {v.exists ? 'already exists on the destination — will be written into' : 'will be created'}
                          {v.driver && v.driver !== 'local' ? ` · driver ${v.driver}` : ''}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {plan.binds.length > 0 && (
              <div>
                <Label>Bind paths</Label>
                <p className="text-xs text-muted-foreground mb-1">
                  These write over directories on the destination host. Unticked by default.
                </p>
                <div className="space-y-1.5 max-h-32 overflow-auto">
                  {plan.binds.map((b) => (
                    <label key={b.source} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={binds.includes(b.source)}
                        onChange={(e) =>
                          setBinds((p) => (e.target.checked ? [...p, b.source] : p.filter((x) => x !== b.source)))
                        }
                      />
                      <span className="font-mono text-xs break-all">{b.dest}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {plan.secrets.length > 0 && (
              <div>
                <Label>Secrets</Label>
                <p className="text-xs text-muted-foreground mb-1">
                  The restore writes the snapshot’s values, so they match the data being restored.
                </p>
                <div className="max-h-32 overflow-auto text-xs space-y-0.5">
                  {plan.secrets.map((s) => (
                    <div key={s.name} className="flex items-baseline gap-2">
                      <span className="font-mono">{s.name}</span>
                      <span className={SECRET_STATE_COLOR[s.state] ?? 'text-muted-foreground'}>
                        {SECRET_STATE_TEXT[s.state] ?? s.state}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {needsPass && (
              <div>
                <Label>Sealing passphrase</Label>
                <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" />
                <p className="text-xs text-muted-foreground mt-1">The one used when this backup was taken — it rebuilds the stack’s .env.</p>
              </div>
            )}

            {!!plan.conflicts.length && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={force} onChange={(e) => setForce(e.target.checked)} />
                <span>
                  Restore anyway, overwriting what is already there.
                  <span className="block text-xs text-muted-foreground">Existing volume contents and any running stack of this name are at stake.</span>
                </span>
              </label>
            )}

            {!canRestore && (
              <p className="text-xs text-muted-foreground">You do not have the backup:restore permission.</p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
