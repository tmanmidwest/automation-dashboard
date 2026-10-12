/**
 * O365 (Microsoft 365) connector — read-only (P1). Admin & security signals via
 * Microsoft Graph, NOT infrastructure: service health, Message Center posts,
 * user & license inventory, and Secure Score. Auth is a Microsoft Entra app
 * registration using **application** permissions with **tenant admin consent**
 * (not delegated) — see the shared Entra helper. docs/azure-o365-connectors.md.
 *
 * Mailbox/file CONTENT is deliberately out of scope. High-blast-radius writes
 * (reset password, disable account, revoke sessions, assign license) are a later,
 * RBAC- + confirmation-gated phase; every resource kind here ships with no actions.
 */
import type {
  Connector,
  ConnectorContext,
  ConnectorManifest,
  ConnectorOverview,
  ConnectorResource,
  ConnectorResourceDetail,
  ConnectorResourceKind,
  OverviewMetric,
  TestConnectionResult,
} from '@cerebro/shared';
import { GraphApi, GraphSku } from './graph-api';
import { EntraCloud, EntraCreds, EntraError } from '../entra/entra-auth';

const HEALTH_KIND = 'service_health';
const ISSUE_KIND = 'service_issue';
const MESSAGE_KIND = 'message_center';
const USER_KIND = 'user';
const LICENSE_KIND = 'license';

const KINDS: ConnectorResourceKind[] = [
  { id: HEALTH_KIND, label: 'Service health', actions: [], deletable: false },
  { id: ISSUE_KIND, label: 'Service issues', actions: [], deletable: false },
  { id: MESSAGE_KIND, label: 'Message Center', actions: [], deletable: false },
  { id: USER_KIND, label: 'Users', actions: [], deletable: false },
  { id: LICENSE_KIND, label: 'Licenses', actions: [], deletable: false },
];

/** Graph health status values that are NOT fully operational. */
const UNHEALTHY = new Set(['serviceDegradation', 'serviceInterruption', 'extendedRecovery', 'investigating', 'restoringService', 'verifyingService']);

function str(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
}

export class O365Connector implements Connector {
  manifest: ConnectorManifest = {
    id: 'o365',
    name: 'Microsoft 365',
    description:
      'Monitor a Microsoft 365 tenant via Microsoft Graph: service health, Message Center posts, user & license inventory, ' +
      'and Secure Score. Read-only, admin/security signals (not mailbox content); sign-in uses a Microsoft Entra app registration with admin consent.',
    icon: 'o365',
    version: '0.1.0',
    configFields: [
      {
        key: 'tenantId',
        label: 'Directory (tenant) ID',
        type: 'text',
        required: true,
        placeholder: '00000000-0000-0000-0000-000000000000',
        help: 'Entra ID → the app registration\'s Overview blade → "Directory (tenant) ID".',
      },
      {
        key: 'clientId',
        label: 'Application (client) ID',
        type: 'text',
        required: true,
        placeholder: '00000000-0000-0000-0000-000000000000',
        help: 'The same Overview blade → "Application (client) ID".',
      },
      {
        key: 'clientSecret',
        label: 'Client secret',
        type: 'password',
        secret: true,
        required: true,
        help: 'The secret VALUE (not its ID) from the app registration → Certificates & secrets → New client secret. Copy it when created — Microsoft hides it afterwards. Stored encrypted in the vault.',
      },
      {
        key: 'cloud',
        label: 'Microsoft cloud',
        type: 'select',
        required: false,
        default: 'public',
        options: [
          { label: 'Microsoft 365 public', value: 'public' },
          { label: 'US Gov (GCC High / DoD)', value: 'usgov' },
          { label: 'Office 365 China (21Vianet)', value: 'china' },
        ],
        help: 'Which Microsoft cloud the tenant lives in — picks the login + Graph endpoints. Almost always "public".',
      },
    ],
    resourceKinds: KINDS,
    help: {
      overview:
        'Read-only admin & security visibility into a Microsoft 365 tenant through Microsoft Graph: service health and active issues, ' +
        'Message Center posts, user and license inventory, and Secure Score. Authentication is a Microsoft Entra (Azure AD) app registration ' +
        'using application permissions with tenant admin consent — the same auth foundation the Azure connector uses. Mailbox and file content ' +
        'are intentionally never read.',
      setupSteps: [
        'Azure portal → Microsoft Entra ID → App registrations → New registration. Name it e.g. "Cerebro – Microsoft 365 (read-only)", single-tenant. Create it.',
        'On its Overview, copy the Directory (tenant) ID and Application (client) ID into the fields below.',
        'Certificates & secrets → New client secret → copy the secret VALUE immediately into "Client secret" below (you cannot read it again).',
        'API permissions → Add a permission → Microsoft Graph → APPLICATION permissions. Add exactly the read scopes listed under "Required permissions" below.',
        'Still on API permissions, click "Grant admin consent for <tenant>". Without this the connector authenticates but every data call returns 403. This needs a Global Administrator (or Privileged Role Admin).',
      ],
      requiredPermissions: [
        'Microsoft Graph APPLICATION permissions (not delegated), each needing tenant admin consent:',
        'ServiceHealth.Read.All — service health overviews and active issues.',
        'ServiceMessage.Read.All — Message Center posts.',
        'User.Read.All — user inventory and account-enabled state.',
        'Organization.Read.All — tenant name and subscribed SKUs (license inventory).',
        'SecurityEvents.Read.All — Secure Score.',
        'None of these can read mailbox or file content; this connector requests no Mail.*, Files.* or Sites.* scopes.',
      ],
      referenceLinks: [
        { label: 'Register an app with Microsoft Entra ID', url: 'https://learn.microsoft.com/entra/identity-platform/quickstart-register-app' },
        { label: 'Grant tenant-wide admin consent', url: 'https://learn.microsoft.com/entra/identity/enterprise-apps/grant-admin-consent' },
        { label: 'Microsoft Graph service health API', url: 'https://learn.microsoft.com/graph/api/resources/service-communications-api-overview' },
      ],
      notes:
        'Admin consent is the step most people miss — a 403 on every call means consent was not granted (or a scope is missing). Keep the app ' +
        'least-privilege: only the read scopes above. Client secrets expire — rotate before expiry or move to certificate auth (a planned follow-up). ' +
        'Account/password writes are intentionally not in this version and will be gated behind confirmation + RBAC when added.',
    },
  };

  private credsFrom(ctx: ConnectorContext): EntraCreds {
    return {
      tenantId: String(ctx.config.tenantId ?? ''),
      clientId: String(ctx.config.clientId ?? ''),
      clientSecret: String(ctx.config.clientSecret ?? ''),
      cloud: (str(ctx.config.cloud) as EntraCloud | undefined) ?? 'public',
    };
  }

  private apiFrom(ctx: ConnectorContext): GraphApi {
    return new GraphApi(this.credsFrom(ctx));
  }

  async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    try {
      const api = this.apiFrom(ctx);
      // authHeader → token fetch validates the client credentials. probeOrg then tells us
      // whether admin consent has been granted (200) or is still missing (403).
      const probe = await api.probeOrg();
      if (probe.status >= 200 && probe.status < 300) {
        return { ok: true, message: `Connected to ${probe.name ?? 'the Microsoft 365 tenant'}.`, details: probe.name ? { tenant: probe.name } : undefined };
      }
      if (probe.status === 403) {
        return { ok: true, message: 'Authenticated, but Graph returned 403 — grant tenant admin consent and add the read permissions (see the setup help).' };
      }
      return { ok: false, message: `Microsoft Graph returned HTTP ${probe.status}.` };
    } catch (e) {
      return { ok: false, message: e instanceof EntraError ? e.message : (e as Error).message };
    }
  }

  async listResources(ctx: ConnectorContext, kind: string): Promise<ConnectorResource[]> {
    const api = this.apiFrom(ctx);
    switch (kind) {
      case HEALTH_KIND:
        return (await api.listServiceHealth()).map((h) => ({
          id: h.service,
          kind,
          name: h.service,
          status: UNHEALTHY.has(h.status) ? h.status : 'operational',
          details: { status: h.status },
        }));
      case ISSUE_KIND:
        return (await api.listServiceIssues()).map((i) => ({
          id: i.id,
          kind,
          name: i.title,
          status: i.status,
          details: {
            service: i.service,
            classification: i.classification ?? '—',
            feature: i.feature ?? '—',
            started: i.startDateTime ?? '—',
            updated: i.lastModifiedDateTime ?? '—',
          },
          tags: i.classification ? { classification: i.classification } : undefined,
        }));
      case MESSAGE_KIND:
        return (await api.listMessages()).map((m) => ({
          id: m.id,
          kind,
          name: m.title,
          status: m.category,
          details: {
            services: (m.services ?? []).join(', ') || '—',
            category: m.category ?? '—',
            updated: m.lastModifiedDateTime ?? '—',
          },
        }));
      case USER_KIND:
        return (await api.listUsers()).map((u) => ({
          id: u.id,
          kind,
          name: u.displayName || u.userPrincipalName || u.id,
          status: u.accountEnabled === false ? 'disabled' : 'enabled',
          details: {
            upn: u.userPrincipalName ?? '—',
            licenses: u.assignedLicenseCount,
            enabled: u.accountEnabled ?? true,
          },
        }));
      case LICENSE_KIND:
        return (await api.listSkus()).map((s) => ({
          id: s.skuId,
          kind,
          name: s.skuPartNumber,
          status: `${s.consumedUnits}/${s.enabledUnits}`,
          details: { assigned: s.consumedUnits, total: s.enabledUnits, available: Math.max(s.enabledUnits - s.consumedUnits, 0) },
        }));
      default:
        return [];
    }
  }

  async describeResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<ConnectorResourceDetail> {
    const list = await this.listResources(ctx, kind);
    const r = list.find((x) => x.id === resourceId);
    const name = r?.name ?? resourceId;
    const items = Object.entries(r?.details ?? {}).map(([label, value]) => ({ label, value: String(value) }));
    return {
      id: resourceId,
      kind,
      name,
      status: r?.status,
      groups: [{ title: 'Details', items: items.length ? items : [{ label: 'id', value: resourceId }] }],
    };
  }

  async performAction(): Promise<{ ok: boolean; message: string }> {
    return { ok: false, message: 'The Microsoft 365 connector is read-only in this version.' };
  }

  async overview(ctx: ConnectorContext): Promise<ConnectorOverview> {
    const api = this.apiFrom(ctx);
    const [health, issues, users, score, skus] = await Promise.all([
      api.listServiceHealth().catch(() => []),
      api.listServiceIssues().catch(() => []),
      api.listUsers().catch(() => []),
      api.getSecureScore().catch(() => null),
      api.listSkus().catch((): GraphSku[] => []),
    ]);
    const degraded = health.filter((h) => UNHEALTHY.has(h.status));
    const activeIssues = issues.filter((i) => i.status !== 'serviceRestored' && i.status !== 'resolved');
    // License headroom = unassigned seats across all subscribed SKUs (total enabled − consumed).
    const licenseHeadroom = skus.reduce((sum, s) => sum + Math.max(s.enabledUnits - s.consumedUnits, 0), 0);
    const metrics: OverviewMetric[] = [
      { key: 'services_degraded', label: 'Services degraded', value: degraded.length },
      { key: 'active_issues', label: 'Active issues', value: activeIssues.length },
      { key: 'users', label: 'Users', value: users.length },
    ];
    if (score) metrics.push({ key: 'secure_score', label: 'Secure Score', value: score.percentage, unit: '%' });
    if (skus.length) metrics.push({ key: 'license_headroom', label: 'Licenses available', value: licenseHeadroom });
    return {
      metrics,
      guests: health.map((h) => ({
        name: h.service,
        kind: HEALTH_KIND,
        status: UNHEALTHY.has(h.status) ? h.status : 'operational',
        node: 'Microsoft 365',
      })).slice(0, 40),
    };
  }
}
