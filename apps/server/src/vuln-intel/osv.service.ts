import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { cvss3BaseScore } from './cvss';

/**
 * OSV.dev (https://osv.dev, free, no key): which advisories affect a distro package
 * version, and what each advisory says. Used for apt machines, whose package manager
 * has no local list of CVEs. Sends only the ecosystem ("Ubuntu:22.04:LTS"), package
 * names and versions: never hostnames or addresses.
 *
 * Lookups are cached in the database a day per (ecosystem, package, version), so ten
 * machines on one release share them; advisory records are cached a week. A failure
 * keeps what's cached and backs off.
 */

const API = 'https://api.osv.dev/v1';
const LOOKUP_TTL = 24 * 3600_000;
const RECORD_TTL = 7 * 24 * 3600_000;
const RETRY_MS = 3 * 3600_000;
const TIMEOUT_MS = 30_000;
const BATCH = 500;
const MAX_PAGES = 5;
const CONCURRENCY = 4;
export const CVE_RE = /^CVE-\d{4}-\d{4,}$/;

export interface OsvRecord {
  id: string;
  cves: string[];
  summary: string | null;
  cvss: number | null;
  cvssVector: string | null;
  /** Vendor priority (Ubuntu: negligible / low / medium / high / critical). */
  priority: string | null;
  published: Date | null;
  missing: boolean;
}

interface RawVuln {
  id?: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  upstream?: string[];
  related?: string[];
  published?: string;
  severity?: { type?: string; score?: string }[];
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

export function recordFromOsv(id: string, v: RawVuln | null): OsvRecord {
  if (!v) return { id, cves: [], summary: null, cvss: null, cvssVector: null, priority: null, published: null, missing: true };
  const cves = new Set<string>();
  const own = /^(?:UBUNTU|DEBIAN)-(CVE-\d{4}-\d{4,})$/.exec(id)?.[1] ?? (CVE_RE.test(id) ? id : null);
  if (own) cves.add(own);
  for (const x of [...(v.aliases ?? []), ...(v.upstream ?? []), ...(v.related ?? [])]) {
    const c = String(x).toUpperCase().replace(/^(?:UBUNTU|DEBIAN)-/, '');
    if (CVE_RE.test(c)) cves.add(c);
  }
  let cvss: number | null = null;
  let cvssVector: string | null = null;
  let priority: string | null = null;
  for (const s of v.severity ?? []) {
    if (!s?.score) continue;
    if (s.type === 'CVSS_V3') {
      const n = cvss3BaseScore(s.score);
      if (n !== null && (cvss === null || n > cvss)) { cvss = n; cvssVector = s.score; }
    } else if (s.type === 'Ubuntu' || s.type === 'Debian') {
      priority = s.score.toLowerCase();
    } else if (s.type === 'CVSS_V4' && !cvssVector) {
      cvssVector = s.score;
    }
  }
  const summary = (v.summary || v.details || '').trim().split('\n')[0].slice(0, 300) || null;
  const published = v.published && !Number.isNaN(Date.parse(v.published)) ? new Date(v.published) : null;
  return { id, cves: [...cves].slice(0, 200), summary, cvss, cvssVector, priority, published, missing: false };
}

@Injectable()
export class OsvService {
  private failedAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logging: LoggingService,
  ) {}

  /** True while OSV is in its back-off after a failure. */
  backingOff(): boolean {
    return !!this.failedAt && Date.now() - this.failedAt < RETRY_MS;
  }

  /** Forget the back-off (a restart or "Check now"). */
  resetBackoff(): void {
    this.failedAt = 0;
  }

  /**
   * Advisory ids affecting each `${name}@${version}` in this ecosystem. A pair is missing
   * from the result when it couldn't be looked up (OSV down, never cached).
   */
  async affecting(ecosystem: string, pairs: { name: string; version: string }[]): Promise<{ ids: Map<string, string[]>; failed: boolean }> {
    const key = (n: string, v: string) => `${n}@${v}`;
    const uniq = [...new Map(pairs.map((p) => [key(p.name, p.version), p])).values()];
    const out = new Map<string, string[]>();
    if (!uniq.length) return { ids: out, failed: false };
    const cached = await this.prisma.osVulnLookup.findMany({ where: { ecosystem, OR: uniq.map((p) => ({ name: p.name, version: p.version })) } });
    const fresh = Date.now() - LOOKUP_TTL;
    for (const c of cached) out.set(key(c.name, c.version), c.vulnIds);
    const todo = uniq.filter((p) => {
      const c = cached.find((x) => x.name === p.name && x.version === p.version);
      return !c || c.fetchedAt.getTime() < fresh;
    });
    if (!todo.length) return { ids: out, failed: false };
    if (this.backingOff()) return { ids: out, failed: true };
    try {
      for (let i = 0; i < todo.length; i += BATCH) {
        const chunk = todo.slice(i, i + BATCH);
        const got = await this.queryBatch(ecosystem, chunk);
        const now = new Date();
        for (const [j, p] of chunk.entries()) {
          const ids = got[j];
          out.set(key(p.name, p.version), ids);
          await this.prisma.osVulnLookup.upsert({
            where: { ecosystem_name_version: { ecosystem, name: p.name, version: p.version } },
            create: { ecosystem, name: p.name, version: p.version, vulnIds: ids, fetchedAt: now },
            update: { vulnIds: ids, fetchedAt: now },
          });
        }
      }
      return { ids: out, failed: false };
    } catch (err) {
      this.failedAt = Date.now();
      void this.logging.warn('os-updates', `OSV.dev lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ids: out, failed: true };
    }
  }

  /** querybatch, following next_page_token for queries that have more than one page. */
  private async queryBatch(ecosystem: string, pairs: { name: string; version: string }[]): Promise<string[][]> {
    const results: string[][] = pairs.map(() => []);
    let pending = pairs.map((p, idx) => ({ idx, q: { package: { name: p.name, ecosystem }, version: p.version } as Record<string, unknown> }));
    for (let page = 0; page < MAX_PAGES && pending.length; page += 1) {
      const res = await this.post('/querybatch', { queries: pending.map((p) => p.q) });
      const rows = (res as { results?: { vulns?: { id?: string }[]; next_page_token?: string }[] } | null)?.results ?? [];
      const next: typeof pending = [];
      pending.forEach((p, i) => {
        const r = rows[i];
        for (const v of r?.vulns ?? []) if (v?.id && !results[p.idx].includes(v.id)) results[p.idx].push(v.id);
        if (r?.next_page_token) next.push({ idx: p.idx, q: { ...p.q, page_token: r.next_page_token } });
      });
      pending = next;
    }
    return results;
  }

  /** Advisory records by id (cached a week). Ids OSV doesn't have come back with missing=true. */
  async records(ids: string[]): Promise<Map<string, OsvRecord>> {
    const uniq = [...new Set(ids)];
    const out = new Map<string, OsvRecord>();
    if (!uniq.length) return out;
    const cached = await this.prisma.osAdvisory.findMany({ where: { id: { in: uniq } } });
    const fresh = Date.now() - RECORD_TTL;
    for (const c of cached) {
      out.set(c.id, { id: c.id, cves: c.cves, summary: c.summary, cvss: c.cvss, cvssVector: c.cvssVector, priority: c.priority, published: c.published, missing: c.missing });
    }
    const todo = uniq.filter((id) => {
      const c = cached.find((x) => x.id === id);
      return !c || c.fetchedAt.getTime() < fresh;
    });
    if (!todo.length || this.backingOff()) return out;
    let failures = 0;
    await pool(todo, CONCURRENCY, async (id) => {
      if (failures >= 3) return;
      try {
        const rec = recordFromOsv(id, (await this.getJson(`/vulns/${encodeURIComponent(id)}`)) as RawVuln | null);
        out.set(id, rec);
        const data = { cves: rec.cves, summary: rec.summary, cvss: rec.cvss, cvssVector: rec.cvssVector, priority: rec.priority, published: rec.published, missing: rec.missing, fetchedAt: new Date() };
        await this.prisma.osAdvisory.upsert({ where: { id }, create: { id, ...data }, update: data });
      } catch (err) {
        failures += 1;
        if (failures === 3) {
          this.failedAt = Date.now();
          void this.logging.warn('os-updates', `OSV.dev advisory fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
    return out;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Cerebro OS update checks' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  private async getJson(path: string): Promise<unknown> {
    const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json', 'user-agent': 'Cerebro OS update checks' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}
