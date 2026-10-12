/**
 * Azure connector — read-only (P1). Monitors an Azure tenant via Azure Resource
 * Manager (ARM): subscriptions, resource groups, virtual machines (with power
 * state), App Services / Functions, and storage accounts. Auth is a Microsoft
 * Entra app registration (client credentials) with at least the built-in Reader
 * role — see the shared Entra helper. docs/azure-o365-connectors.md.
 *
 * Writes (start/stop/deallocate a VM, restart an App Service, …) are a later,
 * RBAC-gated phase; every resource kind here ships with no actions.
 */
import type {
  Connector,
  ConnectorContext,
  ConnectorManifest,
  ConnectorOverview,
  ConnectorResource,
  ConnectorResourceDetail,
  ConnectorResourceKind,
  TestConnectionResult,
} from '@cerebro/shared';
import { AzureApi, AzSite, AzStorageAccount, AzVm } from './azure-api';
import { EntraCloud, EntraCreds, EntraError } from '../entra/entra-auth';

const SUB_KIND = 'subscription';
const RG_KIND = 'resource_group';
const VM_KIND = 'vm';
const APP_KIND = 'app_service';
const STORAGE_KIND = 'storage_account';

/** VM power states that count as "on" for the overview. */
const VM_RUNNING = 'running';

const KINDS: ConnectorResourceKind[] = [
  { id: SUB_KIND, label: 'Subscriptions', actions: [], deletable: false },
  { id: RG_KIND, label: 'Resource groups', actions: [], deletable: false },
  { id: VM_KIND, label: 'Virtual machines', category: 'vm', actions: [], deletable: false },
  { id: APP_KIND, label: 'App Services', actions: [], deletable: false },
  { id: STORAGE_KIND, label: 'Storage accounts', actions: [], deletable: false },
];

function str(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
}

export class AzureConnector implements Connector {
  manifest: ConnectorManifest = {
    id: 'azure',
    name: 'Azure',
    description:
      'Monitor Microsoft Azure via Azure Resource Manager: subscriptions, resource groups, virtual machines (with power state), ' +
      'App Services / Functions, and storage accounts. Read-only; sign-in uses a Microsoft Entra app registration with the Reader role.',
    icon: 'azure',
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
        help: 'The secret VALUE (not its ID) from the app registration → Certificates & secrets → New client secret. Copy it when created — Azure hides it afterwards. Stored encrypted in the vault.',
      },
      {
        key: 'subscriptionId',
        label: 'Subscription ID (optional)',
        type: 'text',
        required: false,
        placeholder: 'leave blank for all readable subscriptions',
        help: 'Scope this connector to one subscription. Blank = every subscription the app registration can read.',
      },
      {
        key: 'cloud',
        label: 'Azure cloud',
        type: 'select',
        required: false,
        default: 'public',
        options: [
          { label: 'Azure public', value: 'public' },
          { label: 'Azure US Gov', value: 'usgov' },
          { label: 'Azure China (21Vianet)', value: 'china' },
        ],
        help: 'Which Azure cloud the tenant lives in — picks the login + ARM endpoints. Almost always "Azure public".',
      },
    ],
    resourceKinds: KINDS,
    help: {
      overview:
        'Read-only visibility into an Azure tenant through Azure Resource Manager (ARM). Lists subscriptions, resource groups, ' +
        'virtual machines with their power state, App Services / Functions, and storage accounts. Authentication is a Microsoft ' +
        'Entra (Azure AD) app registration using the OAuth2 client-credentials grant — the same foundation the O365 connector uses.',
      setupSteps: [
        'In the Azure portal → Microsoft Entra ID → App registrations → New registration. Name it e.g. "Cerebro – Azure (read-only)", single-tenant. Create it.',
        'On its Overview, copy the Directory (tenant) ID and the Application (client) ID into the fields below.',
        'Go to Certificates & secrets → New client secret. Copy the secret VALUE immediately and paste it into "Client secret" below (you cannot read it again later).',
        'Grant it read access: in each subscription (or a management group) → Access control (IAM) → Add role assignment → Role "Reader" → assign to this app registration. This is Azure RBAC, not Entra API permissions.',
        'Leave "Subscription ID" blank to monitor every subscription the Reader role covers, or set it to pin one.',
      ],
      requiredPermissions: [
        'Azure RBAC: the built-in "Reader" role on each subscription (or a parent management group) you want visible. No ARM write roles are needed for this connector.',
        'No Microsoft Graph API permissions are required for Azure — Graph is only used by the separate O365 connector.',
        'The client secret is used solely to obtain a token from login.microsoftonline.com; it is stored encrypted in the Cerebro vault and never returned to the browser.',
      ],
      referenceLinks: [
        { label: 'Register an app with Microsoft Entra ID', url: 'https://learn.microsoft.com/entra/identity-platform/quickstart-register-app' },
        { label: 'Assign Azure roles (RBAC)', url: 'https://learn.microsoft.com/azure/role-based-access-control/role-assignments-portal' },
        { label: 'Azure Resource Manager REST API', url: 'https://learn.microsoft.com/rest/api/resources/' },
      ],
      notes:
        'Keep the app registration least-privilege: Reader only. Client secrets expire — set a calendar reminder and rotate before the expiry, ' +
        'or move to certificate auth (a planned follow-up). Writes (start/stop/deallocate VMs, restart App Services) are intentionally not in this version.',
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

  private apiFrom(ctx: ConnectorContext): AzureApi {
    return new AzureApi(this.credsFrom(ctx), str(ctx.config.subscriptionId));
  }

  async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    try {
      const api = this.apiFrom(ctx);
      // Token fetch (cached) validates the credentials; listing subscriptions validates
      // reachability + that the Reader role sees something. One cheap ARM GET.
      const subs = await api.listSubscriptions();
      return {
        ok: true,
        message: subs.length ? `Connected — ${subs.length} subscription(s) visible.` : 'Connected, but no subscriptions are visible — check the Reader role assignment.',
        details: { subscriptions: String(subs.length) },
      };
    } catch (e) {
      return { ok: false, message: e instanceof EntraError ? e.message : (e as Error).message };
    }
  }

  async listResources(ctx: ConnectorContext, kind: string): Promise<ConnectorResource[]> {
    const api = this.apiFrom(ctx);
    switch (kind) {
      case SUB_KIND:
        return (await api.listSubscriptions()).map((s) => ({
          id: s.subscriptionId,
          kind,
          name: s.displayName,
          status: s.state,
          details: { subscriptionId: s.subscriptionId, state: s.state },
        }));
      case RG_KIND:
        return api.forEachSubscription(async (sub) =>
          (await api.listResourceGroups(sub)).map((rg) => ({
            id: rg.id,
            kind,
            name: rg.name,
            status: rg.provisioningState,
            details: { location: rg.location, provisioningState: rg.provisioningState ?? '—' },
            tags: { subscription: sub },
          })),
        );
      case VM_KIND:
        return api.forEachSubscription(async (sub) =>
          (await api.listVirtualMachines(sub)).map((vm) => ({
            id: vm.id,
            kind,
            name: vm.name,
            status: vm.powerState,
            details: {
              size: vm.vmSize ?? '—',
              os: vm.osType ?? '—',
              location: vm.location,
              resourceGroup: vm.resourceGroup,
            },
            tags: { subscription: sub, resourceGroup: vm.resourceGroup },
          })),
        );
      case APP_KIND:
        return api.forEachSubscription(async (sub) =>
          (await api.listAppServices(sub)).map((s) => ({
            id: s.id,
            kind,
            name: s.name,
            status: s.state,
            details: {
              kind: s.kind ?? '—',
              host: s.defaultHostName ?? '—',
              location: s.location,
              resourceGroup: s.resourceGroup,
              enabled: s.enabled ?? true,
            },
            tags: { subscription: sub, resourceGroup: s.resourceGroup },
          })),
        );
      case STORAGE_KIND:
        return api.forEachSubscription(async (sub) =>
          (await api.listStorageAccounts(sub)).map((s) => ({
            id: s.id,
            kind,
            name: s.name,
            status: s.provisioningState,
            details: {
              sku: s.sku ?? '—',
              kind: s.kind ?? '—',
              accessTier: s.accessTier ?? '—',
              location: s.location,
              resourceGroup: s.resourceGroup,
            },
            tags: { subscription: sub, resourceGroup: s.resourceGroup },
          })),
        );
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
    return { ok: false, message: 'The Azure connector is read-only in this version.' };
  }

  async overview(ctx: ConnectorContext): Promise<ConnectorOverview> {
    const api = this.apiFrom(ctx);
    const [subs, vms, apps, storage] = await Promise.all([
      api.listSubscriptions().catch(() => []),
      api.forEachSubscription((s) => api.listVirtualMachines(s)).catch((): AzVm[] => []),
      api.forEachSubscription((s) => api.listAppServices(s)).catch((): AzSite[] => []),
      api.forEachSubscription((s) => api.listStorageAccounts(s)).catch((): AzStorageAccount[] => []),
    ]);
    const vmsRunning = vms.filter((v) => v.powerState === VM_RUNNING).length;
    return {
      metrics: [
        { key: 'subscriptions', label: 'Subscriptions', value: subs.length },
        { key: 'vms', label: 'VMs running', value: vmsRunning },
        { key: 'vms_total', label: 'VMs total', value: vms.length },
        { key: 'app_services', label: 'App Services', value: apps.length },
        { key: 'storage', label: 'Storage accounts', value: storage.length },
      ],
      guests: [
        ...vms.map((v) => ({ name: v.name, kind: VM_KIND, status: v.powerState, node: v.resourceGroup })),
        ...apps.map((a) => ({ name: a.name, kind: APP_KIND, status: a.state ?? 'unknown', node: a.resourceGroup })),
      ].slice(0, 40),
    };
  }
}
