import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { StackBackupTarget, VerifySchedule, VerifyScheduleStatus } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { LoggingService } from '../logging/logging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BackupTargetService, integrityDueAt } from './backup-target.service';
import { StackBackupService } from './stack-backup.service';
import { StackRestoreService } from './stack-restore.service';
import { StackBackupScheduler } from './stack-backup-scheduler.service';
import { runResticLocalTolerant } from './restic-cli';
import { describeSchedule, isDue, nextRunAt, type BackupSchedule } from '../common/backup-schedule';

const SCHEDULE_KEY = 'stackBackup.verifySchedule';
const LAST_KEY = 'stackBackup.verifyLast';

export const DEFAULT_VERIFY_SCHEDULE: VerifySchedule = {
  enabled: false,
  frequency: 'weekly',
  dayOfWeek: 0,
  hour: 4,
  minute: 30,
  scratchInstanceId: null,
  stacksPerRun: 2,
};

/** A verify can take a while to pull images and settle; past this it is reported as stuck. */
const VERIFY_WAIT_MS = 45 * 60_000;
/** restic check reading a slice of a big B2 repository is slow — bound it, generously. */
const CHECK_TIMEOUT_MS = 6 * 60 * 60_000;

/**
 * The two "is the backup actually any good?" jobs (docs/stack-backup.md,
 * "Scheduled test restores" and "Repository integrity checks"):
 *
 * - **Test restores** rotate through every stack: each run picks the stacks whose
 *   last test is oldest, brings each one up in a throwaway sandbox (the existing
 *   verify-restore), and records pass/fail on the stack. A failure alerts.
 * - **Integrity checks** run `restic check --read-data-subset=N%` per repository
 *   on its own weekly/monthly cadence — the only thing that notices bit rot or a
 *   pack the provider lost, as opposed to a snapshot that was never written.
 */
@Injectable()
export class StackBackupAssuranceService {
  private verifyRunning = false;
  private readonly verifyingPolicies = new Set<string>();
  private readonly checking = new Set<string>();
  private lastSlot = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly targets: BackupTargetService,
    private readonly backups: StackBackupService,
    private readonly restores: StackRestoreService,
    private readonly scheduler: StackBackupScheduler,
    private readonly notifications: NotificationsService,
    private readonly logging: LoggingService,
  ) {}

  // ── Scheduled test restores ──────────────────────────────────────

  async verifySchedule(): Promise<VerifyScheduleStatus> {
    const s = await this.loadSchedule();
    const last = await this.settings.get<{ at?: string; message?: string }>(LAST_KEY);
    const scratch = s.scratchInstanceId
      ? await this.prisma.connectorInstance.findUnique({ where: { id: s.scratchInstanceId }, select: { name: true } })
      : null;
    return {
      ...s,
      scratchHostName: scratch?.name ?? null,
      nextRunAt: s.enabled ? nextRunAt(asSchedule(s))?.toISOString() ?? null : null,
      running: this.verifyRunning,
      lastRunAt: last?.at ?? null,
      lastRunMessage: last?.message ?? null,
    };
  }

  async saveVerifySchedule(input: Partial<VerifySchedule>): Promise<VerifyScheduleStatus> {
    const cur = await this.loadSchedule();
    const next: VerifySchedule = {
      enabled: input.enabled ?? cur.enabled,
      frequency: input.frequency === 'daily' ? 'daily' : input.frequency === 'weekly' ? 'weekly' : cur.frequency,
      dayOfWeek: clampInt(input.dayOfWeek ?? cur.dayOfWeek, 0, 6),
      hour: clampInt(input.hour ?? cur.hour, 0, 23),
      minute: clampInt(input.minute ?? cur.minute, 0, 59),
      scratchInstanceId: input.scratchInstanceId === undefined ? cur.scratchInstanceId : input.scratchInstanceId || null,
      stacksPerRun: clampInt(input.stacksPerRun ?? cur.stacksPerRun, 1, 10),
    };
    if (next.scratchInstanceId) {
      const host = await this.prisma.connectorInstance.findUnique({ where: { id: next.scratchInstanceId } });
      if (!host || host.connectorId !== 'docker') throw new BadRequestException('Pick a Docker host for test restores.');
    }
    await this.settings.set(SCHEDULE_KEY, next);
    return this.verifySchedule();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async verifyTick(): Promise<void> {
    const now = new Date();
    const slot = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (slot === this.lastSlot) return;
    const s = await this.loadSchedule().catch(() => null);
    if (!s?.enabled || !isDue(asSchedule(s), now)) return;
    this.lastSlot = slot;
    // Restart-safe: a redeploy inside the minute must not start a second rotation.
    const last = await this.settings.get<{ at?: string }>(LAST_KEY).catch(() => undefined);
    if (last?.at && now.getTime() - new Date(last.at).getTime() < 5 * 60_000) return;
    void this.runRotation('schedule');
  }

  /** Start a rotation now (the "Run now" button). */
  startRotation(): { started: boolean } {
    if (this.verifyRunning) throw new BadRequestException('Test restores are already running.');
    void this.runRotation('manual');
    return { started: true };
  }

  /** Test one stack now, outside the rotation. */
  async startPolicyVerify(policyId: string): Promise<{ started: boolean }> {
    const policy = await this.prisma.stackBackupPolicy.findUnique({ where: { id: policyId } });
    if (!policy) throw new NotFoundException('Backup policy not found.');
    if (this.verifyingPolicies.has(policyId)) throw new BadRequestException('A test restore of that stack is already running.');
    const s = await this.loadSchedule();
    void this.verifyPolicy(policy, s.scratchInstanceId);
    return { started: true };
  }

  private async runRotation(trigger: 'schedule' | 'manual'): Promise<void> {
    if (this.verifyRunning) return;
    this.verifyRunning = true;
    const at = new Date().toISOString();
    await this.settings.set(LAST_KEY, { at, message: 'Running…' }).catch(() => undefined);
    try {
      const s = await this.loadSchedule();
      // Oldest-tested first, so every stack comes round in turn and a newly added
      // one (never tested) goes to the front of the line.
      const due = await this.prisma.stackBackupPolicy.findMany({
        where: { enabled: true, lastStatus: 'success' },
        orderBy: [{ verifiedAt: { sort: 'asc', nulls: 'first' } }, { stackName: 'asc' }],
        take: s.stacksPerRun,
      });
      if (!due.length) {
        await this.settings.set(LAST_KEY, { at, message: 'Nothing to test — no stack has a successful backup yet.' });
        return;
      }
      void this.logging.info(
        'stack-backup',
        `${trigger === 'schedule' ? 'Scheduled' : 'Manual'} test restores: ${due.map((p) => p.stackName).join(', ')}.`,
      );
      const results: string[] = [];
      for (const policy of due) {
        const r = await this.verifyPolicy(policy, s.scratchInstanceId);
        results.push(`${policy.stackName}: ${r}`);
      }
      await this.settings.set(LAST_KEY, { at, message: results.join(' · ') });
    } catch (err) {
      await this.settings.set(LAST_KEY, { at, message: `Failed: ${msg(err)}` }).catch(() => undefined);
    } finally {
      this.verifyRunning = false;
    }
  }

  /**
   * Bring one stack's latest successful snapshot up in a sandbox and record the
   * outcome on the stack. Returns a one-word result for the rotation summary.
   */
  private async verifyPolicy(
    policy: { id: string; stackName: string; connectorInstanceId: string; setId: string | null },
    scratchInstanceId: string | null,
  ): Promise<'passed' | 'failed' | 'skipped'> {
    if (this.verifyingPolicies.has(policy.id)) return 'skipped';
    this.verifyingPolicies.add(policy.id);
    const record = async (status: 'success' | 'error' | 'skipped', message: string, runId?: string | null) => {
      await this.prisma.stackBackupPolicy.update({
        where: { id: policy.id },
        data: { verifyStatus: status, verifyMessage: message, verifiedAt: new Date(), verifyRunId: runId ?? null },
      }).catch(() => undefined);
    };

    try {
      const last = await this.prisma.stackBackupRun.findFirst({
        where: { policyId: policy.id, status: 'success', snapshotId: { not: null } },
        orderBy: { startedAt: 'desc' },
      });
      if (!last?.snapshotId) {
        await record('skipped', 'No successful backup to test yet.');
        return 'skipped';
      }

      const destInstanceId = scratchInstanceId ?? policy.connectorInstanceId;
      const dest = await this.prisma.connectorInstance.findUnique({ where: { id: destInstanceId } });
      if (!dest || !dest.enabled) {
        await this.fail(policy, `The test-restore host ${dest ? `"${dest.name}" is disabled` : 'no longer exists'}.`, null, record);
        return 'failed';
      }

      let runId: string;
      try {
        const run = await this.restores.startVerify({
          targetId: last.targetId,
          snapshotId: last.snapshotId,
          destInstanceId,
          passphrase: await this.backups.storedSeal(policy),
        });
        runId = run.id;
      } catch (err) {
        const m = msg(err);
        // A data-only snapshot (no compose file) has nothing to bring up — that is
        // a property of the stack, not a failed backup.
        if (/no compose file/i.test(m)) {
          await record('skipped', 'Data-only backup (no compose file) — there is nothing to bring up.');
          return 'skipped';
        }
        if (/sealed/i.test(m)) {
          await record('skipped', 'Secrets are sealed and no passphrase is stored, so a test restore cannot rebuild the .env unattended. Store the sealing passphrase on the stack or its set.');
          return 'skipped';
        }
        await this.fail(policy, `Could not start the test restore: ${m}`, null, record);
        return 'failed';
      }

      const done = await this.awaitRestore(runId, VERIFY_WAIT_MS);
      if (done?.status === 'success') {
        await record('success', done.message ?? 'Restored and came up healthy.', runId);
        return 'passed';
      }
      await this.fail(policy, done?.message ?? 'The test restore did not finish in time.', runId, record);
      return 'failed';
    } catch (err) {
      await this.fail(policy, msg(err), null, record);
      return 'failed';
    } finally {
      this.verifyingPolicies.delete(policy.id);
    }
  }

  private async fail(
    policy: { id: string; stackName: string; connectorInstanceId: string },
    message: string,
    runId: string | null,
    record: (status: 'error', message: string, runId?: string | null) => Promise<void>,
  ): Promise<void> {
    await record('error', message, runId);
    void this.logging.warn('stack-backup', `[${policy.stackName}] Test restore failed: ${message}`);
    await this.notifications.dispatchAlert('backup.verify_failed', {
      title: `Test restore failed: ${policy.stackName}`,
      body: `The latest backup of "${policy.stackName}" was restored into a throwaway copy and did not come up healthy: ${message}`,
      dedupeKey: `stack-backup:verify:${policy.id}:${new Date().toISOString().slice(0, 10)}`,
      connectorId: policy.connectorInstanceId,
    }).catch(() => undefined);
  }

  private async awaitRestore(runId: string, maxMs: number) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const row = await this.prisma.stackRestoreRun.findUnique({ where: { id: runId } }).catch(() => null);
      if (row && row.status !== 'running') return row;
      await sleep(5000);
    }
    return null;
  }

  private async loadSchedule(): Promise<VerifySchedule> {
    const v = await this.settings.get<Partial<VerifySchedule>>(SCHEDULE_KEY);
    return { ...DEFAULT_VERIFY_SCHEDULE, ...(v && typeof v === 'object' ? v : {}) };
  }

  // ── Repository integrity checks ──────────────────────────────────

  /** Nightly: run the checks that have come due. One repository at a time. */
  @Cron('0 0 4 * * *')
  async integritySweep(): Promise<void> {
    const rows = await this.prisma.stackBackupTarget.findMany().catch(() => []);
    const now = new Date();
    for (const t of rows) {
      const due = integrityDueAt(t);
      if (!due || due > now) continue;
      await this.runIntegrity(t.id, 'schedule');
    }
  }

  /** The "Check now" button. Returns at once; the target row shows progress. */
  async startIntegrity(targetId: string): Promise<StackBackupTarget> {
    const t = await this.prisma.stackBackupTarget.findUnique({ where: { id: targetId } });
    if (!t) throw new NotFoundException('Backup target not found.');
    if (this.checking.has(targetId)) throw new BadRequestException('A check of that repository is already running.');
    await this.prisma.stackBackupTarget.update({
      where: { id: targetId },
      data: { integrityStatus: 'running', integrityMessage: 'Waiting for the repository…' },
    });
    void this.runIntegrity(targetId, 'manual');
    return this.targets.get(targetId);
  }

  private async runIntegrity(targetId: string, trigger: 'schedule' | 'manual'): Promise<void> {
    if (this.checking.has(targetId)) return;
    this.checking.add(targetId);
    const before = await this.prisma.stackBackupTarget.findUnique({ where: { id: targetId } }).catch(() => null);
    if (!before) { this.checking.delete(targetId); return; }
    try {
      const pct = Math.min(100, Math.max(1, before.integrityReadPercent || 5));
      let status = 'error' as 'ok' | 'error';
      let message = '';
      const ran = await this.scheduler.exclusive(targetId, async () => {
        await this.prisma.stackBackupTarget.update({
          where: { id: targetId },
          data: { integrityStatus: 'running', integrityMessage: `Reading back ${pct}% of the stored data…` },
        });
        const started = Date.now();
        try {
          const auth = await this.targets.authFor(targetId);
          const r = await runResticLocalTolerant(auth, ['check', `--read-data-subset=${pct}%`], CHECK_TIMEOUT_MS);
          const mins = Math.round((Date.now() - started) / 60_000);
          const took = mins < 1 ? 'under a minute' : `${mins} min`;
          if (r.code === 0) {
            status = 'ok';
            message = `No errors found. ${pct}% of the stored data was read back and verified (${took}).`;
          } else {
            message = `restic check found problems (exit ${r.code}): ${tail(r.stderr || r.stdout)}`;
          }
        } catch (err) {
          message = `The check could not run: ${msg(err)}`;
        }
      });

      if (!ran) {
        // A backup or prune holds the repository. Leave the due date alone so the
        // next nightly sweep (or another click) tries again.
        await this.prisma.stackBackupTarget.update({
          where: { id: targetId },
          data: {
            integrityStatus: before.integrityStatus === 'running' ? 'never' : before.integrityStatus,
            integrityMessage: 'Skipped — a backup was using the repository. It will be retried.',
          },
        }).catch(() => undefined);
        return;
      }

      await this.prisma.stackBackupTarget.update({
        where: { id: targetId },
        data: { integrityStatus: status, integrityMessage: message, integrityCheckedAt: new Date() },
      }).catch(() => undefined);

      if (status === 'ok') {
        void this.logging.info('stack-backup', `Integrity check of "${before.name}" passed (${trigger}).`);
      } else {
        void this.logging.error('stack-backup', `Integrity check of "${before.name}" failed: ${message}`);
        await this.notifications.dispatchAlert('backup.integrity', {
          title: `Backup repository check failed: ${before.name}`,
          body: `${message} Run "restic check" against ${before.repository} to see the details; ` +
            'if packs are damaged, "restic repair" and a fresh backup of each stack are the usual way back.',
          dedupeKey: `stack-backup:integrity:${targetId}:${new Date().toISOString().slice(0, 10)}`,
        }).catch(() => undefined);
      }
    } finally {
      this.checking.delete(targetId);
    }
  }
}

function asSchedule(s: VerifySchedule): BackupSchedule {
  return { frequency: s.frequency, dayOfWeek: s.dayOfWeek, dayOfMonth: 1, hour: s.hour, minute: s.minute };
}

export function describeVerifySchedule(s: VerifySchedule): string {
  return s.enabled ? describeSchedule(asSchedule(s)) : 'off';
}

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

function tail(text: string, max = 600): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
