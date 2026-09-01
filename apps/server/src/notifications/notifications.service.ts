import { Injectable } from '@nestjs/common';
import type {
  AlertRule,
  AlertTypeDef,
  AlertView,
  NotificationChannelId,
  NotificationMessage,
  NotificationSeverity,
} from '@cerebro/shared';
import { SettingsService } from '../settings/settings.service';
import { LoggingService } from '../logging/logging.service';
import { EmailChannel } from './channels/email.channel';
import { TextbeltChannel } from './channels/textbelt.channel';
import { SignalChannel } from './channels/signal.channel';
import { NotificationChannel } from './channels/notification-channel';
import { ALERT_TYPES, getAlertType } from './alerts/alert-registry';

type RoutableChannelId = 'email' | 'textbelt' | 'signal';
const ROUTABLE_CHANNELS: RoutableChannelId[] = ['email', 'textbelt', 'signal'];
const CHANNEL_LABELS: Record<RoutableChannelId, string> = {
  email: 'Email',
  textbelt: 'SMS',
  signal: 'Signal',
};

const DEFAULT_THROTTLE_SEC = 300;

interface ChannelConfig {
  enabled: boolean;
  recipients: string[];
}

interface ChannelView {
  enabled: boolean;
  recipients: string;
}

/** Shape returned to the settings UI (recipients flattened to a string). */
export interface NotificationConfigView {
  email: ChannelView;
  textbelt: ChannelView & { endpoint: string; keySet: boolean };
  signal: ChannelView;
  throttleWindowSec: number;
}

/** Shape accepted from the settings UI on save. */
export interface SaveNotificationConfig {
  email: ChannelView;
  textbelt: ChannelView & { endpoint?: string; key?: string };
  signal: ChannelView;
  throttleWindowSec: number;
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
    private readonly settings: SettingsService,
    private readonly logging: LoggingService,
    email: EmailChannel,
    textbelt: TextbeltChannel,
    signal: SignalChannel,
  ) {
    this.channels = { email, textbelt, signal };
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

  /** Connector-scoped alerts with their global rule + this connector's mute state. */
  async getConnectorAlerts(connectorId: string): Promise<{ alerts: ConnectorAlertView[] }> {
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
    return { alerts };
  }

  async setConnectorMutes(connectorId: string, mutedKeys: string[]): Promise<void> {
    const valid = mutedKeys.filter((k) => getAlertType(k)?.connectorScoped);
    await this.settings.set(`notify.connector.${connectorId}.mutedAlerts`, [...new Set(valid)]);
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
    await this.sendToChannels(msg, rule.channels);
  }

  /** Deliver a message to the given channels, applying enablement + throttling. */
  private async sendToChannels(msg: NotificationMessage, channelIds: NotificationChannelId[]): Promise<void> {
    const windowSec =
      (await this.settings.get<number>('notify.throttle.windowSec')) ?? DEFAULT_THROTTLE_SEC;

    for (const id of channelIds) {
      if (!ROUTABLE_CHANNELS.includes(id as RoutableChannelId)) continue;
      const channelId = id as RoutableChannelId;
      const cfg = await this.channelConfig(channelId);
      if (!cfg.enabled || cfg.recipients.length === 0) continue;
      if (this.isThrottled(channelId, msg, windowSec)) {
        await this.logging.debug('notify', `Throttled ${channelId} for "${msg.title}"`);
        continue;
      }
      try {
        await this.channels[channelId].send(msg, cfg.recipients);
        this.markSent(channelId, msg);
        await this.logging.info(
          'notify',
          `Sent "${msg.title}" via ${channelId} to ${cfg.recipients.length} recipient(s)`,
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : 'Unknown error';
        await this.logging.error('notify', `${channelId} send failed for "${msg.title}": ${m}`);
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
      return { ok: true, message: `Test sent via ${channel} to ${recipients.join(', ')}.` };
    } catch (err) {
      const m = err instanceof Error ? err.message : 'Unknown error';
      await this.logging.error('notify', `Test ${channel} failed: ${m}`);
      return { ok: false, message: m };
    }
  }
}
