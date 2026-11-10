import { BadRequestException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type {
  HostRestoreInput,
  HostRestoreItem,
  HostRestoreJob,
  HostRestorePlan,
  HostRestorePlanInput,
  HostRestoreStackPlan,
} from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { StackBackupService } from './stack-backup.service';
import { StackRestoreService } from './stack-restore.service';

/** One stack restore can pull images and copy gigabytes — bound the wait, generously. */
const STACK_WAIT_MS = 4 * 60 * 60_000;

/**
 * Restore every backed-up stack from one Docker host onto another (or onto the
 * same host after a rebuild) — the "the Pi's SD card died" case. See
 * docs/stack-backup.md, "Restoring a whole host".
 *
 * A planning pass runs the ordinary per-stack restore plan for each stack's
 * latest good snapshot against the destination, so every check a single restore
 * makes (conflicts, existing data, ports, CPU/image support, sealed secrets) is
 * shown for the whole host up front. Executing then runs the ordinary guarded
 * restore for each chosen stack, one at a time, carrying on past a failure so one
 * bad stack does not strand the rest.
 */
@Injectable()
export class StackHostRestoreService implements OnModuleInit {
  private readonly running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly backups: StackBackupService,
    private readonly restores: StackRestoreService,
    private readonly logging: LoggingService,
  ) {}

  /** A job that was running when the server stopped will never finish — say so. */
  async onModuleInit(): Promise<void> {
    await this.prisma.stackHostRestore.updateMany({
      where: { status: 'running' },
      data: { status: 'error', message: 'Interrupted — Cerebro restarted while this was running.', finishedAt: new Date() },
    }).catch(() => undefined);
  }

  async plan(input: HostRestorePlanInput): Promise<HostRestorePlan> {
    const [source, dest] = await Promise.all([this.host(input.sourceInstanceId), this.host(input.destInstanceId)]);
    const policies = await this.prisma.stackBackupPolicy.findMany({
      where: { connectorInstanceId: source.id },
      include: { target: { select: { name: true } } },
      orderBy: { stackName: 'asc' },
    });
    if (!policies.length) throw new BadRequestException(`No stack backups are set up for ${source.name}.`);

    let sourcePlatform: string | null = null;
    let destPlatform: string | null = null;

    // Plans read the manifest out of the repository — a few at a time keeps a
    // host with twenty stacks quick without hammering the repository.
    const stacks = await mapLimit(policies, 3, async (p): Promise<HostRestoreStackPlan> => {
      const base: HostRestoreStackPlan = {
        policyId: p.id,
        stackName: p.stackName,
        targetId: p.targetId,
        targetName: p.target.name,
        snapshotId: null,
        snapshotShortId: null,
        snapshotTime: null,
        status: 'no-snapshot',
        hasCompose: false,
        volumes: 0,
        binds: 0,
        missingPassphrase: false,
        conflicts: [],
        warnings: [],
        overwrites: [],
        imageProblems: [],
      };
      const last = await this.prisma.stackBackupRun.findFirst({
        where: { policyId: p.id, status: 'success', snapshotId: { not: null } },
        orderBy: { startedAt: 'desc' },
      });
      if (!last?.snapshotId) return base;

      try {
        const plan = await this.restores.plan({
          targetId: last.targetId,
          snapshotId: last.snapshotId,
          destInstanceId: dest.id,
        });
        sourcePlatform ??= plan.sourcePlatform ?? null;
        destPlatform ??= plan.destPlatform ?? null;
        const missingPassphrase = plan.needsPassphrase && plan.hasEnv && !(await this.backups.storedSeal(p));
        const imageProblems = plan.images
          .filter((i) => i.status === 'unsupported' || i.status === 'local')
          .map((i) => `${i.ref}: ${i.note ?? i.status}`);
        const conflicts = blocking(plan.conflicts);
        // The CPU difference is said once for the whole host, and binds are restored
        // by default here, so the single-stack "opt-in" note does not apply.
        const warnings = plan.warnings.filter((w) => !/^Different CPU:|^Bind paths restore over/.test(w));
        if (missingPassphrase) {
          conflicts.push('Secrets are sealed and no passphrase is stored — restore this stack on its own from the snapshot list.');
        }
        return {
          ...base,
          snapshotId: plan.snapshot.id,
          snapshotShortId: plan.snapshot.shortId,
          snapshotTime: plan.snapshot.time,
          hasCompose: plan.hasCompose,
          volumes: plan.volumes.length,
          binds: plan.binds.length,
          missingPassphrase,
          conflicts,
          warnings,
          overwrites: [
            ...plan.volumes.filter((v) => v.exists).map((v) => `volume ${v.dest}`),
            ...plan.binds.filter((b) => b.exists).map((b) => b.dest),
          ],
          imageProblems,
          status: conflicts.length ? 'blocked' : imageProblems.length || warnings.length ? 'warning' : 'ready',
        };
      } catch (err) {
        return { ...base, status: 'blocked', conflicts: [`Could not plan: ${msg(err)}`] };
      }
    });

    return {
      sourceInstanceId: source.id,
      sourceHostName: source.name,
      destInstanceId: dest.id,
      destHostName: dest.name,
      sourcePlatform,
      destPlatform,
      // Restorable first, then the ones that need attention; alphabetical within.
      stacks: [...stacks].sort((a, b) => RANK[a.status] - RANK[b.status] || a.stackName.localeCompare(b.stackName)),
    };
  }

  async start(input: HostRestoreInput): Promise<HostRestoreJob> {
    if (!input.stacks?.length) throw new BadRequestException('Choose at least one stack to restore.');
    const plan = await this.plan(input);
    const byPolicy = new Map(plan.stacks.map((s) => [s.policyId, s]));

    const items: HostRestoreItem[] = [];
    for (const want of input.stacks) {
      const s = byPolicy.get(want.policyId);
      if (!s) throw new BadRequestException('One of the chosen stacks is not backed up from that host.');
      if (s.status === 'blocked' || s.status === 'no-snapshot' || !s.snapshotId) {
        throw new BadRequestException(`"${s.stackName}" cannot be restored as part of this run: ${s.conflicts[0] ?? 'no snapshot'}`);
      }
      if (want.snapshotId !== s.snapshotId) {
        throw new BadRequestException(`A newer backup of "${s.stackName}" arrived since the plan was made — review the plan again.`);
      }
      items.push({ policyId: s.policyId, stackName: s.stackName, snapshotId: s.snapshotId, status: 'pending' });
    }

    // Overwriting data on the destination needs the host's name typed once for the
    // whole run (each stack restore still takes its own safety copy first).
    const overwrites = input.stacks.some((w) => (byPolicy.get(w.policyId)?.overwrites.length ?? 0) > 0);
    if (overwrites && (input.confirmHost ?? '').trim() !== plan.destHostName) {
      throw new BadRequestException(
        `Some of these stacks overwrite existing data on ${plan.destHostName}. Type "${plan.destHostName}" to confirm.`,
      );
    }
    if (this.running.has(plan.destInstanceId)) {
      throw new BadRequestException(`A whole-host restore onto ${plan.destHostName} is already running.`);
    }

    const job = await this.prisma.stackHostRestore.create({
      data: {
        sourceInstanceId: plan.sourceInstanceId,
        sourceHostName: plan.sourceHostName,
        destInstanceId: plan.destInstanceId,
        destHostName: plan.destHostName,
        status: 'running',
        items: items as unknown as object,
      },
    });
    this.running.add(plan.destInstanceId);
    void this.execute(job.id, plan, input, items).finally(() => this.running.delete(plan.destInstanceId));
    return this.dto(job);
  }

  private async execute(jobId: string, plan: HostRestorePlan, input: HostRestoreInput, items: HostRestoreItem[]): Promise<void> {
    const save = (extra: Record<string, unknown> = {}) =>
      this.prisma.stackHostRestore.update({ where: { id: jobId }, data: { items: items as unknown as object, ...extra } }).catch(() => undefined);
    void this.logging.info(
      'stack-backup',
      `Whole-host restore ${plan.sourceHostName} → ${plan.destHostName}: ${items.map((i) => i.stackName).join(', ')}.`,
    );

    for (const item of items) {
      const s = plan.stacks.find((x) => x.policyId === item.policyId)!;
      item.status = 'running';
      await save();
      try {
        // Things can change while earlier stacks restore (someone starts a stack by
        // hand). Re-check just before writing; only "data already exists" — which the
        // typed host name covers, and which gets a safety copy — may be overridden.
        const fresh = await this.restores.plan({ targetId: s.targetId, snapshotId: item.snapshotId, destInstanceId: plan.destInstanceId });
        const now = blocking(fresh.conflicts);
        if (now.length) throw new Error(`Skipped — changed since the plan: ${now.join(' ')}`);
        if (fresh.overwrites.length && !s.overwrites.length) {
          throw new Error(`Skipped — it would now overwrite data the confirmation did not cover: ${fresh.overwrites.join(', ')}.`);
        }
        const policy = await this.prisma.stackBackupPolicy.findUnique({ where: { id: item.policyId } });
        const run = await this.restores.start(
          {
            targetId: s.targetId,
            snapshotId: item.snapshotId,
            destInstanceId: plan.destInstanceId,
            mode: s.hasCompose ? 'full' : 'data',
            // Whole host: everything that was captured goes back, binds included unless turned off.
            binds: input.includeBinds ? await this.capturedBinds(s, plan.destInstanceId) : [],
            deploy: s.hasCompose && input.deploy,
            imageVersion: input.imageVersion,
            passphrase: policy ? await this.backups.storedSeal(policy) : undefined,
            // The host name typed once stands for each stack on it.
            confirmName: s.stackName,
            // Only ever overrides "these volumes already exist" — every other conflict
            // was re-checked just above.
            force: true,
          },
          { guarded: true },
        );
        item.restoreRunId = run.id;
        await save();
        const done = await this.awaitRestore(run.id);
        item.status = done?.status === 'success' ? 'success' : 'error';
        item.message = done?.message ?? 'Did not finish in time.';
      } catch (err) {
        item.status = 'error';
        item.message = msg(err);
      }
      await save();
    }

    const ok = items.filter((i) => i.status === 'success').length;
    const status = ok === items.length ? 'success' : ok === 0 ? 'error' : 'partial';
    const message = `${ok} of ${items.length} stack(s) restored onto ${plan.destHostName}.`;
    await save({ status, message, finishedAt: new Date() });
    void this.logging[status === 'success' ? 'info' : 'warn']('stack-backup', `Whole-host restore: ${message}`);
  }

  /** Every bind path the snapshot captured, written back where the plan says. */
  private async capturedBinds(s: HostRestoreStackPlan, destInstanceId: string): Promise<string[]> {
    if (!s.binds || !s.snapshotId) return [];
    const plan = await this.restores.plan({ targetId: s.targetId, snapshotId: s.snapshotId, destInstanceId });
    return plan.binds.map((b) => b.source);
  }

  async list(limit = 10): Promise<HostRestoreJob[]> {
    const rows = await this.prisma.stackHostRestore.findMany({ orderBy: { startedAt: 'desc' }, take: limit });
    return rows.map((r) => this.dto(r));
  }

  async get(id: string): Promise<HostRestoreJob> {
    const row = await this.prisma.stackHostRestore.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Whole-host restore not found.');
    return this.dto(row);
  }

  private async awaitRestore(runId: string) {
    const deadline = Date.now() + STACK_WAIT_MS;
    while (Date.now() < deadline) {
      const row = await this.prisma.stackRestoreRun.findUnique({ where: { id: runId } }).catch(() => null);
      if (row && row.status !== 'running') return row;
      await sleep(3000);
    }
    return null;
  }

  private async host(id: string) {
    const h = await this.prisma.connectorInstance.findUnique({ where: { id } });
    if (!h || h.connectorId !== 'docker') throw new NotFoundException('Docker host not found.');
    return h;
  }

  private dto(r: {
    id: string; sourceInstanceId: string; sourceHostName: string; destInstanceId: string; destHostName: string;
    status: string; items: unknown; message: string | null; startedAt: Date; finishedAt: Date | null;
  }): HostRestoreJob {
    return {
      id: r.id,
      sourceInstanceId: r.sourceInstanceId,
      sourceHostName: r.sourceHostName,
      destInstanceId: r.destInstanceId,
      destHostName: r.destHostName,
      status: r.status,
      items: Array.isArray(r.items) ? (r.items as HostRestoreItem[]) : [],
      message: r.message,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  }
}

const RANK: Record<HostRestoreStackPlan['status'], number> = { ready: 0, warning: 1, blocked: 2, 'no-snapshot': 3 };

/** A single restore's conflict for existing volumes is the overwrite this flow confirms
 *  by host name and covers with a safety copy — everything else still blocks. */
function blocking(conflicts: string[]): string[] {
  return conflicts.filter((c) => !/already exist on .* and would be written into/.test(c));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
