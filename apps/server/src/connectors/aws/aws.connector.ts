import type {
  Connector,
  ConnectorContext,
  ConnectorManifest,
  ConnectorResource,
  ConnectorResourceDetail,
  ConnectorDetailGroup,
  ConnectorOverview,
  TestConnectionResult,
} from '@cerebro/shared';
import { AwsApi, AwsAuth, AwsInstance } from './aws-api';

const EC2_KIND = 'ec2';

/** EC2 states in which an instance can no longer be acted upon. */
const DEAD_STATES = ['terminated', 'shutting-down'];

function timeAgo(d?: Date): string | undefined {
  if (!d) return undefined;
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

export class AwsConnector implements Connector {
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
    help: {
      overview:
        'Connects to a single AWS account and region using an IAM access key. Lists EC2 instances and lets you start, stop, reboot, and terminate them.',
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
    const api = new AwsApi(this.authFrom(ctx));
    try {
      const id = await api.getCallerIdentity();
      // Confirm EC2 access too, so the test reflects the permissions the connector actually uses.
      await api.describeInstances();
      ctx.log('info', `Connected to AWS account ${id.account ?? '?'} as ${id.arn ?? '?'}`);
      return {
        ok: true,
        message: `Connected to AWS account ${id.account ?? '?'} (${this.authFrom(ctx).region}).`,
        details: { account: id.account ?? '', arn: id.arn ?? '' },
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
        type: i.type ?? null,
        az: i.az ?? null,
        privateIp: i.privateIp ?? null,
        publicIp: i.publicIp ?? null,
      },
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

    const groups: ConnectorDetailGroup[] = [
      {
        title: 'General',
        items: [
          { label: 'Instance ID', value: inst.id, variant: 'mono' },
          { label: 'Name', value: inst.name || '—' },
          { label: 'State', value: inst.state, variant: 'status' },
          { label: 'Type', value: inst.type || '—' },
          { label: 'AMI', value: inst.imageId || '—', variant: 'mono' },
          { label: 'Architecture', value: inst.arch || '—' },
          { label: 'Platform', value: inst.platform || '—' },
          { label: 'Key pair', value: inst.keyName || '—' },
          { label: 'Monitoring', value: inst.monitoring || '—' },
          { label: 'Launched', value: timeAgo(inst.launchTime) || '—' },
        ],
      },
      {
        title: 'Networking',
        items: [
          { label: 'Availability zone', value: inst.az || '—' },
          { label: 'Private IP', value: inst.privateIp || '—', variant: 'mono' },
          { label: 'Public IP', value: inst.publicIp || '—', variant: 'mono' },
          { label: 'VPC', value: inst.vpcId || '—', variant: 'mono' },
          { label: 'Subnet', value: inst.subnetId || '—', variant: 'mono' },
          {
            label: 'Security groups',
            value: inst.securityGroups.length
              ? inst.securityGroups.map((g) => `${g.name} (${g.id})`).join(', ')
              : '—',
          },
        ],
      },
      {
        title: 'Storage',
        items: [
          { label: 'Root device', value: inst.rootDeviceName || '—', variant: 'mono' },
          { label: 'Root device type', value: inst.rootDeviceType || '—' },
          ...(inst.volumes.length
            ? inst.volumes.map((v) => ({ label: v.device || 'volume', value: v.volumeId || '—', variant: 'mono' as const }))
            : [{ label: 'Volumes', value: '—' }]),
        ],
      },
    ];

    const tagKeys = Object.keys(inst.tags).filter((k) => k !== 'Name').sort();
    if (tagKeys.length) {
      groups.push({
        title: 'Tags',
        items: tagKeys.map((k) => ({ label: k, value: inst.tags[k] || '—' })),
      });
    }

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

  async overview(ctx: ConnectorContext): Promise<ConnectorOverview> {
    const api = new AwsApi(this.authFrom(ctx));
    const region = this.authFrom(ctx).region;
    const instances = (await api.describeInstances()).filter((i) => i.state !== 'terminated');
    const running = instances.filter((i) => i.state === 'running').length;
    const stopped = instances.filter((i) => i.state === 'stopped').length;

    const metrics = [
      { key: 'ec2Running', label: 'EC2 running', value: running },
      { key: 'ec2Stopped', label: 'EC2 stopped', value: stopped },
      { key: 'ec2Total', label: 'EC2 total', value: instances.length },
    ];

    const guests = instances
      .slice()
      .sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || (a.name || a.id).localeCompare(b.name || b.id))
      .slice(0, 40)
      .map((i) => ({ name: i.name || i.id, kind: EC2_KIND, status: i.state, node: i.az || region }));

    return { metrics, guests };
  }
}
