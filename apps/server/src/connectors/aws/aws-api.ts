import {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  RebootInstancesCommand,
  TerminateInstancesCommand,
  DescribeRegionsCommand,
  DescribeImagesCommand,
  DescribeKeyPairsCommand,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  RunInstancesCommand,
  type Instance,
  type Tag,
} from '@aws-sdk/client-ec2';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } from '@aws-sdk/client-cost-explorer';
import {
  EKSClient,
  ListClustersCommand,
  DescribeClusterCommand,
  ListNodegroupsCommand,
  DescribeNodegroupCommand,
} from '@aws-sdk/client-eks';

export interface AwsAuth {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Optional session token for temporary (STS) credentials. */
  sessionToken?: string;
}

/** A normalized EC2 instance — the shape the connector maps into Cerebro resources. */
export interface AwsInstance {
  id: string;
  name?: string;
  /** running | stopped | pending | stopping | shutting-down | terminated | ... */
  state: string;
  /** Why the instance is in its current state, e.g. "User initiated shutdown". */
  stateReason?: string;
  type?: string;
  az?: string;
  privateIp?: string;
  publicIp?: string;
  privateDns?: string;
  publicDns?: string;
  vpcId?: string;
  subnetId?: string;
  imageId?: string;
  keyName?: string;
  arch?: string;
  platform?: string;
  launchTime?: Date;
  monitoring?: string;
  rootDeviceName?: string;
  rootDeviceType?: string;
  /** IAM instance profile ARN attached to the instance, if any. */
  iamProfileArn?: string;
  tenancy?: string;
  /** 'spot' | 'scheduled' when applicable; undefined for normal on-demand. */
  lifecycle?: string;
  ebsOptimized?: boolean;
  enaSupport?: boolean;
  hypervisor?: string;
  virtualizationType?: string;
  cpuCores?: number;
  cpuThreadsPerCore?: number;
  tags: Record<string, string>;
  securityGroups: { id: string; name: string }[];
  volumes: { device: string; volumeId?: string; deleteOnTermination?: boolean; status?: string }[];
  networkInterfaces: {
    id?: string;
    privateIp?: string;
    privateDns?: string;
    publicIp?: string;
    macAddress?: string;
    subnetId?: string;
    description?: string;
    status?: string;
  }[];
}

export interface AwsIdentity {
  account?: string;
  arn?: string;
  userId?: string;
}

export interface AwsEksNodegroup {
  name: string;
  status?: string;
  instanceTypes?: string[];
  amiType?: string;
  capacityType?: string;
  desiredSize?: number;
  minSize?: number;
  maxSize?: number;
  diskSize?: number;
}

/** A normalized EKS cluster. */
export interface AwsEksCluster {
  name: string;
  status: string; // ACTIVE | CREATING | DELETING | FAILED | UPDATING | ...
  version?: string;
  platformVersion?: string;
  arn?: string;
  endpoint?: string;
  roleArn?: string;
  createdAt?: Date;
  vpcId?: string;
  subnetIds?: string[];
  securityGroupIds?: string[];
  endpointPublicAccess?: boolean;
  endpointPrivateAccess?: boolean;
  tags: Record<string, string>;
  nodegroups: AwsEksNodegroup[];
}

export interface AwsCostSummary {
  /** Previous calendar month's total spend. */
  lastMonth: number;
  /** Month-to-date actual spend. */
  mtd: number;
  /** Raw Cost Explorer forecast (with MONTHLY granularity this is the projected full-month total). */
  forecast: number;
  /** Estimated full-month spend (the month-end forecast, or MTD if no forecast is available). */
  estimated: number;
  currency: string;
  /** ISO timestamp this figure was fetched from Cost Explorer. */
  asOf: string;
}

export interface AwsImage {
  imageId: string;
  name?: string;
  creationDate?: string;
}

export interface AwsImageInfo {
  imageId: string;
  rootDeviceName?: string;
  /** Default size (GB) of the AMI's root EBS volume. */
  rootDefaultSize?: number;
  architecture?: string;
}

export interface AwsSubnet {
  id: string;
  cidr?: string;
  az?: string;
  vpcId?: string;
  name?: string;
}

export interface AwsSecurityGroup {
  id: string;
  name?: string;
  vpcId?: string;
  description?: string;
}

/** Parameters for launching one or more EC2 instances. */
export interface RunInstancesParams {
  imageId: string;
  instanceType: string;
  minCount: number;
  maxCount: number;
  keyName?: string;
  subnetId?: string;
  securityGroupIds?: string[];
  /** Already base64-encoded user data. */
  userDataBase64?: string;
  /** Applied as the Name tag on launched instances. */
  nameTag?: string;
  blockDeviceMappings?: { DeviceName?: string; Ebs?: { VolumeSize?: number; VolumeType?: string } }[];
}

export class AwsApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** Turns an AWS SDK error into a short, actionable message for the UI. */
function friendly(err: unknown): AwsApiError {
  const e = err as { name?: string; Code?: string; message?: string; $metadata?: unknown } | undefined;
  const code = e?.name || e?.Code || '';
  const msg = e?.message || String(err);
  const map: Record<string, string> = {
    InvalidClientTokenId: 'The Access Key ID is not recognized. Check the Access Key ID.',
    UnrecognizedClientException: 'The Access Key ID is not recognized. Check the Access Key ID.',
    SignatureDoesNotMatch: 'The Secret Access Key is incorrect for this Access Key ID.',
    AuthFailure: 'AWS rejected the credentials — check the access key, secret, and that the key is active.',
    AccessDenied: 'Access denied — the IAM identity is missing the required EC2/STS permissions.',
    AccessDeniedException: 'Access denied — the IAM identity is missing the required EC2/STS permissions.',
    UnauthorizedOperation: 'Access denied — the IAM identity is not allowed to perform this EC2 action.',
    RequestExpired: 'The request/session token has expired. Provide fresh credentials.',
    ExpiredToken: 'The session token has expired. Provide a fresh session token.',
    ExpiredTokenException: 'The session token has expired. Provide a fresh session token.',
    OptInRequired: 'This AWS account is not signed up for EC2 in the selected region.',
    'InvalidInstanceID.NotFound': 'That instance was not found in this region.',
    'InvalidInstanceID.Malformed': 'That instance ID is not valid.',
    IncorrectInstanceState: 'The instance is not in a state that allows this action right now.',
  };
  if (map[code]) return new AwsApiError(map[code], code);
  if (/getaddrinfo ENOTFOUND|EAI_AGAIN|UnknownEndpoint/i.test(msg)) {
    return new AwsApiError('Could not resolve the AWS endpoint — check the region and network connectivity.', code);
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENETUNREACH|TimeoutError|timed? ?out/i.test(msg)) {
    return new AwsApiError('Could not reach AWS — the connection timed out or was refused.', code);
  }
  if (/Invalid region|Region is missing|Could not load credentials/i.test(msg)) {
    return new AwsApiError(msg, code);
  }
  return new AwsApiError(msg || 'AWS request failed.', code);
}

function tagsToMap(tags?: Tag[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tags ?? []) if (t.Key) out[t.Key] = t.Value ?? '';
  return out;
}

function normalize(i: Instance): AwsInstance {
  const tags = tagsToMap(i.Tags);
  return {
    id: i.InstanceId ?? '',
    name: tags['Name'] || undefined,
    state: i.State?.Name ?? 'unknown',
    stateReason: i.StateReason?.Message || i.StateTransitionReason || undefined,
    type: i.InstanceType,
    az: i.Placement?.AvailabilityZone,
    privateIp: i.PrivateIpAddress,
    publicIp: i.PublicIpAddress,
    privateDns: i.PrivateDnsName || undefined,
    publicDns: i.PublicDnsName || undefined,
    vpcId: i.VpcId,
    subnetId: i.SubnetId,
    imageId: i.ImageId,
    keyName: i.KeyName,
    arch: i.Architecture,
    platform: i.PlatformDetails || i.Platform,
    launchTime: i.LaunchTime,
    monitoring: i.Monitoring?.State,
    rootDeviceName: i.RootDeviceName,
    rootDeviceType: i.RootDeviceType,
    iamProfileArn: i.IamInstanceProfile?.Arn || undefined,
    tenancy: i.Placement?.Tenancy,
    lifecycle: i.InstanceLifecycle || undefined,
    ebsOptimized: i.EbsOptimized,
    enaSupport: i.EnaSupport,
    hypervisor: i.Hypervisor,
    virtualizationType: i.VirtualizationType,
    cpuCores: i.CpuOptions?.CoreCount,
    cpuThreadsPerCore: i.CpuOptions?.ThreadsPerCore,
    tags,
    securityGroups: (i.SecurityGroups ?? []).map((g) => ({ id: g.GroupId ?? '', name: g.GroupName ?? '' })),
    volumes: (i.BlockDeviceMappings ?? []).map((b) => ({
      device: b.DeviceName ?? '',
      volumeId: b.Ebs?.VolumeId,
      deleteOnTermination: b.Ebs?.DeleteOnTermination,
      status: b.Ebs?.Status,
    })),
    networkInterfaces: (i.NetworkInterfaces ?? []).map((n) => ({
      id: n.NetworkInterfaceId,
      privateIp: n.PrivateIpAddress,
      privateDns: n.PrivateDnsName,
      publicIp: n.Association?.PublicIp,
      macAddress: n.MacAddress,
      subnetId: n.SubnetId,
      description: n.Description || undefined,
      status: n.Status,
    })),
  };
}

/**
 * Thin wrapper over the AWS SDK v3 EC2 + STS clients, scoped to one connector
 * instance's credentials and region. Mirrors ProxmoxApi: friendly errors, one
 * region per instance, no ambient credential resolution.
 */
export class AwsApi {
  private _ec2?: EC2Client;
  private _sts?: STSClient;
  private _ce?: CostExplorerClient;

  constructor(private readonly auth: AwsAuth) {}

  private get credentials() {
    return {
      accessKeyId: this.auth.accessKeyId,
      secretAccessKey: this.auth.secretAccessKey,
      ...(this.auth.sessionToken ? { sessionToken: this.auth.sessionToken } : {}),
    };
  }

  private get ec2(): EC2Client {
    if (!this._ec2) {
      this._ec2 = new EC2Client({
        region: this.auth.region,
        credentials: this.credentials,
        maxAttempts: 3,
      });
    }
    return this._ec2;
  }

  private get sts(): STSClient {
    if (!this._sts) {
      this._sts = new STSClient({
        region: this.auth.region,
        credentials: this.credentials,
        maxAttempts: 3,
      });
    }
    return this._sts;
  }

  /** Cost Explorer only has a global endpoint in us-east-1, regardless of the connector's region. */
  private get ce(): CostExplorerClient {
    if (!this._ce) {
      this._ce = new CostExplorerClient({ region: 'us-east-1', credentials: this.credentials, maxAttempts: 3 });
    }
    return this._ce;
  }

  /**
   * Last month's total, month-to-date spend, and a forecast for the rest of the
   * month. Last month + MTD come from a single GetCostAndUsage (two monthly
   * buckets), so this is still just two Cost Explorer calls. Requires Cost
   * Explorer enabled + ce:GetCostAndUsage / ce:GetCostForecast.
   * NOTE: each call is billed ~$0.01 by AWS — callers should cache aggressively.
   */
  async getCostSummary(): Promise<AwsCostSummary> {
    const pad = (n: number) => String(n).padStart(2, '0');
    const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const lastMonthStart = iso(new Date(Date.UTC(y, m - 1, 1)));
    const monthStart = iso(new Date(Date.UTC(y, m, 1)));
    const today = iso(now);
    const monthEnd = iso(new Date(Date.UTC(y, m + 1, 1)));

    try {
      let mtd = 0;
      let lastMonth = 0;
      let currency = 'USD';
      // One call spanning last month through today → a bucket per month.
      const cu = await this.ce.send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: lastMonthStart, End: today === monthStart ? monthStart : today },
          Granularity: 'MONTHLY',
          Metrics: ['UnblendedCost'],
        }),
      );
      for (const r of cu.ResultsByTime ?? []) {
        const amt = r.Total?.UnblendedCost;
        if (!amt) continue;
        const val = parseFloat(amt.Amount || '0');
        if (amt.Unit) currency = amt.Unit;
        if (r.TimePeriod?.Start === monthStart) mtd = val;
        else if (r.TimePeriod?.Start === lastMonthStart) lastMonth = val;
      }

      // Forecast needs historical data; if unavailable it throws — treat as 0.
      // With MONTHLY granularity, GetCostForecast returns the projected FULL-MONTH
      // total (it already accounts for spend so far), so this IS the month-end
      // estimate — do NOT add MTD on top or it double-counts.
      let forecast = 0;
      try {
        const fc = await this.ce.send(
          new GetCostForecastCommand({
            TimePeriod: { Start: today, End: monthEnd },
            Metric: 'UNBLENDED_COST',
            Granularity: 'MONTHLY',
          }),
        );
        forecast = parseFloat(fc.Total?.Amount || '0');
      } catch {
        forecast = 0;
      }

      // The forecast is the month-end total; fall back to MTD if unavailable.
      const estimated = forecast > 0 ? Math.max(mtd, forecast) : mtd;
      return { lastMonth, mtd, forecast, estimated, currency, asOf: new Date().toISOString() };
    } catch (err) {
      throw friendly(err);
    }
  }

  async getCallerIdentity(): Promise<AwsIdentity> {
    try {
      const r = await this.sts.send(new GetCallerIdentityCommand({}));
      return { account: r.Account, arn: r.Arn, userId: r.UserId };
    } catch (err) {
      throw friendly(err);
    }
  }

  async describeInstances(instanceIds?: string[]): Promise<AwsInstance[]> {
    try {
      const out: AwsInstance[] = [];
      let token: string | undefined;
      do {
        const r = await this.ec2.send(
          new DescribeInstancesCommand({
            InstanceIds: instanceIds && instanceIds.length ? instanceIds : undefined,
            NextToken: token,
            MaxResults: instanceIds && instanceIds.length ? undefined : 1000,
          }),
        );
        for (const res of r.Reservations ?? []) {
          for (const inst of res.Instances ?? []) out.push(normalize(inst));
        }
        token = r.NextToken;
      } while (token);
      return out;
    } catch (err) {
      throw friendly(err);
    }
  }

  async startInstances(ids: string[]): Promise<void> {
    try {
      await this.ec2.send(new StartInstancesCommand({ InstanceIds: ids }));
    } catch (err) {
      throw friendly(err);
    }
  }

  async stopInstances(ids: string[], force = false): Promise<void> {
    try {
      await this.ec2.send(new StopInstancesCommand({ InstanceIds: ids, Force: force }));
    } catch (err) {
      throw friendly(err);
    }
  }

  async rebootInstances(ids: string[]): Promise<void> {
    try {
      await this.ec2.send(new RebootInstancesCommand({ InstanceIds: ids }));
    } catch (err) {
      throw friendly(err);
    }
  }

  async terminateInstances(ids: string[]): Promise<void> {
    try {
      await this.ec2.send(new TerminateInstancesCommand({ InstanceIds: ids }));
    } catch (err) {
      throw friendly(err);
    }
  }

  private _eks?: EKSClient;
  private get eks(): EKSClient {
    if (!this._eks) {
      this._eks = new EKSClient({ region: this.auth.region, credentials: this.credentials, maxAttempts: 3 });
    }
    return this._eks;
  }

  /** Cluster names only (paginated) — cheap, for counts. */
  async listEksClusterNames(): Promise<string[]> {
    try {
      const out: string[] = [];
      let token: string | undefined;
      do {
        // include 'all' so connected/registered clusters are returned too, not just native EKS.
        const r = await this.eks.send(new ListClustersCommand({ nextToken: token, include: ['all'] }));
        out.push(...(r.clusters ?? []));
        token = r.nextToken;
      } while (token);
      return out;
    } catch (err) {
      throw friendly(err);
    }
  }

  /**
   * Cluster list for the table. Each cluster is a DescribeCluster plus a cheap
   * ListNodegroups (names only) so we can show a node-group count without a
   * DescribeNodegroup per group. Full node-group specs are fetched on demand in
   * describeEksCluster (the detail drawer).
   *
   * Each cluster is fetched INDEPENDENTLY: a cluster that's mid-lifecycle
   * (creating/deleting/failed) can make DescribeCluster or ListNodegroups throw,
   * and we must never let that hide the other clusters — a failed lookup still
   * surfaces the cluster (by name), and node-group counts degrade to 0.
   */
  async listEksClusters(): Promise<AwsEksCluster[]> {
    const names = await this.listEksClusterNames();
    return await Promise.all(
      names.map(async (n) => {
        let cluster: AwsEksCluster;
        try {
          cluster = await this.describeEksCluster(n, false);
        } catch {
          // Describe failed (transitional/denied) — still show the cluster.
          cluster = { name: n, status: 'UNKNOWN', tags: {}, nodegroups: [] };
        }
        try {
          cluster.nodegroups = (await this.listEksNodegroupNames(n)).map((name) => ({ name }));
        } catch {
          cluster.nodegroups = [];
        }
        return cluster;
      }),
    );
  }

  /** One cluster's details; set withNodegroups to also fetch full node group specs. */
  async describeEksCluster(name: string, withNodegroups = true): Promise<AwsEksCluster> {
    try {
      const r = await this.eks.send(new DescribeClusterCommand({ name }));
      const c = r.cluster;
      const vpc = c?.resourcesVpcConfig;
      const cluster: AwsEksCluster = {
        name: c?.name ?? name,
        status: c?.status ?? 'UNKNOWN',
        version: c?.version,
        platformVersion: c?.platformVersion,
        arn: c?.arn,
        endpoint: c?.endpoint,
        roleArn: c?.roleArn,
        createdAt: c?.createdAt,
        vpcId: vpc?.vpcId,
        subnetIds: vpc?.subnetIds,
        securityGroupIds: vpc?.securityGroupIds,
        endpointPublicAccess: vpc?.endpointPublicAccess,
        endpointPrivateAccess: vpc?.endpointPrivateAccess,
        tags: c?.tags ?? {},
        nodegroups: [],
      };
      if (withNodegroups) cluster.nodegroups = await this.describeEksNodegroups(name);
      return cluster;
    } catch (err) {
      throw friendly(err);
    }
  }

  /** Node group names for a cluster (cheap — no DescribeNodegroup). */
  async listEksNodegroupNames(clusterName: string): Promise<string[]> {
    const names: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.eks.send(new ListNodegroupsCommand({ clusterName, nextToken: token }));
      names.push(...(r.nodegroups ?? []));
      token = r.nextToken;
    } while (token);
    return names;
  }

  /** Full node group specs for a cluster (DescribeNodegroup per group). */
  async describeEksNodegroups(clusterName: string): Promise<AwsEksNodegroup[]> {
    const names = await this.listEksNodegroupNames(clusterName);
    return await Promise.all(
      names.map(async (nodegroupName) => {
        const d = await this.eks.send(new DescribeNodegroupCommand({ clusterName, nodegroupName }));
        const ng = d.nodegroup;
        return {
          name: ng?.nodegroupName ?? nodegroupName,
          status: ng?.status,
          instanceTypes: ng?.instanceTypes,
          amiType: ng?.amiType,
          capacityType: ng?.capacityType,
          desiredSize: ng?.scalingConfig?.desiredSize,
          minSize: ng?.scalingConfig?.minSize,
          maxSize: ng?.scalingConfig?.maxSize,
          diskSize: ng?.diskSize,
        };
      }),
    );
  }

  /** Region names enabled/available for this account (for a region dropdown). */
  async describeRegions(): Promise<string[]> {
    try {
      const r = await this.ec2.send(new DescribeRegionsCommand({}));
      return (r.Regions ?? []).map((x) => x.RegionName ?? '').filter(Boolean).sort();
    } catch (err) {
      throw friendly(err);
    }
  }

  /** Newest available x86_64 AMI from the given owners matching a name pattern. */
  async latestImage(owners: string[], namePattern: string): Promise<AwsImage | undefined> {
    try {
      const r = await this.ec2.send(
        new DescribeImagesCommand({
          Owners: owners,
          Filters: [
            { Name: 'name', Values: [namePattern] },
            { Name: 'state', Values: ['available'] },
            { Name: 'architecture', Values: ['x86_64'] },
            { Name: 'root-device-type', Values: ['ebs'] },
          ],
        }),
      );
      const images = (r.Images ?? [])
        .slice()
        .sort((a, b) => (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''));
      const img = images[0];
      if (!img?.ImageId) return undefined;
      return { imageId: img.ImageId, name: img.Name, creationDate: img.CreationDate };
    } catch (err) {
      throw friendly(err);
    }
  }

  /** Root device name + default root volume size for a specific AMI (for disk resizing). */
  async getImageInfo(imageId: string): Promise<AwsImageInfo | undefined> {
    try {
      const r = await this.ec2.send(new DescribeImagesCommand({ ImageIds: [imageId] }));
      const img = r.Images?.[0];
      if (!img?.ImageId) return undefined;
      const rootBdm = (img.BlockDeviceMappings ?? []).find((b) => b.DeviceName === img.RootDeviceName);
      return {
        imageId: img.ImageId,
        rootDeviceName: img.RootDeviceName,
        rootDefaultSize: rootBdm?.Ebs?.VolumeSize,
        architecture: img.Architecture,
      };
    } catch (err) {
      throw friendly(err);
    }
  }

  async listKeyPairs(): Promise<{ name: string }[]> {
    try {
      const r = await this.ec2.send(new DescribeKeyPairsCommand({}));
      return (r.KeyPairs ?? []).map((k) => ({ name: k.KeyName ?? '' })).filter((k) => k.name);
    } catch (err) {
      throw friendly(err);
    }
  }

  async listSubnets(): Promise<AwsSubnet[]> {
    try {
      const r = await this.ec2.send(new DescribeSubnetsCommand({}));
      return (r.Subnets ?? []).map((s) => ({
        id: s.SubnetId ?? '',
        cidr: s.CidrBlock,
        az: s.AvailabilityZone,
        vpcId: s.VpcId,
        name: (s.Tags ?? []).find((t) => t.Key === 'Name')?.Value,
      }));
    } catch (err) {
      throw friendly(err);
    }
  }

  async listSecurityGroups(vpcId?: string): Promise<AwsSecurityGroup[]> {
    try {
      const r = await this.ec2.send(
        new DescribeSecurityGroupsCommand({
          Filters: vpcId ? [{ Name: 'vpc-id', Values: [vpcId] }] : undefined,
        }),
      );
      return (r.SecurityGroups ?? []).map((g) => ({
        id: g.GroupId ?? '',
        name: g.GroupName,
        vpcId: g.VpcId,
        description: g.Description,
      }));
    } catch (err) {
      throw friendly(err);
    }
  }

  /** Launch instances; returns the new instance IDs. */
  async runInstances(p: RunInstancesParams): Promise<string[]> {
    try {
      const r = await this.ec2.send(
        new RunInstancesCommand({
          ImageId: p.imageId,
          InstanceType: p.instanceType as never,
          MinCount: p.minCount,
          MaxCount: p.maxCount,
          KeyName: p.keyName,
          SubnetId: p.subnetId,
          SecurityGroupIds: p.securityGroupIds,
          UserData: p.userDataBase64,
          BlockDeviceMappings: p.blockDeviceMappings as never,
          TagSpecifications: p.nameTag
            ? [{ ResourceType: 'instance', Tags: [{ Key: 'Name', Value: p.nameTag }] }]
            : undefined,
        }),
      );
      return (r.Instances ?? []).map((i) => i.InstanceId ?? '').filter(Boolean);
    } catch (err) {
      throw friendly(err);
    }
  }
}
