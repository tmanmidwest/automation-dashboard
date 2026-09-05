import * as https from 'https';
import { URL } from 'url';

export interface CfAuth {
  /** Scoped API token (Bearer). */
  apiToken: string;
  /** Optional account id; auto-resolved when the token sees exactly one account. */
  accountId?: string;
}

/** GET /user/tokens/verify — the cheap call used by testConnection. */
export interface CfTokenVerify {
  id: string;
  status: string; // "active" | "disabled" | "expired"
  expires_on?: string | null;
  not_before?: string | null;
}

/** An account the token can see (GET /accounts). */
export interface CfAccount {
  id: string;
  name: string;
}

/** A zone (GET /zones). */
export interface CfZone {
  id: string;
  name: string;
  status: string; // active | pending | initializing | moved | deleted | deactivated
  paused: boolean;
  type?: string; // full | partial | secondary
  name_servers?: string[];
  plan?: { name?: string };
}

/** A DNS record (GET /zones/:id/dns_records). */
export interface CfDnsRecord {
  id: string;
  zone_id?: string;
  zone_name?: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  proxiable?: boolean;
  ttl?: number;
  comment?: string | null;
}

/** A Cloudflare Tunnel (GET /accounts/:id/cfd_tunnel). */
export interface CfTunnel {
  id: string;
  name: string;
  status: string; // healthy | degraded | down | inactive
  created_at?: string;
  deleted_at?: string | null;
  conns_active_at?: string | null;
  conns_inactive_at?: string | null;
  connections?: { colo_name?: string; client_version?: string; origin_ip?: string; is_pending_reconnect?: boolean }[];
}

/** A Zero Trust Access application (GET /accounts/:id/access/apps). */
export interface CfAccessApp {
  id: string;
  name?: string;
  domain?: string;
  type?: string; // self_hosted | saas | ssh | vnc | warp | ...
  aud?: string;
  created_at?: string;
  updated_at?: string;
}

/** A Zero Trust Access service token (GET /accounts/:id/access/service_tokens). */
export interface CfServiceToken {
  id: string;
  name?: string;
  client_id?: string;
  created_at?: string;
  updated_at?: string;
  expires_at?: string;
  duration?: string;
}

/** A WARP / Zero Trust enrolled device (GET /accounts/:id/devices). */
export interface CfDevice {
  id: string;
  name?: string;
  user?: { email?: string; name?: string };
  model?: string;
  os_version?: string;
  device_type?: string;
  last_seen?: string;
  created?: string;
  deleted?: boolean;
}

/** A Workers script (GET /accounts/:id/workers/scripts). The `id` is the script name. */
export interface CfWorker {
  id: string;
  created_on?: string;
  modified_on?: string;
  usage_model?: string;
}

/** A Pages project (GET /accounts/:id/pages/projects). */
export interface CfPagesProject {
  id?: string;
  name: string;
  subdomain?: string;
  domains?: string[];
  created_on?: string;
  production_branch?: string;
  latest_deployment?: {
    id?: string;
    created_on?: string;
    environment?: string;
    latest_stage?: { name?: string; status?: string };
  };
}

/** An R2 bucket (GET /accounts/:id/r2/buckets → { buckets: [...] }). */
export interface CfR2Bucket {
  name: string;
  creation_date?: string;
  location?: string;
}

/** A load balancer (GET /zones/:id/load_balancers). */
export interface CfLoadBalancer {
  id: string;
  name: string;
  enabled?: boolean;
  proxied?: boolean;
  description?: string;
  default_pools?: string[];
  fallback_pool?: string;
}

/** A WAF ruleset (GET /zones/:id/rulesets). */
export interface CfRuleset {
  id: string;
  name?: string;
  phase?: string; // e.g. http_request_firewall_custom
  kind?: string; // e.g. zone | managed | root
  rules?: CfRule[];
}

/** A single rule within a ruleset. */
export interface CfRule {
  id: string;
  description?: string;
  expression: string;
  action: string; // block | challenge | js_challenge | managed_challenge | skip | log | ...
  enabled?: boolean;
  ref?: string;
}

/** An SSL/TLS certificate pack (GET /zones/:id/ssl/certificate_packs). */
export interface CfCertPack {
  id: string;
  type?: string; // universal | advanced | custom | ...
  status?: string; // active | pending_validation | expired | ...
  hosts?: string[];
  primary_certificate?: string;
  certificates?: {
    id?: string;
    hosts?: string[];
    issuer?: string;
    expires_on?: string;
    status?: string;
  }[];
}

/** Cloudflare's standard response envelope. */
interface CfEnvelope<T> {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  messages?: { code?: number; message?: string }[];
  result: T;
  result_info?: { page?: number; per_page?: number; total_count?: number; total_pages?: number };
}

export class CfApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const API_HOST = 'api.cloudflare.com';
const API_BASE = '/client/v4';

/**
 * Minimal Cloudflare API v4 client using scoped-token (Bearer) auth. Dependency-free
 * HTTPS in the Proxmox/HA style. Unwraps Cloudflare's `{ success, errors, result }`
 * envelope and maps failures to a friendly CfApiError. All calls hit
 * https://api.cloudflare.com over TLS, so there is no verifyTls option.
 */
export class CfApi {
  constructor(private readonly auth: CfAuth) {}

  /** Shared HTTP: performs the request and resolves the status + parsed JSON (or raw text). */
  private rawJson(method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; json: unknown; text: string }> {
    const url = new URL(`https://${API_HOST}${API_BASE}${path}`);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.auth.apiToken}`,
      Accept: 'application/json',
    };

    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload).toString();
    }

    const options: https.RequestOptions = {
      method,
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      headers,
      timeout: 20000,
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
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
      req.on('timeout', () => req.destroy(new CfApiError('Connection to Cloudflare timed out.')));
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || err.code === 'EAI_NODATA') {
          reject(new CfApiError('Could not reach api.cloudflare.com — check network/DNS from the Cerebro host.'));
        } else if (err.code === 'ECONNREFUSED') {
          reject(new CfApiError('Connection to api.cloudflare.com refused.'));
        } else if (err instanceof CfApiError) {
          reject(err);
        } else {
          reject(new CfApiError(err.message));
        }
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** A REST call returning Cloudflare's `{ success, errors, result }` envelope. */
  private async request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<CfEnvelope<T>> {
    const { status, json, text } = await this.rawJson(method, path, body);
    const parsed = json as CfEnvelope<T> | undefined;
    // Cloudflare returns 200 with success:false on API-level errors, and 4xx/5xx
    // with the same envelope. Prefer the envelope's error message either way.
    if (parsed && parsed.success === false) {
      const first = parsed.errors?.[0];
      const detail = first?.message ? first.message : `HTTP ${status}`;
      // 6003/6111 = malformed Authorization header, 9109/10000 = invalid/insufficient token.
      const authCodes = new Set([6003, 6111, 9109, 9103, 10000]);
      if (status === 401 || status === 403 || (first?.code != null && authCodes.has(first.code))) {
        throw new CfApiError(
          `Authentication failed — check the API token and that it has the required permissions. (${detail})`,
          status,
        );
      }
      throw new CfApiError(`Cloudflare API error: ${detail}`, status);
    }
    if (status < 200 || status >= 300) throw new CfApiError(`Cloudflare returned HTTP ${status}: ${text.slice(0, 200)}`, status);
    if (json === undefined) throw new CfApiError('Could not parse the Cloudflare response as JSON.', status);
    return parsed as CfEnvelope<T>;
  }

  /**
   * A GraphQL Analytics call (POST /graphql). This endpoint does NOT use the REST
   * `{ success, result }` envelope — it returns `{ data, errors }` — so it's handled
   * separately. Returns `data`; throws on transport or GraphQL errors.
   */
  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const { status, json } = await this.rawJson('POST', '/graphql', { query, variables });
    const body = json as { data?: T; errors?: { message?: string }[] } | undefined;
    if (status === 401 || status === 403) {
      throw new CfApiError('Authentication failed — the token lacks Analytics read permission.', status);
    }
    if (body?.errors?.length) throw new CfApiError(`Cloudflare GraphQL error: ${body.errors[0]?.message ?? 'unknown'}`, status);
    if (status < 200 || status >= 300) throw new CfApiError(`Cloudflare GraphQL returned HTTP ${status}.`, status);
    if (!body?.data) throw new CfApiError('Empty GraphQL response from Cloudflare.', status);
    return body.data;
  }

  /** GET a paginated list endpoint, following result_info.total_pages. */
  private async getPaged<T>(path: string, perPage = 50): Promise<T[]> {
    const sep = path.includes('?') ? '&' : '?';
    const out: T[] = [];
    let page = 1;
    // Hard cap the page walk so a surprise large account can't spin forever.
    for (let guard = 0; guard < 40; guard++) {
      const env = await this.request<T[]>('GET', `${path}${sep}per_page=${perPage}&page=${page}`);
      if (Array.isArray(env.result)) out.push(...env.result);
      const totalPages = env.result_info?.total_pages ?? 1;
      if (!totalPages || page >= totalPages) break;
      page++;
    }
    return out;
  }

  /** GET /user/tokens/verify — validates the token (cheap; used by testConnection). */
  async verifyToken(): Promise<CfTokenVerify> {
    const env = await this.request<CfTokenVerify>('GET', '/user/tokens/verify');
    return env.result;
  }

  /** GET /accounts — accounts this token can see (used to auto-resolve accountId). */
  async listAccounts(): Promise<CfAccount[]> {
    return this.getPaged<CfAccount>('/accounts');
  }

  /** GET /zones — all zones the token can see. */
  async listZones(): Promise<CfZone[]> {
    return this.getPaged<CfZone>('/zones');
  }

  /** GET /zones/:id/dns_records — DNS records for one zone. */
  async listDnsRecords(zoneId: string): Promise<CfDnsRecord[]> {
    return this.getPaged<CfDnsRecord>(`/zones/${encodeURIComponent(zoneId)}/dns_records`, 100);
  }

  /** GET /accounts/:id/cfd_tunnel — Cloudflare Tunnels (excludes deleted). */
  async listTunnels(accountId: string): Promise<CfTunnel[]> {
    return this.getPaged<CfTunnel>(`/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?is_deleted=false`);
  }

  /** GET /accounts/:id/cfd_tunnel/:tid — one tunnel (with its connections). */
  async getTunnel(accountId: string, tunnelId: string): Promise<CfTunnel> {
    const env = await this.request<CfTunnel>(
      'GET',
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`,
    );
    return env.result;
  }

  /** GET /zones/:id/ssl/certificate_packs — all edge certificate packs (any status). */
  async listCertificatePacks(zoneId: string): Promise<CfCertPack[]> {
    return this.getPaged<CfCertPack>(`/zones/${encodeURIComponent(zoneId)}/ssl/certificate_packs?status=all`);
  }

  /** GET /accounts/:id/access/apps — Zero Trust Access applications. */
  async listAccessApps(accountId: string): Promise<CfAccessApp[]> {
    return this.getPaged<CfAccessApp>(`/accounts/${encodeURIComponent(accountId)}/access/apps`);
  }

  /** GET /accounts/:id/access/service_tokens — Zero Trust Access service tokens. */
  async listServiceTokens(accountId: string): Promise<CfServiceToken[]> {
    return this.getPaged<CfServiceToken>(`/accounts/${encodeURIComponent(accountId)}/access/service_tokens`);
  }

  /** GET /accounts/:id/devices — WARP / Zero Trust enrolled devices. */
  async listDevices(accountId: string): Promise<CfDevice[]> {
    return this.getPaged<CfDevice>(`/accounts/${encodeURIComponent(accountId)}/devices`);
  }

  /** GET /accounts/:id/workers/scripts — deployed Workers scripts. */
  async listWorkers(accountId: string): Promise<CfWorker[]> {
    const env = await this.request<CfWorker[]>('GET', `/accounts/${encodeURIComponent(accountId)}/workers/scripts`);
    return env.result ?? [];
  }

  /** GET /accounts/:id/pages/projects — Cloudflare Pages projects. */
  async listPagesProjects(accountId: string): Promise<CfPagesProject[]> {
    const env = await this.request<CfPagesProject[]>('GET', `/accounts/${encodeURIComponent(accountId)}/pages/projects`);
    return env.result ?? [];
  }

  /** GET /accounts/:id/pages/projects/:name — one Pages project (with latest_deployment). */
  async getPagesProject(accountId: string, name: string): Promise<CfPagesProject> {
    const env = await this.request<CfPagesProject>('GET', `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(name)}`);
    return env.result;
  }

  /** POST .../pages/projects/:name/deployments/:deploymentId/retry — re-run a deployment. */
  async retryPagesDeployment(accountId: string, name: string, deploymentId: string): Promise<void> {
    await this.request<unknown>(
      'POST',
      `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(name)}/deployments/${encodeURIComponent(deploymentId)}/retry`,
    );
  }

  /** GET /accounts/:id/r2/buckets — R2 buckets (result is { buckets: [...] }). */
  async listR2Buckets(accountId: string): Promise<CfR2Bucket[]> {
    const env = await this.request<{ buckets?: CfR2Bucket[] }>('GET', `/accounts/${encodeURIComponent(accountId)}/r2/buckets`);
    return env.result?.buckets ?? [];
  }

  /** GET /zones/:id/load_balancers — load balancers for a zone. */
  async listLoadBalancers(zoneId: string): Promise<CfLoadBalancer[]> {
    const env = await this.request<CfLoadBalancer[]>('GET', `/zones/${encodeURIComponent(zoneId)}/load_balancers`);
    return env.result ?? [];
  }

  /** GET /zones/:id/rulesets — all rulesets (entry points + phases) for a zone. */
  async listRulesets(zoneId: string): Promise<CfRuleset[]> {
    const env = await this.request<CfRuleset[]>('GET', `/zones/${encodeURIComponent(zoneId)}/rulesets`);
    return env.result ?? [];
  }

  /** GET /zones/:id/rulesets/:rid — a ruleset including its rules. */
  async getRuleset(zoneId: string, rulesetId: string): Promise<CfRuleset> {
    const env = await this.request<CfRuleset>('GET', `/zones/${encodeURIComponent(zoneId)}/rulesets/${encodeURIComponent(rulesetId)}`);
    return env.result;
  }

  /** PATCH /zones/:id/rulesets/:rid/rules/:ruleId — update a rule (e.g. toggle `enabled`). */
  async updateRulesetRule(zoneId: string, rulesetId: string, ruleId: string, body: Record<string, unknown>): Promise<void> {
    await this.request<unknown>(
      'PATCH',
      `/zones/${encodeURIComponent(zoneId)}/rulesets/${encodeURIComponent(rulesetId)}/rules/${encodeURIComponent(ruleId)}`,
      body,
    );
  }

  // ---- Phase 2: writes ----

  /** GET one DNS record (for edit prefill / proxiable check). */
  async getDnsRecord(zoneId: string, recordId: string): Promise<CfDnsRecord> {
    const env = await this.request<CfDnsRecord>(
      'GET',
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
    );
    return env.result;
  }

  /** POST a new DNS record. */
  async createDnsRecord(zoneId: string, body: Record<string, unknown>): Promise<CfDnsRecord> {
    const env = await this.request<CfDnsRecord>('POST', `/zones/${encodeURIComponent(zoneId)}/dns_records`, body);
    return env.result;
  }

  /** PATCH (partial-update) a DNS record. */
  async updateDnsRecord(zoneId: string, recordId: string, body: Record<string, unknown>): Promise<CfDnsRecord> {
    const env = await this.request<CfDnsRecord>(
      'PATCH',
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
      body,
    );
    return env.result;
  }

  /** DELETE a DNS record. */
  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`);
  }

  /** POST /zones/:id/purge_cache — body is { purge_everything: true } or { files: [...] }. */
  async purgeCache(zoneId: string, body: Record<string, unknown>): Promise<void> {
    await this.request<unknown>('POST', `/zones/${encodeURIComponent(zoneId)}/purge_cache`, body);
  }

  /** GET /zones/:id/settings/:name — returns { id, value, ... }. */
  async getZoneSetting(zoneId: string, setting: string): Promise<{ id: string; value: unknown }> {
    const env = await this.request<{ id: string; value: unknown }>(
      'GET',
      `/zones/${encodeURIComponent(zoneId)}/settings/${encodeURIComponent(setting)}`,
    );
    return env.result;
  }

  /** PATCH /zones/:id/settings/:name — body is { value }. */
  async patchZoneSetting(zoneId: string, setting: string, value: unknown): Promise<void> {
    await this.request<unknown>('PATCH', `/zones/${encodeURIComponent(zoneId)}/settings/${encodeURIComponent(setting)}`, {
      value,
    });
  }

  /** DELETE /accounts/:id/cfd_tunnel/:tid?cascade=true — removes the tunnel (and its connections). */
  async deleteTunnel(accountId: string, tunnelId: string): Promise<void> {
    await this.request<unknown>(
      'DELETE',
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}?cascade=true`,
    );
  }
}
