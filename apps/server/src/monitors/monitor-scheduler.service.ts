import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { Monitor } from '@prisma/client';
import type { MonitorStatus } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ProbeRegistry } from './probe-registry.service';
import { withDeadline, type ProbeResult } from './probes/probe';

const TICK_MS = 5000;
const CACHE_TTL_MS = 60_000;

/**
 * Runs the checks. One 5-second tick walks the enabled monitors, and any that
 * are due (per-monitor interval, or the retry interval while pending) get
 * probed concurrently. Kuma semantics: a failure first moves the monitor to
 * "pending" and retries up to `retries` times before it flips to "down".
 *
 * State survives restarts because the last status is on the Monitor row; the
 * in-memory maps only hold scheduling bookkeeping.
 */
@Injectable()
export class MonitorSchedulerService {
  private cache: Monitor[] = [];
  private cacheAt = 0;
  private dirty = true;
  private firstLoad = true;
  /** monitorId → epoch ms of the next due check. */
  private readonly nextDue = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  /** Retries remaining before a failing monitor is declared down. */
  private readonly retriesLeft = new Map<string, number>();
  /** Consecutive down beats (drives "resend every N"). */
  private readonly downCount = new Map<string, number>();
  /** monitorId → cert validTo already alerted on (so each cert alerts once). */
  private readonly certAlerted = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly probes: ProbeRegistry,
    private readonly notifications: NotificationsService,
    private readonly logging: LoggingService,
  ) {}

  /** Monitors changed (created/updated/enabled/deleted) — reload on the next tick and check `id` promptly. */
  invalidate(id?: string): void {
    this.dirty = true;
    if (id) {
      this.nextDue.set(id, 0);
      this.retriesLeft.delete(id);
      this.downCount.delete(id);
    }
  }

  @Interval(TICK_MS)
  async tick(): Promise<void> {
    await this.refresh();
    const now = Date.now();
    const due: Monitor[] = [];
    for (const m of this.cache) {
      if (!m.enabled) continue;
      let at = this.nextDue.get(m.id);
      if (at === undefined) {
        // Spread the initial burst after boot across the first interval (max 30 s).
        at = now + (this.firstLoad ? Math.random() * Math.min(m.intervalSec, 30) * 1000 : 0);
        this.nextDue.set(m.id, at);
      }
      if (now >= at && !this.inFlight.has(m.id)) due.push(m);
    }
    this.firstLoad = false;
    await Promise.allSettled(due.map((m) => this.check(m)));
  }

  private async refresh(): Promise<void> {
    if (!this.dirty && Date.now() - this.cacheAt < CACHE_TTL_MS) return;
    try {
      this.cache = await this.prisma.monitor.findMany();
      this.cacheAt = Date.now();
      this.dirty = false;
      const live = new Set(this.cache.map((m) => m.id));
      for (const id of [...this.nextDue.keys()]) {
        if (!live.has(id)) {
          this.nextDue.delete(id);
          this.retriesLeft.delete(id);
          this.downCount.delete(id);
          this.certAlerted.delete(id);
        }
      }
    } catch (err) {
      void this.logging.error('monitors', `Could not load monitors: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Run one check immediately (the "Check now" button). Returns the probe outcome. */
  async checkNow(id: string): Promise<ProbeResult | null> {
    this.dirty = true;
    await this.refresh();
    const m = this.cache.find((x) => x.id === id);
    if (!m || !m.enabled) return null;
    if (this.inFlight.has(id)) return { ok: false, message: 'A check is already running.' };
    return this.check(m);
  }

  private async check(m: Monitor): Promise<ProbeResult> {
    this.inFlight.add(m.id);
    try {
      const probe = this.probes.get(m.type);
      const config = (m.config ?? {}) as Record<string, unknown>;
      const timeoutMs = Math.max(1, m.timeoutSec) * 1000;
      const result: ProbeResult = probe
        ? await withDeadline(
            probe.run(config, timeoutMs).catch((err) => ({ ok: false, message: err instanceof Error ? err.message : 'Probe failed' })),
            timeoutMs + 2000,
            () => ({ ok: false, message: 'Timed out' }),
          )
        : { ok: false, message: `Unknown probe type "${m.type}"` };

      const ok = m.upsideDown ? !result.ok : result.ok;
      const prev = m.status as MonitorStatus;
      let status: MonitorStatus;
      if (ok) {
        status = 'up';
        this.retriesLeft.set(m.id, m.retries);
      } else {
        const left = this.retriesLeft.get(m.id) ?? m.retries;
        if (prev !== 'down' && left > 0) {
          status = 'pending';
          this.retriesLeft.set(m.id, left - 1);
        } else {
          status = 'down';
        }
      }
      const now = new Date();
      const important = status !== prev;
      const message = (m.upsideDown && !result.ok ? `Unreachable (expected): ${result.message}` : result.message).slice(0, 500);
      const certExpiresAt = result.cert ? new Date(result.cert.validTo) : m.type === 'http' ? m.certExpiresAt : null;

      await this.prisma.$transaction([
        this.prisma.monitorHeartbeat.create({
          data: { monitorId: m.id, status, latencyMs: result.latencyMs ?? null, message, important, at: now },
        }),
        this.prisma.monitor.update({
          where: { id: m.id },
          data: {
            status,
            lastCheckAt: now,
            lastLatencyMs: result.latencyMs ?? null,
            lastMessage: message,
            certExpiresAt,
            ...(important ? { lastChangeAt: now } : {}),
          },
        }),
      ]);

      // Alerts look at the *previous* change time for "down for …", so raise before updating it.
      this.raiseAlerts(m, prev, status, message, result);

      // Keep the cached row current so the next tick sees the new status.
      m.status = status;
      m.lastCheckAt = now;
      m.lastLatencyMs = result.latencyMs ?? null;
      m.lastMessage = message;
      m.certExpiresAt = certExpiresAt;
      if (important) m.lastChangeAt = now;

      this.nextDue.set(m.id, Date.now() + (status === 'pending' ? m.retryIntervalSec : m.intervalSec) * 1000);
      return result;
    } catch (err) {
      void this.logging.error('monitors', `Check failed for "${m.name}": ${err instanceof Error ? err.message : err}`);
      this.nextDue.set(m.id, Date.now() + m.intervalSec * 1000);
      return { ok: false, message: 'Check failed' };
    } finally {
      this.inFlight.delete(m.id);
    }
  }

  private raiseAlerts(m: Monitor, prev: MonitorStatus, status: MonitorStatus, message: string, result: ProbeResult): void {
    const target = this.probes.get(m.type)?.describeTarget((m.config ?? {}) as Record<string, unknown>) ?? '';
    if (status === 'down') {
      const n = prev === 'down' ? (this.downCount.get(m.id) ?? 1) + 1 : 1;
      this.downCount.set(m.id, n);
      if (prev !== 'down') {
        void this.notifications.dispatchAlert('monitor.down', {
          title: `Monitor down: ${m.name}`,
          body: `${target}\n${message}`,
          dedupeKey: `monitor:${m.id}:down`,
          monitorId: m.id,
        });
      } else if (m.resendEveryN > 0 && n % m.resendEveryN === 0) {
        const since = m.lastChangeAt ? ` (down for ${duration(Date.now() - m.lastChangeAt.getTime())})` : '';
        void this.notifications.dispatchAlert('monitor.down', {
          title: `Still down: ${m.name}${since}`,
          body: `${target}\n${message}`,
          dedupeKey: `monitor:${m.id}:down:${n}`,
          monitorId: m.id,
        });
      }
    } else if (status === 'up' && prev === 'down') {
      this.downCount.delete(m.id);
      const downFor = m.lastChangeAt ? ` after ${duration(Date.now() - m.lastChangeAt.getTime())}` : '';
      void this.notifications.dispatchAlert('monitor.up', {
        title: `Monitor recovered: ${m.name}`,
        body: `${target}\n${message}\nBack up${downFor}.`,
        dedupeKey: `monitor:${m.id}:up`,
        monitorId: m.id,
      });
    }

    const warnDays = Number((m.config as Record<string, unknown>)?.certExpiryDays ?? 0);
    if (result.cert && warnDays > 0 && result.cert.daysLeft <= warnDays) {
      if (this.certAlerted.get(m.id) !== result.cert.validTo) {
        this.certAlerted.set(m.id, result.cert.validTo);
        const when = result.cert.daysLeft < 0 ? `expired ${-result.cert.daysLeft} day(s) ago` : `expires in ${result.cert.daysLeft} day(s)`;
        void this.notifications.dispatchAlert('monitor.cert_expiring', {
          title: `Certificate ${result.cert.daysLeft < 0 ? 'expired' : 'expiring'}: ${m.name}`,
          body: `${target}\nCertificate for ${result.cert.subject ?? target} ${when} (${new Date(result.cert.validTo).toUTCString()}).`,
          dedupeKey: `monitor:${m.id}:cert:${result.cert.validTo}`,
          monitorId: m.id,
        });
      }
    }
  }
}

/** "3m", "2h 5m", "1d 4h". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
