import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, Boxes, CheckCircle2, HardDriveDownload, Loader2, Plus, RefreshCw, RotateCcw, ScrollText,
  Search, Server, Trash2, TriangleAlert, Undo2, X,
} from 'lucide-react';
import type {
  BackupHost, CfTunnelOption, IngressTarget, MigrateIngressSpec, MigrateIngressSuggestion, MigratePlan,
  NpmCertOption, SecretMode, StackBackupCandidate, StackBackupTarget, StackMigrationRun,
} from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const selectCls = 'mt-1 w-full h-9 rounded-md border border-input bg-background/60 px-2 text-sm';

/** One editable ingress route row in the cutover form (port/cert kept as strings for inputs). */
interface RouteRow {
  instanceId: string;
  hostname: string;
  port: string;
  tunnelId: string;
  certId: string;
  /** Cloudflare path-based rule matcher (blank = host-level route). */
  path: string;
  /** Real priority within the tunnel (first-match-wins); informational, preserved on flip. */
  order?: number;
}
const emptyRoute = (): RouteRow => ({ instanceId: '', hostname: '', port: '', tunnelId: '', certId: '0', path: '' });

const STATUS_COLOR: Record<string, string> = {
  success: 'text-emerald-400',
  running: 'text-amber-400',
  error: 'text-destructive',
  cancelled: 'text-muted-foreground',
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
  cancelling: 'Cancelling',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
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

const SECRET_HELP: Record<string, string> = {
  embed: 'Reads the stack’s current environment and carries it, encrypted with a passphrase you set below. Works no matter where the secrets live. Recommended.',
  raw: 'Reads the stack’s current environment and carries it as-is — simplest, but the values sit unencrypted in the transfer repository.',
  reference: 'Does NOT carry secret values — it stores only references to Cerebro vault keys and re-reads them from the TARGET’s vault on restore. Use only when those secrets already exist in the vault on the target; the migration fails if a referenced key is missing.',
};

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
  const [overwriteTarget, setOverwriteTarget] = useState(false);

  // Automated-cutover ingress (optional, P2) — a stack can front multiple routes.
  const [ingressTargets, setIngressTargets] = useState<IngressTarget[]>([]);
  const [ingressEnabled, setIngressEnabled] = useState(false);
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [tunnelsByInstance, setTunnelsByInstance] = useState<Record<string, CfTunnelOption[]>>({});
  const [certsByInstance, setCertsByInstance] = useState<Record<string, NpmCertOption[]>>({});
  const [ingressFetching, setIngressFetching] = useState(false);
  const [ingressFetchMsg, setIngressFetchMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [plan, setPlan] = useState<MigratePlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [logFor, setLogFor] = useState<StackMigrationRun | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);

  const source = useMemo(() => {
    const [instanceId, stackName] = sourceKey.split('::');
    return candidates.find((c) => c.connectorInstanceId === instanceId && c.stackName === stackName) ?? null;
  }, [sourceKey, candidates]);

  const kindOf = useCallback(
    (instanceId: string) => ingressTargets.find((t) => t.instanceId === instanceId)?.kind ?? null,
    [ingressTargets],
  );

  // Load tunnels (Cloudflare) / certs (NPM) for every connector referenced by a route,
  // once each. Each row can point at a different connector.
  useEffect(() => {
    if (!ingressEnabled) return;
    const ids = [...new Set(routes.map((r) => r.instanceId).filter(Boolean))];
    for (const id of ids) {
      const kind = kindOf(id);
      if (kind === 'cloudflare' && !tunnelsByInstance[id]) {
        void api.get<CfTunnelOption[]>(`/api/stack-migrate/ingress/tunnels?instanceId=${id}`)
          .then((t) => setTunnelsByInstance((m) => ({ ...m, [id]: t })))
          .catch(() => setTunnelsByInstance((m) => ({ ...m, [id]: [] })));
      } else if (kind === 'npm' && !certsByInstance[id]) {
        void api.get<NpmCertOption[]>(`/api/stack-migrate/ingress/certs?instanceId=${id}`)
          .then((c) => setCertsByInstance((m) => ({ ...m, [id]: c })))
          .catch(() => setCertsByInstance((m) => ({ ...m, [id]: [] })));
      }
    }
  }, [ingressEnabled, routes, kindOf, tunnelsByInstance, certsByInstance]);

  const updateRoute = (i: number, patch: Partial<RouteRow>) => {
    setRoutes((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setPlan(null);
  };
  const addRoute = () => { setRoutes((rs) => [...rs, emptyRoute()]); setPlan(null); };
  const removeRoute = (i: number) => { setRoutes((rs) => rs.filter((_, idx) => idx !== i)); setPlan(null); };

  const buildIngressRoutes = useCallback((): MigrateIngressSpec[] => {
    if (!ingressEnabled) return [];
    const out: MigrateIngressSpec[] = [];
    for (const r of routes) {
      const port = Number(r.port);
      if (!r.instanceId || !r.hostname.trim() || !Number.isFinite(port) || port <= 0) continue;
      const kind = kindOf(r.instanceId);
      out.push({
        instanceId: r.instanceId,
        hostname: r.hostname.trim(),
        port,
        tunnelId: kind === 'cloudflare' ? r.tunnelId || undefined : undefined,
        certificateId: kind === 'npm' ? Number(r.certId) || 0 : undefined,
        path: kind === 'cloudflare' && r.path.trim() ? r.path.trim() : undefined,
        order: r.order,
      });
    }
    return out;
  }, [ingressEnabled, routes, kindOf]);

  // "Fetch existing route(s)": look up every live route pointing at the source stack and
  // load them into the editable list (replacing what's there), so nothing must be retyped.
  const fetchIngress = useCallback(async () => {
    if (!source) return;
    setIngressFetching(true);
    setIngressFetchMsg(null);
    try {
      const sugs = await api.get<MigrateIngressSuggestion[]>(
        `/api/stack-migrate/ingress/detect?instanceId=${encodeURIComponent(source.connectorInstanceId)}&stackName=${encodeURIComponent(source.stackName)}`,
      );
      if (sugs.length) {
        setRoutes(sugs.map((s) => ({
          instanceId: s.instanceId,
          hostname: s.hostname,
          port: String(s.port),
          tunnelId: s.tunnelId ?? '',
          certId: typeof s.certificateId === 'number' ? String(s.certificateId) : '0',
          path: s.path ?? '',
          order: s.order,
        })));
        setPlan(null);
        setIngressFetchMsg({ ok: true, text: `Found ${sugs.length} route${sugs.length === 1 ? '' : 's'} (in priority order): ${sugs.map((s) => `${s.hostname}${s.path ?? ''}`).join(', ')}. Loaded below — their order is preserved on cutover.` });
      } else {
        setIngressFetchMsg({ ok: false, text: 'No existing routes found for this stack. Add one manually below.' });
      }
    } catch (e) {
      setIngressFetchMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not look up ingress.' });
    } finally {
      setIngressFetching(false);
    }
  }, [source]);

  const load = useCallback(async () => {
    try {
      const [cands, hs, ts, rs, ing] = await Promise.all([
        api.get<StackBackupCandidate[]>('/api/stack-backup/candidates'),
        api.get<BackupHost[]>('/api/stack-backup/hosts'),
        api.get<StackBackupTarget[]>('/api/stack-backup/targets'),
        api.get<StackMigrationRun[]>('/api/stack-migrate/runs?limit=25&includeArchived=1'),
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
      void api.get<StackMigrationRun[]>('/api/stack-migrate/runs?limit=25&includeArchived=1').then(setRuns).catch(() => undefined);
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
        overwriteTarget,
        ingressRoutes: buildIngressRoutes(),
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
        ingressRoutes: plan.ingressRoutes ?? undefined,
        includeBinds,
        bindMap: bindMap && Object.keys(bindMap).length ? bindMap : undefined,
        restoreCredentialFiles: restoreCredFiles || undefined,
        repointReplicator: plan.replicator ? repointReplicator : undefined,
        overwriteTarget: overwriteTarget || undefined,
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

  const act = async (id: string, kind: 'complete' | 'rollback' | 'force-fail' | 'cancel' | 'dismiss' | 'restore') => {
    setErr(null);
    try {
      const run = await api.post<StackMigrationRun>(`/api/stack-migrate/runs/${id}/${kind}`);
      setRuns((rs) => rs.map((r) => (r.id === id ? run : r)));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : `Could not ${kind}.`);
    }
  };

  // Retry a terminal run: pre-fill the Plan form from it (the source still exists for a
  // failed/cancelled/rolled-back run), so the operator can re-plan — adjusting options
  // (e.g. turn off copy-binds) — rather than hand-retyping everything.
  const retry = (r: StackMigrationRun) => {
    setSourceKey(`${r.sourceInstanceId}::${r.stackName}`);
    setDestInstanceId(r.destInstanceId);
    setDestStackName(r.destStackName === r.stackName ? '' : r.destStackName);
    setRepoTargetId(r.repoTargetId);
    const rts = r.ingressRoutes ?? [];
    setIngressEnabled(rts.length > 0);
    setRoutes(rts.map((s) => ({
      instanceId: s.instanceId,
      hostname: s.hostname,
      port: String(s.port),
      tunnelId: s.tunnelId ?? '',
      certId: typeof s.certificateId === 'number' ? String(s.certificateId) : '0',
      path: s.path ?? '',
      order: s.order,
    })));
    setPlan(null);
    setErr(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const dismissAllFinished = async () => {
    const finished = runs.filter((r) => !r.archived && r.status !== 'running' && r.step !== 'awaiting-cutover');
    if (!finished.length) return;
    if (!confirm(`Dismiss ${finished.length} finished migration${finished.length === 1 ? '' : 's'}? They’re hidden from the list (kept in history — use “Show dismissed” to see them). Any failed run that left a partial target is hidden too, so roll those back first if you still need to.`)) return;
    setErr(null);
    try {
      await api.post('/api/stack-migrate/runs/dismiss-finished');
      const rs = await api.get<StackMigrationRun[]>('/api/stack-migrate/runs?limit=25&includeArchived=1');
      setRuns(rs);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not dismiss finished migrations.');
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
              <select className={selectCls} value={sourceKey} onChange={(e) => { setSourceKey(e.target.value); setPlan(null); setIngressFetchMsg(null); }}>
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
            <div className="col-span-2">
              <Label className="text-xs">Secrets / .env</Label>
              <select className={selectCls} value={secretMode} onChange={(e) => { setSecretMode(e.target.value as SecretMode); setPlan(null); }}>
                <option value="embed">Sealed — carry the values, encrypted (recommended)</option>
                <option value="raw">Plaintext — carry the values, unencrypted</option>
                <option value="reference">Vault reference — re-read from the target’s vault (advanced)</option>
              </select>
              <p className={`text-[0.7rem] mt-1 ${secretMode === 'reference' ? 'text-amber-300' : 'text-muted-foreground'}`}>{SECRET_HELP[secretMode]}</p>
            </div>
          </div>

          <div className="rounded-md border border-border/60 p-3 space-y-1">
            <label className="flex items-center gap-2 text-xs font-medium">
              <input type="checkbox" checked={overwriteTarget} onChange={(e) => { setOverwriteTarget(e.target.checked); setPlan(null); }} />
              Overwrite existing target stack
            </label>
            <p className={`text-[0.7rem] ${overwriteTarget ? 'text-amber-300' : 'text-muted-foreground'}`}>
              If a stack with the target name already exists on the target host, remove its containers first (named volumes are kept and restored into), then restore the source's data over them. Needed when re-migrating onto a host that already runs this stack — otherwise a running same-named target is a pre-flight conflict that blocks Start. Leave off for a fresh target.
            </p>
          </div>

          <div className="rounded-md border border-border/60 p-3 space-y-3">
            {plan?.ingressSuggestions && plan.ingressSuggestions.length > 0 && !ingressEnabled && (
              <div className="flex items-start gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs text-sky-200">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>Heads up — we found {plan.ingressSuggestions.length} existing route{plan.ingressSuggestions.length === 1 ? '' : 's'} for this stack: <strong>{plan.ingressSuggestions.map((s) => s.label).join('; ')}</strong>. Check the box below to move {plan.ingressSuggestions.length === 1 ? 'it' : 'them all'} to the target on cutover; the rows pre-fill.</span>
              </div>
            )}
            <label className="flex items-center gap-2 text-xs font-medium">
              <input
                type="checkbox"
                checked={ingressEnabled}
                onChange={(e) => {
                  const on = e.target.checked;
                  setIngressEnabled(on);
                  // Auto-populate ALL detected routes when turning it on and the list is empty.
                  const sugs = plan?.ingressSuggestions ?? [];
                  if (on && sugs.length && routes.length === 0) {
                    setRoutes(sugs.map((s) => ({
                      instanceId: s.instanceId,
                      hostname: s.hostname,
                      port: String(s.port),
                      tunnelId: s.tunnelId ?? '',
                      certId: typeof s.certificateId === 'number' ? String(s.certificateId) : '0',
                      path: s.path ?? '',
                      order: s.order,
                    })));
                  }
                  setPlan(null);
                }}
                disabled={ingressTargets.length === 0}
              />
              Automatically flip ingress on cutover
              {ingressTargets.length === 0 && <span className="text-muted-foreground font-normal">(no Cloudflare / NPM connector configured)</span>}
            </label>
            <p className="text-[0.7rem] text-muted-foreground">
              <strong className="text-foreground/80">Checked:</strong> at cutover Cerebro repoints every public hostname below (Cloudflare tunnel route or NPM proxy host) from the source host to the target automatically — no manual DNS/proxy edit — and Rollback points them all back.
              {' '}<strong className="text-foreground/80">Unchecked:</strong> the stack is moved but ingress is left alone — after you Complete, you must repoint DNS / your reverse proxy to the target yourself, or traffic keeps hitting the old host.
            </p>
            {ingressEnabled && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => void fetchIngress()} disabled={!source || ingressFetching}>
                    {ingressFetching ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Search className="h-3.5 w-3.5 mr-1" />}
                    Fetch existing route(s)
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={addRoute}>
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add route
                  </Button>
                  {!source && <span className="text-[0.7rem] text-muted-foreground">Choose a source stack first.</span>}
                  {ingressFetchMsg && (
                    <span className={`text-[0.7rem] inline-flex items-center gap-1 ${ingressFetchMsg.ok ? 'text-emerald-400' : 'text-amber-300'}`}>
                      {ingressFetchMsg.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <TriangleAlert className="h-3.5 w-3.5" />}
                      {ingressFetchMsg.text}
                    </span>
                  )}
                </div>

                {routes.length === 0 && (
                  <p className="text-[0.7rem] text-muted-foreground">No routes yet — Fetch to auto-detect what's mapped to this stack, or Add route to enter one by hand.</p>
                )}

                {routes.map((r, i) => {
                  const kind = kindOf(r.instanceId);
                  return (
                    <div key={i} className="rounded-md border border-border/50 bg-background/40 p-3 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[0.7rem] font-medium text-muted-foreground inline-flex items-center gap-2">
                          {typeof r.order === 'number' && (
                            <span className="rounded bg-primary/15 text-primary px-1.5 py-0.5 text-[0.65rem]" title="Priority within the tunnel (first-match-wins). Preserved on cutover.">Priority {r.order + 1}</span>
                          )}
                          Route {i + 1}{kind ? ` · ${kind === 'cloudflare' ? 'Cloudflare' : 'NPM'}` : ''}
                        </span>
                        <Button type="button" variant="ghost" size="sm" onClick={() => removeRoute(i)} title="Remove this route">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <Label className="text-xs">Ingress connector</Label>
                          <select className={selectCls} value={r.instanceId} onChange={(e) => updateRoute(i, { instanceId: e.target.value })}>
                            <option value="">Choose…</option>
                            {ingressTargets.map((t) => <option key={t.instanceId} value={t.instanceId}>{t.name} ({t.kind === 'cloudflare' ? 'Cloudflare' : 'NPM'})</option>)}
                          </select>
                        </div>
                        <div>
                          <Label className="text-xs">Public hostname</Label>
                          <Input value={r.hostname} onChange={(e) => updateRoute(i, { hostname: e.target.value })} placeholder="app.example.com" />
                        </div>
                        <div>
                          <Label className="text-xs">Route to target port</Label>
                          <Input type="number" value={r.port} onChange={(e) => updateRoute(i, { port: e.target.value })} placeholder="8080" />
                        </div>
                        {kind === 'cloudflare' && (
                          <div>
                            <Label className="text-xs">Cloudflare tunnel</Label>
                            <select className={selectCls} value={r.tunnelId} onChange={(e) => updateRoute(i, { tunnelId: e.target.value })}>
                              <option value="">Choose a tunnel…</option>
                              {(tunnelsByInstance[r.instanceId] ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                          </div>
                        )}
                        {kind === 'cloudflare' && (
                          <div>
                            <Label className="text-xs">Path (optional)</Label>
                            <Input value={r.path} onChange={(e) => updateRoute(i, { path: e.target.value })} placeholder="e.g. /api — blank = whole host" />
                          </div>
                        )}
                        {kind === 'npm' && (
                          <div>
                            <Label className="text-xs">TLS certificate (optional)</Label>
                            <select className={selectCls} value={r.certId} onChange={(e) => updateRoute(i, { certId: e.target.value })}>
                              {(certsByInstance[r.instanceId] ?? []).length === 0 && <option value="0">None (HTTP)</option>}
                              {(certsByInstance[r.instanceId] ?? []).map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
                            </select>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                <p className="text-[0.7rem] text-muted-foreground">On “Cut over” every route above is repointed to the target before the source is stopped; Rollback points them all back. Each is edited <strong className="text-foreground/80">in place</strong>, so a Cloudflare tunnel's rule order (priority, and its trailing catch-all) is preserved — path-based rules stay distinct.</p>
              </div>
            )}
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
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm">Migrations</CardTitle>
            <div className="flex items-center gap-3">
              {canMigrate && runs.some((r) => !r.archived && r.status !== 'running' && r.step !== 'awaiting-cutover') && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => void dismissAllFinished()}
                  title="Hide every finished run from the list at once (running and awaiting-cutover runs are left alone)."
                >
                  Dismiss all finished
                </button>
              )}
              {runs.some((r) => r.archived) && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setShowDismissed((s) => !s)}
                >
                  {showDismissed ? 'Hide' : 'Show'} dismissed ({runs.filter((r) => r.archived).length})
                </button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {(() => {
            const visible = runs.filter((r) => showDismissed || !r.archived);
            if (visible.length === 0) {
              return <div className="text-xs text-muted-foreground">{runs.length ? 'No active migrations — all are dismissed.' : 'No migrations yet.'}</div>;
            }
            return visible.map((r) => {
              const retriable = r.step === 'failed' || r.step === 'cancelled' || r.step === 'rolled_back';
              const terminal = r.status !== 'running' && r.step !== 'awaiting-cutover';
              return (
            <div key={r.id} className={`rounded-md border border-border/60 px-3 py-2 ${r.archived ? 'opacity-60' : ''}`}>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="inline-flex items-center gap-2 min-w-0">
                  {r.status === 'running' ? <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
                    : r.step === 'done' ? <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    : r.step === 'rolled_back' || r.step === 'cancelled' ? <Undo2 className="h-4 w-4 text-muted-foreground" />
                    : r.status === 'error' ? <TriangleAlert className="h-4 w-4 text-destructive" />
                    : <HardDriveDownload className="h-4 w-4 text-muted-foreground" />}
                  <span className="truncate">{r.sourceHostName} · {r.stackName} → {r.destHostName} · {r.destStackName}</span>
                  {r.archived && <span className="shrink-0 rounded bg-muted text-muted-foreground px-1.5 py-0.5 text-[0.6rem] uppercase tracking-wider">Dismissed</span>}
                </span>
                <span className={`text-xs shrink-0 ${STATUS_COLOR[r.status] ?? ''}`}>{STEP_LABEL[r.step] ?? r.step}</span>
              </div>
              {r.message && <div className="text-xs text-muted-foreground mt-1">{r.message}</div>}
              {r.ingressRoutes && r.ingressRoutes.length > 0 && (
                <div className="text-[0.7rem] text-muted-foreground mt-1">
                  Ingress: {r.ingressRoutes.map((ing) => `${ing.hostname} → ${ing.port}`).join(', ')}{r.ingressFlipped ? ' · flipped to target' : ''}
                </div>
              )}
              {r.replicatorDeploymentId && (
                <div className="text-[0.7rem] text-muted-foreground mt-1">
                  App Replicator deployment{r.replicatorRepointed ? ' · re-pointed to target' : ' · re-points on cutover'}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <Button variant="ghost" size="sm" onClick={() => openLog(r.id)}><ScrollText className="h-3.5 w-3.5 mr-1" /> Log</Button>
                {canMigrate && r.status === 'running' && (
                  <Button variant="ghost" size="sm" onClick={() => { if (confirm('Cancel this migration? It stops the work, restarts the source if it was stopped, and removes any partial target. A capture/restore already in flight may still finish on its own.')) void act(r.id, 'cancel'); }} title="Stop the migration and clean up — restart the source and remove the partial target.">
                    <X className="h-3.5 w-3.5 mr-1" /> Cancel
                  </Button>
                )}
                {canMigrate && r.status === 'running' && (
                  <Button variant="ghost" size="sm" onClick={() => { if (confirm('Force-fail this migration? Use this only if Cancel is stuck — it just marks the run failed so you can roll it back.')) void act(r.id, 'force-fail'); }} title="Escape hatch if Cancel hangs: mark the run failed so you can roll it back.">
                    <TriangleAlert className="h-3.5 w-3.5 mr-1" /> Force-fail
                  </Button>
                )}
                {canMigrate && r.step === 'awaiting-cutover' && (
                  <Button size="sm" onClick={() => act(r.id, 'complete')}>
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> {r.ingressRoutes && r.ingressRoutes.length > 0 ? 'Cut over (flip ingress + tear down source)' : 'Complete (tear down source)'}
                  </Button>
                )}
                {canMigrate && (r.step === 'awaiting-cutover' || r.step === 'failed') && (
                  <Button variant="ghost" size="sm" onClick={() => { if (confirm('Roll back? The source restarts and the target is removed. Any writes the target took after cutover are discarded.')) void act(r.id, 'rollback'); }} title="Restarts the source and removes the target. Discards changes the target took after cutover.">
                    <RotateCcw className="h-3.5 w-3.5 mr-1" /> Rollback
                  </Button>
                )}
                {canMigrate && retriable && (
                  <Button variant="ghost" size="sm" onClick={() => retry(r)} title="Pre-fill the plan form from this run so you can re-run it (adjust options first).">
                    <RefreshCw className="h-3.5 w-3.5 mr-1" /> Retry
                  </Button>
                )}
                {canMigrate && terminal && !r.archived && (
                  <Button variant="ghost" size="sm" onClick={() => {
                    const warn = r.step === 'failed'
                      ? 'Dismiss this failed run? It may have left a partial stack on the target — consider Rollback first to clean it up. Dismissing only hides it from the list.'
                      : null;
                    if (!warn || confirm(warn)) void act(r.id, 'dismiss');
                  }} title="Hide this finished run from the list (kept in history; show it again with “Show dismissed”).">
                    <X className="h-3.5 w-3.5 mr-1" /> Dismiss
                  </Button>
                )}
                {canMigrate && r.archived && (
                  <Button variant="ghost" size="sm" onClick={() => act(r.id, 'restore')} title="Bring this run back into the active list.">
                    <Undo2 className="h-3.5 w-3.5 mr-1" /> Restore
                  </Button>
                )}
              </div>
            </div>
              );
            });
          })()}
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
