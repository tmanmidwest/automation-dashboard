import type {
  HealthAvailability,
  HealthInventory,
  HealthIssue,
  HealthRole,
  HealthSample,
  HealthStatus,
  HealthThresholds,
} from '@cerebro/shared';

/**
 * Pure health logic (no I/O), shared by the Health page and the alert loop so
 * both always agree. See docs/health-monitoring.md.
 */

/** Auto-detect how a machine should be treated when no operator override is set. */
export function detectRole(inv: HealthInventory | null | undefined, os?: string | null): HealthRole {
  if (inv?.hasBattery) return 'workstation';
  if (inv?.virtRole === 'guest') return 'server';
  const o = (inv?.os ?? os ?? '').toLowerCase();
  if (o === 'darwin') return 'workstation';
  if (o === 'windows') return /server/i.test(inv?.platform ?? '') ? 'server' : 'workstation';
  return 'server';
}

export function normalizeRole(v: unknown): HealthRole | null {
  return v === 'server' || v === 'workstation' ? v : null;
}

/** A recent raw sample, the subset the sustained checks need. */
export interface RecentPoint {
  at: Date;
  cpuPct: number | null;
  memPct: number | null;
}

export interface AssessInput {
  role: HealthRole;
  /** Live Fabric connection (or within its reconnect grace). */
  online: boolean;
  lastSeenAt: Date | null;
  latest: HealthSample | null;
  latestAt: Date | null;
  /** Raw samples from the last max(memMinutes, cpuMinutes), oldest first. */
  recent: RecentPoint[];
  thresholds: HealthThresholds;
  /** Current reporting cadence (seconds); 0 = health collection off. */
  intervalSec: number;
  agentVersion?: string | null;
  now?: Date;
}

export interface Assessment {
  status: HealthStatus;
  score: number | null;
  issues: HealthIssue[];
}

const GB = 1024 ** 3;

export function fmtBytes(n: number): string {
  if (n >= 1024 * GB) return `${(n / (1024 * GB)).toFixed(1)} TB`;
  if (n >= 10 * GB) return `${Math.round(n / GB)} GB`;
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

export function fmtDuration(sec: number): string {
  if (sec < 90) return `${Math.max(1, Math.round(sec))}s`;
  const m = Math.round(sec / 60);
  if (m < 90) return `${m} min`;
  const h = sec / 3600;
  if (h < 48) return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}

/**
 * True when every sample over the last `minutes` is at/above `limit` AND the
 * samples actually cover most of that window — so a single spike, or one sample
 * right after a reconnect, never counts as "sustained".
 */
export function sustained(
  points: RecentPoint[],
  pick: (p: RecentPoint) => number | null,
  limit: number,
  minutes: number,
  intervalSec: number,
  now: Date,
): boolean {
  const since = now.getTime() - minutes * 60_000;
  const inWin = points.filter((p) => p.at.getTime() >= since);
  const expected = (minutes * 60) / Math.max(1, intervalSec);
  if (inWin.length < Math.max(2, Math.floor(expected * 0.6))) return false;
  // Must reach back to near the window start (allow one interval of slack).
  if (inWin[0].at.getTime() > since + Math.max(intervalSec, 30) * 2000) return false;
  return inWin.every((p) => {
    const v = pick(p);
    return v != null && v >= limit;
  });
}

export function assess(i: AssessInput): Assessment {
  const now = i.now ?? new Date();
  const t = i.thresholds;
  const issues: HealthIssue[] = [];

  if (!i.online) {
    const since = i.lastSeenAt ? (now.getTime() - i.lastSeenAt.getTime()) / 1000 : null;
    if (i.role === 'workstation') {
      // Offline is normal for a laptop/desktop: no issue, no score.
      return { status: 'offline', score: null, issues: [] };
    }
    if (since == null || since >= t.offlineMinutes * 60) {
      issues.push({
        key: 'offline',
        severity: 'critical',
        message: since == null ? 'Offline' : `Offline for ${fmtDuration(since)}`,
      });
      return { status: 'critical', score: 0, issues };
    }
  }

  if (!i.latest || !i.latestAt) {
    // Connected but no health data: an agent older than 0.6 (it self-updates on its
    // next connect) or collection switched off.
    return { status: 'unknown', score: null, issues: [] };
  }

  const ageSec = (now.getTime() - i.latestAt.getTime()) / 1000;
  if (i.online && i.intervalSec > 0 && ageSec > Math.max(i.intervalSec * 4, 120)) {
    issues.push({ key: 'stale', severity: 'warning', message: `No health report for ${fmtDuration(ageSec)}` });
  }

  for (const d of i.latest.disks ?? []) {
    const free = Math.max(0, d.totalBytes - d.usedBytes);
    if (d.pct >= t.diskCritPct) {
      issues.push({ key: 'disk', severity: 'critical', subject: d.mount, message: `${d.mount} is ${Math.round(d.pct)}% full (${fmtBytes(free)} free)` });
    } else if (d.pct >= t.diskWarnPct) {
      issues.push({ key: 'disk', severity: 'warning', subject: d.mount, message: `${d.mount} is ${Math.round(d.pct)}% full (${fmtBytes(free)} free)` });
    }
    if (d.inodesPct != null && d.inodesPct >= 90) {
      issues.push({ key: 'inodes', severity: d.inodesPct >= 98 ? 'critical' : 'warning', subject: d.mount, message: `${d.mount} has used ${Math.round(d.inodesPct)}% of its inodes` });
    }
  }

  const iv = i.intervalSec || 30;
  const mem = (p: RecentPoint) => p.memPct;
  if (sustained(i.recent, mem, t.memCritPct, t.memMinutes, iv, now)) {
    issues.push({ key: 'memory', severity: 'critical', message: `Memory above ${t.memCritPct}% for ${t.memMinutes} min (now ${Math.round(i.latest.memPct ?? 0)}%)` });
  } else if (sustained(i.recent, mem, t.memWarnPct, t.memMinutes, iv, now)) {
    issues.push({ key: 'memory', severity: 'warning', message: `Memory above ${t.memWarnPct}% for ${t.memMinutes} min (now ${Math.round(i.latest.memPct ?? 0)}%)` });
  }
  if (sustained(i.recent, (p) => p.cpuPct, t.cpuWarnPct, t.cpuMinutes, iv, now)) {
    issues.push({ key: 'cpu', severity: 'warning', message: `CPU above ${t.cpuWarnPct}% for ${t.cpuMinutes} min (now ${Math.round(i.latest.cpuPct ?? 0)}%)` });
  }

  const crit = issues.filter((x) => x.severity === 'critical').length;
  const warn = issues.length - crit;
  const score = Math.max(0, 100 - crit * 40 - warn * 15);
  const status: HealthStatus = crit ? 'critical' : warn ? 'warning' : 'ok';
  // Critical issues first, then by kind.
  issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
  return { status, score, issues };
}

/** Online/offline over a window. `coveredFrom` = when the agent was enrolled. */
export function availability(windowSec: number, onlineSec: number, now: Date, coveredFrom: Date): HealthAvailability {
  const coverable = Math.max(0, Math.min(windowSec, (now.getTime() - coveredFrom.getTime()) / 1000));
  const online = Math.round(Math.min(onlineSec, coverable));
  const offline = Math.round(Math.max(0, coverable - online));
  return {
    windowSec,
    onlineSec: online,
    offlineSec: offline,
    pct: coverable > 0 ? Math.round((online / coverable) * 1000) / 10 : null,
  };
}

// ── Sanitizing what the agent sends ─────────────────────────────────────────

function num(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;
}
function str(v: unknown, max = 256): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}

/** Validate + clamp one agent sample. Returns null when unusable. */
export function sanitizeSample(raw: unknown): HealthSample | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const at = num(r.at, 0);
  if (!at) return null;
  const pct = (v: unknown) => num(v, 0, 100);
  const disks = Array.isArray(r.disks)
    ? r.disks.slice(0, 32).flatMap((d) => {
        if (!d || typeof d !== 'object') return [];
        const x = d as Record<string, unknown>;
        const mount = str(x.mount, 200);
        const p = pct(x.pct);
        if (!mount || p == null) return [];
        return [{
          mount,
          device: str(x.device, 200),
          fs: str(x.fs, 40),
          totalBytes: num(x.totalBytes) ?? 0,
          usedBytes: num(x.usedBytes) ?? 0,
          pct: p,
          inodesPct: pct(x.inodesPct),
        }];
      })
    : undefined;
  return {
    at,
    spanSec: Math.round(num(r.spanSec, 1, 3600) ?? 30),
    cpuPct: pct(r.cpuPct),
    cpuMaxPct: pct(r.cpuMaxPct),
    load1: num(r.load1, 0, 100000),
    load5: num(r.load5, 0, 100000),
    load15: num(r.load15, 0, 100000),
    memTotal: num(r.memTotal),
    memUsed: num(r.memUsed),
    memPct: pct(r.memPct),
    swapTotal: num(r.swapTotal),
    swapUsed: num(r.swapUsed),
    swapPct: pct(r.swapPct),
    disks,
    diskReadBps: num(r.diskReadBps),
    diskWriteBps: num(r.diskWriteBps),
    netRxBps: num(r.netRxBps),
    netTxBps: num(r.netTxBps),
    uptimeSec: num(r.uptimeSec),
    procs: num(r.procs, 0, 10_000_000),
  };
}

export function sanitizeInventory(raw: unknown): HealthInventory | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const strs = (v: unknown, n: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, n).map((x) => x.slice(0, 64)) : undefined);
  return {
    hostname: str(r.hostname),
    os: str(r.os, 32) ?? 'unknown',
    arch: str(r.arch, 32) ?? '',
    platform: str(r.platform),
    platformVersion: str(r.platformVersion),
    platformFamily: str(r.platformFamily),
    kernelVersion: str(r.kernelVersion),
    cpuModel: str(r.cpuModel),
    cpuCores: num(r.cpuCores, 0, 4096),
    cpuThreads: num(r.cpuThreads, 0, 8192),
    memTotal: num(r.memTotal),
    virtSystem: str(r.virtSystem, 40),
    virtRole: str(r.virtRole, 20),
    hasBattery: r.hasBattery === true,
    bootTime: num(r.bootTime),
    macs: strs(r.macs, 32),
    ips: strs(r.ips, 32),
  };
}

/** Fullest filesystem's used %, for the flat sample row. */
export function worstDiskPct(s: HealthSample): number | null {
  const ds = s.disks ?? [];
  return ds.length ? Math.max(...ds.map((d) => d.pct)) : null;
}
