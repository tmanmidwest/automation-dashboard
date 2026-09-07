import { Injectable } from '@nestjs/common';
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

/**
 * Aggregates every enabled Docker connector instance into one merged tree for the
 * Docker Fleet screen. Reuses each connector's existing overview + resource lists
 * (so image-update chips, host telemetry, stack grouping etc. all carry over) —
 * control still flows through the normal per-instance action/operation endpoints.
 */
@Injectable()
export class DockerFleetService {
  constructor(private readonly instances: ConnectorInstanceService) {}

  async fleet(): Promise<DockerFleet> {
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
