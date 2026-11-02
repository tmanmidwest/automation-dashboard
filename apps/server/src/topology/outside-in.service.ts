import { Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { LoggingService } from '../logging/logging.service';
import { cpeRelease } from './posture';

/**
 * Outside-in data for posture findings, from free public sources (no keys):
 *  - Shodan InternetDB: open ports, software and known CVEs Shodan's scanners saw on an IP.
 *  - CISA KEV: CVEs known to be exploited in the wild.
 *  - endoflife.date: support end dates per product release.
 * Everything is cached and a failed fetch keeps the last good answer, so the map never
 * waits long or breaks because a site is down. Sends only the WAN address(es) to Shodan
 * and product names (e.g. "postgresql") to endoflife.date.
 */

export const OUTSIDE_IN_KEY = 'posture.outsideIn';
const TIMEOUT_MS = 8_000;
const IDB_TTL = 6 * 3600_000;
const KEV_TTL = 24 * 3600_000;
const EOL_TTL = 24 * 3600_000;
/** After a failure, wait this long before trying the same source again. */
const RETRY_MS = 15 * 60_000;

export interface InternetDbHost {
  ip: string;
  ports: number[];
  cpes: string[];
  hostnames: string[];
  tags: string[];
  vulns: string[];
  checkedAt: string;
}
export interface KevEntry {
  cveID: string;
  vendorProject?: string;
  product?: string;
  vulnerabilityName?: string;
  dateAdded?: string;
  requiredAction?: string;
  knownRansomwareCampaignUse?: string;
}
export interface EolCycle {
  cycle: string;
  eol: string | boolean;
  latest?: string;
  releaseDate?: string;
}

export interface OutsideInData {
  wan: InternetDbHost[];
  kev: Map<string, KevEntry>;
  eol: Map<string, EolCycle[]>;
  errors: string[];
}

interface Cached<T> {
  at: number;
  value: T | null;
  failedAt?: number;
}

@Injectable()
export class OutsideInService {
  constructor(
    private readonly settings: SettingsService,
    private readonly logging: LoggingService,
  ) {}

  private idb = new Map<string, Cached<InternetDbHost>>();
  private kevCache: Cached<Map<string, KevEntry>> = { at: 0, value: null };
  private eolCache = new Map<string, Cached<EolCycle[]>>();

  async enabled(): Promise<boolean> {
    return (await this.settings.get<boolean>(OUTSIDE_IN_KEY, true)) !== false;
  }

  async setEnabled(on: boolean): Promise<void> {
    await this.settings.set(OUTSIDE_IN_KEY, on);
  }

  /** Everything the findings need, for these WAN IPs and endoflife.date products. */
  async gather(wanIps: string[], products: string[]): Promise<OutsideInData> {
    const errors: string[] = [];
    const [wanRaw, kev] = await Promise.all([Promise.all(wanIps.map((ip) => this.internetDb(ip, errors))), this.kev(errors)]);
    const wan = wanRaw.filter((w): w is InternetDbHost => !!w);
    // Software Shodan saw on the WAN address gets an end-of-life check too.
    const all = new Set(products);
    for (const w of wan) for (const c of w.cpes) { const r = cpeRelease(c); if (r) all.add(r.product); }
    const eolPairs = await Promise.all([...all].map(async (p) => [p, await this.eol(p, errors)] as const));
    const eol = new Map<string, EolCycle[]>();
    for (const [p, cycles] of eolPairs) if (cycles) eol.set(p, cycles);
    return { wan, kev: kev ?? new Map(), eol, errors: [...new Set(errors)] };
  }

  /** Cache-aware fetch: fresh value, else refetch; on failure keep the old value and back off. */
  private async cached<T>(c: Cached<T>, ttl: number, label: string, errors: string[], load: () => Promise<T>): Promise<T | null> {
    const now = Date.now();
    if (c.value && now - c.at < ttl) return c.value;
    if (c.failedAt && now - c.failedAt < RETRY_MS) {
      errors.push(label);
      return c.value;
    }
    try {
      c.value = await load();
      c.at = now;
      c.failedAt = undefined;
    } catch (err) {
      c.failedAt = now;
      errors.push(label);
      void this.logging.warn('topology', `Outside-in check: ${label} unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return c.value;
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json', 'user-agent': 'Cerebro posture checks' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  private internetDb(ip: string, errors: string[]): Promise<InternetDbHost | null> {
    if (!this.idb.has(ip)) this.idb.set(ip, { at: 0, value: null });
    return this.cached(this.idb.get(ip)!, IDB_TTL, 'Shodan InternetDB', errors, async () => {
      // 404 = Shodan has never seen anything open on this IP.
      const j = (await this.getJson(`https://internetdb.shodan.io/${encodeURIComponent(ip)}`)) as Partial<InternetDbHost> | null;
      const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
      return {
        ip,
        ports: arr<number>(j?.ports).filter((p) => Number.isInteger(p)).sort((a, b) => a - b),
        cpes: arr<string>(j?.cpes),
        hostnames: arr<string>(j?.hostnames),
        tags: arr<string>(j?.tags),
        vulns: arr<string>(j?.vulns).sort(),
        checkedAt: new Date().toISOString(),
      };
    });
  }

  private kev(errors: string[]): Promise<Map<string, KevEntry> | null> {
    return this.cached(this.kevCache, KEV_TTL, 'CISA KEV', errors, async () => {
      const j = (await this.getJson('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json')) as { vulnerabilities?: KevEntry[] } | null;
      return new Map((j?.vulnerabilities ?? []).filter((v) => v?.cveID).map((v) => [v.cveID.toUpperCase(), v]));
    });
  }

  private eol(product: string, errors: string[]): Promise<EolCycle[] | null> {
    if (!this.eolCache.has(product)) this.eolCache.set(product, { at: 0, value: null });
    return this.cached(this.eolCache.get(product)!, EOL_TTL, 'endoflife.date', errors, async () => {
      const j = await this.getJson(`https://endoflife.date/api/${encodeURIComponent(product)}.json`);
      return Array.isArray(j) ? (j as EolCycle[]).filter((c) => c && c.cycle != null).map((c) => ({ ...c, cycle: String(c.cycle) })) : [];
    });
  }
}
