import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/** Cap a buffered HTTP response body so a hostile/compromised host can't OOM us. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface TechAuth {
  /** Admin UI / API origin, e.g. http://192.168.10.1:5380 */
  baseUrl: string;
  /** API token (Administration → Sessions → Create API Token). Bearer auth since v15. */
  apiToken: string;
  /** Accept a self-signed HTTPS certificate. */
  insecureSkipVerify?: boolean;
}

export class TechApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** GET /api/user/session/get — validates the token and reports server info (cheap). */
export interface TechSession {
  displayName?: string;
  username?: string;
  isSsoUser?: boolean;
  info?: {
    version?: string;
    dnsServerDomain?: string;
    uptimestamp?: string;
    defaultRecordTtl?: number;
    dnssecValidation?: boolean;
    permissions?: Record<string, unknown>;
  };
}

/** The `stats` object inside GET /api/dashboard/stats/get. */
export interface TechStats {
  totalQueries?: number;
  totalNoError?: number;
  totalServerFailure?: number;
  totalNxDomain?: number;
  totalRefused?: number;
  totalAuthoritative?: number;
  totalRecursive?: number;
  totalCached?: number;
  totalBlocked?: number;
  totalDropped?: number;
  totalClients?: number;
  zones?: number;
  cachedEntries?: number;
  allowedZones?: number;
  blockedZones?: number;
  allowListZones?: number;
  blockListZones?: number;
}

/** A row in topClients / topDomains / topBlockedDomains. */
export interface TechTopItem {
  name: string;
  domain?: string;
  hits?: number;
  rateLimited?: boolean;
}

/** The full GET /api/dashboard/stats/get payload (the parts we use). */
export interface TechDashboard {
  stats?: TechStats;
  topClients?: TechTopItem[];
  topDomains?: TechTopItem[];
  topBlockedDomains?: TechTopItem[];
}

/** A zone from GET /api/zones/list. */
export interface TechZone {
  name: string;
  type?: string; // Primary | Secondary | Stub | Forwarder | SecondaryForwarder | Catalog | ...
  internal?: boolean;
  dnssecStatus?: string; // Unsigned | Signed | SignedWithNSEC | SignedWithNSEC3 | ...
  soaSerial?: number;
  expiry?: string;
  isExpired?: boolean;
  syncFailed?: boolean;
  notifyFailed?: boolean;
  lastModified?: string;
  disabled?: boolean;
}

/** A DHCP scope from GET /api/dhcp/scopes/list. */
export interface TechDhcpScope {
  name: string;
  enabled?: boolean;
  startingAddress?: string;
  endingAddress?: string;
  subnetMask?: string;
  networkAddress?: string;
  broadcastAddress?: string;
}

/** A DHCP lease from GET /api/dhcp/leases/list. */
export interface TechDhcpLease {
  scope?: string;
  type?: string; // Dynamic | Reserved
  hardwareAddress?: string;
  clientIdentifier?: string;
  address?: string;
  hostName?: string;
  leaseObtained?: string;
  leaseExpires?: string;
}

/** The subset of GET /api/settings/get we use. */
export interface TechSettings {
  blockListUrls?: string[];
}

/** A DNS record from GET /api/zones/records/get. `rData` is type-specific. */
export interface TechRecord {
  name: string;
  type: string;
  ttl?: number;
  disabled?: boolean;
  dnssecStatus?: string;
  rData?: Record<string, unknown>;
}

/**
 * The allowed/blocked zone tree node (GET /api/allowed|blocked/list). `zones`
 * holds the immediate child labels (the manually allowed/blocked domains);
 * `records` holds any DNS records defined at this node.
 */
export interface TechZoneTree {
  domain?: string;
  zones?: string[];
  records?: { name?: string; type?: string; ttl?: number; rData?: Record<string, unknown> }[];
}

/**
 * Minimal Technitium DNS Server API client — dependency-free HTTP/HTTPS in the
 * NPM/Cloudflare style. Sends the token as `Authorization: Bearer <token>`
 * (required since Technitium v15). Technitium wraps most responses in
 * `{ status, response: {...} }`; this client checks `status` and unwraps
 * `response`, mapping failures to a friendly TechApiError. See
 * docs/connectors/technitium.md.
 */
export class TechnitiumApi {
  constructor(private readonly auth: TechAuth) {}

  /** GET /api/user/session/get — cheap token validation + server info. */
  getSession(): Promise<TechSession> {
    // session/get returns its fields at the top level (no `response` wrapper).
    return this.request<TechSession>('GET', '/api/user/session/get', { unwrap: false });
  }

  /** GET /api/dashboard/stats/get — aggregate stats + top lists for the overview. */
  getDashboard(type = 'LastHour'): Promise<TechDashboard> {
    return this.request<TechDashboard>('GET', `/api/dashboard/stats/get?type=${encodeURIComponent(type)}`);
  }

  /** GET /api/zones/list — all authoritative/forwarder/stub zones (walks pagination). */
  async listZones(): Promise<TechZone[]> {
    const out: TechZone[] = [];
    const perPage = 50;
    // Hard cap the page walk so a surprise large server can't spin forever.
    for (let page = 1; page <= 200; page++) {
      const res = await this.request<{ zones?: TechZone[]; totalPages?: number }>(
        'GET',
        `/api/zones/list?pageNumber=${page}&zonesPerPage=${perPage}`,
      );
      if (Array.isArray(res.zones)) out.push(...res.zones);
      const totalPages = res.totalPages ?? 1;
      if (!totalPages || page >= totalPages) break;
    }
    return out;
  }

  /** GET /api/dhcp/scopes/list — configured DHCP scopes. */
  async listDhcpScopes(): Promise<TechDhcpScope[]> {
    const res = await this.request<{ scopes?: TechDhcpScope[] }>('GET', '/api/dhcp/scopes/list');
    return res.scopes ?? [];
  }

  /** GET /api/dhcp/leases/list — active DHCP leases. */
  async listDhcpLeases(): Promise<TechDhcpLease[]> {
    const res = await this.request<{ leases?: TechDhcpLease[] }>('GET', '/api/dhcp/leases/list');
    return res.leases ?? [];
  }

  /** GET /api/allowed/list — the manually allowed domains at the root of the allow tree. */
  listAllowed(domain = ''): Promise<TechZoneTree> {
    return this.request<TechZoneTree>('GET', `/api/allowed/list?domain=${encodeURIComponent(domain)}&direction=down`);
  }

  /** GET /api/blocked/list — the manually blocked domains at the root of the block tree. */
  listBlocked(domain = ''): Promise<TechZoneTree> {
    return this.request<TechZoneTree>('GET', `/api/blocked/list?domain=${encodeURIComponent(domain)}&direction=down`);
  }

  // ── Phase 2: writes ───────────────────────────────────────────────

  /** GET /api/zones/records/get?listZone=true — every record in a zone. */
  async getRecords(zone: string): Promise<TechRecord[]> {
    const res = await this.request<{ records?: TechRecord[] }>(
      'GET',
      `/api/zones/records/get?domain=${encodeURIComponent(zone)}&zone=${encodeURIComponent(zone)}&listZone=true`,
    );
    return res.records ?? [];
  }

  /** POST /api/zones/enable — bring a disabled zone back online. */
  enableZone(zone: string): Promise<void> {
    return this.mutate(`/api/zones/enable?zone=${encodeURIComponent(zone)}`);
  }

  /** POST /api/zones/disable — take a zone offline (stops answering for it). */
  disableZone(zone: string): Promise<void> {
    return this.mutate(`/api/zones/disable?zone=${encodeURIComponent(zone)}`);
  }

  /** POST /api/zones/delete — permanently delete a zone. */
  deleteZone(zone: string): Promise<void> {
    return this.mutate(`/api/zones/delete?zone=${encodeURIComponent(zone)}`);
  }

  /** POST /api/zones/records/add — add a record (params are type-specific; see the connector). */
  addRecord(params: Record<string, string>): Promise<void> {
    return this.mutate(`/api/zones/records/add?${qs(params)}`);
  }

  /** POST /api/zones/records/update — update a record (current + new-prefixed params). */
  updateRecord(params: Record<string, string>): Promise<void> {
    return this.mutate(`/api/zones/records/update?${qs(params)}`);
  }

  /** POST /api/zones/records/delete — remove a record (type + value params identify it). */
  deleteRecord(params: Record<string, string>): Promise<void> {
    return this.mutate(`/api/zones/records/delete?${qs(params)}`);
  }

  /** POST /api/allowed/add — manually allow a domain (overrides blocking). */
  addAllowed(domain: string): Promise<void> {
    return this.mutate(`/api/allowed/add?domain=${encodeURIComponent(domain)}`);
  }

  /** POST /api/allowed/delete — remove a manually allowed domain. */
  deleteAllowed(domain: string): Promise<void> {
    return this.mutate(`/api/allowed/delete?domain=${encodeURIComponent(domain)}`);
  }

  /** POST /api/blocked/add — manually block a domain. */
  addBlocked(domain: string): Promise<void> {
    return this.mutate(`/api/blocked/add?domain=${encodeURIComponent(domain)}`);
  }

  /** POST /api/blocked/delete — remove a manually blocked domain. */
  deleteBlocked(domain: string): Promise<void> {
    return this.mutate(`/api/blocked/delete?domain=${encodeURIComponent(domain)}`);
  }

  // ── Phase 4: cache, block lists, DHCP reservations ────────────────

  /** GET /api/cache/list — the cached child labels under a domain (root by default). */
  listCache(domain = ''): Promise<TechZoneTree> {
    return this.request<TechZoneTree>('GET', `/api/cache/list?domain=${encodeURIComponent(domain)}&direction=down`);
  }

  /** POST /api/cache/flush — clear the entire resolver cache. */
  flushCache(): Promise<void> {
    return this.mutate('/api/cache/flush');
  }

  /** POST /api/cache/delete — drop a domain (and its subtree) from the cache. */
  deleteCache(domain: string): Promise<void> {
    return this.mutate(`/api/cache/delete?domain=${encodeURIComponent(domain)}`);
  }

  /** GET /api/settings/get — reads the full settings (we only use `blockListUrls`). */
  getSettings(): Promise<TechSettings> {
    return this.request<TechSettings>('GET', '/api/settings/get');
  }

  /** POST /api/settings/set?blockListUrls=... — replace the block-list URL set (empty → `false` clears it). */
  setBlockListUrls(urls: string[]): Promise<void> {
    const value = urls.length ? encodeURIComponent(urls.join(',')) : 'false';
    return this.mutate(`/api/settings/set?blockListUrls=${value}`);
  }

  /** POST /api/settings/forceUpdateBlockLists — re-download the block lists now. */
  forceUpdateBlockLists(): Promise<void> {
    return this.mutate('/api/settings/forceUpdateBlockLists');
  }

  /** POST /api/settings/temporaryDisableBlocking?minutes=N — pause ad-blocking for a while. */
  temporaryDisableBlocking(minutes: number): Promise<void> {
    return this.mutate(`/api/settings/temporaryDisableBlocking?minutes=${encodeURIComponent(String(minutes))}`);
  }

  /** POST /api/dhcp/leases/convertToReserved — pin a dynamic lease to its current IP. */
  dhcpConvertToReserved(params: Record<string, string>): Promise<void> {
    return this.mutate(`/api/dhcp/leases/convertToReserved?${qs(params)}`);
  }

  /** POST /api/dhcp/leases/convertToDynamic — release a reserved lease back to the pool. */
  dhcpConvertToDynamic(params: Record<string, string>): Promise<void> {
    return this.mutate(`/api/dhcp/leases/convertToDynamic?${qs(params)}`);
  }

  /** POST /api/dhcp/leases/remove — delete a lease (use carefully; can cause IP conflicts). */
  dhcpRemoveLease(params: Record<string, string>): Promise<void> {
    return this.mutate(`/api/dhcp/leases/remove?${qs(params)}`);
  }

  /** A write call: POST with the params already in the query string; ignores the (empty) body. */
  private async mutate(path: string): Promise<void> {
    await this.request<unknown>('POST', path);
  }

  // ── transport ─────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    opts: { unwrap?: boolean } = {},
  ): Promise<T> {
    const unwrap = opts.unwrap !== false;
    let url: URL;
    try {
      url = new URL(path, this.baseUrl());
    } catch {
      throw new TechApiError('Invalid Technitium base URL.');
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.auth.apiToken}`,
    };

    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const options: https.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers,
      timeout: 20000,
      ...(isHttps && this.auth.insecureSkipVerify ? { rejectUnauthorized: false } : {}),
    };

    const parsed = await new Promise<{ status: number; json: unknown; text: string }>((resolve, reject) => {
      const req = transport.request(options, (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total > MAX_RESPONSE_BYTES) return void req.destroy(new TechApiError('Technitium response exceeded the size limit.'));
          chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          let json: unknown;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status, json, text });
        });
      });
      req.on('timeout', () => req.destroy(new TechApiError('Technitium request timed out.')));
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err instanceof TechApiError) return reject(err);
        reject(new TechApiError(friendly(err)));
      });
      req.end();
    });

    const { status, json, text } = parsed;
    if (status === 401 || status === 403) {
      throw new TechApiError('Authentication failed — check the API token and its permissions.', status);
    }
    if (status < 200 || status >= 300) {
      throw new TechApiError(`Technitium returned HTTP ${status}: ${text.slice(0, 200)}`, status);
    }
    if (json === undefined || typeof json !== 'object' || json === null) {
      throw new TechApiError('Could not parse the Technitium response as JSON.', status);
    }

    // Technitium signals API-level outcome in the body's `status` field (HTTP is 200 even on error).
    const body = json as { status?: string; errorMessage?: string; response?: unknown };
    if (body.status === 'invalid-token') {
      throw new TechApiError('Authentication failed — the API token is invalid or expired.', status);
    }
    if (body.status === '2fa-required') {
      throw new TechApiError('This account requires two-factor auth; use an API token instead of a session login.', status);
    }
    if (body.status && body.status !== 'ok') {
      throw new TechApiError(`Technitium API error: ${body.errorMessage || body.status}`, status);
    }

    if (!unwrap) return body as unknown as T;
    return (body.response ?? {}) as T;
  }

  private baseUrl(): string {
    const b = (this.auth.baseUrl || '').trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(b) ? `${b}/` : `http://${b}/`;
  }
}

/** Build a query string from params, skipping undefined/empty values. */
function qs(params: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.join('&');
}

function friendly(err: Error & { code?: string }): string {
  if (err.code === 'ECONNREFUSED') return 'Connection refused — is Technitium running and the URL/port (default 5380) correct?';
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return 'Host could not be resolved — check the base URL.';
  if (err.code === 'ETIMEDOUT') return 'Connection timed out.';
  if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || err.code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return 'TLS certificate not trusted — enable "Accept self-signed certificate" if this is expected.';
  }
  return err.message || 'Technitium request failed.';
}
