import { Injectable } from '@nestjs/common';
import type { NotificationChannelId, NotificationMessage } from '@cerebro/shared';
import { SettingsService } from '../../settings/settings.service';
import { NotificationChannel } from './notification-channel';

export const TEXTBELT_DEFAULT_ENDPOINT = 'https://textbelt.com/text';

interface TextbeltResponse {
  success?: boolean;
  error?: string;
  quotaRemaining?: number;
  textId?: string;
}

/**
 * SMS channel via Textbelt (https://textbelt.com). One outbound HTTPS POST per
 * recipient — no infrastructure required. The API key is stored encrypted.
 * Use the key `textbelt_test` for a free no-op success while wiring things up.
 */
@Injectable()
export class TextbeltChannel implements NotificationChannel {
  readonly id: NotificationChannelId = 'textbelt';

  constructor(private readonly settings: SettingsService) {}

  async send(msg: NotificationMessage, recipients: string[]): Promise<void> {
    const key = await this.settings.getSecret('notify.textbelt.key');
    if (!key) throw new Error('Textbelt API key is not configured.');
    const endpoint =
      (await this.settings.get<string>('notify.textbelt.endpoint')) || TEXTBELT_DEFAULT_ENDPOINT;

    // SMS is short: lead with the title, append the body, hard-cap the length.
    const text = `Cerebro: ${msg.title}${msg.body ? `\n${msg.body}` : ''}`.slice(0, 600);

    const errors: string[] = [];
    for (const phone of recipients) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ phone, message: text, key }),
        });
        const data = (await res.json().catch(() => ({}))) as TextbeltResponse;
        if (!data.success) errors.push(`${phone}: ${data.error ?? `HTTP ${res.status}`}`);
      } catch (err) {
        errors.push(`${phone}: ${err instanceof Error ? err.message : 'request failed'}`);
      }
    }
    if (errors.length) throw new Error(`Textbelt failed — ${errors.join('; ')}`);
  }
}
