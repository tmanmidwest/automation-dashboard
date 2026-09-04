import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export interface HaAuth {
  /** e.g. "https://ha.example.com" */
  baseUrl: string;
  /** Long-lived access token (Bearer). */
  token: string;
  /** Verify the TLS certificate. */
  verifyTls: boolean;
}

/** A single entity's state as returned by GET /api/states. */
export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

/** GET /api/config — a small, fixed payload used for the connection test. */
export interface HaConfig {
  version: string;
  location_name?: string;
  time_zone?: string;
  unit_system?: { temperature?: string };
}

export class HaApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Minimal Home Assistant REST client using long-lived-token (Bearer) auth.
 * Reads entity state (GET) and calls services (POST) for controls.
 */
export class HaApi {
  constructor(private readonly auth: HaAuth) {}

  private request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const url = new URL(`${this.auth.baseUrl.replace(/\/$/, '')}${path}`);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.auth.token}`,
      Accept: 'application/json',
    };

    // Home Assistant service calls take a JSON body.
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload).toString();
    }

    const options: https.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers,
      rejectUnauthorized: isHttps ? this.auth.verifyTls : undefined,
      timeout: 20000,
    };

    return new Promise<T>((resolve, reject) => {
      const req = lib.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status === 401 || status === 403) {
            return reject(
              new HaApiError('Authentication failed — check the long-lived access token and that it is still valid.', status),
            );
          }
          if (status < 200 || status >= 300) {
            return reject(new HaApiError(`Home Assistant returned HTTP ${status}: ${body.slice(0, 200)}`, status));
          }
          try {
            resolve((body ? JSON.parse(body) : {}) as T);
          } catch {
            reject(new HaApiError('Could not parse the Home Assistant response as JSON.'));
          }
        });
      });
      req.on('timeout', () => {
        req.destroy(new HaApiError('Connection to Home Assistant timed out.'));
      });
      if (payload) req.write(payload);
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || err.code === 'SELF_SIGNED_CERT_IN_CHAIN') {
          reject(new HaApiError('TLS certificate is self-signed. Disable "Verify TLS certificate" for this server, or install a trusted cert.'));
        } else if (err.code === 'ECONNREFUSED') {
          reject(new HaApiError('Connection refused — check the base URL and port.'));
        } else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || err.code === 'EAI_NODATA') {
          reject(new HaApiError('Host not found — check the base URL and that its DNS name resolves.'));
        } else {
          reject(new HaApiError(err.message));
        }
      });
      req.end();
    });
  }

  /** GET /api/config — validates auth and returns the HA version (cheap; used by testConnection). */
  async config(): Promise<HaConfig> {
    return this.request('GET', '/api/config');
  }

  /** GET /api/states — every entity with its current state and attributes. */
  async states(): Promise<HaState[]> {
    return this.request('GET', '/api/states');
  }

  /**
   * POST /api/services/<domain>/<service> — invoke a service (e.g. light.turn_on).
   * `data` carries the target and parameters, e.g. { entity_id, brightness_pct }.
   */
  async callService(domain: string, service: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, data);
  }
}
