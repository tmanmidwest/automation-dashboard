import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, PlugZap, Pencil, Trash2, RefreshCw, Loader2, Rocket } from 'lucide-react';
import type {
  ConnectorInstanceConfig, ConnectorManifest, ConnectorResource, ConnectorAction,
  ConnectorResourceDetail, ConnectorOperation,
} from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { OperationDialog } from '@/components/OperationDialog';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

function statusColor(status?: string) {
  if (status === 'running') return 'text-emerald-400 bg-emerald-500/15';
  if (status === 'stopped') return 'text-muted-foreground bg-muted';
  return 'text-amber-400 bg-amber-500/15';
}

export function ConnectorDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canWrite = can('connectors:write');
  const canAct = can('connectors:action');

  const [inst, setInst] = useState<ConnectorInstanceConfig | null>(null);
  const [manifest, setManifest] = useState<ConnectorManifest | null>(null);
  const [operations, setOperations] = useState<ConnectorOperation[]>([]);
  const [activeOp, setActiveOp] = useState<ConnectorOperation | null>(null);
  const [kind, setKind] = useState<string>('');
  const [resources, setResources] = useState<ConnectorResource[]>([]);
  const [loadingRes, setLoadingRes] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Detail drawer
  const [detailFor, setDetailFor] = useState<ConnectorResource | null>(null);
  const [detail, setDetail] = useState<ConnectorResourceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    async function load() {
      const i = await api.get<ConnectorInstanceConfig>(`/api/connectors/instances/${id}`);
      setInst(i);
      const m = await api.get<ConnectorManifest>(`/api/connectors/available/${i.connectorId}`);
      setManifest(m);
      setKind(m.resourceKinds[0]?.id ?? '');
      if (canAct) {
        setOperations(await api.get<ConnectorOperation[]>(`/api/connectors/instances/${id}/operations?scope=create`).catch(() => []));
      }
    }
    load().catch((e) => setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to load' }));
  }, [id]);

  const loadResources = useCallback(async () => {
    if (!kind || !inst?.enabled) return;
    setLoadingRes(true);
    try {
      setResources(await api.get<ConnectorResource[]>(`/api/connectors/instances/${id}/resources?kind=${kind}`));
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Failed to load resources' });
      setResources([]);
    } finally {
      setLoadingRes(false);
    }
  }, [id, kind, inst?.enabled]);

  useEffect(() => { void loadResources(); }, [loadResources]);

  async function test() {
    setMsg(null);
    try {
      const res = await api.post<{ ok: boolean; message: string }>(`/api/connectors/instances/${id}/test`);
      setMsg({ ok: res.ok, text: res.message });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Test failed' });
    }
  }

  async function toggleEnabled() {
    if (!inst) return;
    const updated = await api.patch<ConnectorInstanceConfig>(`/api/connectors/instances/${id}/enabled`, { enabled: !inst.enabled });
    setInst({ ...inst, enabled: updated.enabled });
  }

  async function removeConnector() {
    if (!inst) return;
    if (!confirm(`Delete connector "${inst.name}"? This removes its stored credentials.`)) return;
    await api.delete(`/api/connectors/instances/${id}`);
    navigate('/connectors');
  }

  async function runAction(res: ConnectorResource, action: ConnectorAction) {
    if (action.confirm && !confirm(`${action.confirm}\n\nTarget: ${res.name}`)) return;
    setBusyAction(`${res.id}:${action.id}`);
    setMsg(null);
    try {
      const r = await api.post<{ ok: boolean; message: string }>(
        `/api/connectors/instances/${id}/resources/${kind}/${encodeURIComponent(res.id)}/actions/${action.id}`,
      );
      setMsg({ ok: r.ok, text: r.message });
      setTimeout(loadResources, 1200);
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Action failed' });
    } finally {
      setBusyAction(null);
    }
  }

  async function openDetail(res: ConnectorResource) {
    setDetailFor(res);
    setDetail(null);
    setConfirmName('');
    setDetailLoading(true);
    try {
      setDetail(await api.get<ConnectorResourceDetail>(`/api/connectors/instances/${id}/resources/${kind}/${encodeURIComponent(res.id)}`));
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Failed to load details' });
      setDetailFor(null);
    } finally {
      setDetailLoading(false);
    }
  }

  async function deleteResource() {
    if (!detailFor) return;
    setDeleting(true);
    setMsg(null);
    try {
      const r = await api.delete<{ ok: boolean; message: string }>(
        `/api/connectors/instances/${id}/resources/${kind}/${encodeURIComponent(detailFor.id)}`,
      );
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) { setDetailFor(null); loadResources(); }
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Delete failed' });
    } finally {
      setDeleting(false);
    }
  }

  if (!inst || !manifest) return null;
  const activeKind = manifest.resourceKinds.find((k) => k.id === kind);
  const actionsFor = (status?: string) =>
    (activeKind?.actions ?? []).filter((a) => !a.showWhenStatus || (status && a.showWhenStatus.includes(status)));

  return (
    <>
      <Link to="/connectors" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-3">
        <ArrowLeft className="h-4 w-4" /> Connectors
      </Link>
      <PageHeader
        title={inst.name}
        description={inst.connectorName}
        actions={
          <div className="flex items-center gap-2">
            {canWrite && <Button variant="ghost" size="sm" onClick={test}><PlugZap className="h-4 w-4" /> Test</Button>}
            {canWrite && <Button variant="ghost" size="sm" onClick={toggleEnabled}>{inst.enabled ? 'Disable' : 'Enable'}</Button>}
            {canWrite && <Button variant="ghost" size="icon" onClick={() => navigate(`/connectors/${id}/edit`)}><Pencil className="h-4 w-4" /></Button>}
            {canWrite && <Button variant="ghost" size="icon" onClick={removeConnector}><Trash2 className="h-4 w-4 text-destructive" /></Button>}
          </div>
        }
      />

      {msg && (
        <div className={cn('mb-4 text-sm rounded-md px-3 py-2 border',
          msg.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                 : 'border-destructive/40 bg-destructive/10 text-destructive')}>
          {msg.text}
        </div>
      )}

      {!inst.enabled ? (
        <Card><CardContent className="pt-8 pb-8 text-center text-muted-foreground">
          This connector is disabled. Enable it to view resources.
        </CardContent></Card>
      ) : (
        <>
          <div className="flex items-center justify-between mb-4">
            <div className="inline-flex rounded-lg border border-border p-1 bg-card">
              {manifest.resourceKinds.map((k) => (
                <button key={k.id} onClick={() => setKind(k.id)}
                  className={cn('px-4 py-1.5 text-sm rounded-md transition-colors',
                    kind === k.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
                  {k.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              {operations.filter((o) => o.kind === kind).map((op) => (
                <Button key={op.id} size="sm" onClick={() => setActiveOp(op)}>
                  <Rocket className="h-4 w-4" /> {op.label}
                </Button>
              ))}
              <Button variant="ghost" size="sm" onClick={loadResources} disabled={loadingRes}>
                <RefreshCw className={cn('h-4 w-4', loadingRes && 'animate-spin')} /> Refresh
              </Button>
            </div>
          </div>

          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground border-b border-border">
                  <tr>
                    <th className="px-4 py-3 font-medium">Name</th>
                    <th className="px-4 py-3 font-medium">ID</th>
                    <th className="px-4 py-3 font-medium">Node</th>
                    <th className="px-4 py-3 font-medium">Resources</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    {canAct && <th className="px-4 py-3 font-medium text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {resources.map((r) => (
                    <tr key={r.id} className="border-b border-border/50 last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <button className="font-medium hover:text-primary transition-colors" onClick={() => openDetail(r)}>
                          {r.name}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{String(r.details?.vmid ?? r.id)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{String(r.details?.node ?? '—')}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {[r.details?.cpu, r.details?.memory].filter(Boolean).join(' · ') || '—'}
                        {r.details?.uptime ? ` · up ${r.details.uptime}` : ''}
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn('text-xs rounded-full px-2 py-0.5 capitalize', statusColor(r.status))}>
                          {r.status ?? 'unknown'}
                        </span>
                      </td>
                      {canAct && (
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 justify-end">
                            {actionsFor(r.status).map((a) => (
                              <Button key={a.id} variant="outline" size="sm"
                                className={cn(a.intent === 'destructive' && 'text-destructive border-destructive/40 hover:bg-destructive/10')}
                                disabled={busyAction === `${r.id}:${a.id}`}
                                onClick={() => runAction(r, a)}>
                                {busyAction === `${r.id}:${a.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                {a.label}
                              </Button>
                            ))}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                  {resources.length === 0 && !loadingRes && (
                    <tr><td colSpan={canAct ? 6 : 5} className="px-4 py-8 text-center text-muted-foreground">
                      No {activeKind?.label.toLowerCase()} found.
                    </td></tr>
                  )}
                  {loadingRes && resources.length === 0 && (
                    <tr><td colSpan={canAct ? 6 : 5} className="px-4 py-8 text-center text-muted-foreground">
                      <Loader2 className="h-5 w-5 animate-spin inline" />
                    </td></tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}

      {/* Resource detail drawer */}
      <Sheet
        open={!!detailFor}
        onClose={() => setDetailFor(null)}
        title={detailFor?.name ?? ''}
        description={activeKind?.label}
        footer={canAct && detailFor && (
          <div>
            <p className="text-sm font-medium text-destructive mb-2">Delete {activeKind?.label.replace(/s$/, '')}</p>
            <p className="text-xs text-muted-foreground mb-2">
              Permanently deletes this guest and its disks. Type <span className="font-mono text-foreground">{detailFor.name}</span> to confirm.
            </p>
            <div className="flex gap-2">
              <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={detailFor.name} />
              <Button variant="destructive" disabled={confirmName !== detailFor.name || deleting} onClick={deleteResource}>
                {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete
              </Button>
            </div>
          </div>
        )}
      >
        {detailLoading && <div className="text-center text-muted-foreground py-8"><Loader2 className="h-5 w-5 animate-spin inline" /></div>}
        {detail && (
          <div className="space-y-5">
            {detail.groups.map((g) => (
              <div key={g.title}>
                <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">{g.title}</p>
                <dl className="divide-y divide-border/50">
                  {g.items.map((it, i) => (
                    <div key={i} className="flex justify-between gap-4 py-1.5 text-sm">
                      <dt className="text-muted-foreground shrink-0">{it.label}</dt>
                      <dd className={cn('text-right break-all', it.variant === 'mono' && 'font-mono text-xs',
                        it.variant === 'status' && 'capitalize')}>{it.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        )}
      </Sheet>

      {activeOp && (
        <OperationDialog
          instanceId={id!}
          operation={activeOp}
          open={!!activeOp}
          onClose={() => setActiveOp(null)}
          onDone={(createdId) => {
            setActiveOp(null);
            if (createdId && activeOp.kind !== kind) setKind(activeOp.kind);
            setTimeout(loadResources, 800);
          }}
        />
      )}
    </>
  );
}
