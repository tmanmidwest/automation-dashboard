import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { ConnectorInstance } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LoggingService } from '../../logging/logging.service';
import { AuditService } from '../../logging/audit.service';
import { SettingsService } from '../../settings/settings.service';
import { ConnectorInstanceService } from '../connector-instance.service';
import { NpmApi, NpmAuditEntry } from './npm-api';

const CONNECTOR_ID = 'nginx-proxy-manager';
/** Guard against an unbounded /api/audit-log on a long-lived NPM: only the newest N per poll. */
const MAX_PER_POLL = 200;

/**
 * Phase 3.5: mirrors each Nginx Proxy Manager instance's own audit log into the
 * unified Ship's Log timeline. Polls `GET /api/audit-log` on a schedule and
 * records entries newer than a per-instance high-watermark through AuditService
 * (which persists to AuditLog and publishes to the live timeline bus). The first
 * sight of an instance seeds the watermark silently — we don't backfill history.
 * See docs/connectors/nginx-proxy-manager.md.
 */
@Injectable()
export class NpmAuditPollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: ConnectorInstanceService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly logging: LoggingService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    let rows: ConnectorInstance[];
    try {
      rows = await this.prisma.connectorInstance.findMany({
        where: { connectorId: CONNECTOR_ID, enabled: true },
      });
    } catch (err) {
      void this.logging.error('npm:audit', `Could not load NPM instances: ${msg(err)}`);
      return;
    }
    await Promise.allSettled(rows.map((r) => this.pollOne(r)));
  }

  private watermarkKey(instanceId: string): string {
    return `npm.audit.${instanceId}.lastId`;
  }

  private async pollOne(instance: ConnectorInstance): Promise<void> {
    try {
      const ctx = await this.instances.contextFor(instance);
      const api = new NpmApi({
        baseUrl: String(ctx.config.baseUrl ?? ''),
        identity: String(ctx.config.identity ?? ''),
        secret: String(ctx.config.secret ?? ''),
        insecureSkipVerify: !!ctx.config.insecureSkipVerify,
      });

      const entries = (await api.auditLog())
        .filter((e) => typeof e.id === 'number')
        .sort((a, b) => b.id - a.id)
        .slice(0, MAX_PER_POLL);
      if (entries.length === 0) return;

      const maxId = entries[0].id;
      const key = this.watermarkKey(instance.id);
      const last = await this.settings.get<number>(key);

      // First sight: adopt the current position without replaying history.
      if (last == null) {
        await this.settings.set(key, maxId);
        void this.logging.info('npm:audit', `[${instance.name}] audit feed initialized at #${maxId}.`);
        return;
      }

      const fresh = entries.filter((e) => e.id > last).sort((a, b) => a.id - b.id);
      for (const e of fresh) {
        await this.audit.record({
          actorEmail: e.user?.email ?? e.user?.name ?? e.user?.nickname ?? null,
          action: npmAction(e),
          target: npmTarget(e),
          meta: {
            connectorId: instance.id, // → TimelineEvent.source, so it lands on this connector's log
            npmAuditId: e.id,
            objectType: e.object_type ?? null,
            npmAction: e.action ?? null,
          },
        });
      }

      if (fresh.length > 0) {
        await this.settings.set(key, Math.max(last, maxId));
        void this.logging.info('npm:audit', `[${instance.name}] recorded ${fresh.length} audit event(s).`);
      }
    } catch (err) {
      // Reachability/credential problems are already surfaced by the connection monitor.
      void this.logging.debug('npm:audit', `[${instance.name}] audit poll skipped: ${msg(err)}`);
    }
  }
}

/** "proxy-host" + "created" → "NPM proxy host created" (drives the timeline title). */
function npmAction(e: NpmAuditEntry): string {
  const object = (e.object_type ?? 'object').replace(/-/g, ' ');
  const verb = e.action ?? 'changed';
  return `NPM ${object} ${verb}`;
}

/** Best identifying label for the affected object, from the entry's meta. */
function npmTarget(e: NpmAuditEntry): string | null {
  const m = e.meta ?? {};
  const domains = m.domain_names;
  if (Array.isArray(domains) && domains.length) return domains.join(', ');
  const named = m.nice_name ?? m.name ?? m.email;
  if (typeof named === 'string' && named) return named;
  return e.object_id ? `#${e.object_id}` : null;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
