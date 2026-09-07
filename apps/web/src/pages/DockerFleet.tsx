import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Loader2, RefreshCw, Server, ChevronRight, ChevronDown, Play, Square, RotateCw,
  Boxes, Terminal, ScrollText, ArrowUpCircle, Search, X, Rocket, History, GitCompare, Pencil,
} from 'lucide-react';
import type { DockerFleet, FleetHost, FleetStack, FleetMember, ConnectorManifest, ConnectorOperation } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { OperationDialog } from '@/components/OperationDialog';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { statusBadgeColor } from '@/lib/utils';

type Focus = 'unhealthy' | 'updates' | 'stopped' | 'running' | null;
const REFRESH_MS = 30_000;
const RUNNING_LIKE = new Set(['running', 'restarting', 'unhealthy']);
const STOPPED_LIKE = new Set(['exited', 'created', 'dead', 'stopped', 'paused']);
// A stack is "stopped" (offer Start) when nothing is running; else offer Stop/Restart.
const STACK_STOPPED = new Set(['stopped', 'error', 'never']);

function matchesFocus(m: FleetMember, focus: Focus): boolean {
  if (!focus) return true;
  if (focus === 'unhealthy') return m.status === 'unhealthy';
  if (focus === 'updates') return m.hasUpdate;
  if (focus === 'running') return m.status === 'running';
  if (focus === 'stopped') return STOPPED_LIKE.has(m.status);
  return true;
}

// ── Live-event patching (no server round-trip for a status flip) ──
type LiveResource = { id: string; status?: string; details?: { stack?: string; image?: string; service?: string } };

/** Recompute a host's stack rollups + metric counts from its (possibly-patched) members. */
function recomputeHost(h: FleetHost): FleetHost {
  const stacks = h.stacks.map((s): FleetStack => {
    const running = s.members.filter((m) => m.status === 'running').length;
    const unhealthy = s.members.filter((m) => m.status === 'unhealthy').length;
    const status = s.members.length === 0 ? s.status
      : unhealthy > 0 ? 'unhealthy' : running === 0 ? 'stopped' : running < s.members.length ? 'degraded' : 'running';
    return { ...s, running, containers: s.members.length, updates: s.members.filter((m) => m.hasUpdate).length, status };
  });
  const members = stacks.flatMap((s) => s.members);
  return {
    ...h, stacks,
    metrics: {
      ...h.metrics,
      running: members.filter((m) => m.status === 'running').length,
      stopped: members.filter((m) => STOPPED_LIKE.has(m.status)).length,
      unhealthy: members.filter((m) => m.status === 'unhealthy').length,
      restarting: members.filter((m) => m.status === 'restarting').length,
    },
  };
}

function recomputeTotals(hosts: FleetHost[]): DockerFleet['totals'] {
  const sum = (pick: (m: FleetHost['metrics']) => number) => hosts.reduce((n, h) => n + (pick(h.metrics) || 0), 0);
  return {
    hosts: hosts.length,
    online: hosts.filter((h) => h.online).length,
    running: sum((m) => m.running),
    stopped: sum((m) => m.stopped),
    unhealthy: sum((m) => m.unhealthy),
    stacks: hosts.reduce((n, h) => n + h.stacks.length, 0),
    updates: sum((m) => m.updates),
    diskUsedGb: Math.round(sum((m) => m.diskUsedGb ?? 0) * 10) / 10,
  };
}

/** Apply one live container event in place. Returns the new fleet + whether a structural refresh is still needed. */
function applyLiveEvent(fleet: DockerFleet, instanceId: string, r: LiveResource): { fleet: DockerFleet; needsRefresh: boolean } {
  const hostIdx = fleet.hosts.findIndex((h) => h.instanceId === instanceId);
  if (hostIdx < 0) return { fleet, needsRefresh: true };
  const status = r.status ?? 'unknown';
  const removed = status === 'removed';
  let found = false;
  const stacks = fleet.hosts[hostIdx].stacks.map((s) => {
    const mi = s.members.findIndex((m) => m.id === r.id);
    if (mi < 0) return s;
    found = true;
    const members = s.members.slice();
    if (removed) members.splice(mi, 1);
    else members[mi] = { ...members[mi], status, image: r.details?.image || members[mi].image };
    return { ...s, members };
  });
  if (!found) return { fleet, needsRefresh: true }; // new container (or moved) → reconcile via a refresh
  const hosts = fleet.hosts.slice();
  hosts[hostIdx] = recomputeHost({ ...fleet.hosts[hostIdx], stacks });
  return { fleet: { hosts, totals: recomputeTotals(hosts) }, needsRefresh: false };
}

export function DockerFleet() {
  const { can } = useAuth();
  const canAct = can('connectors:action');
  const navigate = useNavigate();

  const [fleet, setFleet] = useState<DockerFleet | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [live, setLive] = useState(false);

  const [view, setView] = useState<'stacks' | 'containers'>('stacks');
  const [focus, setFocus] = useState<Focus>(null);
  const [q, setQ] = useState('');
  const [collapsedHosts, setCollapsedHosts] = useState<Set<string>>(new Set());
  const [expandedStacks, setExpandedStacks] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  // Docker manifest operations (same for every host) + the currently-open operation dialog.
  const [ops, setOps] = useState<ConnectorOperation[]>([]);
  const [activeOp, setActiveOp] = useState<{ operation: ConnectorOperation; instanceId: string; resourceId?: string; seed?: Record<string, unknown> } | null>(null);
  useEffect(() => {
    api.get<ConnectorManifest>('/api/connectors/available/docker').then((m) => setOps(m.operations ?? [])).catch(() => {});
  }, []);
  const openOp = (opId: string, instanceId: string, resourceId?: string, seed?: Record<string, unknown>) => {
    const operation = ops.find((o) => o.id === opId);
    if (operation) setActiveOp({ operation, instanceId, resourceId, seed });
  };

  async function load(manual = false) {
    if (manual) setRefreshing(true);
    try {
      // Manual refresh forces a fresh compute; the background poll serves the warm cache (instant).
      const data = await api.get<DockerFleet>(`/api/docker/fleet${manual ? '?force=1' : ''}`);
      setFleet(data); setLoadedAt(new Date()); setErr(null);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed to load the fleet.'); }
    finally { if (manual) setRefreshing(false); }
  }
  useEffect(() => { load(); const t = setInterval(() => load(), REFRESH_MS); return () => clearInterval(t); }, []);

  // Live container updates merged across all hosts — patch state in place (no server round-trip),
  // and debounce a reconciling refresh for structural changes (new/removed containers).
  const fleetRef = useRef<DockerFleet | null>(null);
  useEffect(() => { fleetRef.current = fleet; }, [fleet]);
  const structuralTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const es = new EventSource('/api/docker/fleet/live');
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false); // EventSource reconnects on its own
    es.onmessage = (e) => {
      const cur = fleetRef.current;
      if (!cur) return;
      let evt: { instanceId?: string; resource?: LiveResource };
      try { evt = JSON.parse(e.data); } catch { return; }
      if (!evt?.instanceId || !evt.resource) return; // heartbeat / non-event → ignore
      const { fleet: next, needsRefresh } = applyLiveEvent(cur, evt.instanceId, evt.resource);
      fleetRef.current = next;
      setFleet(next);
      setLoadedAt(new Date());
      if (needsRefresh && !structuralTimer.current) {
        structuralTimer.current = setTimeout(() => { structuralTimer.current = null; load(true); }, 1200);
      }
    };
    return () => { es.close(); if (structuralTimer.current) clearTimeout(structuralTimer.current); };
  }, []);

  const memberKey = (m: FleetMember) => `${m.instanceId}::${m.id}`;
  const allMembers = useMemo(
    () => (fleet?.hosts ?? []).flatMap((h) => h.stacks.flatMap((s) => s.members.map((m) => ({ m, host: h, stack: s })))),
    [fleet],
  );
  const query = q.trim().toLowerCase();
  const memberVisible = (m: FleetMember, stack: FleetStack) =>
    matchesFocus(m, focus) &&
    (!query || m.name.toLowerCase().includes(query) || m.image.toLowerCase().includes(query) || stack.name.toLowerCase().includes(query));

  const outdated = allMembers.filter((x) => x.m.hasUpdate);
  const unhealthy = allMembers.filter((x) => x.m.status === 'unhealthy');
  const selectedMembers = allMembers.filter((x) => selected.has(memberKey(x.m)));

  // ── actions ──────────────────────────────────────────────────────
  const withBusy = async (keys: string[], fn: () => Promise<void>, okMsg?: string) => {
    setBusy((b) => new Set([...b, ...keys])); setMsg(null); setErr(null);
    try { await fn(); if (okMsg) setMsg(okMsg); await load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Action failed.'); }
    finally { setBusy((b) => { const n = new Set(b); keys.forEach((k) => n.delete(k)); return n; }); }
  };
  const containerAction = (m: FleetMember, actionId: string) =>
    withBusy([memberKey(m)], () => api.post(`/api/connectors/instances/${m.instanceId}/resources/container/${encodeURIComponent(m.id)}/actions/${actionId}`, {}), `${actionId} ${m.name}`);
  const containerRecreate = (m: FleetMember) =>
    withBusy([memberKey(m)], () => api.post(`/api/connectors/instances/${m.instanceId}/operations/recreate-container`, { resourceId: m.id, values: { pullLatest: true, confirm: true } }), `Recreating ${m.name}…`);
  // Stack-level lifecycle (start/stop/restart the whole stack) — works on ANY stack, managed or not.
  const stackAction = (s: FleetStack, actionId: string) => {
    if (actionId === 'stop' && !confirm(`Stop all containers in stack "${s.name}"?`)) return;
    return withBusy(
      [`${s.instanceId}::${s.id}`],
      () => api.post(`/api/connectors/instances/${s.instanceId}/resources/stack/${encodeURIComponent(s.id)}/actions/${actionId}`, {}),
      `${actionId} ${s.name}`,
    );
  };
  // One-click "update the whole stack": pull the latest image + recreate every member.
  // Works on ANY stack (no compose needed) — the fit for externally-deployed stacks.
  const stackUpdate = (s: FleetStack) => {
    if (!s.members.length) return;
    if (!confirm(`Update all ${s.members.length} container${s.members.length === 1 ? '' : 's'} in "${s.name}"?\nPulls the latest image and recreates each.`)) return;
    const keys = s.members.map((m) => `${m.instanceId}::${m.id}`);
    return withBusy(keys, async () => {
      const res = await Promise.allSettled(
        s.members.map((m) => api.post(`/api/connectors/instances/${m.instanceId}/operations/recreate-container`, { resourceId: m.id, values: { pullLatest: true, confirm: true } })),
      );
      const failed = res.filter((r) => r.status === 'rejected').length;
      setMsg(`Updating "${s.name}": ${s.members.length - failed} started${failed ? `, ${failed} failed` : ''}.`);
    });
  };
  const openConsole = (m: FleetMember, mode: 'shell' | 'logs') =>
    navigate(`/connectors/${m.instanceId}/console/container/${encodeURIComponent(m.id)}?mode=${mode}`);

  async function bulk(items: { m: FleetMember }[], run: (m: FleetMember) => Promise<unknown>, label: string) {
    if (!items.length) return;
    if (!confirm(`${label} ${items.length} container${items.length === 1 ? '' : 's'} across the fleet?`)) return;
    const keys = items.map((x) => memberKey(x.m));
    await withBusy(keys, async () => {
      const res = await Promise.allSettled(items.map((x) => run(x.m)));
      const failed = res.filter((r) => r.status === 'rejected').length;
      setMsg(`${label}: ${items.length - failed} ok${failed ? `, ${failed} failed` : ''}.`);
    });
    setSelected(new Set());
  }

  if (!fleet && !err) return <div className="py-20 text-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin inline" /></div>;

  const t = fleet?.totals;
  const tiles: { key: Focus; label: string; value: number; tone?: 'warn' | 'bad' | 'good'; view?: 'stacks' }[] = [
    { key: null, label: 'Hosts', value: t ? t.online : 0 },
    { key: 'running', label: 'Running', value: t?.running ?? 0, tone: 'good' },
    { key: 'unhealthy', label: 'Unhealthy', value: t?.unhealthy ?? 0, tone: 'bad' },
    { key: 'stopped', label: 'Stopped', value: t?.stopped ?? 0 },
    { key: null, label: 'Stacks', value: t?.stacks ?? 0, view: 'stacks' },
    { key: 'updates', label: 'Updates', value: t?.updates ?? 0, tone: 'warn' },
    { key: null, label: 'Disk', value: t?.diskUsedGb ?? 0 },
  ];

  return (
    <>
      <PageHeader title="Docker Fleet" description="Every Docker host, stack, and container in one place."
        actions={
          <div className="flex items-center gap-2">
            {live && <span className="flex items-center gap-1.5 text-xs text-emerald-400"><span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />Live</span>}
            {loadedAt && <span className="text-xs text-muted-foreground hidden sm:inline">Updated {loadedAt.toLocaleTimeString()}</span>}
            <Button variant="outline" onClick={() => load(true)} disabled={refreshing}>
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} /> Refresh
            </Button>
          </div>
        } />

      {err && <div className="mb-4 text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">{err}</div>}
      {msg && <div className="mb-4 text-sm rounded-md px-3 py-2 border border-primary/30 bg-primary/10 text-foreground">{msg}</div>}

      {/* Summary strip */}
      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-2 mb-4">
        {tiles.map((tile, i) => {
          const active = (tile.key !== null && focus === tile.key) || (tile.view === 'stacks' && view === 'stacks' && !focus);
          const clickable = tile.key !== null || !!tile.view;
          const onTile = () => {
            if (tile.view) { setView(tile.view); setFocus(null); }
            else if (tile.key !== null) setFocus(active ? null : tile.key);
          };
          return (
            <button key={i} disabled={!clickable}
              onClick={onTile}
              className={cn('rounded-lg border px-3 py-2 text-left transition-colors',
                active ? 'border-primary bg-primary/10'
                  : clickable ? 'border-border bg-card hover:border-primary/40' : 'border-border bg-card',
                !clickable && 'cursor-default')}>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{tile.label}{tile.key === null && tile.label === 'Hosts' && t ? ` / ${t.hosts}` : ''}</p>
              <p className={cn('text-xl font-semibold tabular-nums',
                tile.tone === 'bad' && tile.value > 0 && 'text-destructive',
                tile.tone === 'warn' && tile.value > 0 && 'text-amber-400',
                tile.tone === 'good' && 'text-emerald-400')}>
                {tile.value}{tile.label === 'Disk' ? ' GB' : ''}
              </p>
            </button>
          );
        })}
      </div>

      {/* Control bar */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search containers, images, stacks…" value={q} onChange={(e) => setQ(e.target.value)} />
          {q && <button onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>}
        </div>
        <div className="inline-flex rounded-md border border-border overflow-hidden text-sm">
          {(['stacks', 'containers'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={cn('px-3 py-1.5 capitalize', view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>{v}</button>
          ))}
        </div>
        {focus && <Button variant="ghost" size="sm" onClick={() => setFocus(null)}>Clear filter: {focus} <X className="h-3.5 w-3.5" /></Button>}
      </div>

      {/* Fleet bulk actions */}
      {canAct && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <Button variant="outline" size="sm" disabled={!unhealthy.length} onClick={() => bulk(unhealthy, (m) => containerAction(m, 'restart'), 'Restart')}>
            <RotateCw className="h-4 w-4" /> Restart unhealthy ({unhealthy.length})
          </Button>
          <Button variant="outline" size="sm" disabled={!outdated.length} onClick={() => bulk(outdated, (m) => api.post(`/api/connectors/instances/${m.instanceId}/operations/recreate-container`, { resourceId: m.id, values: { pullLatest: true, confirm: true } }), 'Update')}>
            <ArrowUpCircle className="h-4 w-4 text-amber-400" /> Update outdated ({outdated.length})
          </Button>
          {selected.size > 0 && (
            <div className="flex items-center gap-1 ml-auto rounded-md border border-primary/40 bg-primary/5 px-2 py-1">
              <span className="text-xs text-muted-foreground mr-1">{selected.size} selected</span>
              <Button variant="ghost" size="sm" onClick={() => bulk(selectedMembers, (m) => containerAction(m, 'start'), 'Start')}><Play className="h-4 w-4" /></Button>
              <Button variant="ghost" size="sm" onClick={() => bulk(selectedMembers, (m) => containerAction(m, 'stop'), 'Stop')}><Square className="h-4 w-4" /></Button>
              <Button variant="ghost" size="sm" onClick={() => bulk(selectedMembers, (m) => containerAction(m, 'restart'), 'Restart')}><RotateCw className="h-4 w-4" /></Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}><X className="h-4 w-4" /></Button>
            </div>
          )}
        </div>
      )}

      {view === 'stacks'
        ? <StacksView fleet={fleet!} {...{ query, focus, memberVisible, collapsedHosts, setCollapsedHosts, expandedStacks, setExpandedStacks, selected, setSelected, busy, canAct, containerAction, containerRecreate, openOp, stackAction, stackUpdate, openConsole, memberKey }} />
        : <ContainersView members={allMembers.filter((x) => memberVisible(x.m, x.stack))} {...{ selected, setSelected, busy, canAct, containerAction, containerRecreate, openConsole, memberKey }} />}

      {activeOp && (
        <OperationDialog
          operation={activeOp.operation}
          instanceId={activeOp.instanceId}
          resourceId={activeOp.resourceId}
          seed={activeOp.seed}
          open={!!activeOp}
          onClose={() => setActiveOp(null)}
          onDone={() => { setActiveOp(null); load(true); }}
        />
      )}
    </>
  );
}

// ── Stacks (host accordion) ───────────────────────────────────────

function StacksView(p: {
  fleet: DockerFleet; query: string; focus: Focus;
  memberVisible: (m: FleetMember, s: FleetStack) => boolean;
  collapsedHosts: Set<string>; setCollapsedHosts: (s: Set<string>) => void;
  expandedStacks: Set<string>; setExpandedStacks: (s: Set<string>) => void;
  selected: Set<string>; setSelected: (s: Set<string>) => void; busy: Set<string>; canAct: boolean;
  containerAction: (m: FleetMember, a: string) => void; containerRecreate: (m: FleetMember) => void;
  openOp: (opId: string, instanceId: string, resourceId?: string, seed?: Record<string, unknown>) => void;
  stackAction: (s: FleetStack, actionId: string) => void; stackUpdate: (s: FleetStack) => void;
  openConsole: (m: FleetMember, mode: 'shell' | 'logs') => void;
  memberKey: (m: FleetMember) => string;
}) {
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); setter(n);
  };
  return (
    <div className="space-y-3">
      {p.fleet.hosts.map((h) => {
        const stacks = h.stacks
          .map((s) => ({ s, members: s.members.filter((m) => p.memberVisible(m, s)) }))
          .filter((x) => (p.query || p.focus) ? x.members.length > 0 : true);
        if ((p.query || p.focus) && stacks.length === 0) return null;
        const collapsed = p.collapsedHosts.has(h.instanceId);
        return (
          <Card key={h.instanceId}>
            <button onClick={() => toggle(p.collapsedHosts, p.setCollapsedHosts, h.instanceId)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left">
              {collapsed ? <ChevronRight className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
              <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="font-semibold">{h.name}</span>
              <span className={cn('h-2 w-2 rounded-full shrink-0', h.online ? 'bg-emerald-400' : 'bg-destructive')} title={h.online ? 'Online' : (h.error ?? 'Offline')} />
              <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground flex-wrap justify-end">
                {!h.online ? <span className="text-destructive">{h.error ?? 'offline'}</span> : <>
                  <span className="text-emerald-400">{h.metrics.running} up</span>
                  {h.metrics.unhealthy > 0 && <span className="text-destructive">{h.metrics.unhealthy} unhealthy</span>}
                  {h.metrics.stopped > 0 && <span>{h.metrics.stopped} stopped</span>}
                  {h.metrics.updates > 0 && <span className="text-amber-400">{h.metrics.updates} updates</span>}
                  <span className="opacity-50">·</span>
                  {h.metrics.hostLoadPct != null && <span>CPU {h.metrics.hostLoadPct}%</span>}
                  {h.metrics.hostMemUsedPct != null && <span>MEM {h.metrics.hostMemUsedPct}%</span>}
                  {h.metrics.hostRootDiskPct != null && <span>DISK {h.metrics.hostRootDiskPct}%</span>}
                </>}
              </div>
            </button>
            {!collapsed && (
              <CardContent className="pt-0 pb-2">
                {stacks.length === 0 ? <p className="text-sm text-muted-foreground py-3">No stacks.</p> : (
                  <div className="divide-y divide-border/50">
                    {stacks.map(({ s, members }) => {
                      const open = p.expandedStacks.has(`${h.instanceId}::${s.id}`);
                      return (
                        <div key={s.id} className="py-1">
                          <div className="flex items-center gap-2 py-1.5">
                            <button onClick={() => toggle(p.expandedStacks, p.setExpandedStacks, `${h.instanceId}::${s.id}`)} className="flex items-center gap-2 min-w-0 flex-1 text-left">
                              {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                              <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" />
                              <span className="font-medium truncate">{s.name}</span>
                              <span className={cn('text-[11px] rounded-full px-2 py-0.5 capitalize shrink-0', statusBadgeColor(s.status))}>{s.status}</span>
                              <span className="text-xs text-muted-foreground shrink-0">{s.running}/{s.containers}</span>
                              {s.updates > 0 && <span className="text-[11px] rounded-md border border-amber-500/50 bg-amber-500/15 text-amber-400 px-1.5 py-0.5 shrink-0">{s.updates} update{s.updates === 1 ? '' : 's'}</span>}
                            </button>
                            {p.canAct && (
                              <div className="flex items-center gap-0.5 shrink-0">
                                {/* Compose management — only for Cerebro-managed stacks (we hold their compose). */}
                                {s.managed && <>
                                  <IconBtn title="Edit & redeploy (compose)" onClick={() => p.openOp('edit-stack', s.instanceId, s.id)}><Pencil className="h-4 w-4" /></IconBtn>
                                  <IconBtn title="Redeploy (pull / recreate options)" onClick={() => p.openOp('redeploy-stack', s.instanceId, s.id)}><Rocket className="h-4 w-4" /></IconBtn>
                                  <IconBtn title="Roll back to previous" onClick={() => p.openOp('rollback-stack', s.instanceId, s.id)}><History className="h-4 w-4" /></IconBtn>
                                  <IconBtn title="Check drift" onClick={() => p.openOp('stack-check-drift', s.instanceId, s.id)}><GitCompare className="h-4 w-4" /></IconBtn>
                                </>}
                                {/* Unmanaged stacks: one-click update (pull+recreate every member) + import path. */}
                                {!s.managed && <>
                                  <IconBtn title="Update stack (pull latest image + recreate every container)" onClick={() => p.stackUpdate(s)}><ArrowUpCircle className={cn('h-4 w-4', s.updates > 0 && 'text-amber-400')} /></IconBtn>
                                  <IconBtn title="Import compose (paste it so Cerebro can edit/redeploy this stack)" onClick={() => p.openOp('deploy-stack', s.instanceId, undefined, { name: s.id })}><Rocket className="h-4 w-4" /></IconBtn>
                                </>}
                                {/* Whole-stack lifecycle — works on ANY stack (acts on its containers). */}
                                {STACK_STOPPED.has(s.status)
                                  ? <IconBtn title="Start stack" onClick={() => p.stackAction(s, 'start')}><Play className="h-4 w-4" /></IconBtn>
                                  : <>
                                    <IconBtn title="Restart stack" onClick={() => p.stackAction(s, 'restart')}><RotateCw className="h-4 w-4" /></IconBtn>
                                    <IconBtn title="Stop stack" onClick={() => p.stackAction(s, 'stop')}><Square className="h-4 w-4" /></IconBtn>
                                  </>}
                              </div>
                            )}
                          </div>
                          {open && (
                            <div className="ml-6 border-l border-border/50 pl-3 pb-1">
                              {members.map((m) => <MemberRow key={m.id} m={m} {...p} />)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ── Containers (flat table) ───────────────────────────────────────

function ContainersView(p: {
  members: { m: FleetMember; host: FleetHost; stack: FleetStack }[];
  selected: Set<string>; setSelected: (s: Set<string>) => void; busy: Set<string>; canAct: boolean;
  containerAction: (m: FleetMember, a: string) => void; containerRecreate: (m: FleetMember) => void;
  openConsole: (m: FleetMember, mode: 'shell' | 'logs') => void; memberKey: (m: FleetMember) => string;
}) {
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
            <tr>
              <th className="px-3 py-2 text-left w-8"></th>
              <th className="px-3 py-2 text-left">Container</th>
              <th className="px-3 py-2 text-left">Host</th>
              <th className="px-3 py-2 text-left">Stack</th>
              <th className="px-3 py-2 text-left">Image</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {p.members.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">No containers match.</td></tr>}
            {p.members.map(({ m, host, stack }) => (
              <tr key={p.memberKey(m)} className="hover:bg-muted/20">
                <td className="px-3 py-2">
                  {p.canAct && <input type="checkbox" checked={p.selected.has(p.memberKey(m))} onChange={() => {
                    const n = new Set(p.selected); const k = p.memberKey(m); n.has(k) ? n.delete(k) : n.add(k); p.setSelected(n);
                  }} />}
                </td>
                <td className="px-3 py-2 font-medium">{m.name}</td>
                <td className="px-3 py-2 text-muted-foreground">{host.name}</td>
                <td className="px-3 py-2 text-muted-foreground">{stack.name}</td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{m.image}{m.hasUpdate && <span className="ml-2 text-[11px] rounded-md border border-amber-500/50 bg-amber-500/15 text-amber-400 px-1.5 py-0.5">update</span>}</td>
                <td className="px-3 py-2"><span className={cn('text-[11px] rounded-full px-2 py-0.5 capitalize', statusBadgeColor(m.status))}>{m.status}</span></td>
                <td className="px-3 py-2"><div className="flex items-center justify-end gap-0.5"><MemberActions m={m} {...p} /></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Shared row bits ───────────────────────────────────────────────

function MemberRow(p: {
  m: FleetMember; selected: Set<string>; setSelected: (s: Set<string>) => void; busy: Set<string>; canAct: boolean;
  containerAction: (m: FleetMember, a: string) => void; containerRecreate: (m: FleetMember) => void;
  openConsole: (m: FleetMember, mode: 'shell' | 'logs') => void; memberKey: (m: FleetMember) => string;
}) {
  const { m } = p; const k = p.memberKey(m);
  return (
    <div className="flex items-center gap-2 py-1">
      {p.canAct && <input type="checkbox" className="shrink-0" checked={p.selected.has(k)} onChange={() => {
        const n = new Set(p.selected); n.has(k) ? n.delete(k) : n.add(k); p.setSelected(n);
      }} />}
      <span className={cn('h-2 w-2 rounded-full shrink-0', statusDot(m.status))} title={m.status} />
      <span className="text-sm truncate">{m.service || m.name}</span>
      <span className="font-mono text-xs text-muted-foreground truncate hidden sm:inline">{m.image}</span>
      {m.hasUpdate && <span className="text-[11px] rounded-md border border-amber-500/50 bg-amber-500/15 text-amber-400 px-1.5 py-0.5 shrink-0">update</span>}
      <div className="ml-auto flex items-center gap-0.5 shrink-0"><MemberActions {...p} /></div>
    </div>
  );
}

function MemberActions(p: {
  m: FleetMember; busy: Set<string>; canAct: boolean;
  containerAction: (m: FleetMember, a: string) => void; containerRecreate: (m: FleetMember) => void;
  openConsole: (m: FleetMember, mode: 'shell' | 'logs') => void; memberKey: (m: FleetMember) => string;
}) {
  const { m } = p;
  if (!p.canAct) return null;
  const isBusy = p.busy.has(p.memberKey(m));
  if (isBusy) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  const running = RUNNING_LIKE.has(m.status);
  return (
    <>
      {running
        ? <IconBtn title="Stop" onClick={() => p.containerAction(m, 'stop')}><Square className="h-4 w-4" /></IconBtn>
        : <IconBtn title="Start" onClick={() => p.containerAction(m, 'start')}><Play className="h-4 w-4" /></IconBtn>}
      <IconBtn title="Restart" onClick={() => p.containerAction(m, 'restart')}><RotateCw className="h-4 w-4" /></IconBtn>
      <IconBtn title={m.hasUpdate ? 'Recreate (pull latest)' : 'Recreate'} onClick={() => p.containerRecreate(m)}>
        <ArrowUpCircle className={cn('h-4 w-4', m.hasUpdate && 'text-amber-400')} />
      </IconBtn>
      <IconBtn title="Shell" onClick={() => p.openConsole(m, 'shell')}><Terminal className="h-4 w-4" /></IconBtn>
      <IconBtn title="Logs" onClick={() => p.openConsole(m, 'logs')}><ScrollText className="h-4 w-4" /></IconBtn>
    </>
  );
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick}
      className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
      {children}
    </button>
  );
}

function statusDot(status: string): string {
  if (status === 'unhealthy' || STOPPED_LIKE.has(status)) return status === 'unhealthy' ? 'bg-destructive' : 'bg-muted-foreground';
  if (status === 'running') return 'bg-emerald-400';
  return 'bg-amber-400';
}
