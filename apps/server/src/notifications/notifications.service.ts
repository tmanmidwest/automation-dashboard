import { Injectable } from '@nestjs/common';
import {
  severityRank,
  type NotificationMessage,
  type NotificationSeverity,
} from '@cerebro/shared';
import { SettingsService } from '../settings/settings.service';
import { LoggingService } from '../logging/logging.service';
import { EmailChannel } from './channels/email.channel';
import { TextbeltChannel } from './channels/textbelt.channel';
import { SignalChannel } from './channels/signal.channel';
import { NotificationChannel } from './channels/notification-channel';

/** Channels that route through per-recipient config (everything so far). */
type RoutableChannelId = 'email' | 'textbelt' | 'signal';
const ROUTABLE_CHANNELS: RoutableChannelId[] = ['email', 'textbelt', 'signal'];

const DEFAULT_THROTTLE_SEC = 300;
const DEFAULT_MIN_SEVERITY: NotificationSeverity = 'warning';

interface ChannelConfig {
  enabled: boolean;
  minSeverity: NotificationSeverity;
  recipients: string[];
}

interface ChannelView {
  enabled: boolean;
  minSeverity: NotificationSeverity;
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

/**
 * The notification dispatcher. Other modules call `dispatch()`; it fans the
 * message out to every enabled channel that meets the min-severity bar, isn't
 * rate-limited, and has recipients. Per-channel failures are logged, never
 * thrown — one broken channel must not stop the others or the caller.
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

  // ── Config ────────────────────────────────────────────────

  private parseRecipients(raw: string): string[] {
    return raw
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private async channelConfig(id: RoutableChannelId): Promise<ChannelConfig> {
    return {
      enabled: (await this.settings.get<boolean>(`notify.${id}.enabled`)) ?? false,
      minSeverity:
        (await this.settings.get<NotificationSeverity>(`notify.${id}.minSeverity`)) ??
        DEFAULT_MIN_SEVERITY,
      recipients: (await this.settings.get<string[]>(`notify.${id}.recipients`)) ?? [],
    };
  }

  private view(cfg: ChannelConfig): ChannelView {
    return { enabled: cfg.enabled, minSeverity: cfg.minSeverity, recipients: cfg.recipients.join(', ') };
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
    await this.settings.set('notify.email.minSeverity', cfg.email.minSeverity);
    await this.settings.set('notify.email.recipients', this.parseRecipients(cfg.email.recipients));

    await this.settings.set('notify.textbelt.enabled', cfg.textbelt.enabled);
    await this.settings.set('notify.textbelt.minSeverity', cfg.textbelt.minSeverity);
    await this.settings.set(
      'notify.textbelt.recipients',
      this.parseRecipients(cfg.textbelt.recipients),
    );
    await this.settings.set('notify.textbelt.endpoint', (cfg.textbelt.endpoint ?? '').trim());
    // Blank key keeps the stored one (matches the SMTP password UX).
    if (cfg.textbelt.key) await this.settings.setSecret('notify.textbelt.key', cfg.textbelt.key.trim());

    await this.settings.set('notify.signal.enabled', cfg.signal.enabled);
    await this.settings.set('notify.signal.minSeverity', cfg.signal.minSeverity);
    await this.settings.set('notify.signal.recipients', this.parseRecipients(cfg.signal.recipients));

    await this.settings.set('notify.throttle.windowSec', Math.max(0, cfg.throttleWindowSec));
  }

  // ── Dispatch ──────────────────────────────────────────────

  /**
   * Fan a notification out to every eligible channel. Never throws.
   * Call this from anywhere in the app that wants to raise an alert.
   */
  async dispatch(msg: NotificationMessage): Promise<void> {
    const severity = msg.severity ?? 'info';
    const windowSec =
      (await this.settings.get<number>('notify.throttle.windowSec')) ?? DEFAULT_THROTTLE_SEC;

    for (const id of ROUTABLE_CHANNELS) {
      const cfg = await this.channelConfig(id);
      if (!cfg.enabled) continue;
      if (severityRank(severity) < severityRank(cfg.minSeverity)) continue;
      if (cfg.recipients.length === 0) continue;
      if (this.isThrottled(id, msg, windowSec)) {
        await this.logging.debug('notify', `Throttled ${id} for "${msg.title}"`);
        continue;
      }
      try {
        await this.channels[id].send(msg, cfg.recipients);
        this.markSent(id, msg);
        await this.logging.info(
          'notify',
          `Sent "${msg.title}" via ${id} to ${cfg.recipients.length} recipient(s)`,
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : 'Unknown error';
        await this.logging.error('notify', `${id} send failed for "${msg.title}": ${m}`);
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

  /** Manual test send from the settings UI. Bypasses throttling. */
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
