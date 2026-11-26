import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, ShieldAlert } from 'lucide-react';
import type { OsUpdateCve, OsUpdateMachine, OsUpdatePackage } from '@cerebro/shared';
import { osUpdateAdvisoryLink, osUpdateCveLinks } from '@cerebro/shared';
import { cn } from '@/lib/utils';
import { HELD_BACK_HELP, PRIORITY_STYLE, PriorityBadge } from './updates-ui';

/** Pending packages on a machine's Updates card, most urgent first, with the CVEs each fixes. docs/os-updates.md#severity-and-cves */

const pct = (x: number | null | undefined) => (x == null ? null : x >= 0.1 ? `${Math.round(x * 100)}%` : `${(x * 100).toFixed(1)}%`);

function CveChip({ id, info, m }: { id: string; info: OsUpdateCve | undefined; m: OsUpdateMachine }) {
  const url = osUpdateCveLinks(id, m.manager, m.distro?.id)[0]?.url;
  const tone = info?.kev ? PRIORITY_STYLE['patch-now'].chip : (info?.cvss ?? 0) >= 9 ? PRIORITY_STYLE.critical.chip : (info?.cvss ?? 0) >= 7 ? PRIORITY_STYLE.important.chip : 'border-border text-muted-foreground';
  const title = [
    info?.kev ? `Known exploited (CISA KEV)${info.kev.dueDate ? `, CISA due ${info.kev.dueDate}` : ''}` : null,
    info?.cvss != null ? `CVSS ${info.cvss.toFixed(1)}` : null,
    info?.priority ? `vendor priority ${info.priority}` : null,
    info?.epss != null ? `EPSS ${pct(info.epss)} chance of exploitation in 30 days` : null,
    info?.summary,
  ].filter(Boolean).join(' · ');
  return (
    <a href={url} target="_blank" rel="noreferrer" title={title || id}
      className={cn('inline-flex items-center gap-1 rounded border px-1 py-px font-mono text-[10.5px] hover:underline whitespace-nowrap', tone)}>
      {info?.kev && <ShieldAlert className="h-3 w-3" />}{id}{info?.cvss != null && <span className="opacity-70">{info.cvss.toFixed(1)}</span>}
    </a>
  );
}

export function UpdatesPackages({ pkgs, cves, m }: { pkgs: OsUpdatePackage[]; cves: Record<string, OsUpdateCve>; m: OsUpdateMachine }) {
  const [onlySec, setOnlySec] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const shown = onlySec ? pkgs.filter((p) => p.security || (p.priority && p.priority !== 'regular')) : pkgs;
  const toggle = (k: string) => setExpanded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const anyCves = pkgs.some((p) => p.cves?.length);
  return (
    <div className="mt-2">
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
        <input type="checkbox" checked={onlySec} onChange={(e) => setOnlySec(e.target.checked)} /> Security fixes only
      </label>
      <div className="max-h-[28rem] overflow-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-muted-foreground sticky top-0 z-10">
            <tr>
              <th className="text-left font-medium px-2 py-1.5">Priority</th>
              <th className="text-left font-medium px-2 py-1.5">Name</th>
              <th className="text-left font-medium px-2 py-1.5">Installed → available</th>
              {anyCves && <th className="text-left font-medium px-2 py-1.5">Fixes</th>}
              <th className="text-left font-medium px-2 py-1.5">Notes</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p, i) => {
              const key = `${p.name}-${i}`;
              const list = p.cves ?? [];
              const kevFirst = [...list].sort((a, b) => Number(!!cves[b]?.kev) - Number(!!cves[a]?.kev) || (cves[b]?.cvss ?? -1) - (cves[a]?.cvss ?? -1));
              const hasMore = list.length > 0 || (p.advisories?.length ?? 0) > 0;
              const open = expanded.has(key);
              return (
                <Fragment key={key}>
                  <tr className={cn('border-t border-border align-top', hasMore && 'cursor-pointer hover:bg-muted/30')} onClick={() => hasMore && toggle(key)}>
                    <td className="px-2 py-1">
                      <PriorityBadge p={p.priority ?? (p.security ? 'security' : 'regular')} />
                    </td>
                    <td className="px-2 py-1 font-mono break-all">
                      <span className="inline-flex items-start gap-0.5">
                        {hasMore && (open ? <ChevronDown className="h-3 w-3 mt-0.5 shrink-0" /> : <ChevronRight className="h-3 w-3 mt-0.5 shrink-0" />)}
                        <span>{p.name}{p.kb && <span className="text-muted-foreground"> · {p.kb}</span>}</span>
                      </span>
                    </td>
                    <td className="px-2 py-1 font-mono">
                      <span className="text-muted-foreground">{p.current ?? (p.kb ? '' : 'new')}</span>{p.current || p.available ? ' → ' : ''}{p.available ?? ''}
                    </td>
                    {anyCves && (
                      <td className="px-2 py-1">
                        <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
                          {kevFirst.slice(0, 3).map((c) => <CveChip key={c} id={c} info={cves[c]} m={m} />)}
                          {list.length > 3 && <button className="text-muted-foreground hover:text-foreground" onClick={() => toggle(key)}>+{list.length - 3}</button>}
                        </div>
                      </td>
                    )}
                    <td className="px-2 py-1">
                      {p.severity && <span className="text-muted-foreground">{p.severity}</span>}
                      {p.epss != null && p.epss >= 0.1 && <span className="text-red-300" title="EPSS: chance this gets exploited in the next 30 days">{p.severity ? ' · ' : ''}EPSS {pct(p.epss)}</span>}
                      {p.restart && <span className="text-muted-foreground"> · restart</span>}
                      {p.needsUser && <span className="text-sky-300"> · needs someone at the Mac</span>}
                      {p.heldBack && <span className="text-muted-foreground" title={HELD_BACK_HELP}> · held back</span>}
                    </td>
                  </tr>
                  {open && (
                    <tr className="bg-muted/20">
                      <td colSpan={anyCves ? 5 : 4} className="px-3 py-2">
                        {(p.advisories?.length ?? 0) > 0 && (
                          <p className="mb-1.5">
                            <span className="text-muted-foreground">Advisories: </span>
                            {p.advisories!.map((a, j) => {
                              const url = osUpdateAdvisoryLink(a);
                              return <Fragment key={a}>{j > 0 && ', '}{url ? <a className="text-sky-300 hover:underline" href={url} target="_blank" rel="noreferrer">{a}</a> : a}</Fragment>;
                            })}
                            {p.kb && osUpdateAdvisoryLink(p.kb) && <>{' · '}<a className="text-sky-300 hover:underline" href={osUpdateAdvisoryLink(p.kb)!} target="_blank" rel="noreferrer">{p.kb}</a></>}
                          </p>
                        )}
                        {kevFirst.length > 0 && (
                          <table className="w-full">
                            <tbody>
                              {kevFirst.map((c) => {
                                const info = cves[c];
                                return (
                                  <tr key={c} className="align-top">
                                    <td className="py-0.5 pr-3 font-mono whitespace-nowrap">{c}</td>
                                    <td className="py-0.5 pr-3 whitespace-nowrap">
                                      {info?.kev && <span className="text-red-300 font-medium">Known exploited{info.kev.dueDate ? ` · CISA due ${info.kev.dueDate}` : ''}{info.kev.ransomware ? ' · used by ransomware' : ''} · </span>}
                                      {info?.cvss != null ? `CVSS ${info.cvss.toFixed(1)}` : 'no score'}
                                      {info?.priority ? ` · ${info.priority}` : ''}
                                      {info?.epss != null ? ` · EPSS ${pct(info.epss)}` : ''}
                                    </td>
                                    <td className="py-0.5 pr-3 text-muted-foreground">{info?.kev?.name ?? info?.summary ?? ''}</td>
                                    <td className="py-0.5 whitespace-nowrap text-right">
                                      {osUpdateCveLinks(c, m.manager, m.distro?.id).map((l) => (
                                        <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="ml-2 text-sky-300 hover:underline inline-flex items-center gap-0.5">{l.label}<ExternalLink className="h-3 w-3" /></a>
                                      ))}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!shown.length && <p className="p-3 text-xs text-muted-foreground">No security fixes pending.</p>}
      </div>
    </div>
  );
}
