import * as https from 'https';

/**
 * Minimal client for the UniFi Network **Integration API** (UniFi Network 9+ /
 * UniFi OS 4+), authenticated with an API key (`X-API-KEY`). Local gateways serve
 * a self-signed certificate, so TLS verification is off by default. See
 * docs/connectors/unifi.md.
 */
export interface UniAuth {
  /** Gateway host/IP, optionally with :port (default 443). */
  host: string;
  apiKey: string;
  /** Verify the controller's TLS certificate (default false — local self-signed). */
  verifyTls?: boolean;
}

const BASE = '/proxy/network/integration/v1';
const TIMEOUT_MS = 20000;

export class UniApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'UniApiError';
    this.status = status;
  }
}

// ── Response shapes (only the fields we read; all optional/defensive) ──

export interface UniInfo {
  applicationVersion?: string;
}

export interface UniSite {
  id: string;
  internalReference?: string;
  name?: string;
}

export interface UniDevice {
  id: string;
  name?: string;
  model?: string;
  macAddress?: string;
  ipAddress?: string;
  /** ONLINE | OFFLINE | PENDING_ADOPTION | UPDATING | … */
  state?: string;
  firmwareVersion?: string;
  firmwareUpdatable?: boolean;
  uptimeSec?: number;
  features?: string[];
  uplink?: { deviceId?: string };
}

export interface UniClient {
  id: string;
  name?: string;
  hostname?: string;
  ipAddress?: string;
  macAddress?: string;
  /** WIRED | WIRELESS */
  type?: string;
  connectedAt?: string;
  uplinkDeviceId?: string;
  access?: { type?: string };
}

/** UniFi's pagination envelope. */
interface Page<T> {
  offset?: number;
  limit?: number;
  count?: number;
  totalCount?: number;
  data?: T[];
}

export class UniApi {
  private readonly host: string;
  private readonly port: number;

  constructor(private readonly auth: UniAuth) {
    const raw = (auth.host || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const [h, p] = raw.split(':');
    this.host = h;
    this.port = p ? Number(p) : 443;
  }

  // ── Typed endpoints ─────────────────────────────────────────────

  info(): Promise<UniInfo> {
    return this.get<UniInfo>('/info');
  }
  listSites(): Promise<UniSite[]> {
    return this.getAll<UniSite>('/sites');
  }
  listDevices(siteId: string): Promise<UniDevice[]> {
    return this.getAll<UniDevice>(`/sites/${encodeURIComponent(siteId)}/devices`);
  }
  getDevice(siteId: string, deviceId: string): Promise<UniDevice> {
    return this.get<UniDevice>(`/sites/${encodeURIComponent(siteId)}/devices/${encodeURIComponent(deviceId)}`);
  }
  listClients(siteId: string): Promise<UniClient[]> {
    return this.getAll<UniClient>(`/sites/${encodeURIComponent(siteId)}/clients`);
  }
  /** Device action, e.g. RESTART (Phase 2). */
  deviceAction(siteId: string, deviceId: string, action: string): Promise<void> {
    return this.request<void>(
      'POST',
      `/sites/${encodeURIComponent(siteId)}/devices/${encodeURIComponent(deviceId)}/actions`,
      JSON.stringify({ action }),
    );
  }

  // ── Transport ───────────────────────────────────────────────────

  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  /** Fetch every page of a paginated collection and flatten the `data` arrays. */
  private async getAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let offset = 0;
    const limit = 200;
    for (let guard = 0; guard < 100; guard++) {
      const sep = path.includes('?') ? '&' : '?';
      const page = await this.request<Page<T>>('GET', `${path}${sep}offset=${offset}&limit=${limit}`);
      const rows = page?.data ?? [];
      out.push(...rows);
      offset += rows.length;
      const total = page?.totalCount ?? out.length;
      if (rows.length === 0 || out.length >= total) break;
    }
    return out;
  }

  private request<T>(method: string, path: string, body?: string): Promise<T> {
    const headers: Record<string, string> = {
      'X-API-KEY': this.auth.apiKey,
      Accept: 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body).toString();
    }
    const options: https.RequestOptions = {
      method,
      hostname: this.host,
      port: this.port,
      path: `${BASE}${path}`,
      headers,
      timeout: TIMEOUT_MS,
      rejectUnauthorized: !!this.auth.verifyTls,
    };

    return new Promise<T>((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status === 401 || status === 403) {
            return reject(new UniApiError('UniFi authentication failed — check the API key and that it has access to this site.', status));
          }
          if (status < 200 || status >= 300) {
            let detail = `HTTP ${status}`;
            try {
              const j = text ? (JSON.parse(text) as { message?: string; statusName?: string }) : undefined;
              detail = j?.message || j?.statusName || detail;
            } catch {
              if (text) detail = `${detail}: ${text.slice(0, 200)}`;
            }
            return reject(new UniApiError(`UniFi API error: ${detail}`, status));
          }
          if (!text) return resolve(undefined as T);
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new UniApiError('Could not parse the UniFi response as JSON.', status));
          }
        });
      });
      req.on('timeout', () => req.destroy(new UniApiError('Connection to the UniFi controller timed out.')));
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err instanceof UniApiError) return reject(err);
        if (err.code === 'ECONNREFUSED') reject(new UniApiError('Connection to the UniFi controller was refused — check the host and that the Network API is enabled.'));
        else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') reject(new UniApiError('Could not resolve the UniFi controller host.'));
        else reject(new UniApiError(err.message));
      });
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
}
