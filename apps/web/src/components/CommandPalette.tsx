import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Puzzle, Ship, Video, Activity, Users, History, Zap, ScrollText,
  Settings, Info, Search, CornerDownLeft, ChevronRight, ChevronLeft, Plus, DatabaseBackup,
  LogOut, Lock, KeyRound, Bell, Mail, ShieldCheck, Boxes, Play,
} from 'lucide-react';
import type { Permission, ConnectorInstanceSummary, MonitorSummary, SearchHit, ConnectorManifest } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { cn } from '@/lib/utils';

type Icon = React.ComponentType<{ className?: string }>;
type Track = { label: string; sublabel?: string; to: string };

interface Command {
  id: string;
  group: string;
  label: string;
  sublabel?: string;
  icon: Icon;
  perm?: Permission;
  danger?: boolean;
  run: () => void | Promise<void>;
  /** If set, ArrowRight/→ drills into this resource's actions (Phase 3). */
  drill?: SearchHit;
  /** If set, running this is remembered in "Recent". */
  track?: Track;
}

const RECENTS_KEY = 'cerebro.palette.recents';

function loadRecents(): Track[] {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]'); } catch { return []; }
}
function pushRecent(t: Track) {
  try {
    const list = loadRecents().filter((x) => x.to !== t.to);
    list.unshift(t);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 6)));
  } catch { /* ignore */ }
}

/** Subsequence fuzzy score: lower = better; null = no match. Rewards contiguous + early hits. */
function score(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let ti = 0, penalty = 0, lastHit = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found === -1) return null;
    if (lastHit !== -1) penalty += (found - lastHit - 1);
    if (qi === 0) penalty += found;
    lastHit = found;
    ti = found + 1;
  }
  return penalty;
}

type Mode = { type: 'root' } | { type: 'actions'; hit: SearchHit; commands: Command[] };

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { can, logout } = useAuth();
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [connectors, setConnectors] = useState<ConnectorInstanceSummary[]>([]);
  const [monitors, setMonitors] = useState<MonitorSummary[]>([]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [mode, setMode] = useState<Mode>({ type: 'root' });
  const [error, setError] = useState<string | null>(null);
  const manifestCache = useRef<Record<string, ConnectorManifest>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery(''); setSel(0); setMode({ type: 'root' }); setError(null); setHits([]);
    setTimeout(() => inputRef.current?.focus(), 0);
    if (can('connectors:read') && connectors.length === 0) api.get<ConnectorInstanceSummary[]>('/api/connectors/instances').then(setConnectors).catch(() => {});
    if (can('monitors:read') && monitors.length === 0) api.get<MonitorSummary[]>('/api/monitors').then(setMonitors).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Phase 2: debounced cross-connector resource search (server-side cached index).
  useEffect(() => {
    if (!open || mode.type !== 'root' || !can('connectors:read') || query.trim().length < 2) { setHits([]); return; }
    const q = query.trim();
    const t = setTimeout(() => {
      api.get<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}&limit=20`).then((r) => { if (query.trim() === q) setHits(r); }).catch(() => {});
    }, 160);
    return () => clearTimeout(t);
  }, [query, open, mode.type, can]);

  const go = useCallback((to: string) => { onClose(); navigate(to); }, [navigate, onClose]);

  const manifestFor = useCallback(async (connectorId: string): Promise<ConnectorManifest | null> => {
    if (manifestCache.current[connectorId]) return manifestCache.current[connectorId];
    const m = await api.get<ConnectorManifest>(`/api/connectors/available/${connectorId}`).catch(() => null);
    if (m) manifestCache.current[connectorId] = m;
    return m;
  }, []);

  // Drill into a resource's runnable actions (Phase 3).
  const drillInto = useCallback(async (hit: SearchHit) => {
    const m = await manifestFor(hit.connectorId);
    const kind = m?.resourceKinds.find((k) => k.id === hit.kind);
    const actions = (kind?.actions ?? []).filter((a) => !a.showWhenStatus || (hit.status && a.showWhenStatus.includes(hit.status)));
    const to = `/connectors/${hit.instanceId}?kind=${encodeURIComponent(hit.kind)}&resource=${encodeURIComponent(hit.id)}`;
    const cmds: Command[] = [
      { id: 'open', group: hit.name, label: `Open ${hit.name}`, sublabel: hit.kindLabel, icon: Boxes, run: () => go(to), track: { label: hit.name, sublabel: `${hit.kindLabel} · ${hit.instanceName}`, to } },
      ...actions.map((a): Command => ({
        id: `act-${a.id}`, group: hit.name, label: a.label, sublabel: hit.name, icon: Play, danger: a.intent === 'destructive',
        run: () => runAction(hit, a.id, a.confirm),
      })),
    ];
    setQuery(''); setSel(0);
    setMode({ type: 'actions', hit, commands: cmds });
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [manifestFor, go]); // eslint-disable-line react-hooks/exhaustive-deps

  const runAction = useCallback(async (hit: SearchHit, actionId: string, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(`${confirmMsg}\n\nTarget: ${hit.name}`)) return;
    setError(null);
    try {
      const r = await api.post<{ ok: boolean; message: string }>(
        `/api/connectors/instances/${hit.instanceId}/resources/${hit.kind}/${encodeURIComponent(hit.id)}/actions/${actionId}`, {},
      );
      if (!r.ok) { setError(r.message || 'Action failed.'); return; }
      onClose();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Action failed.'); }
  }, [onClose]);

  // ── Build the root command list ──────────────────────────────────
  const rootCommands = useMemo<Command[]>(() => {
    const nav: Command[] = [
      { id: 'nav-dashboard', group: 'Go to', label: 'Dashboard', icon: LayoutDashboard, run: () => go('/'), track: { label: 'Dashboard', to: '/' } },
      { id: 'nav-connectors', group: 'Go to', label: 'Connectors', icon: Puzzle, perm: 'connectors:read', run: () => go('/connectors'), track: { label: 'Connectors', to: '/connectors' } },
      { id: 'nav-fleet', group: 'Go to', label: 'Docker Fleet', icon: Ship, perm: 'connectors:read', run: () => go('/docker-fleet'), track: { label: 'Docker Fleet', to: '/docker-fleet' } },
      { id: 'nav-viewscreen', group: 'Go to', label: 'Viewscreen', icon: Video, perm: 'connectors:read', run: () => go('/viewscreen'), track: { label: 'Viewscreen', to: '/viewscreen' } },
      { id: 'nav-monitors', group: 'Go to', label: 'Monitors', icon: Activity, perm: 'monitors:read', run: () => go('/monitors'), track: { label: 'Monitors', to: '/monitors' } },
      { id: 'nav-automations', group: 'Go to', label: 'Automations', icon: Zap, perm: 'automations:read', run: () => go('/automations'), track: { label: 'Automations', to: '/automations' } },
      { id: 'nav-timeline', group: 'Go to', label: "Ship's Log", icon: History, perm: 'logs:read', run: () => go('/timeline'), track: { label: "Ship's Log", to: '/timeline' } },
      { id: 'nav-logs', group: 'Go to', label: 'Logs', icon: ScrollText, perm: 'logs:read', run: () => go('/logs'), track: { label: 'Logs', to: '/logs' } },
      { id: 'nav-users', group: 'Go to', label: 'Users', icon: Users, perm: 'users:read', run: () => go('/users'), track: { label: 'Users', to: '/users' } },
      { id: 'nav-settings', group: 'Go to', label: 'Settings', icon: Settings, perm: 'settings:read', run: () => go('/settings'), track: { label: 'Settings', to: '/settings' } },
      { id: 'nav-about', group: 'Go to', label: 'About', icon: Info, run: () => go('/about'), track: { label: 'About', to: '/about' } },
      { id: 'nav-auth', group: 'Go to', label: 'Authentication', sublabel: 'Settings', icon: ShieldCheck, perm: 'settings:read', run: () => go('/settings/authentication') },
      { id: 'nav-email', group: 'Go to', label: 'Email', sublabel: 'Settings', icon: Mail, perm: 'settings:read', run: () => go('/settings/email') },
      { id: 'nav-notifs', group: 'Go to', label: 'Notifications', sublabel: 'Settings', icon: Bell, perm: 'settings:read', run: () => go('/settings/notifications') },
      { id: 'nav-secrets', group: 'Go to', label: 'Secrets Vault', sublabel: 'Settings', icon: Lock, perm: 'secrets:read', run: () => go('/settings/secrets') },
      { id: 'nav-tokens', group: 'Go to', label: 'API Tokens', sublabel: 'Settings', icon: KeyRound, perm: 'settings:read', run: () => go('/settings/api-tokens') },
    ];
    const actions: Command[] = [
      { id: 'act-new-connector', group: 'Actions', label: 'Add a connector', icon: Plus, perm: 'connectors:write', run: () => go('/connectors') },
      { id: 'act-new-monitor', group: 'Actions', label: 'New monitor', icon: Plus, perm: 'monitors:write', run: () => go('/monitors/new') },
      { id: 'act-new-automation', group: 'Actions', label: 'New automation', icon: Zap, perm: 'automations:write', run: () => go('/automations') },
      { id: 'act-backup', group: 'Actions', label: 'Backup & Restore', icon: DatabaseBackup, perm: 'settings:write', run: () => go('/settings/backup') },
      { id: 'act-logout', group: 'Actions', label: 'Log out', icon: LogOut, run: () => { onClose(); void logout(); } },
    ];
    const conn: Command[] = connectors.map((c) => ({
      id: `conn-${c.id}`, group: 'Connectors', label: c.name, sublabel: c.connectorId, icon: Puzzle, perm: 'connectors:read' as Permission,
      run: () => go(`/connectors/${c.id}`), track: { label: c.name, sublabel: c.connectorId, to: `/connectors/${c.id}` },
    }));
    const mon: Command[] = monitors.map((m) => ({
      id: `mon-${m.id}`, group: 'Monitors', label: m.name, sublabel: m.status, icon: Activity, perm: 'monitors:read' as Permission,
      run: () => go(`/monitors/${m.id}`), track: { label: m.name, sublabel: 'Monitor', to: `/monitors/${m.id}` },
    }));
    return [...nav, ...actions, ...conn, ...mon].filter((c) => !c.perm || can(c.perm));
  }, [connectors, monitors, can, go, logout, onClose]);

  // Resource hits → drill-able commands.
  const resourceCommands = useMemo<Command[]>(() => hits.map((h) => ({
    id: `res-${h.instanceId}-${h.kind}-${h.id}`, group: 'Resources', label: h.name, sublabel: `${h.kindLabel} · ${h.instanceName}`,
    icon: Boxes, drill: h,
    run: () => { const to = `/connectors/${h.instanceId}?kind=${encodeURIComponent(h.kind)}&resource=${encodeURIComponent(h.id)}`; pushRecent({ label: h.name, sublabel: `${h.kindLabel} · ${h.instanceName}`, to }); go(to); },
  })), [hits, go]);

  const recentCommands = useMemo<Command[]>(() => {
    if (query.trim()) return [];
    return loadRecents().map((t, i): Command => ({ id: `recent-${i}`, group: 'Recent', label: t.label, sublabel: t.sublabel, icon: History, run: () => go(t.to) }));
  }, [query, go, open]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Compose + rank the visible list ──────────────────────────────
  const results = useMemo<Command[]>(() => {
    if (mode.type === 'actions') {
      const list = mode.commands;
      if (!query.trim()) return list;
      return list.map((c) => ({ c, s: score(query, c.label) })).filter((x): x is { c: Command; s: number } => x.s !== null).sort((a, b) => a.s - b.s).map((x) => x.c);
    }
    const client = rootCommands
      .map((c) => ({ c, s: score(query, c.label + ' ' + (c.sublabel ?? '')) }))
      .filter((x): x is { c: Command; s: number } => x.s !== null)
      .sort((a, b) => a.s - b.s || a.c.label.localeCompare(b.c.label))
      .map((x) => x.c);
    return [...recentCommands, ...client, ...resourceCommands]; // resources already server-ranked
  }, [mode, query, rootCommands, resourceCommands, recentCommands]);

  useEffect(() => { setSel(0); }, [query, mode.type]);
  useEffect(() => { if (sel >= results.length) setSel(Math.max(0, results.length - 1)); }, [results.length, sel]);
  useEffect(() => { listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  if (!open) return null;

  const execute = (c: Command) => { if (c.track) pushRecent(c.track); void c.run(); };

  const groups: { name: string; items: { c: Command; idx: number }[] }[] = [];
  results.forEach((c, idx) => {
    let g = groups.find((x) => x.name === c.group);
    if (!g) { g = { name: c.group, items: [] }; groups.push(g); }
    g.items.push({ c, idx });
  });

  const back = () => { setMode({ type: 'root' }); setQuery(''); setError(null); setTimeout(() => inputRef.current?.focus(), 0); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(results.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = results[sel]; if (c) execute(c); }
    else if (e.key === 'ArrowRight') { const c = results[sel]; if (c?.drill) { e.preventDefault(); void drillInto(c.drill); } }
    else if (e.key === 'ArrowLeft' || (e.key === 'Backspace' && !query)) { if (mode.type === 'actions') { e.preventDefault(); back(); } }
    else if (e.key === 'Escape') { e.preventDefault(); if (mode.type === 'actions') back(); else onClose(); }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] px-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 animate-fade-in" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-xl rounded-xl border border-border bg-card shadow-2xl animate-fade-in overflow-hidden">
        {/* LCARS "Computer" header */}
        <div className="flex items-center gap-2 px-3 border-b border-border/60">
          {mode.type === 'actions'
            ? <button onClick={back} className="shrink-0 text-muted-foreground hover:text-foreground" title="Back"><ChevronLeft className="h-4 w-4" /></button>
            : <Search className="h-4 w-4 text-muted-foreground shrink-0" />}
          <span className="hidden sm:inline text-[10px] font-lcars tracking-[0.2em] text-primary/80 shrink-0">
            {mode.type === 'actions' ? mode.hit.name.toUpperCase().slice(0, 18) : 'COMPUTER'}
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder={mode.type === 'actions' ? 'Run an action…' : 'Search pages, connectors, resources, actions…'}
            className="flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
            spellCheck={false} autoComplete="off"
          />
          <kbd className="hidden sm:block text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5">ESC</kbd>
        </div>

        {error && <div className="px-3 py-2 text-xs border-b border-destructive/30 bg-destructive/10 text-destructive">{error}</div>}

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-2">
          {results.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">{query.trim().length >= 2 ? 'No matches.' : 'Type to search…'}</p>
          ) : (
            groups.map((g) => (
              <div key={g.name} className="mb-1">
                <p className="px-3 pt-1 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">{g.name}</p>
                {g.items.map(({ c, idx }) => (
                  <button
                    key={c.id}
                    data-idx={idx}
                    onMouseMove={() => setSel(idx)}
                    onClick={() => execute(c)}
                    className={cn('w-full flex items-center gap-3 px-3 py-2 text-left text-sm', idx === sel ? 'bg-primary/15 text-foreground' : 'text-foreground/90 hover:bg-muted/40')}
                  >
                    <c.icon className={cn('h-4 w-4 shrink-0', c.danger ? 'text-destructive' : idx === sel ? 'text-primary' : 'text-muted-foreground')} />
                    <span className={cn('truncate', c.danger && 'text-destructive')}>{c.label}</span>
                    {c.sublabel && <span className="ml-auto text-xs text-muted-foreground truncate max-w-[45%]">{c.sublabel}</span>}
                    {idx === sel && (c.drill
                      ? <span className="shrink-0 ml-2 flex items-center gap-1 text-[10px] text-muted-foreground">actions <ChevronRight className="h-3.5 w-3.5" /></span>
                      : <CornerDownLeft className="h-3.5 w-3.5 text-muted-foreground shrink-0 ml-2" />)}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
