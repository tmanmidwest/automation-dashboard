import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LoggingModule } from '../logging/logging.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { FabricModule } from '../fabric/fabric.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { HealthRetentionService } from './health-retention.service';
import { HealthAlertsService } from './health-alerts.service';

/**
 * Health monitoring — resource health reported by the Cerebro agent over its
 * Fabric connection. See docs/health-monitoring.md.
 */
@Module({
  imports: [PrismaModule, LoggingModule, NotificationsModule, SettingsModule, FabricModule],
  controllers: [HealthController],
  providers: [HealthService, HealthRetentionService, HealthAlertsService],
  exports: [HealthService],
})
export class HealthModule {}
