import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Radio, Plus, Trash2, ShieldOff, Loader2, Copy, Check, Terminal, MonitorSmartphone,
  Server, CircleDot, TerminalSquare, X, KeyRound, Monitor, Film, Play, Pause,
  FolderOpen, Folder, File as FileIcon, FileSymlink, ArrowUp, Upload, Download, FolderPlus, Pencil, RefreshCw,
  ShieldCheck, Search, Network, Tag as TagIcon,
} from 'lucide-react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import Guacamole from 'guacamole-common-js';
import RFB from '@novnc/novnc';
import type {
  FabricAgentDto, FabricEnrollmentDto, FabricAgentStatus, FabricProbeResult, FabricTargetDto,
  FabricSshConnectInput, FabricRdpConnectInput, FabricVncConnectInput, FabricSessionTicket,
  FabricVncSessionTicket, FabricSessionDto, FabricSftpListing, FabricSftpOpenResult, FabricSftpEntry,
} from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';

const selectCls = 'mt-1 w-full h-9 rounded-md border border-input bg-background/60 px-2 text-sm';

const STATUS: Record<FabricAgentStatus, { label: string; cls: string }> = {
  online: { label: 'Online', cls: 'text-emerald-400' },
  offline: { label: 'Offline', cls: 'text-muted-foreground' },
  pending: { label: 'Awaiting enrollment', cls: 'text-amber-400' },
  revoked: { label: 'Revoked', cls: 'text-destructive' },
};

// OS grouping: friendly labels + a colored pill, and a stable section order.
type OsKey = 'windows' | 'linux' | 'darwin' | 'other';
const OS_ORDER: OsKey[] = ['windows', 'linux', 'darwin', 'other'];
const OS_META: Record<OsKey, { label: string; cls: string }> = {
  windows: { label: 'Windows', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  linux: { label: 'Linux', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  darwin: { label: 'macOS', cls: 'bg-zinc-400/15 text-zinc-200 border-zinc-400/30' },
  other: { label: 'Other / pending', cls: 'bg-muted text-muted-foreground border-border' },
};
function osKey(os?: string | null): OsKey {
  const v = (os || '').toLowerCase();
  if (v.includes('win')) return 'windows';
  if (v.includes('darwin') || v.includes('mac')) return 'darwin';
  if (v.includes('linux')) return 'linux';
  return 'other';
}
/** Friendly OS label for display (darwin → macOS). */
function osLabel(os?: string | null, osVersion?: string | null): string {
  if (!os && !osVersion) return '—';
  const base = OS_META[osKey(os)].label;
  return osVersion ? `${base} · ${osVersion}` : base;
}

/** Version-agnostic uninstall one-liner for a machine's OS. */
function uninstallCmd(os?: string | null): string {
  const origin = location.origin;
  return os === 'windows'
    ? `iwr ${origin}/api/fabric/uninstall.ps1 -UseBasicParsing | iex`
    : `curl -fsSL ${origin}/api/fabric/uninstall.sh | sudo sh`;
}

/** Per-target remembered RDP options (this browser). */
interface RdpPrefs {
  resolution?: string;
  colorDepth?: string;
  security?: string;
  consoleSession?: boolean;
  enableEffects?: boolean;
  enableAudio?: boolean;
}
function loadRdpPrefs(targetId: string): RdpPrefs {
  try {
    return JSON.parse(localStorage.getItem(`fabric.rdp.${targetId}`) || '{}') as RdpPrefs;
  } catch {
    return {};
  }
}
function saveRdpPrefs(targetId: string, prefs: RdpPrefs): void {
  try {
    localStorage.setItem(`fabric.rdp.${targetId}`, JSON.stringify(prefs));
  } catch {
    /* storage blocked */
  }
}

/** Whether new sessions open in a new browser tab (default) vs. an in-page overlay. */
const NEWTAB_PREF = 'fabric.openInNewTab';
function prefNewTab(): boolean {
  try {
    return localStorage.getItem(NEWTAB_PREF) !== '0';
  } catch {
    return true;
  }
}
function setPrefNewTab(v: boolean): void {
  try {
    localStorage.setItem(NEWTAB_PREF, v ? '1' : '0');
  } catch {
    /* storage blocked */
  }
}

function relTime(iso?: string | null): string {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8 shrink-0"
      title="Copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {done ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
    </Button>
  );
}

export function Fabric() {
  const { can } = useAuth();
  const canManage = can('fabric:manage');
  const canConnect = can('fabric:connect');

  const [agents, setAgents] = useState<FabricAgentDto[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showCli, setShowCli] = useState(false);
  const [showCa, setShowCa] = useState(false);
  const [showRecordings, setShowRecordings] = useState(false);
  const [enrollment, setEnrollment] = useState<FabricEnrollmentDto | null>(null);
  const [probe, setProbe] = useState<Record<string, { loading?: boolean; result?: FabricProbeResult }>>({});
  const [deletedHint, setDeletedHint] = useState<{ name: string; os?: string | null } | null>(null);
  const [connectFor, setConnectFor] = useState<{ agent: FabricAgentDto; target: FabricTargetDto } | null>(null);
  const [filesFor, setFilesFor] = useState<{ agent: FabricAgentDto; target: FabricTargetDto } | null>(null);
  const [editing, setEditing] = useState<FabricAgentDto | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline'>('all');
  const [session, setSession] = useState<{ ticket: FabricSessionTicket; title: string } | null>(null);
  const [rdpSession, setRdpSession] = useState<{ ticket: FabricSessionTicket; title: string; dynamicResize: boolean } | null>(null);
  const [vncSession, setVncSession] = useState<{ ticket: FabricSessionTicket; title: string; creds?: { username?: string; password?: string } } | null>(null);

  /**
   * Launch a session either in a new tab (default) or an in-page overlay. `win`
   * is a blank tab already opened during the user gesture (to dodge popup
   * blockers); we hand it the ticket via localStorage and point it at the
   * session route. Null `win` (blocked or preference off) → overlay.
   */
  const launchViewer = (
    kind: 'ssh' | 'rdp' | 'vnc',
    ticket: FabricSessionTicket,
    title: string,
    win: Window | null,
    extra?: { dynamicResize?: boolean; vncCreds?: { username?: string; password?: string } },
  ) => {
    if (win) {
      const key = `fabric.session.${Math.random().toString(36).slice(2)}`;
      try {
        localStorage.setItem(
          key,
          JSON.stringify({ kind, ticket, title, dynamicResize: extra?.dynamicResize, vncCreds: extra?.vncCreds }),
        );
      } catch {
        /* storage blocked — fall through to overlay */
      }
      win.location.href = `${location.origin}/fabric/session?k=${encodeURIComponent(key)}`;
      return;
    }
    if (kind === 'ssh') setSession({ ticket, title });
    else if (kind === 'rdp') setRdpSession({ ticket, title, dynamicResize: !!extra?.dynamicResize });
    else setVncSession({ ticket, title, creds: extra?.vncCreds });
  };

  const openConnect = (agent: FabricAgentDto, t: FabricTargetDto) => {
    // SSH, RDP and VNC all open the credential dialog (VNC can now use a vault
    // credential instead of prompting in-browser every time).
    setConnectFor({ agent, target: t });
  };

  const runProbe = async (agentId: string, t: FabricTargetDto) => {
    setProbe((p) => ({ ...p, [t.id]: { loading: true } }));
    try {
      const r = await api.post<FabricProbeResult>(`/api/fabric/agents/${agentId}/targets/${t.id}/probe`);
      setProbe((p) => ({ ...p, [t.id]: { result: r } }));
    } catch (e) {
      setProbe((p) => ({
        ...p,
        [t.id]: { result: { ok: false, error: e instanceof ApiError ? e.message : 'Probe failed.' } },
      }));
    }
  };

  const load = async () => {
    try {
      setAgents(await api.get<FabricAgentDto[]>('/api/fabric/agents'));
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load agents.');
    }
  };

  const [pollMs, setPollMs] = useState(10_000);
  useEffect(() => {
    // Poll cadence is operator-tunable (FABRIC_POLL_MS); fetch it once, fall back to 10s.
    api
      .get<{ pollMs: number }>('/api/fabric/config')
      .then((c) => c.pollMs > 0 && setPollMs(c.pollMs))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    // No live push yet — poll to reflect online/offline transitions.
    const id = setInterval(load, pollMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollMs]);

  const revoke = async (a: FabricAgentDto) => {
    if (!confirm(`Revoke "${a.name}"? Its credential is destroyed and it can no longer connect.`)) return;
    try {
      await api.post(`/api/fabric/agents/${a.id}/revoke`);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Revoke failed.');
    }
  };

  const trustCa = async (a: FabricAgentDto) => {
    if (!confirm(`Install the Cerebro SSH CA trust on "${a.name}"? The agent edits sshd_config (validated before reload).`)) return;
    try {
      await api.post(`/api/fabric/agents/${a.id}/trust-ca`);
      setErr(null);
      // The agent installs + validates, then reports back; refresh to catch the green shield.
      setTimeout(load, 2500);
      setTimeout(load, 6000);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to request CA trust.');
    }
  };

  const saveAgent = async (id: string, input: { name?: string; tags?: string[]; notes?: string | null }) => {
    const updated = await api.patch<FabricAgentDto>(`/api/fabric/agents/${id}`, input);
    setAgents((prev) => (prev ? prev.map((a) => (a.id === id ? updated : a)) : prev));
  };

  const remove = async (a: FabricAgentDto) => {
    if (!confirm(`Delete "${a.name}" and its history? This cannot be undone.`)) return;
    try {
      await api.delete(`/api/fabric/agents/${a.id}`);
      // An online v0.3.0+ agent self-uninstalls; anything else needs manual cleanup.
      setDeletedHint({ name: a.name, os: a.os });
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Delete failed.');
    }
  };

  // Filter (search + status) then group by OS in a stable order, online first.
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const by: Record<OsKey, FabricAgentDto[]> = { windows: [], linux: [], darwin: [], other: [] };
    for (const a of agents ?? []) {
      if (statusFilter === 'online' && a.status !== 'online') continue;
      if (statusFilter === 'offline' && a.status === 'online') continue;
      if (q) {
        const hay = [a.name, a.hostname, a.localIp, a.os, a.osVersion, a.notes, ...a.tags]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) continue;
      }
      by[osKey(a.os)].push(a);
    }
    for (const k of OS_ORDER) {
      by[k].sort((x, y) => (x.status === 'online' ? 0 : 1) - (y.status === 'online' ? 0 : 1) || x.name.localeCompare(y.name));
    }
    return by;
  }, [agents, search, statusFilter]);
  const totalShown = OS_ORDER.reduce((n, k) => n + groups[k].length, 0);

  const renderAgentCard = (a: FabricAgentDto) => {
    const st = STATUS[a.status];
    const ssh = a.targets.find((t) => t.kind === 'ssh');
    const online = a.status === 'online';
    return (
      <Card key={a.id} className="overflow-hidden">
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[0.65rem] font-medium ${OS_META[osKey(a.os)].cls}`}>
                  {OS_META[osKey(a.os)].label}
                </span>
                <span className="font-semibold text-sm truncate">{a.name}</span>
              </div>
              <div className={`flex items-center gap-1.5 text-xs mt-1 ${st.cls}`}>
                <CircleDot className="h-3.5 w-3.5" /> {st.label}
                {a.lastSeenAt && (
                  <span className="text-muted-foreground">· {online ? relTime(a.lastSeenAt) : `seen ${relTime(a.lastSeenAt)}`}</span>
                )}
              </div>
            </div>
            {canManage && (
              <div className="flex items-center gap-0.5 shrink-0">
                <Button variant="ghost" size="icon" className="h-8 w-8" title="Edit name, tags & notes" onClick={() => setEditing(a)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost" size="icon" className="h-8 w-8"
                  disabled={!online}
                  title={a.caTrusted ? 'SSH CA trust installed & validated — click to re-install' : online ? 'Install SSH CA trust on this host' : 'Agent offline — CA trust not installed'}
                  onClick={() => trustCa(a)}
                >
                  <ShieldCheck className={`h-4 w-4 ${a.caTrusted ? 'text-emerald-400' : ''}`} />
                </Button>
                {a.status !== 'revoked' && (
                  <Button variant="ghost" size="icon" className="h-8 w-8" title="Revoke" onClick={() => revoke(a)}>
                    <ShieldOff className="h-4 w-4" />
                  </Button>
                )}
                <Button variant="ghost" size="icon" className="h-8 w-8" title="Delete" onClick={() => remove(a)}>
                  <Trash2 className="h-4 w-4 text-destructive/80" />
                </Button>
              </div>
            )}
          </div>

          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {a.hostname && (<><dt className="text-muted-foreground">Host</dt><dd className="truncate text-foreground/80">{a.hostname}</dd></>)}
            {a.localIp && (
              <><dt className="text-muted-foreground inline-flex items-center gap-1"><Network className="h-3 w-3" /> IP</dt>
                <dd className="text-foreground/80 font-mono">{a.localIp}</dd></>
            )}
            <dt className="text-muted-foreground">OS</dt><dd className="truncate text-foreground/80">{osLabel(a.os, a.osVersion)}</dd>
            {a.agentVersion && (<><dt className="text-muted-foreground">Agent</dt><dd className="text-foreground/80">v{a.agentVersion}</dd></>)}
          </dl>

          {a.targets.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <div className="flex flex-wrap gap-1.5">
                {a.targets.map((t) => {
                  const pr = probe[t.id];
                  const clickable = online && canConnect;
                  return (
                    <span key={t.id} className="inline-flex items-center rounded-full border border-border/60 bg-muted/40 overflow-hidden">
                      <button
                        type="button" disabled={!clickable || pr?.loading}
                        onClick={clickable ? () => runProbe(a.id, t) : undefined}
                        title={clickable ? 'Test tunnel' : undefined}
                        className={`inline-flex items-center gap-1 px-2 py-1 text-[0.7rem] ${clickable ? 'hover:bg-muted cursor-pointer' : 'cursor-default'}`}
                      >
                        {pr?.loading ? <Loader2 className="h-3 w-3 animate-spin" /> : t.kind === 'rdp' ? <MonitorSmartphone className="h-3 w-3" /> : t.kind === 'vnc' ? <Monitor className="h-3 w-3" /> : <Terminal className="h-3 w-3" />}
                        {t.kind.toUpperCase()} :{t.port}
                      </button>
                      {canConnect && (
                        <button
                          type="button" disabled={!online}
                          onClick={online ? () => openConnect(a, t) : undefined}
                          title={online ? `Open ${t.kind.toUpperCase()} session${t.hasCredential ? ' (vault credential saved)' : ''}` : 'Agent offline'}
                          className={`inline-flex items-center gap-1 px-2 py-1 border-l border-border/60 ${online ? 'hover:bg-primary/20 cursor-pointer text-primary' : 'opacity-40 cursor-default'}`}
                        >
                          <TerminalSquare className="h-3 w-3" />
                          {t.hasCredential && <KeyRound className="h-2.5 w-2.5 opacity-70" />}
                        </button>
                      )}
                    </span>
                  );
                })}
                {canConnect && ssh && (
                  <button
                    type="button" disabled={!online}
                    onClick={online ? () => setFilesFor({ agent: a, target: ssh }) : undefined}
                    title={online ? 'Browse & transfer files over SFTP' : 'Agent offline'}
                    className={`inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-1 text-[0.7rem] ${online ? 'hover:bg-muted cursor-pointer' : 'opacity-40 cursor-default'}`}
                  >
                    <FolderOpen className="h-3 w-3" /> Files
                  </button>
                )}
              </div>
              {a.targets.map((t) => {
                const r = probe[t.id]?.result;
                if (!r) return null;
                return (
                  <p key={t.id} className={`text-[0.7rem] ${r.ok ? 'text-emerald-400' : 'text-destructive'}`}>
                    {t.kind.toUpperCase()} :{t.port} —{' '}
                    {r.ok ? `reachable${r.latencyMs != null ? ` (${r.latencyMs}ms)` : ''}${r.banner ? ` · ${r.banner}` : ''}` : r.error || 'unreachable'}
                  </p>
                );
              })}
            </div>
          )}

          {a.notes && <p className="mt-2 text-xs text-muted-foreground italic border-l-2 border-border/60 pl-2">{a.notes}</p>}

          {a.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {a.tags.map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1 rounded bg-secondary/20 px-1.5 py-0.5 text-[0.65rem] text-secondary-foreground/80">
                  <TagIcon className="h-2.5 w-2.5 opacity-70" />{tag}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div>
      <PageHeader
        title="Fabric"
        description="Agent-brokered remote access. Machines dial out to Cerebro — no inbound RDP/SSH exposure."
        actions={
          <>
            <Button variant="outline" onClick={() => setShowRecordings(true)}>
              <Film className="h-4 w-4 mr-1" /> Recordings
            </Button>
            {canConnect && (
              <Button variant="outline" onClick={() => setShowCli(true)}>
                <TerminalSquare className="h-4 w-4 mr-1" /> Command line
              </Button>
            )}
            {canConnect && (
              <Button variant="outline" onClick={() => setShowCa(true)}>
                <ShieldCheck className="h-4 w-4 mr-1" /> SSH CA
              </Button>
            )}
            {canManage && (
              <Button onClick={() => setAdding(true)}>
                <Plus className="h-4 w-4 mr-1" /> Add machine
              </Button>
            )}
          </>
        }
      />

      {err && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      )}

      {deletedHint && (
        <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
          <div className="flex items-start justify-between gap-2">
            <div className="text-amber-300/90 min-w-0">
              Deleted <span className="font-medium">{deletedHint.name}</span>. If the agent is still installed on that
              machine (offline or an older version), remove it there:
              <div className="mt-1 flex items-start gap-2">
                <code className="flex-1 text-xs break-all font-mono">{uninstallCmd(deletedHint.os)}</code>
                <CopyBtn text={uninstallCmd(deletedHint.os)} />
              </div>
            </div>
            <button onClick={() => setDeletedHint(null)} className="text-muted-foreground hover:text-foreground shrink-0">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {agents === null ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading agents…
        </div>
      ) : agents.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Radio className="h-8 w-8 mx-auto mb-3 opacity-50" />
            <p>No machines yet.</p>
            {canManage && (
              <p className="text-sm mt-1">
                Click <span className="text-foreground">Add machine</span> to enroll your first Linux or Windows box.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Toolbar: search + status filter */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div className="relative flex-1 min-w-[14rem] max-w-md">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, host, IP, tag, note…" className="pl-8" />
            </div>
            <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
              {(['all', 'online', 'offline'] as const).map((f) => (
                <button key={f} type="button" onClick={() => setStatusFilter(f)}
                  className={`px-3 py-1.5 capitalize ${statusFilter === f ? 'bg-primary/20 text-primary' : 'hover:bg-muted'}`}>
                  {f}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">{totalShown} of {agents.length}</span>
          </div>

          {totalShown === 0 ? (
            <Card><CardContent className="py-10 text-center text-muted-foreground text-sm">No machines match your filters.</CardContent></Card>
          ) : (
            OS_ORDER.filter((k) => groups[k].length > 0).map((k) => (
              <section key={k} className="mb-5">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[0.7rem] font-medium ${OS_META[k].cls}`}>{OS_META[k].label}</span>
                  <span className="text-xs text-muted-foreground">{groups[k].length}</span>
                  <div className="flex-1 h-px bg-border/60" />
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {groups[k].map(renderAgentCard)}
                </div>
              </section>
            ))
          )}
        </>
      )}

      {showCli && <CliDialog onClose={() => setShowCli(false)} />}
      {showCa && <CaDialog canManage={canManage} onClose={() => setShowCa(false)} />}
      {showRecordings && <RecordingsDialog onClose={() => setShowRecordings(false)} />}

      {adding && (
        <AddMachineDialog
          onClose={() => setAdding(false)}
          onEnrolled={(e) => {
            setAdding(false);
            setEnrollment(e);
            load();
          }}
        />
      )}

      {enrollment && <EnrollmentDialog enrollment={enrollment} onClose={() => setEnrollment(null)} />}

      {connectFor && connectFor.target.kind === 'rdp' && (
        <RdpConnectDialog
          agent={connectFor.agent}
          target={connectFor.target}
          canManage={canManage}
          onChanged={load}
          onClose={() => setConnectFor(null)}
          onConnected={(ticket, win, opts) => {
            launchViewer('rdp', ticket, `${connectFor.agent.name} · ${connectFor.target.host}:${connectFor.target.port}`, win, {
              dynamicResize: opts.dynamicResize,
            });
            setConnectFor(null);
          }}
        />
      )}

      {connectFor && connectFor.target.kind === 'ssh' && (
        <SshConnectDialog
          agent={connectFor.agent}
          target={connectFor.target}
          canManage={canManage}
          onChanged={load}
          onClose={() => setConnectFor(null)}
          onConnected={(ticket, win) => {
            launchViewer('ssh', ticket, `${connectFor.agent.name} · ${connectFor.target.host}:${connectFor.target.port}`, win);
            setConnectFor(null);
          }}
        />
      )}

      {connectFor && connectFor.target.kind === 'vnc' && (
        <VncConnectDialog
          agent={connectFor.agent}
          target={connectFor.target}
          canManage={canManage}
          onChanged={load}
          onClose={() => setConnectFor(null)}
          onConnected={(ticket, win) => {
            launchViewer('vnc', ticket, `${connectFor.agent.name} · ${connectFor.target.host}:${connectFor.target.port}`, win, {
              vncCreds: ticket.username || ticket.password ? { username: ticket.username, password: ticket.password } : undefined,
            });
            setConnectFor(null);
          }}
        />
      )}

      {filesFor && (
        <FilesBrowser
          agent={filesFor.agent}
          target={filesFor.target}
          onClose={() => setFilesFor(null)}
        />
      )}

      {editing && (
        <EditAgentDialog agent={editing} onClose={() => setEditing(null)} onSave={saveAgent} />
      )}

      {session && <SshTerminal session={session.ticket} title={session.title} onClose={() => setSession(null)} />}
      {rdpSession && (
        <RdpViewer
          session={rdpSession.ticket}
          title={rdpSession.title}
          dynamicResize={rdpSession.dynamicResize}
          onClose={() => setRdpSession(null)}
        />
      )}
      {vncSession && <VncViewer session={vncSession.ticket} title={vncSession.title} creds={vncSession.creds} onClose={() => setVncSession(null)} />}
    </div>
  );
}

function AddMachineDialog({
  onClose,
  onEnrolled,
}: {
  onClose: () => void;
  onEnrolled: (e: FabricEnrollmentDto) => void;
}) {
  const [name, setName] = useState('');
  const [os, setOs] = useState('linux');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setErr('Give the machine a name.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const e = await api.post<FabricEnrollmentDto>('/api/fabric/agents', { name: name.trim(), os });
      onEnrolled(e);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to create agent.');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add machine"
      description="Creates a one-time enrollment token and the install command to run on the box."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
            Create enrollment
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <p className="text-sm text-destructive">{err}</p>}
        <div>
          <Label htmlFor="fab-name">Name</Label>
          <Input id="fab-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="prod-web-01" autoFocus />
        </div>
        <div>
          <Label htmlFor="fab-os">Operating system</Label>
          <select id="fab-os" className={selectCls} value={os} onChange={(e) => setOs(e.target.value)}>
            <option value="linux">Linux</option>
            <option value="macos">macOS</option>
            <option value="windows">Windows</option>
          </select>
        </div>
      </div>
    </Dialog>
  );
}

function EnrollmentDialog({
  enrollment,
  onClose,
}: {
  enrollment: FabricEnrollmentDto;
  onClose: () => void;
}) {
  const cmd = enrollment.agent.os === 'windows' ? enrollment.installWindows : enrollment.installLinux;
  const other = enrollment.agent.os === 'windows' ? enrollment.installLinux : enrollment.installWindows;
  const otherLabel = enrollment.agent.os === 'windows' ? 'Linux' : 'Windows';

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Enroll ${enrollment.agent.name}`}
      description="Run this on the machine. The enrollment token is shown once — it expires in 1 hour."
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="space-y-4">
        <div>
          <Label>Install command ({enrollment.agent.os === 'windows' ? 'Windows PowerShell (admin)' : 'Linux / macOS (sudo)'})</Label>
          <div className="mt-1 flex items-start gap-2 rounded-md border border-input bg-background/60 p-2">
            <code className="flex-1 text-xs break-all font-mono">{cmd}</code>
            <CopyBtn text={cmd} />
          </div>
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Show {otherLabel} command</summary>
          <div className="mt-1 flex items-start gap-2 rounded-md border border-input bg-background/60 p-2">
            <code className="flex-1 text-xs break-all font-mono">{other}</code>
            <CopyBtn text={other} />
          </div>
        </details>

        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300/90">
          The agent connects outbound only — no inbound firewall rule is needed. You can safely deny inbound 22/3389 on
          this machine's security group.
        </div>
      </div>
    </Dialog>
  );
}

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function sessionDuration(s: FabricSessionDto): string {
  if (!s.endedAt) return 'in progress';
  return fmtTime(new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime());
}

function RecordingsDialog({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<FabricSessionDto[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [playing, setPlaying] = useState<FabricSessionDto | null>(null);

  useEffect(() => {
    api
      .get<FabricSessionDto[]>('/api/fabric/sessions')
      .then((all) => setSessions(all.filter((s) => s.hasRecording)))
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Failed to load recordings.'));
  }, []);

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        size="lg"
        title="Session recordings"
        description="Recorded RDP sessions. Click to play back."
        footer={<Button onClick={onClose}>Close</Button>}
      >
        {err && <p className="text-sm text-destructive">{err}</p>}
        {sessions === null ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm py-6">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6">
            No recordings yet. RDP sessions are recorded automatically.
          </p>
        ) : (
          <div className="divide-y divide-border/60 max-h-[60vh] overflow-y-auto">
            {sessions.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0 text-sm">
                  <div className="truncate">
                    {s.agentName ?? s.agentId}{' '}
                    <span className="uppercase text-[0.65rem] text-muted-foreground">{s.targetKind}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(s.startedAt).toLocaleString()} · {sessionDuration(s)}
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={() => setPlaying(s)}>
                  <Play className="h-4 w-4 mr-1" /> Play
                </Button>
              </div>
            ))}
          </div>
        )}
      </Dialog>
      {playing && <RecordingPlayer session={playing} onClose={() => setPlaying(null)} />}
    </>
  );
}

function RecordingPlayer({ session, onClose }: { session: FabricSessionDto; onClose: () => void }) {
  const screenRef = useRef<HTMLDivElement>(null);
  const recRef = useRef<InstanceType<typeof Guacamole.SessionRecording> | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);

  useEffect(() => {
    if (!screenRef.current) return;
    const host = screenRef.current;
    const tunnel = new Guacamole.StaticHTTPTunnel(`/api/fabric/recordings/${session.id}`);
    const rec = new Guacamole.SessionRecording(tunnel);
    recRef.current = rec;
    const displayEl = rec.getDisplay().getElement();
    host.appendChild(displayEl);

    rec.onprogress = (duration: number) => {
      setDur(duration);
      setReady(true);
    };
    rec.onplay = () => setPlaying(true);
    rec.onpause = () => setPlaying(false);
    rec.onseek = (p: number) => setPos(p);
    rec.connect();

    const iv = setInterval(() => {
      if (recRef.current?.isPlaying()) setPos(recRef.current.getPosition());
    }, 250);

    return () => {
      clearInterval(iv);
      try {
        rec.disconnect();
      } catch {
        /* ignore */
      }
      if (displayEl.parentNode === host) host.removeChild(displayEl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const toggle = () => {
    const r = recRef.current;
    if (!r) return;
    if (r.isPlaying()) r.pause();
    else r.play();
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black flex flex-col">
      <div className="h-12 shrink-0 bg-sidebar border-b border-border flex items-center justify-between px-4">
        <span className="text-sm inline-flex items-center gap-2">
          <Film className="h-4 w-4 text-primary" />
          <span className="text-muted-foreground">Recording ·</span> {session.agentName ?? session.agentId}
        </span>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4 mr-1" /> Close
        </Button>
      </div>
      <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-border bg-sidebar/60">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggle} disabled={!ready}>
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>
        <span className="text-xs tabular-nums text-muted-foreground w-12 text-right">{fmtTime(pos)}</span>
        <input
          type="range"
          min={0}
          max={dur || 1}
          value={Math.min(pos, dur)}
          onChange={(e) => {
            const v = Number(e.target.value);
            setPos(v);
            recRef.current?.seek(v);
          }}
          className="flex-1 accent-[hsl(var(--primary))]"
          disabled={!ready}
        />
        <span className="text-xs tabular-nums text-muted-foreground w-12">{fmtTime(dur)}</span>
      </div>
      <div ref={screenRef} className="flex-1 relative overflow-auto grid place-items-center">
        {!ready && (
          <div className="absolute inset-0 grid place-items-center text-muted-foreground pointer-events-none">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}

interface CaStatus {
  enabled: boolean;
  publicKey?: string;
  fingerprint?: string;
  createdAt?: string;
  ttlMinutes: number;
  autoTrust: boolean;
  hostSetupLinux?: string;
  hostSetupWindows?: string;
  clientTrustLine?: string;
}

function EditAgentDialog({
  agent,
  onClose,
  onSave,
}: {
  agent: FabricAgentDto;
  onClose: () => void;
  onSave: (id: string, input: { name?: string; tags?: string[]; notes?: string | null }) => Promise<void>;
}) {
  const [name, setName] = useState(agent.name);
  const [tags, setTags] = useState(agent.tags.join(', '));
  const [notes, setNotes] = useState(agent.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) { setErr('Name is required.'); return; }
    setBusy(true); setErr(null);
    try {
      await onSave(agent.id, {
        name: name.trim(),
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        notes: notes.trim() || null,
      });
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to save.');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit machine"
      description="Rename, tag, and annotate this machine. Tags and notes show on its card and are searchable."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}Save</Button>
        </>
      }
    >
      {err && <div className="mb-4 text-sm rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2">{err}</div>}
      <div className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label>Tags</Label>
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="prod, aws, us-east-1" />
          <p className="mt-1 text-xs text-muted-foreground">Comma-separated. Shown as chips; used by search.</p>
        </div>
        <div>
          <Label>Notes</Label>
          <textarea
            className="mt-1 w-full h-24 rounded-md border border-input bg-background/60 px-2 py-1.5 text-sm"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. AWS bastion — reboot only during the maintenance window."
          />
        </div>
      </div>
    </Dialog>
  );
}

function CaDialog({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<CaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.get<CaStatus>('/api/fabric/ca').then(setStatus).catch((e) => setErr(e instanceof ApiError ? e.message : 'Failed to load CA status.'));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const enable = async () => {
    setBusy(true); setErr(null);
    try { setStatus(await api.post<CaStatus>('/api/fabric/ca/enable')); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed to enable the CA.'); }
    finally { setBusy(false); }
  };
  const disable = async () => {
    if (!confirm('Disable the SSH CA? New certificates can no longer be issued. Hosts keep the (now-unused) CA key until you remove it there.')) return;
    setBusy(true); setErr(null);
    try { await api.post('/api/fabric/ca/disable'); await load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed to disable the CA.'); }
    finally { setBusy(false); }
  };
  const setAutoTrust = async (enabled: boolean) => {
    setBusy(true); setErr(null);
    try { setStatus(await api.post<CaStatus>('/api/fabric/ca/auto-trust', { enabled })); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed to update auto-trust.'); }
    finally { setBusy(false); }
  };

  const Cmd = ({ text }: { text: string }) => (
    <div className="mt-1 flex items-start gap-2 rounded-md border border-input bg-background/60 p-2">
      <code className="flex-1 text-xs break-all font-mono whitespace-pre-wrap">{text}</code>
      <CopyBtn text={text} />
    </div>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="SSH certificate authority"
      description="Cerebro signs short-lived SSH certificates so you connect with your own client and no per-box keys."
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {err && (
        <div className="mb-4 text-sm rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2">{err}</div>
      )}
      {!status ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : !status.enabled ? (
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            The SSH CA is <span className="text-foreground">off</span>. Enabling it generates a CA keypair (the private
            key is sealed in the vault). You then trust its public key on each box once, and connect with{' '}
            <code>cerebro ssh --ca &lt;user&gt;@&lt;machine&gt;</code> — no keys to manage, certs expire in minutes.
          </p>
          {canManage ? (
            <Button onClick={enable} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ShieldCheck className="h-4 w-4 mr-1" />} Enable SSH CA
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">An admin (fabric:manage) can enable it.</p>
          )}
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1.5 text-emerald-400"><ShieldCheck className="h-4 w-4" /> Enabled</span>
            <span className="text-muted-foreground text-xs">Certs valid {status.ttlMinutes} min</span>
            {status.fingerprint && <span className="text-muted-foreground text-xs font-mono truncate">{status.fingerprint}</span>}
          </div>

          <label className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 p-3 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={status.autoTrust}
              disabled={!canManage || busy}
              onChange={(e) => setAutoTrust(e.target.checked)}
            />
            <span>
              <span className="font-medium">Auto-trust new agents</span>
              <span className="block text-xs text-muted-foreground">
                Push CA trust + a host certificate to each machine automatically the first time it connects — new boxes
                are CA-ready with no clicks. Runs once per machine.
              </span>
            </span>
          </label>

          <div>
            <p className="font-medium">CA public key</p>
            <Cmd text={status.publicKey ?? ''} />
          </div>
          <div>
            <p className="font-medium">1. Trust it on each Linux/macOS box (run there once)</p>
            <Cmd text={status.hostSetupLinux ?? ''} />
          </div>
          <div>
            <p className="font-medium">Windows host (elevated PowerShell)</p>
            <Cmd text={status.hostSetupWindows ?? ''} />
          </div>
          <div>
            <p className="font-medium">2. Connect with your own client (no key setup)</p>
            <Cmd text={`cerebro ssh --ca <user>@<machine>`} />
            <p className="text-muted-foreground text-xs mt-1">
              Generates an ephemeral key, gets a {status.ttlMinutes}-minute cert signed, and launches your <code>ssh</code>.
            </p>
          </div>
          <div>
            <p className="font-medium">Host verification (no TOFU prompts)</p>
            <p className="text-muted-foreground text-xs mb-1">
              Using the per-host <span className="text-foreground">Trust CA</span> button (shield icon on an online agent)
              also signs that box's host key, so clients verify it via the CA. <code>cerebro ssh --ca</code> trusts host
              certs automatically; to verify from a raw <code>ssh</code>, add this to your <code>known_hosts</code>:
            </p>
            <Cmd text={status.clientTrustLine ?? ''} />
          </div>

          {canManage && (
            <div className="pt-2 border-t border-border/50">
              <Button variant="outline" onClick={disable} disabled={busy} className="text-destructive">
                Disable SSH CA
              </Button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function CliDialog({ onClose }: { onClose: () => void }) {
  const origin = location.origin;
  const isWin = /Windows/i.test(navigator.userAgent);
  const isMac = /Mac/i.test(navigator.userAgent);
  const os = isWin ? 'windows' : isMac ? 'darwin' : 'linux';
  const arch = isMac ? 'arm64' : 'amd64';

  const download = isWin
    ? `iwr "${origin}/api/fabric/cli/binary?os=windows&arch=amd64" -OutFile cerebro.exe`
    : `curl -fsSL "${origin}/api/fabric/cli/binary?os=${os}&arch=${arch}" -o cerebro && chmod +x cerebro && sudo mv cerebro /usr/local/bin/`;
  const configure = isWin
    ? `$env:CEREBRO_URL='${origin}'; $env:CEREBRO_TOKEN='cbro_your_token'`
    : `export CEREBRO_URL=${origin}\nexport CEREBRO_TOKEN=cbro_your_token`;

  const Cmd = ({ text }: { text: string }) => (
    <div className="mt-1 flex items-start gap-2 rounded-md border border-input bg-background/60 p-2">
      <code className="flex-1 text-xs break-all font-mono whitespace-pre-wrap">{text}</code>
      <CopyBtn text={text} />
    </div>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Command-line access"
      description="Use your own ssh / scp / mstsc through the tunnel — the box still needs no inbound rule."
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="space-y-4 text-sm">
        <div>
          <p className="font-medium">1. Create an API token</p>
          <p className="text-muted-foreground text-xs mt-0.5">
            In <a href="/settings/api-tokens" className="text-primary hover:underline">Settings → API Tokens</a>, create
            a token with the <code>fabric:read</code> and <code>fabric:connect</code> scopes.
          </p>
        </div>
        <div>
          <p className="font-medium">2. Install the CLI ({os}/{arch})</p>
          <Cmd text={download} />
        </div>
        <div>
          <p className="font-medium">3. Point it at Cerebro</p>
          <Cmd text={configure} />
        </div>
        <div>
          <p className="font-medium">4. Connect</p>
          <Cmd text={`cerebro ls\ncerebro access <machine> ssh    # local port for any client\ncerebro access <machine> rdp`} />
          <p className="text-muted-foreground text-xs mt-1">
            Prints a local address + connect hint, then forwards until Ctrl+C.
          </p>
        </div>
        <div>
          <p className="font-medium">Bring your own SSH client</p>
          <Cmd text={`cerebro ssh <user>@<machine>`} />
          <p className="text-muted-foreground text-xs mt-1">
            Launches your own <code>ssh</code> (your keys, agent forwarding) through the tunnel. Or wire it into{' '}
            <code>~/.ssh/config</code> once for plain <code>ssh</code>/<code>scp</code>/<code>sftp</code>:
          </p>
          <Cmd text={`Host <machine>.fabric\n    ProxyCommand cerebro proxy <machine>\n    User <user>`} />
          <p className="text-muted-foreground text-xs mt-1">
            Then just <code>ssh &lt;machine&gt;.fabric</code>.
          </p>
        </div>
      </div>
    </Dialog>
  );
}

type SaveScope = 'machine' | 'reusable';

/**
 * Shared "save this credential" control for the connect dialogs. The scope is an
 * explicit choice — "this machine" (attaches to the target, shows the key icon on
 * its chip) vs "reusable" (a named vault credential offered for every machine) —
 * so naming a credential can't silently change where it's stored.
 */
function SaveCredentialFields({
  save,
  setSave,
  scope,
  setScope,
  saveAs,
  setSaveAs,
  idPrefix,
}: {
  save: boolean;
  setSave: (v: boolean) => void;
  scope: SaveScope;
  setScope: (v: SaveScope) => void;
  saveAs: string;
  setSaveAs: (v: string) => void;
  idPrefix: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
        Save this credential to the vault
      </label>
      {save && (
        <div className="ml-6 space-y-1.5 text-sm">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name={`${idPrefix}-scope`} checked={scope === 'machine'} onChange={() => setScope('machine')} />
            For this machine only
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name={`${idPrefix}-scope`} checked={scope === 'reusable'} onChange={() => setScope('reusable')} />
            Reusable (shows in the picker for every machine)
          </label>
          {scope === 'reusable' && (
            <Input value={saveAs} onChange={(e) => setSaveAs(e.target.value)} placeholder="Credential name" />
          )}
        </div>
      )}
    </div>
  );
}

function SshConnectDialog({
  agent,
  target,
  canManage,
  onClose,
  onConnected,
  onChanged,
}: {
  agent: FabricAgentDto;
  target: FabricTargetDto;
  canManage: boolean;
  onClose: () => void;
  onConnected: (ticket: FabricSessionTicket, win: Window | null) => void;
  onChanged: () => void;
}) {
  const ownKey = `fabric/${agent.id}/${target.id}`;
  const [savedExists, setSavedExists] = useState(target.hasCredential);
  const [pinnedExists, setPinnedExists] = useState(target.hostKeyPinned);
  const [credOptions, setCredOptions] = useState<{ key: string; label: string }[]>([]);
  const [credSource, setCredSource] = useState(target.hasCredential ? ownKey : 'manual');
  const [username, setUsername] = useState('root');
  const [method, setMethod] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [save, setSave] = useState(false);
  const [saveAs, setSaveAs] = useState('');
  const [saveScope, setSaveScope] = useState<SaveScope>('machine');
  const [newTab, setNewTab] = useState(prefNewTab());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isManual = credSource === 'manual';

  useEffect(() => {
    api
      .get<{ key: string; label: string }[]>('/api/fabric/credentials?kind=ssh')
      .then((list) => setCredOptions(list.filter((c) => c.key !== ownKey)))
      .catch(() => setCredOptions([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    setErr(null);
    let body: FabricSshConnectInput;
    if (!isManual) {
      body = { secretRef: credSource };
    } else {
      if (!username.trim()) {
        setErr('A username is required.');
        return;
      }
      if (method === 'password' ? !password : !privateKey.trim()) {
        setErr(method === 'password' ? 'Enter a password.' : 'Paste a private key.');
        return;
      }
      const saving = save && canManage;
      body =
        method === 'password'
          ? { username: username.trim(), password, save: saving, saveAs: saveScope === 'reusable' ? saveAs.trim() || undefined : undefined }
          : { username: username.trim(), privateKey, passphrase: passphrase || undefined, save: saving, saveAs: saveScope === 'reusable' ? saveAs.trim() || undefined : undefined };
    }
    // Open the tab now (still inside the click) so popup blockers allow it.
    const win = newTab ? window.open('about:blank', '_blank') : null;
    setBusy(true);
    try {
      const ticket = await api.post<FabricSessionTicket>(
        `/api/fabric/agents/${agent.id}/targets/${target.id}/session`,
        body,
      );
      if (isManual && save && canManage) onChanged();
      onConnected(ticket, win);
    } catch (e) {
      win?.close();
      setErr(e instanceof ApiError ? e.message : 'Failed to open session.');
      setBusy(false);
    }
  };

  const forget = async () => {
    if (!confirm('Forget the saved credential for this target?')) return;
    try {
      await api.delete(`/api/fabric/agents/${agent.id}/targets/${target.id}/credential`);
      setSavedExists(false);
      if (credSource === ownKey) setCredSource('manual');
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to remove credential.');
    }
  };

  const resetHostKey = async () => {
    if (!confirm('Reset the pinned host key? The next connection will trust and re-pin the host.')) return;
    try {
      await api.delete(`/api/fabric/agents/${agent.id}/targets/${target.id}/hostkey`);
      setPinnedExists(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to reset host key.');
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`SSH · ${agent.name}`}
      description={`Connect to ${target.host}:${target.port} through the tunnel.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <TerminalSquare className="h-4 w-4 mr-1" />}
            Connect
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <p className="text-sm text-destructive">{err}</p>}

        <div>
          <Label htmlFor="ssh-cred">Credential</Label>
          <select id="ssh-cred" className={selectCls} value={credSource} onChange={(e) => setCredSource(e.target.value)}>
            {savedExists && <option value={ownKey}>Saved for this machine</option>}
            {credOptions.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label} (vault)
              </option>
            ))}
            <option value="manual">Enter manually…</option>
          </select>
          {savedExists && canManage && (
            <button type="button" onClick={forget} className="mt-1 text-xs text-destructive hover:underline">
              Forget this machine's saved credential
            </button>
          )}
        </div>

        {pinnedExists && canManage && (
          <p className="text-xs text-muted-foreground">
            Host key pinned.{' '}
            <button type="button" onClick={resetHostKey} className="text-destructive hover:underline">
              Reset
            </button>{' '}
            if this host was rebuilt.
          </p>
        )}

        {isManual && (
          <>
            <div>
              <Label htmlFor="ssh-user">Username</Label>
              <Input id="ssh-user" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            </div>
            <div>
              <Label htmlFor="ssh-method">Authentication</Label>
              <select
                id="ssh-method"
                className={selectCls}
                value={method}
                onChange={(e) => setMethod(e.target.value as 'password' | 'key')}
              >
                <option value="password">Password</option>
                <option value="key">Private key</option>
              </select>
            </div>
            {method === 'password' ? (
              <div>
                <Label htmlFor="ssh-pass">Password</Label>
                <Input id="ssh-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            ) : (
              <>
                <div>
                  <Label htmlFor="ssh-key">Private key (PEM)</Label>
                  <textarea
                    id="ssh-key"
                    className="mt-1 w-full h-28 rounded-md border border-input bg-background/60 px-2 py-1 text-xs font-mono"
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  />
                </div>
                <div>
                  <Label htmlFor="ssh-phrase">Key passphrase (optional)</Label>
                  <Input id="ssh-phrase" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
                </div>
              </>
            )}
            {canManage && (
              <SaveCredentialFields
                save={save} setSave={setSave}
                scope={saveScope} setScope={setSaveScope}
                saveAs={saveAs} setSaveAs={setSaveAs}
                idPrefix="ssh"
              />
            )}
          </>
        )}

        <label className="flex items-center gap-2 text-sm cursor-pointer pt-1 border-t border-border/50">
          <input
            type="checkbox"
            checked={newTab}
            onChange={(e) => {
              setNewTab(e.target.checked);
              setPrefNewTab(e.target.checked);
            }}
          />
          Open in a new browser tab
        </label>
      </div>
    </Dialog>
  );
}

export function SshTerminal({
  session,
  title,
  onClose,
}: {
  session: FabricSessionTicket;
  title: string;
  onClose: () => void;
}) {
  const screenRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');

  useEffect(() => {
    if (!screenRef.current) return;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'ui-monospace, monospace',
      theme: { background: '#000000' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(screenRef.current);
    fit.fit();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}${session.wsPath}?token=${encodeURIComponent(session.token)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const dec = new TextDecoder();
    const enc = new TextEncoder();

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ resize: { cols: term.cols, rows: term.rows } }));
    };

    ws.onopen = () => {
      setStatus('connected');
      fit.fit();
      term.focus();
      sendResize();
    };
    ws.onmessage = (ev) =>
      term.write(typeof ev.data === 'string' ? ev.data : dec.decode(ev.data as ArrayBuffer));
    ws.onclose = () => setStatus('disconnected');
    ws.onerror = () => setStatus('disconnected');

    const onData = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
    });
    const ro = new ResizeObserver(() => {
      fit.fit();
      sendResize();
    });
    ro.observe(screenRef.current);

    return () => {
      onData.dispose();
      ro.disconnect();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.token]);

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div className="h-12 shrink-0 bg-sidebar border-b border-border flex items-center justify-between px-4">
        <span className="text-sm inline-flex items-center gap-2">
          <TerminalSquare className="h-4 w-4 text-primary" />
          <span className="text-muted-foreground">SSH ·</span> {title}
        </span>
        <div className="flex items-center gap-3 text-sm">
          <span
            className={`inline-flex items-center gap-1.5 ${
              status === 'connected'
                ? 'text-emerald-400'
                : status === 'connecting'
                  ? 'text-amber-400'
                  : 'text-muted-foreground'
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                status === 'connected'
                  ? 'bg-emerald-400'
                  : status === 'connecting'
                    ? 'bg-amber-400 animate-pulse'
                    : 'bg-muted-foreground'
              }`}
            />
            {status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Disconnected'}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4 mr-1" /> Close
          </Button>
        </div>
      </div>
      <div className="flex-1 relative overflow-hidden">
        <div ref={screenRef} className="w-full h-full p-2" />
      </div>
    </div>
  );
}

function RdpConnectDialog({
  agent,
  target,
  canManage,
  onClose,
  onConnected,
  onChanged,
}: {
  agent: FabricAgentDto;
  target: FabricTargetDto;
  canManage: boolean;
  onClose: () => void;
  onConnected: (ticket: FabricSessionTicket, win: Window | null, opts: { dynamicResize: boolean }) => void;
  onChanged: () => void;
}) {
  const ownKey = `fabric/${agent.id}/${target.id}`;
  const [savedExists, setSavedExists] = useState(target.hasCredential);
  const [credOptions, setCredOptions] = useState<{ key: string; label: string }[]>([]);
  const [credSource, setCredSource] = useState(target.hasCredential ? ownKey : 'manual');
  const [saveAs, setSaveAs] = useState('');
  const [saveScope, setSaveScope] = useState<SaveScope>('machine');
  const [username, setUsername] = useState('Administrator');
  const [password, setPassword] = useState('');
  const [domain, setDomain] = useState('');
  const [save, setSave] = useState(false);
  const [newTab, setNewTab] = useState(prefNewTab());
  const isManual = credSource === 'manual';
  // Display / session options, remembered per target in this browser.
  const prefs = useMemo(() => loadRdpPrefs(target.id), [target.id]);
  const [resolution, setResolution] = useState(prefs.resolution ?? 'fit');
  const [colorDepth, setColorDepth] = useState(prefs.colorDepth ?? '32');
  const [security, setSecurity] = useState(prefs.security ?? 'any');
  const [consoleSession, setConsoleSession] = useState(prefs.consoleSession ?? false);
  const [enableEffects, setEnableEffects] = useState(prefs.enableEffects ?? false);
  const [enableAudio, setEnableAudio] = useState(prefs.enableAudio ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ key: string; label: string }[]>('/api/fabric/credentials?kind=rdp')
      .then((list) => setCredOptions(list.filter((c) => c.key !== ownKey)))
      .catch(() => setCredOptions([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const options = () => {
    // Resolution: "fit" → the current window; otherwise a fixed "WxH".
    let width: number | undefined;
    let height: number | undefined;
    if (resolution === 'fit') {
      width = Math.round(window.innerWidth);
      height = Math.max(240, Math.round(window.innerHeight - 48));
    } else {
      const [w, h] = resolution.split('x').map((n) => parseInt(n, 10));
      width = w;
      height = h;
    }
    return {
      width,
      height,
      colorDepth: parseInt(colorDepth, 10),
      security,
      consoleSession,
      enableEffects,
      disableAudio: !enableAudio,
    };
  };

  const submit = async () => {
    setErr(null);
    saveRdpPrefs(target.id, { resolution, colorDepth, security, consoleSession, enableEffects, enableAudio });
    const opts = options();
    let body: FabricRdpConnectInput;
    if (!isManual) {
      body = { secretRef: credSource, ...opts };
    } else {
      if (!username.trim()) {
        setErr('A username is required.');
        return;
      }
      if (!password) {
        setErr('A password is required.');
        return;
      }
      body = {
        username: username.trim(),
        password,
        domain: domain.trim() || undefined,
        save: save && canManage,
        saveAs: saveScope === 'reusable' ? saveAs.trim() || undefined : undefined,
        ...opts,
      };
    }
    const win = newTab ? window.open('about:blank', '_blank') : null;
    setBusy(true);
    try {
      const ticket = await api.post<FabricSessionTicket>(
        `/api/fabric/agents/${agent.id}/targets/${target.id}/rdp-session`,
        body,
      );
      if (isManual && save && canManage) onChanged();
      onConnected(ticket, win, { dynamicResize: resolution === 'fit' });
    } catch (e) {
      win?.close();
      setErr(e instanceof ApiError ? e.message : 'Failed to open session.');
      setBusy(false);
    }
  };

  const forget = async () => {
    if (!confirm('Forget the saved credential for this target?')) return;
    try {
      await api.delete(`/api/fabric/agents/${agent.id}/targets/${target.id}/credential`);
      setSavedExists(false);
      if (credSource === ownKey) setCredSource('manual');
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to remove credential.');
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`RDP · ${agent.name}`}
      description={`Connect to ${target.host}:${target.port} through the tunnel.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <MonitorSmartphone className="h-4 w-4 mr-1" />}
            Connect
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <p className="text-sm text-destructive">{err}</p>}

        <div>
          <Label htmlFor="rdp-cred">Credential</Label>
          <select id="rdp-cred" className={selectCls} value={credSource} onChange={(e) => setCredSource(e.target.value)}>
            {savedExists && <option value={ownKey}>Saved for this machine</option>}
            {credOptions.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label} (vault)
              </option>
            ))}
            <option value="manual">Enter manually…</option>
          </select>
          {savedExists && canManage && (
            <button type="button" onClick={forget} className="mt-1 text-xs text-destructive hover:underline">
              Forget this machine's saved credential
            </button>
          )}
        </div>

        {isManual && (
          <>
            <div>
              <Label htmlFor="rdp-user">Username</Label>
              <Input id="rdp-user" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            </div>
            <div>
              <Label htmlFor="rdp-domain">Domain (optional)</Label>
              <Input id="rdp-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="WORKGROUP" />
            </div>
            <div>
              <Label htmlFor="rdp-pass">Password</Label>
              <Input id="rdp-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {canManage && (
              <SaveCredentialFields
                save={save} setSave={setSave}
                scope={saveScope} setScope={setSaveScope}
                saveAs={saveAs} setSaveAs={setSaveAs}
                idPrefix="rdp"
              />
            )}
          </>
        )}

        <div className="pt-1 mt-1 border-t border-border/50 space-y-3">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Display &amp; session</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="rdp-res">Resolution</Label>
              <select id="rdp-res" className={selectCls} value={resolution} onChange={(e) => setResolution(e.target.value)}>
                <option value="fit">Fit to window</option>
                <option value="1920x1080">1920 × 1080</option>
                <option value="1600x900">1600 × 900</option>
                <option value="1440x900">1440 × 900</option>
                <option value="1366x768">1366 × 768</option>
                <option value="1280x720">1280 × 720</option>
                <option value="1024x768">1024 × 768</option>
              </select>
            </div>
            <div>
              <Label htmlFor="rdp-color">Color depth</Label>
              <select id="rdp-color" className={selectCls} value={colorDepth} onChange={(e) => setColorDepth(e.target.value)}>
                <option value="32">True color (32-bit)</option>
                <option value="24">24-bit</option>
                <option value="16">High color (16-bit)</option>
                <option value="8">256 color (8-bit)</option>
              </select>
            </div>
            <div className="col-span-2">
              <Label htmlFor="rdp-sec">Security mode</Label>
              <select id="rdp-sec" className={selectCls} value={security} onChange={(e) => setSecurity(e.target.value)}>
                <option value="any">Automatic (negotiate)</option>
                <option value="nla">NLA</option>
                <option value="tls">TLS</option>
                <option value="rdp">RDP (legacy)</option>
                <option value="vmconnect">Hyper-V console</option>
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={enableAudio} onChange={(e) => setEnableAudio(e.target.checked)} /> Audio
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={enableEffects} onChange={(e) => setEnableEffects(e.target.checked)} /> Visual effects (wallpaper, themes, animations)
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={consoleSession} onChange={(e) => setConsoleSession(e.target.checked)} /> Connect to admin / console session
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={newTab}
                onChange={(e) => {
                  setNewTab(e.target.checked);
                  setPrefNewTab(e.target.checked);
                }}
              />
              Open in a new browser tab
            </label>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

export function RdpViewer({
  session,
  title,
  dynamicResize,
  onClose,
}: {
  session: FabricSessionTicket;
  title: string;
  dynamicResize: boolean;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // WebSocketTunnel appends `?<connectData>` to this URL, so keep it query-less
    // and pass the token as the connect data below (→ `…/ws?token=…`).
    const url = `${proto}//${location.host}${session.wsPath}`;

    const tunnel = new Guacamole.WebSocketTunnel(url);
    const client = new Guacamole.Client(tunnel);
    const displayEl = client.getDisplay().getElement();
    host.appendChild(displayEl);

    // Guacamole client states: 0 IDLE 1 CONNECTING 2 WAITING 3 CONNECTED
    // 4 DISCONNECTING 5 DISCONNECTED
    const STATE_NAMES = ['idle', 'connecting', 'waiting', 'connected', 'disconnecting', 'disconnected'];
    let everConnected = false;
    let sawError = false;
    client.onstatechange = (state: number) => {
      // eslint-disable-next-line no-console
      console.log('[RDP] client state:', state, STATE_NAMES[state] ?? '');
      if (state === 3) {
        everConnected = true;
        setStatus('connected');
      } else if (state === 5) {
        setStatus('disconnected');
        // Disconnected before ever rendering, with no explicit error, almost
        // always means guacd could not reach the host or RDP was rejected.
        if (!everConnected && !sawError) {
          setError(
            'The session ended before the desktop loaded. Usually guacd could not reach the host through the tunnel, or RDP was rejected (credentials / NLA / certificate). Check the guacd container logs.',
          );
        }
      }
    };
    const onGuacError = (s: { code?: number; message?: string }, where: string) => {
      sawError = true;
      // eslint-disable-next-line no-console
      console.error(`[RDP] ${where} error:`, s?.code, s?.message);
      setError(s?.message ? `${s.message}${s.code != null ? ` (code ${s.code})` : ''}` : `RDP ${where} error (code ${s?.code ?? '?'}).`);
      setStatus('disconnected');
    };
    client.onerror = (s) => onGuacError(s, 'client');
    (tunnel as unknown as { onerror?: (s: { code?: number; message?: string }) => void }).onerror = (s) =>
      onGuacError(s, 'tunnel');

    const sendSize = () => {
      const w = Math.max(640, Math.floor(host.clientWidth));
      const h = Math.max(480, Math.floor(host.clientHeight));
      try {
        client.sendSize(w, h);
      } catch {
        /* not connected yet */
      }
    };

    client.connect(`token=${encodeURIComponent(session.token)}`);

    // Mouse
    const mouse = new Guacamole.Mouse(displayEl);
    mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = () => client.sendMouseState(mouse.currentState);
    // Keyboard (scoped to the viewer element, which we focus)
    host.tabIndex = 0;
    host.focus();
    const keyboard = new Guacamole.Keyboard(host);
    keyboard.onkeydown = (keysym: number) => {
      client.sendKeyEvent(1, keysym);
    };
    keyboard.onkeyup = (keysym: number) => {
      client.sendKeyEvent(0, keysym);
    };

    // Only track the window when "fit to window" was chosen; for a fixed
    // resolution, leave the desktop at the size the server requested.
    let ro: ResizeObserver | undefined;
    let sizeTimer: ReturnType<typeof setTimeout> | undefined;
    if (dynamicResize) {
      ro = new ResizeObserver(() => sendSize());
      ro.observe(host);
      sizeTimer = setTimeout(sendSize, 500);
    }

    return () => {
      if (sizeTimer) clearTimeout(sizeTimer);
      ro?.disconnect();
      try {
        keyboard.reset();
      } catch {
        /* ignore */
      }
      try {
        client.disconnect();
      } catch {
        /* ignore */
      }
      if (displayEl.parentNode === host) host.removeChild(displayEl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.token]);

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div className="h-12 shrink-0 bg-sidebar border-b border-border flex items-center justify-between px-4">
        <span className="text-sm inline-flex items-center gap-2">
          <MonitorSmartphone className="h-4 w-4 text-primary" />
          <span className="text-muted-foreground">RDP ·</span> {title}
        </span>
        <div className="flex items-center gap-3 text-sm">
          <span
            className={`inline-flex items-center gap-1.5 ${
              status === 'connected'
                ? 'text-emerald-400'
                : status === 'connecting'
                  ? 'text-amber-400'
                  : 'text-muted-foreground'
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                status === 'connected'
                  ? 'bg-emerald-400'
                  : status === 'connecting'
                    ? 'bg-amber-400 animate-pulse'
                    : 'bg-muted-foreground'
              }`}
            />
            {status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Disconnected'}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4 mr-1" /> Close
          </Button>
        </div>
      </div>
      {error && (
        <div className="m-3 text-sm rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2">
          {error}
        </div>
      )}
      <div ref={hostRef} className="flex-1 relative overflow-auto outline-none grid place-items-center" />
    </div>
  );
}

export function VncViewer({
  session,
  title,
  creds,
  onClose,
}: {
  session: FabricSessionTicket;
  title: string;
  /** Optional saved credential to auto-fill (vaulted) instead of prompting. */
  creds?: { username?: string; password?: string };
  onClose: () => void;
}) {
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  // Saved creds are auto-sent once; if they're rejected we fall back to the prompt.
  const triedSavedRef = useRef(false);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [error, setError] = useState<string | null>(null);
  // Which credentials the server asked for (null = no prompt showing). macOS
  // Screen Sharing (Apple RA2) needs username+password; legacy VNC just password.
  const [credTypes, setCredTypes] = useState<string[] | null>(null);
  const [credForm, setCredForm] = useState<{ username: string; password: string; target: string }>({
    username: '',
    password: '',
    target: '',
  });

  useEffect(() => {
    if (!screenRef.current) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}${session.wsPath}?token=${encodeURIComponent(session.token)}`;
    let rfb: RFB | null = null;
    try {
      rfb = new RFB(screenRef.current, url);
      rfbRef.current = rfb;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.addEventListener('connect', () => {
        setStatus('connected');
        setCredTypes(null);
      });
      rfb.addEventListener('disconnect', (e) => {
        setStatus('disconnected');
        const d = (e as CustomEvent).detail;
        if (d && !d.clean) setError('The screen-sharing connection was closed.');
      });
      rfb.addEventListener('credentialsrequired', (e) => {
        const types: string[] = (e as CustomEvent).detail?.types ?? ['password'];
        // If we have a vaulted credential that satisfies every requested field,
        // auto-send it once (no prompt). Otherwise show the inline overlay — which
        // noVNC re-fires until every requested credential is supplied.
        const canSatisfy =
          !!creds &&
          (!types.includes('username') || !!creds.username) &&
          (!types.includes('password') || !!creds.password);
        if (canSatisfy && !triedSavedRef.current) {
          triedSavedRef.current = true;
          const auto: { username?: string; password?: string; target?: string } = {};
          if (types.includes('username')) auto.username = creds!.username ?? '';
          if (types.includes('password')) auto.password = creds!.password ?? '';
          rfb?.sendCredentials(auto);
          return;
        }
        setError(null);
        setCredForm({ username: '', password: '', target: '' });
        setCredTypes(types);
      });
      rfb.addEventListener('securityfailure', (e) => {
        const d = (e as CustomEvent).detail;
        setError(`Authentication failed${d?.reason ? `: ${d.reason}` : ''}.`);
        setCredTypes(null);
      });
    } catch {
      setError('Failed to start the screen-sharing session.');
    }
    return () => {
      rfbRef.current = null;
      try {
        rfb?.disconnect();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.token]);

  function submitCredentials() {
    if (!credTypes) return;
    const creds: { username?: string; password?: string; target?: string } = {};
    if (credTypes.includes('username')) creds.username = credForm.username;
    if (credTypes.includes('password')) creds.password = credForm.password;
    if (credTypes.includes('target')) creds.target = credForm.target;
    setCredTypes(null);
    try {
      rfbRef.current?.sendCredentials(creds);
    } catch {
      setError('Failed to send credentials.');
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div className="h-12 shrink-0 bg-sidebar border-b border-border flex items-center justify-between px-4">
        <span className="text-sm inline-flex items-center gap-2">
          <Monitor className="h-4 w-4 text-primary" />
          <span className="text-muted-foreground">VNC ·</span> {title}
        </span>
        <div className="flex items-center gap-3 text-sm">
          <span
            className={`inline-flex items-center gap-1.5 ${
              status === 'connected'
                ? 'text-emerald-400'
                : status === 'connecting'
                  ? 'text-amber-400'
                  : 'text-muted-foreground'
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                status === 'connected'
                  ? 'bg-emerald-400'
                  : status === 'connecting'
                    ? 'bg-amber-400 animate-pulse'
                    : 'bg-muted-foreground'
              }`}
            />
            {status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Disconnected'}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4 mr-1" /> Close
          </Button>
        </div>
      </div>
      {error && (
        <div className="m-3 text-sm rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2">
          {error}
        </div>
      )}
      <div className="flex-1 relative overflow-hidden">
        {/* The RFB canvas mounts here — must fill the pane so noVNC's scaleViewport
            has real dimensions to scale into (an unsized container renders black). */}
        <div ref={screenRef} className="absolute inset-0 overflow-auto grid place-items-center" />
        {credTypes && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-black/70 backdrop-blur-sm">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitCredentials();
              }}
              className="w-[22rem] max-w-[90vw] rounded-lg border border-border bg-sidebar p-5 shadow-xl space-y-4"
            >
              <div className="flex items-center gap-2 text-sm">
                <Monitor className="h-4 w-4 text-primary" />
                <span className="font-medium">Authenticate to {title}</span>
              </div>
              {credTypes.includes('username') && (
                <p className="text-xs text-muted-foreground -mt-1">
                  Use the macOS account you log in to that Mac with (it must be allowed in Screen Sharing).
                </p>
              )}
              {credTypes.includes('username') && (
                <div>
                  <Label>Username</Label>
                  <Input
                    autoFocus
                    autoComplete="username"
                    placeholder="e.g. ember"
                    value={credForm.username}
                    onChange={(e) => setCredForm((f) => ({ ...f, username: e.target.value }))}
                  />
                </div>
              )}
              {credTypes.includes('password') && (
                <div>
                  <Label>Password</Label>
                  <Input
                    type="password"
                    autoComplete="current-password"
                    autoFocus={!credTypes.includes('username')}
                    placeholder="••••••••"
                    value={credForm.password}
                    onChange={(e) => setCredForm((f) => ({ ...f, password: e.target.value }))}
                  />
                </div>
              )}
              {credTypes.includes('target') && (
                <div>
                  <Label>Target</Label>
                  <Input
                    placeholder="Target"
                    value={credForm.target}
                    onChange={(e) => setCredForm((f) => ({ ...f, target: e.target.value }))}
                  />
                </div>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="outline" size="sm" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" size="sm">
                  Connect
                </Button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

// ── VNC connect dialog (vault-credential picker) ─────────────────────────────

function VncConnectDialog({
  agent,
  target,
  canManage,
  onClose,
  onConnected,
  onChanged,
}: {
  agent: FabricAgentDto;
  target: FabricTargetDto;
  canManage: boolean;
  onClose: () => void;
  onConnected: (ticket: FabricVncSessionTicket, win: Window | null) => void;
  onChanged: () => void;
}) {
  const ownKey = `fabric/${agent.id}/${target.id}`;
  const [savedExists, setSavedExists] = useState(target.hasCredential);
  const [credOptions, setCredOptions] = useState<{ key: string; label: string }[]>([]);
  const [credSource, setCredSource] = useState(target.hasCredential ? ownKey : 'manual');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [save, setSave] = useState(false);
  const [saveAs, setSaveAs] = useState('');
  const [saveScope, setSaveScope] = useState<SaveScope>('machine');
  const [newTab, setNewTab] = useState(prefNewTab());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isManual = credSource === 'manual';

  useEffect(() => {
    api
      .get<{ key: string; label: string }[]>('/api/fabric/credentials?kind=vnc')
      .then((list) => setCredOptions(list.filter((c) => c.key !== ownKey)))
      .catch(() => setCredOptions([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    setErr(null);
    let body: FabricVncConnectInput;
    if (credSource === ownKey) body = { useSaved: true };
    else if (!isManual) body = { secretRef: credSource };
    else {
      const saving = save && canManage && !!password;
      body = {
        username: username.trim() || undefined,
        password: password || undefined,
        save: saving,
        saveAs: saveScope === 'reusable' ? saveAs.trim() || undefined : undefined,
      };
    }
    const win = newTab ? window.open('about:blank', '_blank') : null;
    setBusy(true);
    try {
      const ticket = await api.post<FabricVncSessionTicket>(
        `/api/fabric/agents/${agent.id}/targets/${target.id}/vnc-session`,
        body,
      );
      if (isManual && save && canManage && password) onChanged();
      onConnected(ticket, win);
    } catch (e) {
      win?.close();
      setErr(e instanceof ApiError ? e.message : 'Failed to open VNC session.');
      setBusy(false);
    }
  };

  const forget = async () => {
    if (!confirm('Forget the saved credential for this target?')) return;
    try {
      await api.delete(`/api/fabric/agents/${agent.id}/targets/${target.id}/credential`);
      setSavedExists(false);
      if (credSource === ownKey) setCredSource('manual');
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to remove credential.');
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Connect to ${agent.name}`}
      description={`VNC · ${target.host}:${target.port}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Monitor className="h-4 w-4 mr-1" />}
            Connect
          </Button>
        </>
      }
    >
      {err && (
        <div className="mb-4 text-sm rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2">{err}</div>
      )}
      <div className="space-y-4">
        <div>
          <Label>Credential</Label>
          <select className={selectCls} value={credSource} onChange={(e) => setCredSource(e.target.value)}>
            {savedExists && <option value={ownKey}>Saved for this machine</option>}
            {credOptions.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
            <option value="manual">Enter manually…</option>
          </select>
          {savedExists && credSource === ownKey && canManage && (
            <button type="button" className="mt-1 text-xs text-muted-foreground hover:text-destructive" onClick={forget}>
              Forget saved credential
            </button>
          )}
        </div>

        {isManual && (
          <>
            <p className="text-xs text-muted-foreground -mb-1">
              macOS Screen Sharing needs the Mac account username + password. Leave blank for a legacy
              password-only VNC server (you'll be prompted in the viewer).
            </p>
            <div>
              <Label>Username (macOS account)</Label>
              <Input value={username} placeholder="e.g. ember" onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div>
              <Label>Password</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {canManage && password && (
              <SaveCredentialFields
                save={save} setSave={setSave}
                scope={saveScope} setScope={setSaveScope}
                saveAs={saveAs} setSaveAs={setSaveAs}
                idPrefix="vnc"
              />
            )}
          </>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={newTab} onChange={(e) => setNewTab(e.target.checked)} />
          Open in a new browser tab
        </label>
      </div>
    </Dialog>
  );
}

// ── SFTP file browser ────────────────────────────────────────────────────────

function joinPath(dir: string, name: string): string {
  if (dir === '/') return `/${name}`;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

function parentPath(p: string): string {
  const s = p.replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * A file browser + transfer panel for a host, over SFTP (the same SSH connection
 * the terminal uses, tunnelled through the agent). Step 1 authenticates (reusing
 * the credential picker); step 2 browses/uploads/downloads.
 */
function FilesBrowser({
  agent,
  target,
  onClose,
}: {
  agent: FabricAgentDto;
  target: FabricTargetDto;
  onClose: () => void;
}) {
  const ownKey = `fabric/${agent.id}/${target.id}`;
  const [phase, setPhase] = useState<'connect' | 'browsing'>('connect');
  // connect state (mirrors SshConnectDialog)
  const [credOptions, setCredOptions] = useState<{ key: string; label: string }[]>([]);
  const [credSource, setCredSource] = useState(target.hasCredential ? ownKey : 'manual');
  const [username, setUsername] = useState('root');
  const [method, setMethod] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isManual = credSource === 'manual';
  // browse state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [listing, setListing] = useState<FabricSftpListing | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .get<{ key: string; label: string }[]>('/api/fabric/credentials?kind=ssh')
      .then((list) => setCredOptions(list.filter((c) => c.key !== ownKey)))
      .catch(() => setCredOptions([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Best-effort close the SFTP session when the panel unmounts.
  const sessionRef = useRef<string | null>(null);
  useEffect(() => { sessionRef.current = sessionId; }, [sessionId]);
  useEffect(
    () => () => {
      const id = sessionRef.current;
      if (id) api.post(`/api/fabric/sftp/${id}/close`).catch(() => {});
    },
    [],
  );

  const connect = async () => {
    setErr(null);
    let body: FabricSshConnectInput;
    if (!isManual) {
      body = credSource === ownKey ? { useSaved: true } : { secretRef: credSource };
    } else {
      if (!username.trim()) return setErr('A username is required.');
      if (method === 'password' ? !password : !privateKey.trim()) {
        return setErr(method === 'password' ? 'Enter a password.' : 'Paste a private key.');
      }
      body =
        method === 'password'
          ? { username: username.trim(), password }
          : { username: username.trim(), privateKey, passphrase: passphrase || undefined };
    }
    setBusy(true);
    try {
      const res = await api.post<FabricSftpOpenResult>(
        `/api/fabric/agents/${agent.id}/targets/${target.id}/sftp/open`,
        body,
      );
      setSessionId(res.sessionId);
      setListing(res.listing);
      setPhase('browsing');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to open the file session.');
    } finally {
      setBusy(false);
    }
  };

  const navigate = async (path: string) => {
    if (!sessionId) return;
    setLoadingList(true);
    setErr(null);
    try {
      setListing(await api.post<FabricSftpListing>(`/api/fabric/sftp/${sessionId}/ls`, { path }));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to list directory.');
    } finally {
      setLoadingList(false);
    }
  };

  const openEntry = (e: FabricSftpEntry) => {
    if (!listing) return;
    if (e.type === 'dir' || e.type === 'link') navigate(joinPath(listing.path, e.name));
  };

  const download = (e: FabricSftpEntry) => {
    if (!listing || !sessionId) return;
    const url = `/api/fabric/sftp/${sessionId}/download?path=${encodeURIComponent(joinPath(listing.path, e.name))}`;
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const doUpload = async (files: FileList | null) => {
    if (!files || !files.length || !listing || !sessionId) return;
    setUploading(true);
    setErr(null);
    try {
      for (const f of Array.from(files)) {
        const res = await fetch(
          `/api/fabric/sftp/${sessionId}/upload?dir=${encodeURIComponent(listing.path)}&name=${encodeURIComponent(f.name)}`,
          { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: f },
        );
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          throw new Error(t ? (JSON.parse(t).message ?? res.statusText) : res.statusText);
        }
      }
      await navigate(listing.path);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const mkdir = async () => {
    if (!listing || !sessionId) return;
    const name = window.prompt('New folder name:');
    if (!name?.trim()) return;
    try {
      await api.post(`/api/fabric/sftp/${sessionId}/mkdir`, { path: joinPath(listing.path, name.trim()) });
      await navigate(listing.path);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to create folder.');
    }
  };

  const rename = async (e: FabricSftpEntry) => {
    if (!listing || !sessionId) return;
    const next = window.prompt(`Rename "${e.name}" to:`, e.name);
    if (!next?.trim() || next === e.name) return;
    try {
      await api.post(`/api/fabric/sftp/${sessionId}/rename`, {
        from: joinPath(listing.path, e.name),
        to: joinPath(listing.path, next.trim()),
      });
      await navigate(listing.path);
    } catch (err2) {
      setErr(err2 instanceof ApiError ? err2.message : 'Rename failed.');
    }
  };

  const remove = async (e: FabricSftpEntry) => {
    if (!listing || !sessionId) return;
    if (!confirm(`Delete "${e.name}"? This cannot be undone.`)) return;
    try {
      await api.post(`/api/fabric/sftp/${sessionId}/rm`, {
        path: joinPath(listing.path, e.name),
        dir: e.type === 'dir',
      });
      await navigate(listing.path);
    } catch (err2) {
      setErr(err2 instanceof ApiError ? err2.message : 'Delete failed.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex flex-col">
      <div className="h-12 shrink-0 bg-sidebar border-b border-border flex items-center justify-between px-4">
        <span className="text-sm inline-flex items-center gap-2 min-w-0">
          <FolderOpen className="h-4 w-4 text-primary shrink-0" />
          <span className="text-muted-foreground">Files ·</span>
          <span className="truncate">{agent.name}</span>
        </span>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4 mr-1" /> Close
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-3xl">
          {err && (
            <div className="mb-3 text-sm rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2">
              {err}
            </div>
          )}

          {phase === 'connect' ? (
            <Card>
              <CardContent className="p-5 space-y-4">
                <p className="text-sm text-muted-foreground">
                  Connect over SFTP to <code className="text-foreground/80">{target.host}:{target.port}</code> to browse and transfer files.
                </p>
                <div>
                  <Label>Credential</Label>
                  <select className={selectCls} value={credSource} onChange={(e) => setCredSource(e.target.value)}>
                    {target.hasCredential && <option value={ownKey}>Saved for this machine</option>}
                    {credOptions.map((c) => (
                      <option key={c.key} value={c.key}>{c.label}</option>
                    ))}
                    <option value="manual">Enter manually…</option>
                  </select>
                </div>
                {isManual && (
                  <>
                    <div>
                      <Label>Username</Label>
                      <Input value={username} onChange={(e) => setUsername(e.target.value)} />
                    </div>
                    <div>
                      <Label>Authentication</Label>
                      <select className={selectCls} value={method} onChange={(e) => setMethod(e.target.value as 'password' | 'key')}>
                        <option value="password">Password</option>
                        <option value="key">Private key</option>
                      </select>
                    </div>
                    {method === 'password' ? (
                      <div>
                        <Label>Password</Label>
                        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                      </div>
                    ) : (
                      <>
                        <div>
                          <Label>Private key</Label>
                          <textarea
                            className="mt-1 w-full h-28 rounded-md border border-input bg-background/60 px-2 py-1.5 text-xs font-mono"
                            value={privateKey}
                            onChange={(e) => setPrivateKey(e.target.value)}
                            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                          />
                        </div>
                        <div>
                          <Label>Passphrase (optional)</Label>
                          <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
                        </div>
                      </>
                    )}
                  </>
                )}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                  <Button onClick={connect} disabled={busy}>
                    {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FolderOpen className="h-4 w-4 mr-1" />}
                    Open files
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div>
              {/* Toolbar */}
              <div className="flex items-center gap-2 mb-3">
                <Button variant="outline" size="icon" className="h-8 w-8" title="Up a level"
                  onClick={() => listing && navigate(parentPath(listing.path))}
                  disabled={loadingList || listing?.path === '/'}>
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" className="h-8 w-8" title="Refresh"
                  onClick={() => listing && navigate(listing.path)} disabled={loadingList}>
                  {loadingList ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                </Button>
                <code className="flex-1 min-w-0 truncate text-xs bg-muted/40 rounded px-2 py-1.5 border border-border/60">
                  {listing?.path}
                </code>
                <Button variant="outline" size="sm" onClick={mkdir} disabled={loadingList}>
                  <FolderPlus className="h-4 w-4 mr-1" /> New folder
                </Button>
                <Button size="sm" onClick={() => fileInput.current?.click()} disabled={uploading || loadingList}>
                  {uploading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Upload className="h-4 w-4 mr-1" />}
                  Upload
                </Button>
                <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => doUpload(e.target.files)} />
              </div>

              <div className="rounded-md border border-border/60 divide-y divide-border/60 bg-card/40">
                {listing && listing.entries.length === 0 && (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">Empty directory</div>
                )}
                {listing?.entries.map((e) => {
                  const navigable = e.type === 'dir' || e.type === 'link';
                  return (
                    <div key={e.name} className="flex items-center gap-3 px-3 py-1.5 text-sm group">
                      <button
                        type="button"
                        className={`flex items-center gap-2 min-w-0 flex-1 text-left ${navigable ? 'cursor-pointer hover:text-primary' : 'cursor-default'}`}
                        onClick={() => navigable && openEntry(e)}
                        disabled={!navigable}
                      >
                        {e.type === 'dir' ? (
                          <Folder className="h-4 w-4 shrink-0 text-primary" />
                        ) : e.type === 'link' ? (
                          <FileSymlink className="h-4 w-4 shrink-0 text-accent" />
                        ) : (
                          <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate">{e.name}</span>
                      </button>
                      <span className="text-xs text-muted-foreground shrink-0 w-20 text-right hidden sm:block">
                        {e.type === 'file' ? fmtSize(e.size) : ''}
                      </span>
                      <span className="text-xs text-muted-foreground shrink-0 w-36 text-right hidden md:block">
                        {e.mtime ? new Date(e.mtime).toLocaleString() : ''}
                      </span>
                      <span className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                        {e.type === 'file' && (
                          <button type="button" title="Download" className="p-1 hover:text-primary" onClick={() => download(e)}>
                            <Download className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button type="button" title="Rename" className="p-1 hover:text-primary" onClick={() => rename(e)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" title="Delete" className="p-1 hover:text-destructive" onClick={() => remove(e)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
