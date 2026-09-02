import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Monitor } from '@prisma/client';
import {
  MONITOR_MIN_INTERVAL_SEC,
  type MonitorChart,
  type MonitorChartPoint,
  type MonitorChartRange,
  type MonitorDetail,
  type MonitorHeartbeat,
  type MonitorImportResult,
  type MonitorInput,
  type MonitorStats,
  type MonitorStatus,
  type MonitorSummary,
} from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { ProbeRegistry } from './probe-registry.service';
import { MonitorSchedulerService } from './monitor-scheduler.service';
import { kumaToInputs } from './kuma-import';

const RECENT_BEATS = 50;
const AGG_CACHE_MS = 15_000;

interface Agg {
  up24: number;
  down24: number;
  avg24: number | null;
  up30: number;
  down30: number;
}

interface BeatRow {
  monitorId: string;
  status: string;
  latencyMs: number | null;
  message: string | null;
  important: boolean;
  at: Date;
}

/** Monitor CRUD plus the derived numbers (uptime, latency, heartbeat bar, chart, events). */
@Injectable()
export class MonitorsService {
  private aggCache: { at: number; data: Map<string, Agg> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly probes: ProbeRegistry,
    private readonly scheduler: MonitorSchedulerService,
    private readonly logging: LoggingService,
  ) {}

  // ── Read ──────────────────────────────────────────────────

  async list(): Promise<MonitorSummary[]> {
    const rows = await this.prisma.monitor.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    const agg = await this.aggregates();
    const beats = await this.recentBeats(rows.map((r) => r.id));
    return rows.map((r) => this.summary(r, agg.get(r.id), beats.get(r.id) ?? []));
  }

  async stats(): Promise<MonitorStats> {
    const rows = await this.prisma.monitor.groupBy({ by: ['status'], _count: { _all: true } });
    const s: MonitorStats = { total: 0, up: 0, down: 0, pending: 0, paused: 0 };
    for (const r of rows) {
      const n = r._count._all;
      s.total += n;
      if (r.status in s) s[r.status as keyof MonitorStats] += n;
    }
    return s;
  }

  async get(id: string): Promise<MonitorDetail> {
    const row = await this.find(id);
    const agg = await this.aggregates([id]);
    const beats = await this.recentBeats([id], 100);
    return {
      ...this.summary(row, agg.get(id), beats.get(id) ?? []),
      config: (row.config ?? {}) as Record<string, unknown>,
      retries: row.retries,
      retryIntervalSec: row.retryIntervalSec,
      timeoutSec: row.timeoutSec,
      resendEveryN: row.resendEveryN,
      upsideDown: row.upsideDown,
      description: row.description,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async events(id: string, limit = 100): Promise<MonitorHeartbeat[]> {
    await this.find(id);
    const rows = await this.prisma.monitorHeartbeat.findMany({
      where: { monitorId: id, important: true },
      orderBy: { at: 'desc' },
      take: Math.min(limit, 500),
    });
    return rows.map(toBeat);
  }

  async chart(id: string, range: MonitorChartRange): Promise<MonitorChart> {
    await this.find(id);
    const now = Date.now();
    let points: MonitorChartPoint[];
    if (range === '30d') {
      const since = new Date(now - 30 * 86_400_000);
      const rows = await this.prisma.monitorRollup.findMany({
        where: { monitorId: id, bucket: { gte: since } },
        orderBy: { bucket: 'asc' },
      });
      points = rows.map((r) => ({
        at: r.bucket.toISOString(),
        latencyMs: r.avgLatencyMs,
        status: r.down > 0 ? 'down' : r.up > 0 ? 'up' : 'pending',
      }));
    } else {
      const spec = {
        '1h': { ms: 3_600_000, bin: null as string | null },
        '24h': { ms: 86_400_000, bin: '5 minutes' },
        '7d': { ms: 7 * 86_400_000, bin: '30 minutes' },
      }[range];
      if (!spec) throw new BadRequestException('Unknown range');
      const since = new Date(now - spec.ms);
      if (!spec.bin) {
        const rows = await this.prisma.monitorHeartbeat.findMany({
          where: { monitorId: id, at: { gte: since } },
          orderBy: { at: 'asc' },
          select: { at: true, latencyMs: true, status: true },
        });
        points = rows.map((r) => ({
          at: r.at.toISOString(),
          latencyMs: r.status === 'up' ? r.latencyMs : null,
          status: r.status as MonitorStatus,
        }));
      } else {
        const rows = await this.prisma.$queryRaw<{ bucket: Date; latency: number | null; anydown: boolean; anypending: boolean }[]>(Prisma.sql`
          SELECT date_bin(${spec.bin}::interval, "at", TIMESTAMP '2000-01-01') AS bucket,
                 (avg("latencyMs") FILTER (WHERE status = 'up'))::int AS latency,
                 bool_or(status = 'down') AS anydown,
                 bool_or(status = 'pending') AS anypending
          FROM "MonitorHeartbeat"
          WHERE "monitorId" = ${id} AND "at" >= ${since}
          GROUP BY 1 ORDER BY 1
        `);
        points = rows.map((r) => ({
          at: r.bucket.toISOString(),
          latencyMs: r.latency,
          status: r.anydown ? 'down' : r.anypending ? 'pending' : 'up',
        }));
      }
    }
    return { range, points };
  }

  // ── Write ─────────────────────────────────────────────────

  async create(input: MonitorInput): Promise<MonitorDetail> {
    const data = this.normalize(input);
    const row = await this.prisma.monitor.create({ data: { ...data, status: data.enabled ? 'pending' : 'paused' } });
    this.scheduler.invalidate(row.id);
    await this.logging.info('monitors', `Monitor created: ${row.name} (${row.type})`);
    return this.get(row.id);
  }

  async update(id: string, input: MonitorInput): Promise<MonitorDetail> {
    const existing = await this.find(id);
    const data = this.normalize(input);
    const enabledChanged = data.enabled !== existing.enabled;
    const row = await this.prisma.monitor.update({
      where: { id },
      data: { ...data, ...(enabledChanged ? { status: data.enabled ? 'pending' : 'paused' } : {}) },
    });
    this.scheduler.invalidate(id);
    await this.logging.info('monitors', `Monitor updated: ${row.name}`);
    return this.get(row.id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<MonitorDetail> {
    const existing = await this.find(id);
    if (existing.enabled !== enabled) {
      await this.prisma.monitor.update({
        where: { id },
        data: { enabled, status: enabled ? 'pending' : 'paused', lastChangeAt: new Date() },
      });
      this.scheduler.invalidate(id);
      await this.logging.info('monitors', `Monitor ${enabled ? 'resumed' : 'paused'}: ${existing.name}`);
    }
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.find(id);
    await this.prisma.monitor.delete({ where: { id } });
    this.scheduler.invalidate();
    await this.logging.info('monitors', `Monitor deleted: ${existing.name}`);
  }

  async checkNow(id: string): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
    await this.find(id);
    const r = await this.scheduler.checkNow(id);
    if (!r) return { ok: false, message: 'Monitor is paused.' };
    return { ok: r.ok, message: r.message, latencyMs: r.latencyMs };
  }

  /** Import monitors from an Uptime Kuma backup JSON export. */
  async importKuma(payload: unknown): Promise<MonitorImportResult> {
    let parsed: ReturnType<typeof kumaToInputs>;
    try {
      parsed = kumaToInputs(payload);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'Invalid backup');
    }
    const { inputs, skipped } = parsed;
    let imported = 0;
    for (const input of inputs) {
      try {
        await this.create(input);
        imported++;
      } catch (err) {
        skipped.push({ name: input.name, reason: err instanceof Error ? err.message : 'Invalid monitor' });
      }
    }
    await this.logging.info('monitors', `Kuma import: ${imported} imported, ${skipped.length} skipped.`);
    return { imported, skipped };
  }

  // ── Internals ─────────────────────────────────────────────

  private async find(id: string): Promise<Monitor> {
    const row = await this.prisma.monitor.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Monitor not found');
    return row;
  }

  /** Validate + coerce an input into row data. Throws BadRequest on problems. */
  private normalize(input: MonitorInput) {
    const probe = this.probes.get(input.type);
    if (!probe) throw new BadRequestException(`Unknown monitor type "${input.type}"`);
    const name = (input.name ?? '').trim();
    if (!name) throw new BadRequestException('Name is required.');
    const config: Record<string, unknown> = {};
    for (const f of probe.manifest.fields) {
      const v = input.config?.[f.key];
      if (v === undefined || v === null || v === '') {
        if (f.default !== undefined) config[f.key] = f.default;
        continue;
      }
      config[f.key] = f.type === 'number' ? Number(v) : f.type === 'boolean' ? v === true || v === 'true' : String(v);
    }
    const problem = probe.validate(config);
    if (problem) throw new BadRequestException(problem);
    const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
    };
    return {
      name,
      type: input.type,
      config: config as Prisma.InputJsonValue,
      enabled: input.enabled ?? true,
      intervalSec: clampInt(input.intervalSec, MONITOR_MIN_INTERVAL_SEC, 86_400, 60),
      retryIntervalSec: clampInt(input.retryIntervalSec, MONITOR_MIN_INTERVAL_SEC, 86_400, 60),
      timeoutSec: clampInt(input.timeoutSec, 1, 300, 10),
      retries: clampInt(input.retries, 0, 10, 1),
      resendEveryN: clampInt(input.resendEveryN, 0, 1000, 0),
      upsideDown: !!input.upsideDown,
      description: (input.description ?? '').trim() || null,
      tags: [...new Set((input.tags ?? []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 20),
    };
  }

  private summary(r: Monitor, agg: Agg | undefined, beats: MonitorHeartbeat[]): MonitorSummary {
    const probe = this.probes.get(r.type);
    const ratio = (up: number, down: number) => (up + down > 0 ? up / (up + down) : null);
    const certDaysLeft = r.certExpiresAt ? Math.floor((r.certExpiresAt.getTime() - Date.now()) / 86_400_000) : null;
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      typeLabel: probe?.manifest.label ?? r.type,
      target: probe?.describeTarget((r.config ?? {}) as Record<string, unknown>) ?? '',
      enabled: r.enabled,
      intervalSec: r.intervalSec,
      tags: r.tags,
      status: r.status as MonitorStatus,
      lastChangeAt: r.lastChangeAt?.toISOString() ?? null,
      lastCheckAt: r.lastCheckAt?.toISOString() ?? null,
      lastLatencyMs: r.lastLatencyMs,
      lastMessage: r.lastMessage,
      certExpiresAt: r.certExpiresAt?.toISOString() ?? null,
      certDaysLeft,
      uptime24h: agg ? ratio(agg.up24, agg.down24) : null,
      uptime30d: agg ? ratio(agg.up30, agg.down30) : null,
      avgLatency24hMs: agg?.avg24 ?? null,
      recentBeats: beats,
    };
  }

  /** Uptime/latency aggregates (all monitors, cached briefly since the list polls; or a fresh subset). */
  private async aggregates(ids?: string[]): Promise<Map<string, Agg>> {
    if (!ids && this.aggCache && Date.now() - this.aggCache.at < AGG_CACHE_MS) return this.aggCache.data;
    const now = Date.now();
    const since24 = new Date(now - 86_400_000);
    const since30 = new Date(now - 30 * 86_400_000);
    const hourStart = new Date(Math.floor(now / 3_600_000) * 3_600_000);
    const filter = ids ? Prisma.sql`AND "monitorId" IN (${Prisma.join(ids)})` : Prisma.empty;

    const raw24 = await this.prisma.$queryRaw<{ monitorId: string; up: number; down: number; avg: number | null }[]>(Prisma.sql`
      SELECT "monitorId",
             (count(*) FILTER (WHERE status = 'up'))::int AS up,
             (count(*) FILTER (WHERE status = 'down'))::int AS down,
             (avg("latencyMs") FILTER (WHERE status = 'up'))::int AS avg
      FROM "MonitorHeartbeat" WHERE "at" >= ${since24} ${filter} GROUP BY "monitorId"
    `);
    const roll30 = await this.prisma.$queryRaw<{ monitorId: string; up: number; down: number }[]>(Prisma.sql`
      SELECT "monitorId", sum(up)::int AS up, sum(down)::int AS down
      FROM "MonitorRollup" WHERE bucket >= ${since30} ${filter} GROUP BY "monitorId"
    `);
    const rawHour = await this.prisma.$queryRaw<{ monitorId: string; up: number; down: number }[]>(Prisma.sql`
      SELECT "monitorId",
             (count(*) FILTER (WHERE status = 'up'))::int AS up,
             (count(*) FILTER (WHERE status = 'down'))::int AS down
      FROM "MonitorHeartbeat" WHERE "at" >= ${hourStart} ${filter} GROUP BY "monitorId"
    `);

    const map = new Map<string, Agg>();
    const ensure = (id: string) => {
      let a = map.get(id);
      if (!a) map.set(id, (a = { up24: 0, down24: 0, avg24: null, up30: 0, down30: 0 }));
      return a;
    };
    for (const r of raw24) Object.assign(ensure(r.monitorId), { up24: r.up, down24: r.down, avg24: r.avg });
    for (const r of roll30) { const a = ensure(r.monitorId); a.up30 += r.up; a.down30 += r.down; }
    for (const r of rawHour) { const a = ensure(r.monitorId); a.up30 += r.up; a.down30 += r.down; }
    if (!ids) this.aggCache = { at: now, data: map };
    return map;
  }

  /** Last N beats per monitor (oldest → newest) via a LATERAL join so each monitor hits the index once. */
  private async recentBeats(ids: string[], n = RECENT_BEATS): Promise<Map<string, MonitorHeartbeat[]>> {
    const map = new Map<string, MonitorHeartbeat[]>();
    if (ids.length === 0) return map;
    const rows = await this.prisma.$queryRaw<BeatRow[]>(Prisma.sql`
      SELECT b."monitorId", b.status, b."latencyMs", b.message, b.important, b."at"
      FROM "Monitor" m
      CROSS JOIN LATERAL (
        SELECT * FROM "MonitorHeartbeat" h WHERE h."monitorId" = m.id ORDER BY h."at" DESC LIMIT ${n}
      ) b
      WHERE m.id IN (${Prisma.join(ids)})
      ORDER BY b."at" ASC
    `);
    for (const r of rows) {
      let arr = map.get(r.monitorId);
      if (!arr) map.set(r.monitorId, (arr = []));
      arr.push(toBeat(r));
    }
    return map;
  }
}

function toBeat(r: { status: string; latencyMs: number | null; message: string | null; important: boolean; at: Date }): MonitorHeartbeat {
  return { status: r.status as MonitorStatus, latencyMs: r.latencyMs, message: r.message, important: r.important, at: r.at.toISOString() };
}
