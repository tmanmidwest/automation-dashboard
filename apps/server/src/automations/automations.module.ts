import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MonitorsModule } from '../monitors/monitors.module';
import { AutomationsService } from './automations.service';
import { AutomationsController } from './automations.controller';

/**
 * The rules engine. Imports Connectors (to run actions/operations),
 * Notifications (for the notify action), and Monitors (pause/resume actions +
 * monitor_state conditions); TimelineBus + audit/logging come from the global
 * logging module. See docs/automations.md.
 */
@Module({
  imports: [ConnectorsModule, NotificationsModule, MonitorsModule],
  controllers: [AutomationsController],
  providers: [AutomationsService],
  exports: [AutomationsService],
})
export class AutomationsModule {}
