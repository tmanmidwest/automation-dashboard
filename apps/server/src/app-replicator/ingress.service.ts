import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../logging/audit.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { dockerTargetFrom } from './docker-target';
import type {
  AddIngressInput, IngressTarget, CfTunnelOption, NpmCertOption, ReplicatorIngress, ReplicatorPort, ReplicatorIngressKind,
} from '@cerebro/shared';
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

    const ports = (dep.ports as unknown as ReplicatorPort[]) ?? [];
    if (!ports.some((p) => p.hostPort === input.hostPort)) {
      throw new BadRequestException('That port is not published by this deployment.');
    }
    const hostname = input.hostname?.trim();
    if (!hostname) throw new BadRequestException('A hostname is required.');

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
    try {
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
