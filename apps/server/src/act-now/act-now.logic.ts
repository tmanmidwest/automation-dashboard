import {
  ACT_NOW_OVERDUE_DAYS,
  OS_UPDATE_PRIORITY_LABEL,
  type ActNowEvidence,
  type ActNowHidden,
  type ActNowItem,
  type ActNowTier,
  type OsUpdateMode,
  type OsUpdatePackage,
  type OsUpdatePriority,
  type PostureFinding,
} from '@cerebro/shared';

/**
 * Act Now (docs/act-now.md): turns update, posture and backup records into one ranked
 * worklist. Pure, so the rules are tested against fixture data; act-now.service.ts only
 * reads the records and hands them over.
 */

const DAY = 86_400_000;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const daysSince = (d: Date | string, now: Date) => Math.max(0, Math.floor((now.getTime() - new Date(d).getTime()) / DAY));
const ago = (d: Date | string, now: Date) => {
  const n = daysSince(d, now);
  return n === 0 ? 'today' : n === 1 ? '1 day ago' : `${n} days ago`;
};
const waiting = (d: Date | string, now: Date) => {
  const n = daysSince(d, now);
  return n === 0 ? 'since today' : `waiting ${plural(n, 'day')}`;
};
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const nvd = (id: string) => `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(id)}`;

/** Fields every item starts with; builders fill in the rest. */
type Draft = Omit<ActNowItem, 'overdue'>;

function finish(d: Draft, now: Date): ActNowItem {
  const overdue = !!d.since && now.getTime() - new Date(d.since).getTime() > ACT_NOW_OVERDUE_DAYS[d.tier] * DAY;
  return { ...d, overdue };
}

/** Worst first: tier, then overdue, EPSS, CVSS, how long it has waited, how much it touches. */
export function compareItems(a: ActNowItem, b: ActNowItem): number {
  return (
    a.tier - b.tier ||
    Number(b.overdue) - Number(a.overdue) ||
    (b.epss ?? -1) - (a.epss ?? -1) ||
    (b.cvss ?? -1) - (a.cvss ?? -1) ||
    (a.since ? new Date(a.since).getTime() : Infinity) - (b.since ? new Date(b.since).getTime() : Infinity) ||
    b.count - a.count ||
    a.title.localeCompare(b.title)
  );
}

// ── OS updates ─────────────────────────────────────────────────────────────

export interface UpdateMachineIn {
  agentId: string;
  name: string;
  online: boolean;
  mode: OsUpdateMode;
  checkedAt: string | null;
  priority: OsUpdatePriority | null;
  restartPriority: OsUpdatePriority | null;
  rebootRequired: boolean;
  rebootReason: string | null;
  rebootSince: string | null;
  securitySince: string | null;
  patchNowSince: string | null;
  kevCves: string[];
  total: number;
  /** Pending packages as stored (with Cerebro's priority / CVEs / scores). */
  packages: OsUpdatePackage[];
  /** The machine sits on an internet exposure path (Architecture Map). */
  exposed: boolean;
}

const URGENT: OsUpdatePriority[] = ['patch-now', 'critical'];
/** A machine whose last update check is older than this gets a note on its row. */
const UPDATE_STALE_DAYS = 2;

export function updateItems(machines: UpdateMachineIn[], now: Date = new Date()): { items: ActNowItem[]; lowerPriority: number } {
  const items: ActNowItem[] = [];
  let lowerPriority = 0;
  for (const m of machines) {
    if (m.mode === 'off') continue;
    const pendingUrgent = m.priority && URGENT.includes(m.priority) ? m.priority : null;
    const restartUrgent = m.rebootRequired && m.restartPriority && URGENT.includes(m.restartPriority) ? m.restartPriority : null;
    if (!pendingUrgent && !restartUrgent) {
      if (m.total > 0) lowerPriority += 1;
      continue;
    }
    const patchNow = pendingUrgent === 'patch-now' || restartUrgent === 'patch-now';
    const tier: ActNowTier = patchNow ? (m.exposed ? 1 : 2) : 4;

    const pkgs = m.packages
      .filter((p) => p.priority && URGENT.includes(p.priority))
      .sort((a, b) => Number(!!b.kev) - Number(!!a.kev) || (b.epss ?? -1) - (a.epss ?? -1) || (b.maxCvss ?? -1) - (a.maxCvss ?? -1) || a.name.localeCompare(b.name));
    const epssList = pkgs.map((p) => p.epss).filter((x): x is number => typeof x === 'number');
    const cvssList = pkgs.map((p) => p.maxCvss).filter((x): x is number => typeof x === 'number');
    const epss = epssList.length ? Math.max(...epssList) : null;
    const cvss = cvssList.length ? Math.max(...cvssList) : null;
    const kevCves = [...new Set(m.kevCves.map((c) => c.toUpperCase()))].sort();

    const starts = [
      pendingUrgent === 'patch-now' ? m.patchNowSince : pendingUrgent ? m.securitySince ?? m.checkedAt : null,
      restartUrgent ? m.rebootSince : null,
    ].filter((x): x is string => !!x);
    const since = starts.length ? starts.sort()[0] : null;

    const title = pendingUrgent
      ? pendingUrgent === 'patch-now'
        ? `${m.name}: ${plural(pkgs.filter((p) => p.kev).length || 1, 'update fixes', 'updates fix')} ${kevCves.length === 1 ? 'a known-exploited CVE' : 'known-exploited CVEs'}`
        : `${m.name}: ${plural(pkgs.length || 1, 'critical update')}`
      : `${m.name} needs a restart to finish a ${restartUrgent === 'patch-now' ? 'known-exploited' : 'critical'} fix`;
    const reason = [
      OS_UPDATE_PRIORITY_LABEL[(pendingUrgent ?? restartUrgent)!],
      m.exposed ? 'internet-facing' : null,
      epss != null ? `EPSS ${pct(epss)}` : null,
      cvss != null ? `CVSS ${cvss.toFixed(1)}` : null,
      pendingUrgent && restartUrgent ? 'restart also needed' : null,
      since ? waiting(since, now) : null,
    ].filter(Boolean).join(' · ');

    const evidence: ActNowEvidence[] = pkgs.slice(0, 12).map((p) => ({
      label: `${p.name}${p.current || p.available ? ` ${p.current ?? '?'} → ${p.available ?? '?'}` : ''}`,
      note: [
        p.priority ? OS_UPDATE_PRIORITY_LABEL[p.priority] : null,
        (p.cves ?? []).slice(0, 3).join(', ') + ((p.cves ?? []).length > 3 ? ` +${(p.cves ?? []).length - 3}` : ''),
        p.maxCvss != null ? `CVSS ${p.maxCvss.toFixed(1)}` : null,
        p.epss != null ? `EPSS ${pct(p.epss)}` : null,
      ].filter(Boolean).join(' · ') || undefined,
      url: p.cves?.[0] ? nvd(p.cves[0]) : undefined,
      kev: p.kev || undefined,
    }));
    if (pkgs.length > 12) evidence.push({ label: `+${pkgs.length - 12} more`, note: 'See the machine’s Updates card' });
    if (restartUrgent) evidence.push({ label: 'Restart needed', note: m.rebootReason ?? `${OS_UPDATE_PRIORITY_LABEL[restartUrgent]} fixes installed but not in effect${m.rebootSince ? ` · ${waiting(m.rebootSince, now)}` : ''}` });

    const why = patchNow
      ? `${pendingUrgent === 'patch-now' ? 'Pending updates fix' : 'Installed updates fix'} CVEs on CISA's Known Exploited Vulnerabilities list, so attackers are already using them.` +
        (m.exposed ? ' This machine is on a path in from the internet.' : '') +
        (restartUrgent === 'patch-now' && !pendingUrgent ? ' The fix is installed but only takes effect after a restart.' : '')
      : 'Critical updates (CVSS 9 or higher, or rated critical by the vendor) are waiting on this machine.' +
        (restartUrgent && !pendingUrgent ? ' They are installed but only take effect after a restart.' : '');
    const fix = pendingUrgent
      ? m.mode === 'report'
        ? 'This machine is set to report only, so install the updates on it by hand, then restart if asked.'
        : 'Install them from the machine’s Updates card (Security only covers them), then restart if asked.'
      : 'Restart the machine from its Updates card during a quiet hour.';

    const staleNote = !m.online
      ? `Machine offline${m.checkedAt ? ` · last checked ${ago(m.checkedAt, now)}` : ''}`
      : m.checkedAt && daysSince(m.checkedAt, now) >= UPDATE_STALE_DAYS
        ? `Last checked ${ago(m.checkedAt, now)}`
        : undefined;

    items.push(finish({
      key: `update:${m.agentId}`,
      tier,
      source: 'updates',
      title,
      reason,
      why,
      fix,
      since: iso(since),
      epss,
      cvss,
      kevCves,
      exposed: m.exposed,
      count: pkgs.length || 1,
      hosts: [m.name],
      evidence,
      links: [{ label: 'Open Updates', to: `/health/${m.agentId}` }, { label: 'All updates', to: '/health?tab=updates' }],
      snooze: { kind: 'act-now', permission: 'fabric:manage' },
      ...(staleNote ? { staleNote } : {}),
    }, now));
  }
  return { items, lowerPriority };
}

// ── Posture ────────────────────────────────────────────────────────────────

/** Posture's own OS-update findings repeat the update items (per machine, with CVEs). */
const SKIP_POSTURE = (id: string) => id.startsWith('os-') || id.startsWith('backup-orphan:');
const VZDUMP = (id: string) => id.startsWith('backup-missing:') || id.startsWith('backup-stale:');
const isOpen = (a: PostureFinding['affected'][number]) => !a.status || a.status === 'open';

export function postureItems(findings: PostureFinding[], exposedNodes: Set<string>, now: Date = new Date()): { items: ActNowItem[]; setAside: ActNowItem[]; lowerSeverity: number } {
  const items: ActNowItem[] = [];
  const setAside: ActNowItem[] = [];
  let lowerSeverity = 0;
  for (const f of findings) {
    if (f.status === 'fixed' || f.resolvedAt || SKIP_POSTURE(f.id)) continue;
    const open = f.affected.filter(isOpen);
    const pool = open.length ? open : f.affected;
    if (!pool.length) continue;
    const kevCves = [...new Set((f.kevCves ?? []).map((c) => c.toUpperCase()))].sort();
    const kev = kevCves.length > 0 || pool.some((a) => a.kev);
    const exposed = pool.some((a) => a.exposed || (!!a.nodeId && exposedNodes.has(a.nodeId)));
    const backup = VZDUMP(f.id);

    let tier: ActNowTier;
    if (kev) tier = exposed ? 1 : 2;
    else if (backup || f.severity === 'high') tier = 4;
    else {
      if (open.length) lowerSeverity += 1;
      continue;
    }

    const evidence: ActNowEvidence[] = pool.slice(0, 15).map((a) => ({
      label: a.label,
      note: a.note,
      url: a.url ?? (a.nodeId ? `/map?node=${encodeURIComponent(a.nodeId)}` : undefined),
      kev: a.kev || undefined,
      exposed: a.exposed || (!!a.nodeId && exposedNodes.has(a.nodeId)) || undefined,
    }));
    if (pool.length > 15) evidence.push({ label: `+${pool.length - 15} more`, note: 'See the finding on the Posture page' });

    const sev = f.severity[0].toUpperCase() + f.severity.slice(1);
    const reason = [
      backup ? null : sev,
      kev ? (kevCves.length ? `${plural(kevCves.length, 'known-exploited CVE')}` : 'known-exploited CVE') : null,
      exposed ? 'internet-facing' : null,
      pool.length > 1 ? plural(pool.length, 'item') : null,
      f.firstSeenAt ? `first seen ${ago(f.firstSeenAt, now)}` : null,
    ].filter(Boolean).join(' · ');

    const item = finish({
      key: `posture:${f.id}`,
      tier,
      source: backup ? 'backups' : 'posture',
      title: f.title,
      reason,
      why: f.why,
      fix: f.fix,
      since: f.firstSeenAt ?? null,
      epss: null,
      cvss: null,
      kevCves,
      exposed,
      count: pool.length,
      hosts: f.hosts ?? [],
      evidence,
      links: [{ label: 'Open in Posture', to: `/posture?f=${encodeURIComponent(f.id)}` }],
      snooze: { kind: 'posture', findingId: f.id, labels: pool.map((a) => a.label) },
    }, now);

    if (open.length) items.push(item);
    else {
      const until = pool.map((a) => a.until).filter((x): x is string => !!x).sort()[0] ?? null;
      setAside.push({ ...item, snoozed: { until, note: pool.find((a) => a.reason)?.reason ?? null, by: pool.find((a) => a.setBy)?.setBy ?? null, at: pool.find((a) => a.setAt)?.setAt ?? null } });
    }
  }
  return { items, setAside, lowerSeverity };
}

// ── Backups ────────────────────────────────────────────────────────────────

export interface BackupTargetIn {
  id: string;
  name: string;
  lastStatus: string;
  lastMessage: string | null;
  lastCheckedAt: Date | null;
  integrityStatus: string;
  integrityMessage: string | null;
  integrityCheckedAt: Date | null;
  /** Stack backups that write to it. */
  stacks: number;
}

export interface BackupPolicyIn {
  id: string;
  stackName: string;
  hostName: string;
  targetName: string;
  enabled: boolean;
  frequency: string;
  /** describeSchedule() text. */
  scheduleText: string;
  /** intervalMs(schedule); 0 for manual. */
  intervalMs: number;
  lastStatus: string;
  lastMessage: string | null;
  createdAt: Date;
  lastSuccess: Date | null;
  /** Failed runs since the last success, and when the first of them started. */
  failures: number;
  failingSince: Date | null;
  verifyStatus: string;
  verifyMessage: string | null;
  verifiedAt: Date | null;
  /** False when the hourly coverage sweep no longer sees the stack on its host. */
  present: boolean;
}

export interface UnprotectedStackIn {
  instanceId: string;
  hostName: string;
  stackName: string;
  firstSeenAt: Date;
}

export interface SystemBackupIn {
  instanceId: string;
  name: string;
  status: string;
  message: string | null;
  startedAt: Date;
  lastSuccess: Date | null;
}

export interface BackupIn {
  targets: BackupTargetIn[];
  policies: BackupPolicyIn[];
  /** New stacks (seen after Cerebro started watching the host) past the grace period with no backup. */
  unprotected: UnprotectedStackIn[];
  /** Stacks that were already there on day one and still have no backup (counted, not listed). */
  baselineUnprotected: number;
  /** Latest backup run of each Backblaze system backup. */
  system: SystemBackupIn[];
}

/** Same factor the stack-backup scheduler alerts on. */
export const BACKUP_STALE_FACTOR = 2.5;

export function backupItems(b: BackupIn, now: Date = new Date()): ActNowItem[] {
  const out: ActNowItem[] = [];
  const base = {
    source: 'backups' as const,
    epss: null,
    cvss: null,
    kevCves: [],
    exposed: false,
    links: [{ label: 'Open Stack Backups', to: '/backups' }],
    snooze: { kind: 'act-now' as const, permission: 'backup:write' as const },
  };

  for (const t of b.targets) {
    const unreachable = t.lastStatus === 'error';
    const integrity = t.integrityStatus === 'error';
    if (!unreachable && !integrity) continue;
    const since = unreachable ? t.lastCheckedAt : t.integrityCheckedAt;
    out.push(finish({
      ...base,
      key: `backup-target:${t.id}`,
      tier: 3,
      title: unreachable ? `Backup repository “${t.name}” can’t be reached` : `Backup repository “${t.name}” failed its data check`,
      reason: [plural(t.stacks, 'stack backs', 'stacks back') + ' up here', since ? `checked ${ago(since, now)}` : null].filter(Boolean).join(' · '),
      why: unreachable
        ? 'Cerebro could not open this restic repository, so every backup that writes to it fails until it is fixed.'
        : 'Reading back part of the stored data found a problem. Restores from this repository may not work.',
      fix: unreachable
        ? 'Check the repository address, password and provider keys on Stack Backups → Targets, then run Check.'
        : 'Open the target on Stack Backups and read the check output. Run a fresh backup of each stack, then check again.',
      since: iso(since),
      count: t.stacks,
      hosts: [],
      evidence: ([
        unreachable && t.lastMessage ? { label: 'Repository check', note: t.lastMessage } : null,
        integrity && t.integrityMessage ? { label: 'Data check', note: t.integrityMessage } : null,
      ] as (ActNowEvidence | null)[]).filter((x): x is ActNowEvidence => !!x),
    }, now));
  }

  for (const p of b.policies) {
    if (!p.enabled || !p.present) continue;
    const lastGood = p.lastSuccess ? `last good backup ${ago(p.lastSuccess, now)}` : 'no good backup yet';
    if (p.lastStatus === 'error') {
      out.push(finish({
        ...base,
        key: `backup-policy:${p.id}`,
        tier: 3,
        title: `${p.stackName} backup failing`,
        reason: [`On ${p.hostName}`, p.failures > 1 ? `last ${p.failures} runs failed` : 'last run failed', lastGood].join(' · '),
        why: `The most recent backup of ${p.stackName} to ${p.targetName} failed${p.failures > 1 ? `, and so did the ${p.failures - 1} before it` : ''}. Until one succeeds, changes since the last good backup can be lost.`,
        fix: 'Open the stack on Stack Backups, read the run log, fix the cause and run Back up now.',
        since: iso(p.failingSince ?? p.lastSuccess),
        count: 1,
        hosts: [p.hostName],
        evidence: p.lastMessage ? [{ label: 'Last run', note: p.lastMessage }] : [],
      }, now));
    } else if (p.frequency !== 'off' && p.intervalMs > 0) {
      const ref = p.lastSuccess ?? p.createdAt;
      if (now.getTime() - ref.getTime() > p.intervalMs * BACKUP_STALE_FACTOR)
        out.push(finish({
          ...base,
          key: `backup-policy:${p.id}`,
          tier: 4,
          title: p.lastSuccess ? `${p.stackName} hasn’t backed up since ${p.lastSuccess.toISOString().slice(0, 10)}` : `${p.stackName} has never backed up`,
          reason: [`On ${p.hostName}`, `scheduled ${p.scheduleText.toLowerCase()}`, lastGood].join(' · '),
          why: 'The schedule should have produced a backup by now, but nothing has succeeded. A scheduled backup that silently stops is only noticed when you need it.',
          fix: 'Check the stack on Stack Backups: run Back up now and look at the result.',
          since: iso(ref),
          count: 1,
          hosts: [p.hostName],
          evidence: [],
        }, now));
    }
    if (p.verifyStatus === 'error')
      out.push(finish({
        ...base,
        key: `backup-verify:${p.id}`,
        tier: 3,
        title: `Test restore of ${p.stackName} failed`,
        reason: [`On ${p.hostName}`, p.verifiedAt ? `tested ${ago(p.verifiedAt, now)}` : null].filter(Boolean).join(' · '),
        why: 'The scheduled test restore could not bring this stack back from its backup into a throwaway copy, so a real restore may fail too.',
        fix: 'Open the stack on Stack Backups, read the test-restore message, fix it and run the test again.',
        since: iso(p.verifiedAt),
        count: 1,
        hosts: [p.hostName],
        evidence: p.verifyMessage ? [{ label: 'Test restore', note: p.verifyMessage }] : [],
      }, now));
  }

  for (const s of b.unprotected)
    out.push(finish({
      ...base,
      key: `stack-unprotected:${s.instanceId}/${s.stackName}`,
      tier: 4,
      title: `New stack “${s.stackName}” has no backup`,
      reason: [`On ${s.hostName}`, `appeared ${ago(s.firstSeenAt, now)}`].join(' · '),
      why: 'This stack appeared after Cerebro started watching the host and still has no backup set up.',
      fix: 'Add it to a backup set or give it its own backup on Stack Backups. If it never needs one, mark it as not needing a backup.',
      since: iso(s.firstSeenAt),
      count: 1,
      hosts: [s.hostName],
      evidence: [],
      snooze: { kind: 'stack-ignore', instanceId: s.instanceId, stackName: s.stackName },
    }, now));

  for (const r of b.system) {
    if (r.status !== 'error') continue;
    out.push(finish({
      ...base,
      key: `system-backup:${r.instanceId}`,
      tier: 3,
      title: `Backup to ${r.name} failed`,
      reason: [`ran ${ago(r.startedAt, now)}`, r.lastSuccess ? `last good backup ${ago(r.lastSuccess, now)}` : 'no good backup yet'].join(' · '),
      why: `The latest backup run on the ${r.name} connector failed.`,
      fix: `Open the ${r.name} connector, read the run message and run the backup again.`,
      since: iso(r.lastSuccess ?? r.startedAt),
      count: 1,
      hosts: [],
      evidence: r.message ? [{ label: 'Last run', note: r.message }] : [],
      links: [{ label: `Open ${r.name}`, to: `/connectors/${r.instanceId}` }],
    }, now));
  }
  return out;
}

// ── Snoozes and assembly ───────────────────────────────────────────────────

export interface SnoozeState {
  key: string;
  until: Date;
  note: string | null;
  setBy: string | null;
  setAt: Date;
  tier: number;
  kevCves: string[];
}

/**
 * Applies Act Now's own snoozes (updates and backups). A snoozed item comes back early
 * when it gets worse: a worse tier, or a known-exploited CVE it didn't have.
 */
export function applySnoozes(items: ActNowItem[], states: SnoozeState[], now: Date = new Date()): { open: ActNowItem[]; snoozed: ActNowItem[] } {
  const byKey = new Map(states.map((s) => [s.key, s]));
  const open: ActNowItem[] = [];
  const snoozed: ActNowItem[] = [];
  for (const it of items) {
    const s = it.snooze.kind === 'act-now' ? byKey.get(it.key) : undefined;
    const known = new Set(s?.kevCves ?? []);
    const holds = !!s && s.until > now && it.tier >= s.tier && it.kevCves.every((c) => known.has(c));
    if (holds) snoozed.push({ ...it, snoozed: { until: s!.until.toISOString(), note: s!.note, by: s!.setBy, at: s!.setAt.toISOString() } });
    else open.push(it);
  }
  return { open, snoozed };
}

export function hiddenCounts(x: { lowerPriorityMachines: number; lowerSeverityFindings: number; baselineUnprotected: number }): ActNowHidden[] {
  return [
    { label: x.lowerPriorityMachines === 1 ? 'machine with lower-priority updates' : 'machines with lower-priority updates', count: x.lowerPriorityMachines, to: '/health?tab=updates' },
    { label: x.lowerSeverityFindings === 1 ? 'medium or low security finding' : 'medium or low security findings', count: x.lowerSeverityFindings, to: '/posture' },
    { label: x.baselineUnprotected === 1 ? 'older stack without a backup' : 'older stacks without a backup', count: x.baselineUnprotected, to: '/backups' },
  ].filter((h) => h.count > 0);
}

/**
 * Exposure paths name the hops in from the internet. A machine counts as internet-facing when
 * it is a hop or runs one (a container's stack and host are its parents on the map).
 */
export function exposedNodeIds(graph: { nodes: { id: string; parent?: string }[]; exposure?: { paths: { hops: { nodeId: string }[] }[] }[] }): Set<string> {
  const parent = new Map(graph.nodes.map((n) => [n.id, n.parent]));
  const out = new Set<string>();
  for (const e of graph.exposure ?? [])
    for (const p of e.paths)
      for (const h of p.hops) {
        let id: string | undefined = h.nodeId;
        for (let guard = 0; id && guard < 8; guard++) {
          if (id.startsWith('net:') || id === 'internet') break;
          out.add(id);
          id = parent.get(id);
        }
      }
  return out;
}
