import { Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { LoggingService } from '../logging/logging.service';

/**
 * Known CVEs for the versions of the infrastructure software Cerebro talks to (Proxmox VE,
 * Nginx Proxy Manager, UniFi OS / Network / switch firmware), from the NVD CVE API.
 * One query per product (by CPE vendor:product, not by version), cached a day in settings;
 * the version-range check happens here, so a version change needs no new query.
 * Queries run in the background and the map uses whatever is cached, so NVD being slow or
 * rate-limiting never holds up the map. Sends only product names (CPE strings) to NVD.
 * See docs/architecture-map.md#posture-findings.
 */

const STORE_KEY = 'posture.versionCves.nvd';
const TTL_MS = 24 * 3600_000;
const RETRY_MS = 3 * 3600_000;
/** NVD allows 5 requests per 30 s without an API key (50 with one, via NVD_API_KEY). */
const GAP_MS = process.env.NVD_API_KEY ? 800 : 6_500;
const TIMEOUT_MS = 30_000;
const PAGE = 2000;

/** One version range (or exact version) NVD says is vulnerable, for the product we asked about. */
export interface CveRange {
  exact?: string;
  start?: string;
  startIncl?: boolean;
  end?: string;
  endIncl?: boolean;
}
export interface NvdCve {
  id: string;
  published?: string;
  score?: number;
  severity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  summary?: string;
  ranges: CveRange[];
}
interface StoreEntry {
  at: string;
  failedAt?: string;
  error?: string;
  cves: NvdCve[];
}
type Store = Record<string, StoreEntry>;

@Injectable()
export class VersionCveService {
  constructor(
    private readonly settings: SettingsService,
    private readonly logging: LoggingService,
  ) {}

  private refreshing: Promise<boolean> | null = null;
  private triedSinceBoot = false;

  /** Cached CVEs per CPE ("ui:unifi_os"); missing = not fetched yet. */
  async cached(): Promise<Store> {
    return (await this.settings.get<Store>(STORE_KEY)) ?? {};
  }

  /**
   * Fetch any product that is missing or older than a day, in the background.
   * Resolves true when something new was stored (so the caller can rebuild).
   */
  refresh(cpes: string[], retryFailed = false): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh([...new Set(cpes)], retryFailed).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(cpes: string[], retryFailed: boolean): Promise<boolean> {
    // A restart, or a manual Refresh, retries sources that failed instead of waiting out the backoff.
    const skipBackoff = retryFailed || !this.triedSinceBoot;
    this.triedSinceBoot = true;
    const store = await this.cached();
    const now = Date.now();
    const todo = cpes.filter((c) => {
      const e = store[c];
      if (!e) return true;
      if (!skipBackoff && e.failedAt && now - new Date(e.failedAt).getTime() < RETRY_MS) return false;
      return now - new Date(e.at).getTime() > TTL_MS;
    });
    let changed = false;
    for (const [i, cpe] of todo.entries()) {
      if (i) await new Promise((r) => setTimeout(r, GAP_MS));
      try {
        const cves = await this.fetchProduct(cpe);
        store[cpe] = { at: new Date().toISOString(), cves };
        changed = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        store[cpe] = { ...(store[cpe] ?? { at: new Date(0).toISOString(), cves: [] }), failedAt: new Date().toISOString(), error: msg.slice(0, 200) };
        void this.logging.warn('topology', `Version CVE lookup: NVD query for ${cpe} failed: ${msg}`);
      }
      await this.settings.set(STORE_KEY, store);
    }
    return changed;
  }

  private async fetchProduct(cpe: string): Promise<NvdCve[]> {
    const out: NvdCve[] = [];
    for (let start = 0; ; start += PAGE) {
      const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?virtualMatchString=${encodeURIComponent(cpeBase(cpe))}&resultsPerPage=${PAGE}&startIndex=${start}`;
      const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'Cerebro posture checks' };
      if (process.env.NVD_API_KEY) headers.apiKey = process.env.NVD_API_KEY;
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as NvdResponse;
      out.push(...parseNvd(cpe, j));
      const total = j.totalResults ?? 0;
      if (start + PAGE >= total) break;
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
    return out;
  }
}

/** "ui:unifi_os" → "cpe:2.3:o:ui:unifi_os" (part from the product kind). */
export function cpeBase(cpe: string): string {
  const part = /_firmware$|:unifi_os$/.test(cpe) ? 'o' : 'a';
  return `cpe:2.3:${part}:${cpe}`;
}

interface NvdResponse {
  totalResults?: number;
  vulnerabilities?: {
    cve?: {
      id?: string;
      published?: string;
      vulnStatus?: string;
      descriptions?: { lang?: string; value?: string }[];
      metrics?: Record<string, { type?: string; cvssData?: { baseScore?: number; baseSeverity?: string }; baseSeverity?: string }[]>;
      configurations?: { nodes?: { cpeMatch?: { vulnerable?: boolean; criteria?: string; versionStartIncluding?: string; versionStartExcluding?: string; versionEndIncluding?: string; versionEndExcluding?: string }[] }[] }[];
    };
  }[];
}

/** NVD response → the CVEs with a version range (or exact version) for this vendor:product. */
export function parseNvd(cpe: string, j: NvdResponse): NvdCve[] {
  const out: NvdCve[] = [];
  for (const v of j.vulnerabilities ?? []) {
    const c = v.cve;
    if (!c?.id || /reject/i.test(c.vulnStatus ?? '')) continue;
    const ranges: CveRange[] = [];
    for (const conf of c.configurations ?? [])
      for (const node of conf.nodes ?? [])
        for (const m of node.cpeMatch ?? []) {
          if (!m.vulnerable || !m.criteria) continue;
          const parts = m.criteria.split(':');
          if (`${parts[3]}:${parts[4]}` !== cpe) continue;
          const ver = parts[5];
          const hasRange = m.versionStartIncluding || m.versionStartExcluding || m.versionEndIncluding || m.versionEndExcluding;
          if (hasRange)
            ranges.push({
              start: m.versionStartIncluding ?? m.versionStartExcluding,
              startIncl: m.versionStartExcluding ? false : true,
              end: m.versionEndIncluding ?? m.versionEndExcluding,
              endIncl: !!m.versionEndIncluding,
            });
          // "*" with no range (every version) or "-" (unspecified) says nothing about yours: skipped.
          else if (ver && ver !== '*' && ver !== '-') ranges.push({ exact: ver });
        }
    if (!ranges.length) continue;
    const metric = ['cvssMetricV40', 'cvssMetricV31', 'cvssMetricV30', 'cvssMetricV2']
      .map((k) => c.metrics?.[k]?.find((x) => x.type === 'Primary') ?? c.metrics?.[k]?.[0])
      .find(Boolean);
    const sev = String(metric?.cvssData?.baseSeverity ?? metric?.baseSeverity ?? '').toUpperCase();
    out.push({
      id: c.id,
      published: c.published,
      score: metric?.cvssData?.baseScore,
      severity: (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(sev) ? sev : undefined) as NvdCve['severity'],
      summary: c.descriptions?.find((d) => d.lang === 'en')?.value?.slice(0, 200),
      ranges,
    });
  }
  return out;
}

/** Compare dotted versions numerically ("5.1.34.34103" vs "5.1.35"); missing parts count as 0. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.\-+_]/);
  const pb = b.split(/[.\-+_]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    const d = !Number.isNaN(nx) && !Number.isNaN(ny) ? nx - ny : x.localeCompare(y);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Does this version fall in any of the CVE's ranges? Returns the range that matched. */
export function affects(version: string, cve: NvdCve): CveRange | null {
  for (const r of cve.ranges) {
    if (r.exact) {
      if (cmpVersion(version, r.exact) === 0) return r;
      continue;
    }
    if (r.start) {
      const c = cmpVersion(version, r.start);
      if (c < 0 || (c === 0 && r.startIncl === false)) continue;
    }
    if (r.end) {
      const c = cmpVersion(version, r.end);
      if (c > 0 || (c === 0 && !r.endIncl)) continue;
    }
    if (r.start || r.end) return r;
  }
  return null;
}
