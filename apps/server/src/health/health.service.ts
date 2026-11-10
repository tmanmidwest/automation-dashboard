import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DEFAULT_HEALTH_INTERVAL_SEC,
  DEFAULT_HEALTH_THRESHOLDS,
  type FabricHealthFrame,
  type HealthFleet,
  type HealthInventory,
  type HealthMachine,
  type HealthRange,
  type HealthRole,
  type HealthSample,
  type HealthSeries,
  type HealthSeriesPoint,
  type HealthSettings,
  type HealthStatus,
  type HealthThresholds,
} from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { AgentRegistryService } from '../fabric/agent-registry.service';
import {
  assess,
  availability,
  detectRole,
  normalizeRole,
  sanitizeInventory,
  sanitizeSample,
  worstDiskPct,
  type Assessment,
  type RecentPoint,
} from './health-assess';

const SETTINGS_KEY = 'health.settings';
/** Samples older than this (a very long offline backlog) are dropped on ingest. */
const MAX_BACKLOG_MS = 24 * 3_600_000;
/** Most samples accepted from one frame. */
const MAX_SAMPLES_PER_FRAME = 500;

const STATUS_ORDER: Record<HealthStatus, number> = { critical: 0, warning: 1, unknown: 2, ok: 3, offline: 4 };

function hourStart(t: number): Date {
  return new Date(Math.floor(t / 3_600_000) * 3_600_000);
}

type AgentWithHealth = Prisma.AgentGetPayload<{ include: { health: true } }>;

/**
 * Health monitoring (docs/health-monitoring.md): ingests the agent's `health`
 * frames, keeps the latest snapshot + raw samples, and serves the Health page
 * (fleet list, machine detail, chart series, availability).
 */
@Injectable()
export class HealthService implements OnModuleInit {
  private settingsCache: HealthSettings = {
    intervalSec: DEFAULT_HEALTH_INTERVAL_SEC,
    thresholds: { ...DEFAULT_HEALTH_THRESHOLDS },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly registry: AgentRegistryService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadSettings().catch(() => undefined);
    this.registry.setHealthHooks({
      ingest: (agentId, frame) => this.ingest(agentId, frame),
      intervalMs: () => this.settingsCache.intervalSec * 1000,
      quietOffline: async (agentId) => (await this.roleOf(agentId)) === 'workstation',
    });
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  private async loadSettings(): Promise<void> {
    const saved = await this.settings.get<Partial<HealthSettings>>(SETTINGS_KEY);
    this.settingsCache = {
      intervalSec: typeof saved?.intervalSec === 'number' ? saved.intervalSec : DEFAULT_HEALTH_INTERVAL_SEC,
      thresholds: { ...DEFAULT_HEALTH_THRESHOLDS, ...(saved?.thresholds ?? {}) },
    };
  }

  getSettings(): HealthSettings {
    return { intervalSec: this.settingsCache.intervalSec, thresholds: { ...this.settingsCache.thresholds } };
  }

  async updateSettings(input: Partial<HealthSettings>): Promise<HealthSettings> {
    const next = this.getSettings();
    if (input.intervalSec !== undefined) {
      const v = Number(input.intervalSec);
      if (!Number.isInteger(v) || (v !== 0 && (v < 5 || v > 600))) {
        throw new BadRequestException('Reporting interval must be 0 (off) or 5–600 seconds.');
      }
      next.intervalSec = v;
    }
    if (input.thresholds) {
      const t = { ...next.thresholds };
      for (const k of Object.keys(DEFAULT_HEALTH_THRESHOLDS) as (keyof HealthThresholds)[]) {
        const raw = (input.thresholds as Partial<HealthThresholds>)[k];
        if (raw === undefined) continue;
        const v = Number(raw);
        const isPct = k.endsWith('Pct');
        if (!Number.isFinite(v) || v < 1 || (isPct ? v > 100 : v > 1440)) {
          throw new BadRequestException(`Invalid value for ${k}.`);
        }
        t[k] = v;
      }
      if (t.diskWarnPct > t.diskCritPct) throw new BadRequestException('Disk warning must be at or below disk critical.');
      if (t.memWarnPct > t.memCritPct) throw new BadRequestException('Memory warning must be at or below memory critical.');
      next.thresholds = t;
    }
    const intervalChanged = next.intervalSec !== this.settingsCache.intervalSec;
    await this.settings.set(SETTINGS_KEY, next);
    this.settingsCache = next;
    if (intervalChanged) this.registry.broadcastHealthInterval(next.intervalSec * 1000);
    return this.getSettings();
  }

  // ── Ingest ────────────────────────────────────────────────────────────────

  async ingest(agentId: string, frame: FabricHealthFrame): Promise<void> {
    const now = Date.now();
    const intervalSec = this.settingsCache.intervalSec || DEFAULT_HEALTH_INTERVAL_SEC;
    // One sample can't claim to cover more than ~2 intervals (or a minute), so a
    // long gap never inflates online time.
    const maxSpan = Math.max(intervalSec * 2, 60);
    const samples = (Array.isArray(frame.samples) ? frame.samples : [])
      .slice(-MAX_SAMPLES_PER_FRAME)
      .map(sanitizeSample)
      .filter((s): s is HealthSample => !!s)
      .map((s) => ({ ...s, at: s.at > now + 60_000 ? now : s.at, spanSec: Math.min(s.spanSec, maxSpan) }))
      .filter((s) => s.at >= now - MAX_BACKLOG_MS);
    const inventory = sanitizeInventory(frame.inventory);

    if (samples.length) {
      await this.prisma.agentHealthSample.createMany({
        skipDuplicates: true,
        data: samples.map((s) => ({
          agentId,
          at: new Date(s.at),
          spanSec: s.spanSec,
          cpuPct: s.cpuPct ?? null,
          cpuMaxPct: s.cpuMaxPct ?? null,
          memPct: s.memPct ?? null,
          swapPct: s.swapPct ?? null,
          diskPct: worstDiskPct(s),
          load1: s.load1 ?? null,
          netRxBps: s.netRxBps ?? null,
          netTxBps: s.netTxBps ?? null,
          diskReadBps: s.diskReadBps ?? null,
          diskWriteBps: s.diskWriteBps ?? null,
          disks: s.disks?.length ? Object.fromEntries(s.disks.map((d) => [d.mount, d.pct])) : Prisma.JsonNull,
        })),
      });
    }

    const latest = samples.reduce<HealthSample | null>((a, s) => (!a || s.at > a.at ? s : a), null);
    if (!latest && !inventory) return;
    const existing = await this.prisma.agentHealth.findUnique({ where: { agentId }, select: { at: true } });
    const useLatest = latest && (!existing || latest.at >= existing.at.getTime());
    const invData = inventory
      ? { inventory: inventory as unknown as Prisma.InputJsonValue, inventoryAt: new Date(), autoRole: detectRole(inventory) }
      : {};
    const sampleData = useLatest ? { at: new Date(latest.at), sample: latest as unknown as Prisma.InputJsonValue } : {};
    await this.prisma.agentHealth.upsert({
      where: { agentId },
      update: { ...sampleData, ...invData },
      // Inventory can arrive before the first sample: store an empty sample at epoch.
      create: { agentId, at: new Date(0), sample: {}, ...sampleData, ...invData },
    });
  }

  // ── Roles ─────────────────────────────────────────────────────────────────

  async roleOf(agentId: string): Promise<HealthRole> {
    const a = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { healthRole: true, os: true, health: { select: { autoRole: true, inventory: true } } },
    });
    if (!a) return 'server';
    return (
      normalizeRole(a.healthRole) ??
      normalizeRole(a.health?.autoRole) ??
      detectRole(a.health?.inventory as HealthInventory | null, a.os)
    );
  }

  async setRole(agentId: string, role: HealthRole | null): Promise<HealthMachine> {
    if (role !== null && !normalizeRole(role)) throw new BadRequestException('Role must be "server", "workstation" or null (auto).');
    const a = await this.prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } });
    if (!a) throw new NotFoundException('Machine not found');
    await this.prisma.agent.update({ where: { id: agentId }, data: { healthRole: role } });
    return this.machine(agentId);
  }

  refresh(agentId: string): { requested: boolean } {
    return { requested: this.registry.requestHealthNow(agentId) };
  }

  // ── Read side ─────────────────────────────────────────────────────────────

  async fleet(): Promise<HealthFleet> {
    const machines = await this.buildMachines();
    machines.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (a.score ?? 101) - (b.score ?? 101) || a.name.localeCompare(b.name));
    const totals = { machines: machines.length, ok: 0, warning: 0, critical: 0, offline: 0, unknown: 0 };
    for (const m of machines) totals[m.status]++;
    return { machines, totals, settings: this.getSettings() };
  }

  async machine(agentId: string): Promise<HealthMachine> {
    const [m] = await this.buildMachines(agentId);
    if (!m) throw new NotFoundException('Machine not found');
    return m;
  }

  /**
   * Current assessment for every reporting machine — used by the alert loop so it
   * evaluates exactly what the page shows.
   */
  async assessments(): Promise<Array<{ agentId: string; name: string; hostname: string | null; role: HealthRole; assessment: Assessment }>> {
    const ms = await this.buildMachines();
    return ms.map((m) => ({
      agentId: m.agentId,
      name: m.name,
      hostname: m.hostname ?? null,
      role: m.role,
      assessment: { status: m.status, score: m.score, issues: m.issues },
    }));
  }

  private async buildMachines(onlyAgentId?: string): Promise<HealthMachine[]> {
    const now = new Date();
    const t = this.settingsCache.thresholds;
    const agents: AgentWithHealth[] = await this.prisma.agent.findMany({
      where: { status: { notIn: ['pending', 'revoked', 'deleting'] }, ...(onlyAgentId ? { id: onlyAgentId } : {}) },
      include: { health: true },
      orderBy: { name: 'asc' },
    });
    if (!agents.length) return [];
    const ids = agents.map((a) => a.id);
    const idFilter = { agentId: { in: ids } };

    // Raw samples for the sustained checks — and at least the last 16 min, which also
    // fills the sparkline past the newest 5-minute rollup.
    const recentSince = new Date(now.getTime() - (Math.max(t.memMinutes, t.cpuMinutes, 15) + 1) * 60_000);
    const sparkCutoff = new Date(Math.floor((now.getTime() - 10 * 60_000) / 300_000) * 300_000);
    const daySince = new Date(now.getTime() - 86_400_000);
    const weekSince = hourStart(now.getTime() - 7 * 86_400_000);
    const monthSince = hourStart(now.getTime() - 30 * 86_400_000);
    // Hourly rollups are rebuilt every 5 min, so the current hour (and the first few
    // minutes after a new one starts) come from raw samples instead.
    const rollupCutoff = hourStart(now.getTime() - 10 * 60_000);

    const [recent, day, week, month, sinceCutoff, spark] = await Promise.all([
      this.prisma.agentHealthSample.findMany({
        where: { ...idFilter, at: { gte: recentSince } },
        select: { agentId: true, at: true, cpuPct: true, memPct: true },
        orderBy: { at: 'asc' },
      }),
      this.prisma.agentHealthSample.groupBy({ by: ['agentId'], where: { ...idFilter, at: { gte: daySince } }, _sum: { spanSec: true } }),
      this.prisma.agentHealthRollup.groupBy({ by: ['agentId'], where: { ...idFilter, res: '1h', bucket: { gte: weekSince, lt: rollupCutoff } }, _sum: { onlineSec: true } }),
      this.prisma.agentHealthRollup.groupBy({ by: ['agentId'], where: { ...idFilter, res: '1h', bucket: { gte: monthSince, lt: rollupCutoff } }, _sum: { onlineSec: true } }),
      this.prisma.agentHealthSample.groupBy({ by: ['agentId'], where: { ...idFilter, at: { gte: rollupCutoff } }, _sum: { spanSec: true } }),
      this.prisma.agentHealthRollup.findMany({
        where: { ...idFilter, res: '5m', bucket: { gte: daySince, lt: sparkCutoff } },
        select: { agentId: true, bucket: true, cpuAvg: true, memAvg: true },
        orderBy: { bucket: 'asc' },
      }),
    ]);

    const recentBy = new Map<string, RecentPoint[]>();
    for (const r of recent) {
      const arr = recentBy.get(r.agentId) ?? [];
      arr.push({ at: r.at, cpuPct: r.cpuPct, memPct: r.memPct });
      recentBy.set(r.agentId, arr);
    }
    const sum = (rows: Array<{ agentId: string; _sum: Record<string, number | null> }>) =>
      new Map(rows.map((r) => [r.agentId, Object.values(r._sum)[0] ?? 0]));
    const dayBy = sum(day as never);
    const weekBy = sum(week as never);
    const monthBy = sum(month as never);
    const recentOnlineBy = sum(sinceCutoff as never);
    const sparkBy = new Map<string, HealthMachine['spark']>();
    {
      // 30-minute bins over the last 24 h.
      const BIN = 30 * 60_000;
      const acc = new Map<string, Map<number, { c: number[]; m: number[] }>>();
      const rows = [
        ...spark,
        ...recent.filter((r) => r.at >= sparkCutoff).map((r) => ({ agentId: r.agentId, bucket: r.at, cpuAvg: r.cpuPct, memAvg: r.memPct })),
      ];
      for (const r of rows) {
        const k = Math.floor(r.bucket.getTime() / BIN) * BIN;
        const byBin = acc.get(r.agentId) ?? new Map();
        const b = byBin.get(k) ?? { c: [], m: [] };
        if (r.cpuAvg != null) b.c.push(r.cpuAvg);
        if (r.memAvg != null) b.m.push(r.memAvg);
        byBin.set(k, b);
        acc.set(r.agentId, byBin);
      }
      const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
      for (const [agentId, byBin] of acc) {
        sparkBy.set(
          agentId,
          [...byBin.entries()].sort((a, b) => a[0] - b[0]).map(([k, b]) => ({ at: new Date(k).toISOString(), cpu: avg(b.c), mem: avg(b.m) })),
        );
      }
    }

    return agents.map((a) => {
      const h = a.health;
      const inventory = (h?.inventory as HealthInventory | null) ?? null;
      const rawSample = h?.sample as HealthSample | Record<string, never> | undefined;
      const latest = rawSample && typeof (rawSample as HealthSample).at === 'number' ? (rawSample as HealthSample) : null;
      const latestAt = latest && h ? h.at : null;
      const override = normalizeRole(a.healthRole);
      const role = override ?? normalizeRole(h?.autoRole) ?? detectRole(inventory, a.os);
      const online = this.registry.statusOf(a.id, a.status) === 'online';
      const assessment = assess({
        role,
        online,
        lastSeenAt: a.lastSeenAt,
        latest,
        latestAt,
        recent: recentBy.get(a.id) ?? [],
        thresholds: t,
        intervalSec: this.settingsCache.intervalSec,
        agentVersion: a.agentVersion,
        now,
      });
      return {
        agentId: a.id,
        name: a.name,
        hostname: a.hostname,
        os: a.os,
        osVersion: a.osVersion,
        localIp: a.localIp,
        tags: a.tags,
        online,
        lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
        role,
        roleOverridden: !!override,
        status: assessment.status,
        score: assessment.score,
        issues: assessment.issues,
        latest,
        latestAt: latestAt?.toISOString() ?? null,
        inventory,
        agentVersion: a.agentVersion,
        spark: sparkBy.get(a.id) ?? [],
        availability: {
          day: availability(86_400, dayBy.get(a.id) ?? 0, now, a.createdAt),
          week: availability(7 * 86_400, (weekBy.get(a.id) ?? 0) + (recentOnlineBy.get(a.id) ?? 0), now, a.createdAt),
          month: availability(30 * 86_400, (monthBy.get(a.id) ?? 0) + (recentOnlineBy.get(a.id) ?? 0), now, a.createdAt),
        },
      };
    });
  }

  async series(agentId: string, range: HealthRange): Promise<HealthSeries> {
    const now = Date.now();
    const exists = await this.prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Machine not found');
    const r1 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 10) / 10);
    const r0 = (v: number | null | undefined) => (v == null ? null : Math.round(v));
    const disksOf = (v: Prisma.JsonValue | null) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : null);

    if (range === '1h') {
      const rows = await this.prisma.agentHealthSample.findMany({
        where: { agentId, at: { gte: new Date(now - 3_600_000) } },
        orderBy: { at: 'asc' },
      });
      return {
        range,
        resolution: 'raw',
        points: rows.map<HealthSeriesPoint>((r) => ({
          at: r.at.toISOString(),
          cpu: r1(r.cpuPct),
          cpuMax: r1(r.cpuMaxPct),
          mem: r1(r.memPct),
          swap: r1(r.swapPct),
          disk: r1(r.diskPct),
          netRx: r.netRxBps,
          netTx: r.netTxBps,
          read: r.diskReadBps,
          write: r.diskWriteBps,
          disks: disksOf(r.disks),
        })),
      };
    }
    const spec = range === '24h' ? { res: '5m', width: 300_000, ms: 86_400_000 } : range === '7d' ? { res: '1h', width: 3_600_000, ms: 7 * 86_400_000 } : { res: '1h', width: 3_600_000, ms: 30 * 86_400_000 };
    // Rollups are rebuilt every 5 min; the newest buckets are computed here from raw
    // samples so the chart is never behind (and a brand-new machine shows data at once).
    const cutoff = new Date(Math.floor((now - 10 * 60_000) / spec.width) * spec.width);
    const [rows, raw] = await Promise.all([
      this.prisma.agentHealthRollup.findMany({
        where: { agentId, res: spec.res, bucket: { gte: new Date(now - spec.ms), lt: cutoff } },
        orderBy: { bucket: 'asc' },
      }),
      this.prisma.agentHealthSample.findMany({ where: { agentId, at: { gte: cutoff } }, orderBy: { at: 'asc' } }),
    ]);
    const points = rows.map<HealthSeriesPoint>((r) => ({
      at: r.bucket.toISOString(),
      cpu: r1(r.cpuAvg),
      cpuMax: r1(r.cpuMax),
      mem: r1(r.memAvg),
      swap: r1(r.swapMax),
      disk: r1(r.diskMax),
      netRx: r0(r.netRxAvg),
      netTx: r0(r.netTxAvg),
      read: r0(r.readAvg),
      write: r0(r.writeAvg),
      disks: disksOf(r.disks),
    }));
    const bins = new Map<number, typeof raw>();
    for (const r of raw) {
      const k = Math.floor(r.at.getTime() / spec.width) * spec.width;
      const arr = bins.get(k) ?? [];
      arr.push(r);
      bins.set(k, arr);
    }
    const avg = (xs: (number | null)[]) => {
      const v = xs.filter((x): x is number => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const max = (xs: (number | null)[]) => {
      const v = xs.filter((x): x is number => x != null);
      return v.length ? Math.max(...v) : null;
    };
    for (const [k, b] of [...bins.entries()].sort((a, c) => a[0] - c[0])) {
      const lastDisks = [...b].reverse().find((r) => r.disks != null)?.disks ?? null;
      points.push({
        at: new Date(k).toISOString(),
        cpu: r1(avg(b.map((r) => r.cpuPct))),
        cpuMax: r1(max(b.map((r) => r.cpuMaxPct ?? r.cpuPct))),
        mem: r1(avg(b.map((r) => r.memPct))),
        swap: r1(max(b.map((r) => r.swapPct))),
        disk: r1(max(b.map((r) => r.diskPct))),
        netRx: r0(avg(b.map((r) => r.netRxBps))),
        netTx: r0(avg(b.map((r) => r.netTxBps))),
        read: r0(avg(b.map((r) => r.diskReadBps))),
        write: r0(avg(b.map((r) => r.diskWriteBps))),
        disks: disksOf(lastDisks),
      });
    }
    return { range, resolution: spec.res, points };
  }
}
