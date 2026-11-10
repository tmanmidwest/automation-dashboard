import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import type { AgentUpdateRun, Prisma, UpdateSchedule } from '@prisma/client';
import {
  OS_UPDATE_RUN_ACTIVE,
  OS_UPDATE_SECURITY_GRACE_DAYS,
  type FabricUpdatesFrame,
  type FabricUpdatesLogFrame,
  type FabricUpdatesResultFrame,
  type HealthInventory,
  type OsUpdateInstallRequest,
  type OsUpdateMachine,
  type OsUpdateMachineDetail,
  type OsUpdateOverview,
  type OsUpdatePackage,
  type OsUpdateProxmoxGuest,
  type OsUpdateRebootRequest,
  type OsUpdateRing,
  type OsUpdateRun,
  type OsUpdateRunStatus,
  type OsUpdateSchedule,
  type OsUpdateSigning,
  type SessionUser,
} from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AgentRegistryService } from '../fabric/agent-registry.service';
import { FabricUpdateSigningService } from '../fabric/fabric-update-signing.service';
import { AuditService } from '../logging/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { detectRole, normalizeRole } from '../health/health-assess';
import {
  describeTiming,
  isReboot,
  isScope,
  isWindowStart,
  mergeReport,
  nextWindowStart,
  sanitizeAgentRun,
  sanitizeReport,
  sanitizeSchedule,
  snapshotName,
  SNAPSHOT_PREFIX,
  toUpdateStatus,
  type StoredStatus,
} from './os-updates.logic';

/** Oldest agent that reports updates. */
const MIN_AGENT = [0, 7, 0];
/** Output kept per run. */
const MAX_LOG_LINES = 5000;
/** A command the agent never acknowledged. */
const SENT_TIMEOUT_MS = 10 * 60_000;
/** An install that stopped reporting (the agent gives up after 3 h itself). */
const RUNNING_TIMEOUT_MS = 4 * 3_600_000;
/** Manual "now" runs wait this long for the machine before they count as missed. */
const NOW_WINDOW_MS = 15 * 60_000;
/** Manual "later" runs: same window as schedules. */
const LATER_WINDOW_MS = 4 * 3_600_000;
const ALERT_STATE_KEY = 'updates.alertState';
const GUEST_CACHE_MS = 10 * 60_000;
const SNAPSHOTS_KEPT = 2;
const FINAL: OsUpdateRunStatus[] = ['succeeded', 'failed', 'refused', 'missed', 'cancelled', 'unknown'];

type RunWithAgent = AgentUpdateRun & { agent: { name: string } };

function versionAtLeast(v: string | null | undefined, min: number[]): boolean {
  if (!v) return false;
  const p = v.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((p[i] ?? 0) !== min[i]) return (p[i] ?? 0) > min[i];
  }
  return true;
}

/**
 * OS updates: stores what each agent finds pending, runs installs and restarts
 * (by hand or from schedules, ring by ring), takes a Proxmox snapshot first when
 * asked, and raises alerts. Commands go over the agent's Fabric connection and
 * are signed (vault signing). See docs/os-updates.md.
 */
@Injectable()
export class OsUpdatesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OsUpdatesService.name);
  /** Output waiting to be written, by run id. */
  private readonly logBuf = new Map<string, string[]>();
  private flushTimer: NodeJS.Timeout | null = null;
  private dispatching = false;
  /** Runs whose snapshot / send is in flight in this process. */
  private readonly busyRuns = new Set<string>();
  private guestCache: { at: number; byMac: Map<string, OsUpdateProxmoxGuest> } | null = null;
  private alertState: Record<string, string> = {};

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AgentRegistryService,
    private readonly signing: FabricUpdateSigningService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly instances: ConnectorInstanceService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registry.setUpdatesHooks({
      report: (agentId, frame) => this.onReport(agentId, frame),
      log: (agentId, frame) => this.onLog(agentId, frame),
      result: (agentId, frame) => this.onResult(agentId, frame),
    });
    this.flushTimer = setInterval(() => void this.flushLogs(), 2000);
    this.alertState = (await this.settings.get<Record<string, string>>(ALERT_STATE_KEY).catch(() => null)) ?? {};
    // Runs a restart of Cerebro interrupted mid-snapshot can't resume: send them again.
    await this.prisma.agentUpdateRun
      .updateMany({ where: { status: 'snapshot' }, data: { status: 'scheduled', snapshotNote: 'Cerebro restarted while taking the snapshot; trying again.' } })
      .catch(() => undefined);
  }

  onModuleDestroy(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    void this.flushLogs();
  }

  // ── Agent frames ──────────────────────────────────────────────────────────

  private async onReport(agentId: string, frame: FabricUpdatesFrame): Promise<void> {
    const rep = sanitizeReport(frame.report);
    if (!rep) return;
    const now = new Date();
    const prev = (await this.prisma.agentUpdateStatus.findUnique({ where: { agentId } })) as StoredStatus | null;
    const next = mergeReport(prev, rep, now);
    const data = { ...next, packages: (next.packages ?? []) as Prisma.InputJsonValue };
    await this.prisma.agentUpdateStatus.upsert({ where: { agentId }, create: { agentId, ...data }, update: data });
    // The agent is working on a run → it's running.
    if (rep.installing) {
      await this.prisma.agentUpdateRun.updateMany({ where: { id: rep.installing, agentId, status: { in: ['sent', 'scheduled'] } }, data: { status: 'running' } });
    }
    // A result we may have missed (sent while Cerebro was down, or before a restart).
    if (rep.lastRun) await this.applyResult(agentId, rep.lastRun, true);
  }

  private async onLog(agentId: string, frame: FabricUpdatesLogFrame): Promise<void> {
    if (typeof frame.runId !== 'string' || !Array.isArray(frame.lines)) return;
    const lines = frame.lines.filter((l): l is string => typeof l === 'string').map((l) => (l.length > 500 ? `${l.slice(0, 500)}…` : l)).slice(0, 500);
    if (!lines.length) return;
    const buf = this.logBuf.get(frame.runId) ?? [];
    buf.push(...lines);
    this.logBuf.set(frame.runId, buf);
    if (buf.length === lines.length) {
      // First output for this run: it's running.
      await this.prisma.agentUpdateRun.updateMany({ where: { id: frame.runId, agentId, status: { in: ['sent', 'scheduled'] } }, data: { status: 'running' } });
    }
  }

  private async onResult(agentId: string, frame: FabricUpdatesResultFrame): Promise<void> {
    const r = sanitizeAgentRun(frame.result);
    if (r) await this.applyResult(agentId, r, false);
  }

  private async flushLogs(): Promise<void> {
    if (!this.logBuf.size) return;
    const pending = [...this.logBuf.entries()];
    this.logBuf.clear();
    for (const [id, lines] of pending) {
      try {
        const text = `${lines.join('\n')}\n`;
        // Append in SQL so concurrent flushes never lose lines; stop at the cap.
        await this.prisma.$executeRaw`UPDATE "AgentUpdateRun" SET "log" = "log" || ${text}, "logLines" = "logLines" + ${lines.length} WHERE "id" = ${id} AND "logLines" < ${MAX_LOG_LINES}`;
      } catch (e) {
        this.logger.warn(`Couldn't save update output for ${id}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  private async applyResult(agentId: string, r: ReturnType<typeof sanitizeAgentRun> & object, fromReport: boolean): Promise<void> {
    const run = await this.prisma.agentUpdateRun.findFirst({ where: { id: r.runId, agentId }, include: { agent: { select: { name: true } } } });
    if (!run || FINAL.includes(run.status as OsUpdateRunStatus)) return;
    await this.flushLogs();
    const refused = !r.ok && /^Refused/i.test(r.message ?? '');
    const status: OsUpdateRunStatus = r.ok ? 'succeeded' : refused ? 'refused' : 'failed';
    const updated = await this.prisma.agentUpdateRun.update({
      where: { id: run.id },
      data: {
        status,
        message: r.message ?? (r.ok ? 'Done.' : 'Failed.'),
        exitCode: r.exitCode,
        installed: r.installed ?? null,
        rebooting: !!r.rebooting,
        startedAt: run.startedAt ?? (r.startedAt ? new Date(r.startedAt) : new Date()),
        finishedAt: r.finishedAt ? new Date(r.finishedAt) : new Date(),
      },
      include: { agent: { select: { name: true } } },
    });
    if (fromReport) this.logger.log(`Run ${run.id} on ${run.agent.name} finished while Cerebro wasn't listening: ${status}`);
    await this.notifyRun(updated);
    // A finished install frees the machine for the next ring / queued run.
    void this.dispatch();
  }

  private async notifyRun(run: RunWithAgent): Promise<void> {
    const what = run.kind === 'reboot' ? 'Restart' : 'Updates';
    if (run.status === 'succeeded') {
      if (run.kind === 'reboot') return;
      await this.notifications
        .dispatchAlert('updates.run_succeeded', {
          title: `Updates installed on ${run.agent.name}`,
          body: `${run.agent.name}: ${run.message ?? 'Updates installed.'}${run.rebooting ? ' Restarting now.' : ''}`,
          dedupeKey: `updates:run:${run.id}`,
        })
        .catch(() => undefined);
      return;
    }
    if (run.status === 'failed' || run.status === 'refused' || run.status === 'missed' || run.status === 'unknown') {
      await this.notifications
        .dispatchAlert('updates.run_failed', {
          title: `${what} ${run.status === 'missed' ? 'missed' : 'failed'} on ${run.agent.name}`,
          body: `${run.agent.name}: ${run.message ?? run.status}`,
          dedupeKey: `updates:run:${run.id}`,
        })
        .catch(() => undefined);
    }
  }

  // ── Read side ─────────────────────────────────────────────────────────────

  async signingState(): Promise<OsUpdateSigning> {
    const s = await this.signing.status().catch(() => ({ enabled: false }) as { enabled: boolean; mode?: 'vault' | 'offline' });
    if (!s.enabled) return { mode: 'off', canSign: false, message: 'Update signing is off, so agents accept install commands unsigned. Turn on signing in Fabric → Update signing to lock this down.' };
    if (s.mode === 'vault') return { mode: 'vault', canSign: true };
    return {
      mode: 'offline',
      canSign: false,
      message: 'Update signing is in offline mode, so Cerebro can\'t sign install commands and agents that pinned the key will refuse them. Checking for updates still works.',
    };
  }

  private toRun(r: RunWithAgent, scheduleNames: Map<string, string>, withLog = false): OsUpdateRun {
    return {
      id: r.id,
      agentId: r.agentId,
      agentName: r.agent.name,
      kind: r.kind === 'reboot' ? 'reboot' : 'install',
      trigger: r.trigger === 'schedule' ? 'schedule' : 'manual',
      scheduleId: r.scheduleId,
      scheduleName: r.scheduleId ? (scheduleNames.get(r.scheduleId) ?? 'Deleted schedule') : null,
      ring: r.ring,
      scope: isScope(r.scope) ? r.scope : 'all',
      reboot: isReboot(r.reboot) ? r.reboot : 'never',
      snapshot: r.snapshot,
      status: r.status as OsUpdateRunStatus,
      scheduledFor: r.scheduledFor?.toISOString() ?? null,
      windowEnd: r.windowEnd?.toISOString() ?? null,
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      message: r.message,
      exitCode: r.exitCode,
      installed: r.installed,
      rebooting: r.rebooting,
      snapshotName: r.snapshotName,
      snapshotNote: r.snapshotNote,
      requestedBy: r.requestedBy,
      pendingBefore: r.pendingBefore,
      createdAt: r.createdAt.toISOString(),
      logLines: r.logLines,
      ...(withLog ? { log: r.log ? r.log.replace(/\n$/, '').split('\n') : [] } : {}),
    };
  }

  private async scheduleNames(): Promise<Map<string, string>> {
    const rows = await this.prisma.updateSchedule.findMany({ select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async machines(onlyAgentId?: string): Promise<OsUpdateMachine[]> {
    const agents = await this.prisma.agent.findMany({
      where: { status: { notIn: ['pending', 'revoked', 'deleting'] }, ...(onlyAgentId ? { id: onlyAgentId } : {}) },
      include: { updateStatus: true, health: { select: { inventory: true, autoRole: true } } },
      orderBy: { name: 'asc' },
    });
    if (onlyAgentId && !agents.length) throw new NotFoundException('Machine not found.');
    const ids = agents.map((a) => a.id);
    const [lastRuns, names, guests] = await Promise.all([
      this.prisma.agentUpdateRun.findMany({
        where: { agentId: { in: ids } },
        orderBy: { createdAt: 'desc' },
        distinct: ['agentId'],
        include: { agent: { select: { name: true } } },
      }),
      this.scheduleNames(),
      this.guestsByMac().catch(() => new Map<string, OsUpdateProxmoxGuest>()),
    ]);
    const lastBy = new Map(lastRuns.map((r) => [r.agentId, r]));
    return agents.map((a) => {
      const inv = (a.health?.inventory as HealthInventory | null) ?? null;
      const role = normalizeRole(a.healthRole) ?? normalizeRole(a.health?.autoRole) ?? detectRole(inv, a.os);
      const st = toUpdateStatus(a.updateStatus as StoredStatus | null);
      const guest = (inv?.macs ?? []).map((m) => guests.get(m.toLowerCase())).find(Boolean) ?? null;
      const last = lastBy.get(a.id);
      const base = st ?? {
        checkedAt: null, manager: null, supported: false, error: null, note: null, total: 0, security: 0, securityKnown: false,
        rebootRequired: false, rebootReason: null, securitySince: null, rebootSince: null, canInstall: false, proxmox: false,
        mode: 'on' as const, installing: null, checking: false,
      };
      return {
        ...base,
        agentId: a.id,
        name: a.name,
        os: a.os,
        online: this.registry.statusOf(a.id, a.status) === 'online',
        role,
        agentVersion: a.agentVersion,
        agentTooOld: !!a.agentVersion && !versionAtLeast(a.agentVersion, MIN_AGENT),
        proxmoxGuest: guest,
        lastRun: last ? this.toRun(last, names) : null,
      };
    });
  }

  async overview(): Promise<OsUpdateOverview> {
    const [machines, runs, schedules, signing, names] = await Promise.all([
      this.machines(),
      this.prisma.agentUpdateRun.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { agent: { select: { name: true } } } }),
      this.listSchedules(),
      this.signingState(),
      this.scheduleNames(),
    ]);
    const weekAgo = Date.now() - 7 * 86_400_000;
    return {
      machines,
      runs: runs.map((r) => this.toRun(r, names)),
      schedules,
      signing,
      totals: {
        machines: machines.length,
        withUpdates: machines.filter((m) => m.total > 0).length,
        withSecurity: machines.filter((m) => m.security > 0).length,
        needRestart: machines.filter((m) => m.rebootRequired).length,
        failedRuns: runs.filter((r) => ['failed', 'refused', 'missed', 'unknown'].includes(r.status) && r.createdAt.getTime() > weekAgo).length,
      },
    };
  }

  async machineDetail(agentId: string): Promise<OsUpdateMachineDetail> {
    const [machine] = await this.machines(agentId);
    const [row, runs, names] = await Promise.all([
      this.prisma.agentUpdateStatus.findUnique({ where: { agentId }, select: { packages: true } }),
      this.prisma.agentUpdateRun.findMany({ where: { agentId }, orderBy: { createdAt: 'desc' }, take: 30, include: { agent: { select: { name: true } } } }),
      this.scheduleNames(),
    ]);
    const packages = (Array.isArray(row?.packages) ? (row!.packages as unknown as OsUpdatePackage[]) : []).slice();
    packages.sort((a, b) => Number(!!b.security) - Number(!!a.security) || a.name.localeCompare(b.name));
    return { machine, packages, runs: runs.map((r) => this.toRun(r, names)) };
  }

  async run(id: string): Promise<OsUpdateRun> {
    await this.flushLogs();
    const r = await this.prisma.agentUpdateRun.findUnique({ where: { id }, include: { agent: { select: { name: true } } } });
    if (!r) throw new NotFoundException('Run not found.');
    return this.toRun(r, await this.scheduleNames(), true);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  check(agentId: string): { requested: boolean } {
    return { requested: this.registry.requestUpdatesCheck(agentId) };
  }

  /** Queue installs; machines that can't take one are reported back, not queued. */
  async requestInstall(body: OsUpdateInstallRequest, user: SessionUser | undefined): Promise<{ runs: OsUpdateRun[]; skipped: { agentId: string; name: string; reason: string }[] }> {
    if (!body || !Array.isArray(body.agentIds) || !body.agentIds.length) throw new BadRequestException('Pick at least one machine.');
    if (!isScope(body.scope)) throw new BadRequestException('scope must be security or all.');
    if (!isReboot(body.reboot)) throw new BadRequestException('reboot must be never, if-needed or always.');
    return this.queue('install', body.agentIds, { scope: body.scope, reboot: body.reboot, snapshot: !!body.snapshot, at: body.at }, user);
  }

  async requestReboot(body: OsUpdateRebootRequest, user: SessionUser | undefined) {
    if (!body || !Array.isArray(body.agentIds) || !body.agentIds.length) throw new BadRequestException('Pick at least one machine.');
    return this.queue('reboot', body.agentIds, { scope: 'all', reboot: 'always', snapshot: false, at: body.at }, user);
  }

  private async queue(
    kind: 'install' | 'reboot',
    agentIds: string[],
    opts: { scope: string; reboot: string; snapshot: boolean; at?: string },
    user: SessionUser | undefined,
  ) {
    let at = new Date();
    let later = false;
    if (opts.at) {
      const t = new Date(opts.at);
      if (Number.isNaN(t.getTime())) throw new BadRequestException('at must be a date and time.');
      if (t.getTime() > Date.now() + 60_000) {
        at = t;
        later = true;
      }
      if (t.getTime() > Date.now() + 31 * 86_400_000) throw new BadRequestException('Pick a time within the next month.');
    }
    const machines = await this.machines();
    const byId = new Map(machines.map((m) => [m.agentId, m]));
    const batchId = randomUUID();
    const created: OsUpdateRun[] = [];
    const skipped: { agentId: string; name: string; reason: string }[] = [];
    const names = await this.scheduleNames();
    for (const id of [...new Set(agentIds)].slice(0, 200)) {
      const m = byId.get(id);
      if (!m) {
        skipped.push({ agentId: id, name: id, reason: 'Not found.' });
        continue;
      }
      const why = this.cannotRun(m, kind, later);
      if (why) {
        skipped.push({ agentId: id, name: m.name, reason: why });
        continue;
      }
      const run = await this.prisma.agentUpdateRun.create({
        data: {
          agentId: id,
          kind,
          trigger: 'manual',
          batchId,
          scope: opts.scope,
          reboot: opts.reboot,
          snapshot: kind === 'install' && opts.snapshot && !!m.proxmoxGuest,
          status: 'scheduled',
          scheduledFor: at,
          windowEnd: new Date(at.getTime() + (later ? LATER_WINDOW_MS : NOW_WINDOW_MS)),
          requestedBy: user?.email ?? null,
          pendingBefore: kind === 'install' ? (opts.scope === 'security' ? m.security : m.total) : null,
        },
        include: { agent: { select: { name: true } } },
      });
      created.push(this.toRun(run, names));
    }
    if (created.length) {
      await this.audit.record({
        actorId: user?.id ?? null,
        actorEmail: user?.email ?? null,
        action: kind === 'install' ? 'updates.install_requested' : 'updates.reboot_requested',
        target: created.map((r) => r.agentName).join(', ').slice(0, 300),
        meta: { runs: created.map((r) => r.id), scope: opts.scope, reboot: opts.reboot, snapshot: opts.snapshot, at: later ? at.toISOString() : 'now' },
      });
      if (!later) void this.dispatch();
    }
    return { runs: created, skipped };
  }

  /** Why a machine can't take this command now (null = it can). */
  private cannotRun(m: OsUpdateMachine, kind: 'install' | 'reboot', later: boolean): string | null {
    if (m.agentTooOld) return `Agent ${m.agentVersion} is too old; it updates itself to 0.7 on its next connect.`;
    if (m.mode !== 'on') return `Installs are turned off on this machine (CEREBRO_OS_UPDATES=${m.mode}).`;
    if (kind === 'install' && m.checkedAt && !m.supported) return m.error ?? 'Updates aren\'t supported on this machine.';
    if (!later && !m.online) return 'The machine is offline.';
    return null;
  }

  async cancel(id: string, user: SessionUser | undefined): Promise<OsUpdateRun> {
    const r = await this.prisma.agentUpdateRun.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Run not found.');
    if (r.status !== 'scheduled') throw new BadRequestException('Only a run that hasn\'t started can be cancelled.');
    await this.prisma.agentUpdateRun.update({ where: { id }, data: { status: 'cancelled', finishedAt: new Date(), message: `Cancelled by ${user?.email ?? 'an operator'}.` } });
    await this.audit.record({ actorId: user?.id ?? null, actorEmail: user?.email ?? null, action: 'updates.run_cancelled', target: id });
    return this.run(id);
  }

  // ── Dispatch loop ─────────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_30_SECONDS)
  async tick(): Promise<void> {
    await this.fireSchedules().catch((e) => this.logger.warn(`Update schedules: ${e instanceof Error ? e.message : e}`));
    await this.dispatch();
    await this.reapStuck().catch(() => undefined);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async hourly(): Promise<void> {
    await this.securityAlerts().catch((e) => this.logger.warn(`Security update alerts: ${e instanceof Error ? e.message : e}`));
    // Keep a year of run history.
    await this.prisma.agentUpdateRun.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 366 * 86_400_000) } } }).catch(() => undefined);
  }

  /** Start every due run whose machine is free; mark missed ones. */
  async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const now = new Date();
      const due = await this.prisma.agentUpdateRun.findMany({
        where: { status: 'scheduled', scheduledFor: { lte: now } },
        orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
        include: { agent: { select: { name: true } } },
      });
      if (!due.length) return;
      const active = await this.prisma.agentUpdateRun.findMany({
        where: { status: { in: ['snapshot', 'sent', 'running'] } },
        select: { agentId: true },
      });
      const busy = new Set(active.map((a) => a.agentId));
      let machines: Map<string, OsUpdateMachine> | null = null;
      for (const run of due) {
        if (this.busyRuns.has(run.id)) continue;
        if (run.windowEnd && run.windowEnd < now) {
          await this.finish(run, 'missed', this.registry.isOnline(run.agentId) ? 'Another update run on this machine was still going when the window closed.' : 'The machine was offline for the whole window.');
          continue;
        }
        if (busy.has(run.agentId) || !this.registry.isOnline(run.agentId)) continue;
        // Later rings wait for earlier ones in the same window.
        if (run.batchId && run.ring && run.ring > 0) {
          const gate = await this.ringGate(run);
          if (gate === 'wait') continue;
          if (gate) {
            await this.finish(run, 'cancelled', gate);
            continue;
          }
        }
        machines ??= new Map((await this.machines()).map((m) => [m.agentId, m]));
        const m = machines.get(run.agentId);
        if (!m) continue;
        const why = this.cannotRun(m, run.kind === 'reboot' ? 'reboot' : 'install', false);
        if (why) {
          await this.finish(run, 'failed', why);
          continue;
        }
        busy.add(run.agentId);
        this.busyRuns.add(run.id);
        void this.start(run, m).finally(() => this.busyRuns.delete(run.id));
      }
    } catch (e) {
      this.logger.warn(`Update dispatch failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.dispatching = false;
    }
  }

  /** null = go; 'wait' = earlier ring still going; any other string = skip with that reason. */
  private async ringGate(run: AgentUpdateRun): Promise<string | 'wait' | null> {
    const earlier = await this.prisma.agentUpdateRun.findMany({ where: { batchId: run.batchId, ring: { lt: run.ring! } }, select: { status: true, ring: true } });
    if (earlier.some((e) => OS_UPDATE_RUN_ACTIVE.includes(e.status as OsUpdateRunStatus))) return 'wait';
    const sched = run.scheduleId ? await this.prisma.updateSchedule.findUnique({ where: { id: run.scheduleId }, select: { stopOnFailure: true } }) : null;
    if (sched?.stopOnFailure !== false) {
      const bad = earlier.find((e) => ['failed', 'refused', 'unknown'].includes(e.status));
      if (bad) return `Skipped: ring ${(bad.ring ?? 0) + 1} had a failure, so later rings were held back.`;
    }
    return null;
  }

  private async start(run: RunWithAgent, m: OsUpdateMachine): Promise<void> {
    try {
      let note: string | null = null;
      let snapName: string | null = null;
      if (run.kind === 'install' && run.snapshot) {
        if (!m.proxmoxGuest) {
          note = 'No snapshot: this machine isn\'t matched to a Proxmox VM or container.';
        } else {
          await this.prisma.agentUpdateRun.update({ where: { id: run.id }, data: { status: 'snapshot', startedAt: new Date() } });
          try {
            snapName = await this.takeSnapshot(m.proxmoxGuest, run.id);
            note = `Snapshot "${snapName}" taken on ${m.proxmoxGuest.instanceName} (${m.proxmoxGuest.kind === 'lxc' ? 'CT' : 'VM'} ${m.proxmoxGuest.vmid}).`;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await this.finish(run, 'failed', `The Proxmox snapshot failed, so nothing was installed: ${msg}`, { snapshotNote: msg });
            return;
          }
        }
      }
      const fresh = await this.prisma.agentUpdateRun.findUnique({ where: { id: run.id }, select: { status: true } });
      if (!fresh || (fresh.status !== 'scheduled' && fresh.status !== 'snapshot')) return; // cancelled meanwhile
      await this.prisma.agentUpdateRun.update({
        where: { id: run.id },
        data: { status: 'sent', startedAt: run.startedAt ?? new Date(), snapshotName: snapName, snapshotNote: note },
      });
      const res =
        run.kind === 'reboot'
          ? await this.registry.sendUpdatesCommand(run.agentId, { runId: run.id, action: 'reboot' })
          : await this.registry.sendUpdatesCommand(run.agentId, {
              runId: run.id,
              action: 'install',
              scope: isScope(run.scope) ? run.scope : 'security',
              reboot: isReboot(run.reboot) ? run.reboot : 'never',
            });
      this.logger.log(`Sent ${run.kind} (${run.id}) to ${run.agent.name}${res.signed ? ' (signed)' : ''}`);
    } catch (e) {
      await this.finish(run, 'failed', `Couldn't send the command: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async finish(run: RunWithAgent | AgentUpdateRun, status: OsUpdateRunStatus, message: string, extra: Partial<Prisma.AgentUpdateRunUpdateInput> = {}): Promise<void> {
    const updated = await this.prisma.agentUpdateRun.update({
      where: { id: run.id },
      data: { status, message, finishedAt: new Date(), ...extra },
      include: { agent: { select: { name: true } } },
    });
    await this.notifyRun(updated);
  }

  /** Commands nobody answered, installs that went silent. */
  private async reapStuck(): Promise<void> {
    const now = Date.now();
    const stuck = await this.prisma.agentUpdateRun.findMany({
      where: {
        OR: [
          { status: 'sent', startedAt: { lt: new Date(now - SENT_TIMEOUT_MS) } },
          { status: 'running', startedAt: { lt: new Date(now - RUNNING_TIMEOUT_MS) } },
        ],
      },
      include: { agent: { select: { name: true } } },
    });
    for (const r of stuck) {
      // A restart's machine goes away by design; it counts as done once it's back.
      if (r.kind === 'reboot') {
        await this.finish(r, 'unknown', 'The machine never confirmed the restart.');
        continue;
      }
      await this.finish(r, r.status === 'sent' ? 'unknown' : 'failed', r.status === 'sent' ? 'The machine never acknowledged the command (it may have gone offline).' : 'The install stopped reporting progress.');
    }
  }

  // ── Proxmox ───────────────────────────────────────────────────────────────

  /** NIC MAC → Proxmox guest, across every Proxmox connector. */
  private async guestsByMac(): Promise<Map<string, OsUpdateProxmoxGuest>> {
    if (this.guestCache && Date.now() - this.guestCache.at < GUEST_CACHE_MS) return this.guestCache.byMac;
    const byMac = new Map<string, OsUpdateProxmoxGuest>();
    const insts = await this.prisma.connectorInstance.findMany({ where: { connectorId: 'proxmox', enabled: true }, select: { id: true, name: true } });
    for (const inst of insts) {
      for (const kind of ['qemu', 'lxc'] as const) {
        try {
          const list = await this.instances.listResourcesCached(inst.id, kind, { maxAgeMs: GUEST_CACHE_MS });
          for (const r of list.resources) {
            const mac = typeof r.details?.mac === 'string' ? r.details.mac.toLowerCase() : null;
            const vmid = Number(r.details?.vmid ?? r.id);
            if (mac && Number.isFinite(vmid) && !byMac.has(mac)) byMac.set(mac, { instanceId: inst.id, instanceName: inst.name, vmid, kind, name: r.name });
          }
        } catch {
          /* connector unreachable: those guests just aren't matched */
        }
      }
    }
    this.guestCache = { at: Date.now(), byMac };
    return byMac;
  }

  private async takeSnapshot(g: OsUpdateProxmoxGuest, runId: string): Promise<string> {
    const name = snapshotName(new Date());
    const res = await this.instances.runResourceOperationAwait(g.instanceId, 'snapshot-create', String(g.vmid), {
      kind: g.kind,
      snapname: name,
      description: `Taken by Cerebro before installing updates (run ${runId}).`,
    });
    if (!res.ok) throw new Error(res.message || 'Proxmox refused the snapshot.');
    // Keep only the newest few Cerebro snapshots so they don't pile up on the storage.
    try {
      const subs = await this.instances.listSubResources(g.instanceId, g.kind, String(g.vmid), 'snapshot');
      const ours = (subs as Array<{ id?: string; name?: string }>)
        .map((s) => String(s.name ?? s.id ?? ''))
        .filter((n) => n.startsWith(SNAPSHOT_PREFIX))
        .sort();
      for (const old of ours.slice(0, Math.max(0, ours.length - SNAPSHOTS_KEPT))) {
        await this.instances.runResourceOperationAwait(g.instanceId, 'snapshot-delete', String(g.vmid), { kind: g.kind, snapshot: old }).catch(() => undefined);
      }
    } catch {
      /* pruning is best-effort */
    }
    return name;
  }

  // ── Schedules ─────────────────────────────────────────────────────────────

  private toSchedule(s: UpdateSchedule): OsUpdateSchedule {
    const rings = (Array.isArray(s.rings) ? (s.rings as unknown as OsUpdateRing[]) : []).map((r) => ({ agentIds: r.agentIds ?? [], delayHours: r.delayHours ?? 0 }));
    return {
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      days: s.days,
      hour: s.hour,
      minute: s.minute,
      windowHours: s.windowHours,
      scope: isScope(s.scope) ? s.scope : 'security',
      reboot: isReboot(s.reboot) ? s.reboot : 'if-needed',
      snapshot: s.snapshot,
      rings,
      stopOnFailure: s.stopOnFailure,
      lastFiredAt: s.lastFiredAt?.toISOString() ?? null,
      nextRunAt: nextWindowStart(s)?.toISOString() ?? null,
      description: describeTiming(s),
    };
  }

  async listSchedules(): Promise<OsUpdateSchedule[]> {
    const rows = await this.prisma.updateSchedule.findMany({ orderBy: { name: 'asc' } });
    return rows.map((r) => this.toSchedule(r));
  }

  async createSchedule(body: unknown, user: SessionUser | undefined): Promise<OsUpdateSchedule> {
    const v = sanitizeSchedule(body);
    if (!v.ok) throw new BadRequestException(v.error);
    const row = await this.prisma.updateSchedule.create({ data: { ...v.value, rings: v.value.rings as unknown as Prisma.InputJsonValue } });
    await this.audit.record({ actorId: user?.id ?? null, actorEmail: user?.email ?? null, action: 'updates.schedule_created', target: row.name, meta: { id: row.id } });
    return this.toSchedule(row);
  }

  async updateSchedule(id: string, body: unknown, user: SessionUser | undefined): Promise<OsUpdateSchedule> {
    const prev = await this.prisma.updateSchedule.findUnique({ where: { id } });
    if (!prev) throw new NotFoundException('Schedule not found.');
    const v = sanitizeSchedule({ ...this.toSchedule(prev), ...(body as object) });
    if (!v.ok) throw new BadRequestException(v.error);
    const row = await this.prisma.updateSchedule.update({ where: { id }, data: { ...v.value, rings: v.value.rings as unknown as Prisma.InputJsonValue } });
    await this.audit.record({ actorId: user?.id ?? null, actorEmail: user?.email ?? null, action: 'updates.schedule_updated', target: row.name, meta: { id } });
    return this.toSchedule(row);
  }

  async deleteSchedule(id: string, user: SessionUser | undefined): Promise<{ ok: true }> {
    const prev = await this.prisma.updateSchedule.findUnique({ where: { id } });
    if (!prev) throw new NotFoundException('Schedule not found.');
    await this.prisma.agentUpdateRun.updateMany({ where: { scheduleId: id, status: 'scheduled' }, data: { status: 'cancelled', finishedAt: new Date(), message: 'The schedule was deleted.' } });
    await this.prisma.updateSchedule.delete({ where: { id } });
    await this.audit.record({ actorId: user?.id ?? null, actorEmail: user?.email ?? null, action: 'updates.schedule_deleted', target: prev.name });
    return { ok: true };
  }

  /** Open a schedule's window now (the "Run now" button), as if it were its start time. */
  async runScheduleNow(id: string, user: SessionUser | undefined): Promise<{ runs: number }> {
    const s = await this.prisma.updateSchedule.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Schedule not found.');
    const n = await this.openWindow(s, new Date());
    await this.audit.record({ actorId: user?.id ?? null, actorEmail: user?.email ?? null, action: 'updates.schedule_run_now', target: s.name, meta: { runs: n } });
    void this.dispatch();
    return { runs: n };
  }

  private async fireSchedules(): Promise<void> {
    const now = new Date();
    const rows = await this.prisma.updateSchedule.findMany({ where: { enabled: true } });
    for (const s of rows) {
      if (!isWindowStart(s, now)) continue;
      if (s.lastFiredAt && now.getTime() - s.lastFiredAt.getTime() < 120_000) continue;
      await this.openWindow(s, now);
    }
  }

  /** Create this window's runs, one per machine, each ring at its own start. */
  private async openWindow(s: UpdateSchedule, now: Date): Promise<number> {
    const start = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    await this.prisma.updateSchedule.update({ where: { id: s.id }, data: { lastFiredAt: start } });
    const sched = this.toSchedule(s);
    const batchId = randomUUID();
    const known = new Set((await this.prisma.agent.findMany({ where: { status: { notIn: ['pending', 'revoked', 'deleting'] } }, select: { id: true } })).map((a) => a.id));
    let n = 0;
    for (const [ring, r] of sched.rings.entries()) {
      const at = new Date(start.getTime() + r.delayHours * 3_600_000);
      for (const agentId of r.agentIds) {
        if (!known.has(agentId)) continue;
        // One open run per machine: skip if something is already queued or going.
        const open = await this.prisma.agentUpdateRun.count({ where: { agentId, status: { in: OS_UPDATE_RUN_ACTIVE } } });
        if (open) continue;
        await this.prisma.agentUpdateRun.create({
          data: {
            agentId,
            kind: 'install',
            trigger: 'schedule',
            scheduleId: s.id,
            batchId,
            ring,
            scope: sched.scope,
            reboot: sched.reboot,
            snapshot: sched.snapshot,
            status: 'scheduled',
            scheduledFor: at,
            windowEnd: new Date(at.getTime() + s.windowHours * 3_600_000),
            requestedBy: `Schedule: ${s.name}`,
          },
        });
        n += 1;
      }
    }
    this.logger.log(`Update schedule "${s.name}" opened: ${n} run(s) queued`);
    return n;
  }

  // ── Alerts ────────────────────────────────────────────────────────────────

  /** Once per machine and episode: security updates waiting longer than the grace period on a server. */
  private async securityAlerts(): Promise<void> {
    const machines = await this.machines();
    const cutoff = Date.now() - OS_UPDATE_SECURITY_GRACE_DAYS * 86_400_000;
    let changed = false;
    const seen = new Set<string>();
    for (const m of machines) {
      if (!m.securitySince || m.security <= 0) continue;
      seen.add(m.agentId);
      if (m.role !== 'server' || new Date(m.securitySince).getTime() > cutoff) continue;
      if (this.alertState[m.agentId] === m.securitySince) continue;
      this.alertState[m.agentId] = m.securitySince;
      changed = true;
      const days = Math.floor((Date.now() - new Date(m.securitySince).getTime()) / 86_400_000);
      await this.notifications
        .dispatchAlert('updates.security_waiting', {
          title: `${m.name}: ${m.security} security update${m.security === 1 ? '' : 's'} waiting ${days} days`,
          body: `${m.name} has had security updates waiting since ${new Date(m.securitySince).toDateString()}. Install them from Health → Updates or add the machine to an update schedule.`,
          dedupeKey: `updates:security:${m.agentId}:${m.securitySince}`,
        })
        .catch(() => undefined);
    }
    for (const k of Object.keys(this.alertState)) {
      if (!seen.has(k)) {
        delete this.alertState[k];
        changed = true;
      }
    }
    if (changed) await this.settings.set(ALERT_STATE_KEY, this.alertState).catch(() => undefined);
  }
}
