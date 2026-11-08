import { useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, Cloud, Globe } from 'lucide-react';
import type { ExposureEntry, ExposurePath, PostureSeverity } from '@cerebro/shared';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { SevPill } from './Posture';

/**
 * Exposure paths in the Internet row: each way in (WAN port forwards, Cloudflare tunnels)
 * and what it reaches, hop by hop, with the posture findings on each hop. Computed
 * server-side (apps/server/src/topology/exposure.ts).
 */

const DOT: Record<PostureSeverity | 'none', string> = {
  high: 'bg-red-500',
  medium: 'bg-amber-400',
  low: 'bg-slate-400',
  none: 'bg-emerald-500',
};
const HOP_RING: Record<PostureSeverity | 'none', string> = {
  high: 'ring-1 ring-red-500/80',
  medium: 'ring-1 ring-amber-400/80',
  low: '',
  none: '',
};
const RANK: Record<PostureSeverity | 'none', number> = { high: 3, medium: 2, low: 1, none: 0 };

export function ExposureSection({ entries, onShow, onChanged }: { entries: ExposureEntry[]; onShow: (nodeId: string) => void; onChanged: () => void }) {
  if (!entries.length) {
    return <div className="text-sm text-muted-foreground">No port forwards or tunnels reach anything on the map.</div>;
  }
  const paths = entries.reduce((n, e) => n + e.paths.length, 0);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">
        Ways in ({entries.length}) · {paths} path{paths === 1 ? '' : 's'}
      </span>
      {entries.map((e, i) => <Entry key={e.id} e={e} onShow={onShow} onChanged={onChanged} startOpen={i === 0 || e.severity === 'high'} />)}
    </div>
  );
}

function Entry({ e, onShow, onChanged, startOpen }: { e: ExposureEntry; onShow: (nodeId: string) => void; onChanged: () => void; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const lan = (e.hidden ?? []).filter((h) => h.reason === 'lan');
  const marked = (e.hidden ?? []).filter((h) => h.reason === 'marked');
  const Icon = e.kind === 'tunnel' ? Cloud : Globe;
  return (
    <div className="rounded-lg border border-border bg-card">
      <button className="w-full flex flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium font-mono text-[13px]">{e.label}</span>
        {e.severity !== 'none' ? <SevPill severity={e.severity} /> : <span className="text-xs text-emerald-600 dark:text-emerald-400">nothing flagged</span>}
        <span className="text-xs text-muted-foreground">{e.paths.length} path{e.paths.length === 1 ? '' : 's'}</span>
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2.5 flex flex-col gap-2">
          {e.notes.length > 0 && <div className="text-xs text-muted-foreground">{e.notes.join(' · ')}</div>}
          {e.paths.map((p) => <PathRow key={p.id} p={p} onShow={onShow} onChanged={onChanged} />)}
          {lan.length > 0 && (
            <div className="text-xs text-muted-foreground">
              Not shown, LAN-only by access list: {lan.map((h) => h.name).join(', ')}
            </div>
          )}
          {marked.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>Marked internal by you:</span>
              {marked.map((h) => <MarkInternal key={h.name} name={h.name} internal onChanged={onChanged} label={`${h.name} · Undo`} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** "Treat as internal" (or undo): for names only your network can use in a way Cerebro can't see. */
function MarkInternal({ name, internal, onChanged, label }: { name: string; internal: boolean; onChanged: () => void; label: string }) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!can('connectors:write')) return internal ? <span>{name}</span> : null;
  return (
    <button
      className="text-accent hover:underline disabled:opacity-50 whitespace-nowrap"
      disabled={busy}
      title={internal ? 'Show this name as reachable from the internet again' : 'Leave this name out of exposure paths and internet findings'}
      onClick={async () => {
        setBusy(true);
        try {
          await api.put('/api/topology/internal-names', { name, internal: !internal });
          onChanged();
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </button>
  );
}

function PathRow({ p, onShow, onChanged }: { p: ExposurePath; onShow: (nodeId: string) => void; onChanged: () => void }) {
  const flags = p.hops.flatMap((h) => h.flags.map((f) => ({ ...f, hop: h.label })));
  const uniq = flags.filter((f, i) => flags.findIndex((x) => x.findingId === f.findingId) === i).sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  return (
    <div className="flex items-start gap-2.5 min-w-0">
      <span className={cn('mt-1.5 h-2.5 w-2.5 rounded-full shrink-0', DOT[p.severity])} title={p.severity === 'none' ? 'Nothing flagged' : `Worst: ${p.severity}`} />
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex flex-wrap items-center gap-1">
          {p.hops.map((h, i) => {
            const sev = h.flags.reduce<PostureSeverity | 'none'>((a, f) => (RANK[f.severity] > RANK[a] ? f.severity : a), 'none');
            return (
              <span key={`${h.nodeId}-${i}`} className="flex items-center gap-1">
                {i > 0 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
                <button className={cn('rounded bg-muted px-1.5 py-0.5 font-mono text-[12.5px] hover:bg-accent/15', HOP_RING[sev])} onClick={() => onShow(h.nodeId)} title={h.flags.map((f) => f.title).join('\n') || 'Open on the map'}>
                  {h.label}
                </button>
                {h.via && <span className="font-mono text-[12px] text-muted-foreground">{h.via}</span>}
              </span>
            );
          })}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          {(p.notes?.length || uniq.length > 0) && <span>{[...(p.notes ?? []), ...uniq.map((f) => `${f.title}${f.on ? ` (on ${f.on})` : ''}`)].join(' · ')}</span>}
          {p.name && <MarkInternal name={p.name} internal={false} onChanged={onChanged} label="Treat as internal" />}
        </div>
      </div>
    </div>
  );
}
