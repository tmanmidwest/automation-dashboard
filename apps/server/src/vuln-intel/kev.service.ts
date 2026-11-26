import { Injectable } from '@nestjs/common';
import { LoggingService } from '../logging/logging.service';

/**
 * CISA Known Exploited Vulnerabilities: CVEs attackers are using now. One shared copy,
 * cached a day, for Posture (outside-in checks, image scans) and OS updates. A failed
 * download keeps the last good copy and waits before trying again.
 */

export const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const KEV_TTL = 24 * 3600_000;
const RETRY_MS = 15 * 60_000;
const TIMEOUT_MS = 20_000;

export interface KevEntry {
  cveID: string;
  vendorProject?: string;
  product?: string;
  vulnerabilityName?: string;
  dateAdded?: string;
  dueDate?: string;
  requiredAction?: string;
  knownRansomwareCampaignUse?: string;
}

@Injectable()
export class KevService {
  private value: Map<string, KevEntry> | null = null;
  private at = 0;
  private failedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(private readonly logging: LoggingService) {}

  /** The KEV list (fetched when older than a day); null when it has never loaded. Pushes 'CISA KEV' onto errors on failure. */
  async get(errors?: string[]): Promise<Map<string, KevEntry> | null> {
    const now = Date.now();
    if (this.value && now - this.at < KEV_TTL) return this.value;
    if (this.failedAt && now - this.failedAt < RETRY_MS) {
      errors?.push('CISA KEV');
      return this.value;
    }
    if (!this.loading) this.loading = this.load().finally(() => { this.loading = null; });
    await this.loading;
    if (this.failedAt >= now) errors?.push('CISA KEV');
    return this.value;
  }

  /** Whatever is cached, without fetching (for when outside-in checks are off). */
  peek(): Map<string, KevEntry> | null {
    return this.value;
  }

  /** When the cached copy was downloaded (ms), 0 if never. */
  loadedAt(): number {
    return this.at;
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(KEV_URL, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json', 'user-agent': 'Cerebro posture checks' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { vulnerabilities?: KevEntry[] } | null;
      this.value = new Map((j?.vulnerabilities ?? []).filter((v) => v?.cveID).map((v) => [v.cveID.toUpperCase(), v]));
      this.at = Date.now();
      this.failedAt = 0;
    } catch (err) {
      this.failedAt = Date.now();
      void this.logging.warn('topology', `CISA KEV unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
