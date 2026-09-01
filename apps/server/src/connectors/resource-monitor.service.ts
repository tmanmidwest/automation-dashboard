import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { OverviewGuest } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ConnectorInstanceService } from './connector-instance.service';

type State = 'up' | 'down';

/** Classify a guest status into a stable running/stopped state, or undefined for transient/unknown. */
function classify(status: string | undefined): State | undefined {
  const s = (status ?? '').toLowerCase();
  if (['running', 'active', 'online', 'available', 'up'].includes(s)) return 'up';
  if (['stopped', 'off', 'disabled', 'shutdown', 'terminated', 'inactive', 'down'].includes(s)) {
    return 'down';
  }
  return undefined; // pending, stopping, starting, paused, template, … — don't alert on transient
}

function guestKey(g: OverviewGuest): string {
  return `${g.kind}:${g.node}:${g.name}`;
}

/**
 * Per-resource state monitor: watches each connector's guests (VMs, containers,
 * instances) and raises an alert when one transitions running↔stopped. Reuses
 * the connector's own overview() (the same data the dashboard radar shows) and
 * only re-queries a connector once per its refreshIntervalSec.
 *
 * State is in-memory: the first observation of a connector establishes a silent
 * baseline (no alert), so a restart doesn't replay every guest's status.
 */
@Injectable()
export class ResourceMonitorService {
  /** connectorId → (resourceKey → last stable state). */
  private readonly lastStatus = new Map<string, Map<string, State>>();
  /** connectorId → epoch ms of last overview fetch (to honour refreshIntervalSec). */
  private readonly lastCheck = new Map<string, number>();
  /** Connectors with a check in flight, so a slow overview can't overlap. */
  private readonly active = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: ConnectorInstanceService,
    private readonly notifications: NotificationsService,
    private readonly logging: LoggingService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    let rows: { id: string; name: string; refreshIntervalSec: number }[];
    try {
      rows = await this.prisma.connectorInstance.findMany({
        where: { enabled: true },
        select: { id: true, name: true, refreshIntervalSec: true },
      });
    } catch (err) {
      void this.logging.error(
        'notify:monitor',
        `Resource monitor could not load instances: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    const live = new Set(rows.map((r) => r.id));
    for (const id of [...this.lastStatus.keys()]) {
      if (!live.has(id)) {
        this.lastStatus.delete(id);
        this.lastCheck.delete(id);
      }
    }

    await Promise.allSettled(rows.map((r) => this.check(r.id, r.name, r.refreshIntervalSec)));
  }

  private async check(id: string, connectorName: string, refreshIntervalSec: number): Promise<void> {
    const now = Date.now();
    if (now - (this.lastCheck.get(id) ?? 0) < (refreshIntervalSec || 30) * 1000) return;
    if (this.active.has(id)) return;
    this.active.add(id);
    try {
      let guests: OverviewGuest[];
      try {
        guests = (await this.instances.connectorOverview(id)).guests;
      } catch {
        return; // connector unreachable — the connection monitor covers that
      }
      this.lastCheck.set(id, now);

      const prev = this.lastStatus.get(id);
      const first = !prev;
      const curr = new Map<string, State>();

      for (const g of guests) {
        const key = guestKey(g);
        const state = classify(g.status);
        if (!state) {
          // Transient/unknown: carry forward the last stable state so a real
          // transition through it (running → stopping → stopped) is still caught.
          const carried = prev?.get(key);
          if (carried) curr.set(key, carried);
          continue;
        }
        curr.set(key, state);
        if (!first) {
          const was = prev!.get(key);
          if (was && was !== state) {
            const alert = state === 'down' ? 'resource.stopped' : 'resource.started';
            void this.notifications.dispatchAlert(alert, {
              title: `${g.name} ${state === 'down' ? 'stopped' : 'started'} · ${connectorName}`,
              body: `${g.kind}${g.node ? ` on ${g.node}` : ''} is now ${g.status}.`,
              dedupeKey: `res:${id}:${key}:${state}`,
              connectorId: id,
            });
          }
        }
      }

      this.lastStatus.set(id, curr);
    } finally {
      this.active.delete(id);
    }
  }
}
