import { useEffect, useState } from 'react';
import { BellOff, Bell, ExternalLink, ChevronDown, ChevronRight, Crosshair, ShieldCheck, X } from 'lucide-react';
import type { ImageScanSummary, OutsideInSummary, PostureCategory, PostureFinding, PostureSeverity } from '@cerebro/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/components/ui/button';

/**
 * Security posture findings on the Architecture Map: the "Posture findings" tile's
 * list, the badge tiles carry, and the Findings section in an open row.
 * Findings are computed server-side (apps/server/src/topology/posture.ts).
 */

export const SEV_LABEL: Record<PostureSeverity, string> = { high: 'High', medium: 'Medium', low: 'Low' };
export const SEV_PILL: Record<PostureSeverity, string> = {
  high: 'bg-red-500 text-white',
  medium: 'bg-amber-400 text-slate-900',
  low: 'bg-slate-400/80 text-slate-900 dark:bg-slate-500 dark:text-white',
};
/** Tile tint in Posture view. */
export const SEV_TINT: Record<PostureSeverity, string> = {
  high: 'border-red-500 border-2 bg-red-500/[0.07]',
  medium: 'border-amber-400 border-2 bg-amber-400/[0.07]',
  low: 'border-slate-400/70 bg-slate-400/[0.05]',
};
export const CATEGORY_LABEL: Record<PostureCategory, string> = {
  exposure: 'Exposure',
  encryption: 'Encryption',
  backups: 'Backups',
  patching: 'Patching',
  hygiene: 'Hygiene',
};
const CATEGORIES = Object.keys(CATEGORY_LABEL) as PostureCategory[];

export function SevPill({ severity, count, className }: { severity: PostureSeverity; count?: number; className?: string }) {
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide leading-none whitespace-nowrap', SEV_PILL[severity], className)}>
      {count != null ? `${count} ` : ''}{severity === 'medium' ? 'Med' : SEV_LABEL[severity]}
    </span>
  );
}

/** "2 high · 4 medium · 3 low" for the attention tile. */
export function postureSummary(findings: PostureFinding[]): string {
  const open = findings.filter((f) => !f.snoozedUntil);
  if (!open.length) return 'Nothing to fix right now';
  return (['high', 'medium', 'low'] as const)
    .map((s) => [s, open.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n)
    .map(([s, n]) => `${n} ${s}`)
    .join(' · ');
}

const until = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** One finding: a one-line header that expands to why / fix / affected / snooze. */
export function FindingCard({ f, onShow, onChanged, open: startOpen = false, compact = false }: {
  f: PostureFinding;
  onShow: (nodeId: string) => void;
  onChanged: () => void;
  open?: boolean;
  compact?: boolean;
}) {
  const { can } = useAuth();
  const [open, setOpen] = useState(startOpen);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };
  const snooze = (days: number) => run(() => api.post(`/api/topology/findings/${encodeURIComponent(f.id)}/snooze`, { days }));
  const unsnooze = () => run(() => api.delete(`/api/topology/findings/${encodeURIComponent(f.id)}/snooze`));

  return (
    <div className={cn('rounded-lg border bg-card min-w-0', f.snoozedUntil ? 'border-dashed border-border opacity-80' : f.severity === 'high' ? 'border-red-500/50' : 'border-border')}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className={cn('w-full flex items-center gap-2.5 text-left min-w-0', compact ? 'px-3 py-2' : 'px-3.5 py-2.5')}>
        <SevPill severity={f.severity} />
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground shrink-0 hidden sm:inline">{CATEGORY_LABEL[f.category]}</span>
        <span className="text-sm font-medium min-w-0 flex-1">{f.title}</span>
        {f.snoozedUntil && <span className="text-xs text-muted-foreground shrink-0">snoozed to {until(f.snoozedUntil)}</span>}
        {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
      </button>
      {open && (
        <div className={cn('flex flex-col gap-2.5 text-sm border-t border-border', compact ? 'px-3 py-2.5' : 'px-3.5 py-3')}>
          <p><span className="text-muted-foreground">Why it matters. </span>{f.why}</p>
          <p><span className="text-muted-foreground">Fix. </span>{f.fix}</p>
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">Affected ({f.affected.length})</span>
            <ul className="flex flex-col gap-1">
              {f.affected.map((a, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
                  {a.url && !a.nodeId
                    ? <a className="text-accent hover:underline inline-flex items-center gap-1" href={a.url} target="_blank" rel="noopener noreferrer" title="Opens in a new tab"><ExternalLink className="h-3 w-3" />{a.label}</a>
                    : a.nodeId
                    ? <button className="text-accent hover:underline inline-flex items-center gap-1" onClick={() => onShow(a.nodeId!)} title="Show on the map"><Crosshair className="h-3 w-3" />{a.label}</button>
                    : <span>{a.label}</span>}
                  {a.note && <span className="text-xs text-muted-foreground break-all">{a.note}</span>}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">From {f.source}</span>
            {can('connectors:action') && (
              <span className="ml-auto flex flex-wrap gap-2">
                {f.snoozedUntil ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={unsnooze}><Bell className="h-3.5 w-3.5" /> Unsnooze</Button>
                ) : (
                  <>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => snooze(7)} title="Hide for a week; it comes back early if something new is added to it"><BellOff className="h-3.5 w-3.5" /> Snooze 7 days</Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => snooze(30)}>30 days</Button>
                  </>
                )}
              </span>
            )}
          </div>
          {err && <div className="text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">{err}</div>}
        </div>
      )}
    </div>
  );
}

/** The open row for Needs attention → Posture findings. */
export function PostureRow({ findings, outsideIn, imageScan, onShow, onChanged, onClose }: {
  findings: PostureFinding[];
  outsideIn?: OutsideInSummary;
  imageScan?: ImageScanSummary;
  onShow: (nodeId: string) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [cat, setCat] = useState<PostureCategory | 'all' | 'snoozed'>('all');
  const open = findings.filter((f) => !f.snoozedUntil);
  const snoozed = findings.filter((f) => f.snoozedUntil);
  const shown = cat === 'snoozed' ? snoozed : cat === 'all' ? open : open.filter((f) => f.category === cat);
  const tabs: { key: typeof cat; label: string; n: number }[] = [
    { key: 'all', label: 'All', n: open.length },
    ...CATEGORIES.map((c) => ({ key: c, label: CATEGORY_LABEL[c], n: open.filter((f) => f.category === c).length })).filter((t) => t.n),
    ...(snoozed.length ? [{ key: 'snoozed' as const, label: 'Snoozed', n: snoozed.length }] : []),
  ];

  return (
    <div className="rounded-xl border border-primary/50 bg-primary/[0.04] p-4 flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-base font-semibold">Posture findings</h3>
        <span className="text-sm text-muted-foreground">Worked out from what your connectors report, worst first. Open one for why it matters and how to fix it.</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
      </div>
      <OutsideInLine info={outsideIn} onChanged={onChanged} />
      <ImageScanLine info={imageScan} onChanged={onChanged} />
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={cat === t.key} onClick={() => setCat(t.key)}
            className={cn('rounded-full border px-3 py-1 text-sm', cat === t.key ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
            {t.label} <span className="tabular-nums text-muted-foreground">{t.n}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <div className="text-sm text-muted-foreground flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-500" /> Nothing here.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {shown.map((f, i) => <FindingCard key={f.id} f={f} onShow={onShow} onChanged={onChanged} open={i === 0 && cat === 'all' && f.severity === 'high'} />)}
        </div>
      )}
    </div>
  );
}

/** What the outside-in checks saw, with the on/off switch. */
function OutsideInLine({ info, onChanged }: { info?: OutsideInSummary; onChanged: () => void }) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!info) return null;
  const toggle = async () => {
    const on = !info.enabled;
    if (on === false || window.confirm('Turn on outside-in checks?\n\nCerebro will send your WAN address to Shodan InternetDB and software names (e.g. "postgresql", "proxmox") to endoflife.date and NVD, your domain names to crt.sh, and download the CISA Known Exploited Vulnerabilities list.')) {
      setBusy(true);
      try {
        await api.put('/api/topology/outside-in', { enabled: on });
        onChanged();
      } finally {
        setBusy(false);
      }
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
      <span className="font-medium text-foreground/80">Outside-in checks {info.enabled ? 'on' : 'off'}</span>
      {info.enabled && info.wan.map((w) => (
        <span key={w.ip}>Shodan sees {w.ports.length ? `port${w.ports.length === 1 ? '' : 's'} ${w.ports.join(', ')}` : 'nothing open'} on {w.ip} · checked {new Date(w.checkedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
      ))}
      {info.enabled && !info.wan.length && !info.errors.length && <span>No public WAN address found on the UniFi gateway</span>}
      {info.errors.length > 0 && <span className="text-amber-600 dark:text-amber-300">Couldn't reach {info.errors.join(', ')} (using the last data Cerebro has)</span>}
      {can('connectors:write') && (
        <button className="text-accent hover:underline disabled:opacity-50" disabled={busy} onClick={toggle}>{info.enabled ? 'Turn off' : 'Turn on'}</button>
      )}
    </div>
  );
}

/** Status of the nightly container image CVE scan, with Scan now and the on/off switch. */
function ImageScanLine({ info, onChanged }: { info?: ImageScanSummary; onChanged: () => void }) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const running = !!info?.running;
  // While a scan runs, refresh the map every 15 s so progress and new findings show up.
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(onChanged, 15_000);
    return () => window.clearInterval(t);
  }, [running, onChanged]);
  if (!info) return null;
  const call = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const when = info.lastRunAt ? new Date(info.lastRunAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
      <span className="font-medium text-foreground/80">Image CVE scan {info.enabled ? 'on' : 'off'}</span>
      {info.enabled && !info.available && <span className="text-amber-600 dark:text-amber-300">Trivy isn't installed in this Cerebro image; rebuild the image to enable it</span>}
      {info.enabled && info.available && running && <span>Scanning{info.progress ? ` ${info.progress.done} of ${info.progress.total} images` : ''}…</span>}
      {info.enabled && info.available && !running && (
        <span>
          {when ? `${info.scanned} image${info.scanned === 1 ? '' : 's'} scanned · last run ${when}` : 'Not run yet (runs nightly at 3 am)'}
          {info.failed > 0 && <span className="text-amber-600 dark:text-amber-300"> · {info.failed} couldn't be pulled from their registry</span>}
        </span>
      )}
      {info.enabled && info.available && !running && can('connectors:action') && (
        <button className="text-accent hover:underline disabled:opacity-50" disabled={busy} onClick={() => call(() => api.post('/api/topology/image-scan', {}))}>Scan now</button>
      )}
      {can('connectors:write') && (
        <button className="text-accent hover:underline disabled:opacity-50" disabled={busy} onClick={() => call(() => api.put('/api/topology/image-scan', { enabled: !info.enabled }))}>{info.enabled ? 'Turn off' : 'Turn on'}</button>
      )}
    </div>
  );
}

/** "Findings (n)" at the top of a tile's open row. */
export function FindingsSection({ findings, onShow, onChanged }: { findings: PostureFinding[]; onShow: (nodeId: string) => void; onChanged: () => void }) {
  if (!findings.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">Findings ({findings.length})</span>
      {findings.map((f) => <FindingCard key={f.id} f={f} onShow={onShow} onChanged={onChanged} compact />)}
    </div>
  );
}
