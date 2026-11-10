import { osUpdateFindings } from '../os-updates/os-updates.logic';
import { Injectable } from '@nestjs/common';
import type { ConnectorResource, PostureFinding, TopoFeed, TopologyGraph, TopologyProgress, TopologyStep } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { effectiveSshHost } from '../connectors/docker/docker-ssh';
import { SettingsService } from '../settings/settings.service';
import { buildTopology, type BuildInput, type InstRef } from './topology.builder';
import type { HibpBreach } from './hibp.service';
import { buildFindings, ctDomains, npmNameGuards, sortFindings, eolProducts, productVersions, wanIps, type CtInput, type VersionCveInput } from './posture';
import { PostureTrackingService } from './posture-tracking.service';
import { OutsideInService } from './outside-in.service';
import { ImageScanService } from './image-scan.service';
import { VersionCveService } from './version-cve.service';
import { CtLogService, registrable } from './ct-log.service';
import { buildExposure, comboFindings } from './exposure';

const INTERNAL_KEY = 'posture.internalNames';
import { HibpService } from './hibp.service';

/** Serve a built graph this long before rebuilding in the background. */
const SERVE_MAX_MS = 2 * 60_000;
/** A background rebuild re-reads a connector's resource list once its cached copy is this old. */
const RESOURCE_MAX_MS = 5 * 60_000;
/** A Fabric agent seen this recently counts as online. */
const AGENT_ONLINE_MS = 3 * 60_000;

/** Connectors the map reads, and what to call them while it does. */
const MAP_CONNECTORS = new Set(['unifi', 'proxmox', 'docker', 'nginx-proxy-manager', 'backblaze', 'technitium', 'cloudflare']);
/** Cerebro's own steps after the connectors, in the order they run. */
const CHECK_STEPS: [string, string][] = [
  ['local', 'App Replicator and Fabric agents'],
  ['dns', 'Public DNS for your proxy names'],
  ['outside', 'Outside-in checks (Shodan, CISA KEV, endoflife.date)'],
  ['nvd', 'Known CVEs for your software versions (NVD)'],
  ['ct', 'Certificate logs and breach list'],
  ['scan', 'Container image scan results'],
  ['findings', 'Working out findings and exposure paths'],
  ['history', 'Recording what changed'],
];

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
    private readonly outsideIn: OutsideInService,
    private readonly imageScan: ImageScanService,
    private readonly versionCve: VersionCveService,
    private readonly ctLog: CtLogService,
    private readonly hibp: HibpService,
    private readonly tracking: PostureTrackingService,
  ) {}

  private cache: { at: number; graph: TopologyGraph } | null = null;
  private progress: TopologyProgress = { running: false, refresh: false, steps: [] };

  /** What the running build is doing (or what the last one did). */
  buildProgress(): TopologyProgress {
    return { ...this.progress, steps: this.progress.steps.map((x) => ({ ...x })) };
  }

  private step(key: string, state: TopologyStep['state'], detail?: string): void {
    const st = this.progress.steps.find((x) => x.key === key);
    if (st) { st.state = state; if (detail !== undefined) st.detail = detail; }
  }

  /** Runs one step: running → done (or failed with the error); the result is returned. */
  private async track<T>(key: string, fn: () => Promise<T>, detail?: (r: T) => string | undefined): Promise<T> {
    this.step(key, 'running');
    try {
      const r = await fn();
      this.step(key, 'done', detail?.(r));
      return r;
    } catch (err) {
      this.step(key, 'failed', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
  private inflight: Promise<TopologyGraph> | null = null;
  private inflightForced = false;

  async graph(force = false): Promise<TopologyGraph> {
    let g: TopologyGraph;
    if (force || !this.cache) g = await this.rebuild(force);
    else {
      if (Date.now() - this.cache.at >= SERVE_MAX_MS) void this.rebuild(false).catch(() => { /* keep last good */ });
      g = this.cache.graph;
    }
    // Item snoozes / accepted risks are applied per request, so they show up without a rebuild.
    // Scan status is live too (progress while a scan runs).
    const imageScan = await this.imageScan.summary().catch(() => g.imageScan);
    return { ...g, imageScan, findings: await this.tracking.annotate(g.findings ?? [], g) };
  }

  /** Snooze every open item of a finding for `days` (the map's finding card). Returns the finding as now shown. */
  async snooze(id: string, days: number, actor?: string): Promise<PostureFinding | null> {
    if (!(await this.graph()).findings?.some((x) => x.id === id)) return null;
    await this.tracking.setItems(id, [], 'snooze', { days, actor });
    return (await this.graph()).findings?.find((x) => x.id === id) ?? null;
  }

  /** Switch the outside-in checks on or off; the next map build picks it up. */
  async setOutsideIn(on: boolean): Promise<void> {
    await this.outsideIn.setEnabled(on);
    this.cache = null;
  }

  /** Public names you marked "Treat as internal" (they drop out of exposure paths and internet findings). */
  async internalNames(): Promise<string[]> {
    const v = await this.settings.get<string[]>(INTERNAL_KEY);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  }

  async setInternal(name: string, internal: boolean): Promise<void> {
    const n = name.trim().toLowerCase();
    const cur = new Set(await this.internalNames());
    if (internal) cur.add(n);
    else cur.delete(n);
    await this.settings.set(INTERNAL_KEY, [...cur].sort());
    this.cache = null;
  }

  async setPublicDnsResolver(url: string | null): Promise<void> {
    await this.ctLog.setResolverUrl(url);
    this.cache = null;
  }

  /** Switch the nightly image CVE scan on or off. */
  async setImageScan(on: boolean): Promise<void> {
    await this.imageScan.setEnabled(on);
    this.cache = null;
  }

  /** Start a scan of every running image now (returns at once; the map shows progress). */
  async scanImagesNow(): Promise<void> {
    this.cache = null;
    void this.imageScan.scanAll(true).then(() => { this.cache = null; }).catch(() => undefined);
  }

  async unsnooze(id: string, actor?: string): Promise<boolean> {
    return (await this.tracking.setItems(id, [], 'reopen', { actor })) > 0;
  }

  private rebuild(refresh: boolean): Promise<TopologyGraph> {
    if (this.inflight) {
      // A Refresh that lands while a background rebuild (cached data) runs waits for it, then
      // re-reads everything live; joining it would hand back the cached data.
      if (!refresh || this.inflightForced) return this.inflight;
      return this.inflight.catch(() => undefined).then(() => this.rebuild(true));
    }
    this.inflightForced = refresh;
    const startedAt = Date.now();
    const last = this.progress.startedAt && this.progress.finishedAt ? new Date(this.progress.finishedAt).getTime() - new Date(this.progress.startedAt).getTime() : this.progress.lastDurationMs;
    this.progress = { running: true, refresh, startedAt: new Date(startedAt).toISOString(), lastDurationMs: last, steps: CHECK_STEPS.map(([key, label]) => ({ key, label, kind: 'check', state: 'waiting' })) };
    this.inflight = this.gather(refresh)
      .then(async (input) => {
        const graph = buildTopology(input);
        input.internalNames = await this.internalNames();
        // Public DNS (Cloudflare) tells internet-facing names from internal ones.
        this.step('dns', 'running');
        try {
          const cf = await this.ctLog.cloudflareNames();
          // Names NPM serves outside the Cloudflare zones: ask public resolvers.
          const others = input.npm
            .flatMap((n) => n.proxyHosts.flatMap((p) => String(p.details?.domains ?? p.name ?? '').split(/[,\s]+/)))
            .map((x) => x.trim().toLowerCase())
            .filter((x) => x.includes('.') && !cf.zones.some((z) => x === z || x.endsWith(`.${z}`)));
          input.publicDns = { ...cf, resolved: others.length ? await this.ctLog.publicResolve(others) : {} };
          graph.publicDnsResolver = await this.ctLog.resolverUrl();
          this.step('dns', 'done', `${Object.keys(input.publicDns.resolved ?? {}).length} names outside Cloudflare looked up`);
        } catch {
          /* unknown: names are treated as public */
          this.step('dns', 'failed', 'Could not check; names are treated as public');
        }
        let intel = null;
        this.step('outside', 'running');
        try {
          if (await this.outsideIn.enabled()) {
            intel = await this.outsideIn.gather(wanIps(input), eolProducts(input));
            this.step('outside', intel.errors.length ? 'failed' : 'done', intel.errors.length ? `Couldn't reach ${intel.errors.join(', ')} (using last data)` : `${intel.wan.length} WAN address${intel.wan.length === 1 ? '' : 'es'} checked`);
            graph.outsideIn = { enabled: true, wan: intel.wan.map(({ ip, ports, hostnames, vulns, tags, checkedAt }) => ({ ip, ports, hostnames, vulns, tags, checkedAt })), errors: intel.errors };
          } else {
            graph.outsideIn = { enabled: false, wan: [], errors: [] };
            for (const k of ['outside', 'nvd', 'ct']) this.step(k, 'skipped', 'Outside-in checks are off');
          }
        } catch (err) {
          void this.logging.warn('topology', `Outside-in checks failed: ${err instanceof Error ? err.message : String(err)}`);
          this.step('outside', 'failed', err instanceof Error ? err.message : String(err));
        }
        // Known CVEs for Proxmox / NPM / UniFi versions (NVD); part of the outside-in checks.
        let versionCves: VersionCveInput | null = null;
        if (graph.outsideIn?.enabled) {
          this.step('nvd', 'running');
          try {
            const tested: Record<string, Record<string, unknown> | null> = {};
            for (const x of [...input.proxmox, ...input.npm, ...input.unifi]) tested[x.inst.id] = this.instances.lastTestDetails(x.inst.id);
            const products = productVersions(input, graph, tested);
            const store = await this.versionCve.cached();
            versionCves = { products, cves: store };
            if (products.some((p) => store[p.cpe]?.error)) graph.outsideIn.errors = [...new Set([...graph.outsideIn.errors, 'NVD'])];
            // Fetch what's missing or stale in the background; rebuild when it lands.
            void this.versionCve.refresh(products.map((p) => p.cpe), refresh).then((changed) => { if (changed) this.cache = null; }).catch(() => undefined);
            this.step('nvd', 'done', `${products.length} product version${products.length === 1 ? '' : 's'} checked`);
          } catch (err) {
            void this.logging.warn('topology', `Version CVE lookups failed: ${err instanceof Error ? err.message : String(err)}`);
            this.step('nvd', 'failed', err instanceof Error ? err.message : String(err));
          }
        }
        // Certificate Transparency (crt.sh) for your public domains; also part of outside-in.
        let ct: CtInput | null = null;
        let hibp: { domains: string[]; breaches: HibpBreach[] } | null = null;
        if (graph.outsideIn?.enabled) {
          this.step('ct', 'running');
          try {
            const cf = await this.ctLog.cloudflareNames();
            const domains = ctDomains(graph, cf.zones, registrable);
            const store = await this.ctLog.cached();
            ct = { extraNames: cf.names, store: Object.fromEntries(Object.entries(store).filter(([d]) => domains.includes(d))) };
            if (domains.some((d) => store[d]?.error)) graph.outsideIn.errors = [...new Set([...graph.outsideIn.errors, 'the certificate logs (crt.sh and Cert Spotter)'])];
            void this.ctLog.refresh(domains, refresh).then((changed) => { if (changed) this.cache = null; }).catch(() => undefined);
            // Have I Been Pwned (free catalogue, matched locally) for the same domains.
            const hs = await this.hibp.cached();
            hibp = { domains, breaches: hs.breaches };
            if (hs.error && !hs.at) graph.outsideIn.errors = [...new Set([...graph.outsideIn.errors, 'Have I Been Pwned'])];
            void this.hibp.refresh(refresh).then((changed) => { if (changed) this.cache = null; }).catch(() => undefined);
            this.step('ct', 'done', `${domains.length} domain${domains.length === 1 ? '' : 's'}`);
          } catch (err) {
            void this.logging.warn('topology', `Certificate log check failed: ${err instanceof Error ? err.message : String(err)}`);
            this.step('ct', 'failed', err instanceof Error ? err.message : String(err));
          }
        }
        let scans = null;
        this.step('scan', 'running');
        try {
          graph.imageScan = await this.imageScan.summary();
          if (graph.imageScan.enabled) scans = await this.imageScan.results();
          this.step('scan', graph.imageScan.enabled ? 'done' : 'skipped', graph.imageScan.enabled ? `${graph.imageScan.scanned} images` : 'Image scan is off');
        } catch (err) {
          void this.logging.warn('topology', `Image CVE results unavailable: ${err instanceof Error ? err.message : String(err)}`);
          this.step('scan', 'failed', err instanceof Error ? err.message : String(err));
        }
        let findingsOk = true;
        this.step('findings', 'running');
        try {
          graph.findings = buildFindings(input, graph, new Date(), intel, scans, versionCves, ct, hibp);
          // Exposure paths use the findings for their hops; path combos become a finding too.
          graph.exposure = buildExposure(graph, graph.findings, npmNameGuards(input));
          graph.findings = sortFindings([...graph.findings, ...comboFindings(graph.exposure, new Map(graph.nodes.map((n) => [n.id, n]))), ...(await this.osUpdatePosture())]);
          this.step('findings', 'done', `${graph.findings.length} finding${graph.findings.length === 1 ? '' : 's'}`);
        } catch (err) {
          void this.logging.warn('topology', `Posture findings failed: ${err instanceof Error ? err.message : String(err)}`);
          graph.findings = [];
          findingsOk = false;
          this.step('findings', 'failed', err instanceof Error ? err.message : String(err));
        }
        // Remember first seen / fixed. A build with a failed connector can't say something was
        // fixed (its findings may just be missing), so then nothing is marked fixed.
        await this.track('history', () => this.tracking.sync(graph.findings ?? [], findingsOk && graph.feeds.every((f) => f.ok)));
        try {
          const rows = await this.prisma.networkDevice.findMany({ where: { typeOverride: { not: null } }, select: { mac: true, typeOverride: true } });
          for (const r of rows) this.applyType(graph, r.mac, r.typeOverride);
        } catch {
          /* table missing before migration: keep the guesses */
        }
        this.cache = { at: Date.now(), graph };
        return graph;
      })
      .finally(() => {
        this.inflight = null;
        for (const x of this.progress.steps) if (x.state === 'running' || x.state === 'waiting') x.state = 'skipped';
        this.progress.running = false;
        this.progress.finishedAt = new Date().toISOString();
      });
    return this.inflight;
  }

  /** OS updates the Cerebro agent reports (docs/os-updates.md): security updates / restarts left waiting too long. */
  private async osUpdatePosture() {
    try {
      const rows = await this.prisma.agentUpdateStatus.findMany({
        where: { OR: [{ security: { gt: 0 } }, { rebootRequired: true }], agent: { status: { notIn: ['pending', 'revoked', 'deleting'] } } },
        select: { agentId: true, security: true, securitySince: true, rebootRequired: true, rebootSince: true, rebootReason: true, agent: { select: { name: true } } },
      });
      return osUpdateFindings(rows.map((r) => ({ ...r, name: r.agent.name })));
    } catch {
      return []; // table missing before migration
    }
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
    // One step per connector the map reads, ahead of Cerebro's own checks.
    const connectorSteps: TopologyStep[] = all
      .filter((i) => MAP_CONNECTORS.has(i.connectorId))
      .map((i) => ({ key: `c:${i.id}`, label: i.name, kind: i.connectorId, state: 'waiting' }));
    this.progress.steps = [...connectorSteps, ...this.progress.steps];
    /** What each connector returned, e.g. "81 clients · 6 devices", for its step. */
    const counts = new Map<string, string>();
    const n = (x: unknown[], one: string, many = `${one}s`) => `${x.length} ${x.length === 1 ? one : many}`;

    /** One resource list; a failure marks the feed but never sinks the whole map. */
    const list = async (instId: string, kind: string, errs: string[]): Promise<ConnectorResource[]> => {
      try {
        return (await this.instances.listResourcesCached(instId, kind, { refresh, maxAgeMs: RESOURCE_MAX_MS })).resources;
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
        if (MAP_CONNECTORS.has(i.connectorId)) this.step(`c:${i.id}`, 'running');
        switch (i.connectorId) {
          case 'unifi': {
            const [devices, clients, networks, portForwards, firewallRules] = await Promise.all(
              ['device', 'client', 'network', 'port_forward', 'firewall_rule'].map((k) => list(i.id, k, errs)),
            );
            input.unifi.push({ inst, devices, clients, networks, portForwards, firewallRules });
            counts.set(i.id, `${n(devices, 'device')} · ${n(clients, 'client')} · ${n(firewallRules, 'firewall rule')}`);
            break;
          }
          case 'proxmox': {
            const [qemu, lxc] = await Promise.all([list(i.id, 'qemu', errs), list(i.id, 'lxc', errs)]);
            input.proxmox.push({ inst, baseHost: hostOf(cfg.baseUrl), guests: [...qemu, ...lxc] });
            counts.set(i.id, `${n(qemu, 'VM')} · ${n(lxc, 'container')}`);
            break;
          }
          case 'docker': {
            const [hosts, containers] = await Promise.all([list(i.id, 'docker_host', errs), list(i.id, 'container', errs)]);
            input.docker.push({ inst, endpointHost: effectiveSshHost(cfg) || null, hosts, containers });
            counts.set(i.id, `${n(hosts, 'host')} · ${n(containers, 'container')}`);
            break;
          }
          case 'nginx-proxy-manager': {
            // Access lists only refine one finding's wording; a failure there isn't a feed error.
            const [proxyHosts, certificates, accessLists] = await Promise.all([list(i.id, 'proxy_host', errs), list(i.id, 'certificate', errs), list(i.id, 'access_list', [])]);
            input.npm.push({ inst, baseHost: hostOf(cfg.baseUrl), basePort: portOf(cfg.baseUrl), proxyHosts, certificates, accessLists });
            counts.set(i.id, `${n(proxyHosts, 'proxy host')} · ${n(certificates, 'certificate')}`);
            break;
          }
          case 'backblaze': {
            // Only the Proxmox dump folder, for backup findings; not drawn on the map.
            // A Backblaze setup without a dump folder just has no backup findings.
            const files = await list(i.id, 'local', []);
            if (files.length) (input.backups ??= []).push({ inst, files });
            counts.set(i.id, files.length ? n(files, 'backup file') : 'No Proxmox dump folder');
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
            counts.set(i.id, `${n(records, 'DNS record')} · ${n(leases, 'lease')}`);
            break;
          }
          case 'cloudflare': {
            const tunnelList = await list(i.id, 'tunnel', errs);
            const tunnels = await Promise.all(tunnelList.map(async (t) => ({ tunnel: t, routes: await subs(i.id, 'tunnel', t.id, 'route', errs) })));
            input.cloudflare.push({ inst, tunnels });
            counts.set(i.id, n(tunnels, 'tunnel'));
            break;
          }
          default:
            return; // not on the map (yet)
        }
        feeds.push({ name: i.name, connectorId: i.connectorId, instanceId: i.id, ok: errs.length === 0, message: errs.length ? errs.join('; ') : undefined });
        this.step(`c:${i.id}`, errs.length ? 'failed' : 'done', errs.length ? errs[0] : counts.get(i.id));
      }),
    );

    this.step('local', 'running');
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
    this.step('local', 'done', `${input.replicator.length} replicated apps · ${input.fabric.length} Fabric agents`);
    return input;
  }
}
