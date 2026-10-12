/**
 * Minimal Microsoft Graph client for the O365 connector (docs/azure-o365-connectors.md).
 * Read-only in P1. Bearer auth via the shared Entra token helper (application
 * permissions + tenant admin consent); dependency-free using global fetch (Node 22).
 *
 * Graph list endpoints return `{ value: T[], "@odata.nextLink"? }`; `getPaged`
 * follows the nextLink. All paths are under the v1.0 endpoint.
 */
import { EntraCreds, EntraError, getEntraToken, graphBase } from '../entra/entra-auth';

export interface GraphServiceHealth {
  service: string;
  status: string; // serviceOperational | serviceDegradation | serviceInterruption | ...
}

export interface GraphServiceIssue {
  id: string;
  title: string;
  service: string;
  status: string; // investigating | serviceRestored | ...
  classification?: string; // advisory | incident
  feature?: string;
  startDateTime?: string;
  lastModifiedDateTime?: string;
}

export interface GraphMessage {
  id: string;
  title: string;
  services?: string[];
  category?: string; // planForChange | preventOrFixIssue | stayInformed
  severity?: string;
  startDateTime?: string;
  lastModifiedDateTime?: string;
}

export interface GraphUser {
  id: string;
  displayName?: string;
  userPrincipalName?: string;
  accountEnabled?: boolean;
  assignedLicenseCount: number;
}

export interface GraphSku {
  skuId: string;
  skuPartNumber: string;
  consumedUnits: number;
  enabledUnits: number;
}

export interface GraphSecureScore {
  currentScore: number;
  maxScore: number;
  percentage: number;
  createdDateTime?: string;
}

interface GraphList<T> {
  value?: T[];
  '@odata.nextLink'?: string;
}

export class GraphApi {
  constructor(private readonly creds: EntraCreds) {}

  private async authHeader(): Promise<string> {
    return `Bearer ${await getEntraToken(this.creds, graphBase(this.creds))}`;
  }

  /** GET returning { status, json }. Does not throw on 4xx/5xx — callers decide. */
  private async raw(url: string): Promise<{ status: number; json: unknown; text: string }> {
    const full = url.startsWith('http') ? url : `${graphBase(this.creds)}${url}`;
    let res: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      try {
        res = await fetch(full, { headers: { Authorization: await this.authHeader(), Accept: 'application/json' }, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      if (e instanceof EntraError) throw e;
      if (e instanceof Error && e.name === 'AbortError') throw new EntraError('Microsoft Graph request timed out.');
      throw new EntraError(`Could not reach Microsoft Graph — check network/DNS from the Cerebro host. (${(e as Error).message})`);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  }

  /** GET expecting success; maps Graph errors to a friendly EntraError (consent/permission aware). */
  private async get<T>(url: string): Promise<T> {
    const { status, json, text } = await this.raw(url);
    if (status < 200 || status >= 300) {
      const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
      const detail = err?.message ? `${err.code ?? ''} ${err.message}`.trim() : `HTTP ${status}: ${text.slice(0, 160)}`;
      if (status === 401) throw new EntraError(`Microsoft rejected the token — check the app registration and that the secret is valid. (${detail})`, 401);
      if (status === 403) throw new EntraError(`Graph denied the request — the app needs the matching application permission AND tenant admin consent. (${detail})`, 403);
      throw new EntraError(`Microsoft Graph error: ${detail}`, status);
    }
    if (json === undefined) throw new EntraError('Could not parse the Microsoft Graph response as JSON.', status);
    return json as T;
  }

  private async getPaged<T>(url: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = url;
    for (let guard = 0; guard < 50 && next; guard++) {
      const page: GraphList<T> = await this.get<GraphList<T>>(next);
      if (Array.isArray(page.value)) out.push(...page.value);
      next = page['@odata.nextLink'];
    }
    return out;
  }

  /** Cheap reachability probe for testConnection: returns the org/tenant name if readable. */
  async probeOrg(): Promise<{ status: number; name?: string }> {
    const { status, json } = await this.raw('/v1.0/organization?$select=displayName');
    const name = (json as GraphList<{ displayName?: string }> | undefined)?.value?.[0]?.displayName;
    return { status, name };
  }

  async listServiceHealth(): Promise<GraphServiceHealth[]> {
    return this.getPaged<GraphServiceHealth>('/v1.0/admin/serviceAnnouncement/healthOverviews');
  }

  async listServiceIssues(): Promise<GraphServiceIssue[]> {
    // Only issues that are not yet resolved are interesting for monitoring.
    return this.getPaged<GraphServiceIssue>('/v1.0/admin/serviceAnnouncement/issues');
  }

  async listMessages(): Promise<GraphMessage[]> {
    return this.getPaged<GraphMessage>("/v1.0/admin/serviceAnnouncement/messages?$orderby=lastModifiedDateTime desc&$top=50");
  }

  async listUsers(): Promise<GraphUser[]> {
    type Raw = { id: string; displayName?: string; userPrincipalName?: string; accountEnabled?: boolean; assignedLicenses?: { skuId?: string }[] };
    const rows = await this.getPaged<Raw>('/v1.0/users?$select=id,displayName,userPrincipalName,accountEnabled,assignedLicenses&$top=999');
    return rows.map((u) => ({
      id: u.id,
      displayName: u.displayName,
      userPrincipalName: u.userPrincipalName,
      accountEnabled: u.accountEnabled,
      assignedLicenseCount: (u.assignedLicenses ?? []).length,
    }));
  }

  async listSkus(): Promise<GraphSku[]> {
    type Raw = { skuId: string; skuPartNumber: string; consumedUnits?: number; prepaidUnits?: { enabled?: number } };
    const rows = await this.getPaged<Raw>('/v1.0/subscribedSkus');
    return rows.map((s) => ({
      skuId: s.skuId,
      skuPartNumber: s.skuPartNumber,
      consumedUnits: s.consumedUnits ?? 0,
      enabledUnits: s.prepaidUnits?.enabled ?? 0,
    }));
  }

  async getSecureScore(): Promise<GraphSecureScore | null> {
    type Raw = { currentScore?: number; maxScore?: number; createdDateTime?: string };
    const page = await this.get<GraphList<Raw>>('/v1.0/security/secureScores?$top=1');
    const s = page.value?.[0];
    if (!s) return null;
    const current = s.currentScore ?? 0;
    const max = s.maxScore ?? 0;
    return { currentScore: current, maxScore: max, percentage: max > 0 ? Math.round((current / max) * 100) : 0, createdDateTime: s.createdDateTime };
  }
}
