import {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  RebootInstancesCommand,
  TerminateInstancesCommand,
  DescribeRegionsCommand,
  type Instance,
  type Tag,
} from '@aws-sdk/client-ec2';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

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
  type?: string;
  az?: string;
  privateIp?: string;
  publicIp?: string;
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
  tags: Record<string, string>;
  securityGroups: { id: string; name: string }[];
  volumes: { device: string; volumeId?: string }[];
}

export interface AwsIdentity {
  account?: string;
  arn?: string;
  userId?: string;
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
    type: i.InstanceType,
    az: i.Placement?.AvailabilityZone,
    privateIp: i.PrivateIpAddress,
    publicIp: i.PublicIpAddress,
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
    tags,
    securityGroups: (i.SecurityGroups ?? []).map((g) => ({ id: g.GroupId ?? '', name: g.GroupName ?? '' })),
    volumes: (i.BlockDeviceMappings ?? []).map((b) => ({ device: b.DeviceName ?? '', volumeId: b.Ebs?.VolumeId })),
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

  /** Region names enabled/available for this account (for a region dropdown). */
  async describeRegions(): Promise<string[]> {
    try {
      const r = await this.ec2.send(new DescribeRegionsCommand({}));
      return (r.Regions ?? []).map((x) => x.RegionName ?? '').filter(Boolean).sort();
    } catch (err) {
      throw friendly(err);
    }
  }
}
