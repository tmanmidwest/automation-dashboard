import { Injectable } from '@nestjs/common';
import { severityRank } from '@cerebro/shared';
import type {
  AlertRule,
  AlertTypeDef,
  AlertView,
  NotificationChannelId,
  NotificationMessage,
  NotificationSeverity,
} from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { LoggingService } from '../logging/logging.service';
import { EmailChannel } from './channels/email.channel';
import { TextbeltChannel } from './channels/textbelt.channel';
import { SignalChannel } from './channels/signal.channel';
import { NotificationChannel } from './channels/notification-channel';
import { ALERT_TYPES, getAlertType } from './alerts/alert-registry';
import { METRIC_THRESHOLDS } from './alerts/metric-thresholds';

type RoutableChannelId = 'email' | 'textbelt' | 'signal';
const ROUTABLE_CHANNELS: RoutableChannelId[] = ['email', 'textbelt', 'signal'];
const CHANNEL_LABELS: Record<RoutableChannelId, string> = {
  email: 'Email',
  textbelt: 'SMS',
  signal: 'Signal',
};

const DEFAULT_THROTTLE_SEC = 300;
const DEFAULT_QUIET: QuietConfig = {
  enabled: false,
  start: '22:00',
  end: '07:00',
  floor: 'critical',
  channels: ['textbelt', 'signal'],
};

interface ChannelConfig {
  enabled: boolean;
  recipients: string[];
}

interface ChannelView {
  enabled: boolean;
  recipients: string;
}

/** Quiet-hours window (server time): during it, only alerts >= floor go to the listed channels. */
interface QuietConfig {
  enabled: boolean;
  start: string; // 'HH:MM'
  end: string; // 'HH:MM'
  floor: NotificationSeverity;
  channels: RoutableChannelId[];
}

/** Shape returned to the settings UI (recipients flattened to a string). */
export interface NotificationConfigView {
  email: ChannelView;
  textbelt: ChannelView & { endpoint: string; keySet: boolean };
  signal: ChannelView;
  throttleWindowSec: number;
  quiet: QuietConfig;
}

/** Shape accepted from the settings UI on save. */
export interface SaveNotificationConfig {
  email: ChannelView;
  textbelt: ChannelView & { endpoint?: string; key?: string };
  signal: ChannelView;
  throttleWindowSec: number;
  quiet: QuietConfig;
}

/** Minutes-since-midnight for 'HH:MM'. */
function hmToMinutes(s: string): number {
  const [h, m] = s.split(':').map((n) => parseInt(n, 10));
  return (h || 0) * 60 + (m || 0);
}

/** Is `now` (server-local) inside the [start,end) window, handling midnight wrap? */
function inQuietWindow(now: Date, start: string, end: string): boolean {
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = hmToMinutes(start);
  const e = hmToMinutes(end);
  if (s === e) return false; // empty window
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

/** One channel's availability, for the alert matrix UI. */
export interface ChannelInfo {
  id: RoutableChannelId;
  label: string;
  enabled: boolean;
  /** Has recipients (email/textbelt/signal) so it can actually deliver. */
  ready: boolean;
}

export interface AlertsView {
  channels: ChannelInfo[];
  alerts: AlertView[];
}

/** One row of a saved alert-matrix update. */
export interface SaveAlertRule {
  key: string;
  enabled: boolean;
  severity: NotificationSeverity;
  channels: NotificationChannelId[];
}

/** A connector-scoped alert with its global effective rule + this connector's mute state. */
export interface ConnectorAlertView {
  key: string;
  label: string;
  description: string;
  category: string;
  globalEnabled: boolean;
  globalSeverity: NotificationSeverity;
  globalChannels: NotificationChannelId[];
  muted: boolean;
}

/**
 * The notification dispatcher and alert engine.
 *
 * Features raise alerts by type: `dispatchAlert('backup.failure', …)`. Each
 * alert type (see alert-registry) carries defaults; the user overrides its
 * enabled flag, severity, and the set of channels it routes to (the matrix).
 * Per-channel failures are logged, never thrown — one broken channel must not
 * stop the others or the caller.
 */
@Injectable()
export class NotificationsService {
  private readonly channels: Record<RoutableChannelId, NotificationChannel>;
  /** In-memory dedupe: `${channelId}:${dedupeKey}` → epoch ms of last send. Cleared on restart. */
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly logging: LoggingService,
    email: EmailChannel,
    textbelt: TextbeltChannel,
    signal: SignalChannel,
  ) {
    this.channels = { email, textbelt, signal };
  }

  /** Append a delivery outcome to the history table. Best-effort; never throws. */
  private recordHistory(p: {
    channel: RoutableChannelId;
    status: 'sent' | 'failed' | 'held' | 'throttled';
    msg: NotificationMessage;
    alertKey?: string;
    connectorId?: string;
    recipients?: number;
    detail?: string;
  }): void {
    void this.prisma.notificationLog
      .create({
        data: {
          alertKey: p.alertKey ?? null,
          title: p.msg.title,
          severity: p.msg.severity ?? 'info',
          source: p.msg.source ?? null,
          channel: p.channel,
          status: p.status,
          recipients: p.recipients ?? 0,
          connectorId: p.connectorId ?? null,
          detail: p.detail ?? null,
        },
      })
      .catch(() => {
        /* history is best-effort */
      });
  }

  /** Recent notification delivery records, newest first (for the History view). */
  async getHistory(opts: { limit?: number; channel?: string; status?: string; before?: Date }) {
    const limit = Math.min(opts.limit ?? 100, 500);
    return this.prisma.notificationLog.findMany({
      where: {
        channel: opts.channel || undefined,
        status: opts.status || undefined,
        createdAt: opts.before ? { lt: opts.before } : undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  // ── Channel config ────────────────────────────────────────

  private parseRecipients(raw: string): string[] {
    return raw
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private async channelConfig(id: RoutableChannelId): Promise<ChannelConfig> {
    return {
      enabled: (await this.settings.get<boolean>(`notify.${id}.enabled`)) ?? false,
      recipients: (await this.settings.get<string[]>(`notify.${id}.recipients`)) ?? [],
    };
  }

  private view(cfg: ChannelConfig): ChannelView {
    return { enabled: cfg.enabled, recipients: cfg.recipients.join(', ') };
  }

  async getConfig(): Promise<NotificationConfigView> {
    const email = await this.channelConfig('email');
    const textbelt = await this.channelConfig('textbelt');
    const signal = await this.channelConfig('signal');
    return {
      email: this.view(email),
      textbelt: {
        ...this.view(textbelt),
        endpoint: (await this.settings.get<string>('notify.textbelt.endpoint')) ?? '',
        keySet: await this.settings.hasSecret('notify.textbelt.key'),
      },
      signal: this.view(signal),
      throttleWindowSec:
        (await this.settings.get<number>('notify.throttle.windowSec')) ?? DEFAULT_THROTTLE_SEC,
      quiet: await this.quietConfig(),
    };
  }

  private async quietConfig(): Promise<QuietConfig> {
    return {
      enabled: (await this.settings.get<boolean>('notify.quiet.enabled')) ?? DEFAULT_QUIET.enabled,
      start: (await this.settings.get<string>('notify.quiet.start')) ?? DEFAULT_QUIET.start,
      end: (await this.settings.get<string>('notify.quiet.end')) ?? DEFAULT_QUIET.end,
      floor:
        (await this.settings.get<NotificationSeverity>('notify.quiet.floor')) ?? DEFAULT_QUIET.floor,
      channels:
        (await this.settings.get<RoutableChannelId[]>('notify.quiet.channels')) ??
        DEFAULT_QUIET.channels,
    };
  }

  async saveConfig(cfg: SaveNotificationConfig): Promise<void> {
    await this.settings.set('notify.email.enabled', cfg.email.enabled);
    await this.settings.set('notify.email.recipients', this.parseRecipients(cfg.email.recipients));

    await this.settings.set('notify.textbelt.enabled', cfg.textbelt.enabled);
    await this.settings.set(
      'notify.textbelt.recipients',
      this.parseRecipients(cfg.textbelt.recipients),
    );
    await this.settings.set('notify.textbelt.endpoint', (cfg.textbelt.endpoint ?? '').trim());
    // Blank key keeps the stored one (matches the SMTP password UX).
    if (cfg.textbelt.key) await this.settings.setSecret('notify.textbelt.key', cfg.textbelt.key.trim());

    await this.settings.set('notify.signal.enabled', cfg.signal.enabled);
    await this.settings.set('notify.signal.recipients', this.parseRecipients(cfg.signal.recipients));

    await this.settings.set('notify.throttle.windowSec', Math.max(0, cfg.throttleWindowSec));

    await this.settings.set('notify.quiet.enabled', cfg.quiet.enabled);
    await this.settings.set('notify.quiet.start', cfg.quiet.start);
    await this.settings.set('notify.quiet.end', cfg.quiet.end);
    await this.settings.set('notify.quiet.floor', cfg.quiet.floor);
    await this.settings.set(
      'notify.quiet.channels',
      cfg.quiet.channels.filter((c): c is RoutableChannelId =>
        ROUTABLE_CHANNELS.includes(c as RoutableChannelId),
      ),
    );
  }

  // ── Alert catalog ─────────────────────────────────────────

  private async alertRule(def: AlertTypeDef): Promise<AlertRule> {
    return {
      enabled: (await this.settings.get<boolean>(`notify.alert.${def.key}.enabled`)) ?? def.defaultEnabled,
      severity:
        (await this.settings.get<NotificationSeverity>(`notify.alert.${def.key}.severity`)) ??
        def.defaultSeverity,
      channels:
        (await this.settings.get<NotificationChannelId[]>(`notify.alert.${def.key}.channels`)) ??
        def.defaultChannels,
    };
  }

  /** The full catalog with current rules + channel availability, for the settings UI. */
  async getAlerts(): Promise<AlertsView> {
    const alerts = await Promise.all(
      ALERT_TYPES.map(async (def) => ({ ...def, ...(await this.alertRule(def)) })),
    );
    const channels = await Promise.all(
      ROUTABLE_CHANNELS.map(async (id) => {
        const cfg = await this.channelConfig(id);
        return { id, label: CHANNEL_LABELS[id], enabled: cfg.enabled, ready: cfg.recipients.length > 0 };
      }),
    );
    return { channels, alerts };
  }

  async saveAlerts(rules: SaveAlertRule[]): Promise<void> {
    for (const r of rules) {
      if (!getAlertType(r.key)) continue; // ignore unknown keys
      await this.settings.set(`notify.alert.${r.key}.enabled`, r.enabled);
      await this.settings.set(`notify.alert.${r.key}.severity`, r.severity);
      await this.settings.set(
        `notify.alert.${r.key}.channels`,
        r.channels.filter((c): c is RoutableChannelId => ROUTABLE_CHANNELS.includes(c as RoutableChannelId)),
      );
    }
  }

  // ── Per-connector alert overrides (mute) ──────────────────

  private async mutedAlerts(connectorId: string): Promise<string[]> {
    return (await this.settings.get<string[]>(`notify.connector.${connectorId}.mutedAlerts`)) ?? [];
  }

  private thresholdKey(connectorId: string, defId: string): string {
    return `notify.connector.${connectorId}.threshold.${defId}`;
  }

  /** A per-connector metric threshold (0 = no alert). See metric-thresholds.ts. */
  async connectorThreshold(connectorId: string, defId: string): Promise<number> {
    const v = await this.settings.get<number>(this.thresholdKey(connectorId, defId));
    if (v !== undefined) return v;
    // Back-compat: cost used `costThreshold` before thresholds were generalized.
    if (defId === 'cost') {
      return (await this.settings.get<number>(`notify.connector.${connectorId}.costThreshold`)) ?? 0;
    }
    return 0;
  }

  /** Connector-scoped alerts with their global rule + mute state + metric thresholds. */
  async getConnectorAlerts(
    connectorId: string,
  ): Promise<{ alerts: ConnectorAlertView[]; thresholds: Record<string, number> }> {
    const muted = new Set(await this.mutedAlerts(connectorId));
    const alerts = await Promise.all(
      ALERT_TYPES.filter((t) => t.connectorScoped).map(async (def) => {
        const rule = await this.alertRule(def);
        return {
          key: def.key,
          label: def.label,
          description: def.description,
          category: def.category,
          globalEnabled: rule.enabled,
          globalSeverity: rule.severity,
          globalChannels: rule.channels,
          muted: muted.has(def.key),
        };
      }),
    );
    const thresholds: Record<string, number> = {};
    for (const t of METRIC_THRESHOLDS) thresholds[t.id] = await this.connectorThreshold(connectorId, t.id);
    return { alerts, thresholds };
  }

  async saveConnectorAlertConfig(
    connectorId: string,
    cfg: { muted: string[]; thresholds?: Record<string, number> },
  ): Promise<void> {
    const valid = cfg.muted.filter((k) => getAlertType(k)?.connectorScoped);
    await this.settings.set(`notify.connector.${connectorId}.mutedAlerts`, [...new Set(valid)]);
    if (cfg.thresholds) {
      for (const t of METRIC_THRESHOLDS) {
        const v = cfg.thresholds[t.id];
        if (v !== undefined) {
          await this.settings.set(this.thresholdKey(connectorId, t.id), Math.max(0, Number(v) || 0));
        }
      }
    }
  }

  // ── Dispatch ──────────────────────────────────────────────

  /**
   * Raise an alert by type. Looks up the type's rule (enabled / severity /
   * channels), and if enabled, delivers to each configured channel. Never
   * throws — safe to call fire-and-forget from anywhere.
   */
  async dispatchAlert(
    typeKey: string,
    payload: { title: string; body: string; dedupeKey?: string; connectorId?: string },
  ): Promise<void> {
    const def = getAlertType(typeKey);
    if (!def) {
      await this.logging.warn('notify', `Unknown alert type "${typeKey}" — not sent.`);
      return;
    }
    const rule = await this.alertRule(def);
    if (!rule.enabled) return;
    // Per-connector mute: this connector opted out of this alert.
    if (payload.connectorId && def.connectorScoped) {
      const muted = await this.mutedAlerts(payload.connectorId);
      if (muted.includes(typeKey)) {
        await this.logging.debug(
          'notify',
          `Alert "${typeKey}" muted for connector ${payload.connectorId}`,
        );
        return;
      }
    }
    const msg: NotificationMessage = {
      title: payload.title,
      body: payload.body,
      severity: rule.severity,
      source: def.category,
      dedupeKey: payload.dedupeKey ?? typeKey,
    };
    await this.sendToChannels(msg, rule.channels, { alertKey: def.key, connectorId: payload.connectorId });
  }

  /** Deliver a message to the given channels, applying enablement, quiet hours + throttling. */
  private async sendToChannels(
    msg: NotificationMessage,
    channelIds: NotificationChannelId[],
    meta: { alertKey?: string; connectorId?: string } = {},
  ): Promise<void> {
    const windowSec =
      (await this.settings.get<number>('notify.throttle.windowSec')) ?? DEFAULT_THROTTLE_SEC;
    const quiet = await this.quietConfig();
    const quietNow = quiet.enabled && inQuietWindow(new Date(), quiet.start, quiet.end);
    const severity = msg.severity ?? 'info';

    for (const id of channelIds) {
      if (!ROUTABLE_CHANNELS.includes(id as RoutableChannelId)) continue;
      const channelId = id as RoutableChannelId;
      const cfg = await this.channelConfig(channelId);
      if (!cfg.enabled || cfg.recipients.length === 0) continue;
      // Quiet hours: on opted-in channels, hold anything below the floor severity.
      if (
        quietNow &&
        quiet.channels.includes(channelId) &&
        severityRank(severity) < severityRank(quiet.floor)
      ) {
        await this.logging.debug(
          'notify',
          `Quiet hours: held ${channelId} for "${msg.title}" (${severity})`,
        );
        this.recordHistory({ channel: channelId, status: 'held', msg, ...meta, recipients: cfg.recipients.length, detail: 'Held by quiet hours' });
        continue;
      }
      if (this.isThrottled(channelId, msg, windowSec)) {
        await this.logging.debug('notify', `Throttled ${channelId} for "${msg.title}"`);
        this.recordHistory({ channel: channelId, status: 'throttled', msg, ...meta, recipients: cfg.recipients.length, detail: 'Suppressed by dedupe window' });
        continue;
      }
      try {
        await this.channels[channelId].send(msg, cfg.recipients);
        this.markSent(channelId, msg);
        await this.logging.info(
          'notify',
          `Sent "${msg.title}" via ${channelId} to ${cfg.recipients.length} recipient(s)`,
        );
        this.recordHistory({ channel: channelId, status: 'sent', msg, ...meta, recipients: cfg.recipients.length });
      } catch (err) {
        const m = err instanceof Error ? err.message : 'Unknown error';
        await this.logging.error('notify', `${channelId} send failed for "${msg.title}": ${m}`);
        this.recordHistory({ channel: channelId, status: 'failed', msg, ...meta, recipients: cfg.recipients.length, detail: m });
      }
    }
  }

  private throttleKey(id: string, msg: NotificationMessage): string {
    return `${id}:${msg.dedupeKey ?? msg.title}`;
  }

  private isThrottled(id: string, msg: NotificationMessage, windowSec: number): boolean {
    if (windowSec <= 0) return false;
    const last = this.lastSent.get(this.throttleKey(id, msg));
    return last !== undefined && Date.now() - last < windowSec * 1000;
  }

  private markSent(id: string, msg: NotificationMessage): void {
    this.lastSent.set(this.throttleKey(id, msg), Date.now());
  }

  // ── Test ──────────────────────────────────────────────────

  /** Manual test send from the settings UI. Bypasses alert rules and throttling. */
  async test(channel: RoutableChannelId, to?: string): Promise<{ ok: boolean; message: string }> {
    const cfg = await this.channelConfig(channel);
    const recipients = to ? this.parseRecipients(to) : cfg.recipients;
    if (recipients.length === 0) {
      return { ok: false, message: 'No recipients configured for this channel.' };
    }
    const msg: NotificationMessage = {
      title: 'Cerebro test notification',
      body: 'If you received this, your Cerebro alert channel is configured correctly.',
      severity: 'info',
      source: 'test',
    };
    try {
      await this.channels[channel].send(msg, recipients);
      this.recordHistory({ channel, status: 'sent', msg, recipients: recipients.length });
      return { ok: true, message: `Test sent via ${channel} to ${recipients.join(', ')}.` };
    } catch (err) {
      const m = err instanceof Error ? err.message : 'Unknown error';
      await this.logging.error('notify', `Test ${channel} failed: ${m}`);
      this.recordHistory({ channel, status: 'failed', msg, recipients: recipients.length, detail: m });
      return { ok: false, message: m };
    }
  }
}
