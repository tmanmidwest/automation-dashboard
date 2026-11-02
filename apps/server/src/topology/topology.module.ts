import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { TopologyService } from './topology.service';
import { TopologyController } from './topology.controller';
import { NewDevicesService } from './new-devices.service';
import { NewDevicesController } from './new-devices.controller';

/** Architecture map: one graph joined across connectors (topology.builder.ts), plus new-device detection. */
@Module({
  imports: [ConnectorsModule, NotificationsModule, SettingsModule],
  controllers: [TopologyController, NewDevicesController],
  providers: [TopologyService, NewDevicesService],
})
export class TopologyModule {}
