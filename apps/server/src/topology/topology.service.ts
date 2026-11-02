import { Injectable } from '@nestjs/common';
import type { ConnectorResource, PostureFinding, TopoFeed, TopologyGraph } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { effectiveSshHost } from '../connectors/docker/docker-ssh';
import { SettingsService } from '../settings/settings.service';
import { buildTopology, type BuildInput, type InstRef } from './topology.builder';
import { applySnoozes, buildFindings, type Snooze } from './posture';

const SNOOZE_KEY = 'posture.snoozes';

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

/** Explicit port of a URL-ish config value, if any. */
function portOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return /^(?:[a-z]+:\/\/)?[^/]*?:(\d+)(?:\/|$)/i.exec(v.trim())?.[1] ?? null;
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
    private readonly settings: SettingsService,
  ) {}

  private cache: { at: number; graph: TopologyGraph } | null = null;
  private inflight: Promise<TopologyGraph> | null = null;

  async graph(force = false): Promise<TopologyGraph> {
    let g: TopologyGraph;
    if (force || !this.cache) g = await this.rebuild(force);
    else {
      if (Date.now() - this.cache.at >= SERVE_MAX_MS) void this.rebuild(false).catch(() => { /* keep last good */ });
      g = this.cache.graph;
    }
    // Snoozes are applied per request, so snoozing shows up without a rebuild.
    return { ...g, findings: applySnoozes(g.findings ?? [], await this.snoozes()) };
  }

  private async snoozes(): Promise<Record<string, Snooze>> {
    return ((await this.settings.get<Record<string, Snooze>>(SNOOZE_KEY)) ?? {}) as Record<string, Snooze>;
  }

  /** Hide a finding for `days`, or until it gains an item it didn't have. Returns the finding as now shown. */
  async snooze(id: string, days: number): Promise<PostureFinding | null> {
    const f = (await this.graph()).findings?.find((x) => x.id === id);
    if (!f) return null;
    const all = await this.snoozes();
    const now = Date.now();
    // Drop lapsed entries while we're here, so the setting doesn't grow forever.
    for (const [k, v] of Object.entries(all)) if (new Date(v.until).getTime() <= now) delete all[k];
    all[id] = { until: new Date(now + days * 86_400_000).toISOString(), labels: f.affected.map((a) => a.label) };
    await this.settings.set(SNOOZE_KEY, all);
    return { ...f, snoozedUntil: all[id].until };
  }

  async unsnooze(id: string): Promise<boolean> {
    const all = await this.snoozes();
    if (!all[id]) return false;
    delete all[id];
    await this.settings.set(SNOOZE_KEY, all);
    return true;
  }

  private rebuild(refresh: boolean): Promise<TopologyGraph> {
    if (this.inflight) return this.inflight;
    this.inflight = this.gather(refresh)
      .then(async (input) => {
        const graph = buildTopology(input);
        try {
          graph.findings = buildFindings(input, graph);
        } catch (err) {
          void this.logging.warn('topology', `Posture findings failed: ${err instanceof Error ? err.message : String(err)}`);
          graph.findings = [];
        }
        try {
          const rows = await this.prisma.networkDevice.findMany({ where: { typeOverride: { not: null } }, select: { mac: true, typeOverride: true } });
          for (const r of rows) this.applyType(graph, r.mac, r.typeOverride);
        } catch {
          /* table missing before migration: keep the guesses */
        }
        this.cache = { at: Date.now(), graph };
        return graph;
      })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** A type the user set in Cerebro: patch the cached map now instead of rebuilding it. */
  setDeviceType(mac: string, type: string | null): void {
    if (this.cache) this.applyType(this.cache.graph, mac, type);
    if (!type) this.cache = null; // the guess it falls back to lives in the next build
  }

  private applyType(graph: TopologyGraph, mac: string, type: string | null): void {
    const m = mac.toLowerCase();
    for (const n of graph.nodes) {
      if (!n.macs.includes(m)) continue;
      if (type) n.deviceType = { name: type, source: 'You' };
    }
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
            const [proxyHosts, certificates] = await Promise.all([list(i.id, 'proxy_host', errs), list(i.id, 'certificate', errs)]);
            input.npm.push({ inst, baseHost: hostOf(cfg.baseUrl), basePort: portOf(cfg.baseUrl), proxyHosts, certificates });
            break;
          }
          case 'backblaze': {
            // Only the Proxmox dump folder, for backup findings; not drawn on the map.
            // A Backblaze setup without a dump folder just has no backup findings.
            const files = await list(i.id, 'local', []);
            if (files.length) (input.backups ??= []).push({ inst, files });
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
