import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { TopologyService } from './topology.service';
import { TopologyController } from './topology.controller';
import { NewDevicesService } from './new-devices.service';
import { NewDevicesController } from './new-devices.controller';
import { OutsideInService } from './outside-in.service';
import { ImageScanService } from './image-scan.service';
import { VersionCveService } from './version-cve.service';
import { CtLogService } from './ct-log.service';
import { HibpService } from './hibp.service';
import { PostureTrackingService } from './posture-tracking.service';
import { PostureController } from './posture.controller';

/** Architecture map: one graph joined across connectors (topology.builder.ts), plus new-device detection. */
@Module({
  imports: [ConnectorsModule, NotificationsModule, SettingsModule],
  controllers: [TopologyController, NewDevicesController, PostureController],
  providers: [TopologyService, NewDevicesService, OutsideInService, ImageScanService, VersionCveService, CtLogService, HibpService, PostureTrackingService],
})
export class TopologyModule {}
