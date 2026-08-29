import type {
  Connector,
  ConnectorContext,
  ConnectorManifest,
  ConnectorResource,
  ConnectorResourceDetail,
  ConnectorDetailGroup,
  ConnectorDetailItem,
  ConnectorOption,
  OperationResult,
  OperationProgress,
  TestConnectionResult,
} from '@cerebro/shared';
import type { ConnectorSubResourceKind } from '@cerebro/shared';
import { ProxmoxApi, ProxmoxAuth, ProxmoxResource } from './proxmox-api';

const POWER_ACTIONS = ['start', 'stop', 'shutdown', 'reboot', 'suspend', 'resume', 'reset'];

const SNAPSHOTS_SUBRESOURCE: ConnectorSubResourceKind = {
  id: 'snapshot',
  label: 'Snapshots',
  labelSingular: 'snapshot',
  createOperationId: 'snapshot-create',
  itemActions: [
    { id: 'rollback', label: 'Rollback', operationId: 'snapshot-rollback', paramKey: 'snapshot', confirm: 'Roll back to this snapshot? Any changes since it was taken will be lost.' },
    { id: 'delete', label: 'Delete', operationId: 'snapshot-delete', paramKey: 'snapshot', confirm: 'Delete this snapshot?', intent: 'destructive' },
  ],
};

const KIND_TO_TYPE: Record<string, 'qemu' | 'lxc'> = { qemu: 'qemu', lxc: 'lxc' };

function bytes(n?: number): string | undefined {
  if (n == null) return undefined;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function uptime(seconds?: number): string | undefined {
  if (!seconds) return undefined;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export class ProxmoxConnector implements Connector {
  manifest: ConnectorManifest = {
    id: 'proxmox',
    name: 'Proxmox VE',
    description: 'View and manage virtual machines and LXC containers on a Proxmox VE server or cluster.',
    version: '1.0.0',
    icon: 'proxmox',
    configFields: [
      {
        key: 'baseUrl',
        label: 'Base URL',
        type: 'url',
        required: true,
        placeholder: 'https://proxmox.example.com:8006',
        help: 'The Proxmox web URL, including the port (8006 by default).',
      },
      {
        key: 'tokenId',
        label: 'API Token ID',
        type: 'text',
        required: true,
        placeholder: 'user@realm!tokenname',
        help: 'Format: user@realm!tokenname — e.g. cerebro@pve!dashboard.',
      },
      {
        key: 'tokenSecret',
        label: 'API Token Secret',
        type: 'password',
        secret: true,
        required: true,
        help: 'The secret shown once when the token was created.',
      },
      {
        key: 'verifyTls',
        label: 'Verify TLS certificate',
        type: 'boolean',
        default: false,
        help: 'Leave off if your Proxmox uses the default self-signed certificate.',
      },
    ],
    resourceKinds: [
      {
        id: 'qemu',
        label: 'Virtual Machines',
        actions: [
          { id: 'start', label: 'Start', mutating: true, showWhenStatus: ['stopped'] },
          { id: 'shutdown', label: 'Shutdown', mutating: true, confirm: 'Gracefully shut down this VM?', showWhenStatus: ['running'] },
          { id: 'reboot', label: 'Reboot', mutating: true, confirm: 'Reboot this VM?', showWhenStatus: ['running'] },
          { id: 'suspend', label: 'Suspend', mutating: true, showWhenStatus: ['running'] },
          { id: 'resume', label: 'Resume', mutating: true, showWhenStatus: ['paused'] },
          { id: 'reset', label: 'Reset', mutating: true, confirm: 'Hard-reset this VM (like the reset button)?', showWhenStatus: ['running'] },
          { id: 'stop', label: 'Stop (force)', mutating: true, confirm: 'Force-stop this VM? Unsaved data may be lost.', showWhenStatus: ['running', 'paused'], intent: 'destructive' },
        ],
        subResources: [SNAPSHOTS_SUBRESOURCE],
      },
      {
        id: 'lxc',
        label: 'LXC Containers',
        actions: [
          { id: 'start', label: 'Start', mutating: true, showWhenStatus: ['stopped'] },
          { id: 'shutdown', label: 'Shutdown', mutating: true, confirm: 'Gracefully shut down this container?', showWhenStatus: ['running'] },
          { id: 'reboot', label: 'Reboot', mutating: true, confirm: 'Reboot this container?', showWhenStatus: ['running'] },
          { id: 'stop', label: 'Stop (force)', mutating: true, confirm: 'Force-stop this container?', showWhenStatus: ['running'], intent: 'destructive' },
        ],
        subResources: [SNAPSHOTS_SUBRESOURCE],
      },
    ],
    operations: [
      {
        id: 'deploy-template',
        label: 'Deploy from template',
        description:
          'Clone a cloud-init-ready VM template into a new VM and configure it (user, SSH key, IP) — the fast, AWS-style way to spin up a Linux machine.',
        scope: 'create',
        kind: 'qemu',
        icon: 'rocket',
        submitLabel: 'Deploy VM',
        fields: [
          { key: 'templateId', label: 'Source template', type: 'select', optionsSource: 'templates', required: true, help: 'A cloud-init-ready VM template to clone.' },
          { key: 'name', label: 'New VM name', type: 'text', required: true, placeholder: 'web-01', help: 'Also used as the hostname.' },
          { key: 'node', label: 'Target node', type: 'select', optionsSource: 'nodes', required: true },
          { key: 'storage', label: 'Disk storage', type: 'select', optionsSource: 'diskStorages', dependsOn: ['node'], required: true, help: 'Where the new VM\'s disk lives (full clone).' },
          { key: 'ciuser', label: 'Cloud-init user', type: 'text', placeholder: 'ubuntu', help: 'Default login user created on first boot.' },
          { key: 'cipassword', label: 'Cloud-init password', type: 'password', help: 'Optional if you provide an SSH key.' },
          { key: 'sshkeys', label: 'SSH public key(s)', type: 'textarea', placeholder: 'ssh-ed25519 AAAA... user@host', help: 'One key per line.' },
          { key: 'ipmode', label: 'IP configuration', type: 'select', default: 'dhcp', options: [{ label: 'DHCP', value: 'dhcp' }, { label: 'Static', value: 'static' }] },
          { key: 'ipaddress', label: 'IP address (CIDR)', type: 'text', placeholder: '192.168.1.50/24', showWhen: { field: 'ipmode', equals: 'static' } },
          { key: 'gateway', label: 'Gateway', type: 'text', placeholder: '192.168.1.1', showWhen: { field: 'ipmode', equals: 'static' } },
          { key: 'start', label: 'Start VM after creation', type: 'boolean', default: true },
        ],
      },
      {
        id: 'snapshot-create',
        label: 'Take snapshot',
        description: 'Capture the current state so you can roll back to it later.',
        scope: 'resource',
        submitLabel: 'Take snapshot',
        fields: [
          { key: 'snapname', label: 'Snapshot name', type: 'text', required: true, placeholder: 'before-upgrade', help: 'Letters, numbers, and hyphens.' },
          { key: 'description', label: 'Description', type: 'text', placeholder: 'Optional note' },
          { key: 'vmstate', label: 'Include RAM (VM state)', type: 'boolean', default: false, help: 'Snapshot the running memory too (VMs only).' },
        ],
      },
      { id: 'snapshot-rollback', label: 'Rollback snapshot', scope: 'resource', fields: [] },
      { id: 'snapshot-delete', label: 'Delete snapshot', scope: 'resource', fields: [] },
      {
        id: 'create-vm',
        label: 'Create VM',
        description: 'Create a new virtual machine and boot it from an installation ISO.',
        scope: 'create',
        kind: 'qemu',
        icon: 'plus',
        submitLabel: 'Create VM',
        fields: [
          { key: 'name', label: 'VM name', type: 'text', required: true, placeholder: 'debian-01' },
          { key: 'node', label: 'Node', type: 'select', optionsSource: 'nodes', required: true },
          { key: 'ostype', label: 'OS type', type: 'select', default: 'l26', options: [
            { label: 'Linux (6.x/5.x)', value: 'l26' }, { label: 'Windows 11', value: 'win11' },
            { label: 'Windows 10', value: 'win10' }, { label: 'Other', value: 'other' },
          ] },
          { key: 'iso', label: 'Installation ISO', type: 'select', optionsSource: 'isos', dependsOn: ['node'], required: true, help: 'Upload ISOs to a storage in Proxmox first.' },
          { key: 'storage', label: 'Disk storage', type: 'select', optionsSource: 'diskStorages', dependsOn: ['node'], required: true },
          { key: 'disksize', label: 'Disk size (GB)', type: 'number', default: 32 },
          { key: 'cores', label: 'CPU cores', type: 'number', default: 2 },
          { key: 'memory', label: 'Memory (MB)', type: 'number', default: 2048 },
          { key: 'bridge', label: 'Network bridge', type: 'select', optionsSource: 'bridges', dependsOn: ['node'], required: true },
          { key: 'bios', label: 'BIOS', type: 'select', default: 'seabios', options: [
            { label: 'SeaBIOS (default)', value: 'seabios' }, { label: 'UEFI (OVMF)', value: 'ovmf' },
          ] },
          { key: 'start', label: 'Start after creation (begin install)', type: 'boolean', default: true },
        ],
      },
      {
        id: 'create-lxc',
        label: 'Create container',
        description: 'Create a new LXC container from an OS template.',
        scope: 'create',
        kind: 'lxc',
        icon: 'plus',
        submitLabel: 'Create container',
        fields: [
          { key: 'hostname', label: 'Hostname', type: 'text', required: true, placeholder: 'ct-01' },
          { key: 'node', label: 'Node', type: 'select', optionsSource: 'nodes', required: true },
          { key: 'ostemplate', label: 'OS template', type: 'select', optionsSource: 'containerTemplates', dependsOn: ['node'], required: true, help: 'Download templates in Proxmox (CT Templates) first.' },
          { key: 'storage', label: 'Root FS storage', type: 'select', optionsSource: 'rootfsStorages', dependsOn: ['node'], required: true },
          { key: 'disksize', label: 'Disk size (GB)', type: 'number', default: 8 },
          { key: 'cores', label: 'CPU cores', type: 'number', default: 1 },
          { key: 'memory', label: 'Memory (MB)', type: 'number', default: 512 },
          { key: 'swap', label: 'Swap (MB)', type: 'number', default: 512 },
          { key: 'password', label: 'Root password', type: 'password', help: 'Set a root password and/or an SSH key below.' },
          { key: 'sshkeys', label: 'SSH public key(s)', type: 'textarea', placeholder: 'ssh-ed25519 AAAA... user@host' },
          { key: 'bridge', label: 'Network bridge', type: 'select', optionsSource: 'bridges', dependsOn: ['node'], required: true },
          { key: 'ipmode', label: 'IP configuration', type: 'select', default: 'dhcp', options: [
            { label: 'DHCP', value: 'dhcp' }, { label: 'Static', value: 'static' },
          ] },
          { key: 'ipaddress', label: 'IP address (CIDR)', type: 'text', placeholder: '192.168.1.50/24', showWhen: { field: 'ipmode', equals: 'static' } },
          { key: 'gateway', label: 'Gateway', type: 'text', placeholder: '192.168.1.1', showWhen: { field: 'ipmode', equals: 'static' } },
          { key: 'unprivileged', label: 'Unprivileged container', type: 'boolean', default: true },
          { key: 'start', label: 'Start after creation', type: 'boolean', default: true },
        ],
      },
      {
        id: 'build-template',
        label: 'Build template from image',
        description:
          'Download a cloud image (e.g. Ubuntu cloud image), import it as a disk, add a cloud-init drive, and convert it to a reusable template you can then Deploy from. The node needs internet access to fetch the image.',
        scope: 'create',
        kind: 'qemu',
        icon: 'package',
        submitLabel: 'Build template',
        fields: [
          { key: 'name', label: 'Template name', type: 'text', required: true, placeholder: 'ubuntu-2404-cloudinit' },
          { key: 'node', label: 'Node', type: 'select', optionsSource: 'nodes', required: true },
          { key: 'imageUrl', label: 'Cloud image URL', type: 'text', required: true, placeholder: 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img', help: 'A .img/.qcow2 cloud image with cloud-init preinstalled.' },
          { key: 'isoStorage', label: 'Download to storage', type: 'select', optionsSource: 'isoStorages', dependsOn: ['node'], required: true, help: 'A storage that accepts ISO content (the image is staged here).' },
          { key: 'diskStorage', label: 'Disk storage', type: 'select', optionsSource: 'diskStorages', dependsOn: ['node'], required: true, help: 'Where the imported template disk will live.' },
          { key: 'cores', label: 'CPU cores', type: 'number', default: 2 },
          { key: 'memory', label: 'Memory (MB)', type: 'number', default: 2048 },
          { key: 'bridge', label: 'Network bridge', type: 'select', optionsSource: 'bridges', dependsOn: ['node'], required: true },
          { key: 'checksum', label: 'SHA-256 checksum', type: 'text', placeholder: 'optional', help: 'Optional — verifies the downloaded image.' },
        ],
      },
    ],
    help: {
      overview:
        'Cerebro connects to Proxmox VE using an API token (no account password is stored). Create a dedicated token with a least-privilege role, then paste its ID and secret here.',
      setupSteps: [
        'In Proxmox: Datacenter → Permissions → Users, create a dedicated user (e.g. cerebro@pve).',
        'Datacenter → Permissions → API Tokens: add a token for that user (e.g. "dashboard"). Copy the secret now — it is shown only once.',
        'If "Privilege Separation" is enabled on the token, also grant the token a role (next step).',
        'Datacenter → Permissions → Add → API Token Permission: path "/", the token, role PVEAuditor (read-only) or PVEVMAdmin (to start/stop guests).',
        'Paste the Base URL, Token ID (user@realm!tokenname), and the secret into Cerebro, then Test the connection.',
      ],
      requiredPermissions: [
        'PVEAuditor on / — required to list VMs and containers (read-only).',
        'VM.PowerMgmt (included in PVEVMAdmin) on / or per-VM — start, stop, shutdown, reboot, snapshots.',
        'VM.Allocate + VM.Config.* (PVEVMAdmin) — required to create VMs/containers and build templates.',
        'Datastore.AllocateSpace + Datastore.AllocateTemplate (PVEDatastoreAdmin) — required to import disks and download images for template building.',
        'Sys.Audit — recommended, lets the connection test read /version and cluster status.',
      ],
      referenceLinks: [
        { label: 'Proxmox VE API tokens', url: 'https://pve.proxmox.com/wiki/User_Management#pveum_tokens' },
        { label: 'Roles & privileges reference', url: 'https://pve.proxmox.com/wiki/User_Management#pveum_permission_management' },
        { label: 'Proxmox VE API viewer', url: 'https://pve.proxmox.com/pve-docs/api-viewer/' },
      ],
      notes:
        'Use a dedicated token, not your root password. Grant PVEAuditor for a view-only connection; add VM.PowerMgmt only if you want Cerebro to control power state.',
    },
  };

  private authFrom(ctx: ConnectorContext): ProxmoxAuth {
    const c = ctx.config;
    return {
      baseUrl: String(c.baseUrl ?? ''),
      tokenId: String(c.tokenId ?? ''),
      tokenSecret: String(c.tokenSecret ?? ''),
      verifyTls: c.verifyTls === true || c.verifyTls === 'true',
    };
  }

  async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    const api = new ProxmoxApi(this.authFrom(ctx));
    try {
      const v = await api.version();
      ctx.log('info', `Connected to Proxmox VE ${v.version}`);
      return { ok: true, message: `Connected to Proxmox VE ${v.version} (${v.release}).`, details: { version: v.version } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed.';
      ctx.log('warn', `Proxmox connection test failed: ${message}`);
      return { ok: false, message };
    }
  }

  async listResources(ctx: ConnectorContext, kind: string): Promise<ConnectorResource[]> {
    const type = KIND_TO_TYPE[kind];
    if (!type) return [];
    const api = new ProxmoxApi(this.authFrom(ctx));
    const all = await api.clusterResources();
    return all
      .filter((r) => r.type === type)
      .sort((a, b) => a.vmid - b.vmid)
      .map((r) => ({
        id: String(r.vmid),
        kind,
        name: r.name || `${type}-${r.vmid}`,
        status: r.status,
        details: {
          vmid: r.vmid,
          node: r.node,
          cpu: r.maxcpu != null ? `${r.maxcpu} vCPU` : null,
          memory: bytes(r.maxmem) ?? null,
          uptime: r.status === 'running' ? uptime(r.uptime) ?? null : null,
        },
      }));
  }

  async performAction(
    ctx: ConnectorContext,
    kind: string,
    resourceId: string,
    actionId: string,
  ): Promise<{ ok: boolean; message: string }> {
    const type = KIND_TO_TYPE[kind];
    if (!type) return { ok: false, message: `Unknown resource kind "${kind}".` };
    if (!POWER_ACTIONS.includes(actionId)) {
      return { ok: false, message: `Unsupported action "${actionId}".` };
    }
    const api = new ProxmoxApi(this.authFrom(ctx));
    const vmid = parseInt(resourceId, 10);
    try {
      // vmid is cluster-unique; look up its node.
      const all = await api.clusterResources();
      const match = all.find((r) => r.vmid === vmid && r.type === type);
      if (!match) return { ok: false, message: `${type} ${vmid} not found.` };
      await api.setStatus(match.node, type, vmid, actionId);
      ctx.log('info', `Proxmox ${actionId} on ${type} ${vmid} (${match.name ?? ''}) requested.`);
      return { ok: true, message: `${actionId} requested for ${match.name || `${type} ${vmid}`}.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action failed.';
      ctx.log('error', `Proxmox ${actionId} on ${type} ${vmid} failed: ${message}`);
      return { ok: false, message };
    }
  }

  private async locate(api: ProxmoxApi, type: 'qemu' | 'lxc', vmid: number): Promise<ProxmoxResource | undefined> {
    const all = await api.clusterResources();
    return all.find((r) => r.vmid === vmid && r.type === type);
  }

  async describeResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<ConnectorResourceDetail> {
    const type = KIND_TO_TYPE[kind];
    const api = new ProxmoxApi(this.authFrom(ctx));
    const vmid = parseInt(resourceId, 10);
    const res = await this.locate(api, type, vmid);
    if (!res) throw new Error(`${type} ${vmid} not found.`);

    const cfg = await api.config(res.node, type, vmid);
    const groups: ConnectorDetailGroup[] = [];

    // General
    groups.push({
      title: 'General',
      items: [
        { label: 'Name', value: res.name || String(vmid) },
        { label: 'Status', value: res.status ?? 'unknown', variant: 'status' },
        { label: 'Node', value: res.node },
        { label: 'VMID', value: String(vmid), variant: 'mono' },
        { label: 'OS type', value: String(cfg.ostype ?? (type === 'lxc' ? 'lxc' : 'other')) },
        { label: 'CPU', value: `${cfg.cores ?? res.maxcpu ?? '?'} cores${cfg.sockets ? ` × ${cfg.sockets} sockets` : ''}` },
        { label: 'Memory', value: bytes(res.maxmem) ?? `${cfg.memory ?? '?'} MB` },
        ...(res.status === 'running' && res.uptime ? [{ label: 'Uptime', value: uptime(res.uptime) ?? '—' }] : []),
      ],
    });

    // Disks
    const diskItems: ConnectorDetailItem[] = Object.entries(cfg)
      .filter(([k]) => /^(scsi|virtio|sata|ide|efidisk|rootfs|mp)\d*$/.test(k))
      .filter(([, v]) => !`${v}`.includes('media=cdrom'))
      .map(([k, v]) => ({ label: k, value: String(v), variant: 'mono' }));
    if (diskItems.length) groups.push({ title: 'Disks', items: diskItems });

    // Network + IP addresses
    const netItems: ConnectorDetailItem[] = Object.entries(cfg)
      .filter(([k]) => /^net\d+$/.test(k))
      .map(([k, v]) => ({ label: k, value: String(v), variant: 'mono' }));
    const ips = await this.guestIps(api, res.node, type, vmid).catch(() => []);
    if (ips.length) netItems.push({ label: 'IP addresses', value: ips.join(', ') });
    if (netItems.length) groups.push({ title: 'Network', items: netItems });

    return { id: resourceId, kind, name: res.name || String(vmid), status: res.status, groups };
  }

  private async guestIps(api: ProxmoxApi, node: string, type: 'qemu' | 'lxc', vmid: number): Promise<string[]> {
    if (type === 'qemu') {
      const data = await api.qemuAgentInterfaces(node, vmid);
      const ips: string[] = [];
      for (const iface of data.result ?? []) {
        if (iface.name === 'lo') continue;
        for (const a of iface['ip-addresses'] ?? []) {
          if (a['ip-address-type'] === 'ipv4') ips.push(a['ip-address']);
        }
      }
      return ips;
    }
    const ifaces = await api.lxcInterfaces(node, vmid);
    return ifaces.filter((i) => i.name !== 'lo' && i.inet).map((i) => i.inet!.split('/')[0]);
  }

  async deleteResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<{ ok: boolean; message: string }> {
    const type = KIND_TO_TYPE[kind];
    const api = new ProxmoxApi(this.authFrom(ctx));
    const vmid = parseInt(resourceId, 10);
    try {
      const res = await this.locate(api, type, vmid);
      if (!res) return { ok: false, message: `${type} ${vmid} not found.` };
      if (res.status === 'running') {
        return { ok: false, message: 'Stop the guest before deleting it.' };
      }
      await api.destroy(res.node, type, vmid);
      ctx.log('warn', `Proxmox deleted ${type} ${vmid} (${res.name ?? ''}).`);
      return { ok: true, message: `Deleted ${res.name || `${type} ${vmid}`}.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Delete failed.';
      ctx.log('error', `Proxmox delete ${type} ${vmid} failed: ${message}`);
      return { ok: false, message };
    }
  }

  // ── Operations (Phase B) ──

  async resolveOptions(ctx: ConnectorContext, sourceId: string, values: Record<string, unknown>): Promise<ConnectorOption[]> {
    const api = new ProxmoxApi(this.authFrom(ctx));
    switch (sourceId) {
      case 'nodes': {
        const nodes = await api.nodes();
        return nodes.map((n) => ({ label: n.node, value: n.node, description: n.status }));
      }
      case 'templates': {
        const all = await api.clusterResources();
        return all
          .filter((r) => r.type === 'qemu' && (r as unknown as { template?: number }).template === 1)
          .sort((a, b) => a.vmid - b.vmid)
          // value encodes node:vmid so we know where the template lives.
          .map((r) => ({ label: `${r.name || 'template'} · VMID ${r.vmid} · ${r.node}`, value: `${r.node}:${r.vmid}` }));
      }
      case 'diskStorages': {
        const node = String(values.node ?? '');
        if (!node) return [];
        const storages = await api.nodeStorages(node, 'images');
        return storages.map((s) => ({ label: s.storage, value: s.storage, description: s.type }));
      }
      case 'rootfsStorages': {
        const node = String(values.node ?? '');
        if (!node) return [];
        const storages = await api.nodeStorages(node, 'rootdir');
        return storages.map((s) => ({ label: s.storage, value: s.storage, description: s.type }));
      }
      case 'isoStorages': {
        const node = String(values.node ?? '');
        if (!node) return [];
        const storages = await api.nodeStorages(node, 'iso');
        return storages.map((s) => ({ label: s.storage, value: s.storage, description: s.type }));
      }
      case 'bridges': {
        const node = String(values.node ?? '');
        if (!node) return [];
        const nets = await api.networks(node);
        return nets.filter((n) => n.type === 'bridge').map((n) => ({ label: n.iface, value: n.iface }));
      }
      case 'isos':
        return this.storageVolids(api, String(values.node ?? ''), 'iso');
      case 'containerTemplates':
        return this.storageVolids(api, String(values.node ?? ''), 'vztmpl');
      default:
        return [];
    }
  }

  /** Aggregates content volids of a given type across all storages on a node. */
  private async storageVolids(api: ProxmoxApi, node: string, content: string): Promise<ConnectorOption[]> {
    if (!node) return [];
    const storages = await api.nodeStorages(node);
    const eligible = storages.filter((s) => (s.content || '').split(',').includes(content));
    const out: ConnectorOption[] = [];
    for (const s of eligible) {
      const items = await api.storageContent(node, s.storage, content).catch(() => []);
      for (const it of items) out.push({ label: it.volid.split('/').pop() || it.volid, value: it.volid, description: s.storage });
    }
    return out;
  }

  async listSubResources(ctx: ConnectorContext, kind: string, resourceId: string, subKind: string): Promise<ConnectorResource[]> {
    if (subKind !== 'snapshot') return [];
    const type = KIND_TO_TYPE[kind];
    const api = new ProxmoxApi(this.authFrom(ctx));
    const vmid = parseInt(resourceId, 10);
    const res = await this.locate(api, type, vmid);
    if (!res) throw new Error(`${type} ${vmid} not found.`);
    const snaps = await api.listSnapshots(res.node, type, vmid);
    return snaps
      // Proxmox includes a synthetic "current" entry representing the live state.
      .filter((s) => s.name !== 'current')
      .sort((a, b) => (a.snaptime ?? 0) - (b.snaptime ?? 0))
      .map((s) => ({
        id: s.name,
        kind: 'snapshot',
        name: s.name,
        status: s.vmstate ? 'with RAM' : undefined,
        details: {
          created: s.snaptime ? new Date(s.snaptime * 1000).toLocaleString() : null,
          description: s.description?.trim() || null,
          parent: s.parent ?? null,
        },
      }));
  }

  async runOperation(
    ctx: ConnectorContext,
    operationId: string,
    resourceId: string | undefined,
    values: Record<string, unknown>,
    onProgress: OperationProgress,
  ): Promise<OperationResult> {
    const api = new ProxmoxApi(this.authFrom(ctx));
    if (operationId === 'snapshot-create') return this.snapshotCreate(api, resourceId, values, onProgress);
    if (operationId === 'snapshot-rollback') return this.snapshotRollback(api, resourceId, values, onProgress);
    if (operationId === 'snapshot-delete') return this.snapshotDelete(api, resourceId, values, onProgress);
    if (operationId === 'create-vm') return this.createVm(api, values, onProgress);
    if (operationId === 'create-lxc') return this.createLxc(api, values, onProgress);
    if (operationId === 'build-template') return this.buildTemplate(api, values, onProgress);
    if (operationId !== 'deploy-template') {
      return { ok: false, message: `Unknown operation "${operationId}".` };
    }

    const [tplNode, tplVmidStr] = String(values.templateId ?? '').split(':');
    const tplVmid = parseInt(tplVmidStr, 10);
    if (!tplNode || !tplVmid) return { ok: false, message: 'Choose a source template.' };
    const targetNode = String(values.node || tplNode);
    const name = String(values.name ?? '').trim();
    if (!name) return { ok: false, message: 'A VM name is required.' };

    onProgress('Allocating a new VM ID…');
    const newid = await api.nextId();

    onProgress(`Cloning template ${tplVmid} → VM ${newid} (${name})…`);
    const cloneParams: Record<string, unknown> = {
      newid,
      name,
      full: 1,
      target: targetNode !== tplNode ? targetNode : undefined,
      storage: values.storage || undefined,
    };
    const upid = await api.cloneVm(tplNode, tplVmid, cloneParams);
    onProgress('Waiting for the clone to finish…');
    await api.waitForTask(tplNode, upid);

    // Apply cloud-init settings on the new VM.
    const ci: Record<string, unknown> = {};
    if (values.ciuser) ci.ciuser = values.ciuser;
    if (values.cipassword) ci.cipassword = values.cipassword;
    if (values.sshkeys) ci.sshkeys = encodeURIComponent(String(values.sshkeys).trim());
    if (values.ipmode === 'static' && values.ipaddress) {
      ci.ipconfig0 = `ip=${values.ipaddress}${values.gateway ? `,gw=${values.gateway}` : ''}`;
    } else {
      ci.ipconfig0 = 'ip=dhcp';
    }
    if (Object.keys(ci).length > 0) {
      onProgress('Applying cloud-init settings (user, SSH key, network)…');
      await api.updateConfig(targetNode, 'qemu', newid, ci);
    }

    if (values.start === true || values.start === 'true') {
      onProgress('Starting the VM…');
      await api.setStatus(targetNode, 'qemu', newid, 'start');
    }

    ctx.log('info', `Deployed VM ${newid} (${name}) from template ${tplVmid}.`);
    return { ok: true, message: `Deployed ${name} as VM ${newid} on ${targetNode}.`, createdResourceId: String(newid) };
  }

  // ── Create operations ──

  private async createVm(api: ProxmoxApi, values: Record<string, unknown>, onProgress: OperationProgress): Promise<OperationResult> {
    const node = String(values.node ?? '');
    const name = String(values.name ?? '').trim();
    if (!node) return { ok: false, message: 'Choose a node.' };
    if (!name) return { ok: false, message: 'A VM name is required.' };
    try {
      const newid = await api.nextId();
      const storage = String(values.storage);
      const disksize = Number(values.disksize || 32);
      onProgress(`Creating VM ${newid} (${name})…`);
      const params: Record<string, unknown> = {
        vmid: newid,
        name,
        cores: Number(values.cores || 2),
        sockets: 1,
        memory: Number(values.memory || 2048),
        ostype: String(values.ostype || 'l26'),
        scsihw: 'virtio-scsi-single',
        scsi0: `${storage}:${disksize}`,
        ide2: `${values.iso},media=cdrom`,
        net0: `virtio,bridge=${values.bridge}`,
        boot: 'order=scsi0;ide2',
        bios: String(values.bios || 'seabios'),
      };
      if (values.bios === 'ovmf') params.efidisk0 = `${storage}:1,efitype=4m`;
      const upid = await api.createVm(node, params);
      await api.waitForTask(node, upid);
      if (values.start === true || values.start === 'true') {
        onProgress('Starting the VM…');
        await api.setStatus(node, 'qemu', newid, 'start');
      }
      return { ok: true, message: `Created VM ${newid} (${name}) on ${node}.`, createdResourceId: String(newid) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Create failed.' };
    }
  }

  private async createLxc(api: ProxmoxApi, values: Record<string, unknown>, onProgress: OperationProgress): Promise<OperationResult> {
    const node = String(values.node ?? '');
    const hostname = String(values.hostname ?? '').trim();
    if (!node) return { ok: false, message: 'Choose a node.' };
    if (!hostname) return { ok: false, message: 'A hostname is required.' };
    if (!values.password && !values.sshkeys) {
      return { ok: false, message: 'Set a root password or an SSH key.' };
    }
    try {
      const newid = await api.nextId();
      const storage = String(values.storage);
      const disksize = Number(values.disksize || 8);
      const ip =
        values.ipmode === 'static' && values.ipaddress
          ? `${values.ipaddress}${values.gateway ? `,gw=${values.gateway}` : ''}`
          : 'dhcp';
      onProgress(`Creating container ${newid} (${hostname})…`);
      const params: Record<string, unknown> = {
        vmid: newid,
        hostname,
        ostemplate: String(values.ostemplate),
        storage,
        rootfs: `${storage}:${disksize}`,
        cores: Number(values.cores || 1),
        memory: Number(values.memory || 512),
        swap: Number(values.swap || 512),
        net0: `name=eth0,bridge=${values.bridge},ip=${ip}`,
        unprivileged: values.unprivileged === false || values.unprivileged === 'false' ? 0 : 1,
        password: values.password || undefined,
        'ssh-public-keys': values.sshkeys ? String(values.sshkeys).trim() : undefined,
        start: values.start === true || values.start === 'true' ? 1 : 0,
      };
      const upid = await api.createLxc(node, params);
      await api.waitForTask(node, upid);
      return { ok: true, message: `Created container ${newid} (${hostname}) on ${node}.`, createdResourceId: String(newid) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Create failed.' };
    }
  }

  /**
   * Build a cloud-init template from an image URL, API-only (no SSH/CLI):
   * download-url → create VM shell → import disk via `import-from` → cloud-init drive → template.
   * Requires Proxmox 8.x for the config `import-from` feature.
   */
  private async buildTemplate(api: ProxmoxApi, values: Record<string, unknown>, onProgress: OperationProgress): Promise<OperationResult> {
    const node = String(values.node ?? '');
    const name = String(values.name ?? '').trim();
    const imageUrl = String(values.imageUrl ?? '').trim();
    const isoStorage = String(values.isoStorage ?? '');
    const diskStorage = String(values.diskStorage ?? '');
    if (!node || !name || !imageUrl || !isoStorage || !diskStorage) {
      return { ok: false, message: 'Name, node, image URL, and both storages are required.' };
    }
    const LONG = 30 * 60 * 1000; // image downloads / imports can take a while
    let newid: number | undefined;
    let converted = false;
    try {
      // 1) Download the cloud image onto an ISO-capable (file-based) storage.
      const urlName = imageUrl.split('/').pop() || `${name}.img`;
      const filename = urlName.match(/\.(img|qcow2|raw)$/i) ? urlName : `${name}.img`;
      const imageVolid = `${isoStorage}:iso/${filename}`;
      // Idempotent: skip the download if the image is already staged (e.g. a retry).
      const existing = await api.storageContent(node, isoStorage, 'iso').catch(() => []);
      if (existing.some((it) => it.volid === imageVolid)) {
        onProgress(`${filename} already present in ${isoStorage}, skipping download.`);
      } else {
        onProgress(`Downloading ${filename} to ${isoStorage}…`);
        const dlParams: Record<string, unknown> = { content: 'iso', url: imageUrl, filename };
        if (values.checksum) {
          dlParams.checksum = String(values.checksum).trim();
          dlParams['checksum-algorithm'] = 'sha256';
        }
        const dlUpid = await api.downloadUrl(node, isoStorage, dlParams);
        await api.waitForTask(node, dlUpid, LONG);
      }

      // Resolve the image's absolute path: `import-from` rejects an iso-type volid,
      // but accepts a filesystem path. ISO content lives at <storage path>/template/iso/.
      const storeCfg = await api.storageConfig(isoStorage);
      if (!storeCfg.path) {
        throw new Error(`Storage "${isoStorage}" has no filesystem path; pick a directory/NFS storage for the download.`);
      }
      const importFrom = `${storeCfg.path.replace(/\/$/, '')}/template/iso/${filename}`;

      // 2) Create the VM shell (serial console — cloud images expect it).
      newid = await api.nextId();
      onProgress(`Creating VM ${newid} shell…`);
      const createUpid = await api.createVm(node, {
        vmid: newid,
        name,
        cores: Number(values.cores || 2),
        sockets: 1,
        memory: Number(values.memory || 2048),
        ostype: 'l26',
        scsihw: 'virtio-scsi-single',
        net0: `virtio,bridge=${values.bridge}`,
        serial0: 'socket',
        vga: 'serial0',
        agent: 1,
      });
      await api.waitForTask(node, createUpid);

      // 3) Import the downloaded image as scsi0 (PVE8 import-from, by absolute path).
      onProgress('Importing the disk (this can take a while)…');
      const importRes = await api.updateConfig(node, 'qemu', newid, {
        scsi0: `${diskStorage}:0,import-from=${importFrom}`,
      });
      if (typeof importRes === 'string' && importRes.startsWith('UPID')) {
        await api.waitForTask(node, importRes, LONG);
      }

      // 4) Cloud-init drive + boot order.
      onProgress('Adding cloud-init drive and boot settings…');
      await api.updateConfig(node, 'qemu', newid, {
        ide2: `${diskStorage}:cloudinit`,
        boot: 'order=scsi0',
      });

      // 5) Convert to template.
      onProgress('Converting to a template…');
      const tplRes = await api.convertToTemplate(node, newid);
      if (typeof tplRes === 'string' && tplRes.startsWith('UPID')) {
        await api.waitForTask(node, tplRes);
      }
      converted = true;

      return { ok: true, message: `Template "${name}" built (VMID ${newid}). It's now available under "Deploy from template".`, createdResourceId: String(newid) };
    } catch (err) {
      // Best-effort cleanup: remove the half-built VM shell so no orphan is left behind.
      if (newid !== undefined && !converted) {
        onProgress('Cleaning up the incomplete VM…');
        await api.destroy(node, 'qemu', newid).catch(() => undefined);
      }
      return { ok: false, message: err instanceof Error ? err.message : 'Template build failed.' };
    }
  }

  // ── Snapshot operations (resource-scoped; kind comes in via values.kind) ──

  private async resolveGuest(api: ProxmoxApi, values: Record<string, unknown>, resourceId?: string) {
    const type = KIND_TO_TYPE[String(values.kind ?? 'qemu')] ?? 'qemu';
    const vmid = parseInt(String(resourceId ?? ''), 10);
    const res = await this.locate(api, type, vmid);
    if (!res) throw new Error(`${type} ${vmid} not found.`);
    return { type, vmid, node: res.node };
  }

  private async snapshotCreate(api: ProxmoxApi, resourceId: string | undefined, values: Record<string, unknown>, onProgress: OperationProgress): Promise<OperationResult> {
    const snapname = String(values.snapname ?? '').trim();
    if (!snapname) return { ok: false, message: 'A snapshot name is required.' };
    try {
      const { type, vmid, node } = await this.resolveGuest(api, values, resourceId);
      onProgress(`Creating snapshot "${snapname}"…`);
      const params: Record<string, unknown> = { snapname, description: values.description || undefined };
      if (type === 'qemu' && (values.vmstate === true || values.vmstate === 'true')) params.vmstate = 1;
      const upid = await api.createSnapshot(node, type, vmid, params);
      await api.waitForTask(node, upid);
      return { ok: true, message: `Snapshot "${snapname}" created.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Snapshot failed.' };
    }
  }

  private async snapshotRollback(api: ProxmoxApi, resourceId: string | undefined, values: Record<string, unknown>, onProgress: OperationProgress): Promise<OperationResult> {
    const snap = String(values.snapshot ?? '');
    if (!snap) return { ok: false, message: 'No snapshot specified.' };
    try {
      const { type, vmid, node } = await this.resolveGuest(api, values, resourceId);
      onProgress(`Rolling back to "${snap}"…`);
      const upid = await api.rollbackSnapshot(node, type, vmid, snap);
      await api.waitForTask(node, upid);
      return { ok: true, message: `Rolled back to "${snap}".` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Rollback failed.' };
    }
  }

  private async snapshotDelete(api: ProxmoxApi, resourceId: string | undefined, values: Record<string, unknown>, onProgress: OperationProgress): Promise<OperationResult> {
    const snap = String(values.snapshot ?? '');
    if (!snap) return { ok: false, message: 'No snapshot specified.' };
    try {
      const { type, vmid, node } = await this.resolveGuest(api, values, resourceId);
      onProgress(`Deleting snapshot "${snap}"…`);
      const upid = await api.deleteSnapshot(node, type, vmid, snap);
      await api.waitForTask(node, upid);
      return { ok: true, message: `Snapshot "${snap}" deleted.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Delete failed.' };
    }
  }
}
