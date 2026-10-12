/**
 * Minimal Azure Resource Manager (ARM) REST client for the Azure connector
 * (docs/azure-o365-connectors.md). Read-only in P1. Bearer auth via the shared
 * Entra token helper; dependency-free using the global fetch (Node 22).
 *
 * ARM returns `{ value: T[], nextLink? }` for list endpoints; `getPaged` follows
 * nextLink. Every resource type needs an explicit `api-version`.
 */
import { EntraCreds, EntraError, armBase, getEntraToken } from '../entra/entra-auth';

/** API versions pinned per resource type (bump deliberately). */
const API = {
  subscriptions: '2022-12-01',
  resourceGroups: '2021-04-01',
  vms: '2023-09-01',
  sites: '2023-12-01',
  storage: '2023-05-01',
} as const;

export interface AzSubscription {
  subscriptionId: string;
  displayName: string;
  state: string; // Enabled | Warned | PastDue | Disabled | Deleted
}

export interface AzResourceGroup {
  id: string;
  name: string;
  location: string;
  provisioningState?: string;
}

export interface AzVm {
  id: string;
  name: string;
  location: string;
  resourceGroup: string;
  subscriptionId: string;
  vmSize?: string;
  osType?: string;
  /** Normalized power state, e.g. "running", "deallocated", "stopped". */
  powerState: string;
}

export interface AzSite {
  id: string;
  name: string;
  location: string;
  resourceGroup: string;
  subscriptionId: string;
  kind?: string; // "app", "functionapp", "app,linux", ...
  state?: string; // Running | Stopped
  defaultHostName?: string;
  enabled?: boolean;
}

export interface AzStorageAccount {
  id: string;
  name: string;
  location: string;
  resourceGroup: string;
  subscriptionId: string;
  sku?: string;
  kind?: string;
  provisioningState?: string;
  accessTier?: string;
}

interface ArmList<T> {
  value?: T[];
  nextLink?: string;
}

/** Pull the resource-group name out of an ARM resource id. */
function rgFromId(id: string): string {
  const m = /\/resourceGroups\/([^/]+)/i.exec(id);
  return m ? m[1] : '';
}

/** Pull the subscription id out of an ARM resource id. */
function subFromId(id: string): string {
  const m = /\/subscriptions\/([^/]+)/i.exec(id);
  return m ? m[1] : '';
}

export class AzureApi {
  constructor(
    private readonly creds: EntraCreds,
    /** Optional default subscription; blank → every subscription the app can read. */
    private readonly subscriptionId?: string,
  ) {}

  private async authHeader(): Promise<string> {
    return `Bearer ${await getEntraToken(this.creds, armBase(this.creds))}`;
  }

  /** Low-level GET returning parsed JSON. `url` may be a full ARM URL (nextLink) or a path. */
  private async get<T>(url: string): Promise<T> {
    const full = url.startsWith('http') ? url : `${armBase(this.creds)}${url}`;
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
      if (e instanceof Error && e.name === 'AbortError') throw new EntraError('Azure Resource Manager request timed out.');
      throw new EntraError(`Could not reach Azure Resource Manager — check network/DNS from the Cerebro host. (${(e as Error).message})`);
    }

    const text = await res.text();
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text) as { error?: { code?: string; message?: string } };
        if (j.error?.message) detail = `${j.error.code ?? ''} ${j.error.message}`.trim();
      } catch { /* keep HTTP status */ }
      if (res.status === 401) throw new EntraError(`Azure rejected the token — check the app registration and that the secret is valid. (${detail})`, 401);
      if (res.status === 403) throw new EntraError(`Access denied by Azure RBAC — the app registration needs at least the built-in Reader role on the subscription(s). (${detail})`, 403);
      throw new EntraError(`Azure Resource Manager error: ${detail}`, res.status);
    }
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new EntraError('Could not parse the Azure response as JSON.', res.status);
    }
  }

  /** GET a list endpoint and follow nextLink (bounded). */
  private async getPaged<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | undefined = path;
    for (let guard = 0; guard < 50 && url; guard++) {
      const page: ArmList<T> = await this.get<ArmList<T>>(url);
      if (Array.isArray(page.value)) out.push(...page.value);
      url = page.nextLink;
    }
    return out;
  }

  /** Subscriptions the app registration can see. */
  async listSubscriptions(): Promise<AzSubscription[]> {
    type Raw = { subscriptionId: string; displayName: string; state: string };
    const rows = await this.getPaged<Raw>(`/subscriptions?api-version=${API.subscriptions}`);
    return rows.map((r) => ({ subscriptionId: r.subscriptionId, displayName: r.displayName, state: r.state }));
  }

  /** The subscription ids to operate on: the configured one, else all readable. */
  async targetSubscriptions(): Promise<string[]> {
    const configured = this.subscriptionId?.trim();
    if (configured) return [configured];
    return (await this.listSubscriptions()).filter((s) => s.state === 'Enabled').map((s) => s.subscriptionId);
  }

  async listResourceGroups(sub: string): Promise<AzResourceGroup[]> {
    type Raw = { id: string; name: string; location: string; properties?: { provisioningState?: string } };
    const rows = await this.getPaged<Raw>(`/subscriptions/${encodeURIComponent(sub)}/resourcegroups?api-version=${API.resourceGroups}`);
    return rows.map((r) => ({ id: r.id, name: r.name, location: r.location, provisioningState: r.properties?.provisioningState }));
  }

  async listVirtualMachines(sub: string): Promise<AzVm[]> {
    type Raw = {
      id: string; name: string; location: string;
      properties?: {
        hardwareProfile?: { vmSize?: string };
        storageProfile?: { osDisk?: { osType?: string } };
        instanceView?: { statuses?: { code?: string; displayStatus?: string }[] };
      };
    };
    // $expand=instanceView returns power state inline, avoiding a per-VM call.
    const rows = await this.getPaged<Raw>(
      `/subscriptions/${encodeURIComponent(sub)}/providers/Microsoft.Compute/virtualMachines?api-version=${API.vms}&$expand=instanceView`,
    );
    return rows.map((r) => {
      const power = (r.properties?.instanceView?.statuses ?? []).find((s) => s.code?.startsWith('PowerState/'));
      return {
        id: r.id,
        name: r.name,
        location: r.location,
        resourceGroup: rgFromId(r.id),
        subscriptionId: sub,
        vmSize: r.properties?.hardwareProfile?.vmSize,
        osType: r.properties?.storageProfile?.osDisk?.osType,
        powerState: power?.code?.replace('PowerState/', '') ?? 'unknown',
      };
    });
  }

  async listAppServices(sub: string): Promise<AzSite[]> {
    type Raw = { id: string; name: string; location: string; kind?: string; properties?: { state?: string; defaultHostName?: string; enabled?: boolean } };
    const rows = await this.getPaged<Raw>(`/subscriptions/${encodeURIComponent(sub)}/providers/Microsoft.Web/sites?api-version=${API.sites}`);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      location: r.location,
      resourceGroup: rgFromId(r.id),
      subscriptionId: sub,
      kind: r.kind,
      state: r.properties?.state,
      defaultHostName: r.properties?.defaultHostName,
      enabled: r.properties?.enabled,
    }));
  }

  async listStorageAccounts(sub: string): Promise<AzStorageAccount[]> {
    type Raw = { id: string; name: string; location: string; sku?: { name?: string }; kind?: string; properties?: { provisioningState?: string; accessTier?: string } };
    const rows = await this.getPaged<Raw>(`/subscriptions/${encodeURIComponent(sub)}/providers/Microsoft.Storage/storageAccounts?api-version=${API.storage}`);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      location: r.location,
      resourceGroup: rgFromId(r.id),
      subscriptionId: sub,
      sku: r.sku?.name,
      kind: r.kind,
      provisioningState: r.properties?.provisioningState,
      accessTier: r.properties?.accessTier,
    }));
  }

  /** Aggregate a per-subscription list across the target subscriptions. */
  async forEachSubscription<T>(fn: (sub: string) => Promise<T[]>): Promise<T[]> {
    const subs = await this.targetSubscriptions();
    const out: T[] = [];
    for (const sub of subs) {
      try {
        out.push(...(await fn(sub)));
      } catch {
        /* a subscription the app can't read for this provider shouldn't fail the whole list */
      }
    }
    return out;
  }
}

export { subFromId, rgFromId };
