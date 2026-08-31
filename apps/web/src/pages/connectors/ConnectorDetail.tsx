import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, PlugZap, Pencil, Trash2, RefreshCw, Loader2, Rocket, Plus, Cpu, ChevronUp, ChevronDown, ChevronsUpDown, MonitorPlay, TerminalSquare, X } from 'lucide-react';
import type {
  ConnectorInstanceConfig, ConnectorManifest, ConnectorResource, ConnectorAction,
  ConnectorResourceDetail, ConnectorOperation, OverviewMetric,
} from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { OperationDialog } from '@/components/OperationDialog';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { cn, timeAgo, formatMoney, shortDateTime } from '@/lib/utils';

/** Preset background refresh intervals offered per connector. */
const REFRESH_PRESETS: { label: string; value: number }[] = [
  { label: '10s', value: 10 },
  { label: '30s', value: 30 },
  { label: '1m', value: 60 },
  { label: '5m', value: 300 },
  { label: '15m', value: 900 },
  { label: '1h', value: 3600 },
];

/** Render a connector overview metric: currency codes as money, "%" inline, else value + unit. */
function fmtMetric(m: OverviewMetric): string {
  if (m.unit && /^[A-Z]{3}$/.test(m.unit)) return formatMoney(m.value, m.unit);
  if (m.unit === '%') return `${m.value}%`;
  return m.unit ? `${m.value} ${m.unit}` : String(m.value);
}

function statusColor(status?: string) {
  if (status === 'running' || status === 'active') return 'text-emerald-400 bg-emerald-500/15';
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
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [connMetrics, setConnMetrics] = useState<OverviewMetric[]>([]);
  const [billingRefreshing, setBillingRefreshing] = useState(false);

  // Detail drawer
  const [detailFor, setDetailFor] = useState<ConnectorResource | null>(null);
  const [detail, setDetail] = useState<ConnectorResourceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Sub-resources (e.g. snapshots, ECS services/tasks) within the drawer — keyed by subKind id.
  const [subItems, setSubItems] = useState<Record<string, ConnectorResource[]>>({});
  const [subLoadingMap, setSubLoadingMap] = useState<Record<string, boolean>>({});
  const [subDialog, setSubDialog] = useState<{ operation: ConnectorOperation; extraValues: Record<string, unknown>; reloadSub?: string } | null>(null);
  const [subBusy, setSubBusy] = useState<string | null>(null);
  const [resourceOp, setResourceOp] = useState<ConnectorOperation | null>(null);

  // Sorting & grouping
  const [sortCol, setSortCol] = useState<'name' | 'vmid' | 'node' | 'status'>('vmid');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  // 'none' | 'node' | 'status' | 'tag' | 'pool' | a dynamic 'tagk:<key>' for structured tags.
  const [groupBy, setGroupBy] = useState<string>('none');

  // Tag filters (structured key/value tags, e.g. AWS) — multiple, AND-combined.
  const [tagFilters, setTagFilters] = useState<{ key: string; value: string }[]>([]);
  const [addKey, setAddKey] = useState<string>(''); // key currently being added via the builder

  const subKinds = manifest?.resourceKinds.find((k) => k.id === kind)?.subResources ?? [];
  // Operation ids that back sub-resources (create + item actions) — handled within their sub-resource section, not as cluster-level buttons.
  const subOpIds = new Set<string>();
  for (const sk of subKinds) {
    if (sk.createOperationId) subOpIds.add(sk.createOperationId);
    for (const a of sk.itemActions ?? []) subOpIds.add(a.operationId);
  }
  // Resource-scoped operations shown in the detail drawer (e.g. Edit CPU/RAM).
  const resourceOps = (manifest?.operations ?? []).filter(
    (o) => o.scope === 'resource' && !subOpIds.has(o.id) && (!o.kind || o.kind === kind),
  );
  const opById = (opId?: string) => (opId ? manifest?.operations?.find((o) => o.id === opId) ?? null : null);

  useEffect(() => {
    async function load() {
      const i = await api.get<ConnectorInstanceConfig>(`/api/connectors/instances/${id}`);
      setInst(i);
      setSyncedAt(i.lastSyncedAt);
      const m = await api.get<ConnectorManifest>(`/api/connectors/available/${i.connectorId}`);
      setManifest(m);
      setKind(m.resourceKinds[0]?.id ?? '');
      if (canAct) {
        setOperations(await api.get<ConnectorOperation[]>(`/api/connectors/instances/${id}/operations?scope=create`).catch(() => []));
      }
      if (i.enabled) {
        api.get<{ metrics: OverviewMetric[] }>(`/api/connectors/instances/${id}/overview`)
          .then((o) => setConnMetrics(o.metrics))
          .catch(() => setConnMetrics([]));
      }
    }
    load().catch((e) => setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to load' }));
  }, [id]);

  const loadResources = useCallback(async () => {
    if (!kind || !inst?.enabled) return;
    setLoadingRes(true);
    try {
      setResources(await api.get<ConnectorResource[]>(`/api/connectors/instances/${id}/resources?kind=${kind}`));
      setSyncedAt(new Date().toISOString());
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Failed to load resources' });
      setResources([]);
    } finally {
      setLoadingRes(false);
    }
  }, [id, kind, inst?.enabled]);

  useEffect(() => { void loadResources(); }, [loadResources]);

  // Clear the tag filters when switching resource kinds (tag facets differ per kind).
  useEffect(() => { setTagFilters([]); setAddKey(''); }, [kind]);

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

  async function refreshBilling() {
    setBillingRefreshing(true);
    setMsg(null);
    try {
      const o = await api.post<{ metrics: OverviewMetric[] }>(`/api/connectors/instances/${id}/overview/refresh`);
      setConnMetrics(o.metrics);
      setSyncedAt(new Date().toISOString());
      setMsg({ ok: true, text: 'Billing data refreshed from AWS Cost Explorer.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to refresh billing' });
    } finally {
      setBillingRefreshing(false);
    }
  }

  async function setRefreshInterval(sec: number) {
    if (!inst) return;
    setInst({ ...inst, refreshIntervalSec: sec }); // optimistic
    try {
      await api.put<ConnectorInstanceConfig>(`/api/connectors/instances/${id}`, { refreshIntervalSec: sec });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to update refresh interval' });
    }
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
    setSubItems({});
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
    setSubItems({});
    if (subKinds.length) void loadSubResources(res.id);
  }

  async function loadSubResources(resourceId: string) {
    const kinds = manifest?.resourceKinds.find((k) => k.id === kind)?.subResources ?? [];
    for (const sk of kinds) {
      setSubLoadingMap((m) => ({ ...m, [sk.id]: true }));
      try {
        const items = await api.get<ConnectorResource[]>(
          `/api/connectors/instances/${id}/resources/${kind}/${encodeURIComponent(resourceId)}/subresources/${sk.id}`,
        );
        setSubItems((m) => ({ ...m, [sk.id]: items }));
      } catch {
        setSubItems((m) => ({ ...m, [sk.id]: [] }));
      } finally {
        setSubLoadingMap((m) => ({ ...m, [sk.id]: false }));
      }
    }
  }

  /** Runs a resource-scoped operation as a job and waits for it to finish. */
  async function runSub(operationId: string, values: Record<string, unknown>, busyKey: string) {
    if (!detailFor) return;
    setSubBusy(busyKey);
    setMsg(null);
    try {
      const { jobId } = await api.post<{ jobId: string }>(
        `/api/connectors/instances/${id}/operations/${operationId}`,
        { resourceId: detailFor.id, values: { ...values, kind } },
      );
      let status = 'running';
      let message = '';
      for (let i = 0; i < 60 && status === 'running'; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const job = await api.get<{ status: string; message?: string }>(`/api/connectors/instances/${id}/jobs/${jobId}`);
        status = job.status;
        message = job.message ?? '';
      }
      setMsg({ ok: status === 'success', text: message || (status === 'success' ? 'Done.' : 'Operation failed.') });
      await loadSubResources(detailFor.id);
      loadResources();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Operation failed' });
    } finally {
      setSubBusy(null);
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

  // Structured tag facets present across the current resources (drives the tag
  // filter, the group-by-tag options, and the Tags column).
  const tagKeys = (() => {
    const s = new Set<string>();
    for (const r of resources) for (const k of Object.keys(r.tags ?? {})) s.add(k);
    return [...s].sort((a, b) => a.localeCompare(b));
  })();
  const hasTags = tagKeys.length > 0;
  const hasIp = resources.some((r) => r.details?.ip != null && r.details.ip !== '');
  const valuesForKey = (key: string) =>
    [...new Set(resources.map((r) => r.tags?.[key]).filter((v): v is string => v != null && v !== ''))].sort((a, b) => a.localeCompare(b));

  const filterActive = (key: string, value: string) => tagFilters.some((f) => f.key === key && f.value === value);
  const addFilter = (key: string, value: string) =>
    setTagFilters((prev) => (prev.some((f) => f.key === key && f.value === value) ? prev : [...prev, { key, value }]));
  const removeFilter = (key: string, value: string) =>
    setTagFilters((prev) => prev.filter((f) => !(f.key === key && f.value === value)));
  const toggleFilter = (key: string, value: string) =>
    (filterActive(key, value) ? removeFilter(key, value) : addFilter(key, value));

  // A resource must satisfy EVERY active tag filter (AND). An empty value means "has this tag".
  const filtered = resources.filter((r) =>
    tagFilters.every((f) => {
      const v = r.tags?.[f.key];
      return f.value ? v === f.value : v != null && v !== '';
    }),
  );

  const colSpan = (canAct ? 6 : 5) + (hasTags ? 1 : 0) + (hasIp ? 1 : 0);
  function toggleSort(col: typeof sortCol) {
    if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortCol(col); setSortDir('asc'); }
  }
  const sortVal = (r: ConnectorResource): string | number =>
    sortCol === 'vmid' ? Number(r.details?.vmid ?? r.id)
    : sortCol === 'node' ? String(r.details?.node ?? '')
    : sortCol === 'status' ? String(r.status ?? '')
    : String(r.name ?? '');
  const sorted = [...filtered].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const av = sortVal(a), bv = sortVal(b);
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
  const groups: { key: string | null; items: ConnectorResource[] }[] = (() => {
    if (groupBy === 'none') return [{ key: null, items: sorted }];
    const map = new Map<string, ConnectorResource[]>();
    for (const r of sorted) {
      let keys: string[];
      if (groupBy === 'node') keys = [String(r.details?.node ?? '—')];
      else if (groupBy === 'status') keys = [String(r.status ?? 'unknown')];
      else if (groupBy === 'pool') keys = [r.details?.pool ? String(r.details.pool) : 'No pool'];
      else if (groupBy.startsWith('tagk:')) {
        const k = groupBy.slice(5);
        keys = [r.tags?.[k] ? String(r.tags[k]) : `No ${k}`];
      } else {
        const t = r.details?.tags ? String(r.details.tags).split(/[;, ]+/).filter(Boolean) : [];
        keys = t.length ? t : ['Untagged'];
      }
      for (const k of keys) { if (!map.has(k)) map.set(k, []); map.get(k)!.push(r); }
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, items]) => ({ key, items }));
  })();

  const SortHead = ({ col, label, className }: { col: typeof sortCol; label: string; className?: string }) => (
    <th className={cn('px-4 py-3 font-medium', className)}>
      <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort(col)}>
        {label}
        {sortCol === col
          ? (sortDir === 'asc' ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />)
          : <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />}
      </button>
    </th>
  );

  return (
    <>
      <Link to="/connectors" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-3">
        <ArrowLeft className="h-4 w-4" /> Connectors
      </Link>
      <PageHeader
        title={inst.name}
        description={`${inst.connectorName} · Last sync ${timeAgo(syncedAt)}`}
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
          {connMetrics.length > 0 && (
            <div className="mb-4">
              {connMetrics.some((m) => m.key.startsWith('cost')) && canWrite && (
                <div className="flex items-center justify-end mb-2">
                  <Button variant="ghost" size="sm" onClick={refreshBilling} disabled={billingRefreshing}
                    title="Force a fresh pull from AWS Cost Explorer (one billable ~$0.01 call), bypassing the daily cache">
                    <RefreshCw className={cn('h-4 w-4', billingRefreshing && 'animate-spin')} /> Refresh billing
                  </Button>
                </div>
              )}
              <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                {connMetrics.map((m) => (
                  <div key={m.key} className="rounded-xl border border-border/60 bg-card/70 px-3 py-2.5">
                    <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70 truncate">{m.label}</p>
                    <p className="text-lg font-semibold tracking-tight">{fmtMetric(m)}</p>
                    {m.asOf && <p className="text-[10px] text-muted-foreground/60">as of {shortDateTime(m.asOf)}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
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
              {hasTags && (
                <div className="inline-flex items-center gap-1">
                  <select
                    className="h-9 rounded-md border border-input bg-background/60 px-2 text-sm text-muted-foreground"
                    value={addKey}
                    onChange={(e) => setAddKey(e.target.value)}
                    title="Filter by tag"
                  >
                    <option value="">+ Tag filter</option>
                    {tagKeys.map((k) => <option key={k} value={k}>Tag: {k}</option>)}
                  </select>
                  {addKey && (
                    <select
                      className="h-9 rounded-md border border-input bg-background/60 px-2 text-sm text-muted-foreground"
                      value=""
                      onChange={(e) => {
                        if (!e.target.value) return;
                        addFilter(addKey, e.target.value === '__any__' ? '' : e.target.value);
                        setAddKey('');
                      }}
                      title="Tag value"
                    >
                      <option value="">value…</option>
                      <option value="__any__">Any value</option>
                      {valuesForKey(addKey).map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  )}
                </div>
              )}
              <select
                className="h-9 rounded-md border border-input bg-background/60 px-2 text-sm text-muted-foreground"
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value)}
                title="Group by"
              >
                <option value="none">No grouping</option>
                {!hasTags && <option value="tag">Group by tag</option>}
                {!hasTags && <option value="pool">Group by pool</option>}
                <option value="node">Group by node</option>
                <option value="status">Group by status</option>
                {tagKeys.map((k) => <option key={`g-${k}`} value={`tagk:${k}`}>Group by tag: {k}</option>)}
              </select>
              {operations.filter((o) => o.kind === kind).map((op) => (
                <Button key={op.id} size="sm" onClick={() => setActiveOp(op)}>
                  <Rocket className="h-4 w-4" /> {op.label}
                </Button>
              ))}
              {canWrite && (
                <select
                  className="h-9 rounded-md border border-input bg-background/60 px-2 text-sm text-muted-foreground"
                  value={inst.refreshIntervalSec}
                  onChange={(e) => setRefreshInterval(Number(e.target.value))}
                  title="How often background telemetry re-syncs this connector"
                >
                  {REFRESH_PRESETS.map((p) => <option key={p.value} value={p.value}>Sync every {p.label}</option>)}
                  {!REFRESH_PRESETS.some((p) => p.value === inst.refreshIntervalSec) && (
                    <option value={inst.refreshIntervalSec}>Sync every {inst.refreshIntervalSec}s</option>
                  )}
                </select>
              )}
              <Button variant="ghost" size="sm" onClick={loadResources} disabled={loadingRes}>
                <RefreshCw className={cn('h-4 w-4', loadingRes && 'animate-spin')} /> Refresh
              </Button>
            </div>
          </div>

          {tagFilters.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mb-3">
              <span className="text-xs text-muted-foreground mr-0.5">Filtering by</span>
              {tagFilters.map((f) => (
                <button
                  key={`${f.key}=${f.value}`}
                  onClick={() => removeFilter(f.key, f.value)}
                  title="Remove filter"
                  className="inline-flex items-center gap-1 text-[11px] rounded-md border border-primary/60 bg-primary/15 px-1.5 py-0.5 font-mono text-foreground hover:bg-primary/25"
                >
                  {f.key}<span className="opacity-50">=</span>{f.value || 'any'}
                  <X className="h-3 w-3 opacity-70" />
                </button>
              ))}
              <button onClick={() => setTagFilters([])} className="text-[11px] text-muted-foreground hover:text-foreground underline ml-1">
                Clear all
              </button>
            </div>
          )}

          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground border-b border-border">
                  <tr>
                    <SortHead col="name" label="Name" />
                    <SortHead col="vmid" label="ID" />
                    <SortHead col="node" label="Node" />
                    <th className="px-4 py-3 font-medium">Resources</th>
                    {hasIp && <th className="px-4 py-3 font-medium">IP</th>}
                    <SortHead col="status" label="Status" />
                    {hasTags && <th className="px-4 py-3 font-medium">Tags</th>}
                    {canAct && <th className="px-4 py-3 font-medium text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <Fragment key={g.key ?? '__all'}>
                      {g.key !== null && (
                        <tr className="bg-muted/40">
                          <td colSpan={colSpan} className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            {g.key} <span className="text-muted-foreground/60">({g.items.length})</span>
                          </td>
                        </tr>
                      )}
                      {g.items.map((r) => (
                        <tr key={(g.key ?? '') + r.id} className="border-b border-border/50 last:border-0 hover:bg-muted/30">
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
                          {hasIp && (
                            <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{r.details?.ip ? String(r.details.ip) : '—'}</td>
                          )}
                          <td className="px-4 py-3">
                            <span className={cn('text-xs rounded-full px-2 py-0.5 capitalize', statusColor(r.status))}>
                              {r.status ?? 'unknown'}
                            </span>
                          </td>
                          {hasTags && (
                            <td className="px-4 py-3">
                              <div className="flex flex-wrap gap-1 max-w-[260px]">
                                {Object.entries(r.tags ?? {}).slice(0, 4).map(([k, v]) => (
                                  <button
                                    key={k}
                                    title={filterActive(k, v) ? `Remove filter ${k}=${v}` : `Filter by ${k}=${v}`}
                                    onClick={() => toggleFilter(k, v)}
                                    className={cn(
                                      'text-[11px] rounded-md border px-1.5 py-0.5 font-mono transition-colors',
                                      filterActive(k, v)
                                        ? 'border-primary/60 bg-primary/15 text-foreground'
                                        : 'border-border bg-muted/40 text-muted-foreground hover:border-primary/40 hover:text-foreground',
                                    )}
                                  >
                                    {k}<span className="opacity-50">=</span>{v || '—'}
                                  </button>
                                ))}
                                {Object.keys(r.tags ?? {}).length > 4 && (
                                  <span className="text-[11px] text-muted-foreground/70 px-1 py-0.5">+{Object.keys(r.tags ?? {}).length - 4}</span>
                                )}
                                {Object.keys(r.tags ?? {}).length === 0 && <span className="text-xs text-muted-foreground/50">—</span>}
                              </div>
                            </td>
                          )}
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
                    </Fragment>
                  ))}
                  {resources.length === 0 && !loadingRes && (
                    <tr><td colSpan={colSpan} className="px-4 py-8 text-center text-muted-foreground">
                      No {activeKind?.label.toLowerCase()} found.
                    </td></tr>
                  )}
                  {resources.length > 0 && filtered.length === 0 && !loadingRes && (
                    <tr><td colSpan={colSpan} className="px-4 py-8 text-center text-muted-foreground">
                      No {activeKind?.label.toLowerCase()} match {tagFilters.length > 1 ? 'these tag filters' : 'this tag filter'}.{' '}
                      <button className="text-primary hover:underline" onClick={() => setTagFilters([])}>Clear {tagFilters.length > 1 ? 'filters' : 'filter'}</button>
                    </td></tr>
                  )}
                  {loadingRes && resources.length === 0 && (
                    <tr><td colSpan={colSpan} className="px-4 py-8 text-center text-muted-foreground">
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
        footer={canAct && detailFor && activeKind?.deletable !== false && (
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
        {canAct && (resourceOps.length > 0 || (activeKind?.console && detailFor)) && (
          <div className="flex flex-wrap gap-2 mb-5">
            {activeKind?.console && detailFor?.status === 'running' && (
              <>
                <Button size="sm" variant="outline"
                  onClick={() => navigate(`/connectors/${id}/console/${kind}/${encodeURIComponent(detailFor.id)}`)}>
                  <MonitorPlay className="h-4 w-4" /> Console
                </Button>
                <Button size="sm" variant="outline"
                  onClick={() => navigate(`/connectors/${id}/console/${kind}/${encodeURIComponent(detailFor.id)}?mode=serial`)}>
                  <TerminalSquare className="h-4 w-4" /> Serial
                </Button>
              </>
            )}
            {resourceOps.map((op) => (
              <Button key={op.id} size="sm" variant="outline" onClick={() => setResourceOp(op)}>
                <Cpu className="h-4 w-4" /> {op.label}
              </Button>
            ))}
          </div>
        )}
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

        {detailFor && subKinds.map((sk) => {
          const items = subItems[sk.id] ?? [];
          const createOp = opById(sk.createOperationId);
          return (
            <div key={sk.id} className="mt-6 pt-5 border-t border-border">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">{sk.label}</p>
                {canAct && createOp && (
                  <Button size="sm" variant="outline"
                    onClick={() => setSubDialog({ operation: createOp, extraValues: { kind, node: detailFor.details?.node as string | undefined }, reloadSub: sk.id })}>
                    <Plus className="h-4 w-4" /> {createOp.label}
                  </Button>
                )}
              </div>
              {subLoadingMap[sk.id] ? (
                <div className="text-center text-muted-foreground py-3"><Loader2 className="h-4 w-4 animate-spin inline" /></div>
              ) : items.length === 0 ? (
                <p className="text-sm text-muted-foreground">No {sk.label.toLowerCase()}.</p>
              ) : (
                <div className="space-y-2">
                  {items.map((s) => (
                    <div key={s.id} className="rounded-md border border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{s.name}
                            {s.status && <span className="ml-2 text-xs text-muted-foreground">({s.status})</span>}</p>
                          {s.details?.summary && <p className="text-xs text-muted-foreground truncate">{String(s.details.summary)}</p>}
                          {s.details?.created && <p className="text-xs text-muted-foreground">{String(s.details.created)}</p>}
                          {s.details?.description && <p className="text-xs text-muted-foreground italic">{String(s.details.description)}</p>}
                        </div>
                        {canAct && (
                          <div className="flex items-center gap-1 shrink-0">
                            {sk.itemActions?.map((a) => {
                              const op = opById(a.operationId);
                              const hasForm = !!op?.fields?.length;
                              return (
                                <Button key={a.id} size="sm" variant="outline"
                                  className={cn(a.intent === 'destructive' && 'text-destructive border-destructive/40 hover:bg-destructive/10')}
                                  disabled={subBusy === `${s.id}:${a.id}`}
                                  onClick={() => {
                                    if (hasForm && op) {
                                      setSubDialog({ operation: op, extraValues: { kind, [a.paramKey]: s.id }, reloadSub: sk.id });
                                      return;
                                    }
                                    if (a.confirm && !confirm(`${a.confirm}\n\n${sk.labelSingular ?? 'Item'}: ${s.name}`)) return;
                                    runSub(a.operationId, { [a.paramKey]: s.id }, `${s.id}:${a.id}`);
                                  }}>
                                  {subBusy === `${s.id}:${a.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                  {a.label}
                                </Button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </Sheet>

      {activeOp && (
        <OperationDialog
          instanceId={id!}
          operation={activeOp}
          open={!!activeOp}
          onClose={() => setActiveOp(null)}
          onDone={(createdId) => {
            setActiveOp(null);
            if (createdId && activeOp.kind && activeOp.kind !== kind) setKind(activeOp.kind);
            setTimeout(loadResources, 800);
          }}
        />
      )}

      {subDialog && detailFor && (
        <OperationDialog
          instanceId={id!}
          operation={subDialog.operation}
          resourceId={detailFor.id}
          extraValues={subDialog.extraValues}
          open={!!subDialog}
          onClose={() => setSubDialog(null)}
          onDone={() => {
            const reload = subDialog.reloadSub;
            setSubDialog(null);
            if (detailFor) {
              if (reload) void loadSubResources(detailFor.id);
              loadResources();
            }
          }}
        />
      )}

      {resourceOp && detailFor && (
        <OperationDialog
          instanceId={id!}
          operation={resourceOp}
          resourceId={detailFor.id}
          extraValues={{ kind, node: detailFor.details?.node as string | undefined }}
          open={!!resourceOp}
          onClose={() => setResourceOp(null)}
          onDone={() => {
            const target = detailFor;
            setResourceOp(null);
            if (target) openDetail(target); // refresh the detail to show new CPU/RAM
            loadResources();
          }}
        />
      )}
    </>
  );
}
