import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import parser from 'cron-parser';
import { PrismaService } from '../../prisma/prisma.service';
import { LoggingService } from '../../logging/logging.service';
import { ConnectorInstanceService } from '../connector-instance.service';
import { BackupRunService } from './backup-run.service';

const BACKBLAZE_ID = 'backblaze';
const PUSH_OP = 'push-to-b2';
/** How far back a fired cron slot counts as "due" on a given minute tick. */
const DUE_WINDOW_MS = 70_000;

/**
 * Drives the Backblaze connectors' automatic NAS→B2 sync. Every minute it checks
 * each enabled Backblaze instance's `schedule` cron field; when a slot has just
 * fired it runs the push and records a durable BackupRun. Single-process, in-line
 * with the app — no external queue.
 */
@Injectable()
export class BackupSchedulerService {
  /** Instances with a sync currently in flight — prevents overlapping runs. */
  private readonly active = new Set<string>();
  /** Last cron slot (epoch ms) we fired per instance, to avoid double-firing within the window. */
  private readonly lastSlot = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: ConnectorInstanceService,
    private readonly runs: BackupRunService,
    private readonly logging: LoggingService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    const now = new Date();
    let due: { id: string; name: string; schedule: string }[];
    try {
      const rows = await this.prisma.connectorInstance.findMany({
        where: { connectorId: BACKBLAZE_ID, enabled: true },
      });
      due = rows
        .map((r) => ({ id: r.id, name: r.name, schedule: String((r.config as Record<string, unknown>)?.schedule ?? '').trim() }))
        .filter((r) => r.schedule);
    } catch (err) {
      void this.logging.error('connector:backblaze', `Scheduler could not load instances: ${err instanceof Error ? err.message : err}`);
      return;
    }

    for (const inst of due) {
      const slot = this.dueSlot(inst.schedule, now);
      if (slot == null) continue; // not due this minute (or invalid cron — logged in dueSlot)
      if (this.active.has(inst.id)) continue; // a previous run is still going
      if (this.lastSlot.get(inst.id) === slot) continue; // already handled this slot this process

      // Restart-safe: skip if a run for this slot was already recorded before a restart.
      if (await this.runs.hasRunSince(inst.id, new Date(slot))) {
        this.lastSlot.set(inst.id, slot);
        continue;
      }

      this.lastSlot.set(inst.id, slot);
      void this.runSync(inst.id, inst.name);
    }
  }

  /** The epoch ms of a cron slot that fired within the due window, or null. Invalid cron → warn + null. */
  private dueSlot(schedule: string, now: Date): number | null {
    try {
      const prev = parser.parseExpression(schedule, { currentDate: now }).prev().toDate();
      return now.getTime() - prev.getTime() <= DUE_WINDOW_MS ? prev.getTime() : null;
    } catch (err) {
      void this.logging.warn('connector:backblaze', `Ignoring invalid sync schedule "${schedule}": ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private async runSync(instanceId: string, name: string): Promise<void> {
    this.active.add(instanceId);
    const runId = await this.runs.begin(instanceId, 'schedule').catch(() => null);
    void this.logging.info('connector:backblaze', `[${name}] Scheduled sync started.`);
    try {
      const result = await this.instances.runOperationAwait(instanceId, PUSH_OP, { dryRun: false });
      if (runId) await this.runs.finish(runId, result.ok ? 'success' : 'error', result.message);
      void this.logging[result.ok ? 'info' : 'warn']('connector:backblaze', `[${name}] Scheduled sync ${result.ok ? 'ok' : 'failed'}: ${result.message}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Scheduled sync failed.';
      if (runId) await this.runs.finish(runId, 'error', message).catch(() => {});
      void this.logging.error('connector:backblaze', `[${name}] Scheduled sync errored: ${message}`);
    } finally {
      this.active.delete(instanceId);
    }
  }
}
