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
import {
  AwsApi, AwsAuth, AwsInstance, AwsCostSummary, AwsEksCluster, AwsEcsCluster, AwsEcsService, AwsEcsTask,
  AwsElasticIp, AwsVolume, AwsRdsInstance, AwsS3Bucket,
  AwsNatGateway, AwsLoadBalancer, AwsEbsSnapshot, AwsRdsSnapshot, AwsLambdaFunction, AwsCloudFrontDistribution, AwsDynamoTable, AwsElastiCacheCluster,
} from './aws-api';

const EC2_KIND = 'ec2';
const EKS_KIND = 'eks';
const ECS_KIND = 'ecs';
const EIP_KIND = 'eip';
const EBS_KIND = 'ebs';
const RDS_KIND = 'rds';
const S3_KIND = 's3';
const NAT_KIND = 'natgw';
const ELB_KIND = 'elb';
const EBSSNAP_KIND = 'ebssnap';
const RDSSNAP_KIND = 'rdssnap';
const LAMBDA_KIND = 'lambda';
const CF_KIND = 'cloudfront';
const DDB_KIND = 'dynamodb';
const CACHE_KIND = 'elasticache';

function fmtBytes(n?: number): string {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/** A complete IAM policy enabling every AWS-connector feature (view + manage). Shown on the setup screen. */
const AWS_FULL_POLICY = JSON.stringify(
  {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'CerebroIdentityAndCost',
        Effect: 'Allow',
        Action: ['sts:GetCallerIdentity', 'ce:GetCostAndUsage', 'ce:GetCostForecast'],
        Resource: '*',
      },
      {
        Sid: 'CerebroEc2',
        Effect: 'Allow',
        Action: [
          'ec2:DescribeInstances', 'ec2:DescribeRegions', 'ec2:DescribeImages',
          'ec2:DescribeKeyPairs', 'ec2:DescribeSubnets', 'ec2:DescribeSecurityGroups',
          'ec2:DescribeVolumes', 'ec2:DescribeAddresses', 'ec2:DescribeNatGateways', 'ec2:DescribeSnapshots',
          'ec2:StartInstances', 'ec2:StopInstances', 'ec2:RebootInstances',
          'ec2:TerminateInstances', 'ec2:RunInstances', 'ec2:CreateTags',
          'ec2:DeleteVolume', 'ec2:ReleaseAddress',
        ],
        Resource: '*',
      },
      {
        Sid: 'CerebroContainers',
        Effect: 'Allow',
        Action: [
          'eks:ListClusters', 'eks:DescribeCluster', 'eks:ListNodegroups', 'eks:DescribeNodegroup',
          'eks:UpdateNodegroupConfig',
          'ecs:ListClusters', 'ecs:DescribeClusters', 'ecs:ListServices', 'ecs:DescribeServices',
          'ecs:ListTasks', 'ecs:DescribeTasks', 'ecs:UpdateService', 'ecs:StopTask',
        ],
        Resource: '*',
      },
      {
        Sid: 'CerebroDataAndDiscovery',
        Effect: 'Allow',
        Action: [
          'rds:DescribeDBInstances', 'rds:ListTagsForResource', 'rds:DescribeDBSnapshots',
          'rds:StartDBInstance', 'rds:StopDBInstance', 'rds:RebootDBInstance',
          's3:ListAllMyBuckets', 's3:GetBucketLocation',
          'elasticloadbalancing:DescribeLoadBalancers',
          'lambda:ListFunctions',
          'cloudfront:ListDistributions', 'cloudfront:GetDistributionConfig', 'cloudfront:UpdateDistribution',
          'dynamodb:ListTables', 'dynamodb:DescribeTable',
          'elasticache:DescribeCacheClusters',
        ],
        Resource: '*',
      },
    ],
  },
  null,
  2,
);
function ymd(d?: Date): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}
function humanize(key: string): string {
  const s = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Per-kind label overrides for the generic discovery detail (details keys → human labels). */
const DISCOVERY_LABELS: Record<string, Record<string, string>> = {
  natgw: { node: 'Subnet', ip: 'Public IP', connectivity: 'Connectivity', vpc: 'VPC' },
  elb: { node: 'Scheme', cpu: 'Type', ip: 'DNS name', azs: 'Availability zones', vpc: 'VPC' },
  ebssnap: { node: 'Source volume', cpu: 'Size', created: 'Created', description: 'Description', encrypted: 'Encrypted' },
  rdssnap: { node: 'Source database', cpu: 'Engine / size', type: 'Type', created: 'Created' },
  lambda: { node: 'Architecture', cpu: 'Runtime / memory', code: 'Code size', modified: 'Last modified' },
  cloudfront: { node: 'Deployment status', ip: 'Domain name', aliases: 'Aliases', comment: 'Comment' },
  dynamodb: { node: 'Billing mode', cpu: 'Items', size: 'Size' },
  elasticache: { node: 'Node type', cpu: 'Engine', nodes: 'Nodes' },
};

function bytesGb(gb?: number): string {
  return gb != null ? `${gb} GB` : '—';
}

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

  /**
   * Remembers the last non-zero desired task count per ECS service (keyed
   * account:cluster:service) so "Start" after a "Stop" can restore the prior
   * scale instead of guessing. In-memory only — falls back to 1 if unknown
   * (e.g. after a restart, or a service stopped outside Cerebro).
   */
  private ecsDesiredMemory = new Map<string, number>();

  manifest: ConnectorManifest = {
    id: 'aws',
    name: 'Amazon Web Services',
    description: 'Manage EC2 instances and view/manage EKS, ECS, RDS, EBS, Elastic IPs, and S3 across an AWS account, plus spend by service.',
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
      {
        id: EKS_KIND,
        label: 'EKS Clusters',
        // Cluster itself is read-only; drill in to scale its managed node groups.
        actions: [],
        deletable: false,
        subResources: [
          {
            id: 'nodegroup',
            label: 'Node groups',
            labelSingular: 'node group',
            itemActions: [
              { id: 'scale', label: 'Scale', operationId: 'eks-scale-nodegroup', paramKey: 'nodegroup' },
            ],
          },
        ],
      },
      {
        id: ECS_KIND,
        label: 'ECS Clusters',
        actions: [],
        deletable: false,
        subResources: [
          {
            id: 'service',
            label: 'Services',
            labelSingular: 'service',
            itemActions: [
              { id: 'start', label: 'Start', operationId: 'ecs-start-service', paramKey: 'service' },
              { id: 'stop', label: 'Stop', operationId: 'ecs-stop-service', paramKey: 'service', confirm: 'Stop this service (scale to 0 tasks)? Cerebro remembers the current task count so Start can restore it.', intent: 'destructive' },
              { id: 'scale', label: 'Scale', operationId: 'ecs-scale-service', paramKey: 'service' },
              { id: 'redeploy', label: 'Redeploy', operationId: 'ecs-redeploy-service', paramKey: 'service', confirm: 'Force a new deployment of this service (rolling restart)?' },
            ],
          },
          {
            id: 'task',
            label: 'Tasks',
            labelSingular: 'task',
            itemActions: [
              { id: 'stop', label: 'Stop', operationId: 'ecs-stop-task', paramKey: 'task', confirm: 'Stop this task? ECS will start a replacement if a service manages it.', intent: 'destructive' },
            ],
          },
        ],
      },
      {
        id: RDS_KIND,
        label: 'RDS Databases',
        actions: [
          { id: 'start', label: 'Start', mutating: true, showWhenStatus: ['stopped'] },
          { id: 'stop', label: 'Stop', mutating: true, confirm: 'Stop this database? RDS auto-starts it again after 7 days.', showWhenStatus: ['available'] },
          { id: 'reboot', label: 'Reboot', mutating: true, confirm: 'Reboot this database?', showWhenStatus: ['available'] },
        ],
        deletable: false,
      },
      {
        id: EBS_KIND,
        label: 'EBS Volumes',
        actions: [],
        // Deletable via the drawer, but only when the volume is unattached (guarded server-side).
        deletable: true,
      },
      {
        id: EIP_KIND,
        label: 'Elastic IPs',
        actions: [
          { id: 'release', label: 'Release', mutating: true, confirm: 'Release this Elastic IP back to AWS? This frees it (and its charge) but the address is lost.', showWhenStatus: ['unassociated'], intent: 'destructive' },
        ],
        deletable: false,
      },
      {
        id: S3_KIND,
        label: 'S3 Buckets',
        actions: [],
        deletable: false,
      },
      // Delete unblocks cost cleanup / teardown. Guarded server-side + typed-name confirm in the UI.
      { id: NAT_KIND, label: 'NAT Gateways', actions: [], deletable: true },
      { id: ELB_KIND, label: 'Load Balancers', actions: [], deletable: true },
      { id: EBSSNAP_KIND, label: 'EBS Snapshots', actions: [], deletable: true },
      { id: RDSSNAP_KIND, label: 'RDS Snapshots', actions: [], deletable: true },
      { id: LAMBDA_KIND, label: 'Lambda', actions: [], deletable: false },
      {
        id: CF_KIND,
        label: 'CloudFront',
        actions: [
          { id: 'enable', label: 'Enable', mutating: true, showWhenStatus: ['disabled'] },
          { id: 'disable', label: 'Disable', mutating: true, confirm: 'Disable this distribution? It stops serving content until re-enabled (deployment takes a few minutes).', showWhenStatus: ['enabled'], intent: 'destructive' },
        ],
        deletable: false,
      },
      { id: DDB_KIND, label: 'DynamoDB', actions: [], deletable: true },
      {
        id: CACHE_KIND,
        label: 'ElastiCache',
        actions: [
          { id: 'reboot', label: 'Reboot', mutating: true, confirm: 'Reboot every node in this cache cluster? Brief unavailability during the restart.', showWhenStatus: ['available'] },
        ],
        deletable: true,
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
      {
        id: 'ecs-scale-service',
        label: 'Scale service',
        description: 'Set how many tasks an ECS service runs (0 to stop it).',
        scope: 'resource',
        kind: ECS_KIND,
        submitLabel: 'Scale',
        prefill: true,
        fields: [
          { key: 'desiredCount', label: 'Desired task count', type: 'number', required: true, help: 'Number of tasks the service should run (0 stops it).' },
        ],
      },
      {
        id: 'ecs-redeploy-service',
        label: 'Redeploy service',
        scope: 'resource',
        kind: ECS_KIND,
        fields: [],
      },
      {
        id: 'ecs-stop-task',
        label: 'Stop task',
        scope: 'resource',
        kind: ECS_KIND,
        intent: 'destructive',
        fields: [],
      },
      {
        id: 'ecs-start-service',
        label: 'Start service',
        description: 'Scale a stopped service back up to its previous task count.',
        scope: 'resource',
        kind: ECS_KIND,
        fields: [],
      },
      {
        id: 'ecs-stop-service',
        label: 'Stop service',
        description: 'Scale a service down to 0 tasks (remembering the count so Start can restore it).',
        scope: 'resource',
        kind: ECS_KIND,
        intent: 'destructive',
        fields: [],
      },
      {
        id: 'eks-scale-nodegroup',
        label: 'Scale node group',
        description: 'Set the desired, minimum, and maximum node counts for a managed node group.',
        scope: 'resource',
        kind: EKS_KIND,
        submitLabel: 'Scale',
        prefill: true,
        fields: [
          { key: 'desiredSize', label: 'Desired nodes', type: 'number', required: true, help: 'Number of nodes the group should run (0 to scale it to nothing).' },
          { key: 'minSize', label: 'Minimum nodes', type: 'number', required: true, help: 'Lower bound the autoscaler respects.' },
          { key: 'maxSize', label: 'Maximum nodes', type: 'number', required: true, help: 'Upper bound the autoscaler respects.' },
        ],
      },
    ],
    help: {
      overview:
        'Connects to a single AWS account and region using an IAM access key. Lists EC2 instances (launch, start, stop, reboot, terminate), EKS clusters (drill in to scale managed node groups), and ECS clusters (drill in to start/stop/scale/redeploy services and stop tasks). CloudFront distributions can be enabled/disabled, and RDS/EBS/Elastic IP tabs offer their own safe actions.',
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
        'eks:ListClusters, eks:DescribeCluster, eks:ListNodegroups, eks:DescribeNodegroup — OPTIONAL, to list EKS clusters and node groups. No AWS-managed read policy covers these for a user; attach a small custom policy with these actions (Resource "*"). eks:UpdateNodegroupConfig — to scale managed node groups (min/max/desired) from Cerebro.',
        'ecs:ListClusters, ecs:DescribeClusters, ecs:ListServices, ecs:DescribeServices, ecs:ListTasks, ecs:DescribeTasks — OPTIONAL, to list ECS clusters, services, and tasks.',
        'ecs:UpdateService, ecs:StopTask — OPTIONAL, to start/stop/scale/redeploy services and stop tasks from Cerebro (Start/Stop are scale-to-previous / scale-to-0).',
        'rds:DescribeDBInstances (+ ListTagsForResource), rds:StartDBInstance/StopDBInstance/RebootDBInstance — OPTIONAL, to view and start/stop/reboot RDS databases.',
        'ec2:DescribeVolumes, ec2:DescribeAddresses — OPTIONAL, for the EBS Volumes and Elastic IPs tabs (in AmazonEC2ReadOnlyAccess). ec2:DeleteVolume, ec2:ReleaseAddress — to delete unattached volumes / release idle Elastic IPs.',
        's3:ListAllMyBuckets, s3:GetBucketLocation — OPTIONAL, for the S3 Buckets tab (buckets are global — shows all buckets in the account).',
        'Discovery tabs (read-only): ec2:DescribeNatGateways, ec2:DescribeSnapshots, elasticloadbalancing:DescribeLoadBalancers, rds:DescribeDBSnapshots, lambda:ListFunctions, cloudfront:ListDistributions, dynamodb:ListTables + dynamodb:DescribeTable, elasticache:DescribeCacheClusters. cloudfront:GetDistributionConfig + cloudfront:UpdateDistribution — to enable/disable CloudFront distributions from Cerebro.',
      ],
      referenceLinks: [
        { label: 'Creating an IAM access key', url: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html' },
        { label: 'AmazonEC2ReadOnlyAccess policy', url: 'https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonEC2ReadOnlyAccess.html' },
        { label: 'EC2 instance lifecycle', url: 'https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html' },
      ],
      notes:
        'Use a dedicated IAM user with least privilege — grant AmazonEC2ReadOnlyAccess for a view-only connection and add only the power actions you want Cerebro to perform. Prefer scoping the policy to the specific region and tags where possible.',
      codeSamples: [
        {
          title: 'Full IAM policy (all connector features)',
          description:
            'Attach this to the Cerebro IAM user (or a group) to enable every tab and action. It includes management (EC2/RDS start-stop, ECS scale, delete unattached volumes, release Elastic IPs) — remove the write actions you don\'t want. Cost Explorer must also be enabled in the Billing console. Resource is "*" because most describe/list actions don\'t support resource scoping.',
          language: 'json',
          code: AWS_FULL_POLICY,
        },
      ],
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
    const api = new AwsApi(this.authFrom(ctx));
    if (kind === EKS_KIND) {
      const clusters = await api.listEksClusters();
      return clusters
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => this.toEksResource(c));
    }
    if (kind === ECS_KIND) {
      const clusters = await api.listEcsClusters();
      return clusters
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => this.toEcsResource(c));
    }
    if (kind === RDS_KIND) {
      const dbs = await api.listRdsInstances();
      return dbs.slice().sort((a, b) => a.id.localeCompare(b.id)).map((d) => this.toRdsResource(d));
    }
    if (kind === EBS_KIND) {
      const vols = await api.listVolumes();
      return vols.slice().sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)).map((v) => this.toEbsResource(v));
    }
    if (kind === EIP_KIND) {
      const eips = await api.listElasticIps();
      return eips.slice().sort((a, b) => (a.publicIp || '').localeCompare(b.publicIp || '')).map((e) => this.toEipResource(e));
    }
    if (kind === S3_KIND) {
      const buckets = await api.listS3Buckets();
      return buckets.slice().sort((a, b) => a.name.localeCompare(b.name)).map((b) => this.toS3Resource(b));
    }
    if (kind === NAT_KIND) {
      return (await api.listNatGateways()).map((n) => ({
        id: n.id, kind, name: n.name || n.id, status: n.state.toLowerCase(),
        details: { node: n.subnetId ?? null, ip: n.publicIp ?? null, connectivity: n.connectivityType ?? null, vpc: n.vpcId ?? null },
        tags: n.tags,
      }));
    }
    if (kind === ELB_KIND) {
      return (await api.listLoadBalancers()).sort((a, b) => a.name.localeCompare(b.name)).map((lb) => ({
        id: lb.name, kind, name: lb.name, status: (lb.state || '').toLowerCase() || 'active',
        details: { node: lb.scheme ?? null, cpu: lb.type ?? null, ip: lb.dnsName ?? null, azs: lb.azCount != null ? `${lb.azCount} AZs` : null, vpc: lb.vpcId ?? null },
      }));
    }
    if (kind === EBSSNAP_KIND) {
      return (await api.listEbsSnapshots()).sort((a, b) => (b.startTime?.getTime() ?? 0) - (a.startTime?.getTime() ?? 0)).map((s) => ({
        id: s.id, kind, name: s.name || s.id, status: (s.state || '').toLowerCase(),
        details: { node: s.volumeId ?? null, cpu: s.sizeGb != null ? `${s.sizeGb} GB` : null, created: ymd(s.startTime), description: s.description ?? null, encrypted: s.encrypted ? 'yes' : 'no' },
        tags: s.tags,
      }));
    }
    if (kind === RDSSNAP_KIND) {
      return (await api.listRdsSnapshots()).sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)).map((s) => ({
        id: s.id, kind, name: s.id, status: (s.status || '').toLowerCase(),
        details: { node: s.dbInstanceId ?? null, cpu: [s.engine, s.sizeGb != null ? `${s.sizeGb} GB` : null].filter(Boolean).join(' · ') || null, type: s.type ?? null, created: ymd(s.createdAt) },
      }));
    }
    if (kind === LAMBDA_KIND) {
      return (await api.listLambdaFunctions()).sort((a, b) => a.name.localeCompare(b.name)).map((f) => ({
        id: f.name, kind, name: f.name, status: f.runtime || 'fn',
        details: { node: f.arch ?? null, cpu: [f.runtime, f.memoryMb != null ? `${f.memoryMb} MB` : null].filter(Boolean).join(' · ') || null, code: fmtBytes(f.codeSizeBytes), modified: f.lastModified ? f.lastModified.slice(0, 10) : null },
      }));
    }
    if (kind === CF_KIND) {
      // Status pill reflects the ENABLED axis (what the actions toggle); the
      // deployment state (Deployed/InProgress) is surfaced as a detail instead.
      return (await api.listCloudFrontDistributions()).map((d) => ({
        id: d.id, kind, name: d.aliases[0] || d.domainName || d.id, status: d.enabled ? 'enabled' : 'disabled',
        details: { node: d.status ?? null, ip: d.domainName ?? null, aliases: d.aliases.join(', ') || null, comment: d.comment ?? null },
      }));
    }
    if (kind === DDB_KIND) {
      return (await api.listDynamoTables()).sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({
        id: t.name, kind, name: t.name, status: (t.status || '').toLowerCase() || 'active',
        details: { node: t.billingMode ?? null, cpu: t.itemCount != null ? `${t.itemCount.toLocaleString()} items` : null, size: fmtBytes(t.sizeBytes) },
      }));
    }
    if (kind === CACHE_KIND) {
      return (await api.listElastiCacheClusters()).sort((a, b) => a.id.localeCompare(b.id)).map((c) => ({
        id: c.id, kind, name: c.id, status: (c.status || '').toLowerCase(),
        details: { node: c.nodeType ?? null, cpu: [c.engine, c.engineVersion].filter(Boolean).join(' ') || null, nodes: c.nodes != null ? `${c.nodes} node${c.nodes === 1 ? '' : 's'}` : null },
      }));
    }
    if (kind !== EC2_KIND) return [];
    const instances = await api.describeInstances();
    return instances
      .filter((i) => i.state !== 'terminated')
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
      .map((i) => this.toResource(i));
  }

  private toRdsResource(d: AwsRdsInstance): ConnectorResource {
    return {
      id: d.id,
      kind: RDS_KIND,
      name: d.id,
      status: d.status.toLowerCase(),
      details: {
        node: d.az ?? null,
        cpu: [d.engine, d.instanceClass].filter(Boolean).join(' · ') || null,
        ip: d.endpoint ?? null,
        engine: d.engineVersion ? `${d.engine ?? ''} ${d.engineVersion}` : d.engine ?? null,
        storage: d.allocatedStorageGb != null ? `${d.allocatedStorageGb} GB ${d.storageType ?? ''}`.trim() : null,
        multiAZ: d.multiAZ ? 'yes' : 'no',
      },
      tags: d.tags,
    };
  }

  private toEbsResource(v: AwsVolume): ConnectorResource {
    return {
      id: v.id,
      kind: EBS_KIND,
      name: v.name || v.id,
      status: v.state.toLowerCase(), // available (unattached) | in-use | ...
      details: {
        node: v.az ?? null,
        cpu: [bytesGb(v.sizeGb), v.volumeType].filter((x) => x && x !== '—').join(' · ') || null,
        attachedTo: v.attachedInstanceId ?? null,
        iops: v.iops != null ? String(v.iops) : null,
        encrypted: v.encrypted ? 'yes' : 'no',
      },
      tags: v.tags,
    };
  }

  private toEipResource(e: AwsElasticIp): ConnectorResource {
    return {
      id: e.allocationId,
      kind: EIP_KIND,
      name: e.name || e.publicIp || e.allocationId,
      status: e.associated ? 'associated' : 'unassociated',
      details: {
        ip: e.publicIp ?? null,
        allocationId: e.allocationId,
        attachedTo: e.instanceId ?? e.networkInterfaceId ?? null,
        privateIp: e.privateIp ?? null,
      },
      tags: e.tags,
    };
  }

  private toS3Resource(b: AwsS3Bucket): ConnectorResource {
    return {
      id: b.name,
      kind: S3_KIND,
      name: b.name,
      // Buckets have no lifecycle status; surface the region here so the pill isn't empty.
      status: b.region || 'bucket',
      details: {
        node: b.region ?? null,
        created: b.createdAt ? b.createdAt.toISOString().slice(0, 10) : null,
      },
    };
  }

  private toEcsResource(c: AwsEcsCluster): ConnectorResource {
    return {
      id: c.name,
      kind: ECS_KIND,
      name: c.name,
      status: c.status.toLowerCase(), // ACTIVE → active
      details: {
        // Generic table columns: node (tasks) / cpu (services).
        node: `${c.runningTasks ?? 0} running${c.pendingTasks ? ` / ${c.pendingTasks} pending` : ''} task${(c.runningTasks ?? 0) === 1 ? '' : 's'}`,
        cpu: `${c.activeServices ?? 0} service${(c.activeServices ?? 0) === 1 ? '' : 's'}`,
        launchType: c.capacityProviders?.length ? c.capacityProviders.join(', ') : null,
      },
      tags: c.tags,
    };
  }

  private toEksResource(c: AwsEksCluster): ConnectorResource {
    return {
      id: c.name,
      kind: EKS_KIND,
      name: c.name,
      status: c.status.toLowerCase(), // ACTIVE → active (status pill picks it up)
      details: {
        // Generic table columns: node (version) / cpu (node groups summary).
        node: c.version ? `k8s ${c.version}` : null,
        cpu: `${c.nodegroups.length} node group${c.nodegroups.length === 1 ? '' : 's'}`,
        version: c.version ?? null,
        platformVersion: c.platformVersion ?? null,
      },
      tags: c.tags,
    };
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
        // Show private + public together; tag the public one when it's an Elastic IP.
        ip: [i.privateIp, i.publicIp ? `${i.publicIp}${i.publicIpElastic ? ' (EIP)' : ''}` : null].filter(Boolean).join(' · ') || null,
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
    const api = new AwsApi(this.authFrom(ctx));
    try {
      if (kind === RDS_KIND) {
        switch (actionId) {
          case 'start': await api.startRds(resourceId); break;
          case 'stop': await api.stopRds(resourceId); break;
          case 'reboot': await api.rebootRds(resourceId); break;
          default: return { ok: false, message: `Unsupported action "${actionId}".` };
        }
        ctx.log('info', `AWS RDS ${actionId} on ${resourceId} requested.`);
        return { ok: true, message: `${actionId} requested for ${resourceId}.` };
      }
      if (kind === EIP_KIND) {
        if (actionId !== 'release') return { ok: false, message: `Unsupported action "${actionId}".` };
        await api.releaseElasticIp(resourceId);
        ctx.log('warn', `AWS released Elastic IP ${resourceId}.`);
        return { ok: true, message: `Released Elastic IP ${resourceId}.` };
      }
      if (kind === CACHE_KIND) {
        if (actionId !== 'reboot') return { ok: false, message: `Unsupported action "${actionId}".` };
        await api.rebootElastiCache(resourceId);
        ctx.log('info', `AWS ElastiCache reboot on ${resourceId} requested.`);
        return { ok: true, message: `Reboot requested for ${resourceId} — nodes restart shortly.` };
      }
      if (kind === CF_KIND) {
        if (actionId !== 'enable' && actionId !== 'disable') return { ok: false, message: `Unsupported action "${actionId}".` };
        const want = actionId === 'enable';
        const changed = await api.setCloudFrontEnabled(resourceId, want);
        ctx.log(want ? 'info' : 'warn', `AWS CloudFront ${resourceId} ${changed ? `${actionId}d` : `already ${actionId}d`}.`);
        return {
          ok: true,
          message: changed
            ? `${want ? 'Enabling' : 'Disabling'} ${resourceId} — CloudFront is deploying the change (a few minutes).`
            : `${resourceId} is already ${want ? 'enabled' : 'disabled'}.`,
        };
      }
      if (kind !== EC2_KIND) return { ok: false, message: `Unknown resource kind "${kind}".` };
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

  private async describeEks(api: AwsApi, name: string): Promise<ConnectorResourceDetail> {
    const c = await api.describeEksCluster(name, true);
    const groups: ConnectorDetailGroup[] = [
      {
        title: 'General',
        items: [
          { label: 'Cluster', value: c.name, variant: 'mono' },
          { label: 'Status', value: c.status.toLowerCase(), variant: 'status' },
          { label: 'Kubernetes version', value: c.version || '—' },
          { label: 'Platform version', value: c.platformVersion || '—' },
          { label: 'ARN', value: c.arn || '—', variant: 'mono' },
          { label: 'Cluster IAM role', value: c.roleArn ? c.roleArn.split('/').pop() || c.roleArn : '—', variant: 'mono' },
          { label: 'Created', value: timeAgo(c.createdAt) || '—' },
        ],
      },
      {
        title: 'Networking',
        items: [
          { label: 'API endpoint', value: c.endpoint || '—', variant: 'mono' },
          { label: 'Public access', value: c.endpointPublicAccess ? 'Yes' : 'No' },
          { label: 'Private access', value: c.endpointPrivateAccess ? 'Yes' : 'No' },
          { label: 'VPC', value: c.vpcId || '—', variant: 'mono' },
          { label: 'Subnets', value: c.subnetIds?.length ? c.subnetIds.join(', ') : '—', variant: 'mono' },
          { label: 'Security groups', value: c.securityGroupIds?.length ? c.securityGroupIds.join(', ') : '—', variant: 'mono' },
        ],
      },
      {
        title: c.nodegroups.length ? `Node groups (${c.nodegroups.length})` : 'Node groups',
        items: c.nodegroups.length
          ? c.nodegroups.map((ng) => ({
              label: ng.name,
              value: [
                ng.status?.toLowerCase(),
                (ng.instanceTypes ?? []).join('/') || undefined,
                ng.desiredSize != null ? `${ng.desiredSize} nodes (min ${ng.minSize ?? '?'}, max ${ng.maxSize ?? '?'})` : undefined,
                ng.capacityType,
              ].filter(Boolean).join(' · ') || '—',
            }))
          : [{ label: '—', value: 'No managed node groups' }],
      },
    ];

    const tagKeys = Object.keys(c.tags).sort((a, b) => a.localeCompare(b));
    groups.push({
      title: tagKeys.length ? `Tags (${tagKeys.length})` : 'Tags',
      items: tagKeys.length
        ? tagKeys.map((k) => ({ label: k, value: c.tags[k] || '—' }))
        : [{ label: '—', value: 'No tags assigned' }],
    });

    return { id: c.name, kind: EKS_KIND, name: c.name, status: c.status.toLowerCase(), groups };
  }

  private async describeEcs(api: AwsApi, nameOrArn: string): Promise<ConnectorResourceDetail> {
    const c = await api.describeEcsCluster(nameOrArn, true);
    const groups: ConnectorDetailGroup[] = [
      {
        title: 'General',
        items: [
          { label: 'Cluster', value: c.name, variant: 'mono' },
          { label: 'Status', value: c.status.toLowerCase(), variant: 'status' },
          { label: 'Running tasks', value: String(c.runningTasks ?? 0) },
          { label: 'Pending tasks', value: String(c.pendingTasks ?? 0) },
          { label: 'Active services', value: String(c.activeServices ?? 0) },
          { label: 'Container instances', value: String(c.containerInstances ?? 0) },
          { label: 'Capacity providers', value: c.capacityProviders?.length ? c.capacityProviders.join(', ') : '—' },
          { label: 'ARN', value: c.arn || '—', variant: 'mono' },
        ],
      },
      {
        title: c.services.length ? `Services (${c.services.length})` : 'Services',
        items: c.services.length
          ? c.services.map((s) => ({
              label: s.name,
              value: [
                s.status?.toLowerCase(),
                `${s.running ?? 0}/${s.desired ?? 0} running${s.pending ? ` (${s.pending} pending)` : ''}`,
                s.launchType,
              ].filter(Boolean).join(' · ') || '—',
            }))
          : [{ label: '—', value: 'No services' }],
      },
    ];

    const tagKeys = Object.keys(c.tags).sort((a, b) => a.localeCompare(b));
    groups.push({
      title: tagKeys.length ? `Tags (${tagKeys.length})` : 'Tags',
      items: tagKeys.length
        ? tagKeys.map((k) => ({ label: k, value: c.tags[k] || '—' }))
        : [{ label: '—', value: 'No tags assigned' }],
    });

    return { id: c.name, kind: ECS_KIND, name: c.name, status: c.status.toLowerCase(), groups };
  }

  private tagsGroup(tags: Record<string, string>): ConnectorDetailGroup {
    const keys = Object.keys(tags).filter((k) => k !== 'Name').sort((a, b) => a.localeCompare(b));
    return {
      title: keys.length ? `Tags (${keys.length})` : 'Tags',
      items: keys.length ? keys.map((k) => ({ label: k, value: tags[k] || '—' })) : [{ label: '—', value: 'No tags assigned' }],
    };
  }

  private async describeRds(api: AwsApi, id: string): Promise<ConnectorResourceDetail> {
    const [d] = await api.listRdsInstances([id]);
    if (!d) throw new Error(`RDS instance ${id} not found in this region.`);
    const groups: ConnectorDetailGroup[] = [
      {
        title: 'General',
        items: [
          { label: 'Identifier', value: d.id, variant: 'mono' },
          { label: 'Status', value: d.status.toLowerCase(), variant: 'status' },
          { label: 'Engine', value: [d.engine, d.engineVersion].filter(Boolean).join(' ') || '—' },
          { label: 'Instance class', value: d.instanceClass || '—' },
          { label: 'Storage', value: d.allocatedStorageGb != null ? `${d.allocatedStorageGb} GB ${d.storageType ?? ''}`.trim() : '—' },
          { label: 'Multi-AZ', value: d.multiAZ ? 'Yes' : 'No' },
          { label: 'Availability zone', value: d.az || '—' },
          { label: 'Publicly accessible', value: d.publiclyAccessible ? 'Yes' : 'No' },
          { label: 'ARN', value: d.arn || '—', variant: 'mono' },
        ],
      },
      {
        title: 'Connection',
        items: [
          { label: 'Endpoint', value: d.endpoint || '—', variant: 'mono' },
          { label: 'Port', value: d.port != null ? String(d.port) : '—' },
        ],
      },
      this.tagsGroup(d.tags),
    ];
    return { id: d.id, kind: RDS_KIND, name: d.id, status: d.status.toLowerCase(), groups };
  }

  private async describeEbs(api: AwsApi, id: string): Promise<ConnectorResourceDetail> {
    const v = (await api.listVolumes()).find((x) => x.id === id);
    if (!v) throw new Error(`Volume ${id} not found in this region.`);
    const groups: ConnectorDetailGroup[] = [
      {
        title: 'General',
        items: [
          { label: 'Volume ID', value: v.id, variant: 'mono' },
          { label: 'Name', value: v.name || '—' },
          { label: 'State', value: v.state.toLowerCase(), variant: 'status' },
          { label: 'Size', value: bytesGb(v.sizeGb) },
          { label: 'Type', value: v.volumeType || '—' },
          { label: 'IOPS', value: v.iops != null ? String(v.iops) : '—' },
          { label: 'Throughput', value: v.throughput != null ? `${v.throughput} MB/s` : '—' },
          { label: 'Encrypted', value: v.encrypted ? 'Yes' : 'No' },
          { label: 'Availability zone', value: v.az || '—' },
          { label: 'Attached to', value: v.attachedInstanceId ? `${v.attachedInstanceId}${v.attachedDevice ? ` (${v.attachedDevice})` : ''}` : '— (unattached)' },
        ],
      },
      this.tagsGroup(v.tags),
    ];
    return { id: v.id, kind: EBS_KIND, name: v.name || v.id, status: v.state.toLowerCase(), groups };
  }

  private async describeEip(api: AwsApi, allocationId: string): Promise<ConnectorResourceDetail> {
    const e = (await api.listElasticIps()).find((x) => x.allocationId === allocationId);
    if (!e) throw new Error(`Elastic IP ${allocationId} not found in this region.`);
    const groups: ConnectorDetailGroup[] = [
      {
        title: 'General',
        items: [
          { label: 'Public IP', value: e.publicIp || '—', variant: 'mono' },
          { label: 'Allocation ID', value: e.allocationId, variant: 'mono' },
          { label: 'Status', value: e.associated ? 'associated' : 'unassociated', variant: 'status' },
          { label: 'Associated instance', value: e.instanceId || '—', variant: 'mono' },
          { label: 'Network interface', value: e.networkInterfaceId || '—', variant: 'mono' },
          { label: 'Private IP', value: e.privateIp || '—', variant: 'mono' },
          { label: 'Domain', value: e.domain || '—' },
        ],
      },
      this.tagsGroup(e.tags),
    ];
    return { id: e.allocationId, kind: EIP_KIND, name: e.name || e.publicIp || e.allocationId, status: e.associated ? 'associated' : 'unassociated', groups };
  }

  private async describeS3(api: AwsApi, name: string): Promise<ConnectorResourceDetail> {
    const b = (await api.listS3Buckets()).find((x) => x.name === name);
    if (!b) throw new Error(`Bucket ${name} not found.`);
    return {
      id: b.name,
      kind: S3_KIND,
      name: b.name,
      status: b.region || 'bucket',
      groups: [
        {
          title: 'General',
          items: [
            { label: 'Bucket', value: b.name, variant: 'mono' },
            { label: 'Region', value: b.region || '—' },
            { label: 'Created', value: b.createdAt ? b.createdAt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '—' },
          ],
        },
      ],
    };
  }

  /** Detail for the read-only discovery kinds: re-list, find the row, render its details + tags. */
  private async genericDetail(ctx: ConnectorContext, kind: string, resourceId: string): Promise<ConnectorResourceDetail> {
    const r = (await this.listResources(ctx, kind)).find((x) => x.id === resourceId);
    if (!r) throw new Error(`${kind} ${resourceId} not found in this region.`);
    const labels = DISCOVERY_LABELS[kind] ?? {};
    const items = Object.entries(r.details ?? {})
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => ({ label: labels[k] ?? humanize(k), value: String(v), variant: (k === 'ip' || k === 'node') ? ('mono' as const) : undefined }));
    items.unshift({ label: 'ID', value: r.id, variant: 'mono' as const });
    const groups: ConnectorDetailGroup[] = [{ title: 'General', items }];
    if (r.tags && Object.keys(r.tags).length) groups.push(this.tagsGroup(r.tags));
    return { id: r.id, kind, name: r.name, status: r.status, groups };
  }

  async describeResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<ConnectorResourceDetail> {
    const api = new AwsApi(this.authFrom(ctx));
    if (kind === EKS_KIND) return this.describeEks(api, resourceId);
    if (kind === ECS_KIND) return this.describeEcs(api, resourceId);
    if (kind === RDS_KIND) return this.describeRds(api, resourceId);
    if (kind === EBS_KIND) return this.describeEbs(api, resourceId);
    if (kind === EIP_KIND) return this.describeEip(api, resourceId);
    if (kind === S3_KIND) return this.describeS3(api, resourceId);
    if ([NAT_KIND, ELB_KIND, EBSSNAP_KIND, RDSSNAP_KIND, LAMBDA_KIND, CF_KIND, DDB_KIND, CACHE_KIND].includes(kind)) {
      return this.genericDetail(ctx, kind, resourceId);
    }
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
          { label: inst.publicIpElastic ? 'Public IP (Elastic)' : 'Public IP', value: inst.publicIp || '—', variant: 'mono' },
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
    if (kind === EBS_KIND) {
      try {
        const v = (await api.listVolumes()).find((x) => x.id === resourceId);
        if (!v) return { ok: false, message: `Volume ${resourceId} not found in this region.` };
        if (v.state !== 'available') {
          return { ok: false, message: `Volume ${resourceId} is ${v.state} — detach it before deleting.` };
        }
        await api.deleteVolume(resourceId);
        ctx.log('warn', `AWS deleted EBS volume ${resourceId} (${v.name ?? ''}).`);
        return { ok: true, message: `Deleted volume ${v.name || resourceId}.` };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Delete failed.';
        ctx.log('error', `AWS delete volume ${resourceId} failed: ${message}`);
        return { ok: false, message };
      }
    }
    if (kind !== EC2_KIND) {
      return { ok: false, message: `Deleting ${kind} resources isn't supported from Cerebro yet.` };
    }
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

  /** Drop the cached cost summary so the next overview re-queries Cost Explorer (used by "Refresh billing"). */
  invalidateCache(ctx: ConnectorContext): void {
    this.costCache.delete(this.authFrom(ctx).accessKeyId);
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

    // Best-effort EKS cluster count (omit if no eks:* permissions).
    try {
      const clusters = await api.listEksClusterNames();
      if (clusters.length) metrics.push({ key: 'eksClusters', label: 'EKS clusters', value: clusters.length });
    } catch {
      /* eks not permitted / unavailable — omit */
    }

    // Best-effort resource counts across services (each omitted if not permitted).
    // Run in parallel so the overview stays fast. Waste signals (unassociated EIP,
    // unattached EBS) only surface when > 0.
    const [eks, ecs, eips, vols, rds, s3] = await Promise.all([
      api.listEksClusterNames().catch(() => null),
      api.listEcsClusterArns().catch(() => null),
      api.listElasticIps().catch(() => null),
      api.listVolumes().catch(() => null),
      api.listRdsInstances().catch(() => null),
      api.listS3Buckets().catch(() => null),
    ]);
    if (eks?.length) metrics.push({ key: 'eksClusters', label: 'EKS clusters', value: eks.length });
    if (ecs?.length) metrics.push({ key: 'ecsClusters', label: 'ECS clusters', value: ecs.length });
    if (rds?.length) metrics.push({ key: 'rdsInstances', label: 'RDS databases', value: rds.length });
    if (s3?.length) metrics.push({ key: 's3Buckets', label: 'S3 buckets', value: s3.length });
    const eipIdle = eips?.filter((e) => !e.associated).length ?? 0;
    if (eipIdle > 0) metrics.push({ key: 'eipUnassociated', label: 'Idle Elastic IPs', value: eipIdle });
    const ebsIdle = vols?.filter((v) => v.state === 'available').length ?? 0;
    if (ebsIdle > 0) metrics.push({ key: 'ebsUnattached', label: 'Unattached volumes', value: ebsIdle });

    // Best-effort spend (billable → cached a day). Unit is the currency code so the
    // UI renders it as money, and the dashboard sums it across AWS accounts.
    const cost = await this.cachedCost(ctx, api, auth.accessKeyId);
    if (cost) {
      metrics.push({ key: 'costLastMonth', label: 'Last month', value: round2(cost.lastMonth), unit: cost.currency, asOf: cost.asOf });
      metrics.push({ key: 'costMtd', label: 'Spend (MTD)', value: round2(cost.mtd), unit: cost.currency, asOf: cost.asOf });
      metrics.push({ key: 'costForecast', label: 'Est. this month', value: round2(cost.estimated), unit: cost.currency, asOf: cost.asOf });
      // Spend broken down by service (keyed 'costSvc:<service>' so the UI can group them).
      for (const s of cost.byService) {
        metrics.push({ key: `costSvc:${s.service}`, label: s.service, value: round2(s.amount), unit: cost.currency, asOf: cost.asOf });
      }
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

  async listSubResources(ctx: ConnectorContext, kind: string, resourceId: string, subKind: string): Promise<ConnectorResource[]> {
    const api = new AwsApi(this.authFrom(ctx));
    if (kind === EKS_KIND) {
      if (subKind !== 'nodegroup') return [];
      const groups = await api.describeEksNodegroups(resourceId);
      return groups.map((ng) => ({
        id: ng.name,
        kind: 'nodegroup',
        name: ng.name,
        status: (ng.status || '').toLowerCase(),
        details: {
          summary: [
            ng.desiredSize != null ? `${ng.desiredSize} node${ng.desiredSize === 1 ? '' : 's'} (min ${ng.minSize ?? '?'}, max ${ng.maxSize ?? '?'})` : null,
            (ng.instanceTypes ?? []).join('/') || null,
            ng.capacityType,
          ].filter(Boolean).join(' · ') || '—',
        },
      }));
    }
    if (kind !== ECS_KIND) return [];
    if (subKind === 'service') {
      const services = await api.listEcsServices(resourceId);
      return services.map((s: AwsEcsService) => ({
        id: s.name,
        kind: 'service',
        name: s.name,
        status: (s.status || '').toLowerCase(),
        details: {
          summary: `${s.running ?? 0}/${s.desired ?? 0} running${s.pending ? ` · ${s.pending} pending` : ''}${s.launchType ? ` · ${s.launchType}` : ''}`,
          desired: s.desired ?? 0,
          running: s.running ?? 0,
        },
      }));
    }
    if (subKind === 'task') {
      const tasks = await api.listEcsTasks(resourceId);
      return tasks.map((t: AwsEcsTask) => ({
        id: t.arn,
        kind: 'task',
        name: t.id,
        status: (t.lastStatus || '').toLowerCase(),
        details: {
          summary: [t.taskDefinition, t.group].filter(Boolean).join(' · ') || '—',
        },
      }));
    }
    return [];
  }

  async operationDefaults(
    ctx: ConnectorContext,
    operationId: string,
    resourceId: string | undefined,
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (operationId === 'ecs-scale-service' && resourceId && values.service) {
      try {
        const api = new AwsApi(this.authFrom(ctx));
        const svc = (await api.listEcsServices(resourceId)).find((s) => s.name === String(values.service));
        if (svc?.desired != null) return { desiredCount: svc.desired };
      } catch {
        /* best-effort prefill */
      }
    }
    if (operationId === 'eks-scale-nodegroup' && resourceId && values.nodegroup) {
      try {
        const api = new AwsApi(this.authFrom(ctx));
        const ng = (await api.describeEksNodegroups(resourceId)).find((g) => g.name === String(values.nodegroup));
        if (ng) {
          const out: Record<string, unknown> = {};
          if (ng.desiredSize != null) out.desiredSize = ng.desiredSize;
          if (ng.minSize != null) out.minSize = ng.minSize;
          if (ng.maxSize != null) out.maxSize = ng.maxSize;
          return out;
        }
      } catch {
        /* best-effort prefill */
      }
    }
    return {};
  }

  private async runEksOperation(
    ctx: ConnectorContext,
    operationId: string,
    resourceId: string | undefined,
    values: Record<string, unknown>,
    onProgress: OperationProgress,
  ): Promise<OperationResult> {
    const cluster = resourceId;
    if (!cluster) return { ok: false, message: 'Missing EKS cluster.' };
    if (operationId !== 'eks-scale-nodegroup') return { ok: false, message: `Unknown operation "${operationId}".` };
    const nodegroup = String(values.nodegroup ?? '');
    if (!nodegroup) return { ok: false, message: 'Missing node group.' };
    const desired = Number(values.desiredSize);
    const min = Number(values.minSize);
    const max = Number(values.maxSize);
    if (![desired, min, max].every((n) => Number.isInteger(n) && n >= 0)) {
      return { ok: false, message: 'Node counts must be whole numbers of 0 or more.' };
    }
    if (min > max) return { ok: false, message: 'Minimum nodes cannot exceed maximum nodes.' };
    if (desired < min || desired > max) return { ok: false, message: 'Desired nodes must be between the minimum and maximum.' };
    try {
      onProgress(`Scaling ${nodegroup} to ${desired} node${desired === 1 ? '' : 's'} (min ${min}, max ${max})…`);
      const api = new AwsApi(this.authFrom(ctx));
      await api.updateEksNodegroupScaling(cluster, nodegroup, { desiredSize: desired, minSize: min, maxSize: max });
      ctx.log('info', `AWS EKS scaled node group ${nodegroup} in ${cluster} to desired ${desired} (min ${min}, max ${max}).`);
      return { ok: true, message: `Scaling ${nodegroup} to ${desired} node${desired === 1 ? '' : 's'} — EKS is applying the update.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Operation failed.';
      ctx.log('error', `AWS EKS ${operationId} failed: ${message}`);
      return { ok: false, message };
    }
  }

  private async runEcsOperation(
    ctx: ConnectorContext,
    operationId: string,
    resourceId: string | undefined,
    values: Record<string, unknown>,
    onProgress: OperationProgress,
  ): Promise<OperationResult> {
    const auth = this.authFrom(ctx);
    const api = new AwsApi(auth);
    const cluster = resourceId;
    if (!cluster) return { ok: false, message: 'Missing ECS cluster.' };
    const memKey = (service: string) => `${auth.accessKeyId}:${cluster}:${service}`;
    try {
      if (operationId === 'ecs-scale-service') {
        const service = String(values.service ?? '');
        if (!service) return { ok: false, message: 'Missing service.' };
        const desired = Number(values.desiredCount);
        if (!Number.isInteger(desired) || desired < 0) return { ok: false, message: 'Desired task count must be 0 or more.' };
        onProgress(`Scaling ${service} to ${desired} task${desired === 1 ? '' : 's'}…`);
        await api.updateEcsService(cluster, service, { desiredCount: desired });
        // Remember a non-zero scale so a later Stop→Start round-trips back to it.
        if (desired > 0) this.ecsDesiredMemory.set(memKey(service), desired);
        ctx.log('info', `AWS ECS scaled ${service} to ${desired} in ${cluster}.`);
        return { ok: true, message: `Scaled ${service} to ${desired} task${desired === 1 ? '' : 's'}.` };
      }
      if (operationId === 'ecs-stop-service') {
        const service = String(values.service ?? '');
        if (!service) return { ok: false, message: 'Missing service.' };
        // Remember the current count (if running) so Start can restore it.
        const current = (await api.listEcsServices(cluster)).find((s) => s.name === service)?.desired ?? 0;
        if (current > 0) this.ecsDesiredMemory.set(memKey(service), current);
        onProgress(`Stopping ${service} (scaling to 0)…`);
        await api.updateEcsService(cluster, service, { desiredCount: 0 });
        ctx.log('warn', `AWS ECS stopped ${service} in ${cluster} (was ${current}).`);
        return { ok: true, message: `Stopped ${service} (scaled to 0${current > 0 ? `, was ${current}` : ''}).` };
      }
      if (operationId === 'ecs-start-service') {
        const service = String(values.service ?? '');
        if (!service) return { ok: false, message: 'Missing service.' };
        const svc = (await api.listEcsServices(cluster)).find((s) => s.name === service);
        if ((svc?.desired ?? 0) > 0) {
          return { ok: true, message: `${service} is already running ${svc?.desired} task${svc?.desired === 1 ? '' : 's'}.` };
        }
        const restore = this.ecsDesiredMemory.get(memKey(service)) ?? 1;
        onProgress(`Starting ${service} (scaling to ${restore})…`);
        await api.updateEcsService(cluster, service, { desiredCount: restore });
        ctx.log('info', `AWS ECS started ${service} in ${cluster} (to ${restore}).`);
        return { ok: true, message: `Started ${service} — scaling to ${restore} task${restore === 1 ? '' : 's'}.` };
      }
      if (operationId === 'ecs-redeploy-service') {
        const service = String(values.service ?? '');
        if (!service) return { ok: false, message: 'Missing service.' };
        onProgress(`Redeploying ${service}…`);
        await api.updateEcsService(cluster, service, { forceNewDeployment: true });
        ctx.log('info', `AWS ECS redeployed ${service} in ${cluster}.`);
        return { ok: true, message: `New deployment started for ${service}.` };
      }
      if (operationId === 'ecs-stop-task') {
        const task = String(values.task ?? '');
        if (!task) return { ok: false, message: 'Missing task.' };
        onProgress(`Stopping task ${task.split('/').pop()}…`);
        await api.stopEcsTask(cluster, task);
        ctx.log('warn', `AWS ECS stopped task ${task} in ${cluster}.`);
        return { ok: true, message: `Stop requested for task ${task.split('/').pop()}.` };
      }
      return { ok: false, message: `Unknown operation "${operationId}".` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Operation failed.';
      ctx.log('error', `AWS ECS ${operationId} failed: ${message}`);
      return { ok: false, message };
    }
  }

  async runOperation(
    ctx: ConnectorContext,
    operationId: string,
    resourceId: string | undefined,
    values: Record<string, unknown>,
    onProgress: OperationProgress,
  ): Promise<OperationResult> {
    if (operationId.startsWith('ecs-')) return this.runEcsOperation(ctx, operationId, resourceId, values, onProgress);
    if (operationId.startsWith('eks-')) return this.runEksOperation(ctx, operationId, resourceId, values, onProgress);
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
