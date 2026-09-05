import { Module, OnModuleInit } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SettingsModule } from '../settings/settings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ConnectorRegistry } from './connector-registry.service';
import { ConnectorInstanceService } from './connector-instance.service';
import { ConnectionMonitorService } from './connection-monitor.service';
import { ResourceMonitorService } from './resource-monitor.service';
import { MetricThresholdMonitorService } from './metric-threshold-monitor.service';
import { JobService } from './job.service';
import { ConsoleService } from './console.service';
import { ConnectorsController } from './connectors.controller';
import { ProxmoxConnector } from './proxmox/proxmox.connector';
import { AwsConnector } from './aws/aws.connector';
import { HomeAssistantConnector } from './home-assistant/home-assistant.connector';
import { CloudflareConnector } from './cloudflare/cloudflare.connector';
import { BackblazeConnector } from './backblaze/backblaze.connector';
import { BackupRunService } from './backblaze/backup-run.service';
import { BackupSchedulerService } from './backblaze/backup-scheduler.service';
import { BackupStateService } from './backblaze/backup-state.service';
import { VmNameService } from './backblaze/vm-name.service';

@Module({
  imports: [SettingsModule, NotificationsModule, ScheduleModule.forRoot()],
  controllers: [ConnectorsController],
  providers: [
    ConnectorRegistry, ConnectorInstanceService, ConnectionMonitorService, ResourceMonitorService, MetricThresholdMonitorService, JobService, ConsoleService,
    BackupRunService, BackupSchedulerService, BackupStateService, VmNameService,
  ],
  exports: [ConnectorRegistry, ConnectorInstanceService, ConsoleService],
})
export class ConnectorsModule implements OnModuleInit {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly backupRuns: BackupRunService,
    private readonly backupState: BackupStateService,
    private readonly vmNames: VmNameService,
  ) {}

  /** Register the built-in connectors with the extension host. */
  onModuleInit() {
    this.registry.register(new ProxmoxConnector());
    this.registry.register(new AwsConnector());
    this.registry.register(new HomeAssistantConnector());
    this.registry.register(new CloudflareConnector());
    // The Backblaze connector reads restore history, a durable state mirror, and VM names.
    this.registry.register(new BackblazeConnector(this.backupRuns, this.backupState, this.vmNames));
  }
}
