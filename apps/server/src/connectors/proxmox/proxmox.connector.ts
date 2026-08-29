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
import { ProxmoxApi, ProxmoxAuth, ProxmoxResource } from './proxmox-api';

const POWER_ACTIONS = ['start', 'stop', 'shutdown', 'reboot', 'suspend', 'resume', 'reset'];

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
        'VM.PowerMgmt (included in PVEVMAdmin) on / or per-VM — required to start, stop, shutdown, and reboot guests.',
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
      default:
        return [];
    }
  }

  async runOperation(
    ctx: ConnectorContext,
    operationId: string,
    _resourceId: string | undefined,
    values: Record<string, unknown>,
    onProgress: OperationProgress,
  ): Promise<OperationResult> {
    if (operationId !== 'deploy-template') {
      return { ok: false, message: `Unknown operation "${operationId}".` };
    }
    const api = new ProxmoxApi(this.authFrom(ctx));

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
}
