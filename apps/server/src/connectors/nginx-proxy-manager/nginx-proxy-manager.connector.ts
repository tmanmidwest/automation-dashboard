import type {
  Connector,
  ConnectorContext,
  ConnectorManifest,
  ConnectorOperation,
  ConnectorOption,
  ConnectorResource,
  ConnectorResourceDetail,
  ConnectorResourceKind,
  ConnectorDetailItem,
  ConnectorOverview,
  OperationProgress,
  OperationResult,
  OverviewMetric,
  TestConnectionResult,
} from '@cerebro/shared';
import {
  NpmApi,
  NpmAuth,
  NpmProxyHost,
  NpmRedirectionHost,
  NpmStream,
  NpmDeadHost,
  NpmCertificate,
  NpmAccessList,
  NpmHostReport,
} from './npm-api';

const PROXY_KIND = 'proxy_host';
const REDIRECT_KIND = 'redirection_host';
const STREAM_KIND = 'stream';
const DEAD_KIND = 'dead_host';
const CERT_KIND = 'certificate';
const ACCESS_KIND = 'access_list';

/** Certificates within this many days count as "expiring" (tile + status). */
const CERT_EXPIRY_WINDOW_DAYS = 14;

/** API path segment for each host-like kind (used by enable/disable + delete). */
const SEGMENT: Record<string, string> = {
  [PROXY_KIND]: 'proxy-hosts',
  [REDIRECT_KIND]: 'redirection-hosts',
  [STREAM_KIND]: 'streams',
  [DEAD_KIND]: 'dead-hosts',
  [CERT_KIND]: 'certificates',
  [ACCESS_KIND]: 'access-lists',
};

/** enable/disable pair shared by the four host-like kinds. */
const HOST_TOGGLE = [
  { id: 'enable', label: 'Enable', mutating: true, showWhenStatus: ['disabled'] },
  { id: 'disable', label: 'Disable', mutating: true, intent: 'destructive' as const, confirm: 'Disable this host? It will stop serving until re-enabled.', showWhenStatus: ['online', 'error'] },
];

const KINDS: ConnectorResourceKind[] = [
  { id: PROXY_KIND, label: 'Proxy Hosts', deletable: true, actions: HOST_TOGGLE },
  { id: REDIRECT_KIND, label: 'Redirections', deletable: true, actions: HOST_TOGGLE },
  { id: STREAM_KIND, label: 'Streams', deletable: true, actions: HOST_TOGGLE },
  { id: DEAD_KIND, label: '404 Hosts', deletable: true, actions: HOST_TOGGLE },
  {
    id: CERT_KIND, label: 'Certificates', deletable: true,
    actions: [{ id: 'renew', label: 'Renew now', mutating: true, confirm: 'Renew this certificate now?' }],
  },
  { id: ACCESS_KIND, label: 'Access Lists', deletable: true, actions: [] },
];

/** Shared form fields for the create/edit proxy-host operations. */
const PROXY_FIELDS: ConnectorOperation['fields'] = [
  { key: 'domain_names', label: 'Domain names', type: 'textarea', required: true, placeholder: 'app.example.com\napi.example.com', help: 'One or more domains, separated by comma, space, or newline.' },
  { key: 'forward_scheme', label: 'Forward scheme', type: 'select', required: true, default: 'http', options: [{ label: 'http', value: 'http' }, { label: 'https', value: 'https' }] },
  { key: 'forward_host', label: 'Forward host', type: 'text', required: true, placeholder: '10.0.0.20' },
  { key: 'forward_port', label: 'Forward port', type: 'number', required: true, placeholder: '8080' },
  { key: 'certificate_id', label: 'SSL certificate', type: 'select', default: '0', optionsSource: 'npm-certs', help: 'Assign an existing certificate, or None for HTTP only.' },
  { key: 'ssl_forced', label: 'Force SSL (redirect HTTP→HTTPS)', type: 'boolean', default: false, help: 'Only applies when a certificate is selected.' },
  { key: 'block_exploits', label: 'Block common exploits', type: 'boolean', default: true },
  { key: 'allow_websocket_upgrade', label: 'Websockets support', type: 'boolean', default: true },
  { key: 'caching_enabled', label: 'Cache assets', type: 'boolean', default: false },
];

const OPERATIONS: ConnectorOperation[] = [
  {
    id: 'create-proxy-host',
    label: 'Add proxy host',
    description: 'Create a new proxy host that forwards a domain to an upstream server.',
    scope: 'create',
    kind: PROXY_KIND,
    icon: 'plus',
    submitLabel: 'Create host',
    fields: PROXY_FIELDS,
  },
  {
    id: 'edit-proxy-host',
    label: 'Edit proxy host',
    description: 'Change where this proxy host forwards and its options.',
    scope: 'resource',
    kind: PROXY_KIND,
    icon: 'pencil',
    submitLabel: 'Save',
    prefill: true,
    fields: PROXY_FIELDS,
  },
];

/**
 * Nginx Proxy Manager (jc21/NPM) connector. Lists proxy / redirection / stream /
 * 404 hosts, SSL certificates (with expiry status), and access lists, plus
 * overview tiles that flag disabled hosts, hosts NPM failed to bring online, and
 * certificates about to expire. Phase 2 adds writes: enable/disable a host,
 * renew a certificate, delete entities, and create/edit proxy hosts.
 * See docs/connectors/nginx-proxy-manager.md.
 */
export class NginxProxyManagerConnector implements Connector {
  manifest: ConnectorManifest = {
    id: 'nginx-proxy-manager',
    name: 'Nginx Proxy Manager',
    description:
      'Monitor and manage a self-hosted Nginx Proxy Manager: proxy hosts and where they forward, redirections, TCP/UDP streams, 404 hosts, access lists, and SSL certificates. Tiles flag disabled/errored hosts and certificates about to expire. Enable/disable hosts, renew certificates, and add or edit proxy hosts.',
    version: '0.2.0',
    icon: 'nginx-proxy-manager',
    configFields: [
      { key: 'baseUrl', label: 'Base URL', type: 'text', required: true, placeholder: 'http://10.0.0.5:81', help: 'Your NPM admin URL, including the port (admin defaults to 81).' },
      { key: 'identity', label: 'Email', type: 'text', required: true, placeholder: 'admin@example.com', help: 'The NPM login email. Managing hosts/certificates needs a user with the matching permissions.' },
      { key: 'secret', label: 'Password', type: 'password', secret: true, required: true, help: "The NPM user's password." },
      { key: 'insecureSkipVerify', label: 'Skip TLS verification (self-signed HTTPS)', type: 'boolean', required: false, default: false },
    ],
    resourceKinds: KINDS,
    operations: OPERATIONS,
    help: {
      overview:
        'Monitor and manage one Nginx Proxy Manager instance: every proxy host and its upstream, redirections, streams, 404 hosts, access lists, and SSL certificates. Tiles highlight disabled/errored hosts and certificates expiring within two weeks. Enable/disable hosts, renew certificates, and add/edit proxy hosts.',
      setupSteps: [
        'Point Base URL at your NPM admin UI, e.g. http://10.0.0.5:81 (NPM admin defaults to port 81).',
        'Enter the email and password of an NPM user. Any user can read the host/cert lists.',
        'Save — Cerebro logs in for a short-lived token automatically and refreshes it as needed.',
      ],
      notes:
        "NPM's API is the one its own web UI uses; jc21 labels it \"use at your own risk\" rather than a stability-contracted public API. It has been stable across releases in practice, and each kind degrades gracefully (an errored kind shows empty rather than failing the whole connector).",
      referenceLinks: [
        { label: 'Nginx Proxy Manager', url: 'https://nginxproxymanager.com/' },
      ],
    },
  };

  private apiFrom(ctx: ConnectorContext): NpmApi {
    const auth: NpmAuth = {
      baseUrl: String(ctx.config.baseUrl ?? ''),
      identity: String(ctx.config.identity ?? ''),
      secret: String(ctx.config.secret ?? ''),
      insecureSkipVerify: bool(ctx.config.insecureSkipVerify),
    };
    return new NpmApi(auth);
  }

  async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    const api = this.apiFrom(ctx);
    try {
      await api.ensureToken(); // proves the credentials
      const health = await api.health().catch(() => ({}));
      const version = versionString(health);
      ctx.log('info', `Nginx Proxy Manager reachable (v${version}).`);
      return {
        ok: true,
        message: `Connected to Nginx Proxy Manager${version !== '?' ? ` v${version}` : ''}.`,
        details: { version },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed.';
      ctx.log('warn', `Nginx Proxy Manager connection test failed: ${message}`);
      return { ok: false, message };
    }
  }

  async listResources(ctx: ConnectorContext, kind: string): Promise<ConnectorResource[]> {
    const api = this.apiFrom(ctx);

    if (kind === PROXY_KIND) {
      const hosts = await api.proxyHosts();
      return hosts.map((h) => proxyToResource(h)).sort(byName);
    }
    if (kind === REDIRECT_KIND) {
      const hosts = await api.redirectionHosts();
      return hosts.map((h) => redirectToResource(h)).sort(byName);
    }
    if (kind === STREAM_KIND) {
      const streams = await api.streams();
      return streams.map((s) => streamToResource(s)).sort(byName);
    }
    if (kind === DEAD_KIND) {
      const hosts = await api.deadHosts();
      return hosts.map((h) => deadToResource(h)).sort(byName);
    }
    if (kind === CERT_KIND) {
      const certs = await api.certificates();
      return certs.map((c) => certToResource(c)).sort(byName);
    }
    if (kind === ACCESS_KIND) {
      const lists = await api.accessLists();
      return lists.map((l) => accessToResource(l)).sort(byName);
    }
    return [];
  }

  async describeResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<ConnectorResourceDetail> {
    const list = await this.listResources(ctx, kind);
    const r = list.find((x) => x.id === resourceId);
    const items: ConnectorDetailItem[] = Object.entries(r?.details ?? {}).map(([k, v]) => ({
      label: labelize(k),
      value: String(v ?? '—'),
    }));
    return { id: resourceId, kind, name: r?.name ?? resourceId, status: r?.status, groups: [{ title: 'Details', items }] };
  }

  async performAction(ctx: ConnectorContext, kind: string, resourceId: string, actionId: string): Promise<{ ok: boolean; message: string }> {
    const api = this.apiFrom(ctx);
    try {
      if (kind === CERT_KIND && actionId === 'renew') {
        const certs = await api.certificates();
        const cert = certs.find((c) => String(c.id) === resourceId);
        if (cert && cert.provider !== 'letsencrypt') {
          return { ok: false, message: 'Only Let’s Encrypt certificates can be renewed here — custom certificates must be re-uploaded in NPM.' };
        }
        await api.renewCertificate(resourceId);
        ctx.log('info', `NPM certificate ${resourceId} renewal requested.`);
        return { ok: true, message: 'Certificate renewal requested.' };
      }

      const segment = SEGMENT[kind];
      if (segment && (actionId === 'enable' || actionId === 'disable')) {
        const enable = actionId === 'enable';
        await api.setHostEnabled(segment, resourceId, enable);
        ctx.log('info', `NPM ${kind} ${resourceId} ${enable ? 'enabled' : 'disabled'}.`);
        return { ok: true, message: `Host ${enable ? 'enabled' : 'disabled'}.` };
      }

      return { ok: false, message: `Unsupported action "${actionId}".` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action failed.';
      ctx.log('error', `NPM ${kind} ${actionId} failed: ${message}`);
      return { ok: false, message };
    }
  }

  async deleteResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<{ ok: boolean; message: string }> {
    const segment = SEGMENT[kind];
    if (!segment) return { ok: false, message: `${kind} resources can't be deleted.` };
    const api = this.apiFrom(ctx);
    try {
      await api.deleteEntity(segment, resourceId);
      ctx.log('info', `NPM ${kind} ${resourceId} deleted.`);
      return { ok: true, message: 'Deleted.' };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Delete failed.';
      ctx.log('error', `NPM delete ${kind} ${resourceId} failed: ${message}`);
      return { ok: false, message };
    }
  }

  async resolveOptions(ctx: ConnectorContext, sourceId: string): Promise<ConnectorOption[]> {
    if (sourceId === 'npm-certs') {
      const api = this.apiFrom(ctx);
      const certs = await api.certificates().catch(() => [] as NpmCertificate[]);
      const opts = certs
        .slice()
        .sort((a, b) => (a.nice_name || '').localeCompare(b.nice_name || ''))
        .map((c) => ({
          label: `${c.nice_name || primaryDomain(c.domain_names)}${c.provider === 'letsencrypt' ? " (Let's Encrypt)" : ''}`,
          value: String(c.id),
        }));
      return [{ label: 'None (HTTP only)', value: '0' }, ...opts];
    }
    return [];
  }

  async operationDefaults(ctx: ConnectorContext, operationId: string, resourceId: string | undefined): Promise<Record<string, unknown>> {
    if (operationId === 'edit-proxy-host' && resourceId) {
      const api = this.apiFrom(ctx);
      const h = await api.proxyHost(resourceId);
      return {
        domain_names: (h.domain_names ?? []).join(', '),
        forward_scheme: h.forward_scheme ?? 'http',
        forward_host: h.forward_host ?? '',
        forward_port: h.forward_port ?? undefined,
        certificate_id: String(h.certificate_id ?? 0),
        ssl_forced: !!h.ssl_forced,
        block_exploits: !!h.block_exploits,
        allow_websocket_upgrade: !!h.allow_websocket_upgrade,
        caching_enabled: !!h.caching_enabled,
      };
    }
    return {};
  }

  async runOperation(ctx: ConnectorContext, operationId: string, resourceId: string | undefined, values: Record<string, unknown>, onProgress: OperationProgress): Promise<OperationResult> {
    const api = this.apiFrom(ctx);
    try {
      if (operationId === 'create-proxy-host' || operationId === 'edit-proxy-host') {
        const domains = parseDomains(values.domain_names);
        if (domains.length === 0) return { ok: false, message: 'At least one domain name is required.' };
        const forwardHost = String(values.forward_host ?? '').trim();
        const forwardPort = num(values.forward_port);
        if (!forwardHost) return { ok: false, message: 'A forward host is required.' };
        if (!forwardPort) return { ok: false, message: 'A valid forward port is required.' };

        const certificateId = num(values.certificate_id);
        // Force-SSL only makes sense with a certificate attached.
        const sslForced = certificateId > 0 && bool(values.ssl_forced);

        const fields = {
          domain_names: domains,
          forward_scheme: values.forward_scheme === 'https' ? 'https' : 'http',
          forward_host: forwardHost,
          forward_port: forwardPort,
          certificate_id: certificateId,
          ssl_forced: sslForced,
          block_exploits: bool(values.block_exploits),
          allow_websocket_upgrade: bool(values.allow_websocket_upgrade),
          caching_enabled: bool(values.caching_enabled),
        };

        if (operationId === 'create-proxy-host') {
          onProgress(`Creating proxy host ${domains[0]}…`);
          const created = await api.createProxyHost({
            hsts_enabled: false,
            hsts_subdomains: false,
            http2_support: certificateId > 0,
            access_list_id: 0,
            advanced_config: '',
            locations: [],
            meta: { letsencrypt_agree: false, dns_challenge: false },
            enabled: true,
            ...fields,
          });
          ctx.log('info', `NPM proxy host ${domains[0]} created (#${created.id}).`);
          return { ok: true, message: `Created proxy host ${domains[0]}.`, createdResourceId: String(created.id) };
        }

        // Edit: read the existing host and merge, so fields we don't expose
        // (HSTS, HTTP/2, access list, advanced config, locations) are preserved.
        if (!resourceId) return { ok: false, message: 'No target host.' };
        const existing = await api.proxyHost(resourceId);
        onProgress(`Saving proxy host ${domains[0]}…`);
        await api.updateProxyHost(resourceId, {
          ...pickEditable(existing),
          ...fields,
          // Dropping the certificate must also drop force-SSL.
          ...(certificateId === 0 ? { ssl_forced: false } : {}),
        });
        ctx.log('info', `NPM proxy host #${resourceId} updated.`);
        return { ok: true, message: 'Proxy host updated.' };
      }

      return { ok: false, message: `Unknown operation "${operationId}".` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Operation failed.';
      ctx.log('error', `NPM operation ${operationId} failed: ${message}`);
      return { ok: false, message };
    }
  }

  async overview(ctx: ConnectorContext): Promise<ConnectorOverview> {
    const api = this.apiFrom(ctx);
    const [report, proxyHosts, certs] = await Promise.all([
      api.hostReport().catch(() => ({}) as NpmHostReport),
      api.proxyHosts().catch(() => [] as NpmProxyHost[]),
      api.certificates().catch(() => [] as NpmCertificate[]),
    ]);

    const disabled = proxyHosts.filter((h) => !h.enabled).length;
    const errored = proxyHosts.filter((h) => h.meta?.nginx_online === false).length;
    const expiring = certs.filter((c) => certStatus(c) === 'expiring' || certStatus(c) === 'expired').length;

    const metrics: OverviewMetric[] = [
      { key: 'proxyHosts', label: 'Proxy hosts', value: num(report.proxy) || proxyHosts.length },
      { key: 'disabledHosts', label: 'Disabled', value: disabled },
      { key: 'erroredHosts', label: 'Errored', value: errored },
      { key: 'certificates', label: 'Certificates', value: certs.length },
      { key: 'certsExpiring', label: 'Expiring ≤14d', value: expiring },
      { key: 'streams', label: 'Streams', value: num(report.stream) },
      { key: 'redirections', label: 'Redirections', value: num(report.redirection) },
    ];

    const guests = proxyHosts
      .slice()
      .sort((a, b) => primaryDomain(a.domain_names).localeCompare(primaryDomain(b.domain_names)))
      .slice(0, 40)
      .map((h) => ({
        name: primaryDomain(h.domain_names),
        kind: PROXY_KIND,
        status: hostStatus(h.enabled, h.meta?.nginx_online),
        node: `${h.forward_scheme ?? 'http'}://${h.forward_host ?? '?'}:${h.forward_port ?? '?'}`,
      }));

    return { metrics, guests };
  }
}

// ── Mappers ───────────────────────────────────────────────────────

function proxyToResource(h: NpmProxyHost): ConnectorResource {
  const status = hostStatus(h.enabled, h.meta?.nginx_online);
  return {
    id: String(h.id),
    kind: PROXY_KIND,
    name: primaryDomain(h.domain_names),
    status,
    details: {
      domains: (h.domain_names ?? []).join(', ') || '—',
      forward: `${h.forward_scheme ?? 'http'}://${h.forward_host ?? '?'}:${h.forward_port ?? '?'}`,
      ssl: h.certificate_id ? (h.ssl_forced ? 'Forced' : 'Enabled') : 'Off',
      websockets: yesNo(h.allow_websocket_upgrade),
      block_exploits: yesNo(h.block_exploits),
      caching: yesNo(h.caching_enabled),
      access_list: h.access_list_id ? `#${h.access_list_id}` : 'Public',
      enabled: yesNo(h.enabled),
      ...(h.meta?.nginx_err ? { nginx_error: h.meta.nginx_err } : {}),
    },
    tags: { status, ssl: h.certificate_id ? 'yes' : 'no' },
  };
}

function redirectToResource(h: NpmRedirectionHost): ConnectorResource {
  const status = hostStatus(h.enabled, h.meta?.nginx_online);
  const scheme = h.forward_scheme && h.forward_scheme !== 'auto' ? `${h.forward_scheme}://` : '';
  return {
    id: String(h.id),
    kind: REDIRECT_KIND,
    name: primaryDomain(h.domain_names),
    status,
    details: {
      domains: (h.domain_names ?? []).join(', ') || '—',
      target: `${scheme}${h.forward_domain_name ?? '?'}`,
      http_code: String(h.forward_http_code ?? '—'),
      ssl: h.certificate_id ? (h.ssl_forced ? 'Forced' : 'Enabled') : 'Off',
      enabled: yesNo(h.enabled),
    },
    tags: { status },
  };
}

function streamToResource(s: NpmStream): ConnectorResource {
  const status = hostStatus(s.enabled, s.meta?.nginx_online);
  const protocols = [s.tcp_forwarding ? 'TCP' : null, s.udp_forwarding ? 'UDP' : null].filter(Boolean).join('/') || '—';
  return {
    id: String(s.id),
    kind: STREAM_KIND,
    name: `:${s.incoming_port ?? '?'} → ${s.forwarding_host ?? '?'}:${s.forwarding_port ?? '?'}`,
    status,
    details: {
      incoming_port: String(s.incoming_port ?? '—'),
      forward: `${s.forwarding_host ?? '?'}:${s.forwarding_port ?? '?'}`,
      protocol: protocols,
      enabled: yesNo(s.enabled),
    },
    tags: { status, protocol: protocols },
  };
}

function deadToResource(h: NpmDeadHost): ConnectorResource {
  const status = hostStatus(h.enabled, h.meta?.nginx_online);
  return {
    id: String(h.id),
    kind: DEAD_KIND,
    name: primaryDomain(h.domain_names),
    status,
    details: {
      domains: (h.domain_names ?? []).join(', ') || '—',
      ssl: h.certificate_id ? 'Enabled' : 'Off',
      enabled: yesNo(h.enabled),
    },
    tags: { status },
  };
}

function certToResource(c: NpmCertificate): ConnectorResource {
  const status = certStatus(c);
  const days = daysUntil(c.expires_on);
  return {
    id: String(c.id),
    kind: CERT_KIND,
    name: c.nice_name || primaryDomain(c.domain_names),
    status,
    details: {
      provider: c.provider === 'letsencrypt' ? "Let's Encrypt" : c.provider === 'other' ? 'Custom' : (c.provider ?? '—'),
      domains: (c.domain_names ?? []).join(', ') || '—',
      expires_on: fmtDate(c.expires_on),
      expires_in: days === null ? '—' : days < 0 ? `${Math.abs(days)}d ago` : `${days}d`,
    },
    tags: { status, provider: c.provider ?? 'unknown' },
  };
}

function accessToResource(l: NpmAccessList): ConnectorResource {
  return {
    id: String(l.id),
    kind: ACCESS_KIND,
    name: l.name || `Access list #${l.id}`,
    status: 'active',
    details: {
      auth_users: String((l.items ?? []).length),
      client_rules: String((l.clients ?? []).length),
      satisfy: l.satisfy_any ? 'Any' : 'All',
      pass_auth: yesNo(l.pass_auth),
      used_by_hosts: String(l.proxy_host_count ?? 0),
    },
    tags: {},
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function hostStatus(enabled: number | undefined, nginxOnline: boolean | undefined): string {
  if (!enabled) return 'disabled';
  if (nginxOnline === false) return 'error';
  return 'online';
}

function certStatus(c: NpmCertificate): 'valid' | 'expiring' | 'expired' {
  const days = daysUntil(c.expires_on);
  if (days === null) return 'valid';
  if (days < 0) return 'expired';
  if (days <= CERT_EXPIRY_WINDOW_DAYS) return 'expiring';
  return 'valid';
}

function daysUntil(iso?: string): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return Math.floor((then - Date.now()) / 86_400_000);
}

function primaryDomain(domains?: string[]): string {
  return domains?.[0] ?? 'host';
}

/** Split the domains textarea on comma / whitespace / newline into a clean list. */
function parseDomains(v: unknown): string[] {
  return String(v ?? '')
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter(Boolean);
}

/**
 * The editable fields NPM's PUT expects, carried forward from the existing host
 * so options we don't surface in the form survive an edit. Booleans come back
 * from the GET as 0/1 and are coerced for the write body.
 */
function pickEditable(h: NpmProxyHost): Record<string, unknown> {
  return {
    domain_names: h.domain_names ?? [],
    forward_scheme: h.forward_scheme ?? 'http',
    forward_host: h.forward_host ?? '',
    forward_port: h.forward_port ?? 80,
    certificate_id: h.certificate_id ?? 0,
    ssl_forced: !!h.ssl_forced,
    hsts_enabled: !!(h as { hsts_enabled?: number }).hsts_enabled,
    hsts_subdomains: !!(h as { hsts_subdomains?: number }).hsts_subdomains,
    http2_support: !!h.http2_support,
    block_exploits: !!h.block_exploits,
    caching_enabled: !!h.caching_enabled,
    allow_websocket_upgrade: !!h.allow_websocket_upgrade,
    access_list_id: h.access_list_id ?? 0,
    advanced_config: (h as { advanced_config?: string }).advanced_config ?? '',
    locations: (h as { locations?: unknown[] }).locations ?? [],
    meta: (h as { meta?: Record<string, unknown> }).meta ?? {},
  };
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : iso;
}

function versionString(h: { version?: { major?: number; minor?: number; revision?: number } }): string {
  const v = h.version;
  if (!v || v.major === undefined) return '?';
  return [v.major, v.minor, v.revision].filter((n) => n !== undefined).join('.');
}

function byName(a: ConnectorResource, b: ConnectorResource): number {
  return a.name.localeCompare(b.name);
}

function labelize(k: string): string {
  return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function yesNo(v: number | undefined): string {
  return v ? 'Yes' : 'No';
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
}
