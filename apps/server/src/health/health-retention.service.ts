import { Injectable } from '@nestjs/common';
import { Cron, CronExpression, Timeout } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';

/** Raw samples are kept this long (rollups are rebuilt from them). */
export const HEALTH_RAW_HOURS = 48;
/** 5-minute rollups: 14 days. Hourly rollups: ~13 months. */
export const HEALTH_5M_DAYS = 14;
export const HEALTH_1H_DAYS = 400;
/** Each run recomputes buckets this far back, so a reconnecting agent's backlog lands in its buckets. */
const RECOMPUTE_HOURS = 3;

/**
 * Health rollups + retention (docs/health-monitoring.md). Every 5 minutes it
 * recomputes the 5-minute and hourly buckets of the last few hours from the raw
 * samples (idempotent upsert, including the current partial bucket so charts and
 * online time are at most a few minutes behind), then prunes old rows.
 */
@Injectable()
export class HealthRetentionService {
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logging: LoggingService,
  ) {}

  @Timeout(60_000)
  async onBoot(): Promise<void> {
    // After a long outage of Cerebro itself, rebuild everything still in raw.
    await this.run(HEALTH_RAW_HOURS);
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    await this.run(RECOMPUTE_HOURS);
  }

  async run(hours: number): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      const since = new Date(Math.floor((now - hours * 3_600_000) / 3_600_000) * 3_600_000);
      await this.rollup('5m', '5 minutes', since);
      await this.rollup('1h', '1 hour', since);
      const raw = await this.prisma.agentHealthSample.deleteMany({ where: { at: { lt: new Date(now - HEALTH_RAW_HOURS * 3_600_000) } } });
      const r5 = await this.prisma.agentHealthRollup.deleteMany({ where: { res: '5m', bucket: { lt: new Date(now - HEALTH_5M_DAYS * 86_400_000) } } });
      const r1 = await this.prisma.agentHealthRollup.deleteMany({ where: { res: '1h', bucket: { lt: new Date(now - HEALTH_1H_DAYS * 86_400_000) } } });
      if (raw.count + r5.count + r1.count > 0) {
        void this.logging.debug('health', `Retention: pruned ${raw.count} sample(s), ${r5.count + r1.count} rollup(s).`);
      }
    } catch (err) {
      void this.logging.error('health', `Health rollup failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.running = false;
    }
  }

  private async rollup(res: '5m' | '1h', width: string, since: Date): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "AgentHealthRollup" ("agentId", "res", "bucket", "samples", "onlineSec",
        "cpuAvg", "cpuMax", "memAvg", "memMax", "swapMax", "diskMax",
        "netRxAvg", "netTxAvg", "readAvg", "writeAvg", "disks")
      SELECT "agentId", ${res}, b,
             count(*)::int,
             LEAST(sum("spanSec"), extract(epoch from ${width}::interval))::int,
             avg("cpuPct"), max(COALESCE("cpuMaxPct", "cpuPct")),
             avg("memPct"), max("memPct"), max("swapPct"), max("diskPct"),
             avg("netRxBps"), avg("netTxBps"), avg("diskReadBps"), avg("diskWriteBps"),
             (array_agg("disks" ORDER BY "at" DESC) FILTER (WHERE "disks" IS NOT NULL))[1]
      FROM (
        SELECT *, date_bin(${width}::interval, "at", TIMESTAMP '2000-01-01') AS b
        FROM "AgentHealthSample" WHERE "at" >= ${since}
      ) s
      GROUP BY "agentId", b
      ON CONFLICT ("agentId", "res", "bucket") DO UPDATE SET
        "samples" = EXCLUDED."samples", "onlineSec" = EXCLUDED."onlineSec",
        "cpuAvg" = EXCLUDED."cpuAvg", "cpuMax" = EXCLUDED."cpuMax",
        "memAvg" = EXCLUDED."memAvg", "memMax" = EXCLUDED."memMax",
        "swapMax" = EXCLUDED."swapMax", "diskMax" = EXCLUDED."diskMax",
        "netRxAvg" = EXCLUDED."netRxAvg", "netTxAvg" = EXCLUDED."netTxAvg",
        "readAvg" = EXCLUDED."readAvg", "writeAvg" = EXCLUDED."writeAvg",
        "disks" = EXCLUDED."disks"
    `);
  }
}
