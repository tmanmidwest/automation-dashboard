import { Injectable } from '@nestjs/common';
import { Cron, CronExpression, Timeout } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { LoggingService } from '../logging/logging.service';

export const DEFAULT_RAW_DAYS = 7;
export const DEFAULT_ROLLUP_DAYS = 365;

/**
 * Heartbeat retention. Raw beats are kept for `monitors.retention.rawDays`
 * (default 7); hourly rollups are (re)computed from them every hour and kept
 * for `monitors.retention.rollupDays` (default 365). Rollups feed the 30-day
 * uptime and long-range charts, so pruning raw data never loses uptime history.
 */
@Injectable()
export class MonitorRetentionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly logging: LoggingService,
  ) {}

  async rawDays(): Promise<number> {
    return (await this.settings.get<number>('monitors.retention.rawDays')) ?? DEFAULT_RAW_DAYS;
  }

  async rollupDays(): Promise<number> {
    return (await this.settings.get<number>('monitors.retention.rollupDays')) ?? DEFAULT_ROLLUP_DAYS;
  }

  /** Also run shortly after boot so a fresh deploy has rollups without waiting an hour. */
  @Timeout(90_000)
  async onBoot(): Promise<void> {
    await this.run();
  }

  @Cron(CronExpression.EVERY_HOUR)
  async run(): Promise<void> {
    try {
      const rawDays = await this.rawDays();
      const rollupDays = await this.rollupDays();
      const now = new Date();
      const rawSince = new Date(now.getTime() - rawDays * 86_400_000);
      const hourStart = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);

      // Recompute every completed hour still inside the raw window (idempotent upsert).
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO "MonitorRollup" ("monitorId", "bucket", "total", "up", "down", "avgLatencyMs", "minLatencyMs", "maxLatencyMs")
        SELECT "monitorId",
               date_trunc('hour', "at") AS bucket,
               count(*)::int,
               (count(*) FILTER (WHERE status = 'up'))::int,
               (count(*) FILTER (WHERE status = 'down'))::int,
               (avg("latencyMs") FILTER (WHERE status = 'up'))::int,
               (min("latencyMs") FILTER (WHERE status = 'up'))::int,
               (max("latencyMs") FILTER (WHERE status = 'up'))::int
        FROM "MonitorHeartbeat"
        WHERE "at" >= ${rawSince} AND "at" < ${hourStart}
        GROUP BY "monitorId", date_trunc('hour', "at")
        ON CONFLICT ("monitorId", "bucket") DO UPDATE SET
          "total" = EXCLUDED."total", "up" = EXCLUDED."up", "down" = EXCLUDED."down",
          "avgLatencyMs" = EXCLUDED."avgLatencyMs", "minLatencyMs" = EXCLUDED."minLatencyMs", "maxLatencyMs" = EXCLUDED."maxLatencyMs"
      `);

      const beats = await this.prisma.monitorHeartbeat.deleteMany({ where: { at: { lt: rawSince } } });
      const rollups = await this.prisma.monitorRollup.deleteMany({
        where: { bucket: { lt: new Date(now.getTime() - rollupDays * 86_400_000) } },
      });
      if (beats.count || rollups.count) {
        await this.logging.debug('monitors', `Retention: pruned ${beats.count} heartbeat(s), ${rollups.count} rollup(s).`);
      }
    } catch (err) {
      await this.logging.error('monitors', `Retention run failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
