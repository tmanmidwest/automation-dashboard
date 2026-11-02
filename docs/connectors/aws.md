# AWS connector

Manage EC2 and view or manage EKS, ECS, RDS, EBS, Elastic IPs, S3 and several "discovery" services
in one AWS account and region, plus spend by service. Connector `v1.0.0`. It also serves as the
**ECS/Fargate deploy target** for the App Replicator (see
[app-replicator-ecs-target.md](../app-replicator-ecs-target.md)).

Code: `apps/server/src/connectors/aws/` (`aws-api.ts`, `aws.connector.ts`).

## Connecting

| Field | Secret | Notes |
| --- | --- | --- |
| `accessKeyId` / `secretAccessKey` | secret yes | An IAM user's access key |
| `region` | no | One region per connection, e.g. `us-east-1`. Add a second connection for another region. |
| `sessionToken` | yes | Only for temporary (STS) credentials |
| `ecs*` fields | no | Optional App Replicator deploy profile: cluster (default `cerebro`), subnets, security groups, ALB security groups, task execution/task role ARNs, public IP, the Docker connector used to build images, and the Cloudflare connector for ingress |

Use a dedicated least-privilege IAM user. `AmazonEC2ReadOnlyAccess` gives a view-only EC2
connection; the setup screen shows a complete policy (`AWS_FULL_POLICY` in the connector) and
lists which optional actions unlock which tabs. The spend tile needs `ce:GetCostAndUsage` and
`ce:GetCostForecast` with Cost Explorer enabled; AWS bills about $0.01 per call and Cerebro
fetches once a day.

## Resource kinds

| Kind | Actions |
| --- | --- |
| EC2 instances | start, stop, reboot, force stop; **Launch instance** (curated Amazon Linux / Ubuntu AMIs or a custom AMI) |
| EKS clusters | Node groups sub-collection: **Scale** (min/max/desired) |
| ECS clusters | Services: start, stop (scale to 0, remembers the count), scale, redeploy. Tasks: stop |
| RDS databases | start, stop, reboot |
| EBS volumes | delete unattached |
| Elastic IPs | release unassociated |
| S3 buckets | list (all buckets in the account) |
| NAT gateways, load balancers, EBS snapshots, RDS snapshots, DynamoDB | list + delete |
| Lambda | list |
| CloudFront | enable, disable |
| ElastiCache | reboot, delete |

## Overview metrics

EC2 reports `vmsRunning` / `vmsTotal` so instances roll into the dashboard's VMs tile next to
Proxmox. Then `eksClusters`, `ecsClusters`, `rdsInstances`, `s3Buckets`; waste signals
`eipUnassociated` and `ebsUnattached` (only when above zero); and spend: `costMtd`,
`costLastMonth`, `costForecast`, plus `costSvc:<service>` per service. Each count is skipped if
the key isn't permitted to read it.

## Alerts

`cost.threshold` fires when month-to-date spend (`costMtd`) crosses the limit set on the
connector's Alerts tab. Reachability is covered by the baseline connection monitor.
