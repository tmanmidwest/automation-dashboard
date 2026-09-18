import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Radio, Plus, Trash2, ShieldOff, Loader2, Copy, Check, Terminal, MonitorSmartphone,
  Server, CircleDot, TerminalSquare, X, KeyRound,
} from 'lucide-react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import Guacamole from 'guacamole-common-js';
import type {
  FabricAgentDto, FabricEnrollmentDto, FabricAgentStatus, FabricProbeResult, FabricTargetDto,
  FabricSshConnectInput, FabricRdpConnectInput, FabricSessionTicket,
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
  const [enrollment, setEnrollment] = useState<FabricEnrollmentDto | null>(null);
  const [probe, setProbe] = useState<Record<string, { loading?: boolean; result?: FabricProbeResult }>>({});
  const [deletedHint, setDeletedHint] = useState<{ name: string; os?: string | null } | null>(null);
  const [connectFor, setConnectFor] = useState<{ agent: FabricAgentDto; target: FabricTargetDto } | null>(null);
  const [session, setSession] = useState<{ ticket: FabricSessionTicket; title: string } | null>(null);
  const [rdpSession, setRdpSession] = useState<{ ticket: FabricSessionTicket; title: string; dynamicResize: boolean } | null>(null);

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

  useEffect(() => {
    load();
    // Phase 1 has no live push yet — poll to reflect online/offline transitions.
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, []);

  const revoke = async (a: FabricAgentDto) => {
    if (!confirm(`Revoke "${a.name}"? Its credential is destroyed and it can no longer connect.`)) return;
    try {
      await api.post(`/api/fabric/agents/${a.id}/revoke`);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Revoke failed.');
    }
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

  return (
    <div>
      <PageHeader
        title="Fabric"
        description="Agent-brokered remote access. Machines dial out to Cerebro — no inbound RDP/SSH exposure."
        actions={
          <>
            {canConnect && (
              <Button variant="outline" onClick={() => setShowCli(true)}>
                <TerminalSquare className="h-4 w-4 mr-1" /> Command line
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
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {agents.map((a) => {
            const st = STATUS[a.status];
            return (
              <Card key={a.id} className="overflow-hidden">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="font-medium truncate">{a.name}</span>
                      </div>
                      <div className={`flex items-center gap-1.5 text-xs mt-1 ${st.cls}`}>
                        <CircleDot className="h-3.5 w-3.5" /> {st.label}
                        {a.status === 'online' && a.lastSeenAt && (
                          <span className="text-muted-foreground">· {relTime(a.lastSeenAt)}</span>
                        )}
                        {a.status === 'offline' && (
                          <span className="text-muted-foreground">· seen {relTime(a.lastSeenAt)}</span>
                        )}
                      </div>
                    </div>
                    {canManage && (
                      <div className="flex items-center gap-1 shrink-0">
                        {a.status !== 'revoked' && (
                          <Button variant="ghost" size="icon" className="h-8 w-8" title="Revoke" onClick={() => revoke(a)}>
                            <ShieldOff className="h-4 w-4" />
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" className="h-8 w-8" title="Delete" onClick={() => remove(a)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>

                  <dl className="mt-3 space-y-1 text-xs text-muted-foreground">
                    {a.hostname && (
                      <div className="flex gap-2"><dt className="w-16 shrink-0">Host</dt><dd className="truncate text-foreground/80">{a.hostname}</dd></div>
                    )}
                    {(a.os || a.osVersion) && (
                      <div className="flex gap-2"><dt className="w-16 shrink-0">OS</dt><dd className="truncate text-foreground/80">{[a.os, a.osVersion].filter(Boolean).join(' ')}</dd></div>
                    )}
                    {a.agentVersion && (
                      <div className="flex gap-2"><dt className="w-16 shrink-0">Agent</dt><dd className="text-foreground/80">v{a.agentVersion}</dd></div>
                    )}
                  </dl>

                  {a.targets.length > 0 && (
                    <div className="mt-3 space-y-1.5">
                      <div className="flex flex-wrap gap-1.5">
                        {a.targets.map((t) => {
                          const pr = probe[t.id];
                          const online = a.status === 'online';
                          const clickable = online && canConnect;
                          return (
                            <span
                              key={t.id}
                              className="inline-flex items-center rounded-full border border-border/60 bg-muted/40 overflow-hidden"
                            >
                              <button
                                type="button"
                                disabled={!clickable || pr?.loading}
                                onClick={clickable ? () => runProbe(a.id, t) : undefined}
                                title={clickable ? 'Test tunnel' : undefined}
                                className={`inline-flex items-center gap-1 px-2 py-0.5 text-[0.7rem] ${clickable ? 'hover:bg-muted cursor-pointer' : 'cursor-default'}`}
                              >
                                {pr?.loading ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : t.kind === 'rdp' ? (
                                  <MonitorSmartphone className="h-3 w-3" />
                                ) : (
                                  <Terminal className="h-3 w-3" />
                                )}
                                {t.kind.toUpperCase()} :{t.port}
                              </button>
                              {canConnect && (
                                <button
                                  type="button"
                                  disabled={!online}
                                  onClick={online ? () => setConnectFor({ agent: a, target: t }) : undefined}
                                  title={
                                    online
                                      ? `${t.kind === 'rdp' ? 'Open RDP session' : 'Open SSH session'}${t.hasCredential ? ' (vault credential saved)' : ''}`
                                      : 'Agent offline'
                                  }
                                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 border-l border-border/60 ${online ? 'hover:bg-primary/20 cursor-pointer text-primary' : 'opacity-40 cursor-default'}`}
                                >
                                  <TerminalSquare className="h-3 w-3" />
                                  {t.hasCredential && <KeyRound className="h-2.5 w-2.5 opacity-70" />}
                                </button>
                              )}
                            </span>
                          );
                        })}
                      </div>
                      {a.targets.map((t) => {
                        const r = probe[t.id]?.result;
                        if (!r) return null;
                        return (
                          <p key={t.id} className={`text-[0.7rem] ${r.ok ? 'text-emerald-400' : 'text-destructive'}`}>
                            {t.kind.toUpperCase()} :{t.port} —{' '}
                            {r.ok
                              ? `reachable${r.latencyMs != null ? ` (${r.latencyMs}ms)` : ''}${r.banner ? ` · ${r.banner}` : ''}`
                              : r.error || 'unreachable'}
                          </p>
                        );
                      })}
                    </div>
                  )}

                  {a.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {a.tags.map((tag) => (
                        <span key={tag} className="rounded bg-secondary/20 px-1.5 py-0.5 text-[0.65rem] text-secondary-foreground/80">{tag}</span>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {showCli && <CliDialog onClose={() => setShowCli(false)} />}

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
          onConnected={(ticket, opts) => {
            setRdpSession({
              ticket,
              title: `${connectFor.agent.name} · ${connectFor.target.host}:${connectFor.target.port}`,
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
          onConnected={(ticket) => {
            setSession({ ticket, title: `${connectFor.agent.name} · ${connectFor.target.host}:${connectFor.target.port}` });
            setConnectFor(null);
          }}
        />
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
          <Label>Install command ({enrollment.agent.os === 'windows' ? 'Windows PowerShell (admin)' : 'Linux (root)'})</Label>
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
          <Cmd text={`cerebro ls\ncerebro access <machine> ssh\ncerebro access <machine> rdp`} />
          <p className="text-muted-foreground text-xs mt-1">
            Prints a local address + connect hint, then forwards until Ctrl+C.
          </p>
        </div>
      </div>
    </Dialog>
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
  onConnected: (ticket: FabricSessionTicket) => void;
  onChanged: () => void;
}) {
  const [savedExists, setSavedExists] = useState(target.hasCredential);
  const [pinnedExists, setPinnedExists] = useState(target.hostKeyPinned);
  const [useSaved, setUseSaved] = useState(target.hasCredential);
  const [username, setUsername] = useState('root');
  const [method, setMethod] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    let body: FabricSshConnectInput;
    if (useSaved) {
      body = { useSaved: true };
    } else {
      if (!username.trim()) {
        setErr('A username is required.');
        return;
      }
      if (method === 'password' ? !password : !privateKey.trim()) {
        setErr(method === 'password' ? 'Enter a password.' : 'Paste a private key.');
        return;
      }
      body =
        method === 'password'
          ? { username: username.trim(), password, save: save && canManage }
          : { username: username.trim(), privateKey, passphrase: passphrase || undefined, save: save && canManage };
    }
    setBusy(true);
    try {
      const ticket = await api.post<FabricSessionTicket>(
        `/api/fabric/agents/${agent.id}/targets/${target.id}/session`,
        body,
      );
      if (!useSaved && save && canManage) onChanged();
      onConnected(ticket);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to open session.');
      setBusy(false);
    }
  };

  const forget = async () => {
    if (!confirm('Forget the saved credential for this target?')) return;
    try {
      await api.delete(`/api/fabric/agents/${agent.id}/targets/${target.id}/credential`);
      setSavedExists(false);
      setUseSaved(false);
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

        {savedExists && (
          <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 space-y-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={useSaved} onChange={(e) => setUseSaved(e.target.checked)} />
              Use the saved credential from the vault
            </label>
            {canManage && (
              <button type="button" onClick={forget} className="text-xs text-destructive hover:underline">
                Forget saved credential
              </button>
            )}
          </div>
        )}

        {pinnedExists && canManage && (
          <p className="text-xs text-muted-foreground">
            Host key pinned.{' '}
            <button type="button" onClick={resetHostKey} className="text-destructive hover:underline">
              Reset
            </button>{' '}
            if this host was rebuilt.
          </p>
        )}

        {!useSaved && (
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
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
                Save to the vault for next time
              </label>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

function SshTerminal({
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
  onConnected: (ticket: FabricSessionTicket, opts: { dynamicResize: boolean }) => void;
  onChanged: () => void;
}) {
  const [savedExists, setSavedExists] = useState(target.hasCredential);
  const [useSaved, setUseSaved] = useState(target.hasCredential);
  const [username, setUsername] = useState('Administrator');
  const [password, setPassword] = useState('');
  const [domain, setDomain] = useState('');
  const [save, setSave] = useState(false);
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
    if (useSaved) {
      body = { useSaved: true, ...opts };
    } else {
      if (!username.trim()) {
        setErr('A username is required.');
        return;
      }
      if (!password) {
        setErr('A password is required.');
        return;
      }
      body = { username: username.trim(), password, domain: domain.trim() || undefined, save: save && canManage, ...opts };
    }
    setBusy(true);
    try {
      const ticket = await api.post<FabricSessionTicket>(
        `/api/fabric/agents/${agent.id}/targets/${target.id}/rdp-session`,
        body,
      );
      if (!useSaved && save && canManage) onChanged();
      onConnected(ticket, { dynamicResize: resolution === 'fit' });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to open session.');
      setBusy(false);
    }
  };

  const forget = async () => {
    if (!confirm('Forget the saved credential for this target?')) return;
    try {
      await api.delete(`/api/fabric/agents/${agent.id}/targets/${target.id}/credential`);
      setSavedExists(false);
      setUseSaved(false);
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

        {savedExists && (
          <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 space-y-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={useSaved} onChange={(e) => setUseSaved(e.target.checked)} />
              Use the saved credential from the vault
            </label>
            {canManage && (
              <button type="button" onClick={forget} className="text-xs text-destructive hover:underline">
                Forget saved credential
              </button>
            )}
          </div>
        )}

        {!useSaved && (
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
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
                Save to the vault for next time
              </label>
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
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function RdpViewer({
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
