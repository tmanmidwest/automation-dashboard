import type { PostureAffected, PostureFinding, PostureSeverity, TopologyGraph, TopoNodeType } from '@cerebro/shared';

/**
 * Posture tracking, the pure part: compares a fresh set of findings with what was recorded
 * last time and works out what changed (new findings, items added or gone, fixed findings,
 * snoozes that ran out, accepted risks that got worse). The service applies the plan to
 * the database. Findings themselves are still computed on every map build (posture.ts).
 * See docs/posture.md.
 */

export type ItemStatus = 'open' | 'snoozed' | 'accepted';

export interface ItemRec {
  label: string;
  firstSeenAt: Date;
  goneAt: Date | null;
  status: string;
  until: Date | null;
  note: string | null;
  setBy: string | null;
  setAt: Date | null;
  acceptedSeverity: string | null;
}

export interface FindingRec {
  id: string;
  severity: string;
  title: string;
  firstSeenAt: Date;
  resolvedAt: Date | null;
  items: ItemRec[];
}

export interface PlannedEvent {
  findingId: string;
  kind: string;
  text: string;
  actor?: string;
}

export interface SyncPlan {
  /** Findings to create (never seen) or update (title / severity / snapshot, and un-resolve). */
  upserts: { finding: PostureFinding; create: boolean; reopen: boolean }[];
  /** Items to create. */
  newItems: { findingId: string; label: string }[];
  /** Item fields to change. */
  itemPatches: { findingId: string; label: string; patch: Partial<Omit<ItemRec, 'label' | 'firstSeenAt'>> }[];
  /** Findings no longer found. */
  resolve: string[];
  events: PlannedEvent[];
}

const RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };
const SEV_WORD: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low' };

/** "a, b and 3 more" */
export function listLabels(labels: string[], max = 3): string {
  if (labels.length <= max) return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels[0] ?? '';
  return `${labels.slice(0, max).join(', ')} and ${labels.length - max} more`;
}

/**
 * Works out what changed. `trustGone` is false when this build can't be trusted to say
 * something went away (a connector failed, or the findings didn't compute): then nothing is
 * marked fixed, but new findings and items are still recorded.
 */
export function planSync(findings: PostureFinding[], records: FindingRec[], now: Date, trustGone: boolean): SyncPlan {
  const plan: SyncPlan = { upserts: [], newItems: [], itemPatches: [], resolve: [], events: [] };
  const byId = new Map(records.map((r) => [r.id, r]));
  const current = new Set<string>();

  for (const f of findings) {
    current.add(f.id);
    const rec = byId.get(f.id);
    const labels = [...new Set(f.affected.map((a) => a.label))];
    if (!rec) {
      plan.upserts.push({ finding: f, create: true, reopen: false });
      for (const label of labels) plan.newItems.push({ findingId: f.id, label });
      plan.events.push({ findingId: f.id, kind: 'first_seen', text: labels.length > 1 ? `First seen with ${labels.length} items` : 'First seen' });
      continue;
    }
    const reopen = !!rec.resolvedAt;
    plan.upserts.push({ finding: f, create: false, reopen });
    if (reopen) plan.events.push({ findingId: f.id, kind: 'reappeared', text: 'Found again after it was fixed' });
    if (rec.severity !== f.severity) plan.events.push({ findingId: f.id, kind: 'severity', text: `Severity changed from ${SEV_WORD[rec.severity] ?? rec.severity} to ${SEV_WORD[f.severity]}` });

    const items = new Map(rec.items.map((i) => [i.label, i]));
    const added: string[] = [];
    const back: string[] = [];
    const ended: string[] = [];
    const worse: string[] = [];
    for (const label of labels) {
      const it = items.get(label);
      if (!it) {
        plan.newItems.push({ findingId: f.id, label });
        added.push(label);
        continue;
      }
      if (it.goneAt || reopen) {
        // It went away (or the whole finding was fixed) and came back: whatever was decided about it no longer holds.
        plan.itemPatches.push({ findingId: f.id, label, patch: { goneAt: null, ...(it.status !== 'open' ? reopenPatch() : {}) } });
        back.push(label);
        continue;
      }
      if (it.status !== 'open' && it.until && it.until.getTime() <= now.getTime()) {
        plan.itemPatches.push({ findingId: f.id, label, patch: reopenPatch() });
        ended.push(label);
        continue;
      }
      if (it.status === 'accepted' && it.acceptedSeverity && (RANK[f.severity] ?? 0) > (RANK[it.acceptedSeverity] ?? 0)) {
        plan.itemPatches.push({ findingId: f.id, label, patch: reopenPatch() });
        worse.push(label);
      }
    }
    if (added.length && !reopen) plan.events.push({ findingId: f.id, kind: 'items_added', text: `New: ${listLabels(added)}` });
    if (back.length && !reopen) plan.events.push({ findingId: f.id, kind: 'items_back', text: `Back again: ${listLabels(back)}` });
    if (ended.length) plan.events.push({ findingId: f.id, kind: 'snooze_ended', text: `Snooze or acceptance ran out, open again: ${listLabels(ended)}` });
    if (worse.length) plan.events.push({ findingId: f.id, kind: 'accept_reopened', text: `Got worse since the risk was accepted, open again: ${listLabels(worse)}` });

    if (trustGone) {
      const present = new Set(labels);
      const gone = rec.items.filter((i) => !i.goneAt && !present.has(i.label)).map((i) => i.label);
      for (const label of gone) plan.itemPatches.push({ findingId: f.id, label, patch: { goneAt: now } });
      if (gone.length) plan.events.push({ findingId: f.id, kind: 'items_fixed', text: `Fixed: ${listLabels(gone)}` });
    }
  }

  if (trustGone) {
    for (const r of records) {
      if (current.has(r.id) || r.resolvedAt) continue;
      plan.resolve.push(r.id);
      plan.events.push({ findingId: r.id, kind: 'fixed', text: 'Fixed: no longer found' });
    }
  }
  return plan;
}

function reopenPatch(): Partial<ItemRec> {
  return { status: 'open', until: null, note: null, setBy: null, setAt: null, acceptedSeverity: null };
}

/** Machine-level node types: what "host" means when filtering findings. */
const MACHINE: TopoNodeType[] = ['host', 'pve_node', 'gateway', 'switch', 'ap'];

/** The machines a finding is about: each affected node, or what it runs on. */
export function findingHosts(f: PostureFinding, graph: Pick<TopologyGraph, 'nodes'>): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  for (const a of f.affected) {
    let n = a.nodeId ? byId.get(a.nodeId) : undefined;
    const seen = new Set<string>();
    while (n && !seen.has(n.id)) {
      seen.add(n.id);
      if (MACHINE.includes(n.type)) {
        // An address no connector knows is not a machine worth grouping by.
        if (n.sources.length) out.add(n.label);
        break;
      }
      n = n.parent ? byId.get(n.parent) : undefined;
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** Adds what was recorded (first seen, per-item decisions) to freshly built findings. */
export function annotate(findings: PostureFinding[], records: FindingRec[], graph: Pick<TopologyGraph, 'nodes'>, now: Date = new Date()): PostureFinding[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  return findings.map((f) => {
    const rec = byId.get(f.id);
    const items = new Map(rec?.items.map((i) => [i.label, i]) ?? []);
    const affected: PostureAffected[] = f.affected.map((a) => {
      const it = items.get(a.label);
      const live = it && !it.goneAt && it.status !== 'open' && !(it.until && it.until.getTime() <= now.getTime());
      return {
        ...a,
        status: live ? (it!.status as ItemStatus) : 'open',
        until: live && it!.until ? it!.until.toISOString() : undefined,
        reason: live && it!.note ? it!.note : undefined,
        setBy: live && it!.setBy ? it!.setBy : undefined,
        setAt: live && it!.setAt ? it!.setAt.toISOString() : undefined,
        firstSeenAt: it && !it.goneAt ? it.firstSeenAt.toISOString() : undefined,
      };
    });
    const open = affected.some((a) => a.status === 'open') || !affected.length;
    const snoozed = affected.filter((a) => a.status === 'snoozed');
    const status = open ? 'open' : snoozed.length ? 'snoozed' : 'accepted';
    const wake = snoozed.map((a) => a.until!).filter(Boolean).sort()[0];
    return {
      ...f,
      affected,
      status,
      // Older readers (map badges, exposure) treat any finding with snoozedUntil as set aside.
      snoozedUntil: open ? undefined : wake ?? '9999-12-31T00:00:00.000Z',
      firstSeenAt: rec?.firstSeenAt.toISOString(),
      hosts: findingHosts(f, graph),
    };
  });
}

export const severityRank = (s: PostureSeverity | string) => RANK[s] ?? 0;
