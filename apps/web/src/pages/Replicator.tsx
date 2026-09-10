import { useEffect, useMemo, useState } from 'react';
import { Boxes, Plus, Trash2, Rocket, GitBranch, RotateCw, Loader2, KeyRound, Wand2, Globe, ExternalLink, X, ArrowUpCircle, RefreshCw } from 'lucide-react';
import type {
  ReplicatorApp, ReplicatorDeployment, ReplicatorTarget, ReplicatorVariable,
  IntrospectResult, DeployTargetInfo, SecretSummary,
  IngressTarget, CfTunnelOption, NpmCertOption, ReplicatorIngress,
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
  const [ingressFor, setIngressFor] = useState<ReplicatorDeployment | null>(null);
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
              onIngress={setIngressFor}
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

function AppCard({ app, deployments, canWrite, hasIngress, onDeploy, onIngress, onChanged, setErr }: {
  app: ReplicatorApp; deployments: ReplicatorDeployment[]; canWrite: boolean; hasIngress: boolean;
  onDeploy: () => void; onIngress: (d: ReplicatorDeployment) => void; onChanged: () => void; setErr: (s: string | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const ports = app.variables.filter((v) => v.role === 'host_port').length;
  const secrets = app.variables.filter((v) => v.secret).length;

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
                      {d.project} <span className={`text-xs ${STATUS_COLOR[d.status] ?? ''}`}>· {d.status}</span>
                      {d.updateAvailable && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/15 text-amber-400 px-2 py-0.5 text-[0.65rem] font-semibold"
                          title={`Repo moved to ${d.availableCommit?.slice(0, 7) ?? '?'} — redeploy to update`}>
                          <ArrowUpCircle className="h-3 w-3" /> update available
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {d.dockerInstanceName ?? d.dockerInstanceId}
                      {d.ports.map((p) => ` · ${p.hostPort}→${p.containerPort}`).join('')}
                      {d.deployedCommit && ` · ${d.deployedCommit.slice(0, 7)}`}
                    </p>
                    {d.lastMessage && d.status === 'error' && <p className="text-xs text-destructive truncate">{d.lastMessage}</p>}
                  </div>
                  {canWrite && (
                    <div className="flex items-center gap-1 shrink-0">
                      {hasIngress && (
                        <Button variant="ghost" size="icon" aria-label="Manage ingress" title="Expose via Cloudflare / NPM"
                          onClick={() => onIngress(d)}><Globe className="h-4 w-4" /></Button>
                      )}
                      <Button variant={d.updateAvailable ? 'default' : 'ghost'} size="icon" aria-label="Redeploy" disabled={busy === d.id}
                        title={d.updateAvailable ? 'Update available — pull latest & redeploy' : 'Pull latest & redeploy'}
                        onClick={() => act(d.id, () => api.post(`/api/replicator/deployments/${d.id}/redeploy`, { forceRebuild: true }))}>
                        {busy === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
                      </Button>
                      <Button variant="ghost" size="icon" aria-label="Delete deployment" disabled={busy === d.id}
                        title="Stop, remove & clean up secrets"
                        onClick={() => { if (confirm(`Remove deployment "${d.project}"? This stops the stack, removes any ingress, and deletes its secrets.`)) act(d.id, () => api.delete(`/api/replicator/deployments/${d.id}`)); }}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  )}
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

  const toggleSecret = (name: string) => setVars((vs) => vs.map((v) =>
    v.name === name && (v.role === 'plain' || v.role === 'secret')
      ? { ...v, secret: !v.secret, role: !v.secret ? 'secret' : 'plain' } : v));

  return (
    <Dialog open onClose={onClose} size="lg" title="Register app"
      description="Point Cerebro at a Git repo; it reads the compose file to detect variables and ports."
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
              Detected from <code>{result.composePath}</code> · services: {result.services.join(', ') || '—'}.
              Image tag &amp; container name are set per deployment automatically.
            </p>
            <div className="rounded-lg border border-border/60 divide-y divide-border/60 max-h-64 overflow-y-auto">
              {vars.filter((v) => v.role !== 'image_tag' && v.role !== 'container_name').map((v) => (
                <div key={v.name} className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
                  <div className="min-w-0">
                    <span className="font-mono text-xs">{v.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {v.role === 'host_port' ? `port →${v.containerPort ?? '?'}` : v.role}
                      {v.required ? ' · required' : v.default != null ? ` · default ${v.default === '' ? '“”' : v.default}` : ''}
                    </span>
                  </div>
                  {(v.role === 'plain' || v.role === 'secret') && (
                    <label className="flex items-center gap-1.5 text-xs shrink-0 cursor-pointer">
                      <input type="checkbox" checked={v.secret} onChange={() => toggleSecret(v.name)} /> secret
                    </label>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ── Deploy dialog (target → plan → variable form) ───────────────────

function DeployDialog({ app, targets, onClose, onDeployed, setErr }: {
  app: ReplicatorApp; targets: ReplicatorTarget[]; onClose: () => void; onDeployed: () => void; setErr: (s: string | null) => void;
}) {
  const deployable = targets.filter((t) => t.deployable);
  const [dockerInstanceId, setDockerInstanceId] = useState(deployable[0]?.instanceId ?? '');
  const [name, setName] = useState('');
  const [plan, setPlan] = useState<DeployTargetInfo | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [ports, setPorts] = useState<Record<string, number>>({});
  const [forceRebuild, setForceRebuild] = useState(true);
  const [busy, setBusy] = useState(false);

  const formVars = app.variables.filter((v) => v.role !== 'image_tag' && v.role !== 'container_name');

  async function loadPlan() {
    if (!dockerInstanceId) return;
    setBusy(true); setErr(null);
    try {
      const p = await api.post<DeployTargetInfo>(`/api/replicator/apps/${app.id}/plan`, { dockerInstanceId });
      setPlan(p);
      // Seed defaults: plain from repo default; ports from suggestions.
      const v: Record<string, string> = {};
      for (const fv of formVars) if (fv.role === 'plain' && fv.default != null) v[fv.name] = fv.default;
      setValues(v);
      const pr: Record<string, number> = {};
      for (const s of p.suggestions) pr[s.variable] = s.suggested;
      setPorts(pr);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not plan the deploy.'); }
    finally { setBusy(false); }
  }

  async function deploy() {
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/replicator/apps/${app.id}/deploy`, { dockerInstanceId, name, values, secrets, ports, forceRebuild });
      onDeployed();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Deploy failed.'); setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose} size="lg" title={`Deploy ${app.name}`}
      description="Materialize a new isolated instance onto a Docker host."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {plan
            ? <Button onClick={deploy} disabled={busy || !name.trim()}>{busy ? 'Deploying…' : <><Rocket className="h-4 w-4" /> Deploy</>}</Button>
            : <Button onClick={loadPlan} disabled={busy || !dockerInstanceId}>{busy ? 'Checking host…' : 'Next: check ports'}</Button>}
        </>
      }>
      <div className="space-y-4">
        {deployable.length === 0 && (
          <p className="text-sm text-amber-400">No deployable Docker connector — add one with SSH configured.</p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Target host</Label>
            <select className={selectCls} value={dockerInstanceId} disabled={!!plan} onChange={(e) => setDockerInstanceId(e.target.value)}>
              {deployable.map((t) => <option key={t.instanceId} value={t.instanceId}>{t.name} ({t.hostIp})</option>)}
            </select>
          </div>
          <div><Label>Deployment name</Label><Input value={name} placeholder="acme-poc" onChange={(e) => setName(e.target.value)} /></div>
        </div>

        {plan && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Host {plan.hostIp} · {plan.usedPorts.length} ports already in use. Reachable at {plan.hostIp}:&lt;host port&gt;.
            </p>
            <div className="space-y-2">
              {formVars.map((v) => (
                <VarField key={v.name} v={v}
                  value={v.role === 'host_port' ? String(ports[v.name] ?? '') : v.role === 'secret' ? (secrets[v.name] ?? '') : (values[v.name] ?? '')}
                  usedPorts={plan.usedPorts}
                  onChange={(val) => {
                    if (v.role === 'host_port') setPorts((p) => ({ ...p, [v.name]: Number(val) }));
                    else if (v.role === 'secret') setSecrets((s) => ({ ...s, [v.name]: val }));
                    else setValues((s) => ({ ...s, [v.name]: val }));
                  }} />
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={forceRebuild} onChange={(e) => setForceRebuild(e.target.checked)} />
              Force rebuild images (repos that build their own image)
            </label>
          </div>
        )}
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
  const [hostPort, setHostPort] = useState<number>(deployment.ports[0]?.hostPort ?? 0);
  const [instanceId, setInstanceId] = useState(targets[0]?.instanceId ?? '');
  const [hostname, setHostname] = useState('');
  const [tunnelId, setTunnelId] = useState('');
  const [certId, setCertId] = useState(0);
  const [tunnels, setTunnels] = useState<CfTunnelOption[]>([]);
  const [certs, setCerts] = useState<NpmCertOption[]>([]);
  const [busy, setBusy] = useState(false);

  const target = targets.find((t) => t.instanceId === instanceId);
  const kind = target?.kind;

  useEffect(() => {
    setTunnels([]); setCerts([]); setTunnelId(''); setCertId(0);
    if (!instanceId || !kind) return;
    if (kind === 'cloudflare') {
      api.get<CfTunnelOption[]>(`/api/replicator/ingress/tunnels?instanceId=${instanceId}`).then((t) => { setTunnels(t); setTunnelId(t[0]?.id ?? ''); }).catch(() => {});
    } else {
      api.get<NpmCertOption[]>(`/api/replicator/ingress/certs?instanceId=${instanceId}`).then(setCerts).catch(() => {});
    }
  }, [instanceId, kind]);

  async function refetch() {
    const l = await api.get<ReplicatorIngress[]>(`/api/replicator/deployments/${deployment.id}/ingress`).catch(() => list);
    setList(l); onChanged();
  }

  async function add() {
    setBusy(true); setErr(null);
    try {
      const service = deployment.ports.find((p) => p.hostPort === hostPort)?.service ?? 'app';
      await api.post(`/api/replicator/deployments/${deployment.id}/ingress`, {
        kind, instanceId, service, hostPort, hostname,
        tunnelId: kind === 'cloudflare' ? tunnelId : undefined,
        certificateId: kind === 'npm' ? certId : undefined,
        sslForced: kind === 'npm' && certId > 0,
      });
      setHostname(''); await refetch();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not add ingress.'); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    setBusy(true); setErr(null);
    try { await api.delete(`/api/replicator/ingress/${id}`); await refetch(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not remove ingress.'); }
    finally { setBusy(false); }
  }

  const canAdd = !!kind && !!instanceId && !!hostname.trim() && (kind !== 'cloudflare' || !!tunnelId);

  return (
    <Dialog open onClose={onClose} size="lg" title={`Ingress · ${deployment.project}`}
      description="Expose a published port through a Cloudflare tunnel or Nginx Proxy Manager."
      footer={<Button variant="outline" onClick={onClose}>Done</Button>}>
      <div className="space-y-4">
        {list.length > 0 && (
          <div className="rounded-lg border border-border/60 divide-y divide-border/60">
            {list.map((ing) => (
              <div key={ing.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <a href={ing.url} target="_blank" rel="noreferrer" className="font-medium truncate inline-flex items-center gap-1 hover:underline">
                    {ing.hostname} <ExternalLink className="h-3 w-3 opacity-60" />
                  </a>
                  <p className="text-xs text-muted-foreground">{ing.kind === 'cloudflare' ? 'Cloudflare' : 'NPM'} · {ing.instanceName} · →:{ing.hostPort}</p>
                </div>
                <Button variant="ghost" size="icon" aria-label="Remove ingress" disabled={busy} onClick={() => remove(ing.id)}>
                  <X className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="rounded-lg border border-border/60 p-3 space-y-3">
          <p className="text-sm font-medium">Add ingress</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Published port</Label>
              <select className={selectCls} value={hostPort} onChange={(e) => setHostPort(Number(e.target.value))}>
                {deployment.ports.map((p) => <option key={p.hostPort} value={p.hostPort}>{p.service} · {p.hostPort}→{p.containerPort}</option>)}
              </select>
            </div>
            <div>
              <Label>Via</Label>
              <select className={selectCls} value={instanceId} onChange={(e) => setInstanceId(e.target.value)}>
                {targets.map((t) => <option key={t.instanceId} value={t.instanceId}>{t.name} ({t.kind === 'cloudflare' ? 'Cloudflare' : 'NPM'})</option>)}
              </select>
            </div>
            <div className="col-span-2"><Label>Hostname</Label><Input value={hostname} placeholder="app.example.com" onChange={(e) => setHostname(e.target.value)} /></div>
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
          <Button onClick={add} disabled={busy || !canAdd}>{busy ? 'Adding…' : <><Plus className="h-4 w-4" /> Add route</>}</Button>
        </div>
      </div>
    </Dialog>
  );
}

function VarField({ v, value, usedPorts, onChange }: {
  v: ReplicatorVariable; value: string; usedPorts: number[]; onChange: (val: string) => void;
}) {
  const conflict = v.role === 'host_port' && value && usedPorts.includes(Number(value));
  return (
    <div>
      <Label className="flex items-center gap-2">
        <span className="font-mono text-xs">{v.name}</span>
        {v.role === 'host_port' && <span className="text-xs text-muted-foreground">→ {v.containerPort}</span>}
        {v.secret && <KeyRound className="h-3 w-3 text-amber-400" />}
        {v.required && <span className="text-xs text-destructive">required</span>}
      </Label>
      <div className="flex items-center gap-2 mt-1">
        <Input
          type={v.role === 'host_port' ? 'number' : v.secret ? 'password' : 'text'}
          value={value}
          placeholder={v.secret && !v.required ? 'leave blank to keep repo default' : v.default ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
        {v.secret && (
          <Button type="button" variant="outline" size="icon" aria-label="Generate" title="Generate a random value"
            onClick={() => onChange(randomSecret())}><Wand2 className="h-4 w-4" /></Button>
        )}
      </div>
      {conflict && <p className="text-xs text-destructive mt-0.5">Port {value} is already in use on this host.</p>}
    </div>
  );
}
