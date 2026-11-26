import type { OsUpdateDistro, OsUpdatePackage, OsUpdatePriority } from '@cerebro/shared';
import { osUpdatePriorityRank } from '@cerebro/shared';

/**
 * Pure helpers for OS-update severity (docs/os-updates.md#severity-and-cves): which
 * OSV.dev ecosystem a machine is in, what each update's OSV advisories add, and the
 * priority rules. No I/O.
 */

const CVE = /^CVE-\d{4}-\d{4,}$/;

/** The OSV.dev ecosystem for an apt machine ("Ubuntu:22.04:LTS", "Debian:12"), else null. */
export function osvEcosystem(distro: OsUpdateDistro | null | undefined, manager: string | null | undefined): string | null {
  if (manager !== 'apt' || !distro?.versionId) return null;
  const id = distro.id.toLowerCase();
  const ver = distro.versionId.trim();
  if (id === 'ubuntu') {
    const m = /^(\d{2})\.(\d{2})$/.exec(ver);
    if (!m) return null;
    const lts = m[2] === '04' && Number(m[1]) % 2 === 0;
    return `Ubuntu:${ver}${lts ? ':LTS' : ''}`;
  }
  // Debian, Raspberry Pi OS (raspbian, or debian on 64-bit), Proxmox VE (debian).
  if (id === 'debian' || id === 'raspbian') {
    const major = /^(\d+)/.exec(ver)?.[1];
    return major ? `Debian:${major}` : null;
  }
  return null;
}

/** Advisory ids that affect the installed version but not the new one: what this update fixes. */
export function fixedIds(current: string[] | undefined, available: string[] | undefined): string[] {
  if (!current || !available) return [];
  const still = new Set(available);
  return current.filter((id) => !still.has(id));
}

/** Per-CVE advisories (UBUNTU-CVE-…, DEBIAN-CVE-…) aren't shown as advisories; their CVE is. */
export function isNoticeId(id: string): boolean {
  return !/^(UBUNTU|DEBIAN)-CVE-/.test(id) && !CVE.test(id);
}

export interface CveScore {
  cvss: number | null;
  priority: string | null;
  epss: number | null;
}

const VENDOR_CRITICAL = ['critical'];
const VENDOR_IMPORTANT = ['important', 'high'];

/** The priority rules (see OsUpdatePriority). */
export function packagePriority(
  pkg: OsUpdatePackage,
  scores: Map<string, CveScore>,
  kev: { has(id: string): boolean } | null,
): { priority: OsUpdatePriority; maxCvss?: number; kev?: boolean; epss?: number } {
  const cves = pkg.cves ?? [];
  let maxCvss: number | undefined;
  let epss: number | undefined;
  let vendorCritical = VENDOR_CRITICAL.includes((pkg.severity ?? '').toLowerCase());
  let vendorImportant = VENDOR_IMPORTANT.includes((pkg.severity ?? '').toLowerCase());
  for (const c of cves) {
    const s = scores.get(c);
    if (!s) continue;
    if (s.cvss != null && (maxCvss === undefined || s.cvss > maxCvss)) maxCvss = s.cvss;
    if (s.epss != null && (epss === undefined || s.epss > epss)) epss = s.epss;
    const p = (s.priority ?? '').toLowerCase();
    if (VENDOR_CRITICAL.includes(p)) vendorCritical = true;
    if (VENDOR_IMPORTANT.includes(p)) vendorImportant = true;
  }
  const isKev = !!kev && cves.some((c) => kev.has(c));
  const extra = { ...(maxCvss !== undefined ? { maxCvss } : {}), ...(epss !== undefined ? { epss } : {}), ...(isKev ? { kev: true } : {}) };
  if (isKev) return { priority: 'patch-now', ...extra };
  if ((maxCvss ?? 0) >= 9 || vendorCritical) return { priority: 'critical', ...extra };
  if ((maxCvss ?? 0) >= 7 || vendorImportant) return { priority: 'important', ...extra };
  if (pkg.security || cves.length) return { priority: 'security', ...extra };
  return { priority: 'regular', ...extra };
}

export interface MachineSummary {
  priority: OsUpdatePriority | null;
  cveCount: number;
  kevCount: number;
  kevCves: string[];
}

export function summarize(pkgs: OsUpdatePackage[], kev: { has(id: string): boolean } | null): MachineSummary {
  let priority: OsUpdatePriority | null = null;
  const cves = new Set<string>();
  const kevCves = new Set<string>();
  let kevCount = 0;
  for (const p of pkgs) {
    if (p.priority && (!priority || osUpdatePriorityRank(p.priority) < osUpdatePriorityRank(priority))) priority = p.priority;
    for (const c of p.cves ?? []) {
      cves.add(c);
      if (kev?.has(c)) kevCves.add(c);
    }
    if (p.kev) kevCount += 1;
  }
  return { priority, cveCount: cves.size, kevCount, kevCves: [...kevCves].sort() };
}

/** Packages most urgent first: priority, then EPSS, then CVSS, then name. */
export function sortPackages(pkgs: OsUpdatePackage[]): OsUpdatePackage[] {
  return pkgs.slice().sort(
    (a, b) =>
      osUpdatePriorityRank(a.priority ?? (a.security ? 'security' : 'regular')) - osUpdatePriorityRank(b.priority ?? (b.security ? 'security' : 'regular')) ||
      (b.epss ?? -1) - (a.epss ?? -1) ||
      (b.maxCvss ?? -1) - (a.maxCvss ?? -1) ||
      a.name.localeCompare(b.name),
  );
}
