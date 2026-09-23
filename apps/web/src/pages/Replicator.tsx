import { useEffect, useMemo, useState } from 'react';
import { Boxes, Plus, Trash2, Rocket, GitBranch, RotateCw, Loader2, KeyRound, Wand2, Globe, ExternalLink, X, ArrowUpCircle, RefreshCw, FileCog, Pencil, FileText, Lock } from 'lucide-react';
import type {
  ReplicatorApp, ReplicatorDeployment, ReplicatorTarget, ReplicatorVariable, ReplicatorPort,
  IntrospectResult, DeployTargetInfo, SecretSummary, RefreshSchemaResult,
  IngressTarget, CfTunnelOption, NpmCertOption, ReplicatorIngress, TargetKind,
  DeploymentEnvView, DeploymentEnvDrift, DeploymentEnvOrigin,
} from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';

const selectCls = 'mt-1 w-full h-9 rounded-md border border-input bg-background/60 px-2 text-sm';

const STATUS_COLOR: Record<string, string> = {
  deployed: 'text-emerald-400', pending: 'text-amber-400', updating: 'text-amber-400',
  error: 'text-destructive', stopped: 'text-muted-foreground',
};

/**
 * Approximate monthly USD for a Fargate task (us-east-1 rates; excludes the shared
 * ALB, data transfer, and ECR/logs storage) — a deploy-wizard sanity figure. Kept
 * local to the web because @cerebro/shared is consumed here as types only (its
 * CommonJS barrel doesn't expose a runtime value through `export *`); the server
 * uses the shared `estimateEcsMonthlyUsd`, and the two must stay in sync.
 */
function estimateEcsMonthlyUsd(cpu: string, memoryMiB: string, opts?: { assignPublicIp?: boolean }) {
  const HOURS = 730;
  const VCPU_HR = 0.04048;
  const GB_HR = 0.004445;
  const PUBLIC_IP_HR = 0.005;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const vcpu = (Number(cpu) || 256) / 1024;
  const gb = (Number(memoryMiB) || 512) / 1024;
  const taskUsd = round2((vcpu * VCPU_HR + gb * GB_HR) * HOURS);
  const publicIpUsd = opts?.assignPublicIp === false ? 0 : round2(PUBLIC_IP_HR * HOURS);
  return {
    taskUsd,
    publicIpUsd,
    total: round2(taskUsd + publicIpUsd),
    note: 'Approx us-east-1 Fargate rates; excludes the shared ALB (~$16+/mo per connector), data transfer, and ECR/logs storage.',
  };
}

/** A URL-safe random secret for the "generate" affordance. */
function randomSecret(bytes = 24): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function Replicator() {
  const { can } = useAuth();
  const canWrite = can('replicator:write');

  const [apps, setApps] = useState<ReplicatorApp[] | null>(null);
  const [deployments, setDeployments] = useState<ReplicatorDeployment[]>([]);
  const [targets, setTargets] = useState<ReplicatorTarget[]>([]);
  const [ingressTargets, setIngressTargets] = useState<IngressTarget[]>([]);
  const [gitSecrets, setGitSecrets] = useState<SecretSummary[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const [registering, setRegistering] = useState(false);
  const [deployFor, setDeployFor] = useState<ReplicatorApp | null>(null);
  const [refreshFor, setRefreshFor] = useState<ReplicatorApp | null>(null);
  const [editFor, setEditFor] = useState<{ app: ReplicatorApp; d: ReplicatorDeployment } | null>(null);
  const [ingressFor, setIngressFor] = useState<ReplicatorDeployment | null>(null);
  const [envFor, setEnvFor] = useState<ReplicatorDeployment | null>(null);
  const [checking, setChecking] = useState(false);

  async function checkUpdates() {
    setChecking(true); setErr(null);
    try { await api.post('/api/replicator/updates/check'); await refresh(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Update check failed.'); }
    finally { setChecking(false); }
  }

  async function refresh() {
    try {
      const [a, d, t, it] = await Promise.all([
        api.get<ReplicatorApp[]>('/api/replicator/apps'),
        api.get<ReplicatorDeployment[]>('/api/replicator/deployments'),
        api.get<ReplicatorTarget[]>('/api/replicator/targets'),
        api.get<IngressTarget[]>('/api/replicator/ingress/targets'),
      ]);
      setApps(a); setDeployments(d); setTargets(t); setIngressTargets(it);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load.');
      setApps([]);
    }
  }

  useEffect(() => {
    void refresh();
    api.get<SecretSummary[]>('/api/secrets').then((s) => setGitSecrets(s.filter((x) => x.kind === 'git'))).catch(() => {});
  }, []);

  const deploymentsByApp = useMemo(() => {
    const m = new Map<string, ReplicatorDeployment[]>();
    for (const d of deployments) { const arr = m.get(d.appId) ?? []; arr.push(d); m.set(d.appId, arr); }
    return m;
  }, [deployments]);

  // While any deploy/redeploy is running in the background, poll so the row's
  // phase + final status update on their own.
  const inFlight = deployments.some((d) => d.status === 'pending' || d.status === 'updating');
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => { void refresh(); }, 2500);
    return () => clearInterval(t);
  }, [inFlight]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="App Replicator"
        description="Register a Git-repo app once, then replicate it as isolated instances onto a Docker host."
        actions={
          <>
            {(apps?.length ?? 0) > 0 && (
              <Button variant="outline" onClick={checkUpdates} disabled={checking}>
                {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Check for updates
              </Button>
            )}
            {canWrite && <Button onClick={() => setRegistering(true)}><Plus className="h-4 w-4" /> Register app</Button>}
          </>
        }
      />

      {err && <p className="text-sm text-destructive">{err}</p>}

      {apps === null ? (
        <p className="text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
      ) : apps.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-muted-foreground">
          No apps yet. {canWrite && 'Register one from a Git repo to get started.'}
        </CardContent></Card>
      ) : (
        <div className="space-y-4">
          {apps.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              deployments={deploymentsByApp.get(app.id) ?? []}
              canWrite={canWrite}
              hasIngress={ingressTargets.length > 0}
              onDeploy={() => setDeployFor(app)}
              onRefreshSchema={() => setRefreshFor(app)}
              onEdit={(d) => setEditFor({ app, d })}
              onIngress={setIngressFor}
              onEnv={setEnvFor}
              onChanged={refresh}
              setErr={setErr}
            />
          ))}
        </div>
      )}

      {registering && (
        <RegisterDialog
          gitSecrets={gitSecrets}
          onClose={() => setRegistering(false)}
          onRegistered={() => { setRegistering(false); void refresh(); }}
          setErr={setErr}
        />
      )}
      {deployFor && (
        <DeployDialog
          app={deployFor}
          targets={targets}
          onClose={() => setDeployFor(null)}
          onDeployed={() => { setDeployFor(null); void refresh(); }}
          setErr={setErr}
        />
      )}
      {refreshFor && (
        <RefreshSchemaDialog
          app={refreshFor}
          onClose={() => setRefreshFor(null)}
          onApplied={() => { setRefreshFor(null); void refresh(); }}
          setErr={setErr}
        />
      )}
      {editFor && (
        <EditRedeployDialog
          app={editFor.app}
          deployment={editFor.d}
          onClose={() => setEditFor(null)}
          onDone={() => { setEditFor(null); void refresh(); }}
          setErr={setErr}
        />
      )}
      {envFor && (
        <EnvDialog deployment={envFor} onClose={() => setEnvFor(null)} setErr={setErr} />
      )}
      {ingressFor && (
        <IngressDialog
          deployment={ingressFor}
          targets={ingressTargets}
          onClose={() => setIngressFor(null)}
          onChanged={() => { void refresh(); }}
          setErr={setErr}
        />
      )}
    </div>
  );
}

// ── App card + its deployments ──────────────────────────────────────

function AppCard({ app, deployments, canWrite, hasIngress, onDeploy, onRefreshSchema, onEdit, onIngress, onEnv, onChanged, setErr }: {
  app: ReplicatorApp; deployments: ReplicatorDeployment[]; canWrite: boolean; hasIngress: boolean;
  onDeploy: () => void; onRefreshSchema: () => void; onEdit: (d: ReplicatorDeployment) => void;
  onIngress: (d: ReplicatorDeployment) => void; onEnv: (d: ReplicatorDeployment) => void;
  onChanged: () => void; setErr: (s: string | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const ports = app.variables.filter((v) => v.role === 'host_port').length;
  const secrets = app.variables.filter((v) => v.secret).length;
  const isInFlight = (d: ReplicatorDeployment) => d.status === 'pending' || d.status === 'updating';
  /** How many operator-added env entries an instance carries (shown on its row). */
  const extraCount = (d: ReplicatorDeployment) => Object.keys(d.extraEnv ?? {}).length + (d.extraSecretVars?.length ?? 0);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id); setErr(null);
    try { await fn(); onChanged(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Action failed.'); }
    finally { setBusy(null); }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2"><Boxes className="h-5 w-5" /> {app.name}</CardTitle>
          <CardDescription className="flex items-center gap-2 mt-1">
            <GitBranch className="h-3.5 w-3.5" /> {app.gitUrl}<span className="opacity-60">@{app.gitRef}</span>
          </CardDescription>
          <p className="text-xs text-muted-foreground mt-1">
            {app.variables.length} variables · {ports} port{ports === 1 ? '' : 's'} · {secrets} secret{secrets === 1 ? '' : 's'}
            {app.usesGeneratedCompose && <span className="text-amber-400"> · generated compose (deploy not yet supported)</span>}
          </p>
        </div>
        {canWrite && (
          <div className="flex items-center gap-2 shrink-0">
            <Button onClick={onDeploy} disabled={app.usesGeneratedCompose}><Rocket className="h-4 w-4" /> Deploy</Button>
            <Button variant="ghost" size="icon" aria-label="Refresh schema"
              title="Re-read the repo compose to pick up new variables"
              onClick={onRefreshSchema}>
              <FileCog className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Remove app"
              disabled={busy === 'rm' || deployments.length > 0}
              title={deployments.length > 0 ? 'Remove its deployments first' : 'Remove app'}
              onClick={() => act('rm', () => api.delete(`/api/replicator/apps/${app.id}`))}>
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        )}
      </CardHeader>
      {deployments.length > 0 && (
        <CardContent className="pt-0">
          <div className="rounded-lg border border-border/60 divide-y divide-border/60">
            {deployments.map((d) => (
              <div key={d.id} className="px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium truncate flex items-center gap-2">
                      {d.project}
                      {d.targetKind === 'ecs' && (
                        <span className="rounded-full bg-sky-400/15 text-sky-400 px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide">ECS</span>
                      )}
                      {isInFlight(d) ? (
                        <span className="text-xs text-amber-400 inline-flex items-center gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" /> {d.phase ?? d.status}
                        </span>
                      ) : (
                        <span className={`text-xs ${STATUS_COLOR[d.status] ?? ''}`}>· {d.status}</span>
                      )}
                      {d.updateAvailable && !isInFlight(d) && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/15 text-amber-400 px-2 py-0.5 text-[0.65rem] font-semibold"
                          title={`Repo moved to ${d.availableCommit?.slice(0, 7) ?? '?'} — redeploy to update`}>
                          <ArrowUpCircle className="h-3 w-3" /> update available
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {d.dockerInstanceName ?? d.dockerInstanceId}
                      {d.targetKind === 'ecs'
                        ? (d.ecs?.cluster ? ` · cluster ${d.ecs.cluster}` : '')
                        : d.ports.map((p) => ` · ${p.hostPort}→${p.containerPort}`).join('')}
                      {d.deployedCommit && ` · ${d.deployedCommit.slice(0, 7)}`}
                      {extraCount(d) > 0 && ` · ${extraCount(d)} extra env`}
                    </p>
                    {d.lastMessage && d.status === 'error' && <p className="text-xs text-destructive truncate">{d.lastMessage}</p>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {/* Read-only, so it stays available without replicator:write. */}
                    <Button variant="ghost" size="icon" aria-label="View environment"
                      title="See every variable this instance receives, and where each came from"
                      onClick={() => onEnv(d)}><FileText className="h-4 w-4" /></Button>
                    {canWrite && (
                      <>
                      {hasIngress && (
                        <Button variant="ghost" size="icon" aria-label="Manage ingress" title="Expose via Cloudflare / NPM"
                          disabled={isInFlight(d)} onClick={() => onIngress(d)}><Globe className="h-4 w-4" /></Button>
                      )}
                      <Button variant="ghost" size="icon" aria-label="Edit & redeploy" disabled={busy === d.id || isInFlight(d)}
                        title="Edit values / secrets / ports / extra env, then redeploy"
                        onClick={() => onEdit(d)}><Pencil className="h-4 w-4" /></Button>
                      <Button variant={d.updateAvailable ? 'default' : 'ghost'} size="icon" aria-label="Redeploy" disabled={busy === d.id || isInFlight(d)}
                        title={d.updateAvailable ? 'Update available — pull latest & redeploy' : 'Pull latest & redeploy'}
                        onClick={() => act(d.id, () => api.post(`/api/replicator/deployments/${d.id}/redeploy`, { forceRebuild: true }))}>
                        {busy === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
                      </Button>
                      <Button variant="ghost" size="icon" aria-label="Delete deployment" disabled={busy === d.id || isInFlight(d)}
                        title="Stop, remove & clean up secrets"
                        onClick={() => { if (confirm(`Remove deployment "${d.project}"? This stops the stack, removes any ingress, and deletes its secrets.`)) act(d.id, () => api.delete(`/api/replicator/deployments/${d.id}`)); }}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                      </>
                    )}
                  </div>
                </div>
                {d.ingress && d.ingress.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {d.ingress.map((ing) => (
                      <a key={ing.id} href={ing.url} target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-xs hover:bg-muted"
                        title={`${ing.kind === 'cloudflare' ? 'Cloudflare tunnel' : 'NPM proxy'} → :${ing.hostPort}`}>
                        <Globe className="h-3 w-3" /> {ing.hostname}<ExternalLink className="h-3 w-3 opacity-60" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ── Register dialog (introspect → review → register) ────────────────

function RegisterDialog({ gitSecrets, onClose, onRegistered, setErr }: {
  gitSecrets: SecretSummary[]; onClose: () => void; onRegistered: () => void; setErr: (s: string | null) => void;
}) {
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [gitRef, setGitRef] = useState('main');
  const [gitPath, setGitPath] = useState('');
  const [gitCredKey, setGitCredKey] = useState('');
  const [result, setResult] = useState<IntrospectResult | null>(null);
  const [vars, setVars] = useState<ReplicatorVariable[]>([]);
  const [busy, setBusy] = useState(false);

  async function introspect() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<IntrospectResult>('/api/replicator/introspect', { gitUrl, gitRef, gitPath: gitPath || undefined, gitCredKey: gitCredKey || undefined });
      setResult(r); setVars(r.variables);
      if (!name && gitUrl) setName(gitUrl.replace(/\.git$/, '').split('/').pop() || '');
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Introspection failed.'); }
    finally { setBusy(false); }
  }

  async function register() {
    setBusy(true); setErr(null);
    try {
      await api.post('/api/replicator/apps', {
        name, gitUrl, gitRef, gitPath: gitPath || undefined, gitCredKey: gitCredKey || undefined,
        variables: vars, usesGeneratedCompose: result?.usesGeneratedCompose,
      });
      onRegistered();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Register failed.'); setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose} size="lg" title="Register app"
      description="Point Cerebro at a Git repo; it reads the compose file (and any committed env file) to detect variables and ports."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {result
            ? <Button onClick={register} disabled={busy || !name.trim()}>{busy ? 'Registering…' : 'Register app'}</Button>
            : <Button onClick={introspect} disabled={busy || !gitUrl.trim()}>{busy ? 'Reading repo…' : 'Introspect repo'}</Button>}
        </>
      }>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div><Label>Git URL</Label><Input value={gitUrl} placeholder="https://github.com/you/app.git" onChange={(e) => setGitUrl(e.target.value)} /></div>
          <div><Label>Ref (branch/tag)</Label><Input value={gitRef} placeholder="main" onChange={(e) => setGitRef(e.target.value)} /></div>
          <div><Label>Compose path <span className="text-muted-foreground font-normal">(optional)</span></Label><Input value={gitPath} placeholder="docker-compose.yml" onChange={(e) => setGitPath(e.target.value)} /></div>
          <div>
            <Label>Git credential <span className="text-muted-foreground font-normal">(private repos)</span></Label>
            <select className={selectCls} value={gitCredKey} onChange={(e) => setGitCredKey(e.target.value)}>
              <option value="">Public (none)</option>
              {gitSecrets.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
        </div>

        {result && (
          <div className="space-y-3">
            <div><Label>App name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
            {result.warnings.map((w, i) => <p key={i} className="text-xs text-amber-400">⚠ {w}</p>)}
            <p className="text-xs text-muted-foreground">
              Detected from <code>{result.composePath}</code>
              {result.envFiles?.length ? <> and <code>{result.envFiles.join(', ')}</code></> : null}
              {' '}· services: {result.services.join(', ') || '—'}.
              Image tag &amp; container name are set per deployment automatically.
            </p>
            <VariableSchemaEditor vars={vars} onChange={setVars} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ── Refresh-schema dialog (re-introspect → review diff → apply) ─────

function RefreshSchemaDialog({ app, onClose, onApplied, setErr }: {
  app: ReplicatorApp; onClose: () => void; onApplied: () => void; setErr: (s: string | null) => void;
}) {
  const [result, setResult] = useState<RefreshSchemaResult | null>(null);
  const [vars, setVars] = useState<ReplicatorVariable[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      setErr(null);
      try {
        const r = await api.post<RefreshSchemaResult>(`/api/replicator/apps/${app.id}/refresh-schema`, {});
        if (!alive) return;
        setResult(r); setVars(r.variables);
      } catch (e) {
        if (alive) setErr(e instanceof ApiError ? e.message : 'Could not re-read the repo.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [app.id, setErr]);

  async function apply() {
    setBusy(true); setErr(null);
    try {
      await api.patch(`/api/replicator/apps/${app.id}`, {
        variables: vars, usesGeneratedCompose: result?.usesGeneratedCompose,
      });
      onApplied();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not save the schema.'); setBusy(false); }
  }

  const diff = result?.diff;
  const noChanges = diff && !diff.added.length && !diff.removed.length && !diff.roleChanged.length;

  return (
    <Dialog open onClose={onClose} size="lg" title={`Refresh schema · ${app.name}`}
      description="Re-read the repo's compose file and pick up variable changes. Existing deployments are untouched until you redeploy them."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={apply} disabled={busy || loading || !result}>
            {busy ? 'Saving…' : 'Apply to app'}
          </Button>
        </>
      }>
      {loading ? (
        <p className="text-muted-foreground flex items-center gap-2 py-6"><Loader2 className="h-4 w-4 animate-spin" /> Reading repo…</p>
      ) : result ? (
        <div className="space-y-4">
          {result.warnings.map((w, i) => <p key={i} className="text-xs text-amber-400">⚠ {w}</p>)}
          <p className="text-xs text-muted-foreground">
            Detected from <code>{result.composePath}</code>
            {result.envFiles?.length ? <> and <code>{result.envFiles.join(', ')}</code></> : null}. Variables you added
            by hand are kept.
          </p>

          {noChanges ? (
            <p className="text-sm text-emerald-400">No schema changes — the stored variables already match the repo.</p>
          ) : (
            <div className="space-y-1.5 text-sm">
              {diff!.added.length > 0 && (
                <p><span className="text-emerald-400 font-medium">Added:</span> <span className="font-mono text-xs">{diff!.added.join(', ')}</span></p>
              )}
              {diff!.removed.length > 0 && (
                <p><span className="text-destructive font-medium">Removed:</span> <span className="font-mono text-xs">{diff!.removed.join(', ')}</span></p>
              )}
              {diff!.roleChanged.map((c) => (
                <p key={c.name}><span className="text-amber-400 font-medium">Reclassified:</span>{' '}
                  <span className="font-mono text-xs">{c.name}</span> <span className="text-muted-foreground">{c.from} → {c.to}</span>
                </p>
              ))}
            </div>
          )}

          <VariableSchemaEditor vars={vars} onChange={setVars} added={diff!.added} />
        </div>
      ) : (
        <p className="text-sm text-destructive py-6">Could not read the repository.</p>
      )}
    </Dialog>
  );
}

// ── Deploy dialog (target → plan → variable form) ───────────────────

const ECS_CPU = [
  { value: '256', label: '0.25 vCPU' }, { value: '512', label: '0.5 vCPU' },
  { value: '1024', label: '1 vCPU' }, { value: '2048', label: '2 vCPU' }, { value: '4096', label: '4 vCPU' },
];
const ECS_MEM = [
  { value: '512', label: '0.5 GB' }, { value: '1024', label: '1 GB' }, { value: '2048', label: '2 GB' },
  { value: '4096', label: '4 GB' }, { value: '8192', label: '8 GB' },
];

function DeployDialog({ app, targets, onClose, onDeployed, setErr }: {
  app: ReplicatorApp; targets: ReplicatorTarget[]; onClose: () => void; onDeployed: () => void; setErr: (s: string | null) => void;
}) {
  const deployable = targets.filter((t) => t.deployable);
  const [instanceId, setInstanceId] = useState(deployable[0]?.instanceId ?? '');
  const selected = deployable.find((t) => t.instanceId === instanceId);
  const targetKind: TargetKind = selected?.targetKind ?? 'docker';
  const isEcs = targetKind === 'ecs';

  const [name, setName] = useState('');
  const [plan, setPlan] = useState<DeployTargetInfo | null>(null);
  const [configured, setConfigured] = useState(false); // ECS: skips the port-preflight step
  const [values, setValues] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [extras, setExtras] = useState<ExtraRow[]>([]);
  const schemaNames = useMemo(() => new Set(app.variables.map((v) => v.name)), [app.variables]);
  const [ports, setPorts] = useState<Record<string, number>>({});
  const [taskCpu, setTaskCpu] = useState('256');
  const [taskMemory, setTaskMemory] = useState('512');
  const [forceRebuild, setForceRebuild] = useState(true);
  const [busy, setBusy] = useState(false);

  // ECS has no host ports/bind addresses — those roles are irrelevant on Fargate.
  const formVars = app.variables.filter((v) =>
    v.role !== 'image_tag' && v.role !== 'container_name' && (!isEcs || (v.role !== 'host_port' && v.role !== 'host_ip')));

  const ready = isEcs ? configured : !!plan;
  const cost = isEcs ? estimateEcsMonthlyUsd(taskCpu, taskMemory) : null;

  function seedValueDefaults() {
    const v: Record<string, string> = {};
    for (const fv of formVars) if ((fv.role === 'plain' || fv.role === 'host_ip') && fv.default != null) v[fv.name] = fv.default;
    setValues(v);
  }

  async function next() {
    if (isEcs) { seedValueDefaults(); setConfigured(true); return; }
    if (!instanceId) return;
    setBusy(true); setErr(null);
    try {
      const p = await api.post<DeployTargetInfo>(`/api/replicator/apps/${app.id}/plan`, { dockerInstanceId: instanceId });
      setPlan(p);
      seedValueDefaults();
      const pr: Record<string, number> = {};
      for (const s of p.suggestions) pr[s.variable] = s.suggested;
      setPorts(pr);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not plan the deploy.'); }
    finally { setBusy(false); }
  }

  async function deploy() {
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/replicator/apps/${app.id}/deploy`, {
        dockerInstanceId: instanceId, targetKind, name, values, secrets,
        ports: isEcs ? {} : ports, forceRebuild, extraEnv: extraEntriesOf(extras),
        ...(isEcs ? { taskCpu, taskMemory } : {}),
      });
      onDeployed();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Deploy failed.'); setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose} size="lg" title={`Deploy ${app.name}`}
      description={isEcs ? 'Build the image, push to ECR, and run it on AWS Fargate.' : 'Materialize a new isolated instance onto a Docker host.'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {ready
            ? <Button onClick={deploy} disabled={busy || !name.trim()}>{busy ? 'Starting…' : <><Rocket className="h-4 w-4" /> Deploy</>}</Button>
            : <Button onClick={next} disabled={busy || !instanceId}>{busy ? 'Checking host…' : isEcs ? 'Next: configure' : 'Next: check ports'}</Button>}
        </>
      }>
      <div className="space-y-4">
        {deployable.length === 0 && (
          <p className="text-sm text-amber-400">No deployable target — add a Docker connector with SSH, or an AWS connector with an ECS deployment profile.</p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Target</Label>
            <select className={selectCls} value={instanceId} disabled={ready} onChange={(e) => setInstanceId(e.target.value)}>
              {deployable.map((t) => (
                <option key={t.instanceId} value={t.instanceId}>
                  {t.name} — {t.targetKind === 'ecs' ? `AWS ECS (${t.hostIp})` : `Docker (${t.hostIp})`}
                </option>
              ))}
            </select>
          </div>
          <div><Label>Deployment name</Label><Input value={name} placeholder="acme-poc" onChange={(e) => setName(e.target.value)} /></div>
        </div>

        {ready && (
          <div className="space-y-3">
            {isEcs ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Task CPU</Label>
                    <select className={selectCls} value={taskCpu} onChange={(e) => setTaskCpu(e.target.value)}>
                      {ECS_CPU.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <Label>Task memory</Label>
                    <select className={selectCls} value={taskMemory} onChange={(e) => setTaskMemory(e.target.value)}>
                      {ECS_MEM.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select>
                  </div>
                </div>
                {cost && (
                  <p className="text-xs text-muted-foreground">
                    Est. <span className="text-foreground font-medium">${cost.total.toFixed(2)}/mo</span> (task ${cost.taskUsd.toFixed(2)} + public IP ${cost.publicIpUsd.toFixed(2)}). {cost.note}
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Host {plan!.hostIp} · {plan!.usedPorts.length} ports already in use. Reachable at {plan!.hostIp}:&lt;host port&gt;.
              </p>
            )}
            <div className="space-y-2">
              {formVars.map((v) => (
                <VarField key={v.name} v={v}
                  value={v.role === 'host_port' ? String(ports[v.name] ?? '') : v.role === 'secret' ? (secrets[v.name] ?? '') : (values[v.name] ?? '')}
                  usedPorts={plan?.usedPorts ?? []}
                  onChange={(val) => {
                    if (v.role === 'host_port') setPorts((p) => ({ ...p, [v.name]: Number(val) }));
                    else if (v.role === 'secret') setSecrets((s) => ({ ...s, [v.name]: val }));
                    else setValues((s) => ({ ...s, [v.name]: val }));
                  }} />
              ))}
            </div>
            <ExtraEnvEditor rows={extras} onChange={setExtras} schemaNames={schemaNames} />
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={forceRebuild} onChange={(e) => setForceRebuild(e.target.checked)} />
              Force rebuild image{isEcs ? '' : 's'} (repos that build their own image)
            </label>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ── Edit & redeploy dialog (change config, then rebuild) ────────────

function EditRedeployDialog({ app, deployment, onClose, onDone, setErr }: {
  app: ReplicatorApp; deployment: ReplicatorDeployment;
  onClose: () => void; onDone: () => void; setErr: (s: string | null) => void;
}) {
  const formVars = app.variables.filter((v) => v.role !== 'image_tag' && v.role !== 'container_name');
  const setVars = useMemo(() => new Set(deployment.secretVars), [deployment.secretVars]);
  const currentPort = useMemo(
    () => new Map(deployment.ports.map((p) => [p.variable, p.hostPort])),
    [deployment.ports],
  );

  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const fv of formVars) {
      if (fv.role === 'plain' || fv.role === 'host_ip') v[fv.name] = deployment.values[fv.name] ?? fv.default ?? '';
    }
    return v;
  });
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [ports, setPorts] = useState<Record<string, number>>(() => {
    const pr: Record<string, number> = {};
    for (const fv of formVars) {
      if (fv.role === 'host_port') pr[fv.name] = currentPort.get(fv.name) ?? Number(fv.default ?? fv.containerPort ?? 0);
    }
    return pr;
  });
  const [extras, setExtras] = useState<ExtraRow[]>(
    () => extraRowsFrom(deployment.extraEnv, deployment.extraSecretVars),
  );
  const schemaNames = useMemo(() => new Set(app.variables.map((v) => v.name)), [app.variables]);
  const [forceRebuild, setForceRebuild] = useState(true);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/replicator/deployments/${deployment.id}/redeploy`, {
        edit: true, values, secrets, ports, forceRebuild, extraEnv: extraEntriesOf(extras),
      });
      onDone();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Redeploy failed.'); setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose} size="lg" title={`Edit & redeploy · ${deployment.project}`}
      description="Change values, rotate secrets, move host ports, or edit this instance's extra environment, then redeploy. The stack restarts with the new config."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? 'Starting…' : <><RotateCw className="h-4 w-4" /> Redeploy</>}</Button>
        </>
      }>
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          On {deployment.dockerInstanceName ?? deployment.dockerInstanceId}. Secrets are hidden — leave a secret blank to keep its current value.
        </p>
        <div className="space-y-2">
          {formVars.map((v) => (
            <VarField key={v.name} v={v}
              value={v.role === 'host_port' ? String(ports[v.name] ?? '') : v.role === 'secret' ? (secrets[v.name] ?? '') : (values[v.name] ?? '')}
              usedPorts={[]}
              placeholder={v.secret && setVars.has(v.name) ? 'leave blank to keep current secret' : undefined}
              hideRequired={v.secret && setVars.has(v.name)}
              onChange={(val) => {
                if (v.role === 'host_port') setPorts((p) => ({ ...p, [v.name]: Number(val) }));
                else if (v.role === 'secret') setSecrets((s) => ({ ...s, [v.name]: val }));
                else setValues((s) => ({ ...s, [v.name]: val }));
              }} />
          ))}
        </div>
        <ExtraEnvEditor rows={extras} onChange={setExtras} schemaNames={schemaNames} allowKeepBlank />
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={forceRebuild} onChange={(e) => setForceRebuild(e.target.checked)} />
          Force rebuild images (repos that build their own image)
        </label>
      </div>
    </Dialog>
  );
}

// ── Ingress dialog (expose a port via Cloudflare / NPM) ─────────────

function IngressDialog({ deployment, targets, onClose, onChanged, setErr }: {
  deployment: ReplicatorDeployment; targets: IngressTarget[];
  onClose: () => void; onChanged: () => void; setErr: (s: string | null) => void;
}) {
  const [list, setList] = useState<ReplicatorIngress[]>(deployment.ingress ?? []);

  async function refetch() {
    const l = await api.get<ReplicatorIngress[]>(`/api/replicator/deployments/${deployment.id}/ingress`).catch(() => list);
    setList(l); onChanged();
  }

  const routesByPort = useMemo(() => {
    const m = new Map<number, ReplicatorIngress[]>();
    for (const ing of list) m.set(ing.hostPort, [...(m.get(ing.hostPort) ?? []), ing]);
    return m;
  }, [list]);

  const exposed = routesByPort.size;
  const isEcs = (deployment.targetKind ?? 'docker') === 'ecs';
  const cfTargets = useMemo(() => targets.filter((t) => t.kind === 'cloudflare'), [targets]);

  if (isEcs) {
    return (
      <Dialog open onClose={onClose} size="lg" title={`Ingress · ${deployment.project}`}
        description="Expose this Fargate service on a hostname — a Cloudflare DNS record proxying to the deployment's load balancer."
        footer={<Button variant="outline" onClick={onClose}>Done</Button>}>
        <EcsIngressBody deployment={deployment} routes={list} targets={cfTargets} onChanged={refetch} setErr={setErr} />
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} size="lg" title={`Ingress · ${deployment.project}`}
      description="Give each published port its own hostname through a Cloudflare tunnel or Nginx Proxy Manager."
      footer={<Button variant="outline" onClick={onClose}>Done</Button>}>
      <div className="space-y-4">
        {deployment.ports.length === 0 ? (
          <p className="text-sm text-amber-400">This deployment publishes no host ports, so there's nothing to expose.</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {deployment.ports.length} published port{deployment.ports.length === 1 ? '' : 's'} · {exposed} with DNS.
            </p>
            {deployment.ports.map((p) => (
              <PortIngressRow
                key={p.hostPort}
                deploymentId={deployment.id}
                port={p}
                routes={routesByPort.get(p.hostPort) ?? []}
                targets={targets}
                onChanged={refetch}
                setErr={setErr}
              />
            ))}
          </>
        )}
      </div>
    </Dialog>
  );
}

/** ECS ingress: hostnames routed to the deployment's ALB via a Cloudflare DNS record. */
function EcsIngressBody({ deployment, routes, targets, onChanged, setErr }: {
  deployment: ReplicatorDeployment; routes: ReplicatorIngress[]; targets: IngressTarget[];
  onChanged: () => Promise<void>; setErr: (s: string | null) => void;
}) {
  const [instanceId, setInstanceId] = useState(targets[0]?.instanceId ?? '');
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const hasLb = !!deployment.ecs?.albDnsName && !!deployment.ecs?.targetGroupArn;

  async function add() {
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/replicator/deployments/${deployment.id}/ingress`, {
        kind: 'cloudflare', instanceId, service: 'app', hostPort: deployment.ecs?.routedContainerPort ?? 0, hostname,
      });
      setHostname(''); await onChanged();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not add ingress.'); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    setBusy(true); setErr(null);
    try { await api.delete(`/api/replicator/ingress/${id}`); await onChanged(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not remove ingress.'); }
    finally { setBusy(false); }
  }

  if (!hasLb) {
    return <p className="text-sm text-amber-400">This deployment has no load balancer — it needs a published port and an ALB security group configured on the AWS connector.</p>;
  }
  if (targets.length === 0) {
    return <p className="text-sm text-amber-400">No Cloudflare connector available to create the DNS record.</p>;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">Routes to the shared ALB <code>{deployment.ecs?.albDnsName}</code> on container port {deployment.ecs?.routedContainerPort ?? '?'}.</p>
      {routes.length > 0 && (
        <div className="divide-y divide-border/60 rounded-md border border-border/50">
          {routes.map((ing) => (
            <div key={ing.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-sm">
              <a href={ing.url} target="_blank" rel="noreferrer" className="font-medium truncate inline-flex items-center gap-1 hover:underline">
                {ing.hostname} <ExternalLink className="h-3 w-3 opacity-60" />
              </a>
              <Button variant="ghost" size="icon" aria-label="Remove route" disabled={busy} onClick={() => remove(ing.id)}>
                <X className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label>Cloudflare connector</Label>
          <select className={selectCls} value={instanceId} onChange={(e) => setInstanceId(e.target.value)}>
            {targets.map((t) => <option key={t.instanceId} value={t.instanceId}>{t.name}</option>)}
          </select>
        </div>
        <div><Label>Hostname</Label><Input value={hostname} placeholder="app.example.com" onChange={(e) => setHostname(e.target.value)} /></div>
      </div>
      <Button size="sm" onClick={add} disabled={busy || !instanceId || !hostname.trim()}>
        {busy ? 'Adding…' : <><Plus className="h-4 w-4" /> Add hostname</>}
      </Button>
    </div>
  );
}

/** One published port: its existing routes plus an inline "add a route" form. */
function PortIngressRow({ deploymentId, port, routes, targets, onChanged, setErr }: {
  deploymentId: string; port: ReplicatorPort; routes: ReplicatorIngress[];
  targets: IngressTarget[]; onChanged: () => Promise<void>; setErr: (s: string | null) => void;
}) {
  const [adding, setAdding] = useState(routes.length === 0);
  const [instanceId, setInstanceId] = useState(targets[0]?.instanceId ?? '');
  const [hostname, setHostname] = useState('');
  const [tunnelId, setTunnelId] = useState('');
  const [certId, setCertId] = useState(0);
  const [tunnels, setTunnels] = useState<CfTunnelOption[]>([]);
  const [certs, setCerts] = useState<NpmCertOption[]>([]);
  const [busy, setBusy] = useState(false);

  const kind = targets.find((t) => t.instanceId === instanceId)?.kind;

  useEffect(() => {
    setTunnels([]); setCerts([]); setTunnelId(''); setCertId(0);
    if (!instanceId || !kind) return;
    if (kind === 'cloudflare') {
      api.get<CfTunnelOption[]>(`/api/replicator/ingress/tunnels?instanceId=${instanceId}`).then((t) => { setTunnels(t); setTunnelId(t[0]?.id ?? ''); }).catch(() => {});
    } else {
      api.get<NpmCertOption[]>(`/api/replicator/ingress/certs?instanceId=${instanceId}`).then(setCerts).catch(() => {});
    }
  }, [instanceId, kind]);

  async function add() {
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/replicator/deployments/${deploymentId}/ingress`, {
        kind, instanceId, service: port.service, hostPort: port.hostPort, hostname,
        tunnelId: kind === 'cloudflare' ? tunnelId : undefined,
        certificateId: kind === 'npm' ? certId : undefined,
        sslForced: kind === 'npm' && certId > 0,
      });
      setHostname(''); setAdding(false); await onChanged();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not add ingress.'); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    setBusy(true); setErr(null);
    try { await api.delete(`/api/replicator/ingress/${id}`); await onChanged(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not remove ingress.'); }
    finally { setBusy(false); }
  }

  const canAdd = !!kind && !!instanceId && !!hostname.trim() && (kind !== 'cloudflare' || !!tunnelId);

  return (
    <div className="rounded-lg border border-border/60 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono text-xs">{port.service} · :{port.hostPort}→{port.containerPort}</span>
          {routes.length > 0
            ? <span className="rounded-full bg-emerald-400/15 text-emerald-400 px-2 py-0.5 text-[0.65rem] font-semibold">{routes.length} route{routes.length === 1 ? '' : 's'}</span>
            : <span className="rounded-full bg-muted/60 text-muted-foreground px-2 py-0.5 text-[0.65rem] font-semibold">not exposed</span>}
        </div>
        {!adding && (
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" /> Add route</Button>
        )}
      </div>

      {routes.length > 0 && (
        <div className="divide-y divide-border/60 rounded-md border border-border/50">
          {routes.map((ing) => (
            <div key={ing.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-sm">
              <div className="min-w-0">
                <a href={ing.url} target="_blank" rel="noreferrer" className="font-medium truncate inline-flex items-center gap-1 hover:underline">
                  {ing.hostname} <ExternalLink className="h-3 w-3 opacity-60" />
                </a>
                <p className="text-xs text-muted-foreground">{ing.kind === 'cloudflare' ? 'Cloudflare' : 'NPM'} · {ing.instanceName}</p>
              </div>
              <Button variant="ghost" size="icon" aria-label="Remove route" disabled={busy} onClick={() => remove(ing.id)}>
                <X className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <div className="space-y-2 pt-1">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Via</Label>
              <select className={selectCls} value={instanceId} onChange={(e) => setInstanceId(e.target.value)}>
                {targets.map((t) => <option key={t.instanceId} value={t.instanceId}>{t.name} ({t.kind === 'cloudflare' ? 'Cloudflare' : 'NPM'})</option>)}
              </select>
            </div>
            <div><Label>Hostname</Label><Input value={hostname} placeholder="app.example.com" onChange={(e) => setHostname(e.target.value)} /></div>
            {kind === 'cloudflare' && (
              <div className="col-span-2">
                <Label>Tunnel</Label>
                <select className={selectCls} value={tunnelId} onChange={(e) => setTunnelId(e.target.value)}>
                  {tunnels.length === 0 && <option value="">No tunnels found</option>}
                  {tunnels.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <p className="text-xs text-muted-foreground mt-1">Adds a proxied CNAME and a public-hostname route to the tunnel.</p>
              </div>
            )}
            {kind === 'npm' && (
              <div className="col-span-2">
                <Label>Certificate</Label>
                <select className={selectCls} value={certId} onChange={(e) => setCertId(Number(e.target.value))}>
                  {certs.length === 0 && <option value={0}>None (HTTP only)</option>}
                  {certs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={add} disabled={busy || !canAdd}>{busy ? 'Adding…' : <><Plus className="h-4 w-4" /> Add route</>}</Button>
            {routes.length > 0 && <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setHostname(''); }}>Cancel</Button>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Human label for a variable's role, in the schema list. */
function roleLabel(v: ReplicatorVariable): string {
  if (v.role === 'host_port') return `port →${v.containerPort ?? '?'}`;
  if (v.role === 'host_ip') return 'bind address';
  return v.role;
}

/**
 * The reviewable variable schema, shared by the register and refresh dialogs.
 *
 * Variables are grouped by where they came from, because the groups behave
 * differently and the operator needs to see which is which: compose tokens carry
 * the port/image structure, env-file entries came from a committed `.env.example`,
 * and hand-added ones exist only in Cerebro — they're what you reach for when the
 * app reads a key the repo never documents. All three are written into the
 * deployment's `.env` the same way.
 */
function VariableSchemaEditor({ vars, onChange, added }: {
  vars: ReplicatorVariable[]; onChange: (next: ReplicatorVariable[]) => void; added?: string[];
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [secret, setSecret] = useState(false);

  const shown = vars.filter((v) => v.role !== 'image_tag' && v.role !== 'container_name');
  const groups: { key: string; label: string; hint?: string; vars: ReplicatorVariable[] }[] = [];
  const push = (key: string, label: string, hint: string | undefined, list: ReplicatorVariable[]) => {
    if (list.length) groups.push({ key, label, hint, vars: list });
  };
  push('compose', 'From the compose file', undefined, shown.filter((v) => (v.source ?? 'compose') === 'compose'));
  for (const file of [...new Set(shown.filter((v) => v.source === 'env_file').map((v) => v.envFile ?? ''))]) {
    push(`env:${file}`, `From ${file || 'an env file'}`, 'Written to the .env Cerebro creates beside the compose file.',
      shown.filter((v) => v.source === 'env_file' && (v.envFile ?? '') === file));
  }
  push('manual', 'Added here', 'Not in the repo — Cerebro writes these into the deployment’s .env.',
    shown.filter((v) => v.source === 'manual'));

  const trimmed = name.trim();
  const nameOk = /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed);
  const duplicate = nameOk && vars.some((v) => v.name === trimmed);

  const toggleSecret = (target: string) => onChange(vars.map((v) =>
    v.name === target && (v.role === 'plain' || v.role === 'secret')
      ? { ...v, secret: !v.secret, role: !v.secret ? 'secret' : 'plain' } : v));

  const remove = (target: string) => onChange(vars.filter((v) => v.name !== target));

  function add() {
    if (!nameOk || duplicate) return;
    onChange([...vars, {
      name: trimmed,
      // A secret is supplied per deployment, so a shared default would be wrong.
      default: secret || !value ? null : value,
      role: secret ? 'secret' : 'plain',
      service: null,
      containerPort: null,
      required: secret,
      secret,
      source: 'manual',
      envFile: null,
      comment: null,
    }]);
    setName(''); setValue(''); setSecret(false);
  }

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 divide-y divide-border/60 max-h-64 overflow-y-auto">
        {groups.length === 0 && (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            No variables detected. Add the ones this app needs below.
          </p>
        )}
        {groups.map((g) => (
          <div key={g.key}>
            <div className="px-3 py-1 bg-muted/30">
              <p className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">{g.label}</p>
              {g.hint && <p className="text-[0.65rem] text-muted-foreground/70">{g.hint}</p>}
            </div>
            <div className="divide-y divide-border/60">
              {g.vars.map((v) => (
                <div key={v.name} className="flex items-start justify-between gap-3 px-3 py-1.5 text-sm">
                  <div className="min-w-0">
                    <span className="font-mono text-xs">{v.name}</span>
                    {added?.includes(v.name) && <span className="ml-2 text-[0.65rem] text-emerald-400">new</span>}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {roleLabel(v)}
                      {v.required ? ' · required' : v.default != null ? ` · default ${v.default === '' ? '“”' : v.default}` : ''}
                    </span>
                    {v.comment && <p className="text-[0.65rem] text-muted-foreground/80 truncate">{v.comment}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {(v.role === 'plain' || v.role === 'secret') && (
                      <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                        <input type="checkbox" checked={v.secret} onChange={() => toggleSecret(v.name)} /> secret
                      </label>
                    )}
                    {v.source === 'manual' && (
                      <Button type="button" variant="ghost" size="icon" className="h-6 w-6" title="Remove this variable"
                        aria-label={`Remove ${v.name}`} onClick={() => remove(v.name)}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Label className="text-xs">Add a variable</Label>
          <Input className="mt-1 font-mono text-xs" value={name} placeholder="EXTRA_SETTING"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        </div>
        <div className="flex-1">
          <Label className="text-xs">Default <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <Input className="mt-1" value={value} disabled={secret}
            placeholder={secret ? 'set per deployment' : 'value'}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        </div>
        <label className="flex items-center gap-1.5 text-xs h-9 cursor-pointer">
          <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} /> secret
        </label>
        <Button type="button" variant="outline" size="sm" className="h-9" onClick={add} disabled={!nameOk || duplicate}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>
      {trimmed && !nameOk && <p className="text-xs text-destructive">Use letters, digits and underscores, starting with a letter or underscore.</p>}
      {duplicate && <p className="text-xs text-destructive">{trimmed} is already in the schema.</p>}
    </div>
  );
}

// ── Environment view (what actually gets written) ───────────────────

const ENV_ORIGIN: Record<DeploymentEnvOrigin, { label: string; hint: string }> = {
  managed: { label: 'Managed by Cerebro', hint: 'Image tag, container name and the allocated host port — set per deployment so instances never collide.' },
  compose: { label: 'From the compose file', hint: 'A ${VAR} the compose interpolates.' },
  env_file: { label: 'From the repo’s env file', hint: 'Read out of the committed .env.example (or whatever env_file names).' },
  manual: { label: 'Added to the app schema', hint: 'Not in the repo — added by hand on the app, so every deployment has it.' },
  extra: { label: 'Added to this deployment', hint: 'Extra environment set on this instance alone.' },
};

const ENV_ORDER: DeploymentEnvOrigin[] = ['managed', 'compose', 'env_file', 'manual', 'extra'];

/**
 * The effective `.env` for one deployment — the answer to "what did this instance
 * actually get?", which the deploy form can only imply: managed values are
 * assigned at deploy time, env-file defaults are materialized, and a blank falls
 * back or doesn't depending on where the variable came from.
 *
 * Secrets show as masked with their vault key. The vault's own step-up-gated
 * reveal stays the single audited path to plaintext.
 */
function EnvDialog({ deployment, onClose, setErr }: {
  deployment: ReplicatorDeployment; onClose: () => void; setErr: (s: string | null) => void;
}) {
  const [view, setView] = useState<DeploymentEnvView | null>(null);
  const [loading, setLoading] = useState(true);
  const [drift, setDrift] = useState<DeploymentEnvDrift | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    setErr(null);
    api.get<DeploymentEnvView>(`/api/replicator/deployments/${deployment.id}/env`)
      .then((v) => { if (alive) setView(v); })
      .catch((e) => { if (alive) setErr(e instanceof ApiError ? e.message : 'Could not read the environment.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [deployment.id, setErr]);

  async function check() {
    setChecking(true); setErr(null);
    try { setDrift(await api.get<DeploymentEnvDrift>(`/api/replicator/deployments/${deployment.id}/env/drift`)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not compare with the host.'); }
    finally { setChecking(false); }
  }

  /** The file as text, secrets masked — safe to paste into a ticket or a diff. */
  function copy() {
    if (!view) return;
    const text = view.entries.map((e) => `${e.name}=${e.secret ? '<secret in vault>' : e.value ?? ''}`).join('\n');
    navigator.clipboard?.writeText(text + '\n').then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => setErr('Could not copy to the clipboard.'));
  }

  const groups = ENV_ORDER
    .map((origin) => ({ origin, entries: (view?.entries ?? []).filter((e) => e.origin === origin) }))
    .filter((g) => g.entries.length > 0);

  return (
    <Dialog open onClose={onClose} size="lg" title={`Environment · ${deployment.project}`}
      description="Every variable this deployment receives, and where each one came from."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button variant="outline" onClick={copy} disabled={!view}>
            {copied ? 'Copied' : 'Copy (secrets masked)'}
          </Button>
          {view?.targetKind !== 'ecs' && (
            <Button onClick={check} disabled={checking || !view}>
              {checking ? 'Reading host…' : 'Compare with host'}
            </Button>
          )}
        </>
      }>
      {loading ? (
        <p className="text-muted-foreground flex items-center gap-2 py-6"><Loader2 className="h-4 w-4 animate-spin" /> Resolving…</p>
      ) : view ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {view.path ? <>Written to <code>{view.path}</code>. </> : null}{view.note}
          </p>

          {drift && (
            <div className={`rounded-lg border p-3 space-y-1 ${drift.available && !drift.onlyOnHost.length && !drift.missingOnHost.length && !drift.differing.length ? 'border-emerald-400/40' : 'border-amber-400/40'}`}>
              <p className={`text-sm ${drift.available ? '' : 'text-muted-foreground'}`}>{drift.message}</p>
              {drift.differing.length > 0 && (
                <p className="text-xs"><span className="text-amber-400 font-medium">Different on the host:</span>{' '}
                  <span className="font-mono">{drift.differing.join(', ')}</span></p>
              )}
              {drift.onlyOnHost.length > 0 && (
                <p className="text-xs"><span className="text-amber-400 font-medium">Only on the host:</span>{' '}
                  <span className="font-mono">{drift.onlyOnHost.join(', ')}</span></p>
              )}
              {drift.missingOnHost.length > 0 && (
                <p className="text-xs"><span className="text-amber-400 font-medium">Missing on the host:</span>{' '}
                  <span className="font-mono">{drift.missingOnHost.join(', ')}</span></p>
              )}
              {drift.available && <p className="text-[0.65rem] text-muted-foreground">Key names only — host values are never read back.</p>}
            </div>
          )}

          <div className="rounded-lg border border-border/60 divide-y divide-border/60 max-h-80 overflow-y-auto">
            {groups.map((g) => (
              <div key={g.origin}>
                <div className="px-3 py-1 bg-muted/30">
                  <p className="text-[0.65rem] uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                    {g.origin === 'managed' && <Lock className="h-3 w-3" />}
                    {ENV_ORIGIN[g.origin].label}
                  </p>
                  <p className="text-[0.65rem] text-muted-foreground/70">{ENV_ORIGIN[g.origin].hint}</p>
                </div>
                <div className="divide-y divide-border/60">
                  {g.entries.map((e) => (
                    <div key={e.name} className="px-3 py-1.5">
                      <p className="font-mono text-xs break-all">
                        <span className="text-foreground">{e.name}</span>
                        <span className="text-muted-foreground">=</span>
                        {e.secret
                          ? <span className="text-amber-400" title={e.vaultKey ? `Vault key: ${e.vaultKey}` : undefined}>••••••••</span>
                          : <span className="text-muted-foreground">{e.value || <em className="not-italic opacity-60">(empty)</em>}</span>}
                      </p>
                      {e.secret && e.vaultKey && (
                        <p className="text-[0.65rem] text-muted-foreground/80 break-all">
                          In the vault as <span className="font-mono">{e.vaultKey}</span> — reveal it there.
                        </p>
                      )}
                      {e.envFile && <p className="text-[0.65rem] text-muted-foreground/70">{e.envFile}</p>}
                      {e.comment && <p className="text-[0.65rem] text-muted-foreground/80">{e.comment}</p>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {groups.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">This deployment receives no variables.</p>}
          </div>
        </div>
      ) : (
        <p className="text-sm text-destructive py-6">Could not resolve the environment.</p>
      )}
    </Dialog>
  );
}

// ── Env extras (per-deployment additions) ───────────────────────────
//
// The app schema covers what the repo declares. These are the keys it doesn't:
// something the app reads that neither the compose nor any committed env file
// mentions, or a value that differs per instance rather than per app. They're
// written into the deployment's `.env` alongside everything else.

/** A row in the extras grid. `stored` marks a secret already held in the vault. */
interface ExtraRow { id: number; name: string; value: string; secret: boolean; stored: boolean }

let extraRowSeq = 0;
const nextExtraRowId = () => ++extraRowSeq;

/**
 * Same secret-name heuristic the server applies to compose and env-file variables,
 * inlined because @cerebro/shared is consumed here as types only (its CommonJS
 * barrel doesn't expose a runtime value through `export *`).
 */
const EXTRA_SECRET_RE = /(secret|password|passwd|token|api[_-]?key|apikey|private[_-]?key|credential)/i;

/** Rebuild the grid from a deployment's stored extras (secret values stay hidden). */
function extraRowsFrom(extraEnv: Record<string, string>, extraSecretVars: string[]): ExtraRow[] {
  return [
    ...Object.entries(extraEnv ?? {}).map(([name, value]) => ({ id: nextExtraRowId(), name, value, secret: false, stored: false })),
    ...(extraSecretVars ?? []).map((name) => ({ id: nextExtraRowId(), name, value: '', secret: true, stored: true })),
  ];
}

/** Grid rows → the wire shape, dropping rows the operator left unnamed. */
function extraEntriesOf(rows: ExtraRow[]) {
  return rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), value: r.value, secret: r.secret }));
}

/** Pull `KEY=value` lines out of pasted `.env` text (quotes and `export` handled). */
function parseEnvPaste(text: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    out.push({ name: m[1], value: v });
  }
  return out;
}

function ExtraEnvEditor({ rows, onChange, schemaNames, allowKeepBlank }: {
  rows: ExtraRow[]; onChange: (next: ExtraRow[]) => void;
  /** Names already in the app's schema — an extra may not shadow one. */
  schemaNames: Set<string>;
  /** Edit mode: a blank secret keeps the stored value instead of being incomplete. */
  allowKeepBlank?: boolean;
}) {
  const [open, setOpen] = useState(rows.length > 0);
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState('');

  const patch = (id: number, next: Partial<ExtraRow>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...next } : r)));
  const add = () => onChange([...rows, { id: nextExtraRowId(), name: '', value: '', secret: false, stored: false }]);
  const remove = (id: number) => onChange(rows.filter((r) => r.id !== id));

  function applyPaste() {
    const parsed = parseEnvPaste(paste);
    if (!parsed.length) { setPasting(false); setPaste(''); return; }
    const next = [...rows];
    for (const { name, value } of parsed) {
      const existing = next.find((r) => r.name.trim() === name);
      if (existing) { existing.value = value; continue; }
      // A pasted credential starts flagged secret; the operator can untick it.
      const secret = EXTRA_SECRET_RE.test(name);
      next.push({ id: nextExtraRowId(), name, value, secret, stored: false });
    }
    onChange(next);
    setPaste(''); setPasting(false);
  }

  const problem = (r: ExtraRow): string | null => {
    const name = r.name.trim();
    if (!name) return null;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return 'Letters, digits and underscores only, starting with a letter or underscore.';
    if (schemaNames.has(name)) return `${name} is one of this app's variables — set it in the form above.`;
    if (rows.filter((o) => o.name.trim() === name).length > 1) return `${name} is listed twice.`;
    if (r.secret && !r.value && !(allowKeepBlank && r.stored)) return 'Give this secret a value.';
    return null;
  };

  const named = rows.filter((r) => r.name.trim()).length;

  return (
    <div className="rounded-lg border border-border/60">
      <button type="button" className="w-full flex items-center justify-between px-3 py-2 text-sm"
        onClick={() => setOpen((o) => !o)}>
        <span className="flex items-center gap-2">
          <FileCog className="h-4 w-4 text-muted-foreground" />
          Additional environment
          {named > 0 && <span className="text-xs text-muted-foreground">{named} entr{named === 1 ? 'y' : 'ies'}</span>}
        </span>
        <span className="text-xs text-muted-foreground">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            Keys this app needs that aren’t in its schema. Written into this deployment’s <code>.env</code>;
            secrets go to the vault and are removed with the deployment.
          </p>

          {rows.map((r) => {
            const err = problem(r);
            return (
              <div key={r.id} className="space-y-1">
                <div className="flex items-center gap-2">
                  <Input className="flex-1 font-mono text-xs" value={r.name} placeholder="EXTRA_SETTING"
                    onChange={(e) => patch(r.id, { name: e.target.value })} />
                  <Input className="flex-1" type={r.secret ? 'password' : 'text'} value={r.value}
                    placeholder={r.secret && r.stored && allowKeepBlank ? 'leave blank to keep current secret' : 'value'}
                    onChange={(e) => patch(r.id, { value: e.target.value })} />
                  {r.secret && (
                    <Button type="button" variant="outline" size="icon" aria-label="Generate" title="Generate a random value"
                      onClick={() => patch(r.id, { value: randomSecret() })}><Wand2 className="h-4 w-4" /></Button>
                  )}
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer shrink-0">
                    <input type="checkbox" checked={r.secret} onChange={(e) => patch(r.id, { secret: e.target.checked })} /> secret
                  </label>
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0"
                    aria-label="Remove entry" title="Remove this entry" onClick={() => remove(r.id)}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {err && <p className="text-xs text-destructive">{err}</p>}
              </div>
            );
          })}

          {pasting ? (
            <div className="space-y-2">
              <textarea
                className="w-full h-28 rounded-md border border-input bg-background/60 p-2 font-mono text-xs"
                value={paste} autoFocus placeholder={'PASTE=an .env here\nAPI_TOKEN=…'}
                onChange={(e) => setPaste(e.target.value)} />
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" onClick={applyPaste} disabled={!paste.trim()}>Add these</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => { setPasting(false); setPaste(''); }}>Cancel</Button>
                <span className="text-xs text-muted-foreground">Credential-looking names arrive flagged secret.</span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={add}><Plus className="h-4 w-4" /> Add entry</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPasting(true)}>Paste .env</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function VarField({ v, value, usedPorts, onChange, placeholder, hideRequired }: {
  v: ReplicatorVariable; value: string; usedPorts: number[]; onChange: (val: string) => void;
  placeholder?: string; hideRequired?: boolean;
}) {
  const conflict = v.role === 'host_port' && value && usedPorts.includes(Number(value));
  return (
    <div>
      <Label className="flex items-center gap-2">
        <span className="font-mono text-xs">{v.name}</span>
        {v.role === 'host_port' && <span className="text-xs text-muted-foreground">→ {v.containerPort}</span>}
        {v.role === 'host_ip' && <span className="text-xs text-muted-foreground">bind address</span>}
        {v.secret && <KeyRound className="h-3 w-3 text-amber-400" />}
        {v.required && !hideRequired && <span className="text-xs text-destructive">required</span>}
      </Label>
      <div className="flex items-center gap-2 mt-1">
        <Input
          type={v.role === 'host_port' ? 'number' : v.secret ? 'password' : 'text'}
          value={value}
          placeholder={placeholder ?? (v.secret && !v.required ? 'leave blank to keep repo default' : v.default ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
        {v.secret && (
          <Button type="button" variant="outline" size="icon" aria-label="Generate" title="Generate a random value"
            onClick={() => onChange(randomSecret())}><Wand2 className="h-4 w-4" /></Button>
        )}
      </div>
      {v.comment && <p className="text-xs text-muted-foreground mt-0.5">{v.comment}</p>}
      {conflict && <p className="text-xs text-destructive mt-0.5">Port {value} is already in use on this host.</p>}
    </div>
  );
}
