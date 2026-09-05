import type {
  Connector,
  ConnectorContext,
  ConnectorManifest,
  ConnectorOperation,
  ConnectorOption,
  ConnectorResource,
  ConnectorResourceDetail,
  ConnectorResourceKind,
  ConnectorDetailGroup,
  ConnectorDetailItem,
  ConnectorOverview,
  OverviewMetric,
  OperationProgress,
  OperationResult,
  TestConnectionResult,
} from '@cerebro/shared';
import {
  CfApi, CfAuth, CfZone, CfDnsRecord, CfTunnel, CfCertPack,
  CfAccessApp, CfServiceToken, CfDevice, CfRule,
  CfWorker, CfPagesProject, CfR2Bucket, CfLoadBalancer,
} from './cf-api';

const TUNNEL_KIND = 'tunnel';
const ZONE_KIND = 'zone';
const DNS_KIND = 'dns_record';
const CERT_KIND = 'certificate';
const ACCESS_APP_KIND = 'access_app';
const SERVICE_TOKEN_KIND = 'service_token';
const WARP_DEVICE_KIND = 'warp_device';
const FW_KIND = 'firewall_rule';
const WORKER_KIND = 'worker';
const PAGES_KIND = 'pages_project';
const R2_KIND = 'r2_bucket';
const LB_KIND = 'load_balancer';

/** The WAF phase that holds a zone's custom firewall rules. */
const FW_CUSTOM_PHASE = 'http_request_firewall_custom';

/** Tunnel statuses that mean it isn't fully serving traffic (drive the overview + future alerts). */
const TUNNEL_DOWN_STATES = new Set(['down', 'degraded', 'inactive']);

/** A certificate within this many days of expiry (or already expired) counts as "expiring soon". */
const CERT_EXPIRY_WINDOW_DAYS = 30;
/** Certificate packs are fetched at most this often for the overview (per-zone fan-out is heavy). */
const CERT_TTL_MS = 3_600_000;

/** A service token within this many days of expiry (or already expired) counts as "expiring soon". */
const TOKEN_EXPIRY_WINDOW_DAYS = 14;
/** Zero Trust data (apps/tokens/devices) is fetched at most this often for the overview. */
const ZT_TTL_MS = 300_000;

/** GraphQL analytics are plan-gated + heavier; fetched at most this often for the overview. */
const ANALYTICS_TTL_MS = 3_600_000;

/** DNS record types Cloudflare can proxy (orange cloud). Others are DNS-only. */
const PROXYABLE_TYPES = new Set(['A', 'AAAA', 'CNAME']);

/** DNS record types offered in the create form. */
const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'];

/** Security levels Cloudflare accepts (security_level setting) — "under_attack" is the panic button. */
const SECURITY_LEVELS = [
  { label: 'Essentially off', value: 'essentially_off' },
  { label: 'Low', value: 'low' },
  { label: 'Medium (default)', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'I\'m Under Attack!', value: 'under_attack' },
];

/**
 * Phase 2 resource kinds. Tunnels and zones stay list-first; DNS records gain
 * create/edit/proxy-toggle/delete. Zones gain cache purge + dev-mode + security-level.
 */
const KINDS: ConnectorResourceKind[] = [
  {
    id: TUNNEL_KIND,
    label: 'Tunnels',
    // Delete is offered as a typed-name delete in the detail drawer (cascades connections).
    deletable: true,
    actions: [],
  },
  {
    id: ZONE_KIND,
    label: 'Zones',
    deletable: false,
    actions: [{ id: 'purge_cache', label: 'Purge cache', mutating: true, confirm: 'Purge everything from Cloudflare\'s cache for this zone?', intent: 'destructive' }],
  },
  {
    id: DNS_KIND,
    label: 'DNS Records',
    deletable: true,
    actions: [
      { id: 'proxy_on', label: 'Proxy on', mutating: true, showWhenStatus: ['dns_only'] },
      { id: 'proxy_off', label: 'Proxy off', mutating: true, showWhenStatus: ['proxied'] },
    ],
  },
  { id: CERT_KIND, label: 'Certificates', deletable: false, actions: [] },
  { id: ACCESS_APP_KIND, label: 'Access Apps', deletable: false, actions: [] },
  { id: SERVICE_TOKEN_KIND, label: 'Service Tokens', deletable: false, actions: [] },
  { id: WARP_DEVICE_KIND, label: 'WARP Devices', deletable: false, actions: [] },
  {
    id: FW_KIND,
    label: 'Firewall Rules',
    deletable: false,
    actions: [
      { id: 'enable', label: 'Enable', mutating: true, showWhenStatus: ['disabled'] },
      { id: 'disable', label: 'Disable', mutating: true, showWhenStatus: ['enabled'] },
    ],
  },
  { id: WORKER_KIND, label: 'Workers', deletable: false, actions: [] },
  { id: PAGES_KIND, label: 'Pages', deletable: false, actions: [] },
  { id: R2_KIND, label: 'R2 Buckets', deletable: false, actions: [] },
  { id: LB_KIND, label: 'Load Balancers', deletable: false, actions: [] },
];

const OPERATIONS: ConnectorOperation[] = [
  {
    id: 'create-dns-record',
    label: 'Add DNS record',
    description: 'Create a new DNS record in one of your zones.',
    scope: 'create',
    kind: DNS_KIND,
    icon: 'plus',
    submitLabel: 'Create record',
    fields: [
      { key: 'zone', label: 'Zone', type: 'select', required: true, optionsSource: 'cf-zones' },
      { key: 'type', label: 'Type', type: 'select', required: true, default: 'A', options: DNS_TYPES.map((t) => ({ label: t, value: t })) },
      { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'sub  (or @ for the root)', help: 'The record name; "@" or the bare domain for the zone root.' },
      { key: 'content', label: 'Content', type: 'text', required: true, placeholder: '203.0.113.10', help: 'IP for A/AAAA, target host for CNAME, value for TXT, etc.' },
      { key: 'ttl', label: 'TTL (seconds)', type: 'number', default: 1, help: '1 = automatic. Proxied records are always automatic.' },
      { key: 'proxied', label: 'Proxy through Cloudflare (orange cloud)', type: 'boolean', default: false, help: 'Only valid for A, AAAA, and CNAME records.' },
    ],
  },
  {
    id: 'edit-dns-record',
    label: 'Edit record',
    description: 'Change this DNS record\'s content, TTL, or proxy status.',
    scope: 'resource',
    kind: DNS_KIND,
    icon: 'pencil',
    submitLabel: 'Save',
    prefill: true,
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'content', label: 'Content', type: 'text', required: true },
      { key: 'ttl', label: 'TTL (seconds)', type: 'number', help: '1 = automatic.' },
      { key: 'proxied', label: 'Proxy through Cloudflare (orange cloud)', type: 'boolean' },
    ],
  },
  {
    id: 'zone-security-level',
    label: 'Set security level',
    description: 'Change the zone security level — set "I\'m Under Attack!" to challenge all visitors during an attack.',
    scope: 'resource',
    kind: ZONE_KIND,
    icon: 'shield',
    submitLabel: 'Apply',
    prefill: true,
    fields: [{ key: 'value', label: 'Security level', type: 'select', required: true, options: SECURITY_LEVELS }],
  },
  {
    id: 'zone-dev-mode',
    label: 'Development mode',
    description: 'Temporarily bypass Cloudflare\'s cache (development mode auto-expires after 3 hours).',
    scope: 'resource',
    kind: ZONE_KIND,
    icon: 'wrench',
    submitLabel: 'Apply',
    prefill: true,
    fields: [
      {
        key: 'value',
        label: 'Development mode',
        type: 'select',
        required: true,
        options: [
          { label: 'On (bypass cache)', value: 'on' },
          { label: 'Off', value: 'off' },
        ],
      },
    ],
  },
  {
    id: 'zone-purge-urls',
    label: 'Purge URLs',
    description: 'Purge specific URLs from Cloudflare\'s cache (one per line).',
    scope: 'resource',
    kind: ZONE_KIND,
    icon: 'trash-2',
    submitLabel: 'Purge',
    fields: [
      { key: 'urls', label: 'URLs', type: 'textarea', required: true, placeholder: 'https://example.com/style.css\nhttps://example.com/app.js', help: 'One full URL per line.' },
    ],
  },
  {
    id: 'pages-retry-deploy',
    label: 'Retry latest deployment',
    description: 'Re-run this Pages project\'s most recent deployment.',
    scope: 'resource',
    kind: PAGES_KIND,
    icon: 'refresh-cw',
    submitLabel: 'Retry deployment',
    fields: [],
  },
];

function strOrUndef(v: unknown): string | undefined {
  const s = v == null ? '' : String(v).trim();
  return s ? s : undefined;
}

function numOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
}

/** Split a composite DNS resource id ("zoneId:recordId") into its parts. */
function splitDnsId(id: string): { zoneId: string; recordId: string } | null {
  const i = id.indexOf(':');
  if (i <= 0) return null;
  return { zoneId: id.slice(0, i), recordId: id.slice(i + 1) };
}

/** Split a composite firewall-rule id ("zoneId:rulesetId:ruleId"). CF ids are hex, so ':' is safe. */
function splitFwId(id: string): { zoneId: string; rulesetId: string; ruleId: string } | null {
  const parts = id.split(':');
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  return { zoneId: parts[0], rulesetId: parts[1], ruleId: parts[2] };
}

/** The earliest expiry (ISO) across a cert pack's certificates, or null. */
function earliestExpiry(pack: CfCertPack): string | null {
  const times = (pack.certificates ?? [])
    .map((c) => (c.expires_on ? Date.parse(c.expires_on) : NaN))
    .filter((t) => Number.isFinite(t));
  if (times.length === 0) return null;
  return new Date(Math.min(...times)).toISOString();
}

/** Whole days from now until the given ISO time (negative = already past). Null if unparseable. */
function daysUntil(iso?: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - Date.now()) / 86_400_000);
}

/** Best-effort relative-time label for an ISO timestamp. */
function rel(iso?: string | null): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** How long a resolved account id is cached (accounts don't change). */
const ACCOUNT_TTL_MS = 3_600_000;

export class CloudflareConnector implements Connector {
  /** Per-instance cache of the resolved account id (accounts are stable). */
  private readonly accountCache = new Map<string, { at: number; accountId: string }>();
  /** Per-instance cache of certificate packs (per-zone fan-out is heavy; the overview polls often). */
  private readonly certCache = new Map<string, { at: number; packs: { zoneId: string; zoneName: string; pack: CfCertPack }[] }>();
  /** Per-instance cache of Zero Trust data (apps/tokens/devices) so the overview poll stays cheap. */
  private readonly ztCache = new Map<string, { at: number; apps: CfAccessApp[]; tokens: CfServiceToken[]; devices: CfDevice[] }>();
  /** Per-instance cache of GraphQL analytics totals (plan-gated + heavier). null = tried and unavailable. */
  private readonly analyticsCache = new Map<string, { at: number; data: { requests: number; bytes: number; threats: number } | null }>();

  manifest: ConnectorManifest = {
    id: 'cloudflare',
    name: 'Cloudflare',
    description:
      'Monitor and manage Cloudflare — Tunnels, DNS, SSL certificates, Zero Trust, WAF, analytics, plus Workers, Pages, R2, and load balancers. Edit DNS, purge cache, toggle security/dev mode and firewall rules, retry Pages deploys, and get alerted on tunnels down, paused zones, expiring certs/tokens, and threats.',
    version: '0.6.0',
    icon: 'cloudflare',
    configFields: [
      {
        key: 'apiToken',
        label: 'API token',
        type: 'password',
        secret: true,
        required: true,
        help: 'A scoped API token (My Profile → API Tokens → Create Token). Not the legacy Global API Key.',
      },
      {
        key: 'accountId',
        label: 'Account ID (optional)',
        type: 'text',
        required: false,
        placeholder: 'auto-detected for single-account tokens',
        help: 'Only needed if the token can see more than one account. Find it on any zone\'s Overview page (right sidebar).',
      },
    ],
    resourceKinds: KINDS,
    operations: OPERATIONS,
    help: {
      overview:
        'Monitor and manage Cloudflare: Cloudflare Tunnels and their health, DNS zones (active/paused/plan, security & development mode), and DNS records (add, edit, proxy toggle, delete). The dashboard summary flags tunnels that are down and zones that are paused.',
      setupSteps: [
        'In the Cloudflare dashboard, open My Profile → API Tokens → Create Token.',
        'For read-only: Account → Cloudflare Tunnel → Read, Zone → Zone → Read, Zone → DNS → Read.',
        'For the editing features, also add: Zone → DNS → Edit, Zone → Cache Purge → Purge, and Zone → Zone Settings → Edit (and Account → Cloudflare Tunnel → Edit to delete tunnels).',
        'Set the token to include all accounts/zones you want to manage, then create and copy it. Paste it here.',
      ],
      requiredPermissions: [
        'Account → Cloudflare Tunnel → Read (Edit to delete tunnels)',
        'Zone → Zone → Read, Zone → Zone Settings → Edit (security/development mode)',
        'Zone → DNS → Read + Edit (view and manage DNS records)',
        'Zone → Cache Purge → Purge (purge cache)',
        'Zone → SSL and Certificates → Read (certificate expiry)',
        'Account → Access: Apps and Policies → Read (Zero Trust apps)',
        'Account → Access: Service Tokens → Read (service tokens)',
        'Account → Zero Trust → Read (WARP devices)',
        'Zone → Zone WAF → Read + Edit (view and toggle firewall rules)',
        'Account → Account Analytics → Read, Zone → Analytics → Read (traffic tiles)',
        'Account → Workers Scripts → Read (Workers)',
        'Account → Pages → Read + Edit (Pages projects; Edit to retry deployments)',
        'Account → Workers R2 Storage → Read (R2 buckets)',
        'Zone → Load Balancers → Read (load balancers)',
      ],
      referenceLinks: [
        { label: 'Create an API token', url: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/' },
        { label: 'Cloudflare API v4', url: 'https://developers.cloudflare.com/api/' },
        { label: 'API rate limits', url: 'https://developers.cloudflare.com/fundamentals/api/reference/limits/' },
      ],
      notes:
        'The Cloudflare API is free — there is no per-call charge. Editing features need the matching Edit permissions on the token; without them, those actions fail with a clear message while read-only views keep working. Proxy (orange cloud) applies only to A, AAAA, and CNAME records.',
    },
  };

  private authFrom(ctx: ConnectorContext): CfAuth {
    return {
      apiToken: String(ctx.config.apiToken ?? ''),
      accountId: strOrUndef(ctx.config.accountId),
    };
  }

  private cacheKey(ctx: ConnectorContext): string {
    return ctx.instanceId ?? String(ctx.config.apiToken ?? '');
  }

  invalidateCache(ctx: ConnectorContext): void {
    this.accountCache.delete(this.cacheKey(ctx));
    this.certCache.delete(this.cacheKey(ctx));
    this.ztCache.delete(this.cacheKey(ctx));
    this.analyticsCache.delete(this.cacheKey(ctx));
  }

  /**
   * Aggregate traffic totals (requests, bytes, threats) over the last day across all
   * zones, via one GraphQL query. Plan-gated + heavier, so cached; best-effort — returns
   * null (and caches the null) if the token/plan can't serve analytics.
   */
  private async analyticsTotals(
    ctx: ConnectorContext,
    api: CfApi,
    zones: CfZone[],
    fresh: boolean,
  ): Promise<{ requests: number; bytes: number; threats: number } | null> {
    const key = this.cacheKey(ctx);
    const cached = this.analyticsCache.get(key);
    if (!fresh && cached && Date.now() - cached.at < ANALYTICS_TTL_MS) return cached.data;
    if (zones.length === 0) return null;

    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    const until = new Date();
    const since = new Date(until.getTime() - 24 * 3600 * 1000);
    const query = `query Cerebro($tags:[string!],$since:Date!,$until:Date!){
      viewer{ zones(filter:{zoneTag_in:$tags}){
        httpRequests1dGroups(limit:100, filter:{date_geq:$since, date_leq:$until}){ sum { requests bytes threats } }
      } }
    }`;
    try {
      type Resp = { viewer?: { zones?: { httpRequests1dGroups?: { sum?: { requests?: number; bytes?: number; threats?: number } }[] }[] } };
      const data = await api.graphql<Resp>(query, { tags: zones.map((z) => z.id), since: ymd(since), until: ymd(until) });
      let requests = 0, bytes = 0, threats = 0;
      for (const z of data.viewer?.zones ?? []) {
        for (const g of z.httpRequests1dGroups ?? []) {
          requests += g.sum?.requests ?? 0;
          bytes += g.sum?.bytes ?? 0;
          threats += g.sum?.threats ?? 0;
        }
      }
      const totals = { requests, bytes, threats };
      this.analyticsCache.set(key, { at: Date.now(), data: totals });
      return totals;
    } catch (err) {
      ctx.log('debug', `Cloudflare analytics unavailable: ${err instanceof Error ? err.message : err}`);
      this.analyticsCache.set(key, { at: Date.now(), data: null }); // cache the miss so we don't retry each poll
      return null;
    }
  }

  /**
   * Zero Trust data (Access apps, service tokens, WARP devices) — all account-scoped.
   * Cached so the every-minute overview poll doesn't refetch each tick; a user opening a
   * Zero Trust tab passes `fresh` to refetch. Each list is best-effort so a missing token
   * scope leaves that slice empty rather than failing the others.
   */
  private async ztData(
    ctx: ConnectorContext,
    api: CfApi,
    fresh: boolean,
  ): Promise<{ apps: CfAccessApp[]; tokens: CfServiceToken[]; devices: CfDevice[] }> {
    const key = this.cacheKey(ctx);
    const cached = this.ztCache.get(key);
    if (!fresh && cached && Date.now() - cached.at < ZT_TTL_MS) return cached;

    const accountId = await this.resolveAccountId(ctx, api);
    const safe = async <T>(label: string, fn: () => Promise<T[]>): Promise<T[]> => {
      try {
        return await fn();
      } catch (err) {
        ctx.log('debug', `Cloudflare ${label} unavailable: ${err instanceof Error ? err.message : err}`);
        return [];
      }
    };
    const [apps, tokens, devices] = await Promise.all([
      safe('access apps', () => api.listAccessApps(accountId)),
      safe('service tokens', () => api.listServiceTokens(accountId)),
      safe('devices', () => api.listDevices(accountId)),
    ]);
    const data = { at: Date.now(), apps, tokens, devices };
    this.ztCache.set(key, data);
    return data;
  }

  /**
   * Certificate packs across all zones, flattened. Fans out per zone (heavy), so the
   * result is cached: the every-minute overview reuses the cache, while a user opening
   * the Certificates tab passes `fresh` to refetch. Best-effort per zone — an unreadable
   * zone is skipped rather than sinking the whole list.
   */
  private async certPacks(
    ctx: ConnectorContext,
    api: CfApi,
    zones: CfZone[],
    fresh: boolean,
  ): Promise<{ zoneId: string; zoneName: string; pack: CfCertPack }[]> {
    const key = this.cacheKey(ctx);
    const cached = this.certCache.get(key);
    if (!fresh && cached && Date.now() - cached.at < CERT_TTL_MS) return cached.packs;

    const perZone = await Promise.all(
      zones.map(async (z) => {
        try {
          const packs = await api.listCertificatePacks(z.id);
          return packs.map((pack) => ({ zoneId: z.id, zoneName: z.name, pack }));
        } catch (err) {
          ctx.log('debug', `Cloudflare certificate packs for ${z.name} unavailable: ${err instanceof Error ? err.message : err}`);
          return [] as { zoneId: string; zoneName: string; pack: CfCertPack }[];
        }
      }),
    );
    const flat = perZone.flat();
    this.certCache.set(key, { at: Date.now(), packs: flat });
    return flat;
  }

  /**
   * The account id to use for account-scoped endpoints (tunnels). Prefers the
   * configured value; otherwise resolves it from GET /accounts (cached) — using the
   * sole account when the token sees exactly one, and erroring clearly otherwise.
   */
  private async resolveAccountId(ctx: ConnectorContext, api: CfApi): Promise<string> {
    const configured = strOrUndef(ctx.config.accountId);
    if (configured) return configured;

    const key = this.cacheKey(ctx);
    const cached = this.accountCache.get(key);
    if (cached && Date.now() - cached.at < ACCOUNT_TTL_MS) return cached.accountId;

    const accounts = await api.listAccounts();
    if (accounts.length === 0) {
      throw new Error('The API token can\'t see any Cloudflare accounts — check its account permissions.');
    }
    if (accounts.length > 1) {
      throw new Error(
        `The API token spans ${accounts.length} accounts — set the Account ID field to choose one (e.g. ${accounts[0].id}).`,
      );
    }
    const accountId = accounts[0].id;
    this.accountCache.set(key, { at: Date.now(), accountId });
    return accountId;
  }

  async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    const api = new CfApi(this.authFrom(ctx));
    try {
      const v = await api.verifyToken();
      if (v.status !== 'active') {
        ctx.log('warn', `Cloudflare token status is "${v.status}".`);
        return { ok: false, message: `Cloudflare API token is "${v.status}", not active.` };
      }
      ctx.log('info', 'Cloudflare API token verified (active).');
      return { ok: true, message: 'Cloudflare API token verified (active).', details: { status: v.status } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed.';
      ctx.log('warn', `Cloudflare connection test failed: ${message}`);
      return { ok: false, message };
    }
  }

  async listResources(ctx: ConnectorContext, kind: string): Promise<ConnectorResource[]> {
    const api = new CfApi(this.authFrom(ctx));

    if (kind === ZONE_KIND) {
      const zones = await api.listZones();
      return zones
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((z) => this.zoneToResource(z));
    }

    if (kind === TUNNEL_KIND) {
      const accountId = await this.resolveAccountId(ctx, api);
      const tunnels = await api.listTunnels(accountId);
      return tunnels
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => this.tunnelToResource(t));
    }

    if (kind === DNS_KIND) {
      // DNS records live under zones — fan out per zone (user-initiated, not the poll).
      const zones = await api.listZones();
      const perZone = await Promise.all(
        zones.map(async (z) => {
          try {
            const records = await api.listDnsRecords(z.id);
            return records.map((r) => this.dnsToResource(r, z.id, z.name));
          } catch (err) {
            // One unreadable zone shouldn't sink the whole list.
            ctx.log('debug', `Cloudflare DNS records for ${z.name} unavailable: ${err instanceof Error ? err.message : err}`);
            return [] as ConnectorResource[];
          }
        }),
      );
      return perZone.flat().sort((a, b) => a.name.localeCompare(b.name));
    }

    if (kind === CERT_KIND) {
      const zones = await api.listZones();
      const packs = await this.certPacks(ctx, api, zones, true); // user-initiated → refresh
      return packs
        .map(({ zoneId, zoneName, pack }) => this.certToResource(pack, zoneId, zoneName))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    if (kind === ACCESS_APP_KIND || kind === SERVICE_TOKEN_KIND || kind === WARP_DEVICE_KIND) {
      const zt = await this.ztData(ctx, api, true); // user-initiated → refresh
      if (kind === ACCESS_APP_KIND) {
        return zt.apps
          .map((a) => this.accessAppToResource(a))
          .sort((a, b) => a.name.localeCompare(b.name));
      }
      if (kind === SERVICE_TOKEN_KIND) {
        return zt.tokens
          .map((t) => this.serviceTokenToResource(t))
          .sort((a, b) => a.name.localeCompare(b.name));
      }
      return zt.devices
        .map((d) => this.deviceToResource(d))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    if (kind === FW_KIND) {
      const zones = await api.listZones();
      const perZone = await Promise.all(
        zones.map(async (z) => {
          try {
            const rulesets = await api.listRulesets(z.id);
            // The custom-firewall entry-point ruleset(s) for this zone hold the user's WAF rules.
            const custom = rulesets.filter((r) => r.phase === FW_CUSTOM_PHASE && r.kind === 'zone');
            const out: ConnectorResource[] = [];
            for (const rs of custom) {
              const full = await api.getRuleset(z.id, rs.id);
              for (const rule of full.rules ?? []) out.push(this.fwRuleToResource(rule, z.id, rs.id, z.name));
            }
            return out;
          } catch (err) {
            ctx.log('debug', `Cloudflare firewall rules for ${z.name} unavailable: ${err instanceof Error ? err.message : err}`);
            return [] as ConnectorResource[];
          }
        }),
      );
      return perZone.flat().sort((a, b) => a.name.localeCompare(b.name));
    }

    if (kind === WORKER_KIND) {
      const accountId = await this.resolveAccountId(ctx, api);
      const workers = await api.listWorkers(accountId);
      return workers.map((w) => this.workerToResource(w)).sort((a, b) => a.name.localeCompare(b.name));
    }

    if (kind === PAGES_KIND) {
      const accountId = await this.resolveAccountId(ctx, api);
      const projects = await api.listPagesProjects(accountId);
      return projects.map((p) => this.pagesToResource(p)).sort((a, b) => a.name.localeCompare(b.name));
    }

    if (kind === R2_KIND) {
      const accountId = await this.resolveAccountId(ctx, api);
      const buckets = await api.listR2Buckets(accountId);
      return buckets.map((b) => this.r2ToResource(b)).sort((a, b) => a.name.localeCompare(b.name));
    }

    if (kind === LB_KIND) {
      const zones = await api.listZones();
      const perZone = await Promise.all(
        zones.map(async (z) => {
          try {
            const lbs = await api.listLoadBalancers(z.id);
            return lbs.map((lb) => this.lbToResource(lb, z.id, z.name));
          } catch (err) {
            ctx.log('debug', `Cloudflare load balancers for ${z.name} unavailable: ${err instanceof Error ? err.message : err}`);
            return [] as ConnectorResource[];
          }
        }),
      );
      return perZone.flat().sort((a, b) => a.name.localeCompare(b.name));
    }

    return [];
  }

  private zoneToResource(z: CfZone): ConnectorResource {
    return {
      id: z.id,
      kind: ZONE_KIND,
      name: z.name,
      status: z.paused ? 'paused' : z.status,
      details: {
        status: z.status,
        paused: z.paused,
        plan: z.plan?.name ?? null,
        type: z.type ?? null,
        name_servers: z.name_servers?.length ? z.name_servers.join(', ') : null,
      },
      tags: { status: z.paused ? 'paused' : z.status, ...(z.plan?.name ? { plan: z.plan.name } : {}) },
    };
  }

  private tunnelToResource(t: CfTunnel): ConnectorResource {
    const conns = t.connections?.length ?? 0;
    const clientVersion = t.connections?.find((c) => c.client_version)?.client_version;
    return {
      id: t.id,
      kind: TUNNEL_KIND,
      name: t.name,
      status: t.status,
      details: {
        connections: conns,
        client: clientVersion ?? null,
        created: rel(t.created_at),
        last_active: rel(t.conns_active_at),
      },
      tags: { status: t.status },
    };
  }

  private dnsToResource(r: CfDnsRecord, zoneId: string, zoneName: string): ConnectorResource {
    return {
      // Composite id so actions/delete/edit know the zone without a lookup.
      id: `${zoneId}:${r.id}`,
      kind: DNS_KIND,
      // Include the type so records disambiguate in the list (e.g. "A · api.example.com").
      name: `${r.type} · ${r.name}`,
      status: r.proxied ? 'proxied' : 'dns_only',
      details: {
        type: r.type,
        name: r.name,
        content: r.content,
        proxied: !!r.proxied,
        ttl: r.ttl === 1 ? 'auto' : (r.ttl ?? null),
        zone: zoneName,
        comment: r.comment ?? null,
      },
      tags: { zone: zoneName, type: r.type, status: r.proxied ? 'proxied' : 'dns_only' },
    };
  }

  private certToResource(pack: CfCertPack, zoneId: string, zoneName: string): ConnectorResource {
    const expiry = earliestExpiry(pack);
    const days = daysUntil(expiry);
    const issuer = pack.certificates?.find((c) => c.issuer)?.issuer;
    const hosts = pack.hosts?.length ? pack.hosts : [zoneName];
    return {
      id: `${zoneId}:${pack.id}`,
      kind: CERT_KIND,
      name: hosts[0] + (hosts.length > 1 ? ` (+${hosts.length - 1})` : ''),
      status: pack.status ?? 'unknown',
      details: {
        type: pack.type ?? null,
        hosts: hosts.join(', '),
        issuer: issuer ?? null,
        expires: expiry ? expiry.slice(0, 10) : null,
        days_left: days ?? null,
        zone: zoneName,
      },
      tags: { zone: zoneName, ...(pack.type ? { type: pack.type } : {}) },
    };
  }

  private accessAppToResource(a: CfAccessApp): ConnectorResource {
    return {
      id: a.id,
      kind: ACCESS_APP_KIND,
      name: a.name || a.domain || a.id,
      status: a.type || 'app',
      details: {
        domain: a.domain ?? null,
        type: a.type ?? null,
        aud: a.aud ?? null,
        created: rel(a.created_at),
      },
      tags: a.type ? { type: a.type } : undefined,
    };
  }

  private serviceTokenToResource(t: CfServiceToken): ConnectorResource {
    const days = daysUntil(t.expires_at);
    const status = t.expires_at ? (days != null && days < 0 ? 'expired' : 'active') : 'active';
    return {
      id: t.id,
      kind: SERVICE_TOKEN_KIND,
      name: t.name || t.id,
      status,
      details: {
        client_id: t.client_id ?? null,
        expires: t.expires_at ? t.expires_at.slice(0, 10) : null,
        days_left: days ?? null,
        created: rel(t.created_at),
      },
    };
  }

  private deviceToResource(d: CfDevice): ConnectorResource {
    return {
      id: d.id,
      kind: WARP_DEVICE_KIND,
      name: d.name || d.user?.email || d.model || d.id,
      status: d.deleted ? 'deleted' : 'active',
      details: {
        user: d.user?.email ?? d.user?.name ?? null,
        model: d.model ?? null,
        os: d.os_version ?? null,
        type: d.device_type ?? null,
        last_seen: rel(d.last_seen),
      },
      tags: d.user?.email ? { user: d.user.email } : undefined,
    };
  }

  private fwRuleToResource(rule: CfRule, zoneId: string, rulesetId: string, zoneName: string): ConnectorResource {
    const enabled = rule.enabled !== false; // default enabled when the flag is absent
    const label = rule.description?.trim() || rule.expression;
    return {
      id: `${zoneId}:${rulesetId}:${rule.id}`,
      kind: FW_KIND,
      name: label.length > 60 ? label.slice(0, 57) + '…' : label,
      status: enabled ? 'enabled' : 'disabled',
      details: {
        action: rule.action,
        expression: rule.expression,
        enabled,
        zone: zoneName,
      },
      tags: { zone: zoneName, action: rule.action },
    };
  }

  private workerToResource(w: CfWorker): ConnectorResource {
    return {
      id: w.id,
      kind: WORKER_KIND,
      name: w.id,
      status: 'deployed',
      details: {
        usage_model: w.usage_model ?? null,
        modified: rel(w.modified_on),
        created: rel(w.created_on),
      },
    };
  }

  private pagesToResource(p: CfPagesProject): ConnectorResource {
    const stage = p.latest_deployment?.latest_stage;
    // The deploy status when finished is the build stage's status; fall back to 'idle'.
    const status = stage?.status || 'idle';
    return {
      id: p.name,
      kind: PAGES_KIND,
      name: p.name,
      status,
      details: {
        subdomain: p.subdomain ?? null,
        domains: p.domains?.length ? p.domains.join(', ') : null,
        environment: p.latest_deployment?.environment ?? null,
        last_deploy: rel(p.latest_deployment?.created_on),
        production_branch: p.production_branch ?? null,
      },
      tags: p.latest_deployment?.environment ? { environment: p.latest_deployment.environment } : undefined,
    };
  }

  private r2ToResource(b: CfR2Bucket): ConnectorResource {
    return {
      id: b.name,
      kind: R2_KIND,
      name: b.name,
      status: 'active',
      details: {
        location: b.location ?? null,
        created: rel(b.creation_date),
      },
      tags: b.location ? { location: b.location } : undefined,
    };
  }

  private lbToResource(lb: CfLoadBalancer, zoneId: string, zoneName: string): ConnectorResource {
    return {
      id: `${zoneId}:${lb.id}`,
      kind: LB_KIND,
      name: lb.name,
      status: lb.enabled === false ? 'disabled' : 'enabled',
      details: {
        proxied: lb.proxied ?? null,
        pools: lb.default_pools?.length ?? 0,
        fallback: lb.fallback_pool ?? null,
        zone: zoneName,
      },
      tags: { zone: zoneName },
    };
  }

  async describeResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<ConnectorResourceDetail> {
    const api = new CfApi(this.authFrom(ctx));

    if (kind === ZONE_KIND) {
      const zones = await api.listZones();
      const z = zones.find((x) => x.id === resourceId);
      if (!z) throw new Error(`Zone ${resourceId} not found.`);
      const items: ConnectorDetailItem[] = [
        { label: 'Name', value: z.name },
        { label: 'Status', value: z.paused ? 'paused' : z.status, variant: 'status' },
        { label: 'Plan', value: z.plan?.name ?? '—' },
        { label: 'Type', value: z.type ?? '—' },
        { label: 'Zone ID', value: z.id, variant: 'mono' },
      ];
      const groups: ConnectorDetailGroup[] = [{ title: 'General', items }];
      if (z.name_servers?.length) {
        groups.push({
          title: 'Name servers',
          items: z.name_servers.map((ns) => ({ label: 'NS', value: ns, variant: 'mono' })),
        });
      }
      return { id: z.id, kind, name: z.name, status: z.paused ? 'paused' : z.status, groups };
    }

    if (kind === TUNNEL_KIND) {
      const accountId = await this.resolveAccountId(ctx, api);
      let t: CfTunnel;
      try {
        t = await api.getTunnel(accountId, resourceId);
      } catch {
        const all = await api.listTunnels(accountId);
        const found = all.find((x) => x.id === resourceId);
        if (!found) throw new Error(`Tunnel ${resourceId} not found.`);
        t = found;
      }
      const general: ConnectorDetailItem[] = [
        { label: 'Name', value: t.name },
        { label: 'Status', value: t.status, variant: 'status' },
        { label: 'Active connections', value: String(t.connections?.length ?? 0) },
        { label: 'Created', value: rel(t.created_at) ?? '—' },
        { label: 'Last active', value: rel(t.conns_active_at) ?? '—' },
        { label: 'Tunnel ID', value: t.id, variant: 'mono' },
      ];
      const groups: ConnectorDetailGroup[] = [{ title: 'General', items: general }];
      if (t.connections?.length) {
        groups.push({
          title: 'Connections',
          items: t.connections.map((c, i) => ({
            label: c.colo_name ? `${c.colo_name}` : `Connection ${i + 1}`,
            value: [c.client_version && `cloudflared ${c.client_version}`, c.origin_ip].filter(Boolean).join(' · ') || '—',
          })),
        });
      }
      return { id: t.id, kind, name: t.name, status: t.status, groups };
    }

    if (kind === DNS_KIND) {
      const parts = splitDnsId(resourceId);
      if (!parts) throw new Error(`DNS record ${resourceId} not found.`);
      const r = await api.getDnsRecord(parts.zoneId, parts.recordId);
      const zones = await api.listZones();
      const zoneName = zones.find((z) => z.id === parts.zoneId)?.name ?? r.zone_name ?? parts.zoneId;
      const items: ConnectorDetailItem[] = [
        { label: 'Type', value: r.type },
        { label: 'Name', value: r.name, variant: 'mono' },
        { label: 'Content', value: r.content, variant: 'mono' },
        { label: 'Proxied', value: r.proxied ? 'Yes (orange cloud)' : 'No (DNS only)', variant: 'status' },
        { label: 'TTL', value: r.ttl === 1 ? 'Auto' : String(r.ttl ?? '—') },
        { label: 'Zone', value: zoneName },
        { label: 'Comment', value: r.comment ?? '—' },
        { label: 'Record ID', value: r.id, variant: 'mono' },
      ];
      return {
        id: resourceId,
        kind,
        name: `${r.type} · ${r.name}`,
        status: r.proxied ? 'proxied' : 'dns_only',
        groups: [{ title: 'General', items }],
      };
    }

    if (kind === CERT_KIND) {
      const parts = splitDnsId(resourceId); // same "zoneId:packId" shape
      if (!parts) throw new Error(`Certificate ${resourceId} not found.`);
      const packs = await api.listCertificatePacks(parts.zoneId);
      const pack = packs.find((p) => p.id === parts.recordId);
      if (!pack) throw new Error(`Certificate ${resourceId} not found.`);
      const zones = await api.listZones();
      const zoneName = zones.find((z) => z.id === parts.zoneId)?.name ?? parts.zoneId;
      const expiry = earliestExpiry(pack);
      const days = daysUntil(expiry);
      const issuer = pack.certificates?.find((c) => c.issuer)?.issuer;
      const items: ConnectorDetailItem[] = [
        { label: 'Status', value: pack.status ?? 'unknown', variant: 'status' },
        { label: 'Type', value: pack.type ?? '—' },
        { label: 'Hosts', value: pack.hosts?.length ? pack.hosts.join(', ') : zoneName },
        { label: 'Issuer', value: issuer ?? '—' },
        { label: 'Expires', value: expiry ? expiry.slice(0, 10) : '—' },
        { label: 'Days left', value: days == null ? '—' : String(days) },
        { label: 'Zone', value: zoneName },
        { label: 'Pack ID', value: pack.id, variant: 'mono' },
      ];
      return { id: resourceId, kind, name: pack.hosts?.[0] ?? zoneName, status: pack.status ?? 'unknown', groups: [{ title: 'General', items }] };
    }

    if (kind === ACCESS_APP_KIND || kind === SERVICE_TOKEN_KIND || kind === WARP_DEVICE_KIND) {
      const zt = await this.ztData(ctx, api, false);
      if (kind === ACCESS_APP_KIND) {
        const a = zt.apps.find((x) => x.id === resourceId);
        if (!a) throw new Error(`Access app ${resourceId} not found.`);
        const items: ConnectorDetailItem[] = [
          { label: 'Name', value: a.name || '—' },
          { label: 'Domain', value: a.domain || '—', variant: 'mono' },
          { label: 'Type', value: a.type || '—' },
          { label: 'AUD', value: a.aud || '—', variant: 'mono' },
          { label: 'Created', value: rel(a.created_at) ?? '—' },
          { label: 'App ID', value: a.id, variant: 'mono' },
        ];
        return { id: a.id, kind, name: a.name || a.domain || a.id, status: a.type || 'app', groups: [{ title: 'General', items }] };
      }
      if (kind === SERVICE_TOKEN_KIND) {
        const t = zt.tokens.find((x) => x.id === resourceId);
        if (!t) throw new Error(`Service token ${resourceId} not found.`);
        const days = daysUntil(t.expires_at);
        const items: ConnectorDetailItem[] = [
          { label: 'Name', value: t.name || '—' },
          { label: 'Client ID', value: t.client_id || '—', variant: 'mono' },
          { label: 'Expires', value: t.expires_at ? t.expires_at.slice(0, 10) : '—' },
          { label: 'Days left', value: days == null ? '—' : String(days) },
          { label: 'Duration', value: t.duration || '—' },
          { label: 'Created', value: rel(t.created_at) ?? '—' },
          { label: 'Token ID', value: t.id, variant: 'mono' },
        ];
        const status = t.expires_at ? (days != null && days < 0 ? 'expired' : 'active') : 'active';
        return { id: t.id, kind, name: t.name || t.id, status, groups: [{ title: 'General', items }] };
      }
      const d = zt.devices.find((x) => x.id === resourceId);
      if (!d) throw new Error(`Device ${resourceId} not found.`);
      const items: ConnectorDetailItem[] = [
        { label: 'Name', value: d.name || '—' },
        { label: 'User', value: d.user?.email || d.user?.name || '—' },
        { label: 'Model', value: d.model || '—' },
        { label: 'OS', value: d.os_version || '—' },
        { label: 'Type', value: d.device_type || '—' },
        { label: 'Last seen', value: rel(d.last_seen) ?? '—' },
        { label: 'Device ID', value: d.id, variant: 'mono' },
      ];
      return { id: d.id, kind, name: d.name || d.user?.email || d.id, status: d.deleted ? 'deleted' : 'active', groups: [{ title: 'General', items }] };
    }

    if (kind === FW_KIND) {
      const parts = splitFwId(resourceId);
      if (!parts) throw new Error(`Firewall rule ${resourceId} not found.`);
      const rs = await api.getRuleset(parts.zoneId, parts.rulesetId);
      const rule = (rs.rules ?? []).find((r) => r.id === parts.ruleId);
      if (!rule) throw new Error(`Firewall rule ${resourceId} not found.`);
      const zones = await api.listZones();
      const zoneName = zones.find((z) => z.id === parts.zoneId)?.name ?? parts.zoneId;
      const enabled = rule.enabled !== false;
      const items: ConnectorDetailItem[] = [
        { label: 'Description', value: rule.description || '—' },
        { label: 'Status', value: enabled ? 'enabled' : 'disabled', variant: 'status' },
        { label: 'Action', value: rule.action },
        { label: 'Expression', value: rule.expression, variant: 'mono' },
        { label: 'Zone', value: zoneName },
        { label: 'Rule ID', value: rule.id, variant: 'mono' },
      ];
      return { id: resourceId, kind, name: rule.description || rule.expression, status: enabled ? 'enabled' : 'disabled', groups: [{ title: 'General', items }] };
    }

    if (kind === WORKER_KIND) {
      const accountId = await this.resolveAccountId(ctx, api);
      const w = (await api.listWorkers(accountId)).find((x) => x.id === resourceId);
      if (!w) throw new Error(`Worker ${resourceId} not found.`);
      const items: ConnectorDetailItem[] = [
        { label: 'Name', value: w.id, variant: 'mono' },
        { label: 'Usage model', value: w.usage_model || '—' },
        { label: 'Modified', value: rel(w.modified_on) ?? '—' },
        { label: 'Created', value: rel(w.created_on) ?? '—' },
      ];
      return { id: w.id, kind, name: w.id, status: 'deployed', groups: [{ title: 'General', items }] };
    }

    if (kind === PAGES_KIND) {
      const accountId = await this.resolveAccountId(ctx, api);
      const p = await api.getPagesProject(accountId, resourceId);
      const stage = p.latest_deployment?.latest_stage;
      const items: ConnectorDetailItem[] = [
        { label: 'Name', value: p.name },
        { label: 'Subdomain', value: p.subdomain || '—', variant: 'mono' },
        { label: 'Custom domains', value: p.domains?.length ? p.domains.join(', ') : '—' },
        { label: 'Production branch', value: p.production_branch || '—' },
        { label: 'Last deploy', value: rel(p.latest_deployment?.created_on) ?? '—' },
        { label: 'Last stage', value: stage ? `${stage.name ?? ''} (${stage.status ?? ''})`.trim() : '—' },
        { label: 'Environment', value: p.latest_deployment?.environment || '—' },
      ];
      return { id: p.name, kind, name: p.name, status: stage?.status || 'idle', groups: [{ title: 'General', items }] };
    }

    if (kind === R2_KIND) {
      const accountId = await this.resolveAccountId(ctx, api);
      const b = (await api.listR2Buckets(accountId)).find((x) => x.name === resourceId);
      if (!b) throw new Error(`Bucket ${resourceId} not found.`);
      const items: ConnectorDetailItem[] = [
        { label: 'Name', value: b.name, variant: 'mono' },
        { label: 'Location', value: b.location || '—' },
        { label: 'Created', value: rel(b.creation_date) ?? '—' },
      ];
      return { id: b.name, kind, name: b.name, status: 'active', groups: [{ title: 'General', items }] };
    }

    if (kind === LB_KIND) {
      const parts = splitDnsId(resourceId); // "zoneId:lbId"
      if (!parts) throw new Error(`Load balancer ${resourceId} not found.`);
      const lb = (await api.listLoadBalancers(parts.zoneId)).find((x) => x.id === parts.recordId);
      if (!lb) throw new Error(`Load balancer ${resourceId} not found.`);
      const zones = await api.listZones();
      const zoneName = zones.find((z) => z.id === parts.zoneId)?.name ?? parts.zoneId;
      const items: ConnectorDetailItem[] = [
        { label: 'Name', value: lb.name },
        { label: 'Status', value: lb.enabled === false ? 'disabled' : 'enabled', variant: 'status' },
        { label: 'Proxied', value: lb.proxied ? 'Yes' : 'No' },
        { label: 'Default pools', value: String(lb.default_pools?.length ?? 0) },
        { label: 'Fallback pool', value: lb.fallback_pool || '—', variant: 'mono' },
        { label: 'Description', value: lb.description || '—' },
        { label: 'Zone', value: zoneName },
      ];
      return { id: resourceId, kind, name: lb.name, status: lb.enabled === false ? 'disabled' : 'enabled', groups: [{ title: 'General', items }] };
    }

    throw new Error(`Unknown resource kind "${kind}".`);
  }

  async performAction(
    ctx: ConnectorContext,
    kind: string,
    resourceId: string,
    actionId: string,
  ): Promise<{ ok: boolean; message: string }> {
    const api = new CfApi(this.authFrom(ctx));
    try {
      if (kind === ZONE_KIND && actionId === 'purge_cache') {
        await api.purgeCache(resourceId, { purge_everything: true });
        ctx.log('info', `Cloudflare purged all cache for zone ${resourceId}.`);
        return { ok: true, message: 'Cache purge requested (everything).' };
      }

      if (kind === DNS_KIND && (actionId === 'proxy_on' || actionId === 'proxy_off')) {
        const parts = splitDnsId(resourceId);
        if (!parts) return { ok: false, message: 'Could not resolve the record\'s zone.' };
        const proxied = actionId === 'proxy_on';
        if (proxied) {
          // Only A/AAAA/CNAME can be proxied — check first so we give a clear message.
          const rec = await api.getDnsRecord(parts.zoneId, parts.recordId);
          if (!(rec.proxiable ?? PROXYABLE_TYPES.has(rec.type))) {
            return { ok: false, message: `${rec.type} records can't be proxied through Cloudflare.` };
          }
          // Proxied records must use automatic TTL.
          await api.updateDnsRecord(parts.zoneId, parts.recordId, { proxied: true, ttl: 1 });
        } else {
          await api.updateDnsRecord(parts.zoneId, parts.recordId, { proxied: false });
        }
        ctx.log('info', `Cloudflare set proxied=${proxied} on record ${parts.recordId}.`);
        return { ok: true, message: `Proxy turned ${proxied ? 'on' : 'off'}.` };
      }

      if (kind === FW_KIND && (actionId === 'enable' || actionId === 'disable')) {
        const parts = splitFwId(resourceId);
        if (!parts) return { ok: false, message: 'Could not resolve the rule.' };
        const enabled = actionId === 'enable';
        // The rules endpoint wants the rule's core fields on update — re-send action +
        // expression (+ description) alongside the flipped `enabled` flag.
        const rs = await api.getRuleset(parts.zoneId, parts.rulesetId);
        const rule = (rs.rules ?? []).find((r) => r.id === parts.ruleId);
        if (!rule) return { ok: false, message: 'Firewall rule not found.' };
        await api.updateRulesetRule(parts.zoneId, parts.rulesetId, parts.ruleId, {
          action: rule.action,
          expression: rule.expression,
          description: rule.description ?? '',
          enabled,
        });
        ctx.log('info', `Cloudflare ${enabled ? 'enabled' : 'disabled'} firewall rule ${parts.ruleId}.`);
        return { ok: true, message: `Firewall rule ${enabled ? 'enabled' : 'disabled'}.` };
      }

      return { ok: false, message: `Unsupported action "${actionId}" for ${kind}.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action failed.';
      ctx.log('error', `Cloudflare action ${kind}.${actionId} on ${resourceId} failed: ${message}`);
      return { ok: false, message };
    }
  }

  async deleteResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<{ ok: boolean; message: string }> {
    const api = new CfApi(this.authFrom(ctx));
    try {
      if (kind === DNS_KIND) {
        const parts = splitDnsId(resourceId);
        if (!parts) return { ok: false, message: 'Could not resolve the record\'s zone.' };
        await api.deleteDnsRecord(parts.zoneId, parts.recordId);
        ctx.log('info', `Cloudflare deleted DNS record ${parts.recordId}.`);
        return { ok: true, message: 'DNS record deleted.' };
      }
      if (kind === TUNNEL_KIND) {
        const accountId = await this.resolveAccountId(ctx, api);
        await api.deleteTunnel(accountId, resourceId);
        ctx.log('info', `Cloudflare deleted tunnel ${resourceId}.`);
        return { ok: true, message: 'Tunnel deleted.' };
      }
      return { ok: false, message: `${kind} resources can't be deleted.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Delete failed.';
      ctx.log('error', `Cloudflare delete ${kind} ${resourceId} failed: ${message}`);
      return { ok: false, message };
    }
  }

  async resolveOptions(ctx: ConnectorContext, sourceId: string): Promise<ConnectorOption[]> {
    if (sourceId === 'cf-zones') {
      const api = new CfApi(this.authFrom(ctx));
      const zones = await api.listZones();
      return zones
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((z) => ({ label: z.name, value: z.id }));
    }
    return [];
  }

  async operationDefaults(
    ctx: ConnectorContext,
    operationId: string,
    resourceId: string | undefined,
  ): Promise<Record<string, unknown>> {
    const api = new CfApi(this.authFrom(ctx));

    if (operationId === 'edit-dns-record' && resourceId) {
      const parts = splitDnsId(resourceId);
      if (!parts) return {};
      const r = await api.getDnsRecord(parts.zoneId, parts.recordId);
      return { name: r.name, content: r.content, ttl: r.ttl ?? 1, proxied: !!r.proxied };
    }

    if (operationId === 'zone-security-level' && resourceId) {
      try {
        const s = await api.getZoneSetting(resourceId, 'security_level');
        return { value: String(s.value ?? 'medium') };
      } catch {
        return { value: 'medium' };
      }
    }

    if (operationId === 'zone-dev-mode' && resourceId) {
      try {
        const s = await api.getZoneSetting(resourceId, 'development_mode');
        return { value: String(s.value ?? 'off') };
      } catch {
        return { value: 'off' };
      }
    }

    return {};
  }

  async runOperation(
    ctx: ConnectorContext,
    operationId: string,
    resourceId: string | undefined,
    values: Record<string, unknown>,
    onProgress: OperationProgress,
  ): Promise<OperationResult> {
    const api = new CfApi(this.authFrom(ctx));
    try {
      if (operationId === 'create-dns-record') {
        const zoneId = strOrUndef(values.zone);
        const type = strOrUndef(values.type);
        const name = strOrUndef(values.name);
        const content = strOrUndef(values.content);
        if (!zoneId || !type || !name || !content) return { ok: false, message: 'Zone, type, name, and content are required.' };
        const proxied = asBool(values.proxied);
        if (proxied && !PROXYABLE_TYPES.has(type)) return { ok: false, message: `${type} records can't be proxied through Cloudflare.` };
        const ttl = proxied ? 1 : (numOrUndef(values.ttl) ?? 1); // proxied records must be automatic
        onProgress(`Creating ${type} record ${name}…`);
        const rec = await api.createDnsRecord(zoneId, { type, name, content, ttl, proxied });
        return { ok: true, message: `Created ${type} record ${rec.name}.`, createdResourceId: `${zoneId}:${rec.id}` };
      }

      if (operationId === 'edit-dns-record') {
        if (!resourceId) return { ok: false, message: 'No target record.' };
        const parts = splitDnsId(resourceId);
        if (!parts) return { ok: false, message: 'Could not resolve the record\'s zone.' };
        const name = strOrUndef(values.name);
        const content = strOrUndef(values.content);
        if (!name || !content) return { ok: false, message: 'Name and content are required.' };
        const proxied = asBool(values.proxied);
        const body: Record<string, unknown> = { name, content, proxied };
        // Proxied records must use automatic TTL; otherwise honor the entered value.
        body.ttl = proxied ? 1 : (numOrUndef(values.ttl) ?? 1);
        onProgress('Saving record…');
        await api.updateDnsRecord(parts.zoneId, parts.recordId, body);
        return { ok: true, message: 'DNS record updated.' };
      }

      if (operationId === 'zone-security-level') {
        if (!resourceId) return { ok: false, message: 'No target zone.' };
        const value = strOrUndef(values.value);
        if (!value) return { ok: false, message: 'Choose a security level.' };
        onProgress(`Setting security level to ${value}…`);
        await api.patchZoneSetting(resourceId, 'security_level', value);
        return { ok: true, message: `Security level set to ${value}.` };
      }

      if (operationId === 'zone-dev-mode') {
        if (!resourceId) return { ok: false, message: 'No target zone.' };
        const value = strOrUndef(values.value);
        if (value !== 'on' && value !== 'off') return { ok: false, message: 'Choose on or off.' };
        onProgress(`Turning development mode ${value}…`);
        await api.patchZoneSetting(resourceId, 'development_mode', value);
        return { ok: true, message: `Development mode turned ${value}.` };
      }

      if (operationId === 'zone-purge-urls') {
        if (!resourceId) return { ok: false, message: 'No target zone.' };
        const files = String(values.urls ?? '')
          .split(/\r?\n/)
          .map((u) => u.trim())
          .filter(Boolean);
        if (files.length === 0) return { ok: false, message: 'Enter at least one URL.' };
        onProgress(`Purging ${files.length} URL(s)…`);
        await api.purgeCache(resourceId, { files });
        return { ok: true, message: `Purge requested for ${files.length} URL(s).` };
      }

      if (operationId === 'pages-retry-deploy') {
        if (!resourceId) return { ok: false, message: 'No target project.' };
        const accountId = await this.resolveAccountId(ctx, api);
        onProgress('Looking up the latest deployment…');
        const proj = await api.getPagesProject(accountId, resourceId);
        const depId = proj?.latest_deployment?.id;
        if (!depId) return { ok: false, message: 'This project has no deployment to retry yet.' };
        onProgress('Retrying deployment…');
        await api.retryPagesDeployment(accountId, resourceId, depId);
        return { ok: true, message: 'Deployment retry requested.' };
      }

      return { ok: false, message: `Unknown operation "${operationId}".` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Operation failed.';
      ctx.log('error', `Cloudflare operation ${operationId} failed: ${message}`);
      return { ok: false, message };
    }
  }

  /**
   * Dashboard summary. Kept cheap for the every-minute poll: two list calls (zones +
   * tunnels), all counts computed in memory. Tunnel access is best-effort — if the
   * token lacks the account-scoped permission, zones still report.
   */
  async overview(ctx: ConnectorContext): Promise<ConnectorOverview> {
    const api = new CfApi(this.authFrom(ctx));
    const zones = await api.listZones();
    const zonesPaused = zones.filter((z) => z.paused || z.status === 'deactivated').length;

    const metrics: OverviewMetric[] = [
      { key: 'zonesTotal', label: 'Zones', value: zones.length },
      { key: 'zonesPaused', label: 'Zones paused', value: zonesPaused },
    ];

    let tunnels: CfTunnel[] = [];
    try {
      const accountId = await this.resolveAccountId(ctx, api);
      tunnels = await api.listTunnels(accountId);
      const tunnelsDown = tunnels.filter((t) => TUNNEL_DOWN_STATES.has(t.status)).length;
      metrics.unshift(
        { key: 'tunnelsTotal', label: 'Tunnels', value: tunnels.length },
        { key: 'tunnelsDown', label: 'Tunnels down', value: tunnelsDown },
      );
    } catch (err) {
      ctx.log('debug', `Cloudflare tunnels unavailable for overview: ${err instanceof Error ? err.message : err}`);
    }

    // Certificate expiry — cached per-zone fan-out (heavy), best-effort so it never fails the overview.
    try {
      const packs = await this.certPacks(ctx, api, zones, false);
      const expiringSoon = packs.filter(({ pack }) => {
        const d = daysUntil(earliestExpiry(pack));
        return d != null && d <= CERT_EXPIRY_WINDOW_DAYS;
      }).length;
      metrics.push({ key: 'certsExpiringSoon', label: 'Certs expiring', value: expiringSoon });
    } catch (err) {
      ctx.log('debug', `Cloudflare certificates unavailable for overview: ${err instanceof Error ? err.message : err}`);
    }

    // Zero Trust — cached account-scoped lists, best-effort so a missing scope never fails the overview.
    try {
      const zt = await this.ztData(ctx, api, false);
      const tokensExpiringSoon = zt.tokens.filter((t) => {
        const d = daysUntil(t.expires_at);
        return d != null && d <= TOKEN_EXPIRY_WINDOW_DAYS;
      }).length;
      metrics.push(
        { key: 'accessAppsTotal', label: 'Access apps', value: zt.apps.length },
        { key: 'warpDevicesTotal', label: 'WARP devices', value: zt.devices.filter((d) => !d.deleted).length },
        { key: 'tokensExpiringSoon', label: 'Tokens expiring', value: tokensExpiringSoon },
      );
    } catch (err) {
      ctx.log('debug', `Cloudflare Zero Trust unavailable for overview: ${err instanceof Error ? err.message : err}`);
    }

    // Traffic analytics (GraphQL, plan-gated) — cached, best-effort. Only add tiles if available.
    try {
      const a = await this.analyticsTotals(ctx, api, zones, false);
      if (a) {
        metrics.push(
          { key: 'requests24h', label: 'Requests (24h)', value: a.requests },
          { key: 'bandwidthGb24h', label: 'Bandwidth (24h)', value: Math.round((a.bytes / 1e9) * 10) / 10, unit: 'GB' },
          { key: 'threats24h', label: 'Threats (24h)', value: a.threats },
        );
      }
    } catch (err) {
      ctx.log('debug', `Cloudflare analytics unavailable for overview: ${err instanceof Error ? err.message : err}`);
    }

    const tunnelGuests = tunnels
      .slice()
      .sort((a, b) => (TUNNEL_DOWN_STATES.has(b.status) ? 1 : 0) - (TUNNEL_DOWN_STATES.has(a.status) ? 1 : 0))
      .map((t) => ({ name: t.name, kind: TUNNEL_KIND, status: t.status, node: '' }));
    const zoneGuests = zones
      .slice()
      .sort((a, b) => (b.paused ? 1 : 0) - (a.paused ? 1 : 0) || a.name.localeCompare(b.name))
      .map((z) => ({ name: z.name, kind: ZONE_KIND, status: z.paused ? 'paused' : z.status, node: '' }));

    return { metrics, guests: [...tunnelGuests, ...zoneGuests].slice(0, 40) };
  }
}
