import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, Boxes, CheckCircle2, HardDriveDownload, Loader2, RefreshCw, RotateCcw, ScrollText,
  Server, TriangleAlert, Undo2,
} from 'lucide-react';
import type {
  BackupHost, CfTunnelOption, IngressTarget, MigrateIngressSpec, MigratePlan, NpmCertOption, SecretMode,
  StackBackupCandidate, StackBackupTarget, StackMigrationRun,
} from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const selectCls = 'mt-1 w-full h-9 rounded-md border border-input bg-background/60 px-2 text-sm';

const STATUS_COLOR: Record<string, string> = {
  success: 'text-emerald-400',
  running: 'text-amber-400',
  error: 'text-destructive',
};

const STEP_LABEL: Record<string, string> = {
  planned: 'Planned',
  'transferring-images': 'Transferring images',
  'pre-copying': 'Warm pre-copy',
  'pre-restoring': 'Pre-restoring to target',
  quiescing: 'Stopping source',
  capturing: 'Capturing',
  restoring: 'Restoring on target',
  verifying: 'Verifying health',
  'awaiting-cutover': 'Awaiting cutover',
  completing: 'Tearing down source',
  done: 'Done',
  failed: 'Failed',
  rolled_back: 'Rolled back',
};

function formatBytes(n?: number): string {
  if (!n || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

const CHECK_CLS: Record<string, string> = { pass: 'text-emerald-400', warn: 'text-amber-400', fail: 'text-destructive' };

const IMAGE_BADGE: Record<string, { label: string; cls: string }> = {
  present: { label: 'already on target', cls: 'bg-muted text-muted-foreground' },
  pull: { label: 'pull from registry', cls: 'bg-sky-500/15 text-sky-300' },
  transfer: { label: 'save → load (built on host)', cls: 'bg-amber-500/15 text-amber-300' },
};

export function StackMigrate() {
  const { can } = useAuth();
  const canMigrate = can('backup:restore');

  const [candidates, setCandidates] = useState<StackBackupCandidate[]>([]);
  const [hosts, setHosts] = useState<BackupHost[]>([]);
  const [targets, setTargets] = useState<StackBackupTarget[]>([]);
  const [runs, setRuns] = useState<StackMigrationRun[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // Form
  const [sourceKey, setSourceKey] = useState(''); // `${instanceId}::${stackName}`
  const [destInstanceId, setDestInstanceId] = useState('');
  const [destStackName, setDestStackName] = useState('');
  const [repoTargetId, setRepoTargetId] = useState('');
  const [secretMode, setSecretMode] = useState<SecretMode>('embed');
  const [quiesceSource, setQuiesceSource] = useState(true);
  const [warmPrecopy, setWarmPrecopy] = useState(true);
  const [preRestore, setPreRestore] = useState(true);
  const [passphrase, setPassphrase] = useState('');
  const [copyBinds, setCopyBinds] = useState(false);
  const [bindTargets, setBindTargets] = useState<Record<string, string>>({});
  const [restoreCredFiles, setRestoreCredFiles] = useState(false);
  const [repointReplicator, setRepointReplicator] = useState(true);

  // Automated-cutover ingress (optional, P2)
  const [ingressTargets, setIngressTargets] = useState<IngressTarget[]>([]);
  const [ingressEnabled, setIngressEnabled] = useState(false);
  const [ingressInstanceId, setIngressInstanceId] = useState('');
  const [ingressHostname, setIngressHostname] = useState('');
  const [ingressPort, setIngressPort] = useState('');
  const [tunnels, setTunnels] = useState<CfTunnelOption[]>([]);
  const [ingressTunnelId, setIngressTunnelId] = useState('');
  const [certs, setCerts] = useState<NpmCertOption[]>([]);
  const [ingressCertId, setIngressCertId] = useState('0');

  const [plan, setPlan] = useState<MigratePlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [logFor, setLogFor] = useState<StackMigrationRun | null>(null);

  const source = useMemo(() => {
    const [instanceId, stackName] = sourceKey.split('::');
    return candidates.find((c) => c.connectorInstanceId === instanceId && c.stackName === stackName) ?? null;
  }, [sourceKey, candidates]);

  const ingressKind = useMemo(
    () => ingressTargets.find((t) => t.instanceId === ingressInstanceId)?.kind ?? null,
    [ingressTargets, ingressInstanceId],
  );

  // Load tunnels (Cloudflare) or certs (NPM) for the chosen ingress connector.
  useEffect(() => {
    if (!ingressEnabled || !ingressInstanceId) return;
    if (ingressKind === 'cloudflare') {
      void api.get<CfTunnelOption[]>(`/api/stack-migrate/ingress/tunnels?instanceId=${ingressInstanceId}`).then(setTunnels).catch(() => setTunnels([]));
    } else if (ingressKind === 'npm') {
      void api.get<NpmCertOption[]>(`/api/stack-migrate/ingress/certs?instanceId=${ingressInstanceId}`).then(setCerts).catch(() => setCerts([]));
    }
  }, [ingressEnabled, ingressInstanceId, ingressKind]);

  const buildIngress = useCallback((): MigrateIngressSpec | undefined => {
    const port = Number(ingressPort);
    if (!ingressEnabled || !ingressInstanceId || !ingressHostname.trim() || !Number.isFinite(port) || port <= 0) return undefined;
    return {
      instanceId: ingressInstanceId,
      hostname: ingressHostname.trim(),
      port,
      tunnelId: ingressKind === 'cloudflare' ? ingressTunnelId || undefined : undefined,
      certificateId: ingressKind === 'npm' ? Number(ingressCertId) || 0 : undefined,
    };
  }, [ingressEnabled, ingressInstanceId, ingressHostname, ingressPort, ingressKind, ingressTunnelId, ingressCertId]);

  const load = useCallback(async () => {
    try {
      const [cands, hs, ts, rs, ing] = await Promise.all([
        api.get<StackBackupCandidate[]>('/api/stack-backup/candidates'),
        api.get<BackupHost[]>('/api/stack-backup/hosts'),
        api.get<StackBackupTarget[]>('/api/stack-backup/targets'),
        api.get<StackMigrationRun[]>('/api/stack-migrate/runs?limit=25'),
        api.get<IngressTarget[]>('/api/stack-migrate/ingress/targets').catch(() => []),
      ]);
      setCandidates(cands);
      setHosts(hs);
      setTargets(ts);
      setRuns(rs);
      setIngressTargets(ing);
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Poll while anything is mid-flight.
  useEffect(() => {
    if (!runs.some((r) => r.status === 'running')) return;
    const t = setInterval(() => {
      void api.get<StackMigrationRun[]>('/api/stack-migrate/runs?limit=25').then(setRuns).catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [runs]);

  const doPlan = async () => {
    if (!source || !destInstanceId || !repoTargetId) return;
    setPlanning(true); setErr(null); setPlan(null);
    try {
      const p = await api.post<MigratePlan>('/api/stack-migrate/plan', {
        sourceInstanceId: source.connectorInstanceId,
        stackName: source.stackName,
        destInstanceId,
        destStackName: destStackName.trim() || undefined,
        repoTargetId,
        secretMode,
        ingress: buildIngress(),
      });
      setPlan(p);
      if (p.secretMode) setSecretMode(p.secretMode);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Planning failed.');
    } finally {
      setPlanning(false);
    }
  };

  const doStart = async (force: boolean) => {
    if (!plan) return;
    if (!confirm(`Start migration of "${plan.stackName}"?\n\nThis STOPS it on ${plan.sourceHostName ?? 'the source host'} during the copy. It stays stopped until you Complete (cut over) or Rollback.`)) return;
    setStarting(true); setErr(null);
    try {
      const includeBinds = copyBinds && plan.binds.length ? plan.binds : undefined;
      const bindMap = includeBinds
        ? Object.fromEntries(includeBinds.map((s) => [s, (bindTargets[s] ?? '').trim() || s]).filter(([s, t]) => t !== s))
        : undefined;
      const run = await api.post<StackMigrationRun>('/api/stack-migrate/start', {
        sourceInstanceId: plan.sourceInstanceId,
        stackName: plan.stackName,
        destInstanceId: plan.destInstanceId,
        destStackName: plan.destStackName,
        repoTargetId: plan.repoTargetId,
        secretMode: plan.secretMode,
        quiesceSource,
        warmPrecopy,
        preRestore,
        passphrase: passphrase.trim() || undefined,
        ingress: plan.ingress ?? undefined,
        includeBinds,
        bindMap: bindMap && Object.keys(bindMap).length ? bindMap : undefined,
        restoreCredentialFiles: restoreCredFiles || undefined,
        repointReplicator: plan.replicator ? repointReplicator : undefined,
        force,
      });
      setRuns((rs) => [run, ...rs]);
      setPlan(null);
      setPassphrase('');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not start the migration.');
    } finally {
      setStarting(false);
    }
  };

  const act = async (id: string, kind: 'complete' | 'rollback' | 'force-fail') => {
    setErr(null);
    try {
      const run = await api.post<StackMigrationRun>(`/api/stack-migrate/runs/${id}/${kind}`);
      setRuns((rs) => rs.map((r) => (r.id === id ? run : r)));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : `Could not ${kind}.`);
    }
  };

  const openLog = async (id: string) => {
    try { setLogFor(await api.get<StackMigrationRun>(`/api/stack-migrate/runs/${id}`)); } catch { /* ignore */ }
  };

  // Live-tail the open log while its run is still in flight.
  const logTerminal = !logFor || ['done', 'failed', 'rolled_back'].includes(logFor.step);
  useEffect(() => {
    if (!logFor || logTerminal) return;
    const t = setInterval(() => {
      void api.get<StackMigrationRun>(`/api/stack-migrate/runs/${logFor.id}`).then(setLogFor).catch(() => undefined);
    }, 2000);
    return () => clearInterval(t);
  }, [logFor, logTerminal]);

  const readyToPlan = !!source && !!destInstanceId && !!repoTargetId && source.connectorInstanceId !== destInstanceId;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stack Migrate"
        description="Move a Compose stack from one Docker host to another — volumes, config, secrets and images (including images built on the host)."
      />

      {err && (
        <div className="text-sm rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2">{err}</div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Boxes className="h-4 w-4 text-primary" /> Plan a migration</CardTitle>
          <CardDescription>Cold migration: the source is stopped for a consistent copy, the target is brought up and health-checked, then you flip ingress and complete.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Source stack</Label>
              <select className={selectCls} value={sourceKey} onChange={(e) => { setSourceKey(e.target.value); setPlan(null); }}>
                <option value="">Choose a stack…</option>
                {candidates.map((c) => (
                  <option key={`${c.connectorInstanceId}::${c.stackName}`} value={`${c.connectorInstanceId}::${c.stackName}`}>
                    {c.hostName} · {c.stackName}{c.requiresRelay ? ' (no SSH — relay)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">Target host</Label>
              <select className={selectCls} value={destInstanceId} onChange={(e) => { setDestInstanceId(e.target.value); setPlan(null); }}>
                <option value="">Choose a host…</option>
                {hosts.map((h) => {
                  const isSource = !!source && h.id === source.connectorInstanceId;
                  return (
                    <option key={h.id} value={h.id} disabled={isSource || !h.backupable}>
                      {h.name}{isSource ? ' (source)' : !h.backupable ? ' (needs SSH)' : ''}
                    </option>
                  );
                })}
              </select>
            </div>
            <div>
              <Label className="text-xs">Target stack name (optional)</Label>
              <Input value={destStackName} onChange={(e) => { setDestStackName(e.target.value); setPlan(null); }} placeholder={source?.stackName || 'same as source'} />
            </div>
            <div>
              <Label className="text-xs">Transfer repository</Label>
              <select className={selectCls} value={repoTargetId} onChange={(e) => { setRepoTargetId(e.target.value); setPlan(null); }}>
                <option value="">Choose a restic repo…</option>
                {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs">Secrets / .env</Label>
              <select className={selectCls} value={secretMode} onChange={(e) => { setSecretMode(e.target.value as SecretMode); setPlan(null); }}>
                <option value="raw">Copy values (plaintext in the repo)</option>
                <option value="embed">Seal with a passphrase</option>
                <option value="reference">Reference vault keys (re-resolved on target)</option>
              </select>
            </div>
          </div>

          <div className="rounded-md border border-border/60 p-3 space-y-3">
            <label className="flex items-center gap-2 text-xs font-medium">
              <input type="checkbox" checked={ingressEnabled} onChange={(e) => { setIngressEnabled(e.target.checked); setPlan(null); }} disabled={ingressTargets.length === 0} />
              Automatically flip ingress on cutover
              {ingressTargets.length === 0 && <span className="text-muted-foreground font-normal">(no Cloudflare / NPM connector configured)</span>}
            </label>
            {ingressEnabled && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label className="text-xs">Ingress connector</Label>
                  <select className={selectCls} value={ingressInstanceId} onChange={(e) => { setIngressInstanceId(e.target.value); setPlan(null); }}>
                    <option value="">Choose…</option>
                    {ingressTargets.map((t) => <option key={t.instanceId} value={t.instanceId}>{t.name} ({t.kind === 'cloudflare' ? 'Cloudflare' : 'NPM'})</option>)}
                  </select>
                </div>
                <div>
                  <Label className="text-xs">Public hostname</Label>
                  <Input value={ingressHostname} onChange={(e) => { setIngressHostname(e.target.value); setPlan(null); }} placeholder="app.example.com" />
                </div>
                <div>
                  <Label className="text-xs">Route to target port</Label>
                  <Input type="number" value={ingressPort} onChange={(e) => { setIngressPort(e.target.value); setPlan(null); }} placeholder="8080" />
                </div>
                {ingressKind === 'cloudflare' && (
                  <div>
                    <Label className="text-xs">Cloudflare tunnel</Label>
                    <select className={selectCls} value={ingressTunnelId} onChange={(e) => setIngressTunnelId(e.target.value)}>
                      <option value="">Choose a tunnel…</option>
                      {tunnels.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                )}
                {ingressKind === 'npm' && (
                  <div>
                    <Label className="text-xs">TLS certificate (optional)</Label>
                    <select className={selectCls} value={ingressCertId} onChange={(e) => setIngressCertId(e.target.value)}>
                      {certs.length === 0 && <option value="0">None (HTTP)</option>}
                      {certs.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
                    </select>
                  </div>
                )}
              </div>
            )}
            {ingressEnabled && <p className="text-[0.7rem] text-muted-foreground">On “Cut over” the hostname is repointed to the target before the source is stopped; Rollback points it back.</p>}
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={doPlan} disabled={!readyToPlan || planning}>
              {planning ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />} Plan
            </Button>
            {source && destInstanceId && source.connectorInstanceId === destInstanceId && (
              <span className="text-xs text-muted-foreground">Source and target are the same host.</span>
            )}
          </div>
        </CardContent>
      </Card>

      {plan && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Server className="h-4 w-4" /> {plan.sourceHostName} · {plan.stackName}
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
              <Server className="h-4 w-4" /> {plan.destHostName} · {plan.destStackName}
            </CardTitle>
            <CardDescription>
              {plan.usingExistingPolicy ? 'Reusing the existing backup policy for capture.' : 'A one-off capture will run for this migration.'} Secrets: {plan.secretMode}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {plan.conflicts.length > 0 && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 space-y-1">
                {plan.conflicts.map((c, i) => <div key={i} className="flex gap-2 text-destructive"><TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" /> {c}</div>)}
              </div>
            )}
            {plan.warnings.map((w, i) => (
              <div key={i} className="flex gap-2 text-amber-300 text-xs"><TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" /> {w}</div>
            ))}

            {/* Pre-flight readiness checklist */}
            {plan.checks.length > 0 && (
              <div className="rounded-md border border-border/60 p-3 space-y-1">
                <div className="text-xs font-medium text-muted-foreground mb-1">Pre-flight checks{plan.estimatedDataBytes ? ` · ~${formatBytes(plan.estimatedDataBytes)} of volume data` : ''}</div>
                {plan.checks.map((c) => (
                  <div key={c.id} className="flex items-start gap-2 text-xs">
                    {c.status === 'pass'
                      ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5 text-emerald-400" />
                      : <TriangleAlert className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${CHECK_CLS[c.status]}`} />}
                    <span>
                      <span className={CHECK_CLS[c.status]}>{c.label}</span>
                      {c.detail && <span className="text-muted-foreground"> — {c.detail}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* App Replicator re-point */}
            {plan.replicator && (
              <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3 space-y-1">
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input type="checkbox" checked={repointReplicator} onChange={(e) => setRepointReplicator(e.target.checked)} />
                  Re-point the App Replicator deployment “{plan.replicator.name}” to the target
                </label>
                <p className="text-[0.7rem] text-muted-foreground">
                  This stack is replicator-managed. On cutover, its deployment record and ingress routes move to the target so the replicator keeps managing it. Leave off only if you'll manage the migrated stack as a plain Docker stack (the replicator would then still point at the old host).
                </p>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Images ({plan.images.length})</div>
                <div className="space-y-1">
                  {plan.images.map((im) => (
                    <div key={im.ref} className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs truncate">{im.ref}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[0.65rem] ${IMAGE_BADGE[im.method]?.cls ?? ''}`}>{IMAGE_BADGE[im.method]?.label ?? im.method}</span>
                    </div>
                  ))}
                  {!plan.images.length && <div className="text-xs text-muted-foreground">None detected.</div>}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Volumes ({plan.volumes.length})</div>
                <div className="font-mono text-xs break-words">{plan.volumes.join(', ') || '—'}</div>
                {plan.binds.length > 0 && (
                  <>
                    <div className="text-xs font-medium text-muted-foreground mt-2 mb-1">Bind paths ({plan.binds.length})</div>
                    <div className="font-mono text-xs break-words">{plan.binds.join(', ')}</div>
                  </>
                )}
                {plan.ports.length > 0 && (
                  <>
                    <div className="text-xs font-medium text-muted-foreground mt-2 mb-1">Published ports</div>
                    <div className="text-xs">{plan.ports.map((p) => <span key={p.hostPort} className={p.inUse ? 'text-destructive mr-2' : 'mr-2'}>{p.hostPort}{p.inUse ? ' (in use)' : ''}</span>)}</div>
                  </>
                )}
              </div>
            </div>

            {plan.binds.length > 0 && (
              <div className="rounded-md border border-border/60 p-3 space-y-2">
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input type="checkbox" checked={copyBinds} onChange={(e) => setCopyBinds(e.target.checked)} />
                  Copy bind-mount host paths to the target ({plan.binds.length})
                </label>
                <p className="text-[0.7rem] text-muted-foreground">Named volumes always travel; these are host directories the stack bind-mounts. They restore to the same path unless you remap it.</p>
                {copyBinds && plan.binds.map((b) => (
                  <div key={b} className="grid grid-cols-2 gap-2 items-center">
                    <span className="font-mono text-xs truncate" title={b}>{b}</span>
                    <Input value={bindTargets[b] ?? ''} onChange={(e) => setBindTargets((m) => ({ ...m, [b]: e.target.value }))} placeholder={`target path (default ${b})`} />
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-end gap-3 pt-2 border-t border-border/60">
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={quiesceSource} onChange={(e) => setQuiesceSource(e.target.checked)} />
                Stop the source during copy (consistent — needed for databases)
              </label>
              <label className="flex items-center gap-2 text-xs" title="Back up the running stack first, then stop only for a fast delta — shrinks downtime for large volumes.">
                <input type="checkbox" checked={warmPrecopy} disabled={!quiesceSource} onChange={(e) => setWarmPrecopy(e.target.checked)} />
                Warm pre-copy to shrink downtime{!quiesceSource ? ' (needs stop-during-copy)' : ''}
              </label>
              <label className="flex items-center gap-2 text-xs" title="Also pre-restore the warm data onto the target while the source still runs, so the stop window is just a fast delta restore (live-ish).">
                <input type="checkbox" checked={preRestore} disabled={!quiesceSource || !warmPrecopy} onChange={(e) => setPreRestore(e.target.checked)} />
                Pre-restore to target (live-ish){!quiesceSource || !warmPrecopy ? ' (needs warm pre-copy)' : ''}
              </label>
              <label className="flex items-center gap-2 text-xs" title="Write back credential files captured from compose `secrets: file:` host paths. Needs sealed/plaintext secrets, not vault-reference mode.">
                <input type="checkbox" checked={restoreCredFiles} disabled={plan.secretMode === 'reference'} onChange={(e) => setRestoreCredFiles(e.target.checked)} />
                Restore captured credential files{plan.secretMode === 'reference' ? ' (needs sealed/plaintext secrets)' : ''}
              </label>
              {plan.needsPassphrase && (
                <div>
                  <Label className="text-xs">Backup passphrase</Label>
                  <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="to rebuild the .env" />
                </div>
              )}
            </div>

            {canMigrate ? (
              <div className="flex items-center gap-2">
                {plan.conflicts.length === 0 && !plan.checks.some((c) => c.status === 'fail') ? (
                  <Button onClick={() => doStart(false)} disabled={starting || (plan.needsPassphrase && !passphrase.trim())}>
                    {starting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <HardDriveDownload className="h-4 w-4 mr-1" />} Start migration
                  </Button>
                ) : (
                  <Button variant="destructive" onClick={() => doStart(true)} disabled={starting}>
                    {starting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <TriangleAlert className="h-4 w-4 mr-1" />} Start anyway (override checks)
                  </Button>
                )}
                <span className="text-xs text-muted-foreground">The source is left stopped; flip ingress, then Complete or Rollback.</span>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">You need the <span className="font-mono">backup:restore</span> permission to run a migration.</div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-sm">Migrations</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {runs.length === 0 && <div className="text-xs text-muted-foreground">No migrations yet.</div>}
          {runs.map((r) => (
            <div key={r.id} className="rounded-md border border-border/60 px-3 py-2">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="inline-flex items-center gap-2 min-w-0">
                  {r.status === 'running' ? <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
                    : r.step === 'done' ? <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    : r.step === 'rolled_back' ? <Undo2 className="h-4 w-4 text-muted-foreground" />
                    : r.status === 'error' ? <TriangleAlert className="h-4 w-4 text-destructive" />
                    : <HardDriveDownload className="h-4 w-4 text-muted-foreground" />}
                  <span className="truncate">{r.sourceHostName} · {r.stackName} → {r.destHostName} · {r.destStackName}</span>
                </span>
                <span className={`text-xs shrink-0 ${STATUS_COLOR[r.status] ?? ''}`}>{STEP_LABEL[r.step] ?? r.step}</span>
              </div>
              {r.message && <div className="text-xs text-muted-foreground mt-1">{r.message}</div>}
              {r.ingress && (
                <div className="text-[0.7rem] text-muted-foreground mt-1">
                  Ingress: {r.ingress.hostname} → port {r.ingress.port}{r.ingressFlipped ? ' · flipped to target' : ''}
                </div>
              )}
              {r.replicatorDeploymentId && (
                <div className="text-[0.7rem] text-muted-foreground mt-1">
                  App Replicator deployment{r.replicatorRepointed ? ' · re-pointed to target' : ' · re-points on cutover'}
                </div>
              )}
              <div className="flex items-center gap-2 mt-2">
                <Button variant="ghost" size="sm" onClick={() => openLog(r.id)}><ScrollText className="h-3.5 w-3.5 mr-1" /> Log</Button>
                {canMigrate && r.status === 'running' && (
                  <Button variant="ghost" size="sm" onClick={() => { if (confirm('Force-fail this migration? Its background task may still be finishing — this just lets you roll back a stuck run.')) void act(r.id, 'force-fail'); }} title="Mark a stuck run failed so you can roll it back. The background task may still finish on its own.">
                    <TriangleAlert className="h-3.5 w-3.5 mr-1" /> Force-fail
                  </Button>
                )}
                {canMigrate && r.step === 'awaiting-cutover' && (
                  <Button size="sm" onClick={() => act(r.id, 'complete')}>
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> {r.ingress ? 'Cut over (flip ingress + tear down source)' : 'Complete (tear down source)'}
                  </Button>
                )}
                {canMigrate && (r.step === 'awaiting-cutover' || r.step === 'failed') && (
                  <Button variant="ghost" size="sm" onClick={() => { if (confirm('Roll back? The source restarts and the target is removed. Any writes the target took after cutover are discarded.')) void act(r.id, 'rollback'); }} title="Restarts the source and removes the target. Discards changes the target took after cutover.">
                    <RotateCcw className="h-3.5 w-3.5 mr-1" /> Rollback
                  </Button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {logFor && (
        <div className="fixed inset-0 z-50 bg-black/70 grid place-items-center p-4" onClick={() => setLogFor(null)}>
          <div className="w-[52rem] max-w-full max-h-[80vh] overflow-auto rounded-lg border border-border bg-sidebar p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium inline-flex items-center gap-2">
                {logFor.stackName} → {logFor.destStackName}
                {!logTerminal && <span className="inline-flex items-center gap-1 text-xs text-amber-400"><Loader2 className="h-3 w-3 animate-spin" /> live</span>}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setLogFor(null)}>Close</Button>
            </div>
            <pre className="text-xs whitespace-pre-wrap font-mono text-muted-foreground">{logFor.log || 'No log.'}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
