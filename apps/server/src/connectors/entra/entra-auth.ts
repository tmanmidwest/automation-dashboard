/**
 * Shared Microsoft Entra ID (Azure AD) auth foundation for the Azure and O365
 * connectors (docs/azure-o365-connectors.md).
 *
 * Both connectors authenticate the same way: an app registration + OAuth2
 * **client-credentials** grant against login.microsoftonline.com, which returns a
 * short-lived bearer token. Azure then calls Azure Resource Manager (ARM); O365
 * calls Microsoft Graph. This module owns that token exchange once — including the
 * sovereign-cloud endpoints and a process-wide token cache — so neither connector
 * re-implements it and `testConnection` (which runs every minute) stays cheap.
 *
 * The token endpoint is free and not rate-limited the way the data APIs are, and
 * tokens are cached until shortly before expiry, so a per-minute reachability probe
 * costs at most one cached lookup.
 */

export type EntraCloud = 'public' | 'usgov' | 'china';

/** Per-cloud endpoints. `authority` mints tokens; `arm`/`graph` are the token audiences (scope = `<resource>/.default`). */
export const ENTRA_CLOUDS: Record<EntraCloud, { label: string; authority: string; arm: string; graph: string }> = {
  public: {
    label: 'Azure public',
    authority: 'https://login.microsoftonline.com',
    arm: 'https://management.azure.com',
    graph: 'https://graph.microsoft.com',
  },
  usgov: {
    label: 'Azure US Gov',
    authority: 'https://login.microsoftonline.us',
    arm: 'https://management.usgovcloudapi.net',
    graph: 'https://graph.microsoft.us',
  },
  china: {
    label: 'Azure China (21Vianet)',
    authority: 'https://login.chinacloudapi.cn',
    arm: 'https://management.chinacloudapi.cn',
    graph: 'https://microsoftgraph.chinacloudapi.cn',
  },
};

export interface EntraCreds {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  cloud?: EntraCloud;
}

/** A friendly, user-facing error — mirrors the CfApiError/AWS mapping style. */
export class EntraError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

interface CachedToken {
  token: string;
  /** epoch ms at which we treat the token as expired (real expiry minus a safety skew). */
  expMs: number;
}

/** Refresh this many ms before the real expiry so a token never lapses mid-request. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/**
 * Process-wide token cache, keyed by tenant + client + audience + cloud. Deliberately
 * NOT keyed on the secret: if a secret is rotated, the previously-issued token stays
 * valid until it expires (~1h), after which the next fetch uses the new secret.
 */
const tokenCache = new Map<string, CachedToken>();

function cloudOf(creds: EntraCreds): EntraCloud {
  return creds.cloud && ENTRA_CLOUDS[creds.cloud] ? creds.cloud : 'public';
}

function endpointsOf(creds: EntraCreds) {
  return ENTRA_CLOUDS[cloudOf(creds)];
}

/** The ARM base URL (e.g. https://management.azure.com) for this instance's cloud. */
export function armBase(creds: EntraCreds): string {
  return endpointsOf(creds).arm;
}

/** The Microsoft Graph base URL (e.g. https://graph.microsoft.com) for this instance's cloud. */
export function graphBase(creds: EntraCreds): string {
  return endpointsOf(creds).graph;
}

function assertCreds(creds: EntraCreds): void {
  if (!creds.tenantId?.trim()) throw new EntraError('Missing the Directory (tenant) ID.');
  if (!creds.clientId?.trim()) throw new EntraError('Missing the Application (client) ID.');
  if (!creds.clientSecret?.trim()) throw new EntraError('Missing the client secret.');
}

/**
 * Get a bearer token for `audience` (an ARM or Graph base URL), from cache when it's
 * still fresh, otherwise via the client-credentials grant. Throws a friendly
 * EntraError on auth / network failure.
 */
export async function getEntraToken(creds: EntraCreds, audience: string): Promise<string> {
  assertCreds(creds);
  const cloud = cloudOf(creds);
  const scope = `${audience.replace(/\/+$/, '')}/.default`;
  const key = `${cloud}|${creds.tenantId}|${creds.clientId}|${scope}`;

  const cached = tokenCache.get(key);
  if (cached && cached.expMs > Date.now()) return cached.token;

  const authority = ENTRA_CLOUDS[cloud].authority;
  const url = `${authority}/${encodeURIComponent(creds.tenantId.trim())}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.clientId.trim(),
    client_secret: creds.clientSecret,
    scope,
  });

  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new EntraError('Timed out reaching login.microsoftonline.com.');
    throw new EntraError(`Could not reach the Microsoft token endpoint — check network/DNS from the Cerebro host. (${(e as Error).message})`);
  }

  const text = await res.text();
  let json: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* fall through to the HTTP-status error below */
  }

  if (!res.ok || !json.access_token) {
    // error_description carries the AADSTS code + a precise reason; surface it verbatim (first line).
    const detail = (json.error_description || json.error || `HTTP ${res.status}`).split('\n')[0].trim();
    if (res.status === 400 || res.status === 401) {
      throw new EntraError(`Microsoft rejected the credentials — check the tenant ID, client ID and secret, and that the secret hasn't expired. (${detail})`, res.status);
    }
    throw new EntraError(`Could not get a token from Microsoft: ${detail}`, res.status);
  }

  const lifetimeMs = (json.expires_in ?? 3600) * 1000;
  tokenCache.set(key, { token: json.access_token, expMs: Date.now() + Math.max(lifetimeMs - EXPIRY_SKEW_MS, 30_000) });
  return json.access_token;
}

/** Drop any cached tokens for an instance's creds — e.g. after its config changes. */
export function clearEntraTokens(creds: Pick<EntraCreds, 'tenantId' | 'clientId'>): void {
  for (const key of [...tokenCache.keys()]) {
    if (key.includes(`|${creds.tenantId}|${creds.clientId}|`)) tokenCache.delete(key);
  }
}
