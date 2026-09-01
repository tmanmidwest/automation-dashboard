import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { METRIC_THRESHOLDS } from '../notifications/alerts/metric-thresholds';
import { ConnectorInstanceService } from './connector-instance.service';

/** Format a metric value with its unit (currency codes as "USD 12.34"). */
function fmt(value: number, unit: string): string {
  if (/^[A-Z]{3}$/.test(unit)) return `${unit} ${value.toFixed(2)}`;
  return unit ? `${value} ${unit}` : String(value);
}

/**
 * Watches per-connector numeric thresholds (cost, storage size, …; see
 * metric-thresholds.ts) and raises the matching alert when a metric from the
 * connector's overview crosses its limit. Reads each connector's overview once
 * (cached — no extra upstream calls) and only when a threshold is actually set.
 *
 * Fires once on the up-crossing: an in-memory "over" set suppresses repeats
 * until the metric drops back under the limit (which also gives cost its monthly
 * reset for free, since month-to-date starts near zero each month). Runs every
 * 5 minutes; these metrics move slowly.
 */
@Injectable()
export class MetricThresholdMonitorService {
  /** `${connectorId}:${defId}` for thresholds currently over the limit (already alerted). */
  private readonly over = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: ConnectorInstanceService,
    private readonly notifications: NotificationsService,
    private readonly logging: LoggingService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
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
        `Threshold monitor could not load instances: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    const live = new Set(rows.map((r) => r.id));
    for (const k of [...this.over]) if (!live.has(k.slice(0, k.lastIndexOf(':')))) this.over.delete(k);

    await Promise.allSettled(rows.map((r) => this.check(r.id, r.name)));
  }

  private async check(id: string, name: string): Promise<void> {
    // Only the defs this connector has a threshold set for.
    const active: { def: (typeof METRIC_THRESHOLDS)[number]; threshold: number }[] = [];
    for (const def of METRIC_THRESHOLDS) {
      const threshold = await this.notifications.connectorThreshold(id, def.id);
      if (threshold > 0) active.push({ def, threshold });
      else this.over.delete(`${id}:${def.id}`); // no threshold → clear any stale flag
    }
    if (active.length === 0) return;

    let metrics;
    try {
      metrics = (await this.instances.connectorOverview(id)).metrics;
    } catch {
      return; // connector unreachable — the connection monitor covers that
    }

    for (const { def, threshold } of active) {
      const metric = metrics.find((m) => m.key === def.metricKey);
      if (!metric) continue; // this connector doesn't report the metric
      const stateKey = `${id}:${def.id}`;
      if (metric.value >= threshold) {
        if (this.over.has(stateKey)) continue; // already alerted, don't spam
        this.over.add(stateKey);
        const unit = metric.unit ?? '';
        const val = fmt(metric.value, unit);
        const lim = fmt(threshold, unit);
        void this.notifications.dispatchAlert(def.alertKey, {
          title: `${def.label} over ${lim}: ${name}`,
          body: `${metric.label} is ${val}, over the ${lim} limit.`,
          dedupeKey: `thr:${id}:${def.id}`,
          connectorId: id,
        });
        void this.logging.info(
          'notify:monitor',
          `${def.label} threshold crossed for ${name}: ${val} >= ${lim}`,
        );
      } else {
        this.over.delete(stateKey); // back under — a future crossing can alert again
      }
    }
  }
}
