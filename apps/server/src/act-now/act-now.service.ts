import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ACT_NOW_TIERS,
  type ActNowItem,
  type ActNowList,
  type ActNowSourceStatus,
  type ActNowSummary,
  type ActNowTier,
  type OsUpdatePackage,
  type Permission,
  type SessionUser,
} from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { OsUpdatesService } from '../os-updates/os-updates.service';
import { TopologyService } from '../topology/topology.service';
import { describeSchedule, intervalMs, type BackupSchedule } from '../common/backup-schedule';
import {
  applySnoozes,
  backupItems,
  compareItems,
  exposedNodeIds,
  hiddenCounts,
  postureItems,
  updateItems,
  type BackupIn,
  type UpdateMachineIn,
} from './act-now.logic';

const CACHE_MS = 60_000;
/** While the posture build is still running, look again sooner. */
const PARTIAL_CACHE_MS = 5_000;
const DOCKER = 'docker';
const BACKBLAZE = 'backblaze';
/** The coverage sweep's grace before a new stack counts as unprotected (stack-backup-set.service.ts). */
const UNPROTECTED_GRACE_MS = 60 * 60 * 1000;
/** A stack the hourly sweep hasn't seen for this long is treated as gone. */
const PRESENT_MS = 3 * 86_400_000;
const MAX_SNOOZE_DAYS = 90;

type Perms = { updates: boolean; posture: boolean; backups: boolean };
type Built = Omit<ActNowList, 'items' | 'snoozed' | 'counts'> & { all: ActNowItem[]; postureSetAside: ActNowItem[]; partial: boolean };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Act Now (docs/act-now.md): one worst-first worklist read from what Cerebro already
 * keeps. Database rows and the cached posture build only: no SSH, no outside lookups.
 */
@Injectable()
export class ActNowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly osUpdates: OsUpdatesService,
    private readonly topology: TopologyService,
  ) {}

  private cache = new Map<string, { at: number; ttl: number; built: Promise<Built> }>();

  private perms(user: Pick<SessionUser, 'permissions'>): Perms {
    const has = (p: Permission) => user.permissions.includes(p);
    return { updates: has('fabric:read'), posture: has('connectors:read'), backups: has('backup:read') };
  }

  async list(user: Pick<SessionUser, 'permissions'>, opts: { fresh?: boolean } = {}): Promise<ActNowList> {
    const perms = this.perms(user);
    const built = await this.built(perms, !!opts.fresh);
    const states = await this.prisma.actNowState.findMany().catch(() => []);
    const now = new Date();
    const { open, snoozed } = applySnoozes(built.all, states, now);
    const counts = Object.fromEntries(ACT_NOW_TIERS.map((t) => [t, open.filter((i) => i.tier === t).length])) as Record<ActNowTier, number>;
    return {
      items: open.sort(compareItems),
      snoozed: [...snoozed, ...built.postureSetAside].sort(compareItems),
      sources: built.sources,
      hidden: built.hidden,
      counts,
      generatedAt: built.generatedAt,
    };
  }

  async summary(user: Pick<SessionUser, 'permissions'>): Promise<ActNowSummary> {
    const l = await this.list(user);
    return {
      total: l.items.length,
      counts: l.counts,
      overdue: l.items.filter((i) => i.overdue).length,
      top: l.items.slice(0, 3).map(({ key, tier, title, reason, source, overdue }) => ({ key, tier, title, reason, source, overdue })),
      generatedAt: l.generatedAt,
    };
  }

  /** Snooze an update or backup item. Posture items and stacks use their own pages' endpoints. */
  async snooze(user: SessionUser, key: string, days: number, note?: string): Promise<{ until: string }> {
    if (!Number.isInteger(days) || days < 1 || days > MAX_SNOOZE_DAYS) throw new BadRequestException(`Snooze for 1 to ${MAX_SNOOZE_DAYS} days.`);
    const item = (await this.list(user, { fresh: true })).items.find((i) => i.key === key);
    if (!item) throw new NotFoundException('That item is no longer on the list.');
    if (item.snooze.kind !== 'act-now') throw new BadRequestException('Snooze this item from its own page.');
    this.requirePerm(user, item.snooze.permission);
    const until = new Date(Date.now() + days * 86_400_000);
    const data = { until, note: note?.trim().slice(0, 1000) || null, setBy: user.displayName || user.email, setAt: new Date(), tier: item.tier, kevCves: item.kevCves };
    await this.prisma.actNowState.upsert({ where: { key }, create: { key, ...data }, update: data });
    return { until: until.toISOString() };
  }

  async unsnooze(user: SessionUser, key: string): Promise<{ ok: true }> {
    const perm = key.startsWith('update:') ? 'fabric:manage' : 'backup:write';
    this.requirePerm(user, perm);
    await this.prisma.actNowState.deleteMany({ where: { key } });
    return { ok: true };
  }

  private requirePerm(user: SessionUser, p: Permission) {
    if (!user.permissions.includes(p)) throw new ForbiddenException(`You need the ${p} permission to snooze this.`);
  }

  // ── Building ─────────────────────────────────────────────────────────────

  private built(perms: Perms, fresh: boolean): Promise<Built> {
    const key = `${+perms.updates}${+perms.posture}${+perms.backups}`;
    const hit = this.cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < hit.ttl) return hit.built;
    const built = this.build(perms);
    const entry = { at: Date.now(), ttl: CACHE_MS, built };
    this.cache.set(key, entry);
    built.then((b) => { if (b.partial) entry.ttl = PARTIAL_CACHE_MS; }, () => this.cache.delete(key));
    return built;
  }

  private async build(perms: Perms): Promise<Built> {
    const now = new Date();
    const sources: ActNowSourceStatus[] = [];
    const all: ActNowItem[] = [];
    const postureSetAside: ActNowItem[] = [];
    let lowerPriorityMachines = 0;
    let lowerSeverityFindings = 0;
    let baselineUnprotected = 0;

    // The posture build also says which machines are internet-facing, for the update tiers.
    const peek = perms.posture || perms.updates ? await this.topology.peek().catch(() => null) : null;
    const exposed = peek ? exposedNodeIds(peek.graph) : new Set<string>();

    const run = async (source: ActNowSourceStatus['source'], allowed: boolean, fn: () => Promise<string | null>) => {
      if (!allowed) return sources.push({ source, allowed: false, ok: true, asOf: null });
      try {
        sources.push({ source, allowed: true, ok: true, asOf: await fn() });
      } catch (err) {
        sources.push({ source, allowed: true, ok: false, message: msg(err), asOf: null });
      }
    };

    await run('updates', perms.updates, async () => {
      const machines = (await this.osUpdates.listMachines()).filter((m) => m.supported && !m.agentTooOld);
      const urgent = machines.filter((m) => m.priority === 'patch-now' || m.priority === 'critical' || (m.rebootRequired && (m.restartPriority === 'patch-now' || m.restartPriority === 'critical')));
      const pkgRows = urgent.length
        ? await this.prisma.agentUpdateStatus.findMany({ where: { agentId: { in: urgent.map((m) => m.agentId) } }, select: { agentId: true, packages: true } })
        : [];
      const pkgs = new Map(pkgRows.map((r) => [r.agentId, Array.isArray(r.packages) ? (r.packages as unknown as OsUpdatePackage[]) : []]));
      const agentNode = new Map<string, string>();
      for (const n of peek?.graph.nodes ?? []) for (const s of n.sources) if (s.connectorId === 'fabric' && s.resourceId) agentNode.set(s.resourceId, n.id);
      const input: UpdateMachineIn[] = machines.map((m) => {
        const node = agentNode.get(m.agentId);
        return {
          agentId: m.agentId, name: m.name, online: m.online, mode: m.mode, checkedAt: m.checkedAt,
          priority: m.priority, restartPriority: m.restartPriority, rebootRequired: m.rebootRequired, rebootReason: m.rebootReason,
          rebootSince: m.rebootSince, securitySince: m.securitySince, patchNowSince: m.patchNowSince, kevCves: m.kevCves, total: m.total,
          packages: pkgs.get(m.agentId) ?? [],
          exposed: !!node && exposed.has(node),
        };
      });
      const r = updateItems(input, now);
      all.push(...r.items);
      lowerPriorityMachines = r.lowerPriority;
      const checked = machines.map((m) => m.checkedAt).filter((x): x is string => !!x).sort();
      return checked.length ? checked[checked.length - 1] : null;
    });

    await run('posture', perms.posture, async () => {
      if (!peek) throw new Error('The security checks are still building. This list fills in within a minute or two.');
      const r = postureItems(peek.graph.findings ?? [], exposed, now);
      all.push(...r.items);
      postureSetAside.push(...r.setAside);
      lowerSeverityFindings = r.lowerSeverity;
      return peek.builtAt.toISOString();
    });

    await run('backups', perms.backups, async () => {
      const b = await this.backupInput(now);
      baselineUnprotected = b.baselineUnprotected;
      all.push(...backupItems(b, now));
      return now.toISOString();
    });

    // Without backup:read, vzdump findings from Posture still show (they come with connectors:read).
    return {
      all,
      postureSetAside,
      partial: (perms.posture || perms.updates) && !peek,
      sources,
      hidden: hiddenCounts({ lowerPriorityMachines, lowerSeverityFindings, baselineUnprotected }),
      generatedAt: now.toISOString(),
    };
  }

  private async backupInput(now: Date): Promise<BackupIn> {
    const [targets, policies, entries, instances] = await Promise.all([
      this.prisma.stackBackupTarget.findMany({ include: { _count: { select: { policies: true } } } }),
      this.prisma.stackBackupPolicy.findMany({ include: { target: { select: { name: true } } } }),
      this.prisma.stackCoverageEntry.findMany(),
      this.prisma.connectorInstance.findMany({ where: { connectorId: { in: [DOCKER, BACKBLAZE] }, enabled: true }, select: { id: true, name: true, connectorId: true } }),
    ]);
    const hostName = new Map(instances.map((i) => [i.id, i.name]));
    const entryOf = new Map(entries.map((e) => [`${e.connectorInstanceId}/${e.stackName}`, e]));

    // Last success and the current failure streak per policy, from the last 60 days of runs.
    const runs = policies.length
      ? await this.prisma.stackBackupRun.findMany({
        where: { policyId: { in: policies.map((p) => p.id) }, status: { in: ['success', 'error'] }, startedAt: { gte: new Date(now.getTime() - 60 * 86_400_000) } },
        orderBy: { startedAt: 'desc' },
        select: { policyId: true, status: true, startedAt: true },
      })
      : [];
    const runsBy = new Map<string, typeof runs>();
    for (const r of runs) if (r.policyId) runsBy.set(r.policyId, [...(runsBy.get(r.policyId) ?? []), r]);
    const olderSuccess = await this.prisma.stackBackupRun.groupBy({ by: ['policyId'], where: { status: 'success' }, _max: { startedAt: true } });
    const lastSuccessAll = new Map(olderSuccess.map((r) => [r.policyId, r._max.startedAt]));

    const policyIn = policies
      .filter((p) => hostName.has(p.connectorInstanceId))
      .map((p) => {
        const rs = runsBy.get(p.id) ?? [];
        let failures = 0;
        let failingSince: Date | null = null;
        for (const r of rs) {
          if (r.status !== 'error') break;
          failures += 1;
          failingSince = r.startedAt;
        }
        const schedule: BackupSchedule = { frequency: p.frequency as BackupSchedule['frequency'], dayOfWeek: p.dayOfWeek, dayOfMonth: p.dayOfMonth, hour: p.hour, minute: p.minute };
        const entry = entryOf.get(`${p.connectorInstanceId}/${p.stackName}`);
        return {
          id: p.id,
          stackName: p.stackName,
          hostName: hostName.get(p.connectorInstanceId)!,
          targetName: p.target.name,
          enabled: p.enabled,
          frequency: p.frequency,
          scheduleText: describeSchedule(schedule),
          intervalMs: p.frequency === 'off' ? 0 : intervalMs(schedule),
          lastStatus: p.lastStatus,
          lastMessage: p.lastMessage,
          createdAt: p.createdAt,
          lastSuccess: lastSuccessAll.get(p.id) ?? null,
          failures: Math.max(failures, p.lastStatus === 'error' ? 1 : 0),
          failingSince: failingSince ?? (p.lastStatus === 'error' ? p.lastRunAt : null),
          verifyStatus: p.verifyStatus,
          verifyMessage: p.verifyMessage,
          verifiedAt: p.verifiedAt,
          present: !entry || now.getTime() - entry.lastSeenAt.getTime() < PRESENT_MS,
        };
      });

    // New vs baseline: the first scan of a host stamps alertedAt = firstSeenAt on what it finds.
    const configured = new Set(policies.map((p) => `${p.connectorInstanceId}/${p.stackName}`));
    const unprotected: BackupIn['unprotected'] = [];
    let baselineUnprotected = 0;
    for (const e of entries) {
      if (e.ignored || configured.has(`${e.connectorInstanceId}/${e.stackName}`) || !hostName.has(e.connectorInstanceId)) continue;
      if (now.getTime() - e.lastSeenAt.getTime() >= PRESENT_MS) continue;
      const baseline = !!e.alertedAt && e.alertedAt.getTime() === e.firstSeenAt.getTime();
      if (baseline) baselineUnprotected += 1;
      else if (now.getTime() - e.firstSeenAt.getTime() >= UNPROTECTED_GRACE_MS)
        unprotected.push({ instanceId: e.connectorInstanceId, hostName: hostName.get(e.connectorInstanceId)!, stackName: e.stackName, firstSeenAt: e.firstSeenAt });
    }

    // Backblaze system backups: the latest scheduled or manual run on each connector.
    const b2 = instances.filter((i) => i.connectorId === BACKBLAZE);
    const system: BackupIn['system'] = [];
    for (const i of b2) {
      const [last, good] = await Promise.all([
        this.prisma.backupRun.findFirst({ where: { connectorInstanceId: i.id, trigger: { not: 'restore' }, status: { in: ['success', 'error'] } }, orderBy: { startedAt: 'desc' } }),
        this.prisma.backupRun.findFirst({ where: { connectorInstanceId: i.id, trigger: { not: 'restore' }, status: 'success' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
      ]);
      if (last) system.push({ instanceId: i.id, name: i.name, status: last.status, message: last.message, startedAt: last.startedAt, lastSuccess: good?.startedAt ?? null });
    }

    return {
      targets: targets.map((t) => ({
        id: t.id, name: t.name, lastStatus: t.lastStatus, lastMessage: t.lastMessage, lastCheckedAt: t.lastCheckedAt,
        integrityStatus: t.integrityStatus, integrityMessage: t.integrityMessage, integrityCheckedAt: t.integrityCheckedAt, stacks: t._count.policies,
      })),
      policies: policyIn,
      unprotected,
      baselineUnprotected,
      system,
    };
  }
}
