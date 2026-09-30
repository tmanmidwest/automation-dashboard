/**
 * The Backblaze connector's schedule, read out of its connector config. The
 * semantics (when is it due, how do we say it) are shared with stack backup
 * policies — see common/backup-schedule.ts — so the two never drift apart.
 */
import type { BackupSchedule } from '../../common/backup-schedule';

export type { BackupSchedule, BackupFrequency } from '../../common/backup-schedule';
export { isDue, describeSchedule } from '../../common/backup-schedule';

function intOr(v: unknown, fallback: number): number {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Read a schedule out of a connector instance's config. */
export function parseSchedule(config: Record<string, unknown>): BackupSchedule {
  const freq = String(config.backupFrequency ?? 'off');
  return {
    frequency: (['off', 'daily', 'weekly', 'monthly'].includes(freq) ? freq : 'off') as BackupSchedule['frequency'],
    dayOfWeek: Math.min(6, Math.max(0, intOr(config.backupDayOfWeek, 0))),
    dayOfMonth: Math.min(28, Math.max(1, intOr(config.backupDayOfMonth, 1))),
    hour: Math.min(23, Math.max(0, intOr(config.backupHour, 4))),
    minute: Math.min(59, Math.max(0, intOr(config.backupMinute, 0))),
  };
}
