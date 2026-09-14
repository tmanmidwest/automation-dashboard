import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../logging/audit.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { dockerTargetFrom } from './docker-target';
import type {
  AddIngressInput, IngressTarget, CfTunnelOption, NpmCertOption, ReplicatorIngress, ReplicatorPort, ReplicatorIngressKind,
  TargetKind, EcsDeploymentRefs,
} from '@cerebro/shared';
import type { ReplicatorDeployment as DeploymentRow } from '@prisma/client';
import type { ActorCtx } from '../secrets/secrets.service';
import type { ReplicatorIngress as IngressRow } from '@prisma/client';

const CF = 'cloudflare';
const NPM = 'nginx-proxy-manager';

/**
 * App Replicator Phase 2 — expose a deployment's published port through a
 * Cloudflare tunnel public-hostname route or an Nginx Proxy Manager proxy host,
 * by driving those connectors' own operations. CF's add/delete-route are
 * resource-scoped (the tunnel is the resourceId); NPM's create is a `create` op
 * and its delete is `deleteResource('proxy_host', id)`. See docs/app-replicator.md.
 */
@Injectable()
export class IngressService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: ConnectorInstanceService,
    private readonly audit: AuditService,
  ) {}

  /** Cloudflare + NPM connector instances that can front a deployment. */
  async listTargets(): Promise<IngressTarget[]> {
    const list = await this.instances.list();
    return list
      .filter((i) => i.enabled && (i.connectorId === CF || i.connectorId === NPM))
      .map((i) => ({ instanceId: i.id, name: i.name, kind: (i.connectorId === CF ? 'cloudflare' : 'npm') as ReplicatorIngressKind }));
  }

  /** Tunnels offered by a Cloudflare instance (for the ingress picker). */
  async listTunnels(instanceId: string): Promise<CfTunnelOption[]> {
    const res = await this.instances.listResources(instanceId, 'tunnel').catch(() => []);
    // Editability (local vs remote) is enforced by the connector op; surfaced there if a
    // local tunnel is chosen. We list all and let the add guard reject a local one.
    return res.map((r) => ({ id: r.id, name: r.name, editable: true }));
  }

  /** Certificates offered by an NPM instance (id 0 = None / HTTP-only). */
  async listCerts(instanceId: string): Promise<NpmCertOption[]> {
    const opts = await this.instances.resolveOptions(instanceId, 'npm-certs', {}).catch(() => []);
    return opts.map((o) => ({ id: Number(o.value) || 0, name: o.label }));
  }

  async listForDeployment(deploymentId: string): Promise<ReplicatorIngress[]> {
    const rows = await this.prisma.replicatorIngress.findMany({ where: { deploymentId }, orderBy: { createdAt: 'asc' } });
    const names = await this.instanceNames();
    return rows.map((r) => this.map(r, names.get(r.instanceId)));
  }

  // ── Add ────────────────────────────────────────────────────────────

  async add(deploymentId: string, input: AddIngressInput, actor: ActorCtx): Promise<ReplicatorIngress> {
    const dep = await this.prisma.replicatorDeployment.findUnique({ where: { id: deploymentId } });
    if (!dep) throw new NotFoundException('Deployment not found.');

    const hostname = input.hostname?.trim();
    if (!hostname) throw new BadRequestException('A hostname is required.');

    // ECS deployments front their ALB with a Cloudflare DNS record, not a tunnel/NPM.
    if (((dep.targetKind as TargetKind) ?? 'docker') === 'ecs') {
      return this.addEcs(dep, input, hostname, actor);
    }

    const ports = (dep.ports as unknown as ReplicatorPort[]) ?? [];
    if (!ports.some((p) => p.hostPort === input.hostPort)) {
      throw new BadRequestException('That port is not published by this deployment.');
    }

    const hostIp = await this.hostIpFor(dep.dockerInstanceId);
    if (!hostIp) throw new BadRequestException('Could not determine the deployment host IP from its Docker connector.');

    let ref: string;
    if (input.kind === 'cloudflare') {
      if (!input.tunnelId) throw new BadRequestException('Pick a Cloudflare tunnel.');
      const service = `http://${hostIp}:${input.hostPort}`;
      const res = await this.instances.runResourceOperationAwait(input.instanceId, 'tunnel-add-route', input.tunnelId, {
        hostname, service, createDns: true,
      });
      if (!res.ok) throw new BadGatewayException(res.message || 'Cloudflare rejected the route.');
      ref = input.tunnelId; // delete needs the tunnel id + hostname (stored in its column)
    } else if (input.kind === 'npm') {
      const certId = input.certificateId ?? 0;
      const res = await this.instances.runResourceOperationAwait(input.instanceId, 'create-proxy-host', undefined, {
        domain_names: hostname,
        forward_scheme: 'http',
        forward_host: hostIp,
        forward_port: input.hostPort,
        certificate_id: String(certId),
        ssl_forced: certId > 0 && !!input.sslForced,
        block_exploits: true,
        allow_websocket_upgrade: true,
        caching_enabled: false,
      });
      if (!res.ok) throw new BadGatewayException(res.message || 'NPM rejected the proxy host.');
      if (!res.createdResourceId) throw new BadGatewayException('NPM did not return the created proxy host id.');
      ref = res.createdResourceId;
    } else {
      throw new BadRequestException('Unknown ingress kind.');
    }

    const row = await this.prisma.replicatorIngress.create({
      data: { deploymentId, kind: input.kind, instanceId: input.instanceId, service: portService(ports, input.hostPort), hostPort: input.hostPort, hostname, ref },
    });
    await this.audit.record({ ...actor, action: 'replicator.ingress_add', target: `${dep.project} → ${hostname}`, meta: { kind: input.kind } });
    const names = await this.instanceNames();
    return this.map(row, names.get(row.instanceId));
  }

  /**
   * ECS ingress: add an ALB host-header rule (hostname → the deployment's target
   * group) on its AWS connector, plus a proxied Cloudflare CNAME (hostname → the
   * ALB DNS name) on the chosen CF connector. Both handles are stored so teardown
   * can undo them. Best-effort rollback of the rule if the DNS step fails.
   */
  private async addEcs(dep: DeploymentRow, input: AddIngressInput, hostname: string, actor: ActorCtx): Promise<ReplicatorIngress> {
    const refs = (dep.ecs as unknown as EcsDeploymentRefs | null) ?? null;
    if (!refs?.albListenerArn || !refs.targetGroupArn || !refs.albDnsName) {
      throw new BadRequestException('This ECS deployment has no load balancer to route to — it has no published port, or no ALB security group was configured on the AWS connector.');
    }
    if (input.kind !== 'cloudflare') throw new BadRequestException('ECS deployments are exposed via a Cloudflare DNS record — choose a Cloudflare target.');

    // 1. ALB listener rule on the deployment's AWS connector.
    const ruleRes = await this.instances.runResourceOperationAwait(dep.dockerInstanceId, 'alb-create-rule', undefined, {
      rule: { listenerArn: refs.albListenerArn, hostname, targetGroupArn: refs.targetGroupArn },
    });
    if (!ruleRes.ok) throw new BadGatewayException(ruleRes.message || 'Could not add the ALB listener rule.');
    const ruleArn = String(ruleRes.data?.ruleArn ?? '');

    // 2. Resolve the CF zone for the hostname, then create a proxied CNAME → ALB.
    const zoneId = await this.resolveZone(input.instanceId, hostname);
    if (!zoneId) {
      await this.instances.runResourceOperationAwait(dep.dockerInstanceId, 'alb-delete-rule', undefined, { ruleArn }).catch(() => {});
      throw new BadRequestException('No Cloudflare zone on that connector matches the hostname.');
    }
    const dnsRes = await this.instances.runResourceOperationAwait(input.instanceId, 'create-dns-record', undefined, {
      zone: zoneId, type: 'CNAME', name: hostname, content: refs.albDnsName, proxied: true,
    });
    if (!dnsRes.ok || !dnsRes.createdResourceId) {
      await this.instances.runResourceOperationAwait(dep.dockerInstanceId, 'alb-delete-rule', undefined, { ruleArn }).catch(() => {});
      throw new BadGatewayException(dnsRes.message || 'Cloudflare rejected the DNS record.');
    }

    const ports = (dep.ports as unknown as ReplicatorPort[]) ?? [];
    const row = await this.prisma.replicatorIngress.create({
      data: {
        deploymentId: dep.id,
        kind: 'cloudflare',
        instanceId: input.instanceId,
        service: ports[0]?.service ?? 'app',
        hostPort: refs.routedContainerPort ?? 0,
        hostname,
        ref: dnsRes.createdResourceId, // "zoneId:recordId" — the CF teardown handle
        meta: { ruleArn, awsInstanceId: dep.dockerInstanceId },
      },
    });
    await this.audit.record({ ...actor, action: 'replicator.ingress_add', target: `${dep.project} → ${hostname}`, meta: { kind: 'ecs-alb' } });
    const names = await this.instanceNames();
    return this.map(row, names.get(row.instanceId));
  }

  /** Longest-suffix match of a hostname against the CF connector's zones → zone id. */
  private async resolveZone(cfInstanceId: string, hostname: string): Promise<string | null> {
    const zones = await this.instances.listResources(cfInstanceId, 'zone').catch(() => []);
    let bestId: string | null = null;
    let bestLen = -1;
    for (const z of zones) {
      const n = z.name;
      if (n && (hostname === n || hostname.endsWith(`.${n}`)) && n.length > bestLen) { bestId = z.id; bestLen = n.length; }
    }
    return bestId;
  }

  // ── Remove ─────────────────────────────────────────────────────────

  async remove(ingressId: string, actor: ActorCtx): Promise<{ ok: boolean; message: string }> {
    const row = await this.prisma.replicatorIngress.findUnique({ where: { id: ingressId } });
    if (!row) throw new NotFoundException('Ingress not found.');
    const problem = await this.teardown(row);
    await this.prisma.replicatorIngress.delete({ where: { id: row.id } });
    await this.audit.record({ ...actor, action: 'replicator.ingress_remove', target: row.hostname, meta: { kind: row.kind, problem } });
    return problem
      ? { ok: true, message: `Removed the ingress record. The route may need manual cleanup: ${problem}` }
      : { ok: true, message: `Removed ingress for ${row.hostname}.` };
  }

  /** Tear down every ingress for a deployment (called during deployment teardown). */
  async removeAllForDeployment(deploymentId: string): Promise<string[]> {
    const rows = await this.prisma.replicatorIngress.findMany({ where: { deploymentId } });
    const problems: string[] = [];
    for (const row of rows) {
      const p = await this.teardown(row);
      if (p) problems.push(`${row.hostname}: ${p}`);
    }
    // Rows themselves cascade-delete with the deployment; nothing else to do here.
    return problems;
  }

  /** Best-effort: remove the actual route/proxy host. Returns a problem string or null. */
  private async teardown(row: IngressRow): Promise<string | null> {
    const meta = (row.meta as unknown as { ruleArn?: string; awsInstanceId?: string } | null) ?? null;
    try {
      // ECS/ALB ingress: remove the CF DNS record + the ALB listener rule.
      if (meta?.ruleArn) {
        const problems: string[] = [];
        const dns = await this.instances.deleteResource(row.instanceId, 'dns_record', row.ref).catch((e) => ({ ok: false, message: e instanceof Error ? e.message : 'DNS delete failed' }));
        if (!dns.ok) problems.push(dns.message);
        if (meta.awsInstanceId) {
          const rule = await this.instances.runResourceOperationAwait(meta.awsInstanceId, 'alb-delete-rule', undefined, { ruleArn: meta.ruleArn }).catch((e) => ({ ok: false, message: e instanceof Error ? e.message : 'rule delete failed' }));
          if (!rule.ok) problems.push(rule.message);
        }
        return problems.length ? problems.join('; ') : null;
      }
      if (row.kind === 'cloudflare') {
        const res = await this.instances.runResourceOperationAwait(row.instanceId, 'tunnel-delete-route', row.ref, { hostname: row.hostname });
        return res.ok ? null : res.message;
      }
      const res = await this.instances.deleteResource(row.instanceId, 'proxy_host', row.ref);
      return res.ok ? null : res.message;
    } catch (err) {
      return err instanceof Error ? err.message : 'route teardown failed';
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private async hostIpFor(dockerInstanceId: string): Promise<string> {
    const instance = await this.instances.get(dockerInstanceId).catch(() => null);
    if (!instance) return '';
    const ctx = await this.instances.contextFor(instance);
    return dockerTargetFrom(ctx).hostIp;
  }

  private async instanceNames(): Promise<Map<string, string>> {
    const list = await this.instances.list().catch(() => []);
    return new Map(list.map((i) => [i.id, i.name]));
  }

  private map(row: IngressRow, instanceName?: string): ReplicatorIngress {
    return {
      id: row.id,
      deploymentId: row.deploymentId,
      kind: row.kind as ReplicatorIngressKind,
      instanceId: row.instanceId,
      instanceName,
      service: row.service,
      hostPort: row.hostPort,
      hostname: row.hostname,
      ref: row.ref,
      url: `https://${row.hostname}`,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

function portService(ports: ReplicatorPort[], hostPort: number): string {
  return ports.find((p) => p.hostPort === hostPort)?.service ?? 'app';
}
