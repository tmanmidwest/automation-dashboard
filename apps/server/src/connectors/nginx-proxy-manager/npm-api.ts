import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export interface NpmAuth {
  /** Admin UI origin, e.g. http://10.0.0.5:81 */
  baseUrl: string;
  /** Login email (identity). */
  identity: string;
  /** Login password (secret). */
  secret: string;
  /** Accept a self-signed HTTPS certificate. */
  insecureSkipVerify?: boolean;
}

export class NpmApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** POST /api/tokens */
interface NpmToken {
  token: string;
  expires?: string;
}

/** GET /api/ — unauthenticated health/version. */
export interface NpmHealth {
  status?: string;
  version?: { major?: number; minor?: number; revision?: number };
}

/** GET /api/reports/hosts */
export interface NpmHostReport {
  proxy?: number;
  redirection?: number;
  stream?: number;
  dead?: number;
}

interface NpmMeta {
  nginx_online?: boolean;
  nginx_err?: string | null;
}

/** GET /api/nginx/proxy-hosts */
export interface NpmProxyHost {
  id: number;
  domain_names?: string[];
  forward_scheme?: string; // http | https
  forward_host?: string;
  forward_port?: number;
  enabled?: number; // 0 | 1
  ssl_forced?: number;
  http2_support?: number;
  block_exploits?: number;
  caching_enabled?: number;
  allow_websocket_upgrade?: number;
  certificate_id?: number;
  access_list_id?: number;
  meta?: NpmMeta;
  created_on?: string;
  modified_on?: string;
}

/** GET /api/nginx/redirection-hosts */
export interface NpmRedirectionHost {
  id: number;
  domain_names?: string[];
  forward_scheme?: string; // http | https | auto ($scheme)
  forward_domain_name?: string;
  forward_http_code?: number;
  preserve_path?: number;
  enabled?: number;
  ssl_forced?: number;
  certificate_id?: number;
  meta?: NpmMeta;
}

/** GET /api/nginx/streams */
export interface NpmStream {
  id: number;
  incoming_port?: number;
  forwarding_host?: string;
  forwarding_port?: number;
  tcp_forwarding?: number;
  udp_forwarding?: number;
  enabled?: number;
  certificate_id?: number;
  meta?: NpmMeta;
}

/** GET /api/nginx/dead-hosts (404 hosts) */
export interface NpmDeadHost {
  id: number;
  domain_names?: string[];
  enabled?: number;
  ssl_forced?: number;
  certificate_id?: number;
  meta?: NpmMeta;
}

/** GET /api/nginx/certificates */
export interface NpmCertificate {
  id: number;
  provider?: string; // letsencrypt | other
  nice_name?: string;
  domain_names?: string[];
  expires_on?: string;
  created_on?: string;
  meta?: Record<string, unknown>;
}

/** GET /api/audit-log (newest first). `?expand=user` inlines the acting user. */
export interface NpmAuditEntry {
  id: number;
  created_on?: string;
  user_id?: number;
  object_type?: string; // proxy-host | redirection-host | stream | dead-host | certificate | access-list | user | ...
  object_id?: number;
  action?: string; // created | updated | deleted | enabled | disabled | renewed | ...
  meta?: Record<string, unknown>;
  user?: { id?: number; name?: string; nickname?: string; email?: string };
}

/** GET /api/nginx/access-lists */
export interface NpmAccessList {
  id: number;
  name?: string;
  satisfy_any?: number;
  pass_auth?: number;
  items?: { username?: string }[];
  clients?: { address?: string; directive?: string }[];
  proxy_host_count?: number;
}

/**
 * Minimal Nginx Proxy Manager (jc21/NPM) REST client — dependency-free HTTP/HTTPS.
 * Logs in once (POST /api/tokens) and caches the JWT on the instance, reusing it
 * across the calls in one fan-out. See docs/connectors/nginx-proxy-manager.md.
 */
export class NpmApi {
  private token?: string;

  constructor(private readonly auth: NpmAuth) {}

  /** GET /api/ — no auth; proves reachability and reports the NPM version. */
  health() {
    return this.request<NpmHealth>('GET', '/api/', undefined, { auth: false });
  }

  hostReport() { return this.get<NpmHostReport>('/api/reports/hosts'); }
  proxyHosts() { return this.get<NpmProxyHost[]>('/api/nginx/proxy-hosts'); }
  proxyHost(id: number | string) { return this.get<NpmProxyHost>(`/api/nginx/proxy-hosts/${enc(id)}`); }
  redirectionHosts() { return this.get<NpmRedirectionHost[]>('/api/nginx/redirection-hosts'); }
  streams() { return this.get<NpmStream[]>('/api/nginx/streams'); }
  deadHosts() { return this.get<NpmDeadHost[]>('/api/nginx/dead-hosts'); }
  certificates() { return this.get<NpmCertificate[]>('/api/nginx/certificates'); }
  accessLists() { return this.get<NpmAccessList[]>('/api/nginx/access-lists?expand=items,clients,proxy_hosts'); }
  /** Recent audit-log entries (newest first), with the acting user inlined. */
  auditLog() { return this.get<NpmAuditEntry[]>('/api/audit-log?expand=user'); }

  // ── Writes (Phase 2) ──────────────────────────────────────────────
  /**
   * Enable or disable a host. `segment` is the API path segment for the kind
   * (proxy-hosts | redirection-hosts | streams | dead-hosts).
   */
  setHostEnabled(segment: string, id: number | string, enabled: boolean) {
    return this.request<boolean>('POST', `/api/nginx/${segment}/${enc(id)}/${enabled ? 'enable' : 'disable'}`);
  }
  /** Delete any host / certificate / access-list entity by its API path segment. */
  deleteEntity(segment: string, id: number | string) {
    return this.request<boolean>('DELETE', `/api/nginx/${segment}/${enc(id)}`);
  }
  /** Renew a Let's Encrypt certificate. */
  renewCertificate(id: number | string) {
    return this.request<NpmCertificate>('POST', `/api/nginx/certificates/${enc(id)}/renew`);
  }
  createProxyHost(body: Record<string, unknown>) {
    return this.request<NpmProxyHost>('POST', '/api/nginx/proxy-hosts', body);
  }
  updateProxyHost(id: number | string, body: Record<string, unknown>) {
    return this.request<NpmProxyHost>('PUT', `/api/nginx/proxy-hosts/${enc(id)}`, body);
  }

  /** Exchange credentials for a JWT, or return the cached one. */
  async ensureToken(): Promise<string> {
    if (this.token) return this.token;
    const res = await this.request<NpmToken>(
      'POST',
      '/api/tokens',
      { identity: this.auth.identity, secret: this.auth.secret },
      { auth: false },
    );
    if (!res?.token) throw new NpmApiError('Login succeeded but no token was returned.');
    this.token = res.token;
    return this.token;
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { auth?: boolean } = {},
  ): Promise<T> {
    const useAuth = opts.auth !== false;
    let url: URL;
    try {
      url = new URL(path, this.baseUrl());
    } catch {
      return Promise.reject(new NpmApiError('Invalid Nginx Proxy Manager base URL.'));
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (useAuth) headers['Authorization'] = `Bearer ${await this.ensureToken()}`;

    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload).toString();
    }

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

    return new Promise((resolve, reject) => {
      const req = transport.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status === 401 || status === 403) {
            return reject(new NpmApiError('Authentication failed — check the email and password.', status));
          }
          if (status < 200 || status >= 300) {
            return reject(new NpmApiError(`Nginx Proxy Manager returned HTTP ${status}: ${errBody(text)}`, status));
          }
          if (!text) return resolve(undefined as T);
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new NpmApiError('Could not parse the Nginx Proxy Manager response as JSON.', status));
          }
        });
      });
      req.on('timeout', () => req.destroy(new NpmApiError('Nginx Proxy Manager request timed out.')));
      req.on('error', (err) => reject(new NpmApiError(friendly(err))));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  private baseUrl(): string {
    const b = (this.auth.baseUrl || '').trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(b) ? `${b}/` : `http://${b}/`;
  }
}

function enc(id: number | string): string {
  return encodeURIComponent(String(id));
}

/** NPM errors come back as `{ error: { message } }` — surface the message when present. */
function errBody(text: string): string {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message ?? j?.message;
    if (typeof m === 'string' && m) return m;
  } catch {
    /* not JSON */
  }
  return text.slice(0, 200);
}

function friendly(err: Error & { code?: string }): string {
  if (err.code === 'ECONNREFUSED') return 'Connection refused — is Nginx Proxy Manager running and the URL/port correct?';
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return 'Host could not be resolved — check the base URL.';
  if (err.code === 'ETIMEDOUT') return 'Connection timed out.';
  return err.message || 'Nginx Proxy Manager request failed.';
}
