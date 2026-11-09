import { Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { LoggingService } from '../logging/logging.service';

/**
 * Have I Been Pwned, free part only (no API key): has a website on one of your domains
 * itself been breached? Reads HIBP's public breach catalogue (/api/v3/breaches) once a day
 * and matches each breach's domain against yours locally, so nothing about your domains
 * leaves Cerebro. Which of your addresses appear in breaches would need a paid HIBP key
 * plus domain verification; not built. See docs/architecture-map.md#posture-findings.
 */

const STORE_KEY = 'posture.hibp';
const TTL_MS = 24 * 3600_000;
const RETRY_MS = 3 * 3600_000;
const TIMEOUT_MS = 30_000;

export interface HibpBreach {
  name: string;
  title: string;
  domain: string;
  breachDate?: string;
  addedDate?: string;
  pwnCount?: number;
  dataClasses: string[];
}
export interface HibpStore {
  at?: string;
  failedAt?: string;
  error?: string;
  /** Every breach in the catalogue that has a website domain (slimmed). */
  breaches: HibpBreach[];
}

@Injectable()
export class HibpService {
  constructor(
    private readonly settings: SettingsService,
    private readonly logging: LoggingService,
  ) {}

  private refreshing: Promise<boolean> | null = null;
  private triedSinceBoot = false;

  async cached(): Promise<HibpStore> {
    return { breaches: [], ...((await this.settings.get<HibpStore>(STORE_KEY)) ?? {}) };
  }

  /** Re-read the catalogue if it's a day old; resolves true when something new was stored. */
  refresh(retryFailed = false): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh(retryFailed).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(retryFailed: boolean): Promise<boolean> {
    // A restart, or a manual Refresh, retries sources that failed instead of waiting out the backoff.
    const skipBackoff = retryFailed || !this.triedSinceBoot;
    this.triedSinceBoot = true;
    const prev = await this.cached();
    const now = Date.now();
    if (prev.at && now - new Date(prev.at).getTime() < TTL_MS) return false;
    if (!skipBackoff && prev.failedAt && now - new Date(prev.failedAt).getTime() < RETRY_MS) return false;
    try {
      const res = await fetch('https://haveibeenpwned.com/api/v3/breaches', {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'application/json', 'user-agent': 'Cerebro-posture-checks' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const breaches = parseBreaches(await res.json());
      await this.settings.set(STORE_KEY, { at: new Date().toISOString(), breaches } satisfies HibpStore);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void this.logging.warn('topology', `Have I Been Pwned check failed: ${msg}`);
      await this.settings.set(STORE_KEY, { ...prev, failedAt: new Date().toISOString(), error: msg.slice(0, 200) } satisfies HibpStore);
      return false;
    }
  }
}

/** HIBP catalogue → the breaches tied to a website domain. */
export function parseBreaches(j: unknown): HibpBreach[] {
  const rows = Array.isArray(j) ? (j as { Name?: string; Title?: string; Domain?: string; BreachDate?: string; AddedDate?: string; PwnCount?: number; DataClasses?: string[]; IsSpamList?: boolean }[]) : [];
  return rows
    .filter((b) => b.Name && b.Domain && !b.IsSpamList)
    .map((b) => ({
      name: b.Name!,
      title: b.Title ?? b.Name!,
      domain: b.Domain!.toLowerCase(),
      breachDate: b.BreachDate,
      addedDate: b.AddedDate,
      pwnCount: b.PwnCount,
      dataClasses: b.DataClasses ?? [],
    }));
}
