import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StackBackupService } from './stack-backup.service';
import { BackupTargetService } from './backup-target.service';
import { runResticLocal, ResticError } from './restic-cli';
import { describeSchedule, intervalMs } from '../common/backup-schedule';

/** How long after a schedule's own interval a missing backup becomes an alert. */
const STALE_FACTOR = 2.5;

/**
 * Runs stack backups on their schedule, applies retention, and notices when a
 * scheduled backup has quietly stopped happening.
 *
 * Three cadences, deliberately separated: a minute tick that fires due policies,
 * a nightly maintenance pass that prunes (expensive, and it takes a repository
 * lock), and an hourly staleness check. Single-process, in line with the rest of
 * the app. See docs/stack-backup.md.
 */
@Injectable()
export class StackBackupScheduler {
  /** Repositories with work in flight — restic locks anyway, but queueing avoids the churn. */
  private readonly busyTargets = new Set<string>();
  /** Minute slot already fired per policy, so one tick can't double-fire. */
  private readonly lastSlot = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly backups: StackBackupService,
    private readonly targets: BackupTargetService,
    private readonly notifications: NotificationsService,
    private readonly logging: LoggingService,
  ) {}

  // ── The minute tick ───────────────────────────────────────────────

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    const now = new Date();
    const slot = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

    let due: Awaited<ReturnType<StackBackupService['duePolicies']>>;
    try {
      due = await this.backups.duePolicies(now);
    } catch (err) {
      void this.logging.error('stack-backup', `Scheduler could not load policies: ${msg(err)}`);
      return;
    }

    for (const policy of due) {
      if (this.lastSlot.get(policy.id) === slot) continue;
      this.lastSlot.set(policy.id, slot);

      // Restart-safe: a redeploy mid-minute must not re-run a backup that already
      // started, so check the durable record rather than trusting process memory.
      const minuteStart = new Date(now);
      minuteStart.setSeconds(0, 0);
      const already = await this.prisma.stackBackupRun.count({
        where: { policyId: policy.id, startedAt: { gte: minuteStart } },
      }).catch(() => 0);
      if (already) continue;

      // Serialize per repository: concurrent backups to one restic repo spend their
      // time fighting over the lock instead of moving data.
      if (this.busyTargets.has(policy.targetId)) {
        void this.logging.info(
          'stack-backup',
          `[${policy.stackName}] Scheduled backup deferred — another backup is using that repository.`,
        );
        continue;
      }

      void this.runOne(policy.id, policy.targetId, policy.stackName, describeSchedule(this.backups.scheduleOf(policy)));
    }
  }

  private async runOne(policyId: string, targetId: string, stackName: string, when: string): Promise<void> {
    this.busyTargets.add(targetId);
    try {
      void this.logging.info('stack-backup', `[${stackName}] Scheduled backup started (${when}).`);
      const run = await this.backups.startBackup(policyId, undefined, 'schedule');
      // startBackup returns as soon as the row exists; wait for it so the repository
      // stays reserved for the duration of the actual work.
      await this.awaitRun(run.id);
    } catch (err) {
      void this.logging.error('stack-backup', `[${stackName}] Scheduled backup could not start: ${msg(err)}`);
    } finally {
      this.busyTargets.delete(targetId);
    }
  }

  /** Poll a run to completion. Cheap (one indexed row) and bounded by the run itself. */
  private async awaitRun(runId: string): Promise<void> {
    const deadline = Date.now() + 8 * 60 * 60 * 1000;
    for (;;) {
      await sleep(5000);
      const row = await this.prisma.stackBackupRun.findUnique({
        where: { id: runId },
        select: { status: true },
      }).catch(() => null);
      if (!row || row.status !== 'running') return;
      if (Date.now() > deadline) return;
    }
  }

  // ── Nightly retention ─────────────────────────────────────────────

  /**
   * Apply each policy's retention, then reclaim space once per repository.
   *
   * `forget` is metadata-only and runs per policy so each stack keeps its own N
   * snapshots rather than N shared across every stack; `prune` is the expensive,
   * lock-taking part and runs once at the end. Both use the FULL credential —
   * Docker hosts only ever get the append-only one, so a compromised host can add
   * snapshots but never delete history.
   */
  @Cron('0 30 2 * * *')
  async maintenance(): Promise<void> {
    const targets = await this.prisma.stackBackupTarget.findMany().catch(() => []);
    for (const target of targets) {
      const keep = retentionFlags(target);
      if (!keep.length) continue; // no retention configured — never delete anything
      if (this.busyTargets.has(target.id)) {
        void this.logging.info('stack-backup', `Retention for "${target.name}" skipped — a backup is using the repository.`);
        continue;
      }

      this.busyTargets.add(target.id);
      try {
        const auth = await this.targets.authFor(target.id);
        const policies = await this.prisma.stackBackupPolicy.findMany({ where: { targetId: target.id } });
        let forgotten = 0;
        for (const policy of policies) {
          try {
            // --group-by host,paths (restic's default) puts a single policy's
            // snapshots in one group. Grouping by tags would NOT work: every
            // snapshot carries a unique run:<id> tag, so each would be its own
            // group and nothing would ever be forgotten.
            const out = await runResticLocal(
              auth,
              ['forget', '--tag', `policy:${policy.id}`, '--group-by', 'host,paths', ...keep],
              30 * 60_000,
            );
            forgotten += (out.match(/^remove \d+ snapshots/gim) ?? []).length;
          } catch (err) {
            void this.logging.warn('stack-backup', `Retention failed for "${policy.stackName}": ${msg(err)}`);
          }
        }

        await runResticLocal(auth, ['prune'], 4 * 60 * 60 * 1000);
        void this.logging.info(
          'stack-backup',
          `Retention applied to "${target.name}" across ${policies.length} stack(s)${forgotten ? `; ${forgotten} forget pass(es) removed snapshots` : ''}, then pruned.`,
        );
      } catch (err) {
        const message = msg(err);
        void this.logging.error('stack-backup', `Retention/prune failed for "${target.name}": ${message}`);
        await this.notifications.dispatchAlert('retention.failure', {
          title: `Backup retention failed: ${target.name}`,
          body: err instanceof ResticError && err.code === 'locked'
            ? `${message} A previous run may have left a stale lock — run "restic unlock" against this repository.`
            : message,
          dedupeKey: `stack-backup:retention:${target.id}`,
        }).catch(() => { /* never let alerting break maintenance */ });
      } finally {
        this.busyTargets.delete(target.id);
      }
    }
  }

  // ── Staleness ─────────────────────────────────────────────────────

  /**
   * A backup that silently stopped running is worse than one that fails loudly —
   * nothing alerts, and the gap is only discovered when it is needed. The
   * threshold comes from the schedule itself, so a daily backup is chased after
   * two and a half days while a monthly one is not.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async staleness(): Promise<void> {
    const policies = await this.prisma.stackBackupPolicy
      .findMany({ where: { enabled: true, frequency: { not: 'off' } } })
      .catch(() => []);

    for (const policy of policies) {
      const window = intervalMs(this.backups.scheduleOf(policy)) * STALE_FACTOR;
      if (!window) continue;

      const lastGood = await this.prisma.stackBackupRun.findFirst({
        where: { policyId: policy.id, status: 'success' },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      }).catch(() => null);

      const since = lastGood ? Date.now() - lastGood.startedAt.getTime() : Date.now() - policy.createdAt.getTime();
      if (since < window) continue;

      const days = Math.floor(since / 86_400_000);
      await this.notifications.dispatchAlert('backup.stale', {
        title: `No recent backup: ${policy.stackName}`,
        body: lastGood
          ? `The last successful backup of "${policy.stackName}" was ${days} day(s) ago, but it is scheduled ${describeSchedule(this.backups.scheduleOf(policy)).toLowerCase()}.`
          : `"${policy.stackName}" is scheduled ${describeSchedule(this.backups.scheduleOf(policy)).toLowerCase()} but has never completed a successful backup.`,
        // One alert per policy per day, not one per hourly sweep.
        dedupeKey: `stack-backup:stale:${policy.id}:${new Date().toISOString().slice(0, 10)}`,
        connectorId: policy.connectorInstanceId,
      }).catch(() => { /* never let alerting break the sweep */ });
    }
  }
}

/** Translate a target's keep-* columns into restic forget flags. Empty = no retention. */
function retentionFlags(t: {
  keepLast: number | null; keepDaily: number | null; keepWeekly: number | null;
  keepMonthly: number | null; keepWithinDays: number | null;
}): string[] {
  const flags: string[] = [];
  if (t.keepLast) flags.push('--keep-last', String(t.keepLast));
  if (t.keepDaily) flags.push('--keep-daily', String(t.keepDaily));
  if (t.keepWeekly) flags.push('--keep-weekly', String(t.keepWeekly));
  if (t.keepMonthly) flags.push('--keep-monthly', String(t.keepMonthly));
  if (t.keepWithinDays) flags.push('--keep-within', `${t.keepWithinDays}d`);
  return flags;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
