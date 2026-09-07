import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import type {
  ConnectorResource,
  DockerFleet,
  FleetHost,
  FleetHostMetrics,
  FleetMember,
  FleetStack,
  FleetTotals,
  OverviewMetric,
} from '@cerebro/shared';

const DOCKER = 'docker';
/** Serve a cached snapshot up to this old on a normal request (poll/tap) — makes the page load instantly. */
const SERVE_MAX_MS = 25_000;
/** Keep the cache warm in the background this long after the page was last used. */
const ACTIVE_WINDOW_MS = 5 * 60_000;

/**
 * Aggregates every enabled Docker connector instance into one merged tree for the
 * Docker Fleet screen. Reuses each connector's existing overview + resource lists
 * (so image-update chips, host telemetry, stack grouping etc. all carry over) —
 * control still flows through the normal per-instance action/operation endpoints.
 *
 * Computing the tree hits every host over the network, so results are cached and
 * kept warm by a background refresh while the page is in active use — a tap serves
 * the last snapshot instantly instead of waiting on all hosts. `force` recomputes.
 */
@Injectable()
export class DockerFleetService {
  constructor(private readonly instances: ConnectorInstanceService) {}

  private cache: { at: number; data: DockerFleet } | null = null;
  private inflight: Promise<DockerFleet> | null = null;
  private lastAccess = 0;

  /** The endpoint. Serves a warm cache when fresh enough; `force` awaits a fresh compute. */
  async fleet(force = false): Promise<DockerFleet> {
    this.lastAccess = Date.now();
    if (!force && this.cache && Date.now() - this.cache.at < SERVE_MAX_MS) return this.cache.data;
    return this.refresh();
  }

  /** Recompute (deduping concurrent callers) and update the cache. */
  private refresh(): Promise<DockerFleet> {
    if (this.inflight) return this.inflight;
    this.inflight = this.compute()
      .then((data) => { this.cache = { at: Date.now(), data }; return data; })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** While the page is being used, keep the cache warm so every tap is instant. */
  @Interval(15_000)
  backgroundRefresh(): void {
    if (Date.now() - this.lastAccess < ACTIVE_WINDOW_MS) void this.refresh().catch(() => { /* keep last good cache */ });
  }

  private async compute(): Promise<DockerFleet> {
    const all = await this.instances.list();
    const docker = all.filter((i) => i.connectorId === DOCKER && i.enabled);
    const hosts = await Promise.all(docker.map((i) => this.host(i.id, i.name)));
    hosts.sort((a, b) => a.name.localeCompare(b.name));
    return { hosts, totals: this.totals(hosts) };
  }

  private async host(instanceId: string, name: string): Promise<FleetHost> {
    try {
      const [overview, stacks, containers] = await Promise.all([
        this.instances.connectorOverview(instanceId),
        this.instances.listResources(instanceId, 'stack').catch(() => [] as ConnectorResource[]),
        this.instances.listResources(instanceId, 'container').catch(() => [] as ConnectorResource[]),
      ]);
      return {
        instanceId,
        name,
        online: true,
        metrics: metricsFrom(overview.metrics),
        stacks: buildStacks(instanceId, stacks, containers),
      };
    } catch (err) {
      return {
        instanceId,
        name,
        online: false,
        error: err instanceof Error ? err.message : 'Host unreachable.',
        metrics: emptyMetrics(),
        stacks: [],
      };
    }
  }

  private totals(hosts: FleetHost[]): FleetTotals {
    const sum = (pick: (m: FleetHostMetrics) => number) => hosts.reduce((n, h) => n + (pick(h.metrics) || 0), 0);
    return {
      hosts: hosts.length,
      online: hosts.filter((h) => h.online).length,
      running: sum((m) => m.running),
      stopped: sum((m) => m.stopped),
      unhealthy: sum((m) => m.unhealthy),
      stacks: hosts.reduce((n, h) => n + h.stacks.length, 0),
      updates: sum((m) => m.updates),
      diskUsedGb: Math.round(sum((m) => m.diskUsedGb ?? 0) * 10) / 10,
    };
  }
}

// ── Pure mappers ──────────────────────────────────────────────────

function metricsFrom(metrics: OverviewMetric[]): FleetHostMetrics {
  const v = (key: string): number | undefined => metrics.find((m) => m.key === key)?.value;
  return {
    running: v('containersRunning') ?? 0,
    stopped: v('containersStopped') ?? 0,
    unhealthy: v('containersUnhealthy') ?? 0,
    restarting: v('containersRestarting') ?? 0,
    updates: v('updatesAvailable') ?? 0,
    images: v('imagesTotal'),
    diskUsedGb: v('diskUsedGb'),
    hostLoadPct: v('hostLoadPct'),
    hostMemUsedPct: v('hostMemUsedPct'),
    hostRootDiskPct: v('hostRootDiskPct'),
  };
}

function emptyMetrics(): FleetHostMetrics {
  return { running: 0, stopped: 0, unhealthy: 0, restarting: 0, updates: 0 };
}

function buildStacks(instanceId: string, stacks: ConnectorResource[], containers: ConnectorResource[]): FleetStack[] {
  const membersByStack = new Map<string, FleetMember[]>();
  for (const c of containers) {
    const project = str(c.details?.stack) || 'ungrouped';
    const arr = membersByStack.get(project) ?? [];
    arr.push({
      instanceId,
      id: c.id,
      name: c.name,
      image: str(c.details?.image) || '',
      service: str(c.details?.service) || undefined,
      status: c.status ?? 'unknown',
      hasUpdate: c.tags?.updates === 'available',
    });
    membersByStack.set(project, arr);
  }

  return stacks
    .map((s): FleetStack => {
      const members = (membersByStack.get(s.id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
      return {
        instanceId,
        id: s.id,
        name: s.name,
        status: s.status ?? 'unknown',
        containers: num(s.details?.containers) ?? members.length,
        running: num(s.details?.running) ?? members.filter((m) => m.status === 'running').length,
        updates: num(s.details?.updates) ?? members.filter((m) => m.hasUpdate).length,
        managed: s.details?.managed === true,
        members,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}
function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
