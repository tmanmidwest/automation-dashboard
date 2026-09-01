import { Injectable } from '@nestjs/common';
import type { NotificationChannelId, NotificationMessage } from '@cerebro/shared';
import { SettingsService } from '../../settings/settings.service';
import { SignalCli } from '../signal/signal-cli';
import { NotificationChannel } from './notification-channel';

/**
 * Signal channel — sends via the bundled signal-cli using the linked/registered
 * "send-as" account. Account lifecycle (link/register) is handled by
 * SignalService; this only sends.
 */
@Injectable()
export class SignalChannel implements NotificationChannel {
  readonly id: NotificationChannelId = 'signal';
  private readonly cli = new SignalCli();

  constructor(private readonly settings: SettingsService) {}

  async send(msg: NotificationMessage, recipients: string[]): Promise<void> {
    const account = await this.settings.get<string>('notify.signal.account');
    if (!account) {
      throw new Error('Signal is not linked — link a device or register a number first.');
    }
    const text = `Cerebro: ${msg.title}${msg.body ? `\n\n${msg.body}` : ''}`;
    await this.cli.send(account, recipients, text);
  }
}
