import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ConnectorInstanceService } from './connector-instance.service';

/**
 * Baseline connection monitor: once a minute, run each enabled connector's
 * testConnection and raise an alert when its reachability *changes* (up→down or
 * down→up). Keeps per-instance state in memory and only dispatches on a real
 * transition, so a persistently-down connector is announced once, not every
 * minute. Runs independently of the dashboard (unlike dashboardOverview, which
 * only fires while someone is looking at it).
 *
 * This is deliberately simple — the richer, user-configurable alert catalog
 * (per-resource state changes, thresholds, routing rules) comes later.
 */
@Injectable()
export class ConnectionMonitorService {
  /** Last observed reachability per instance id. Absent = never checked yet. */
  private readonly health = new Map<string, 'up' | 'down'>();
  /** Instances with a check in flight, so a slow test can't overlap the next tick. */
  private readonly active = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: ConnectorInstanceService,
    private readonly notifications: NotificationsService,
    private readonly logging: LoggingService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    let rows: { id: string; name: string }[];
    try {
      rows = await this.prisma.connectorInstance.findMany({
        where: { enabled: true },
        select: { id: true, name: true },
      });
    } catch (err) {
      void this.logging.error(
        'notify:monitor',
        `Connection monitor could not load instances: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    // Forget state for connectors that were removed or disabled.
    const live = new Set(rows.map((r) => r.id));
    for (const id of this.health.keys()) if (!live.has(id)) this.health.delete(id);

    await Promise.allSettled(rows.map((r) => this.check(r.id, r.name)));
  }

  private async check(id: string, name: string): Promise<void> {
    if (this.active.has(id)) return;
    this.active.add(id);
    try {
      let ok = false;
      let message = '';
      try {
        const res = await this.instances.test(id);
        ok = !!res.ok;
        message = res.message ?? '';
      } catch (err) {
        ok = false;
        message = err instanceof Error ? err.message : 'unreachable';
      }

      const prev = this.health.get(id);
      if (ok) {
        if (prev === 'down') {
          void this.notifications.dispatchAlert('connection.recovered', {
            title: `Connector recovered: ${name}`,
            body: message || 'Connection restored.',
            dedupeKey: `conn:${id}:up`,
            connectorId: id,
          });
        }
        this.health.set(id, 'up');
      } else {
        // Alert on the transition into "down" (including first-seen-down).
        if (prev !== 'down') {
          void this.notifications.dispatchAlert('connection.down', {
            title: `Connector unreachable: ${name}`,
            body: message || 'Connection test failed.',
            dedupeKey: `conn:${id}:down`,
            connectorId: id,
          });
        }
        this.health.set(id, 'down');
      }
    } finally {
      this.active.delete(id);
    }
  }
}
