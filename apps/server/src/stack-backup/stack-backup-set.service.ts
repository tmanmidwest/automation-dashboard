import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { StackBackupPolicy as PolicyRow, StackBackupSet as SetRow } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { SecretsService } from '../secrets/secrets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { DockerStackService } from '../connectors/docker/docker-stack.service';
import type { DockerContainer } from '../connectors/docker/docker-api';
import type {
  AddSetMembersInput, CoverageReport, CoverageStatus, HostCoverage, IgnoreStackInput, QuiesceMode,
  RunSetResult, SaveBackupSetInput, SecretMode, StackBackupSet, StackCoverageRow, TransferMode,
} from '@cerebro/shared';
import { describeSchedule, intervalMs, nextRunAt } from '../common/backup-schedule';
import { hostAccess } from './docker-host';
import { StackBackupService } from './stack-backup.service';
import { StackBackupScheduler } from './stack-backup-scheduler.service';
import { cleanOverrides, inheritedColumns, setSealKey, transferFor } from './set-inherit';

const DOCKER = 'docker';
const PROJECT_LABEL = 'com.docker.compose.project';
/** Same threshold the staleness alert uses, so the coverage view and the alert agree. */
const STALE_FACTOR = 2.5;
/** A new stack gets this long to be given a backup (or picked up by a set) before it alerts. */
const UNPROTECTED_GRACE_MS = 60 * 60 * 1000;
/** One unreachable host must not hold up the whole coverage view. */
const HOST_TIMEOUT_MS = 10_000;

/**
 * Bind sources that are plumbing, not data — never worth flagging as "not captured".
 * Matched as the path itself or anything beneath it.
 */
const SYSTEM_BIND_PREFIXES = [
  '/var/run/docker.sock', '/run/docker.sock', '/etc/localtime', '/etc/timezone', '/etc/hosts',
  '/etc/resolv.conf', '/proc', '/sys', '/dev', '/lib/modules', '/run/udev', '/var/run/dbus', '/run/dbus',
];

interface HostScan {
  instanceId: string;
  hostName: string;
  reachable: boolean;
  error?: string;
  architecture?: string | null;
  /** project → bind sources its containers use */
  projects: Map<string, Set<string>>;
  managed: Set<string>;
}

/**
 * Backup sets and coverage — the management layer on top of per-stack backups
 * (docs/stack-backup.md, "Backup sets" and "Coverage").
 *
 * A set holds shared settings and writes them onto every member that has not
 * overridden them; each member stays an ordinary policy, so the scheduler,
 * retention and staleness checks need no idea that sets exist. Coverage answers
 * the question sets alone cannot: which stacks on which hosts have no backup at all.
 */
@Injectable()
export class StackBackupSetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: ConnectorInstanceService,
    private readonly stacks: DockerStackService,
    private readonly backups: StackBackupService,
    private readonly scheduler: StackBackupScheduler,
    private readonly secrets: SecretsService,
    private readonly notifications: NotificationsService,
    private readonly logging: LoggingService,
  ) {}

  // ── Sets ──────────────────────────────────────────────────────────

  async listSets(): Promise<StackBackupSet[]> {
    const rows = await this.prisma.stackBackupSet.findMany({
      orderBy: { name: 'asc' },
      include: { target: { select: { name: true } }, policies: { orderBy: { stackName: 'asc' } } },
    });
    const hostNames = await this.hostNames();
    return Promise.all(rows.map((r) => this.setDto(r, hostNames)));
  }

  async getSet(id: string): Promise<StackBackupSet> {
    const row = await this.prisma.stackBackupSet.findUnique({
      where: { id },
      include: { target: { select: { name: true } }, policies: { orderBy: { stackName: 'asc' } } },
    });
    if (!row) throw new NotFoundException('Backup set not found.');
    return this.setDto(row, await this.hostNames());
  }

  async saveSet(id: string | null, input: SaveBackupSetInput): Promise<StackBackupSet> {
    const name = (input.name ?? '').trim();
    if (!name) throw new BadRequestException('Give the set a name.');
    const target = await this.prisma.stackBackupTarget.findUnique({ where: { id: input.targetId } });
    if (!target) throw new BadRequestException('Choose a backup target.');

    const connectorInstanceId = input.connectorInstanceId || null;
    if (connectorInstanceId) {
      const host = await this.prisma.connectorInstance.findUnique({ where: { id: connectorInstanceId } });
      if (!host || host.connectorId !== DOCKER) throw new BadRequestException('That Docker host no longer exists.');
    }
    const autoInclude = !!input.autoInclude;
    if (autoInclude && !connectorInstanceId) {
      throw new BadRequestException('Auto-include needs a host — it adds every stack found on that one host.');
    }

    const quiesce = (input.quiesce ?? 'hot') as QuiesceMode;
    if (!['hot', 'pause', 'stop'].includes(quiesce)) throw new BadRequestException('Unknown capture mode.');
    const transfer = (input.transfer ?? 'direct') as TransferMode;
    if (!['direct', 'relay'].includes(transfer)) throw new BadRequestException('Unknown transfer mode.');
    const secretMode = (input.secretMode ?? 'embed') as SecretMode;
    if (!['embed', 'raw', 'reference'].includes(secretMode)) throw new BadRequestException('Unknown secret mode.');
    const frequency = input.frequency ?? 'off';
    if (!['off', 'daily', 'weekly', 'monthly'].includes(frequency)) throw new BadRequestException('Unknown schedule.');

    const existing = id ? await this.prisma.stackBackupSet.findUnique({ where: { id }, include: { policies: true } }) : null;
    if (id && !existing) throw new NotFoundException('Backup set not found.');

    // Narrowing a set to one host must not leave members from other hosts behind
    // under settings that no longer describe them.
    if (existing && connectorInstanceId) {
      const strays = existing.policies.filter((p) => p.connectorInstanceId !== connectorInstanceId);
      if (strays.length) {
        throw new BadRequestException(
          `This set has stacks on other hosts (${strays.map((p) => p.stackName).join(', ')}). Remove them from the set before limiting it to one host.`,
        );
      }
    }

    const data = {
      name,
      description: input.description?.trim() || null,
      connectorInstanceId,
      autoInclude,
      targetId: input.targetId,
      enabled: input.enabled ?? true,
      frequency,
      dayOfWeek: clamp(input.dayOfWeek ?? 0, 0, 6),
      dayOfMonth: clamp(input.dayOfMonth ?? 1, 1, 28),
      hour: clamp(input.hour ?? 3, 0, 23),
      minute: clamp(input.minute ?? 0, 0, 59),
      quiesce,
      transfer,
      secretMode,
      excludes: (input.excludes ?? []).map((x) => x.trim()).filter(Boolean),
      ...(input.excludedStacks ? { excludedStacks: [...new Set(input.excludedStacks.filter(Boolean))] } : {}),
    };

    // Same rule as a single stack, decided before anything is written: a sealed
    // schedule with nothing to seal with would fail every night. The set must hold
    // the passphrase itself, because auto-include can add stacks at any time and
    // each of them needs to be sealable unattended from its first run.
    if (frequency !== 'off' && secretMode === 'embed') {
      const willHaveSeal = input.sealPassphrase
        ? true
        : input.sealPassphrase === ''
          ? false
          : !!id && (await this.secrets.has(setSealKey(id)));
      if (!willHaveSeal) {
        throw new BadRequestException(
          'A scheduled set that seals secrets needs a stored sealing passphrase on the set — set one, or switch the set to raw secrets.',
        );
      }
    }

    const clash = await this.prisma.stackBackupSet.findFirst({ where: { name, ...(id ? { NOT: { id } } : {}) } });
    if (clash) throw new BadRequestException(`There is already a set called "${name}".`);

    const row = id
      ? await this.prisma.stackBackupSet.update({ where: { id }, data })
      : await this.prisma.stackBackupSet.create({ data });

    if (input.sealPassphrase != null) {
      if (input.sealPassphrase) {
        await this.secrets.set(setSealKey(row.id), input.sealPassphrase, {
          label: `Stack backup set sealing passphrase — ${row.name}`,
          description: 'Seals secrets for every stack in this backup set that has no passphrase of its own, including on scheduled runs.',
          category: 'manual',
        });
      } else {
        await this.secrets.remove(setSealKey(row.id)).catch(() => { /* may not exist */ });
      }
    }

    await this.applyToMembers(row.id);
    if (row.autoInclude) await this.syncSet(row.id).catch((err) => {
      void this.logging.warn('stack-backup', `Set "${row.name}" saved, but the first auto-include scan failed: ${msg(err)}`);
    });
    return this.getSet(row.id);
  }

  /**
   * Delete a set. Its stacks keep their backups as standalone ones with the
   * settings they had — deleting a grouping must never silently stop backups.
   * A member that sealed with the set's passphrase gets its own copy first, or
   * its next scheduled run would have nothing to seal with.
   */
  async deleteSet(id: string): Promise<void> {
    const row = await this.prisma.stackBackupSet.findUnique({ where: { id }, include: { policies: true } });
    if (!row) throw new NotFoundException('Backup set not found.');
    for (const p of row.policies) await this.carrySealOver(p, row);
    await this.prisma.stackBackupSet.delete({ where: { id } });
    await this.secrets.remove(setSealKey(id)).catch(() => { /* may not exist */ });
    void this.logging.info('stack-backup', `Backup set "${row.name}" deleted — its ${row.policies.length} stack(s) keep their backups.`);
  }

  async addMembers(setId: string, input: AddSetMembersInput): Promise<StackBackupSet> {
    const set = await this.prisma.stackBackupSet.findUnique({ where: { id: setId } });
    if (!set) throw new NotFoundException('Backup set not found.');
    const wanted = (input.stacks ?? []).filter((s) => s.connectorInstanceId && s.stackName);
    if (!wanted.length) throw new BadRequestException('Pick at least one stack.');

    const problems: string[] = [];
    for (const s of wanted) {
      if (set.connectorInstanceId && s.connectorInstanceId !== set.connectorInstanceId) {
        problems.push(`${s.stackName}: this set only takes stacks from its own host`);
        continue;
      }
      const existing = await this.prisma.stackBackupPolicy.findUnique({
        where: { connectorInstanceId_stackName: { connectorInstanceId: s.connectorInstanceId, stackName: s.stackName } },
        include: { set: { select: { name: true } } },
      });
      if (existing?.setId && existing.setId !== setId) {
        problems.push(`${s.stackName}: already in set "${existing.set?.name}" — remove it there first`);
        continue;
      }
      await this.join(set, s.connectorInstanceId, s.stackName, existing);
    }
    // Putting a stack back by hand undoes an earlier "remove from set".
    const back = wanted.map((s) => s.stackName).filter((n) => set.excludedStacks.includes(n));
    if (back.length) {
      await this.prisma.stackBackupSet.update({
        where: { id: setId },
        data: { excludedStacks: set.excludedStacks.filter((n) => !back.includes(n)) },
      });
    }
    if (problems.length && problems.length === wanted.length) throw new BadRequestException(problems.join('; '));
    if (problems.length) void this.logging.warn('stack-backup', `Set "${set.name}": some stacks were not added — ${problems.join('; ')}`);
    return this.getSet(setId);
  }

  /**
   * Take a stack out of a set. `keep` leaves it as a standalone backup with the
   * settings it had; `delete` removes its backup configuration (never its snapshots).
   * Either way an auto-include set remembers, so the next sync does not re-add it.
   */
  async removeMember(setId: string, policyId: string, mode: 'keep' | 'delete'): Promise<StackBackupSet> {
    const policy = await this.prisma.stackBackupPolicy.findUnique({ where: { id: policyId }, include: { set: true } });
    if (!policy || policy.setId !== setId || !policy.set) throw new NotFoundException('That stack is not in this set.');
    const set = policy.set;
    if (set.autoInclude && !set.excludedStacks.includes(policy.stackName)) {
      await this.prisma.stackBackupSet.update({ where: { id: setId }, data: { excludedStacks: { push: policy.stackName } } });
    }
    if (mode === 'delete') {
      await this.backups.removePolicy(policyId);
    } else {
      await this.carrySealOver(policy, set);
      await this.prisma.stackBackupPolicy.update({ where: { id: policyId }, data: { setId: null, setOverrides: [] } });
    }
    return this.getSet(setId);
  }

  /** Queue every enabled member for a backup now, one at a time per repository. */
  async runSet(setId: string): Promise<RunSetResult> {
    const set = await this.prisma.stackBackupSet.findUnique({ where: { id: setId }, include: { policies: true } });
    if (!set) throw new NotFoundException('Backup set not found.');
    const out: RunSetResult = { queued: [], skipped: [] };
    for (const p of set.policies) {
      if (!p.enabled) { out.skipped.push({ stackName: p.stackName, reason: 'switched off' }); continue; }
      if (p.secretMode === 'embed' && !(await this.backups.hasStoredSeal(p))) {
        out.skipped.push({ stackName: p.stackName, reason: 'seals secrets but has no stored passphrase — run it on its own' });
        continue;
      }
      const ok = this.scheduler.enqueue(p.id, p.targetId, p.stackName, 'manual', `set "${set.name}"`);
      if (ok) out.queued.push(p.stackName);
      else out.skipped.push({ stackName: p.stackName, reason: 'already queued or running' });
    }
    return out;
  }

  // ── Auto-include ──────────────────────────────────────────────────

  /**
   * Add every compose stack on the set's host that has no backup anywhere yet.
   * Never touches a stack that already has a backup (standalone or in another
   * set), never re-adds one removed by hand, and never removes anything — a stack
   * that disappeared from the host shows up as "missing" in coverage instead.
   */
  async syncSet(setId: string): Promise<StackBackupSet> {
    const set = await this.prisma.stackBackupSet.findUnique({ where: { id: setId } });
    if (!set) throw new NotFoundException('Backup set not found.');
    if (!set.autoInclude || !set.connectorInstanceId) throw new BadRequestException('This set does not auto-include stacks.');

    const scan = await this.scanHost(set.connectorInstanceId);
    if (!scan.reachable) {
      await this.prisma.stackBackupSet.update({
        where: { id: setId },
        data: { lastSyncAt: new Date(), lastSyncMessage: `Host unreachable: ${scan.error ?? 'unknown error'}` },
      });
      return this.getSet(setId);
    }

    const configured = new Set(
      (await this.prisma.stackBackupPolicy.findMany({
        where: { connectorInstanceId: set.connectorInstanceId },
        select: { stackName: true },
      })).map((p) => p.stackName),
    );
    const ignored = new Set(
      (await this.prisma.stackCoverageEntry.findMany({
        where: { connectorInstanceId: set.connectorInstanceId, ignored: true },
        select: { stackName: true },
      })).map((e) => e.stackName),
    );

    const added: string[] = [];
    for (const project of [...scan.projects.keys()].sort()) {
      if (configured.has(project) || set.excludedStacks.includes(project) || ignored.has(project)) continue;
      await this.join(set, set.connectorInstanceId, project, null);
      added.push(project);
    }
    const message = added.length
      ? `Added ${added.length} stack(s): ${added.join(', ')}`
      : 'No new stacks to add.';
    await this.prisma.stackBackupSet.update({ where: { id: setId }, data: { lastSyncAt: new Date(), lastSyncMessage: message } });
    if (added.length) void this.logging.info('stack-backup', `Set "${set.name}": ${message}.`);
    return this.getSet(setId);
  }

  // ── Coverage ──────────────────────────────────────────────────────

  async coverage(): Promise<CoverageReport> {
    const hosts = await this.prisma.connectorInstance.findMany({
      where: { connectorId: DOCKER, enabled: true },
      orderBy: { name: 'asc' },
    });
    const scans = await Promise.all(hosts.map((h) => this.scanHost(h.id, h.name)));
    await this.recordSeen(scans);

    const policies = await this.prisma.stackBackupPolicy.findMany({ include: { set: { select: { name: true } } } });
    const lastGood = await this.lastSuccessByPolicy();
    const entries = await this.prisma.stackCoverageEntry.findMany();
    const entryOf = new Map(entries.map((e) => [`${e.connectorInstanceId}/${e.stackName}`, e]));

    const totals = Object.fromEntries(
      (['protected', 'pending', 'manual', 'stale', 'failing', 'disabled', 'unprotected', 'ignored', 'missing'] as CoverageStatus[]).map((k) => [k, 0]),
    ) as Record<CoverageStatus, number>;

    const out: HostCoverage[] = [];
    for (const scan of scans) {
      const rows: StackCoverageRow[] = [];
      const hostPolicies = policies.filter((p) => p.connectorInstanceId === scan.instanceId);
      const names = new Set<string>([...scan.projects.keys(), ...hostPolicies.map((p) => p.stackName)]);
      for (const stackName of [...names].sort()) {
        const policy = hostPolicies.find((p) => p.stackName === stackName);
        const entry = entryOf.get(`${scan.instanceId}/${stackName}`);
        const binds = scan.projects.get(stackName);
        const present = scan.projects.has(stackName);
        const success = policy ? lastGood.get(policy.id) : undefined;
        const status = coverageStatus({ policy, present, reachable: scan.reachable, ignored: !!entry?.ignored, lastSuccess: success, schedule: policy ? this.backups.scheduleOf(policy) : undefined });
        totals[status] += 1;
        rows.push({
          connectorInstanceId: scan.instanceId,
          stackName,
          status,
          policyId: policy?.id ?? null,
          setId: policy?.setId ?? null,
          setName: policy?.set?.name ?? null,
          lastSuccessAt: success?.toISOString() ?? null,
          scheduleText: policy ? (policy.enabled ? describeSchedule(this.backups.scheduleOf(policy)) : 'disabled') : null,
          uncapturedBinds: binds ? uncaptured([...binds], policy?.includeBinds ?? []) : [],
          managed: scan.managed.has(stackName),
          ignoreReason: entry?.ignored ? entry.ignoreReason : null,
          firstSeenAt: entry?.firstSeenAt.toISOString() ?? null,
        });
      }
      out.push({
        connectorInstanceId: scan.instanceId,
        hostName: scan.hostName,
        architecture: scan.architecture ?? null,
        reachable: scan.reachable,
        error: scan.error ?? null,
        stacks: rows,
      });
    }
    return { hosts: out, totals, generatedAt: new Date().toISOString() };
  }

  /** Mark a stack as "no backup on purpose" (or undo that). */
  async setIgnored(instanceId: string, stackName: string, input: IgnoreStackInput): Promise<void> {
    if (!instanceId || !stackName) throw new BadRequestException('A host and stack are required.');
    await this.prisma.stackCoverageEntry.upsert({
      where: { connectorInstanceId_stackName: { connectorInstanceId: instanceId, stackName } },
      update: { ignored: !!input.ignored, ignoreReason: input.ignored ? input.reason?.trim() || null : null },
      create: {
        connectorInstanceId: instanceId, stackName, ignored: !!input.ignored,
        ignoreReason: input.ignored ? input.reason?.trim() || null : null,
        // Un-ignoring later should not fire an alert for a stack the operator already knew about.
        alertedAt: new Date(),
      },
    });
  }

  // ── Hourly: auto-include, then chase unprotected stacks ──────────

  @Cron('0 15 * * * *')
  async hourly(): Promise<void> {
    const sets = await this.prisma.stackBackupSet.findMany({ where: { autoInclude: true } }).catch(() => []);
    for (const set of sets) {
      await this.syncSet(set.id).catch((err) => {
        void this.logging.warn('stack-backup', `Auto-include for set "${set.name}" failed: ${msg(err)}`);
      });
    }
    await this.sweepUnprotected().catch((err) => {
      void this.logging.warn('stack-backup', `Coverage sweep failed: ${msg(err)}`);
    });
  }

  /**
   * Alert once for each stack that appeared since Cerebro started watching and
   * still has no backup after a grace period. Stacks present the first time a
   * host is scanned are the baseline — they show in the coverage view, but do
   * not trigger a flood of alerts on day one.
   */
  async sweepUnprotected(): Promise<void> {
    const hosts = await this.prisma.connectorInstance.findMany({ where: { connectorId: DOCKER, enabled: true } });
    const scans = await Promise.all(hosts.map((h) => this.scanHost(h.id, h.name)));
    await this.recordSeen(scans);

    const configured = new Set(
      (await this.prisma.stackBackupPolicy.findMany({ select: { connectorInstanceId: true, stackName: true } }))
        .map((p) => `${p.connectorInstanceId}/${p.stackName}`),
    );
    const cutoff = new Date(Date.now() - UNPROTECTED_GRACE_MS);
    for (const scan of scans) {
      if (!scan.reachable) continue;
      const due = await this.prisma.stackCoverageEntry.findMany({
        where: {
          connectorInstanceId: scan.instanceId,
          ignored: false,
          alertedAt: null,
          firstSeenAt: { lte: cutoff },
          stackName: { in: [...scan.projects.keys()] },
        },
      });
      const fresh = due.filter((e) => !configured.has(`${e.connectorInstanceId}/${e.stackName}`));
      if (!fresh.length) continue;
      const names = fresh.map((e) => e.stackName).sort();
      await this.notifications.dispatchAlert('backup.unprotected', {
        title: `New stack${names.length > 1 ? 's' : ''} with no backup on ${scan.hostName}`,
        body: `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} running on ${scan.hostName} with no backup configured. Add ${names.length > 1 ? 'them' : 'it'} to a backup set, back ${names.length > 1 ? 'them' : 'it'} up on ${names.length > 1 ? 'their' : 'its'} own, or mark ${names.length > 1 ? 'them' : 'it'} as not needing a backup on the Stack Backups page.`,
        dedupeKey: `stack-backup:unprotected:${scan.instanceId}:${names.join(',')}`,
        connectorId: scan.instanceId,
      }).catch(() => { /* never let alerting break the sweep */ });
      await this.prisma.stackCoverageEntry.updateMany({
        where: { id: { in: fresh.map((e) => e.id) } },
        data: { alertedAt: new Date() },
      });
    }
  }

  // ── Internals ─────────────────────────────────────────────────────

  /** Put one stack in a set: create its backup if it has none, or adopt the existing one. */
  private async join(set: SetRow, instanceId: string, stackName: string, existing: PolicyRow | null): Promise<void> {
    const ssh = await this.backups.hostHasSsh(instanceId);
    const inherited = inheritedColumns(set, []);
    const data = {
      ...inherited,
      transfer: transferFor(set.transfer, ssh),
      setId: set.id,
      setOverrides: [] as string[],
    };
    if (existing) {
      await this.prisma.stackBackupPolicy.update({ where: { id: existing.id }, data });
    } else {
      // Bind paths and hooks start empty: binds stay opt-in per path, exactly as
      // when a stack is backed up on its own.
      await this.prisma.stackBackupPolicy.create({
        data: { connectorInstanceId: instanceId, stackName, ...data, targetId: set.targetId },
      });
    }
  }

  /** Write a set's settings onto every member, honouring each member's overrides. */
  private async applyToMembers(setId: string): Promise<void> {
    const set = await this.prisma.stackBackupSet.findUnique({ where: { id: setId }, include: { policies: true } });
    if (!set) return;
    const sshByHost = new Map<string, boolean>();
    for (const p of set.policies) {
      if (!sshByHost.has(p.connectorInstanceId)) sshByHost.set(p.connectorInstanceId, await this.backups.hostHasSsh(p.connectorInstanceId));
      const overrides = cleanOverrides(p.setOverrides);
      const data = inheritedColumns(set, overrides);
      if (data.transfer !== undefined) data.transfer = transferFor(data.transfer, sshByHost.get(p.connectorInstanceId)!);
      await this.prisma.stackBackupPolicy.update({ where: { id: p.id }, data });
    }
  }

  /** Before a member stops being able to use the set's passphrase, give it its own copy. */
  private async carrySealOver(policy: PolicyRow, set: SetRow): Promise<void> {
    const own = `stack-backup:policy:${policy.id}:passphrase`;
    if (await this.secrets.has(own)) return;
    const shared = await this.secrets.reveal(setSealKey(set.id)).catch(() => null);
    if (!shared) return;
    await this.secrets.set(own, shared, {
      label: `Stack backup sealing passphrase — ${policy.stackName}`,
      description: `Copied from backup set "${set.name}" when the stack left the set.`,
      category: 'manual',
    });
  }

  /** What is on one host right now: compose projects, their bind sources, and the CPU. */
  private async scanHost(instanceId: string, hostName?: string): Promise<HostScan> {
    const base: HostScan = { instanceId, hostName: hostName ?? instanceId, reachable: false, projects: new Map(), managed: new Set() };
    try {
      const row = await this.prisma.connectorInstance.findUnique({ where: { id: instanceId } });
      if (!row) return { ...base, error: 'Host no longer exists.' };
      base.hostName = row.name;
      const { api } = hostAccess(await this.instances.contextFor(row), this.stacks);
      const [containers, info] = await Promise.all([
        withTimeout(api.listContainers(true), HOST_TIMEOUT_MS),
        withTimeout(api.info(), HOST_TIMEOUT_MS).catch(() => null),
      ]);
      const projects = groupProjects(containers);
      const managed = new Set((await this.stacks.list(instanceId).catch(() => [])).map((s) => s.name));
      return {
        ...base,
        reachable: true,
        architecture: (info as { Architecture?: string } | null)?.Architecture ?? null,
        projects,
        managed,
      };
    } catch (err) {
      return { ...base, error: msg(err) };
    }
  }

  /**
   * Keep the "seen" ledger current. The first time a host is scanned, everything
   * on it is recorded as already alerted — the baseline — so only stacks that turn
   * up later are announced.
   */
  private async recordSeen(scans: HostScan[]): Promise<void> {
    const now = new Date();
    for (const scan of scans) {
      if (!scan.reachable) continue;
      const known = await this.prisma.stackCoverageEntry.findMany({
        where: { connectorInstanceId: scan.instanceId },
        select: { stackName: true },
      });
      const baseline = known.length === 0;
      const knownNames = new Set(known.map((k) => k.stackName));
      const fresh = [...scan.projects.keys()].filter((n) => !knownNames.has(n));
      if (fresh.length) {
        await this.prisma.stackCoverageEntry.createMany({
          data: fresh.map((stackName) => ({
            connectorInstanceId: scan.instanceId, stackName, firstSeenAt: now, lastSeenAt: now,
            alertedAt: baseline ? now : null,
          })),
          skipDuplicates: true,
        });
      }
      const seen = [...scan.projects.keys()].filter((n) => knownNames.has(n));
      if (seen.length) {
        await this.prisma.stackCoverageEntry.updateMany({
          where: { connectorInstanceId: scan.instanceId, stackName: { in: seen } },
          data: { lastSeenAt: now },
        });
      }
    }
  }

  private async lastSuccessByPolicy(): Promise<Map<string, Date>> {
    const rows = await this.prisma.stackBackupRun.groupBy({
      by: ['policyId'],
      where: { status: 'success', policyId: { not: null } },
      _max: { startedAt: true },
    });
    const out = new Map<string, Date>();
    for (const r of rows) if (r.policyId && r._max.startedAt) out.set(r.policyId, r._max.startedAt);
    return out;
  }

  private async hostNames(): Promise<Map<string, string>> {
    const rows = await this.prisma.connectorInstance.findMany({ where: { connectorId: DOCKER }, select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async setDto(
    row: SetRow & { target: { name: string }; policies: PolicyRow[] },
    hostNames: Map<string, string>,
  ): Promise<StackBackupSet> {
    const schedule = this.backups.scheduleOf(row);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      connectorInstanceId: row.connectorInstanceId,
      hostName: row.connectorInstanceId ? hostNames.get(row.connectorInstanceId) ?? null : null,
      autoInclude: row.autoInclude,
      excludedStacks: row.excludedStacks,
      targetId: row.targetId,
      targetName: row.target.name,
      enabled: row.enabled,
      frequency: row.frequency as StackBackupSet['frequency'],
      dayOfWeek: row.dayOfWeek,
      dayOfMonth: row.dayOfMonth,
      hour: row.hour,
      minute: row.minute,
      quiesce: row.quiesce as QuiesceMode,
      transfer: row.transfer as TransferMode,
      secretMode: row.secretMode as SecretMode,
      excludes: row.excludes,
      hasSealPassphrase: await this.secrets.has(setSealKey(row.id)),
      scheduleText: row.enabled ? describeSchedule(schedule) : 'disabled',
      nextRunAt: row.enabled ? (nextRunAt(schedule)?.toISOString() ?? null) : null,
      lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
      lastSyncMessage: row.lastSyncMessage,
      members: row.policies.map((p) => ({
        policyId: p.id,
        connectorInstanceId: p.connectorInstanceId,
        hostName: hostNames.get(p.connectorInstanceId),
        stackName: p.stackName,
        setOverrides: cleanOverrides(p.setOverrides),
        lastStatus: p.lastStatus,
        lastRunAt: p.lastRunAt?.toISOString() ?? null,
      })),
      createdAt: row.createdAt.toISOString(),
    };
  }
}

// ── Pure helpers (exported for tests) ──────────────────────────────

/** Compose projects on a host and the bind sources their containers use. */
export function groupProjects(containers: DockerContainer[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const c of containers) {
    const project = (c.Labels ?? {})[PROJECT_LABEL];
    if (!project) continue;
    const binds = out.get(project) ?? new Set<string>();
    for (const m of c.Mounts ?? []) {
      if (m.Type === 'bind' && m.Source) binds.add(m.Source);
    }
    out.set(project, binds);
  }
  return out;
}

/** Bind sources that hold data and are not covered by an included path (itself or a parent). */
export function uncaptured(sources: string[], included: string[]): string[] {
  const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);
  return sources
    .filter((s) => !SYSTEM_BIND_PREFIXES.some((sys) => under(s, sys)))
    .filter((s) => !included.some((inc) => under(s, inc)))
    .sort();
}

export function coverageStatus(a: {
  policy?: { enabled: boolean; frequency: string; lastStatus: string; createdAt: Date } | null;
  present: boolean;
  reachable: boolean;
  ignored: boolean;
  lastSuccess?: Date;
  schedule?: { frequency: string; dayOfWeek: number; dayOfMonth: number; hour: number; minute: number };
  now?: number;
}): CoverageStatus {
  const now = a.now ?? Date.now();
  if (!a.policy) return a.ignored ? 'ignored' : 'unprotected';
  // Only call a stack missing when we actually looked and it was not there.
  if (a.reachable && !a.present) return 'missing';
  if (!a.policy.enabled) return 'disabled';
  if (a.policy.lastStatus === 'error') return 'failing';
  if (a.policy.frequency === 'off') return 'manual';
  const window = a.schedule ? intervalMs(a.schedule as Parameters<typeof intervalMs>[0]) * STALE_FACTOR : 0;
  const since = now - (a.lastSuccess ?? a.policy.createdAt).getTime();
  if (window && since > window) return 'stale';
  // Never call a stack protected before a backup of it has actually succeeded.
  return a.lastSuccess ? 'protected' : 'pending';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`No answer within ${Math.round(ms / 1000)}s.`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : lo)));
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
