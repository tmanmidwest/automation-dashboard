import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Loader2, RotateCw, Search, ShieldAlert, Wrench } from 'lucide-react';
import type { OsUpdateMachineDetail } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { fmtAgo } from './health-ui';
import { ACTIVE, HELD_BACK_HELP, InstallDialog, RebootDialog, RepairDialog, RunDialog, RunStatus, UpdatesChip, daysSince, managerLabel, priorityLine, runWhat, runWhen } from './updates-ui';
import { UpdatesPackages } from './UpdatesPackages';

/** The Updates card on a machine's Health page. docs/os-updates.md */
export function UpdatesCard({ agentId, canManage }: { agentId: string; canManage: boolean }) {
  const [d, setD] = useState<OsUpdateMachineDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openPref, setOpenPref] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [install, setInstall] = useState(false);
  const [reboot, setReboot] = useState(false);
  const [repair, setRepair] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);

  async function load() {
    try { setD(await api.get<OsUpdateMachineDetail>(`/api/os-updates/machines/${agentId}`)); setErr(null); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed to load updates.'); }
  }
  const busy = !!d && (d.machine.checking || !!d.machine.installing || d.runs.some((r) => ACTIVE.includes(r.status) && r.status !== 'scheduled'));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [agentId]);
  useEffect(() => {
    const t = setInterval(load, busy ? 4000 : 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, busy]);

  async function checkNow() {
    setChecking(true);
    try {
      await api.post(`/api/os-updates/machines/${agentId}/check`);
      await new Promise((r) => setTimeout(r, 3000));
      await load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Check failed.'); } finally { setChecking(false); }
  }

  if (!d) {
    return <Card className="mb-4"><CardContent className="pt-5 text-sm text-muted-foreground">{err ?? <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading updates…</span>}</CardContent></Card>;
  }
  const m = d.machine;
  // Opens by itself when something on it is urgent.
  const open = openPref ?? (m.priority === 'patch-now' || m.priority === 'critical');
  const setOpen = (v: boolean) => setOpenPref(v);
  const secDays = daysSince(m.securitySince);
  const pkgs = d.packages;
  const sec = pkgs.filter((p) => p.security);
  const why = priorityLine(m, 4);
  const lookingUp = m.checkedAt && pkgs.length > 0 && (!m.enrichedAt || new Date(m.enrichedAt) < new Date(m.checkedAt));
  const heldPkgs = pkgs.filter((p) => p.heldBack).length;
  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle>Updates</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {m.agentTooOld ? `Agent ${m.agentVersion} doesn't report updates yet; it updates itself on its next connect.`
              : m.mode === 'off' ? 'Update checks are turned off on this machine (CEREBRO_OS_UPDATES=off).'
              : m.checkedAt ? `${managerLabel(m.manager)} · checked ${fmtAgo(m.checkedAt)}${m.mode === 'report' ? ' · report only (installs turned off on the machine)' : ''}`
              : m.checking ? 'Checking for the first time…' : 'Not checked yet. The agent checks a minute or so after it starts, then every 6 hours.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 justify-end">
          <Button variant="outline" size="sm" onClick={checkNow} disabled={checking || m.checking || !m.online || m.agentTooOld || m.mode === 'off'}>
            {checking || m.checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Check now
          </Button>
          {canManage && (
            <>
              <Button size="sm" onClick={() => setInstall(true)} disabled={m.agentTooOld || m.mode !== 'on' || !!m.installing}><Download className="h-4 w-4" /> Install…</Button>
              <Button variant="outline" size="sm" onClick={() => setReboot(true)} disabled={m.agentTooOld || m.mode !== 'on' || !!m.installing}><RotateCw className="h-4 w-4" /> Restart…</Button>
              {m.canRepair && (
                <Button variant="outline" size="sm" onClick={() => setRepair(true)} disabled={m.mode !== 'on' || !!m.installing || !m.online} title="Stop a stuck apt and finish half-done package setup">
                  <Wrench className="h-4 w-4" /> Repair…
                </Button>
              )}
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {err && <p className="text-destructive">{err}</p>}
        {m.checkedAt && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <UpdatesChip u={m} className="text-base" />
            {m.security > 0 && secDays != null && <span className={cn('text-xs', secDays >= 7 ? 'text-red-300' : 'text-muted-foreground')}>security updates waiting {secDays === 0 ? 'since today' : `${secDays} day${secDays === 1 ? '' : 's'}`}</span>}
            {m.rebootRequired && <span className="text-xs text-amber-300">{m.rebootReason ?? 'Restart needed'}{m.rebootSince ? ` · since ${fmtAgo(m.rebootSince)}` : ''}. Restart to finish; this clears once the machine is back.</span>}
          </div>
        )}
        {why && (
          <p className={cn('text-xs', m.kevCount > 0 ? 'text-red-300' : 'text-muted-foreground')}>
            {why}{m.kevCount > 0 && '. CISA lists these as exploited in the wild, so install them first (Security only covers them).'}
          </p>
        )}
        {m.rebootRequired && (m.restartPriority === 'patch-now' || m.restartPriority === 'critical') && (
          <p className="text-xs text-red-300">Fixes for {m.restartPriority === 'patch-now' ? 'known-exploited' : 'critical'} CVEs are installed but only take effect after a restart.</p>
        )}
        {lookingUp && <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Checking which CVEs these fix…</p>}
        {m.enrichNote && <p className="text-xs text-muted-foreground">{m.enrichNote}</p>}
        {m.heldBack > 0 && (
          <p className="text-xs text-muted-foreground">
            {m.total === 0 && m.security === 0 ? 'Up to date. ' : ''}{m.heldBack} optional held back: {HELD_BACK_HELP.replace(/^Held back \(optional\): /, '').replace(/^these/, 'they')}
            {!m.canFullUpgrade && ' (Available once the agent has updated itself to 0.8.)'}
          </p>
        )}
        {m.error && <p className="text-xs text-amber-300 flex gap-1"><ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-px" /> {m.error}</p>}
        {m.note && <p className="text-xs text-muted-foreground">{m.note}</p>}
        {m.proxmoxGuest && <p className="text-xs text-muted-foreground">Proxmox {m.proxmoxGuest.kind === 'lxc' ? 'container' : 'VM'} {m.proxmoxGuest.vmid} on {m.proxmoxGuest.instanceName}: installs can take a snapshot first.</p>}

        {pkgs.length > 0 && (
          <div>
            <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {open ? 'Hide' : 'Show'} {pkgs.length} pending{sec.length ? ` (${sec.length} security, most urgent first)` : ''}{heldPkgs ? `, ${heldPkgs} held back` : ''}
            </button>
            {open && <UpdatesPackages pkgs={pkgs} cves={d.cves ?? {}} m={m} />}
          </div>
        )}

        {d.runs.length > 0 && (
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Recent runs</p>
            <div className="divide-y divide-border rounded-md border border-border">
              {d.runs.slice(0, 6).map((r) => (
                <button key={r.id} onClick={() => setRunId(r.id)} className="w-full text-left px-2.5 py-1.5 hover:bg-muted/30 flex flex-wrap gap-x-3 text-xs">
                  <span className="w-28"><RunStatus r={r} /></span>
                  <span>{runWhat(r)}</span>
                  <span className="text-muted-foreground">{r.scheduleName ?? r.requestedBy ?? ''}</span>
                  <span className="text-muted-foreground ml-auto">{runWhen(r)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </CardContent>
      {install && <InstallDialog machines={[m]} onClose={() => setInstall(false)} onDone={(runs) => { load(); if (runs[0]) setRunId(runs[0].id); }} />}
      {repair && <RepairDialog machine={m} onClose={() => setRepair(false)} onDone={(runs) => { load(); if (runs[0]) setRunId(runs[0].id); }} />}
      {reboot && <RebootDialog machines={[m]} onClose={() => setReboot(false)} onDone={() => load()} />}
      {runId && <RunDialog runId={runId} canManage={canManage} onClose={() => setRunId(null)} onChanged={load} />}
    </Card>
  );
}
