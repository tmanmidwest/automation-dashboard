import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { LoggingService } from '../../logging/logging.service';
import { ConnectorInstanceService } from '../connector-instance.service';
import { BackupRunService } from './backup-run.service';
import { parseSchedule, isDue, describeSchedule } from './schedule-util';

const BACKBLAZE_ID = 'backblaze';
const BACKUP_OP = 'backup-now';

/**
 * Runs each Backblaze connector's automatic backup on its structured schedule
 * (frequency + day + time picked in the UI — no cron). Checks every minute;
 * when an instance is due it runs the backup (which also applies retention).
 * Single-process, in-line with the app.
 */
@Injectable()
export class BackupSchedulerService {
  /** Instances with a backup currently in flight — prevents overlapping runs. */
  private readonly active = new Set<string>();
  /** Last minute-slot we fired per instance, to avoid double-firing within the minute. */
  private readonly lastSlot = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: ConnectorInstanceService,
    private readonly runs: BackupRunService,
    private readonly logging: LoggingService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    const now = new Date();
    const slot = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

    let rows: { id: string; name: string; config: unknown }[];
    try {
      rows = await this.prisma.connectorInstance.findMany({ where: { connectorId: BACKBLAZE_ID, enabled: true } });
    } catch (err) {
      void this.logging.error('connector:backblaze', `Scheduler could not load instances: ${err instanceof Error ? err.message : err}`);
      return;
    }

    for (const inst of rows) {
      const schedule = parseSchedule((inst.config ?? {}) as Record<string, unknown>);
      if (!isDue(schedule, now)) continue;
      if (this.active.has(inst.id)) continue;
      if (this.lastSlot.get(inst.id) === slot) continue;

      // Restart-safe: skip if a run for this instance already started this minute.
      const minuteStart = new Date(now); minuteStart.setSeconds(0, 0);
      if (await this.runs.hasRunSince(inst.id, minuteStart)) {
        this.lastSlot.set(inst.id, slot);
        continue;
      }

      this.lastSlot.set(inst.id, slot);
      void this.runBackup(inst.id, inst.name, describeSchedule(schedule));
    }
  }

  private async runBackup(instanceId: string, name: string, scheduleDesc: string): Promise<void> {
    this.active.add(instanceId);
    void this.logging.info('connector:backblaze', `[${name}] Scheduled backup started (${scheduleDesc}).`);
    try {
      const result = await this.instances.runOperationAwait(instanceId, BACKUP_OP, { trigger: 'schedule' });
      void this.logging[result.ok ? 'info' : 'warn']('connector:backblaze', `[${name}] Scheduled backup ${result.ok ? 'ok' : 'failed'}: ${result.message}`);
    } catch (err) {
      void this.logging.error('connector:backblaze', `[${name}] Scheduled backup errored: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.active.delete(instanceId);
    }
  }
}
