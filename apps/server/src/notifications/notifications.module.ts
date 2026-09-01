import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { EmailChannel } from './channels/email.channel';
import { TextbeltChannel } from './channels/textbelt.channel';
import { SignalChannel } from './channels/signal.channel';
import { SignalService } from './signal/signal.service';
import { SignalController } from './signal/signal.controller';

/**
 * Outbound alerts / notifications. Owns the channels (email, Textbelt SMS,
 * Signal) and the dispatcher. Signal-cli is bundled in the app image; the
 * SignalService/SignalController drive its account lifecycle (link/register).
 * Exports NotificationsService so other modules can raise alerts via `dispatch()`.
 */
@Module({
  imports: [SettingsModule, MailModule],
  controllers: [NotificationsController, SignalController],
  providers: [NotificationsService, EmailChannel, TextbeltChannel, SignalChannel, SignalService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
