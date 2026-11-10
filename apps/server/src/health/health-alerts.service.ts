import { Injectable, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { HealthIssue } from '@cerebro/shared';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { LoggingService } from '../logging/logging.service';
import { HealthService } from './health.service';

/** Persisted "already alerted" map, so a redeploy doesn't re-send every open issue. */
const STATE_KEY = 'health.alertState';

const ALERT_FOR: Partial<Record<HealthIssue['key'], string>> = {
  disk: 'health.disk',
  inodes: 'health.disk',
  memory: 'health.memory',
  cpu: 'health.cpu',
};

/**
 * Turns Health issues into alerts (docs/health-monitoring.md). Runs every minute
 * on the same assessment the Health page shows, fires once when an issue opens
 * (or escalates warning → critical) and optionally once when it clears.
 *
 * Offline is NOT alerted here — Fabric's existing "agent offline" alert covers it
 * (and skips workstations). While a machine is offline or has no data its open
 * issues are left as they are, so a laptop closing its lid never reads as "recovered".
 */
@Injectable()
export class HealthAlertsService implements OnModuleInit {
  /** `${agentId}|${key}|${subject}` → severity already alerted. */
  private open = new Map<string, 'warning' | 'critical'>();
  private running = false;

  constructor(
    private readonly health: HealthService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly logging: LoggingService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const saved = await this.settings.get<Record<string, 'warning' | 'critical'>>(STATE_KEY);
      if (saved && typeof saved === 'object') this.open = new Map(Object.entries(saved));
    } catch {
      /* start empty */
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.evaluate();
    } catch (err) {
      void this.logging.error('health', `Health alert check failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.running = false;
    }
  }

  async evaluate(): Promise<void> {
    const machines = await this.health.assessments();
    const known = new Set(machines.map((m) => m.agentId));
    let changed = false;

    for (const m of machines) {
      const { status, issues } = m.assessment;
      // No fresh view of this machine: keep whatever is open as-is.
      if (status === 'offline' || status === 'unknown' || issues.some((i) => i.key === 'offline' || i.key === 'stale')) continue;

      const current = new Map<string, HealthIssue>();
      for (const i of issues) {
        if (!ALERT_FOR[i.key]) continue;
        current.set(`${m.agentId}|${i.key}|${i.subject ?? ''}`, i);
      }
      const label = `${m.name}${m.hostname && m.hostname !== m.name ? ` (${m.hostname})` : ''}`;

      for (const [k, i] of current) {
        const prev = this.open.get(k);
        if (prev === i.severity || (prev === 'critical' && i.severity === 'warning')) {
          if (prev !== i.severity) {
            this.open.set(k, i.severity); // de-escalated: remember, don't re-alert
            changed = true;
          }
          continue;
        }
        this.open.set(k, i.severity);
        changed = true;
        await this.notifications
          .dispatchAlert(ALERT_FOR[i.key]!, {
            title: `${i.severity === 'critical' ? 'Critical' : 'Warning'}: ${label} — ${i.message}`,
            body: `${label}: ${i.message}.`,
            dedupeKey: `health:${k}:${i.severity}`,
          })
          .catch(() => undefined);
      }

      for (const k of [...this.open.keys()]) {
        if (!k.startsWith(`${m.agentId}|`) || current.has(k)) continue;
        this.open.delete(k);
        changed = true;
        const [, key, subject] = k.split('|');
        const what = key === 'disk' || key === 'inodes' ? `${subject || 'Disk'} usage` : key === 'memory' ? 'Memory' : 'CPU';
        await this.notifications
          .dispatchAlert('health.recovered', {
            title: `Recovered: ${label} — ${what} back to normal`,
            body: `${label}: ${what} is back under its limit.`,
            dedupeKey: `health:${k}:recovered:${Date.now()}`,
          })
          .catch(() => undefined);
      }
    }

    // Machines that were removed: forget their state.
    for (const k of [...this.open.keys()]) {
      if (!known.has(k.split('|')[0])) {
        this.open.delete(k);
        changed = true;
      }
    }
    if (changed) await this.settings.set(STATE_KEY, Object.fromEntries(this.open)).catch(() => undefined);
  }
}
