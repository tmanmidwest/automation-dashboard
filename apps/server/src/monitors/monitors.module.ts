import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProbeRegistry } from './probe-registry.service';
import { MonitorsService } from './monitors.service';
import { MonitorSchedulerService } from './monitor-scheduler.service';
import { MonitorRetentionService } from './monitor-retention.service';
import { MonitorsController } from './monitors.controller';

/**
 * Uptime monitoring (the Uptime Kuma replacement). Probe types live in
 * ./probes and are registered in ProbeRegistry; the scheduler runs checks and
 * raises monitor.* alerts through NotificationsService. ScheduleModule is
 * initialised once in ConnectorsModule (forRoot), so decorators here just work.
 */
@Module({
  imports: [SettingsModule, NotificationsModule],
  controllers: [MonitorsController],
  providers: [ProbeRegistry, MonitorsService, MonitorSchedulerService, MonitorRetentionService],
  exports: [MonitorsService],
})
export class MonitorsModule {}
