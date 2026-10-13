import type {
  Connector,
  ConnectorContext,
  ConnectorManifest,
  ConnectorOperation,
  ConnectorResource,
  ConnectorResourceDetail,
  ConnectorResourceKind,
  ConnectorDetailItem,
  ConnectorOverview,
  OverviewMetric,
  OperationProgress,
  OperationResult,
  TestConnectionResult,
} from '@cerebro/shared';
import {
  TechnitiumApi,
  TechAuth,
  TechZone,
  TechDhcpScope,
  TechDhcpLease,
  TechRecord,
} from './technitium-api';

const ZONE_KIND = 'zone';
const DHCP_SCOPE_KIND = 'dhcp_scope';
const DHCP_LEASE_KIND = 'dhcp_lease';
const ALLOWED_KIND = 'allowed_zone';
const BLOCKED_KIND = 'blocked_zone';
const RECORD_SUB = 'record';

/** The record types this connector can add/edit/delete. Each maps to a value field below. */
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'PTR', 'SRV'];

/** Record types that are auto-managed (SOA/DNSSEC) — shown? no, hidden from the editable list. */
const HIDDEN_RECORD_TYPES = new Set(['SOA', 'RRSIG', 'NSEC', 'NSEC3', 'NSEC3PARAM', 'DNSKEY']);

/** How many top clients to surface as the dashboard's live sample. */
const TOP_GUESTS = 12;

/**
 * Phase 2 kinds. Zones gain enable/disable actions, typed-name delete, and a
 * "DNS Records" sub-collection (add/edit/delete). Allow/block domains become
 * deletable and gain an "add" button. DHCP stays read-only.
 */
const KINDS: ConnectorResourceKind[] = [
  {
    id: ZONE_KIND,
    label: 'DNS Zones',
    deletable: true,
    actions: [
      { id: 'enable', label: 'Enable', mutating: true, showWhenStatus: ['disabled'] },
      { id: 'disable', label: 'Disable', mutating: true, showWhenStatus: ['active'], confirm: 'Disable this zone? The server will stop answering queries for it.', intent: 'destructive' },
    ],
    subResources: [
      {
        id: RECORD_SUB,
        label: 'DNS Records',
        labelSingular: 'record',
        createOperationId: 'add-record',
        itemActions: [
          { id: 'edit', label: 'Edit', operationId: 'edit-record', paramKey: 'record' },
          { id: 'delete', label: 'Delete', operationId: 'delete-record', paramKey: 'record', confirm: 'Delete this DNS record?', intent: 'destructive' },
        ],
      },
    ],
  },
  { id: DHCP_SCOPE_KIND, label: 'DHCP Scopes', deletable: false, actions: [] },
  { id: DHCP_LEASE_KIND, label: 'DHCP Leases', deletable: false, actions: [] },
  { id: ALLOWED_KIND, label: 'Allowed Domains', deletable: true, actions: [] },
  { id: BLOCKED_KIND, label: 'Blocked Domains', deletable: true, actions: [] },
];

/** The main value field, shown for every record type with type-appropriate help. */
const RECORD_VALUE_FIELD = {
  key: 'value',
  label: 'Value',
  type: 'text' as const,
  required: true,
  placeholder: '203.0.113.10',
  help: 'A/AAAA: IP address · CNAME/NS: target host · TXT: text · MX: mail host · PTR: target name · SRV: target host.',
};

const OPERATIONS: ConnectorOperation[] = [
  // ── DNS records (sub-resource ops under a zone; no `kind` so they surface only there) ──
  {
    id: 'add-record',
    label: 'Add DNS record',
    description: 'Add a record to this zone.',
    scope: 'resource',
    icon: 'plus',
    submitLabel: 'Add record',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'www  (or @ for the zone root)', help: 'The record name. Use "@" or leave bare for the zone root; a short label like "www" is taken relative to the zone.' },
      { key: 'type', label: 'Type', type: 'select', required: true, default: 'A', options: RECORD_TYPES.map((t) => ({ label: t, value: t })) },
      RECORD_VALUE_FIELD,
      { key: 'preference', label: 'Preference', type: 'number', default: 10, help: 'MX only — lower is preferred.', showWhen: { field: 'type', equals: 'MX' } },
      { key: 'priority', label: 'Priority', type: 'number', default: 1, help: 'SRV only.', showWhen: { field: 'type', equals: 'SRV' } },
      { key: 'weight', label: 'Weight', type: 'number', default: 1, help: 'SRV only.', showWhen: { field: 'type', equals: 'SRV' } },
      { key: 'port', label: 'Port', type: 'number', help: 'SRV only.', showWhen: { field: 'type', equals: 'SRV' } },
      { key: 'ttl', label: 'TTL (seconds)', type: 'number', default: 3600 },
    ],
  },
  {
    id: 'edit-record',
    label: 'Edit DNS record',
    description: 'Change this record\'s value or TTL.',
    scope: 'resource',
    icon: 'pencil',
    submitLabel: 'Save',
    prefill: true,
    fields: [
      RECORD_VALUE_FIELD,
      { key: 'preference', label: 'Preference', type: 'number', help: 'MX only.' },
      { key: 'priority', label: 'Priority', type: 'number', help: 'SRV only.' },
      { key: 'weight', label: 'Weight', type: 'number', help: 'SRV only.' },
      { key: 'port', label: 'Port', type: 'number', help: 'SRV only.' },
      { key: 'ttl', label: 'TTL (seconds)', type: 'number', default: 3600 },
    ],
  },
  { id: 'delete-record', label: 'Delete DNS record', scope: 'resource', fields: [] },
  // ── Allow / block list entries (scope 'create' → an "Add" button on each tab) ──
  {
    id: 'add-allowed',
    label: 'Allow a domain',
    description: 'Manually allow a domain (and its subdomains), overriding any block list.',
    scope: 'create',
    kind: ALLOWED_KIND,
    icon: 'plus',
    submitLabel: 'Allow domain',
    fields: [
      { key: 'domain', label: 'Domain', type: 'text', required: true, placeholder: 'example.com', help: 'The domain to allow. Its subdomains are allowed too.' },
    ],
  },
  {
    id: 'add-blocked',
    label: 'Block a domain',
    description: 'Manually block a domain (and its subdomains).',
    scope: 'create',
    kind: BLOCKED_KIND,
    icon: 'plus',
    submitLabel: 'Block domain',
    fields: [
      { key: 'domain', label: 'Domain', type: 'text', required: true, placeholder: 'ads.example.com', help: 'The domain to block. Its subdomains are blocked too.' },
    ],
  },
];

function strOrUndef(v: unknown): string | undefined {
  const s = v == null ? '' : String(v).trim();
  return s ? s : undefined;
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
}

function numOrUndef(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : undefined;
}

/**
 * A record's stable identity, encoded into the sub-resource id so edit/delete can
 * rebuild the exact type-specific parameters Technitium needs. `d` = full record
 * domain, `t` = type, `rd` = the identifying rData fields for that type.
 */
interface RecordIdentity {
  d: string;
  t: string;
  rd: Record<string, string>;
}

function encodeRecordId(idn: RecordIdentity): string {
  return Buffer.from(JSON.stringify(idn), 'utf8').toString('base64url');
}

function decodeRecordId(id: string): RecordIdentity | null {
  try {
    const obj = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
    if (obj && typeof obj.d === 'string' && typeof obj.t === 'string' && obj.rd) return obj as RecordIdentity;
  } catch {
    /* not a record id */
  }
  return null;
}

/** The identifying rData fields for a record of the given type (what update/delete need). */
function rdataIdentity(type: string, rd: Record<string, unknown>): Record<string, string> {
  const s = (k: string) => (rd[k] === undefined || rd[k] === null ? '' : String(rd[k]));
  switch (type) {
    case 'A':
    case 'AAAA':
      return { ipAddress: s('ipAddress') };
    case 'CNAME':
      return { cname: s('cname') };
    case 'TXT':
      return { text: s('text') };
    case 'NS':
      return { nameServer: s('nameServer') };
    case 'PTR':
      return { ptrName: s('ptrName') };
    case 'MX':
      return { preference: s('preference'), exchange: s('exchange') };
    case 'SRV':
      return { priority: s('priority'), weight: s('weight'), port: s('port'), target: s('target') };
    default:
      return {};
  }
}

/** A human-readable one-line value for a record (for the list + detail). */
function rdataDisplay(type: string, rd: Record<string, unknown>): string {
  const s = (k: string) => (rd[k] === undefined || rd[k] === null ? '' : String(rd[k]));
  switch (type) {
    case 'A':
    case 'AAAA':
      return s('ipAddress');
    case 'CNAME':
      return s('cname');
    case 'TXT':
      return s('text');
    case 'NS':
      return s('nameServer');
    case 'PTR':
      return s('ptrName');
    case 'MX':
      return `${s('preference')} ${s('exchange')}`.trim();
    case 'SRV':
      return `${s('priority')} ${s('weight')} ${s('port')} ${s('target')}`.trim();
    case 'SOA':
      return s('primaryNameServer');
    default:
      return JSON.stringify(rd);
  }
}

/** The main editable value for a record type (prefill for the edit form's `value` field). */
function rdataMainValue(type: string, rd: Record<string, string>): string {
  switch (type) {
    case 'A':
    case 'AAAA':
      return rd.ipAddress ?? '';
    case 'CNAME':
      return rd.cname ?? '';
    case 'TXT':
      return rd.text ?? '';
    case 'NS':
      return rd.nameServer ?? '';
    case 'PTR':
      return rd.ptrName ?? '';
    case 'MX':
      return rd.exchange ?? '';
    case 'SRV':
      return rd.target ?? '';
    default:
      return '';
  }
}

/**
 * Resolve a user-entered record name to the full domain Technitium wants. "@" or
 * blank → the zone itself; a name already ending in the zone → as-is; otherwise
 * it's taken as a label relative to the zone.
 */
function resolveDomain(zone: string, name: string): string {
  const n = (name ?? '').trim().replace(/\.$/, '');
  if (n === '' || n === '@') return zone;
  const lower = n.toLowerCase();
  const z = zone.toLowerCase();
  if (lower === z || lower.endsWith(`.${z}`)) return n;
  return `${n}.${zone}`;
}

/** Trim free-form detail items, dropping empty values so the drawer stays clean. */
function detailItems(pairs: [string, string | number | boolean | null | undefined][]): ConnectorDetailItem[] {
  const out: ConnectorDetailItem[] = [];
  for (const [label, value] of pairs) {
    if (value === undefined || value === null || value === '') continue;
    out.push({ label, value: String(value) });
  }
  return out;
}

/**
 * Technitium DNS Server connector (Phase 1 — read-only). Surfaces DNS zones,
 * DHCP scopes and leases, and the manually allowed/blocked domains, plus a
 * dashboard summary (query volume, block rate, clients, cache). Auth is a single
 * scoped API token (Bearer). The target is the user's own Technitium server, so
 * the base URL and an optional self-signed-TLS toggle are configurable.
 */
export class TechnitiumConnector implements Connector {
  manifest: ConnectorManifest = {
    id: 'technitium',
    name: 'Technitium DNS',
    description:
      'Monitor and manage a Technitium DNS Server — DNS zones and their records (add/edit/delete), DHCP scopes and leases, and the manually allowed/blocked domains (add/remove), with a dashboard summary of query volume, block rate, active clients, and cache. Enable, disable, or delete zones.',
    version: '0.3.0',
    icon: 'technitium',
    configFields: [
      {
        key: 'baseUrl',
        label: 'Server URL',
        type: 'url',
        required: true,
        placeholder: 'http://192.168.10.1:5380',
        help: 'The Technitium web console / API origin, including the port (default 5380).',
      },
      {
        key: 'apiToken',
        label: 'API token',
        type: 'password',
        secret: true,
        required: true,
        help: 'Administration → Sessions → Create API Token. A non-expiring token is recommended.',
      },
      {
        key: 'insecureSkipVerify',
        label: 'Accept self-signed certificate',
        type: 'boolean',
        required: false,
        default: false,
        help: 'Only if the server URL is HTTPS with a self-signed certificate.',
      },
    ],
    resourceKinds: KINDS,
    operations: OPERATIONS,
    help: {
      overview:
        'Monitor and manage your self-hosted Technitium DNS Server: authoritative DNS zones and their records (add, edit, delete), DHCP scopes and their active leases, and the domains you have manually allowed or blocked. The dashboard summary reports queries, how many were blocked, active clients, and cached entries over the last hour.',
      setupSteps: [
        'Open the Technitium web console (default http://<server>:5380) and sign in as an admin.',
        'Go to Administration → Sessions.',
        'Under "Create API Token", enter a name (e.g. "cerebro"), choose the admin user, and click Create.',
        'Copy the token value — it is shown only once — and paste it below, along with the server URL (including the port).',
      ],
      requiredPermissions: [
        'The token inherits the chosen user\'s permissions. An admin token works for everything.',
        'Minimum to view: Dashboard: View, Zones: View, DHCP: View.',
        'To manage records/zones: Zone: Modify (add/edit records, enable/disable) and Zone: Delete (delete records/zones).',
        'To manage allow/block lists: Allowed Zones and Blocked Zones: Modify.',
      ],
      referenceLinks: [
        { label: 'Technitium DNS Server', url: 'https://technitium.com/dns/' },
        { label: 'HTTP API documentation', url: 'https://github.com/TechnitiumSoftware/DnsServer/blob/master/APIDOCS.md' },
      ],
      notes:
        'The API token is sent as a Bearer token (required since Technitium v15). If your server uses HTTPS with a self-signed certificate, enable the "Accept self-signed certificate" option. Editing features need the matching Zone: Modify/Delete permissions on the token\'s user; without them those actions fail with a clear message while read-only views keep working. Record editing covers A, AAAA, CNAME, TXT, MX, NS, PTR, and SRV — other record types are shown read-only.',
    },
  };

  private authFrom(ctx: ConnectorContext): TechAuth {
    return {
      baseUrl: String(ctx.config.baseUrl ?? ''),
      apiToken: String(ctx.config.apiToken ?? ''),
      insecureSkipVerify: asBool(ctx.config.insecureSkipVerify),
    };
  }

  async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    const api = new TechnitiumApi(this.authFrom(ctx));
    try {
      const s = await api.getSession();
      const version = s.info?.version;
      ctx.log('info', `Technitium session verified${version ? ` (v${version})` : ''}.`);
      return {
        ok: true,
        message: version ? `Connected to Technitium DNS Server v${version}.` : 'Connected to Technitium DNS Server.',
        details: {
          ...(version ? { version } : {}),
          ...(s.username ? { user: s.username } : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed.';
      ctx.log('warn', `Technitium connection test failed: ${message}`);
      return { ok: false, message };
    }
  }

  async listResources(ctx: ConnectorContext, kind: string): Promise<ConnectorResource[]> {
    const api = new TechnitiumApi(this.authFrom(ctx));

    if (kind === ZONE_KIND) {
      const zones = await api.listZones();
      return zones
        .map((z) => this.zoneToResource(z))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    if (kind === DHCP_SCOPE_KIND) {
      const scopes = await api.listDhcpScopes();
      return scopes
        .map((s) => this.scopeToResource(s))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    if (kind === DHCP_LEASE_KIND) {
      const leases = await api.listDhcpLeases();
      return leases
        .map((l) => this.leaseToResource(l))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    if (kind === ALLOWED_KIND) {
      const tree = await api.listAllowed();
      return (tree.zones ?? [])
        .map((name) => this.allowBlockToResource(ALLOWED_KIND, name, 'allowed'))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    if (kind === BLOCKED_KIND) {
      const tree = await api.listBlocked();
      return (tree.zones ?? [])
        .map((name) => this.allowBlockToResource(BLOCKED_KIND, name, 'blocked'))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    return [];
  }

  async describeResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<ConnectorResourceDetail> {
    const api = new TechnitiumApi(this.authFrom(ctx));

    if (kind === ZONE_KIND) {
      const zones = await api.listZones();
      const z = zones.find((zz) => zz.name === resourceId);
      if (!z) throw new Error(`Zone "${resourceId}" not found.`);
      const r = this.zoneToResource(z);
      return {
        id: r.id,
        kind,
        name: r.name,
        status: r.status,
        groups: [
          {
            title: 'Zone',
            items: detailItems([
              ['Type', z.type],
              ['Status', z.disabled ? 'Disabled' : 'Active'],
              ['Internal', z.internal ? 'Yes' : 'No'],
              ['DNSSEC', z.dnssecStatus],
              ['SOA serial', z.soaSerial],
              ['Last modified', z.lastModified],
              ['Expiry', z.expiry],
              ['Expired', z.isExpired === undefined ? undefined : z.isExpired ? 'Yes' : 'No'],
              ['Sync failed', z.syncFailed ? 'Yes' : undefined],
              ['Notify failed', z.notifyFailed ? 'Yes' : undefined],
            ]),
          },
        ],
      };
    }

    if (kind === DHCP_SCOPE_KIND) {
      const scopes = await api.listDhcpScopes();
      const s = scopes.find((ss) => ss.name === resourceId);
      if (!s) throw new Error(`DHCP scope "${resourceId}" not found.`);
      const r = this.scopeToResource(s);
      return {
        id: r.id,
        kind,
        name: r.name,
        status: r.status,
        groups: [
          {
            title: 'DHCP Scope',
            items: detailItems([
              ['Status', s.enabled ? 'Enabled' : 'Disabled'],
              ['Range start', s.startingAddress],
              ['Range end', s.endingAddress],
              ['Subnet mask', s.subnetMask],
              ['Network', s.networkAddress],
              ['Broadcast', s.broadcastAddress],
            ]),
          },
        ],
      };
    }

    if (kind === DHCP_LEASE_KIND) {
      const leases = await api.listDhcpLeases();
      const l = leases.find((ll) => (ll.address || ll.hardwareAddress) === resourceId);
      if (!l) throw new Error(`DHCP lease "${resourceId}" not found.`);
      const r = this.leaseToResource(l);
      return {
        id: r.id,
        kind,
        name: r.name,
        status: r.status,
        groups: [
          {
            title: 'DHCP Lease',
            items: detailItems([
              ['Host name', l.hostName],
              ['IP address', l.address],
              ['MAC address', l.hardwareAddress],
              ['Type', l.type],
              ['Scope', l.scope],
              ['Client id', l.clientIdentifier],
              ['Obtained', l.leaseObtained],
              ['Expires', l.leaseExpires],
            ]),
          },
        ],
      };
    }

    // Allowed / blocked domains carry only their name.
    const label = kind === ALLOWED_KIND ? 'Allowed Domain' : 'Blocked Domain';
    return {
      id: resourceId,
      kind,
      name: resourceId,
      status: kind === ALLOWED_KIND ? 'allowed' : 'blocked',
      groups: [{ title: label, items: detailItems([['Domain', resourceId]]) }],
    };
  }

  async overview(ctx: ConnectorContext): Promise<ConnectorOverview> {
    const api = new TechnitiumApi(this.authFrom(ctx));
    const dash = await api.getDashboard('LastHour');
    const stats = dash.stats ?? {};

    const totalQueries = stats.totalQueries ?? 0;
    const totalBlocked = stats.totalBlocked ?? 0;
    const blockedPct = totalQueries > 0 ? Math.round((totalBlocked / totalQueries) * 100) : 0;

    // Count expired zones (best-effort — one extra local list call; never sinks the overview).
    // Drives the technitium.zones_expired alert (threshold defaults to 1).
    let zonesExpired = 0;
    try {
      const zones = await api.listZones();
      zonesExpired = zones.filter((z) => z.isExpired).length;
    } catch (err) {
      ctx.log('debug', `Technitium zone list for overview unavailable: ${err instanceof Error ? err.message : err}`);
    }

    const metrics: OverviewMetric[] = [
      { key: 'queries1h', label: 'Queries (1h)', value: totalQueries },
      { key: 'blocked1h', label: 'Blocked (1h)', value: totalBlocked },
      { key: 'blockedPct', label: 'Blocked', value: blockedPct, unit: '%' },
      { key: 'serverFailures1h', label: 'Server failures (1h)', value: stats.totalServerFailure ?? 0 },
      { key: 'clients1h', label: 'Clients (1h)', value: stats.totalClients ?? 0 },
      { key: 'zones', label: 'Zones', value: stats.zones ?? 0 },
      { key: 'zonesExpired', label: 'Zones expired', value: zonesExpired },
      { key: 'cachedEntries', label: 'Cached entries', value: stats.cachedEntries ?? 0 },
    ];

    // The live sample: the most active clients this hour (IP or reverse-resolved name).
    const guests = (dash.topClients ?? [])
      .slice(0, TOP_GUESTS)
      .map((c) => ({
        name: c.name || c.domain || 'unknown',
        kind: 'client',
        status: `${c.hits ?? 0} queries`,
        node: '',
      }));

    return { metrics, guests };
  }

  async performAction(ctx: ConnectorContext, kind: string, resourceId: string, actionId: string): Promise<{ ok: boolean; message: string }> {
    const api = new TechnitiumApi(this.authFrom(ctx));
    if (kind === ZONE_KIND && actionId === 'enable') {
      await api.enableZone(resourceId);
      return { ok: true, message: `Zone "${resourceId}" enabled.` };
    }
    if (kind === ZONE_KIND && actionId === 'disable') {
      await api.disableZone(resourceId);
      return { ok: true, message: `Zone "${resourceId}" disabled.` };
    }
    return { ok: false, message: `Unsupported action "${actionId}" for ${kind}.` };
  }

  async deleteResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<{ ok: boolean; message: string }> {
    const api = new TechnitiumApi(this.authFrom(ctx));
    if (kind === ZONE_KIND) {
      await api.deleteZone(resourceId);
      return { ok: true, message: `Zone "${resourceId}" deleted.` };
    }
    if (kind === ALLOWED_KIND) {
      await api.deleteAllowed(resourceId);
      return { ok: true, message: `"${resourceId}" removed from the allowed list.` };
    }
    if (kind === BLOCKED_KIND) {
      await api.deleteBlocked(resourceId);
      return { ok: true, message: `"${resourceId}" removed from the blocked list.` };
    }
    return { ok: false, message: `Deleting ${kind} is not supported.` };
  }

  async listSubResources(ctx: ConnectorContext, kind: string, resourceId: string, subKind: string): Promise<ConnectorResource[]> {
    if (kind !== ZONE_KIND || subKind !== RECORD_SUB) return [];
    const api = new TechnitiumApi(this.authFrom(ctx));
    const records = await api.getRecords(resourceId);
    return records
      .filter((r) => !HIDDEN_RECORD_TYPES.has((r.type || '').toUpperCase()))
      .map((r) => this.recordToResource(r))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async operationDefaults(
    ctx: ConnectorContext,
    operationId: string,
    _resourceId: string | undefined,
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (operationId !== 'edit-record') return {};
    const idn = decodeRecordId(String(values.record ?? ''));
    if (!idn) return {};
    const out: Record<string, unknown> = { value: rdataMainValue(idn.t, idn.rd) };
    if (idn.t === 'MX') out.preference = idn.rd.preference ?? '';
    if (idn.t === 'SRV') {
      out.priority = idn.rd.priority ?? '';
      out.weight = idn.rd.weight ?? '';
      out.port = idn.rd.port ?? '';
    }
    return out;
  }

  async runOperation(
    ctx: ConnectorContext,
    operationId: string,
    resourceId: string | undefined,
    values: Record<string, unknown>,
    _onProgress: OperationProgress,
  ): Promise<OperationResult> {
    const api = new TechnitiumApi(this.authFrom(ctx));

    if (operationId === 'add-allowed') {
      const domain = strOrUndef(values.domain);
      if (!domain) return { ok: false, message: 'A domain is required.' };
      await api.addAllowed(domain);
      return { ok: true, message: `Allowed "${domain}".`, createdResourceId: domain };
    }
    if (operationId === 'add-blocked') {
      const domain = strOrUndef(values.domain);
      if (!domain) return { ok: false, message: 'A domain is required.' };
      await api.addBlocked(domain);
      return { ok: true, message: `Blocked "${domain}".`, createdResourceId: domain };
    }

    // The remaining ops act on records within a zone (resourceId = the zone name).
    const zone = strOrUndef(resourceId);
    if (!zone) return { ok: false, message: 'No zone in context for this record operation.' };

    if (operationId === 'add-record') {
      const type = String(values.type ?? '').toUpperCase();
      const value = strOrUndef(values.value);
      if (!RECORD_TYPES.includes(type)) return { ok: false, message: `Unsupported record type "${type}".` };
      if (!value) return { ok: false, message: 'A value is required.' };
      const domain = resolveDomain(zone, String(values.name ?? ''));
      const params = this.buildRecordValueParams(type, value, values);
      if ('error' in params) return { ok: false, message: params.error };
      await api.addRecord({ domain, zone, type, ttl: numOrUndef(values.ttl) ?? '3600', ...params.params });
      return { ok: true, message: `Added ${type} record for ${domain}.` };
    }

    if (operationId === 'edit-record' || operationId === 'delete-record') {
      const idn = decodeRecordId(String(values.record ?? ''));
      if (!idn) return { ok: false, message: 'Could not identify the record to modify.' };

      if (operationId === 'delete-record') {
        await api.deleteRecord({ domain: idn.d, zone, type: idn.t, ...idn.rd });
        return { ok: true, message: `Deleted ${idn.t} record for ${idn.d}.` };
      }

      // edit: build update params from the decoded current rData + the new form values.
      const value = strOrUndef(values.value);
      if (!value) return { ok: false, message: 'A value is required.' };
      const upd = this.buildUpdateParams(idn, value, values);
      if ('error' in upd) return { ok: false, message: upd.error };
      await api.updateRecord({ domain: idn.d, zone, type: idn.t, ttl: numOrUndef(values.ttl) ?? '3600', ...upd.params });
      return { ok: true, message: `Updated ${idn.t} record for ${idn.d}.` };
    }

    return { ok: false, message: `Unsupported operation "${operationId}".` };
  }

  /** Build the value params for an ADD, given the type and the form's value/extra fields. */
  private buildRecordValueParams(
    type: string,
    value: string,
    values: Record<string, unknown>,
  ): { params: Record<string, string> } | { error: string } {
    switch (type) {
      case 'A':
      case 'AAAA':
        return { params: { ipAddress: value } };
      case 'CNAME':
        return { params: { cname: value } };
      case 'TXT':
        return { params: { text: value } };
      case 'NS':
        return { params: { nameServer: value } };
      case 'PTR':
        return { params: { ptrName: value } };
      case 'MX': {
        const preference = numOrUndef(values.preference);
        if (preference === undefined) return { error: 'MX records need a preference.' };
        return { params: { exchange: value, preference } };
      }
      case 'SRV': {
        const priority = numOrUndef(values.priority);
        const weight = numOrUndef(values.weight);
        const port = numOrUndef(values.port);
        if (priority === undefined || weight === undefined || port === undefined) {
          return { error: 'SRV records need priority, weight, and port.' };
        }
        return { params: { target: value, priority, weight, port } };
      }
      default:
        return { error: `Unsupported record type "${type}".` };
    }
  }

  /** Build the update params (current + new-prefixed) for an EDIT. */
  private buildUpdateParams(
    idn: RecordIdentity,
    value: string,
    values: Record<string, unknown>,
  ): { params: Record<string, string> } | { error: string } {
    const rd = idn.rd;
    switch (idn.t) {
      case 'A':
      case 'AAAA':
        return { params: { ipAddress: rd.ipAddress ?? '', newIpAddress: value } };
      case 'CNAME':
        // A name has at most one CNAME; setting `cname` replaces its target.
        return { params: { cname: value } };
      case 'TXT':
        return { params: { text: rd.text ?? '', newText: value } };
      case 'NS':
        return { params: { nameServer: rd.nameServer ?? '', newNameServer: value } };
      case 'PTR':
        return { params: { ptrName: rd.ptrName ?? '', newPtrName: value } };
      case 'MX': {
        const newPreference = numOrUndef(values.preference);
        if (newPreference === undefined) return { error: 'MX records need a preference.' };
        return {
          params: {
            preference: rd.preference ?? '1',
            exchange: rd.exchange ?? '',
            newPreference,
            newExchange: value,
          },
        };
      }
      case 'SRV': {
        const newPriority = numOrUndef(values.priority);
        const newWeight = numOrUndef(values.weight);
        const newPort = numOrUndef(values.port);
        if (newPriority === undefined || newWeight === undefined || newPort === undefined) {
          return { error: 'SRV records need priority, weight, and port.' };
        }
        return {
          params: {
            priority: rd.priority ?? '',
            weight: rd.weight ?? '',
            port: rd.port ?? '',
            target: rd.target ?? '',
            newPriority,
            newWeight,
            newPort,
            newTarget: value,
          },
        };
      }
      default:
        return { error: `Editing ${idn.t} records is not supported.` };
    }
  }

  // ── mappers ───────────────────────────────────────────────────────

  private recordToResource(r: TechRecord): ConnectorResource {
    const type = (r.type || '').toUpperCase();
    const rd = r.rData ?? {};
    const idn: RecordIdentity = { d: r.name, t: type, rd: rdataIdentity(type, rd) };
    // Only the types we can round-trip get a stable editable id; others get a display-only id.
    const editable = RECORD_TYPES.includes(type);
    return {
      id: editable ? encodeRecordId(idn) : `ro:${r.name}:${type}`,
      kind: RECORD_SUB,
      name: `${type} · ${r.name}`,
      status: r.disabled ? 'disabled' : 'active',
      tags: { type },
      details: {
        value: rdataDisplay(type, rd),
        ttl: r.ttl ?? null,
      },
    };
  }

  private zoneToResource(z: TechZone): ConnectorResource {
    const tags: Record<string, string> = {};
    if (z.type) tags.type = z.type;
    if (z.dnssecStatus && z.dnssecStatus !== 'Unsigned') tags.dnssec = z.dnssecStatus;
    if (z.internal) tags.internal = 'yes';
    return {
      id: z.name,
      kind: ZONE_KIND,
      name: z.name || '(root)',
      status: z.isExpired ? 'expired' : z.disabled ? 'disabled' : 'active',
      tags,
      details: {
        type: z.type ?? '',
        dnssec: z.dnssecStatus ?? '',
        soaSerial: z.soaSerial ?? null,
      },
    };
  }

  private scopeToResource(s: TechDhcpScope): ConnectorResource {
    const range = s.startingAddress && s.endingAddress ? `${s.startingAddress} – ${s.endingAddress}` : '';
    return {
      id: s.name,
      kind: DHCP_SCOPE_KIND,
      name: s.name,
      status: s.enabled ? 'enabled' : 'disabled',
      details: { range, subnet: s.subnetMask ?? '' },
    };
  }

  private leaseToResource(l: TechDhcpLease): ConnectorResource {
    const tags: Record<string, string> = {};
    if (l.scope) tags.scope = l.scope;
    if (l.type) tags.type = l.type;
    return {
      // Prefer IP as the stable id; fall back to MAC.
      id: l.address || l.hardwareAddress || l.hostName || 'lease',
      kind: DHCP_LEASE_KIND,
      name: strOrUndef(l.hostName) || l.address || l.hardwareAddress || 'lease',
      status: (l.type || 'dynamic').toLowerCase(),
      tags,
      details: {
        address: l.address ?? '',
        mac: l.hardwareAddress ?? '',
        expires: l.leaseExpires ?? '',
      },
    };
  }

  private allowBlockToResource(kind: string, name: string, status: string): ConnectorResource {
    return { id: name, kind, name, status };
  }
}
