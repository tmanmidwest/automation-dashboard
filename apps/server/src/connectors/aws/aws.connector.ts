import type {
  Connector,
  ConnectorContext,
  ConnectorManifest,
  ConnectorResource,
  ConnectorResourceDetail,
  ConnectorDetailGroup,
  ConnectorOption,
  ConnectorOverview,
  OverviewMetric,
  OperationResult,
  OperationProgress,
  TestConnectionResult,
} from '@cerebro/shared';
import { AwsApi, AwsAuth, AwsInstance, AwsCostSummary } from './aws-api';

const EC2_KIND = 'ec2';

/** EC2 states in which an instance can no longer be acted upon. */
const DEAD_STATES = ['terminated', 'shutting-down'];

/** Sentinel option value that reveals the free-text "Custom AMI ID" field. */
const CUSTOM_AMI = '__custom__';

/** Curated latest-official-image catalog, resolved to concrete AMI IDs at form-open time. */
const AMI_CATALOG: { label: string; owners: string[]; name: string }[] = [
  { label: 'Amazon Linux 2023 (x86_64)', owners: ['amazon'], name: 'al2023-ami-2023.*-x86_64' },
  { label: 'Ubuntu 24.04 LTS (x86_64)', owners: ['099720109477'], name: 'ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-amd64-server-*' },
  { label: 'Ubuntu 22.04 LTS (x86_64)', owners: ['099720109477'], name: 'ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*' },
];

/** Common x86_64 instance types offered in the launch form. */
const INSTANCE_TYPES = [
  't3.micro', 't3.small', 't3.medium', 't3.large', 't3.xlarge',
  't3a.micro', 't3a.small', 't3a.medium', 't3a.large',
  'm5.large', 'm5.xlarge', 'm6i.large', 'm6i.xlarge',
  'c5.large', 'c6i.large', 'r5.large', 'r6i.large',
];

function timeAgo(d?: Date): string | undefined {
  if (!d) return undefined;
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** Cost Explorer is billed per call, and spend moves ~daily — cache it for a day. */
const COST_TTL_MS = 24 * 60 * 60 * 1000;
/** If a cost fetch fails (CE not enabled / no perms), retry sooner than a full day. */
const COST_RETRY_MS = 60 * 60 * 1000;

const round2 = (n: number) => Math.round(n * 100) / 100;

export class AwsConnector implements Connector {
  /**
   * Caches month-to-date + forecast spend per account (access key). AWS bills
   * ~$0.01 per Cost Explorer call, so this is only refreshed once a day even
   * though overview() runs far more often. Failures cache briefly then retry.
   */
  private costCache = new Map<string, { at: number; data: AwsCostSummary | null }>();

  manifest: ConnectorManifest = {
    id: 'aws',
    name: 'Amazon Web Services',
    description: 'View and manage Amazon EC2 instances in an AWS account and region.',
    version: '1.0.0',
    icon: 'aws',
    configFields: [
      {
        key: 'accessKeyId',
        label: 'Access Key ID',
        type: 'text',
        required: true,
        placeholder: 'AKIA...',
        help: 'The access key ID of an IAM user or role with EC2 read/manage permissions.',
      },
      {
        key: 'secretAccessKey',
        label: 'Secret Access Key',
        type: 'password',
        secret: true,
        required: true,
        help: 'The secret shown once when the access key was created.',
      },
      {
        key: 'region',
        label: 'Region',
        type: 'text',
        required: true,
        placeholder: 'us-east-1',
        help: 'The AWS region to manage, e.g. us-east-1, eu-west-2. One region per connection.',
      },
      {
        key: 'sessionToken',
        label: 'Session Token',
        type: 'password',
        secret: true,
        help: 'Only for temporary (STS) credentials — leave blank for a normal IAM access key.',
      },
    ],
    resourceKinds: [
      {
        id: EC2_KIND,
        label: 'EC2 Instances',
        category: 'vm',
        actions: [
          { id: 'start', label: 'Start', mutating: true, showWhenStatus: ['stopped'] },
          { id: 'stop', label: 'Stop', mutating: true, confirm: 'Stop this instance?', showWhenStatus: ['running'] },
          { id: 'reboot', label: 'Reboot', mutating: true, confirm: 'Reboot this instance?', showWhenStatus: ['running'] },
          {
            id: 'force-stop',
            label: 'Force stop',
            mutating: true,
            confirm: 'Force-stop this instance? Unsaved in-memory data may be lost.',
            showWhenStatus: ['running', 'stopping'],
            intent: 'destructive',
          },
        ],
      },
    ],
    operations: [
      {
        id: 'launch-ec2',
        label: 'Launch instance',
        description: 'Launch a new EC2 instance from an official image or a custom AMI.',
        scope: 'create',
        kind: EC2_KIND,
        icon: 'rocket',
        submitLabel: 'Launch instance',
        fields: [
          { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'web-01', help: 'Applied as the instance\'s Name tag.' },
          { key: 'imageId', label: 'AMI', type: 'select', optionsSource: 'amis', required: true, help: 'Latest official images, or pick "Custom AMI ID…" to enter your own.' },
          { key: 'customImageId', label: 'Custom AMI ID', type: 'text', placeholder: 'ami-0abc123...', showWhen: { field: 'imageId', equals: CUSTOM_AMI } },
          { key: 'instanceType', label: 'Instance type', type: 'select', required: true, default: 't3.micro', options: INSTANCE_TYPES.map((t) => ({ label: t, value: t })) },
          { key: 'keyName', label: 'Key pair', type: 'select', optionsSource: 'keyPairs', help: 'SSH key pair for login. Blank = launch without a key.' },
          { key: 'subnetId', label: 'Subnet', type: 'select', optionsSource: 'subnets', help: 'Blank = the account\'s default subnet for this region.' },
          { key: 'securityGroupId', label: 'Security group', type: 'select', optionsSource: 'securityGroups', dependsOn: ['subnetId'], help: 'Filtered to the subnet\'s VPC. Blank = default security group.' },
          { key: 'rootVolumeSize', label: 'Root volume size (GB)', type: 'number', help: 'Blank = the AMI default. Must be at least the AMI default.' },
          { key: 'volumeType', label: 'Root volume type', type: 'select', default: 'gp3', options: [{ label: 'gp3', value: 'gp3' }, { label: 'gp2', value: 'gp2' }], help: 'Applied only when a root volume size is set.' },
          { key: 'userData', label: 'User data (cloud-init)', type: 'textarea', placeholder: '#cloud-config\n...', help: 'Optional startup script run on first boot.' },
          { key: 'count', label: 'How many', type: 'number', default: 1, help: 'Number of identical instances to launch (1–10).' },
        ],
      },
    ],
    help: {
      overview:
        'Connects to a single AWS account and region using an IAM access key. Lists EC2 instances and lets you launch, start, stop, reboot, and terminate them.',
      setupSteps: [
        'In the AWS IAM console, create (or reuse) an IAM user for Cerebro.',
        'Attach a policy granting the EC2 describe/power permissions listed below (AmazonEC2ReadOnlyAccess covers listing; add the power actions to manage state).',
        'Create an access key for that user and paste the Access Key ID and Secret Access Key here.',
        'Enter the region you want to manage (one connection per region — add another connector instance for other regions).',
      ],
      requiredPermissions: [
        'sts:GetCallerIdentity — used by the connection test.',
        'ec2:DescribeInstances, ec2:DescribeRegions — required to list instances (AmazonEC2ReadOnlyAccess covers these).',
        'ec2:StartInstances, ec2:StopInstances, ec2:RebootInstances — required for power actions.',
        'ec2:TerminateInstances — required only if you want to terminate instances from Cerebro.',
        'ec2:RunInstances (+ ec2:CreateTags) — required to launch new instances.',
        'ec2:DescribeImages, ec2:DescribeKeyPairs, ec2:DescribeSubnets, ec2:DescribeSecurityGroups — populate the Launch form (all in AmazonEC2ReadOnlyAccess).',
        'ce:GetCostAndUsage, ce:GetCostForecast — OPTIONAL, for the spend tile. Requires Cost Explorer to be enabled in Billing first; each call is billed ~$0.01 by AWS (Cerebro fetches once a day).',
      ],
      referenceLinks: [
        { label: 'Creating an IAM access key', url: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html' },
        { label: 'AmazonEC2ReadOnlyAccess policy', url: 'https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonEC2ReadOnlyAccess.html' },
        { label: 'EC2 instance lifecycle', url: 'https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html' },
      ],
      notes:
        'Use a dedicated IAM user with least privilege — grant AmazonEC2ReadOnlyAccess for a view-only connection and add only the power actions you want Cerebro to perform. Prefer scoping the policy to the specific region and tags where possible.',
    },
  };

  private authFrom(ctx: ConnectorContext): AwsAuth {
    const c = ctx.config;
    const sessionToken = c.sessionToken != null && `${c.sessionToken}` !== '' ? String(c.sessionToken) : undefined;
    return {
      accessKeyId: String(c.accessKeyId ?? '').trim(),
      secretAccessKey: String(c.secretAccessKey ?? ''),
      region: String(c.region ?? '').trim(),
      sessionToken,
    };
  }

  async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    const auth = this.authFrom(ctx);
    const api = new AwsApi(auth);
    try {
      const id = await api.getCallerIdentity();
      // Confirm EC2 access too, so the test reflects the permissions the connector actually uses.
      await api.describeInstances();

      // Probe Cost Explorer so the user knows whether the spend tile will work. This is
      // one billable (~$0.01) call, made only on an explicit Test. On success it primes
      // the cost cache so the spend tile appears immediately.
      let costStatus: string;
      try {
        const summary = await api.getCostSummary();
        this.costCache.set(auth.accessKeyId, { at: Date.now(), data: summary });
        costStatus = `available — ${summary.currency} ${summary.mtd.toFixed(2)} MTD`;
      } catch (err) {
        const m = err instanceof Error ? err.message : 'error';
        costStatus = `unavailable — enable Cost Explorer + grant ce:GetCostAndUsage/ce:GetCostForecast (${m})`;
        ctx.log('warn', `AWS Cost Explorer probe failed: ${m}`);
      }

      ctx.log('info', `Connected to AWS account ${id.account ?? '?'} as ${id.arn ?? '?'}. Cost Explorer ${costStatus}.`);
      return {
        ok: true,
        message: `Connected to AWS account ${id.account ?? '?'} (${auth.region}). Spend tile: ${costStatus}.`,
        details: { account: id.account ?? '', arn: id.arn ?? '', costExplorer: costStatus },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed.';
      ctx.log('warn', `AWS connection test failed: ${message}`);
      return { ok: false, message };
    }
  }

  async listResources(ctx: ConnectorContext, kind: string): Promise<ConnectorResource[]> {
    if (kind !== EC2_KIND) return [];
    const api = new AwsApi(this.authFrom(ctx));
    const instances = await api.describeInstances();
    return instances
      .filter((i) => i.state !== 'terminated')
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
      .map((i) => this.toResource(i));
  }

  private toResource(i: AwsInstance): ConnectorResource {
    return {
      id: i.id,
      kind: EC2_KIND,
      name: i.name || i.id,
      status: i.state,
      details: {
        instanceId: i.id,
        // Generic keys the shared list/drill-down tables read: `node` (location)
        // and `cpu` (resource summary). EC2 has no node, so surface the AZ/type.
        node: i.az ?? null,
        cpu: i.type ?? null,
        type: i.type ?? null,
        az: i.az ?? null,
        privateIp: i.privateIp ?? null,
        publicIp: i.publicIp ?? null,
      },
      // Structured tags for the list's chips / tag filter (Name is already the
      // display name, so it's omitted here to keep the tag facets meaningful).
      tags: Object.fromEntries(Object.entries(i.tags).filter(([k]) => k !== 'Name')),
    };
  }

  async performAction(
    ctx: ConnectorContext,
    kind: string,
    resourceId: string,
    actionId: string,
  ): Promise<{ ok: boolean; message: string }> {
    if (kind !== EC2_KIND) return { ok: false, message: `Unknown resource kind "${kind}".` };
    const api = new AwsApi(this.authFrom(ctx));
    try {
      switch (actionId) {
        case 'start':
          await api.startInstances([resourceId]);
          break;
        case 'stop':
          await api.stopInstances([resourceId]);
          break;
        case 'force-stop':
          await api.stopInstances([resourceId], true);
          break;
        case 'reboot':
          await api.rebootInstances([resourceId]);
          break;
        default:
          return { ok: false, message: `Unsupported action "${actionId}".` };
      }
      ctx.log('info', `AWS ${actionId} on ${resourceId} requested.`);
      return { ok: true, message: `${actionId} requested for ${resourceId}.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action failed.';
      ctx.log('error', `AWS ${actionId} on ${resourceId} failed: ${message}`);
      return { ok: false, message };
    }
  }

  async describeResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<ConnectorResourceDetail> {
    const api = new AwsApi(this.authFrom(ctx));
    const [inst] = await api.describeInstances([resourceId]);
    if (!inst) throw new Error(`Instance ${resourceId} not found in this region.`);

    const yn = (b?: boolean) => (b === undefined ? '—' : b ? 'Yes' : 'No');
    const vcpus = inst.cpuCores != null ? inst.cpuCores * (inst.cpuThreadsPerCore ?? 1) : undefined;
    const iamProfile = inst.iamProfileArn ? inst.iamProfileArn.split('/').pop() || inst.iamProfileArn : '—';

    const groups: ConnectorDetailGroup[] = [
      {
        title: 'General',
        items: [
          { label: 'Instance ID', value: inst.id, variant: 'mono' },
          { label: 'Name', value: inst.name || '—' },
          { label: 'State', value: inst.state, variant: 'status' },
          ...(inst.stateReason ? [{ label: 'State reason', value: inst.stateReason }] : []),
          { label: 'Type', value: inst.type || '—' },
          { label: 'vCPUs', value: vcpus != null ? String(vcpus) : '—' },
          { label: 'Lifecycle', value: inst.lifecycle ? inst.lifecycle : 'on-demand' },
          { label: 'AMI', value: inst.imageId || '—', variant: 'mono' },
          { label: 'Architecture', value: inst.arch || '—' },
          { label: 'Platform', value: inst.platform || '—' },
          { label: 'Virtualization', value: inst.virtualizationType || '—' },
          { label: 'Key pair', value: inst.keyName || '—' },
          { label: 'IAM role', value: iamProfile, variant: 'mono' },
          { label: 'Tenancy', value: inst.tenancy || '—' },
          { label: 'Monitoring', value: inst.monitoring || '—' },
          { label: 'EBS optimized', value: yn(inst.ebsOptimized) },
          { label: 'ENA', value: yn(inst.enaSupport) },
          { label: 'Launched', value: timeAgo(inst.launchTime) || '—' },
        ],
      },
      {
        title: 'Networking',
        items: [
          { label: 'Availability zone', value: inst.az || '—' },
          { label: 'Private IP', value: inst.privateIp || '—', variant: 'mono' },
          { label: 'Public IP', value: inst.publicIp || '—', variant: 'mono' },
          { label: 'Private DNS', value: inst.privateDns || '—', variant: 'mono' },
          { label: 'Public DNS', value: inst.publicDns || '—', variant: 'mono' },
          { label: 'VPC', value: inst.vpcId || '—', variant: 'mono' },
          { label: 'Subnet', value: inst.subnetId || '—', variant: 'mono' },
          {
            label: 'Security groups',
            value: inst.securityGroups.length
              ? inst.securityGroups.map((g) => `${g.name} (${g.id})`).join(', ')
              : '—',
          },
          ...inst.networkInterfaces.map((n) => ({
            label: `NIC ${n.id ?? ''}`.trim(),
            value: [n.privateIp, n.publicIp ? `→ ${n.publicIp}` : '', n.macAddress ? `· ${n.macAddress}` : '', n.description ? `· ${n.description}` : '']
              .filter(Boolean).join(' ') || '—',
            variant: 'mono' as const,
          })),
        ],
      },
      {
        title: 'Storage',
        items: [
          { label: 'Root device', value: inst.rootDeviceName || '—', variant: 'mono' },
          { label: 'Root device type', value: inst.rootDeviceType || '—' },
          ...(inst.volumes.length
            ? inst.volumes.map((v) => ({
                label: v.device || 'volume',
                value: [v.volumeId ?? '—', v.status ? `(${v.status})` : '', v.deleteOnTermination ? '· delete on termination' : '']
                  .filter(Boolean).join(' '),
                variant: 'mono' as const,
              }))
            : [{ label: 'Volumes', value: '—' }]),
        ],
      },
    ];

    // Every tag on the instance, Name first, then alphabetical.
    const tagKeys = Object.keys(inst.tags).sort((a, b) => (a === 'Name' ? -1 : b === 'Name' ? 1 : a.localeCompare(b)));
    groups.push({
      title: tagKeys.length ? `Tags (${tagKeys.length})` : 'Tags',
      items: tagKeys.length
        ? tagKeys.map((k) => ({ label: k, value: inst.tags[k] || '—' }))
        : [{ label: '—', value: 'No tags assigned' }],
    });

    return { id: inst.id, kind: EC2_KIND, name: inst.name || inst.id, status: inst.state, groups };
  }

  async deleteResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<{ ok: boolean; message: string }> {
    const api = new AwsApi(this.authFrom(ctx));
    try {
      const [inst] = await api.describeInstances([resourceId]);
      if (!inst) return { ok: false, message: `Instance ${resourceId} not found in this region.` };
      if (DEAD_STATES.includes(inst.state)) {
        return { ok: false, message: `Instance ${resourceId} is already ${inst.state}.` };
      }
      await api.terminateInstances([resourceId]);
      ctx.log('warn', `AWS terminated instance ${resourceId} (${inst.name ?? ''}).`);
      return { ok: true, message: `Termination requested for ${inst.name || resourceId}.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Terminate failed.';
      ctx.log('error', `AWS terminate ${resourceId} failed: ${message}`);
      return { ok: false, message };
    }
  }

  /** Cached (24h) month-to-date + forecast spend; null when Cost Explorer isn't available. */
  private async cachedCost(ctx: ConnectorContext, api: AwsApi, accountKey: string): Promise<AwsCostSummary | null> {
    const c = this.costCache.get(accountKey);
    if (c && Date.now() - c.at < (c.data ? COST_TTL_MS : COST_RETRY_MS)) return c.data;
    try {
      const data = await api.getCostSummary();
      this.costCache.set(accountKey, { at: Date.now(), data });
      return data;
    } catch (err) {
      // Cost Explorer not enabled / missing ce:* permissions / transient — omit spend, retry later.
      const m = err instanceof Error ? err.message : 'error';
      ctx.log('warn', `AWS spend hidden — Cost Explorer unavailable: ${m}. Enable Cost Explorer in Billing and grant ce:GetCostAndUsage/ce:GetCostForecast.`);
      this.costCache.set(accountKey, { at: Date.now(), data: null });
      return null;
    }
  }

  async overview(ctx: ConnectorContext): Promise<ConnectorOverview> {
    const auth = this.authFrom(ctx);
    const api = new AwsApi(auth);
    const region = auth.region;
    const instances = (await api.describeInstances()).filter((i) => i.state !== 'terminated');
    const running = instances.filter((i) => i.state === 'running').length;

    // Report against the canonical 'vms*' keys so EC2 rolls up into the
    // dashboard's cross-connector "VMs" tile alongside Proxmox VMs.
    const metrics: OverviewMetric[] = [
      { key: 'vmsRunning', label: 'VMs running', value: running },
      { key: 'vmsTotal', label: 'VMs total', value: instances.length },
    ];

    // Best-effort spend (billable → cached a day). Unit is the currency code so the
    // UI renders it as money, and the dashboard sums it across AWS accounts.
    const cost = await this.cachedCost(ctx, api, auth.accessKeyId);
    if (cost) {
      metrics.push({ key: 'costMtd', label: 'Spend (MTD)', value: round2(cost.mtd), unit: cost.currency });
      metrics.push({ key: 'costForecast', label: 'Est. this month', value: round2(cost.estimated), unit: cost.currency });
    }

    const guests = instances
      .slice()
      .sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || (a.name || a.id).localeCompare(b.name || b.id))
      .slice(0, 40)
      .map((i) => ({ name: i.name || i.id, kind: EC2_KIND, status: i.state, node: i.az || region }));

    return { metrics, guests };
  }

  async resolveOptions(ctx: ConnectorContext, sourceId: string, values: Record<string, unknown>): Promise<ConnectorOption[]> {
    const api = new AwsApi(this.authFrom(ctx));
    switch (sourceId) {
      case 'amis': {
        // Resolve each catalog entry to its latest concrete AMI ID; skip any that don't resolve.
        const settled = await Promise.allSettled(AMI_CATALOG.map((c) => api.latestImage(c.owners, c.name)));
        const opts: ConnectorOption[] = [];
        settled.forEach((r, i) => {
          if (r.status === 'fulfilled' && r.value) {
            opts.push({ label: AMI_CATALOG[i].label, value: r.value.imageId, description: r.value.imageId });
          }
        });
        opts.push({ label: 'Custom AMI ID…', value: CUSTOM_AMI });
        return opts;
      }
      case 'keyPairs': {
        const kps = await api.listKeyPairs();
        return kps.map((k) => ({ label: k.name, value: k.name }));
      }
      case 'subnets': {
        const subs = await api.listSubnets();
        return subs.map((s) => ({
          label: `${s.name ? s.name + ' · ' : ''}${s.id} — ${s.cidr ?? '?'} (${s.az ?? '?'})`,
          value: s.id,
          description: s.vpcId ? `VPC ${s.vpcId}` : undefined,
        }));
      }
      case 'securityGroups': {
        // Scope to the chosen subnet's VPC when one is selected.
        let vpcId: string | undefined;
        if (values.subnetId) {
          const sub = (await api.listSubnets()).find((s) => s.id === values.subnetId);
          vpcId = sub?.vpcId;
        }
        const sgs = await api.listSecurityGroups(vpcId);
        return sgs.map((g) => ({ label: `${g.name ?? g.id} (${g.id})`, value: g.id, description: g.description }));
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
    if (operationId !== 'launch-ec2') return { ok: false, message: `Unknown operation "${operationId}".` };
    const api = new AwsApi(this.authFrom(ctx));
    try {
      const imageId = (values.imageId === CUSTOM_AMI ? String(values.customImageId ?? '') : String(values.imageId ?? '')).trim();
      if (!imageId) return { ok: false, message: 'Choose an AMI or provide a custom AMI ID.' };
      if (!/^ami-[0-9a-f]+$/i.test(imageId)) return { ok: false, message: `"${imageId}" is not a valid AMI ID.` };

      const instanceType = String(values.instanceType || 't3.micro');
      const name = String(values.name ?? '').trim();
      const count = Math.max(1, Math.min(10, Math.floor(Number(values.count) || 1)));

      onProgress(`Preparing to launch ${count} × ${instanceType} from ${imageId}…`);

      let blockDeviceMappings: { DeviceName?: string; Ebs?: { VolumeSize?: number; VolumeType?: string } }[] | undefined;
      const rootSizeRaw = values.rootVolumeSize;
      if (rootSizeRaw != null && `${rootSizeRaw}` !== '') {
        const rootSize = Number(rootSizeRaw);
        if (!Number.isFinite(rootSize) || rootSize <= 0) return { ok: false, message: 'Root volume size must be a positive number of GB.' };
        onProgress('Reading the image\'s root volume…');
        const info = await api.getImageInfo(imageId);
        if (!info) return { ok: false, message: `AMI ${imageId} not found in this region.` };
        if (info.rootDefaultSize && rootSize < info.rootDefaultSize) {
          return { ok: false, message: `Root volume must be at least the AMI default of ${info.rootDefaultSize} GB.` };
        }
        blockDeviceMappings = [
          { DeviceName: info.rootDeviceName, Ebs: { VolumeSize: rootSize, VolumeType: String(values.volumeType || 'gp3') } },
        ];
      }

      const keyName = values.keyName ? String(values.keyName) : undefined;
      const subnetId = values.subnetId ? String(values.subnetId) : undefined;
      const securityGroupId = values.securityGroupId ? String(values.securityGroupId) : undefined;
      const userDataBase64 = values.userData && `${values.userData}` !== ''
        ? Buffer.from(String(values.userData), 'utf8').toString('base64')
        : undefined;

      onProgress(`Launching ${count} instance${count > 1 ? 's' : ''}…`);
      const ids = await api.runInstances({
        imageId,
        instanceType,
        minCount: count,
        maxCount: count,
        keyName,
        subnetId,
        securityGroupIds: securityGroupId ? [securityGroupId] : undefined,
        userDataBase64,
        nameTag: name || undefined,
        blockDeviceMappings,
      });

      if (!ids.length) return { ok: false, message: 'AWS accepted the request but returned no instance IDs.' };
      ctx.log('info', `AWS launched ${ids.join(', ')} (${name || imageId}).`);
      onProgress(`Launched ${ids.join(', ')}.`);
      return {
        ok: true,
        message: `Launched ${ids.length} instance${ids.length > 1 ? 's' : ''}: ${ids.join(', ')}.`,
        createdResourceId: ids[0],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Launch failed.';
      ctx.log('error', `AWS launch failed: ${message}`);
      return { ok: false, message };
    }
  }
}
