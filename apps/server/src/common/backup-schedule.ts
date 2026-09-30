/**
 * Structured backup schedules — dropdowns, never cron. The operator picks a
 * frequency, an optional day, and a time; these helpers decide when that is due,
 * when it next fires, and how to say it in a sentence.
 *
 * Shared by the Backblaze connector's own schedule and by stack backup policies,
 * so "weekly on Sunday at 04:00" means the same thing in both places. All times
 * are the server's local time (set TZ on the container).
 */

export type BackupFrequency = 'off' | 'daily' | 'weekly' | 'monthly';

export interface BackupSchedule {
  frequency: BackupFrequency;
  /** 0=Sunday … 6=Saturday (weekly). */
  dayOfWeek: number;
  /** 1–28 (monthly) — capped at 28 so every month has the day. */
  dayOfMonth: number;
  hour: number;
  minute: number;
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** True when `now` matches the schedule to the minute. */
export function isDue(s: BackupSchedule, now: Date): boolean {
  if (s.frequency === 'off') return false;
  if (now.getHours() !== s.hour || now.getMinutes() !== s.minute) return false;
  if (s.frequency === 'daily') return true;
  if (s.frequency === 'weekly') return now.getDay() === s.dayOfWeek;
  if (s.frequency === 'monthly') return now.getDate() === s.dayOfMonth;
  return false;
}

/** e.g. "Weekly on Sunday at 04:00" — for detail views and run logs. */
export function describeSchedule(s: BackupSchedule): string {
  if (s.frequency === 'off') return 'off (manual backups only)';
  const time = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
  if (s.frequency === 'daily') return `Daily at ${time} (server time)`;
  if (s.frequency === 'weekly') return `Weekly on ${DAY_NAMES[s.dayOfWeek]} at ${time} (server time)`;
  return `Monthly on day ${s.dayOfMonth} at ${time} (server time)`;
}

/** The next time this schedule fires after `from`, or null when it is off. */
export function nextRunAt(s: BackupSchedule, from: Date = new Date()): Date | null {
  if (s.frequency === 'off') return null;
  const at = (d: Date) => {
    const x = new Date(d);
    x.setHours(s.hour, s.minute, 0, 0);
    return x;
  };

  if (s.frequency === 'daily') {
    const today = at(from);
    return today > from ? today : at(new Date(from.getTime() + 86_400_000));
  }

  if (s.frequency === 'weekly') {
    for (let i = 0; i < 8; i += 1) {
      const d = at(new Date(from.getTime() + i * 86_400_000));
      if (d.getDay() === s.dayOfWeek && d > from) return d;
    }
    return null;
  }

  // Monthly: this month's day if it is still ahead, otherwise next month's.
  const thisMonth = at(new Date(from.getFullYear(), from.getMonth(), s.dayOfMonth));
  if (thisMonth > from) return thisMonth;
  return at(new Date(from.getFullYear(), from.getMonth() + 1, s.dayOfMonth));
}

/**
 * How long a schedule leaves between runs, in ms. Used to judge staleness — a
 * daily backup that has not succeeded in three days is a problem, whereas a
 * monthly one is not.
 */
export function intervalMs(s: BackupSchedule): number {
  if (s.frequency === 'daily') return 86_400_000;
  if (s.frequency === 'weekly') return 7 * 86_400_000;
  if (s.frequency === 'monthly') return 31 * 86_400_000;
  return 0;
}
