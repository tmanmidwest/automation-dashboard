/**
 * Structured (dropdown-driven) backup schedule — no cron syntax in the UI.
 * The user picks a frequency, an optional day, and a time; these helpers decide
 * when it's due and render a human summary.
 */
export type BackupFrequency = 'off' | 'daily' | 'weekly' | 'monthly';

export interface BackupSchedule {
  frequency: BackupFrequency;
  /** 0=Sunday … 6=Saturday (used for weekly). */
  dayOfWeek: number;
  /** 1–28 (used for monthly). */
  dayOfMonth: number;
  hour: number;   // 0–23
  minute: number; // 0–59
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function intOr(v: unknown, fallback: number): number {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Read a schedule out of a connector instance's config. */
export function parseSchedule(config: Record<string, unknown>): BackupSchedule {
  const freq = String(config.backupFrequency ?? 'off') as BackupFrequency;
  return {
    frequency: ['off', 'daily', 'weekly', 'monthly'].includes(freq) ? freq : 'off',
    dayOfWeek: Math.min(6, Math.max(0, intOr(config.backupDayOfWeek, 0))),
    dayOfMonth: Math.min(28, Math.max(1, intOr(config.backupDayOfMonth, 1))),
    hour: Math.min(23, Math.max(0, intOr(config.backupHour, 4))),
    minute: Math.min(59, Math.max(0, intOr(config.backupMinute, 0))),
  };
}

/** True when `now` (server local time) matches the schedule to the minute. */
export function isDue(s: BackupSchedule, now: Date): boolean {
  if (s.frequency === 'off') return false;
  if (now.getHours() !== s.hour || now.getMinutes() !== s.minute) return false;
  if (s.frequency === 'daily') return true;
  if (s.frequency === 'weekly') return now.getDay() === s.dayOfWeek;
  if (s.frequency === 'monthly') return now.getDate() === s.dayOfMonth;
  return false;
}

/** e.g. "Weekly on Sunday at 04:00" — for the Test result and detail views. */
export function describeSchedule(s: BackupSchedule): string {
  if (s.frequency === 'off') return 'off (manual backups only)';
  const time = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
  if (s.frequency === 'daily') return `Daily at ${time} (server time)`;
  if (s.frequency === 'weekly') return `Weekly on ${DAY_NAMES[s.dayOfWeek]} at ${time} (server time)`;
  return `Monthly on day ${s.dayOfMonth} at ${time} (server time)`;
}
