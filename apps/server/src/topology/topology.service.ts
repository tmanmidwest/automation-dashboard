import { Injectable } from '@nestjs/common';
import type { ConnectorResource, TopoFeed, TopologyGraph } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { effectiveSshHost } from '../connectors/docker/docker-ssh';
import { buildTopology, type BuildInput, type InstRef } from './topology.builder';

/** Serve a built graph this long before rebuilding in the background. */
const SERVE_MAX_MS = 2 * 60_000;
/** A Fabric agent seen this recently counts as online. */
const AGENT_ONLINE_MS = 3 * 60_000;

/** Host part of a URL-ish config value ("https://192.168.10.5:8006" → "192.168.10.5"). */
function hostOf(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const m = /^(?:[a-z]+:\/\/)?\[?([^\]/:]+)/i.exec(v.trim());
  return m ? m[1] : null;
}

/**
 * Builds the architecture map: reads each enabled connector's resource lists (from
 * the same last-good cache the connector pages use, so opening the map doesn't hammer
 * the devices) plus App Replicator and Fabric rows, and hands them to the pure
 * builder. The result is cached and rebuilt stale-while-revalidate.
 */
@Injectable()
export class TopologyService {
  constructor(
    private readonly instances: ConnectorInstanceService,
    private readonly prisma: PrismaService,
    private readonly logging: LoggingService,
  ) {}

  private cache: { at: number; graph: TopologyGraph } | null = null;
  private inflight: Promise<TopologyGraph> | null = null;

  async graph(force = false): Promise<TopologyGraph> {
    if (force || !this.cache) return this.rebuild(force);
    if (Date.now() - this.cache.at >= SERVE_MAX_MS) void this.rebuild(false).catch(() => { /* keep last good */ });
    return this.cache.graph;
  }

  private rebuild(refresh: boolean): Promise<TopologyGraph> {
    if (this.inflight) return this.inflight;
    this.inflight = this.gather(refresh)
      .then((input) => {
        const graph = buildTopology(input);
        this.cache = { at: Date.now(), graph };
        return graph;
      })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async gather(refresh: boolean): Promise<BuildInput> {
    const feeds: TopoFeed[] = [];
    const input: BuildInput = { unifi: [], proxmox: [], docker: [], npm: [], technitium: [], cloudflare: [], replicator: [], fabric: [], feeds };
    const all = (await this.instances.list()).filter((i) => i.enabled);

    /** One resource list; a failure marks the feed but never sinks the whole map. */
    const list = async (instId: string, kind: string, errs: string[]): Promise<ConnectorResource[]> => {
      try {
        return (await this.instances.listResourcesCached(instId, kind, { refresh })).resources;
      } catch (err) {
        errs.push(`${kind}: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    };
    const subs = async (instId: string, kind: string, id: string, sub: string, errs: string[]) => {
      try {
        return await this.instances.listSubResources(instId, kind, id, sub);
      } catch (err) {
        errs.push(`${kind} ${id}: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    };

    await Promise.all(
      all.map(async (i) => {
        const inst: InstRef = { id: i.id, name: i.name };
        const cfg = (i.config ?? {}) as Record<string, unknown>;
        const errs: string[] = [];
        switch (i.connectorId) {
          case 'unifi': {
            const [devices, clients, networks, portForwards, firewallRules] = await Promise.all(
              ['device', 'client', 'network', 'port_forward', 'firewall_rule'].map((k) => list(i.id, k, errs)),
            );
            input.unifi.push({ inst, devices, clients, networks, portForwards, firewallRules });
            break;
          }
          case 'proxmox': {
            const [qemu, lxc] = await Promise.all([list(i.id, 'qemu', errs), list(i.id, 'lxc', errs)]);
            input.proxmox.push({ inst, baseHost: hostOf(cfg.baseUrl), guests: [...qemu, ...lxc] });
            break;
          }
          case 'docker': {
            const [hosts, containers] = await Promise.all([list(i.id, 'docker_host', errs), list(i.id, 'container', errs)]);
            input.docker.push({ inst, endpointHost: effectiveSshHost(cfg) || null, hosts, containers });
            break;
          }
          case 'nginx-proxy-manager': {
            input.npm.push({ inst, baseHost: hostOf(cfg.baseUrl), proxyHosts: await list(i.id, 'proxy_host', errs) });
            break;
          }
          case 'technitium': {
            const [zones, leases] = await Promise.all([list(i.id, 'zone', errs), list(i.id, 'dhcp_lease', errs)]);
            // Records live under each zone; skip the built-in reverse / localhost zones.
            const userZones = zones.filter((z) => z.tags?.internal !== 'yes' && !z.name.endsWith('.arpa'));
            const records = (
              await Promise.all(userZones.map(async (z) => (await subs(i.id, 'zone', z.id, 'record', errs)).map((record) => ({ zone: z.name, record }))))
            ).flat();
            input.technitium.push({ inst, baseHost: hostOf(cfg.baseUrl), records, leases });
            break;
          }
          case 'cloudflare': {
            const tunnelList = await list(i.id, 'tunnel', errs);
            const tunnels = await Promise.all(tunnelList.map(async (t) => ({ tunnel: t, routes: await subs(i.id, 'tunnel', t.id, 'route', errs) })));
            input.cloudflare.push({ inst, tunnels });
            break;
          }
          default:
            return; // not on the map (yet)
        }
        feeds.push({ name: i.name, connectorId: i.connectorId, instanceId: i.id, ok: errs.length === 0, message: errs.length ? errs.join('; ') : undefined });
      }),
    );

    try {
      const deps = await this.prisma.replicatorDeployment.findMany({ include: { app: { select: { name: true } } } });
      input.replicator = deps.map((d) => ({ name: d.name, appName: d.app?.name ?? d.name, project: d.project, dockerInstanceId: d.dockerInstanceId, status: d.status }));
      feeds.push({ name: 'App Replicator', connectorId: 'replicator', ok: true });
    } catch (err) {
      feeds.push({ name: 'App Replicator', connectorId: 'replicator', ok: false, message: String(err) });
    }
    try {
      const agents = await this.prisma.agent.findMany({ select: { id: true, name: true, hostname: true, localIp: true, lastSeenAt: true, mode: true } });
      const now = Date.now();
      input.fabric = agents.map((a) => ({
        id: a.id,
        name: a.name,
        hostname: a.hostname,
        localIp: a.localIp,
        mode: a.mode,
        online: !!a.lastSeenAt && now - a.lastSeenAt.getTime() < AGENT_ONLINE_MS,
      }));
      feeds.push({ name: 'Fabric', connectorId: 'fabric', ok: true });
    } catch (err) {
      feeds.push({ name: 'Fabric', connectorId: 'fabric', ok: false, message: String(err) });
    }

    const bad = feeds.filter((f) => !f.ok);
    if (bad.length) void this.logging.warn('topology', `Architecture map built with ${bad.length} partial source(s): ${bad.map((b) => b.name).join(', ')}`);
    feeds.sort((a, b) => a.name.localeCompare(b.name));
    return input;
  }
}
