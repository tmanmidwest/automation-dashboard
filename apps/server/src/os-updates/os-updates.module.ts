import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LoggingModule } from '../logging/logging.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { FabricModule } from '../fabric/fabric.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { OsUpdatesController } from './os-updates.controller';
import { OsUpdatesService } from './os-updates.service';
import { OsUpdateEnrichService } from './os-update-enrich.service';
import { VulnIntelModule } from '../vuln-intel/vuln-intel.module';

/**
 * OS updates — pending updates reported by the Cerebro agent, installs, restarts
 * and update schedules. See docs/os-updates.md.
 */
@Module({
  imports: [PrismaModule, LoggingModule, NotificationsModule, SettingsModule, FabricModule, ConnectorsModule, VulnIntelModule],
  controllers: [OsUpdatesController],
  providers: [OsUpdatesService, OsUpdateEnrichService],
  exports: [OsUpdatesService, OsUpdateEnrichService],
})
export class OsUpdatesModule {}
