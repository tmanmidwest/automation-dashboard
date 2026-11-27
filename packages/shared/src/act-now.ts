// Act Now — one worst-first worklist over Health → Updates, Posture and Stack Backups.
// See docs/act-now.md.

/**
 * 1 exploited & exposed: known-exploited (CISA KEV) and reachable from the internet
 * 2 known exploited: known-exploited, internal
 * 3 backups broken: a repository, backup, test restore or system backup failing
 * 4 critical / high: critical updates, high posture findings, stale or missing backups
 */
export type ActNowTier = 1 | 2 | 3 | 4;
export const ACT_NOW_TIERS: ActNowTier[] = [1, 2, 3, 4];
export const ACT_NOW_TIER_LABEL: Record<ActNowTier, string> = {
  1: 'Exploited & exposed',
  2: 'Known exploited',
  3: 'Backups broken',
  4: 'Critical / high',
};
/** An item open longer than this (days) is overdue and sorts first in its tier. */
export const ACT_NOW_OVERDUE_DAYS: Record<ActNowTier, number> = { 1: 1, 2: 2, 3: 1, 4: 7 };

export type ActNowSource = 'updates' | 'posture' | 'backups';
export const ACT_NOW_SOURCE_LABEL: Record<ActNowSource, string> = { updates: 'Updates', posture: 'Security', backups: 'Backups' };

/** One line of evidence in the detail: a CVE, an affected item, a run message. */
export interface ActNowEvidence {
  label: string;
  note?: string;
  /** Outside link (NVD) or an in-app path. */
  url?: string;
  kev?: boolean;
  exposed?: boolean;
}

export interface ActNowLink {
  label: string;
  /** In-app path, e.g. "/health/<agentId>" or "/posture?f=<id>". */
  to: string;
}

/** How this item is set aside: each source keeps its own snooze where it has one. */
export type ActNowSnoozeVia =
  | { kind: 'act-now'; permission: 'fabric:manage' | 'backup:write' }
  /** POST /api/posture/findings/:id/items with these labels. */
  | { kind: 'posture'; findingId: string; labels: string[] }
  /** PUT /api/stack-backup/coverage/:instanceId/:stackName/ignore ("no backup on purpose"). */
  | { kind: 'stack-ignore'; instanceId: string; stackName: string };

export interface ActNowItem {
  /** Stable, e.g. "update:<agentId>", "posture:<findingId>", "backup-policy:<policyId>". */
  key: string;
  tier: ActNowTier;
  source: ActNowSource;
  title: string;
  /** One line under the title: the facts that put it here. */
  reason: string;
  /** Why it's on the list (the rule it hit), a sentence or two. */
  why: string;
  /** What to do. */
  fix: string;
  /** ISO: when the problem started (first seen, waiting since, last good backup). */
  since: string | null;
  overdue: boolean;
  /** Highest EPSS (0–1) / CVSS among its CVEs, when known. */
  epss: number | null;
  cvss: number | null;
  kevCves: string[];
  /** Reachable from the internet (sits on an exposure path). */
  exposed: boolean;
  /** How many things it touches (packages, affected items, stacks). */
  count: number;
  hosts: string[];
  evidence: ActNowEvidence[];
  /** First is the primary "Open in …" link. */
  links: ActNowLink[];
  snooze: ActNowSnoozeVia;
  /** Set when the source data is old, e.g. "Last checked 3 days ago". */
  staleNote?: string;
  /** Only on items in `snoozed`: until when and by whom. */
  snoozed?: { until: string | null; note?: string | null; by?: string | null; at?: string | null };
}

export interface ActNowSourceStatus {
  source: ActNowSource;
  /** False when the caller lacks the source's read permission (it isn't read at all). */
  allowed: boolean;
  ok: boolean;
  message?: string;
  /** ISO: how fresh the source data is (posture build time, newest update check, …). */
  asOf: string | null;
}

/** Things left off the list on purpose, counted so they aren't forgotten. */
export interface ActNowHidden {
  label: string;
  count: number;
  to: string;
}

export interface ActNowList {
  items: ActNowItem[];
  snoozed: ActNowItem[];
  sources: ActNowSourceStatus[];
  hidden: ActNowHidden[];
  counts: Record<ActNowTier, number>;
  generatedAt: string;
}

export interface ActNowSummary {
  total: number;
  counts: Record<ActNowTier, number>;
  overdue: number;
  top: Pick<ActNowItem, 'key' | 'tier' | 'title' | 'reason' | 'source' | 'overdue'>[];
  generatedAt: string;
}

export interface ActNowSnoozeRequest {
  key: string;
  /** 1–90. */
  days: number;
  note?: string;
}
