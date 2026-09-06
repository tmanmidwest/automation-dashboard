import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AutomationsService } from './automations.service';
import { AutomationsController } from './automations.controller';

/**
 * The rules engine. Imports Connectors (to run actions/operations) and
 * Notifications (for the notify action); TimelineBus + audit/logging come from
 * the global logging module. See docs/automations.md.
 */
@Module({
  imports: [ConnectorsModule, NotificationsModule],
  controllers: [AutomationsController],
  providers: [AutomationsService],
})
export class AutomationsModule {}
