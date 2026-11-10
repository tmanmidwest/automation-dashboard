import type {
  OsUpdateAgentRun,
  OsUpdateMode,
  OsUpdatePackage,
  OsUpdateReboot,
  OsUpdateReport,
  OsUpdateRing,
  OsUpdateScheduleInput,
  OsUpdateScope,
  OsUpdateStatus,
  PostureFinding,
} from '@cerebro/shared';
import { OS_UPDATE_REBOOT_GRACE_DAYS, OS_UPDATE_SECURITY_GRACE_DAYS } from '@cerebro/shared';

/**
 * Pure OS-update logic (no I/O): report sanitizing, "waiting since" tracking,
 * schedule timing and posture findings. See docs/os-updates.md.
 */

const DAY_MS = 86_400_000;
export const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SCOPES: OsUpdateScope[] = ['security', 'all'];
const REBOOTS: OsUpdateReboot[] = ['never', 'if-needed', 'always'];
const MODES: OsUpdateMode[] = ['on', 'report', 'off'];

export function isScope(v: unknown): v is OsUpdateScope {
  return SCOPES.includes(v as OsUpdateScope);
}
export function isReboot(v: unknown): v is OsUpdateReboot {
  return REBOOTS.includes(v as OsUpdateReboot);
}

const str = (v: unknown, max = 300): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max)}…` : t;
};
const int = (v: unknown, min = 0, max = 1_000_000): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.min(max, Math.max(min, n));
};

/** Clamp an agent report to known fields and sane sizes. */
export function sanitizeReport(raw: unknown): OsUpdateReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pkgs: OsUpdatePackage[] = [];
  if (Array.isArray(r.packages)) {
    for (const p of r.packages.slice(0, 400)) {
      if (!p || typeof p !== 'object') continue;
      const x = p as Record<string, unknown>;
      const name = str(x.name, 200);
      if (!name) continue;
      const pkg: OsUpdatePackage = { name };
      const cur = str(x.current, 100);
      const avail = str(x.available, 100);
      if (cur) pkg.current = cur;
      if (avail) pkg.available = avail;
      if (x.security === true) pkg.security = true;
      const sev = str(x.severity, 40);
      if (sev) pkg.severity = sev;
      const kb = str(x.kb, 40);
      if (kb) pkg.kb = kb;
      const src = str(x.source, 200);
      if (src) pkg.source = src;
      if (x.restart === true) pkg.restart = true;
      if (x.needsUser === true) pkg.needsUser = true;
      pkgs.push(pkg);
    }
  }
  const lastRun = sanitizeAgentRun(r.lastRun);
  return {
    checkedAt: int(r.checkedAt, 0, 8_640_000_000_000),
    manager: str(r.manager, 40),
    supported: r.supported === true,
    error: str(r.error, 500),
    note: str(r.note, 500),
    packages: pkgs,
    total: int(r.total),
    security: int(r.security),
    securityKnown: r.securityKnown === true,
    rebootRequired: r.rebootRequired === true,
    rebootReason: str(r.rebootReason, 300),
    canInstall: r.canInstall === true,
    proxmox: r.proxmox === true,
    mode: MODES.includes(r.mode as OsUpdateMode) ? (r.mode as OsUpdateMode) : 'on',
    installing: str(r.installing, 64),
    checking: r.checking === true,
    ...(lastRun ? { lastRun } : {}),
  };
}

export function sanitizeAgentRun(raw: unknown): OsUpdateAgentRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const runId = str(r.runId, 64);
  if (!runId) return null;
  return {
    runId,
    kind: r.kind === 'reboot' ? 'reboot' : 'install',
    ok: r.ok === true,
    exitCode: typeof r.exitCode === 'number' && Number.isFinite(r.exitCode) ? Math.round(r.exitCode) : -1,
    message: str(r.message, 1000),
    startedAt: int(r.startedAt, 0, 8_640_000_000_000),
    finishedAt: int(r.finishedAt, 0, 8_640_000_000_000),
    rebooting: r.rebooting === true,
    installed: typeof r.installed === 'number' && r.installed >= 0 ? Math.round(r.installed) : undefined,
  };
}

export interface StoredStatus {
  checkedAt: Date | null;
  manager: string | null;
  supported: boolean;
  error: string | null;
  note: string | null;
  total: number;
  security: number;
  securityKnown: boolean;
  rebootRequired: boolean;
  rebootReason: string | null;
  rebootSince: Date | null;
  securitySince: Date | null;
  canInstall: boolean;
  proxmox: boolean;
  mode: string;
  installing: string | null;
  checking: boolean;
  packages: unknown;
}

/**
 * Fold a report into the stored row. A report sent before the first check has
 * finished (checkedAt 0) only updates the live fields. "Since" times start when
 * security updates / a restart first show up and clear when they're gone.
 */
export function mergeReport(prev: StoredStatus | null, rep: OsUpdateReport, now: Date): StoredStatus {
  const live = { mode: rep.mode, installing: rep.installing ?? null, checking: !!rep.checking };
  if (!rep.checkedAt) {
    return prev
      ? { ...prev, ...live }
      : {
          checkedAt: null, manager: rep.manager ?? null, supported: rep.supported, error: null, note: null, total: 0, security: 0,
          securityKnown: false, rebootRequired: false, rebootReason: null, rebootSince: null, securitySince: null,
          canInstall: rep.canInstall, proxmox: !!rep.proxmox, packages: [], ...live,
        };
  }
  const checkedAt = new Date(Math.min(rep.checkedAt, now.getTime() + 60_000));
  // A failed check keeps the last good numbers (and says why it failed).
  if (rep.error && prev?.checkedAt && !rep.packages.length && !rep.total) {
    return { ...prev, ...live, error: rep.error, note: rep.note ?? prev.note, checkedAt };
  }
  const security = rep.security;
  return {
    checkedAt,
    manager: rep.manager ?? null,
    supported: rep.supported,
    error: rep.error ?? null,
    note: rep.note ?? null,
    total: rep.total,
    security,
    securityKnown: rep.securityKnown,
    rebootRequired: rep.rebootRequired,
    rebootReason: rep.rebootReason ?? null,
    rebootSince: rep.rebootRequired ? (prev?.rebootRequired && prev.rebootSince ? prev.rebootSince : now) : null,
    securitySince: security > 0 ? (prev && prev.security > 0 && prev.securitySince ? prev.securitySince : now) : null,
    canInstall: rep.canInstall,
    proxmox: !!rep.proxmox,
    packages: rep.packages,
    ...live,
  };
}

export function toUpdateStatus(row: StoredStatus | null | undefined): OsUpdateStatus | null {
  if (!row) return null;
  return {
    checkedAt: row.checkedAt?.toISOString() ?? null,
    manager: row.manager,
    supported: row.supported,
    error: row.error,
    note: row.note,
    total: row.total,
    security: row.security,
    securityKnown: row.securityKnown,
    rebootRequired: row.rebootRequired,
    rebootReason: row.rebootReason,
    securitySince: row.securitySince?.toISOString() ?? null,
    rebootSince: row.rebootSince?.toISOString() ?? null,
    canInstall: row.canInstall,
    proxmox: row.proxmox,
    mode: (MODES.includes(row.mode as OsUpdateMode) ? row.mode : 'on') as OsUpdateMode,
    installing: row.installing,
    checking: row.checking,
  };
}

// --- schedules ---------------------------------------------------------------

export interface ScheduleTiming {
  enabled: boolean;
  days: number[];
  hour: number;
  minute: number;
}

/** True when `now` is the minute a window opens (server local time). */
export function isWindowStart(s: ScheduleTiming, now: Date): boolean {
  return s.enabled && s.days.includes(now.getDay()) && now.getHours() === s.hour && now.getMinutes() === s.minute;
}

/** The next window start after `from`, or null when disabled / no days. */
export function nextWindowStart(s: ScheduleTiming, from: Date = new Date()): Date | null {
  if (!s.enabled || !s.days.length) return null;
  for (let i = 0; i < 8; i += 1) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, s.hour, s.minute, 0, 0);
    if (d > from && s.days.includes(d.getDay())) return d;
  }
  return null;
}

export function describeTiming(s: ScheduleTiming): string {
  if (!s.days.length) return 'No days picked';
  const time = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
  const days = [...s.days].sort((a, b) => a - b);
  const dayText = days.length === 7 ? 'Every day' : days.join(',') === '1,2,3,4,5' ? 'Weekdays' : days.join(',') === '0,6' ? 'Weekends' : days.map((d) => DAY_NAMES_SHORT[d]).join(', ');
  return `${dayText} at ${time} (server time)`;
}

export function sanitizeRings(raw: unknown): OsUpdateRing[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: OsUpdateRing[] = [];
  for (const r of raw.slice(0, 5)) {
    if (!r || typeof r !== 'object') continue;
    const x = r as Record<string, unknown>;
    const ids = Array.isArray(x.agentIds) ? x.agentIds.filter((a): a is string => typeof a === 'string' && !!a && !seen.has(a)) : [];
    ids.forEach((a) => seen.add(a));
    const delay = typeof x.delayHours === 'number' && Number.isFinite(x.delayHours) ? Math.min(24 * 14, Math.max(0, Math.round(x.delayHours))) : 0;
    out.push({ agentIds: ids, delayHours: out.length === 0 ? 0 : delay });
  }
  return out;
}

/** Validate a schedule body; returns the cleaned input or an error message. */
export function sanitizeSchedule(body: unknown): { ok: true; value: OsUpdateScheduleInput } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body required.' };
  const b = body as Record<string, unknown>;
  const name = str(b.name, 80);
  if (!name) return { ok: false, error: 'Give the schedule a name.' };
  const days = Array.isArray(b.days) ? [...new Set(b.days.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))] : [];
  if (!days.length) return { ok: false, error: 'Pick at least one day.' };
  const hour = Number(b.hour);
  const minute = Number(b.minute);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return { ok: false, error: 'Pick a valid time.' };
  const windowHours = Number(b.windowHours ?? 4);
  if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 24) return { ok: false, error: 'The window must be 1 to 24 hours.' };
  if (!isScope(b.scope)) return { ok: false, error: 'scope must be security or all.' };
  if (!isReboot(b.reboot)) return { ok: false, error: 'reboot must be never, if-needed or always.' };
  const rings = sanitizeRings(b.rings).filter((r, i) => i === 0 || r.agentIds.length);
  if (!rings.length || !rings.some((r) => r.agentIds.length)) return { ok: false, error: 'Add at least one machine.' };
  for (let i = 1; i < rings.length; i += 1) {
    if (rings[i].delayHours < rings[i - 1].delayHours) return { ok: false, error: `Ring ${i + 1} must start at or after ring ${i}.` };
  }
  return {
    ok: true,
    value: {
      name,
      enabled: b.enabled !== false,
      days: days.sort((a, c) => a - c),
      hour,
      minute,
      windowHours,
      scope: b.scope,
      reboot: b.reboot,
      snapshot: b.snapshot !== false,
      rings,
      stopOnFailure: b.stopOnFailure !== false,
    },
  };
}

/** Proxmox snapshot names: a letter first, then letters, digits, - and _; max 40. */
export function snapshotName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `cerebro-pre-update-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

export const SNAPSHOT_PREFIX = 'cerebro-pre-update-';

// --- posture -----------------------------------------------------------------

export interface PostureMachine {
  agentId: string;
  name: string;
  security: number;
  securitySince: Date | null;
  rebootRequired: boolean;
  rebootSince: Date | null;
  rebootReason: string | null;
}

const days = (from: Date, now: Date) => Math.floor((now.getTime() - from.getTime()) / DAY_MS);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Posture findings for security updates and restarts that have waited too long. */
export function osUpdateFindings(machines: PostureMachine[], now: Date = new Date()): PostureFinding[] {
  const out: PostureFinding[] = [];
  const sec = machines.filter((m) => m.security > 0 && m.securitySince && days(m.securitySince, now) >= OS_UPDATE_SECURITY_GRACE_DAYS);
  if (sec.length) {
    const worst = Math.max(...sec.map((m) => days(m.securitySince!, now)));
    out.push({
      id: 'os-security-updates',
      severity: worst >= 30 ? 'high' : 'medium',
      category: 'patching',
      title: `${plural(sec.length, 'machine has', 'machines have')} had security updates waiting over ${OS_UPDATE_SECURITY_GRACE_DAYS} days`,
      why: 'Security updates fix known holes in the operating system and its packages. Once a fix is public, so is the bug it fixes.',
      fix: 'Install them from Health → Updates (security only is enough), or add the machine to an update schedule so it happens on its own.',
      affected: sec.map((m) => ({
        label: m.name,
        note: `${plural(m.security, 'security update', 'security updates')} waiting ${plural(days(m.securitySince!, now), 'day', 'days')}`,
        url: `/health/${m.agentId}`,
      })),
      source: 'Cerebro agent',
      hosts: sec.map((m) => m.name),
    });
  }
  const rb = machines.filter((m) => m.rebootRequired && m.rebootSince && days(m.rebootSince, now) >= OS_UPDATE_REBOOT_GRACE_DAYS);
  if (rb.length)
    out.push({
      id: 'os-restart-pending',
      severity: 'low',
      category: 'patching',
      title: `${plural(rb.length, 'machine needs', 'machines need')} a restart to finish installing updates`,
      why: 'Until it restarts, the machine keeps running the old kernel or libraries, so the fixes that were installed are not in effect yet.',
      fix: 'Restart it from Health → Updates during a quiet hour, or let an update schedule restart it ("Restart if needed").',
      affected: rb.map((m) => ({ label: m.name, note: `${m.rebootReason ?? 'Restart needed'} · waiting ${plural(days(m.rebootSince!, now), 'day', 'days')}`, url: `/health/${m.agentId}` })),
      source: 'Cerebro agent',
      hosts: rb.map((m) => m.name),
    });
  return out;
}
