import type {
  Connector,
  ConnectorContext,
  ConnectorDetailGroup,
  ConnectorDetailItem,
  ConnectorManifest,
  ConnectorNode,
  ConnectorOverview,
  ConnectorResource,
  ConnectorResourceDetail,
  ConnectorResourceKind,
  OverviewMetric,
  TestConnectionResult,
} from '@cerebro/shared';
import { UniApi, type UniAuth, type UniClient, type UniDevice, type UniSite } from './unifi-api';

const DEVICE_KIND = 'device';
const CLIENT_KIND = 'client';

/** Device states that mean "not fully online" (drive the overview + alerts). */
const OFFLINE_STATES = new Set(['offline', 'disconnected', 'unknown', 'pending_adoption', 'adopting']);

/** Phase 1 is read-only. Device restart + alerts come in later phases. */
const KINDS: ConnectorResourceKind[] = [
  { id: DEVICE_KIND, label: 'Devices', deletable: false, actions: [] },
  { id: CLIENT_KIND, label: 'Clients', deletable: false, actions: [] },
];

/** How long a resolved site id is cached (sites are stable). */
const SITE_TTL_MS = 3_600_000;

function fmtUptime(sec?: number): string | null {
  if (!sec || sec <= 0) return null;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function normState(state?: string): string {
  return (state ?? 'unknown').toLowerCase();
}

export class UnifiConnector implements Connector {
  /** Per-instance cache of the resolved site id. */
  private readonly siteCache = new Map<string, { at: number; siteId: string }>();

  manifest: ConnectorManifest = {
    id: 'unifi',
    name: 'UniFi',
    description:
      'Monitor a UniFi network: gateway, switches, and access points with their status, uptime, and firmware, ' +
      'plus connected clients. Read-only in this phase — device restart and alerts come next.',
    icon: 'unifi',
    version: '0.1.0',
    configFields: [
      {
        key: 'host',
        label: 'Controller host',
        type: 'text',
        required: true,
        placeholder: '192.168.1.1',
        help: 'The UniFi OS gateway host or IP (HTTPS). Add :port only if it is not 443.',
      },
      {
        key: 'apiKey',
        label: 'API key',
        type: 'password',
        secret: true,
        required: true,
        help: 'UniFi OS → Settings → Control Plane → Integrations → API Keys. Stored encrypted in the secrets vault.',
      },
      {
        key: 'siteId',
        label: 'Site (optional)',
        type: 'text',
        required: false,
        placeholder: 'auto-detected for single-site controllers',
        help: 'Only needed if the key can see more than one site.',
      },
      {
        key: 'verifyTls',
        label: 'Verify TLS certificate',
        type: 'boolean',
        required: false,
        help: 'Off by default — local gateways use a self-signed certificate. Enable only if you have installed the CA.',
      },
    ],
    resourceKinds: KINDS,
    help: {
      overview:
        'Monitor a UniFi network via the UniFi OS Integration API (API key): every device (gateway, switches, APs) ' +
        'with status/uptime/firmware, connected clients, and a health overview flagging offline devices and available firmware updates.',
      setupSteps: [
        'In UniFi OS, open Settings → Control Plane → Integrations → API Keys and create a key.',
        'Enter the gateway host/IP and paste the API key here.',
        'Leave "Verify TLS" off unless you have installed the controller\'s CA (local gateways use a self-signed cert).',
      ],
      requiredPermissions: [
        'A UniFi OS API key with access to the site(s) you want to monitor.',
        'Read access is enough for this phase; device restart (a later phase) needs a key allowed to manage devices.',
      ],
      referenceLinks: [
        { label: 'UniFi Network API', url: 'https://developer.ui.com/unifi-api/' },
      ],
      notes:
        'Uses the supported Integration API (X-API-KEY), not the legacy login+CSRF controller API. Needs a recent ' +
        'UniFi Network / UniFi OS. Full WAN throughput and per-client traffic are richer stats calls planned for a later phase.',
    },
  };

  private apiFrom(ctx: ConnectorContext): UniApi {
    const auth: UniAuth = {
      host: String(ctx.config.host ?? ''),
      apiKey: String(ctx.config.apiKey ?? ''),
      verifyTls: bool(ctx.config.verifyTls),
    };
    return new UniApi(auth);
  }

  private cacheKey(ctx: ConnectorContext): string {
    return ctx.instanceId ?? String(ctx.config.host ?? '');
  }

  invalidateCache(ctx: ConnectorContext): void {
    this.siteCache.delete(this.cacheKey(ctx));
  }

  /** The site id to query — configured, else the sole site, else a clear error. */
  private async resolveSiteId(ctx: ConnectorContext, api: UniApi): Promise<string> {
    const configured = str(ctx.config.siteId);
    if (configured) return configured;

    const key = this.cacheKey(ctx);
    const cached = this.siteCache.get(key);
    if (cached && Date.now() - cached.at < SITE_TTL_MS) return cached.siteId;

    const sites = await api.listSites();
    if (sites.length === 0) throw new Error('The API key can\'t see any UniFi sites — check its permissions.');
    if (sites.length > 1) {
      throw new Error(`The API key spans ${sites.length} sites — set the Site field to choose one (e.g. ${sites[0].id}).`);
    }
    const siteId = sites[0].id;
    this.siteCache.set(key, { at: Date.now(), siteId });
    return siteId;
  }

  async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    const api = this.apiFrom(ctx);
    try {
      const info = await api.info();
      const site = await this.resolveSiteId(ctx, api);
      ctx.log('info', `UniFi controller reachable (Network ${info.applicationVersion ?? '?'}), site ${site}.`);
      return {
        ok: true,
        message: `Connected to UniFi Network ${info.applicationVersion ?? '?'}.`,
        details: { version: info.applicationVersion ?? '?', site },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed.';
      ctx.log('warn', `UniFi connection test failed: ${message}`);
      return { ok: false, message };
    }
  }

  async listResources(ctx: ConnectorContext, kind: string): Promise<ConnectorResource[]> {
    const api = this.apiFrom(ctx);
    const site = await this.resolveSiteId(ctx, api);

    if (kind === DEVICE_KIND) {
      const devices = await api.listDevices(site);
      return devices
        .map((d) => this.deviceToResource(d))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    if (kind === CLIENT_KIND) {
      const clients = await api.listClients(site);
      return clients
        .map((c) => this.clientToResource(c))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    return [];
  }

  private deviceToResource(d: UniDevice): ConnectorResource {
    const state = normState(d.state);
    return {
      id: d.id,
      kind: DEVICE_KIND,
      name: d.name || d.model || d.macAddress || d.id,
      status: OFFLINE_STATES.has(state) ? 'offline' : state,
      details: {
        model: d.model ?? null,
        ip: d.ipAddress ?? null,
        mac: d.macAddress ?? null,
        firmware: d.firmwareVersion ?? null,
        update_available: !!d.firmwareUpdatable,
        uptime: fmtUptime(d.uptimeSec),
      },
      tags: {
        state: OFFLINE_STATES.has(state) ? 'offline' : state,
        ...(d.model ? { model: d.model } : {}),
        ...(d.firmwareUpdatable ? { update: 'available' } : {}),
      },
    };
  }

  private clientToResource(c: UniClient): ConnectorResource {
    const type = (c.type ?? c.access?.type ?? '').toLowerCase();
    const wired = type.includes('wired');
    return {
      id: c.id,
      kind: CLIENT_KIND,
      name: c.name || c.hostname || c.macAddress || c.id,
      status: wired ? 'wired' : type ? 'wireless' : 'connected',
      details: {
        ip: c.ipAddress ?? null,
        mac: c.macAddress ?? null,
        type: type || null,
        connected_since: c.connectedAt ?? null,
      },
      tags: type ? { type: wired ? 'wired' : 'wireless' } : undefined,
    };
  }

  async describeResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<ConnectorResourceDetail> {
    const api = this.apiFrom(ctx);
    const site = await this.resolveSiteId(ctx, api);

    if (kind === DEVICE_KIND) {
      let d: UniDevice;
      try {
        d = await api.getDevice(site, resourceId);
      } catch {
        const all = await api.listDevices(site);
        const found = all.find((x) => x.id === resourceId);
        if (!found) throw new Error(`Device ${resourceId} not found.`);
        d = found;
      }
      const state = normState(d.state);
      const items: ConnectorDetailItem[] = [
        { label: 'Name', value: d.name || '—' },
        { label: 'Model', value: d.model || '—' },
        { label: 'Status', value: OFFLINE_STATES.has(state) ? 'offline' : state, variant: 'status' },
        { label: 'IP address', value: d.ipAddress || '—', variant: 'mono' },
        { label: 'MAC', value: d.macAddress || '—', variant: 'mono' },
        { label: 'Firmware', value: d.firmwareVersion || '—' },
        { label: 'Update available', value: d.firmwareUpdatable ? 'Yes' : 'No', variant: 'status' },
        { label: 'Uptime', value: fmtUptime(d.uptimeSec) ?? '—' },
      ];
      return { id: d.id, kind, name: d.name || d.id, status: OFFLINE_STATES.has(state) ? 'offline' : state, groups: [{ title: 'General', items }] };
    }

    // Clients: light detail from the list entry.
    const list = await this.listResources(ctx, kind);
    const r = list.find((x) => x.id === resourceId);
    if (!r) throw new Error(`${kind} ${resourceId} not found.`);
    const items: ConnectorDetailItem[] = Object.entries(r.details ?? {}).map(([k, v]) => ({
      label: k.replace(/_/g, ' ').replace(/^\w/, (ch) => ch.toUpperCase()),
      value: v == null ? '—' : String(v),
    }));
    return { id: r.id, kind, name: r.name, status: r.status, groups: [{ title: 'General', items }] };
  }

  async listNodes(ctx: ConnectorContext): Promise<ConnectorNode[]> {
    const api = this.apiFrom(ctx);
    try {
      const sites = await api.listSites();
      return sites.map((s: UniSite) => ({ name: s.name || s.internalReference || s.id, status: 'running', cpuPct: 0 }));
    } catch (err) {
      ctx.log('debug', `UniFi listNodes failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  // Phase 1 is read-only — device restart arrives in Phase 2.
  async performAction(): Promise<{ ok: boolean; message: string }> {
    return { ok: false, message: 'This UniFi connector is read-only in this phase.' };
  }

  async overview(ctx: ConnectorContext): Promise<ConnectorOverview> {
    const api = this.apiFrom(ctx);
    const site = await this.resolveSiteId(ctx, api);
    const [devices, clients] = await Promise.all([
      api.listDevices(site),
      api.listClients(site).catch(() => [] as UniClient[]),
    ]);

    const offline = devices.filter((d) => OFFLINE_STATES.has(normState(d.state))).length;
    const updates = devices.filter((d) => d.firmwareUpdatable).length;
    const wireless = clients.filter((c) => !(c.type ?? c.access?.type ?? '').toLowerCase().includes('wired')).length;

    const metrics: OverviewMetric[] = [
      { key: 'devicesTotal', label: 'Devices', value: devices.length },
      { key: 'devicesOffline', label: 'Offline', value: offline },
      { key: 'firmwareUpdates', label: 'Updates', value: updates },
      { key: 'clientsTotal', label: 'Clients', value: clients.length },
      { key: 'clientsWireless', label: 'Wireless', value: wireless },
    ];

    const guests = devices
      .slice()
      .sort((a, b) => (OFFLINE_STATES.has(normState(b.state)) ? 1 : 0) - (OFFLINE_STATES.has(normState(a.state)) ? 1 : 0))
      .slice(0, 40)
      .map((d) => ({
        name: d.name || d.model || d.id,
        kind: DEVICE_KIND,
        status: OFFLINE_STATES.has(normState(d.state)) ? 'offline' : normState(d.state),
        node: '',
      }));

    return { metrics, guests };
  }
}

function str(v: unknown): string | undefined {
  const s = v == null ? '' : String(v).trim();
  return s ? s : undefined;
}

function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
}
