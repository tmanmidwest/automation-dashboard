import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';

const CF = 'cloudflare';
const NPM = 'nginx-proxy-manager';

export type IngressKind = 'cloudflare' | 'npm';

/** The teardown handle for a route: CF → tunnel id (+ hostname); NPM → proxy-host id. */
export interface IngressRef {
  kind: IngressKind;
  ref: string;
}

/**
 * The pure op-driving core for ingress routes — create / edit / delete a Cloudflare
 * tunnel public-hostname route or an Nginx Proxy Manager proxy host, by instance id
 * and plain values. No DB rows, no deployment coupling: both the App Replicator
 * ([[IngressService]] wraps this with its replicatorIngress bookkeeping) and the
 * stack migrator's cutover (which repoints a hostname source→target) use it.
 * See docs/app-replicator.md and docs/stack-migrator.md.
 */
@Injectable()
export class IngressOps {
  constructor(private readonly instances: ConnectorInstanceService) {}

  /** Resolve whether an instance fronts with Cloudflare or NPM. */
  async kindOf(instanceId: string): Promise<IngressKind> {
    const inst = await this.instances.get(instanceId);
    if (inst.connectorId === CF) return 'cloudflare';
    if (inst.connectorId === NPM) return 'npm';
    throw new BadRequestException('That connector is not a Cloudflare or Nginx Proxy Manager instance.');
  }

  // ── Cloudflare tunnel routes (keyed by hostname on a tunnel) ──────────

  async cfAddRoute(instanceId: string, tunnelId: string, hostname: string, upstreamHost: string, port: number, createDns = true, path?: string): Promise<void> {
    const res = await this.instances.runResourceOperationAwait(instanceId, 'tunnel-add-route', tunnelId, {
      hostname, service: `http://${upstreamHost}:${port}`, createDns, ...(path ? { path } : {}),
    });
    if (!res.ok) throw new BadGatewayException(res.message || 'Cloudflare rejected the route.');
  }

  /** In-place repoint of an existing hostname route on the SAME tunnel. `path` targets the
   *  exact rule when a hostname has several path-based rules (order preserved). Returns false
   *  when there is no such route to edit (caller can then add). */
  async cfEditRoute(instanceId: string, tunnelId: string, hostname: string, upstreamHost: string, port: number, path?: string): Promise<boolean> {
    const res = await this.instances.runResourceOperationAwait(instanceId, 'tunnel-edit-route', tunnelId, {
      hostname, service: `http://${upstreamHost}:${port}`, ...(path ? { path } : {}),
    });
    return res.ok;
  }

  cfDeleteRoute(instanceId: string, tunnelId: string, hostname: string): Promise<{ ok: boolean; message: string }> {
    return this.instances.runResourceOperationAwait(instanceId, 'tunnel-delete-route', tunnelId, { hostname });
  }

  // ── NPM proxy hosts (a resource with its own id) ─────────────────────

  /** The proxy-host id serving this hostname on an NPM instance, or null. */
  async npmFindHostId(instanceId: string, hostname: string): Promise<string | null> {
    const list = await this.instances.listResources(instanceId, 'proxy_host').catch(() => []);
    const want = hostname.toLowerCase();
    const hit = list.find((r) => {
      const n = (r.name ?? '').toLowerCase();
      return n === want || n.split(/[\s,]+/).includes(want);
    });
    return hit?.id ?? null;
  }

  async npmCreateHost(instanceId: string, hostname: string, upstreamHost: string, port: number, certificateId = 0, sslForced = false): Promise<string> {
    const res = await this.instances.runResourceOperationAwait(instanceId, 'create-proxy-host', undefined, {
      domain_names: hostname,
      forward_scheme: 'http',
      forward_host: upstreamHost,
      forward_port: port,
      certificate_id: String(certificateId),
      ssl_forced: certificateId > 0 && sslForced,
      block_exploits: true,
      allow_websocket_upgrade: true,
      caching_enabled: false,
    });
    if (!res.ok) throw new BadGatewayException(res.message || 'NPM rejected the proxy host.');
    if (!res.createdResourceId) throw new BadGatewayException('NPM did not return the created proxy host id.');
    return res.createdResourceId;
  }

  /** In-place repoint: change an existing proxy host's upstream (SSL/cert preserved). */
  async npmEditHost(instanceId: string, proxyHostId: string, upstreamHost: string, port: number): Promise<void> {
    const res = await this.instances.runResourceOperationAwait(instanceId, 'edit-proxy-host', proxyHostId, {
      forward_scheme: 'http', forward_host: upstreamHost, forward_port: port,
    });
    if (!res.ok) throw new BadGatewayException(res.message || 'NPM rejected the proxy host edit.');
  }

  npmDeleteHost(instanceId: string, proxyHostId: string): Promise<{ ok: boolean; message: string }> {
    return this.instances.deleteResource(instanceId, 'proxy_host', proxyHostId);
  }

  // ── High-level upsert: ensure `hostname` routes to `upstreamHost:port` ─

  /**
   * Point (or repoint) a public hostname at `upstreamHost:port`, replacing whatever
   * it served before — the migrator's cutover and rollback both call this to flip a
   * hostname between the source and target host. Prefers the in-place edit op so a
   * flip keeps the same CNAME / SSL cert; falls back to create when the route is new.
   */
  async setRoute(spec: {
    instanceId: string;
    hostname: string;
    upstreamHost: string;
    port: number;
    /** Cloudflare: the tunnel the hostname is (or will be) routed on. */
    tunnelId?: string;
    /** Cloudflare: path matcher for a path-based rule (targets the exact rule to edit). */
    path?: string;
    /** NPM: certificate to attach when CREATING a new proxy host (ignored on edit). */
    certificateId?: number;
    sslForced?: boolean;
    kind?: IngressKind;
  }): Promise<IngressRef> {
    const kind = spec.kind ?? (await this.kindOf(spec.instanceId));
    const hostname = spec.hostname.trim();
    if (!hostname) throw new BadRequestException('A hostname is required.');

    if (kind === 'cloudflare') {
      if (!spec.tunnelId) throw new BadRequestException('Pick a Cloudflare tunnel for the route.');
      const edited = await this.cfEditRoute(spec.instanceId, spec.tunnelId, hostname, spec.upstreamHost, spec.port, spec.path);
      if (!edited) await this.cfAddRoute(spec.instanceId, spec.tunnelId, hostname, spec.upstreamHost, spec.port, true, spec.path);
      return { kind, ref: spec.tunnelId };
    }

    const existing = await this.npmFindHostId(spec.instanceId, hostname);
    if (existing) {
      await this.npmEditHost(spec.instanceId, existing, spec.upstreamHost, spec.port);
      return { kind, ref: existing };
    }
    const ref = await this.npmCreateHost(spec.instanceId, hostname, spec.upstreamHost, spec.port, spec.certificateId ?? 0, spec.sslForced);
    return { kind, ref };
  }
}
