import { Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { LoggingService } from '../logging/logging.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';

/**
 * Certificate Transparency: every public certificate issued for your domains, from crt.sh.
 * Lets the posture findings spot certificates you didn't ask for (a new name, or someone
 * else getting a certificate for one of yours) and hostnames the public logs still list
 * that nothing in Cerebro serves any more. One query per domain a day, in the background,
 * cached in settings. Sends only your domain names to crt.sh.
 * See docs/architecture-map.md#posture-findings.
 */

const STORE_KEY = 'posture.ctLog';
export const RESOLVER_KEY = 'posture.publicDnsResolver';
export const DEFAULT_RESOLVER = 'https://cloudflare-dns.com/dns-query';
const TTL_MS = 24 * 3600_000;
const RETRY_MS = 3 * 3600_000;
/** crt.sh is a free shared service and often slow; be gentle. */
const GAP_MS = 5_000;
const TIMEOUT_MS = 60_000;

export interface CtCert {
  id: number;
  issuer: string;
  names: string[];
  notBefore: string;
  notAfter: string;
}
interface Entry {
  at: string;
  failedAt?: string;
  error?: string;
  certs: CtCert[];
}
export type CtStore = Record<string, Entry>;

/** Public suffixes with a second level (example.co.uk); enough for the domains a homelab uses. */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);
const PRIVATE_TLDS = new Set(['internal', 'local', 'lan', 'home', 'arpa', 'localdomain', 'test', 'invalid', 'example', 'corp', 'intranet']);

/** "a.b.example.co.uk" → "example.co.uk"; null for internal names and IPs. */
export function registrable(name: string): string | null {
  const n = name.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  if (!n.includes('.') || /^[\d.]+$/.test(n) || n.includes(':')) return null;
  const parts = n.split('.');
  if (PRIVATE_TLDS.has(parts[parts.length - 1])) return null;
  const take = parts.length >= 3 && parts[parts.length - 1].length === 2 && SECOND_LEVEL.has(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-take).join('.');
}

@Injectable()
export class CtLogService {
  constructor(
    private readonly settings: SettingsService,
    private readonly logging: LoggingService,
    private readonly instances: ConnectorInstanceService,
  ) {}

  private refreshing: Promise<boolean> | null = null;

  async cached(): Promise<CtStore> {
    return (await this.settings.get<CtStore>(STORE_KEY)) ?? {};
  }

  /** Cloudflare zones and DNS record names (from the cached resource lists). */
  async cloudflareNames(): Promise<{ zones: string[]; names: string[] }> {
    const zones = new Set<string>();
    const names = new Set<string>();
    for (const i of (await this.instances.list()).filter((x) => x.enabled && x.connectorId === 'cloudflare')) {
      try {
        for (const z of (await this.instances.listResourcesCached(i.id, 'zone', {})).resources) if (z.name) zones.add(z.name.toLowerCase());
        for (const r of (await this.instances.listResourcesCached(i.id, 'dns_record', {})).resources) {
          const n = typeof r.details?.name === 'string' ? r.details.name : null;
          if (n) names.add(n.toLowerCase());
        }
      } catch {
        /* a connector that's down: use what the map already knows */
      }
    }
    return { zones: [...zones], names: [...names] };
  }

  private resolveCache = new Map<string, { at: number; listed: boolean | null }>();

  /** DNS-over-HTTPS resolver (JSON API) used for "is this name public?"; a setting, Cloudflare by default. */
  async resolverUrl(): Promise<string> {
    const v = await this.settings.get<string>(RESOLVER_KEY);
    return typeof v === 'string' && /^https:\/\/[^\s/]+/.test(v) ? v : DEFAULT_RESOLVER;
  }

  async setResolverUrl(url: string | null): Promise<void> {
    if (url && !/^https:\/\/[^\s/]+/.test(url)) throw new Error('The resolver must be an https:// DNS-over-HTTPS address.');
    await this.settings.set(RESOLVER_KEY, url || null);
    this.resolveCache.clear();
  }

  /**
   * Is each name in public DNS? Asks a public DNS-over-HTTPS resolver, so split DNS at home
   * (Technitium answering for the same names, or the gateway catching port 53) can't make an
   * internal name look public. true = resolves publicly, false = doesn't exist publicly,
   * missing = couldn't tell. Cached 6 h.
   */
  async publicResolve(names: string[]): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    const now = Date.now();
    const todo: string[] = [];
    for (const n of [...new Set(names.map((x) => x.toLowerCase()))]) {
      const c = this.resolveCache.get(n);
      if (c && now - c.at < 6 * 3600_000) { if (c.listed != null) out[n] = c.listed; } else todo.push(n);
    }
    if (!todo.length) return out;
    const base = await this.resolverUrl();
    const query = async (name: string, type: 'A' | 'AAAA'): Promise<boolean | null> => {
      const u = new URL(base);
      u.searchParams.set('name', name);
      u.searchParams.set('type', type);
      const res = await fetch(u, { signal: AbortSignal.timeout(5_000), headers: { accept: 'application/dns-json' } });
      if (!res.ok) return null;
      const j = (await res.json()) as { Status?: number; Answer?: unknown[] };
      if (j.Status === 3) return false; // NXDOMAIN
      if (j.Status !== 0) return null; // SERVFAIL etc.: can't tell
      return Array.isArray(j.Answer) && j.Answer.length > 0;
    };
    await Promise.all(
      todo.map(async (n) => {
        let listed: boolean | null = null;
        try {
          const a = await query(n, 'A');
          listed = a === true ? true : a === null ? null : (await query(n, 'AAAA')) ?? a;
        } catch {
          listed = null;
        }
        this.resolveCache.set(n, { at: now, listed });
        if (listed != null) out[n] = listed;
      }),
    );
    return out;
  }

  refresh(domains: string[]): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh([...new Set(domains)].sort()).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(domains: string[]): Promise<boolean> {
    const store = await this.cached();
    const now = Date.now();
    // Forget domains you no longer have.
    for (const d of Object.keys(store)) if (!domains.includes(d)) delete store[d];
    const todo = domains.filter((d) => {
      const e = store[d];
      if (!e) return true;
      if (e.failedAt && now - new Date(e.failedAt).getTime() < RETRY_MS) return false;
      return now - new Date(e.at).getTime() > TTL_MS;
    });
    let changed = false;
    for (const [i, d] of todo.entries()) {
      if (i) await new Promise((r) => setTimeout(r, GAP_MS));
      try {
        store[d] = { at: new Date().toISOString(), certs: await this.fetchDomain(d) };
        changed = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        store[d] = { ...(store[d] ?? { at: new Date(0).toISOString(), certs: [] }), failedAt: new Date().toISOString(), error: msg.slice(0, 200) };
        void this.logging.warn('topology', `Certificate log check: crt.sh query for ${d} failed: ${msg}`);
      }
      await this.settings.set(STORE_KEY, store);
    }
    return changed;
  }

  private async fetchDomain(domain: string): Promise<CtCert[]> {
    const url = `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json&exclude=expired`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json', 'user-agent': 'Cerebro posture checks' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseCrtSh(await res.text());
  }
}

/** crt.sh JSON → one entry per certificate (crt.sh lists the precertificate and the certificate separately). */
export function parseCrtSh(text: string): CtCert[] {
  const rows = JSON.parse(text || '[]') as { id?: number; issuer_name?: string; name_value?: string; common_name?: string; not_before?: string; not_after?: string; serial_number?: string }[];
  const bySerial = new Map<string, CtCert>();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r.id || !r.not_before || !r.not_after) continue;
    const names = [...new Set(`${r.name_value ?? ''}\n${r.common_name ?? ''}`.split(/\s+/).map((n) => n.trim().toLowerCase()).filter((n) => n.includes('.')))].sort();
    const key = `${r.issuer_name}|${r.serial_number ?? r.id}`;
    const prev = bySerial.get(key);
    if (prev) {
      prev.names = [...new Set([...prev.names, ...names])].sort();
      prev.id = Math.min(prev.id, r.id);
      continue;
    }
    // "C=US, O=Let's Encrypt, CN=R11" → "Let's Encrypt (R11)"
    const iss = r.issuer_name ?? '';
    const o = /(?:^|,\s*)O="?([^,"]+)"?/.exec(iss)?.[1];
    const cn = /(?:^|,\s*)CN="?([^,"]+)"?/.exec(iss)?.[1];
    bySerial.set(key, { id: r.id, issuer: o ? `${o}${cn ? ` (${cn})` : ''}` : cn ?? iss, names, notBefore: r.not_before, notAfter: r.not_after });
  }
  return [...bySerial.values()].sort((a, b) => b.notBefore.localeCompare(a.notBefore));
}
