import { Module, OnModuleInit } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { ConnectorRegistry } from './connector-registry.service';
import { ConnectorInstanceService } from './connector-instance.service';
import { JobService } from './job.service';
import { ConsoleService } from './console.service';
import { ConnectorsController } from './connectors.controller';
import { ProxmoxConnector } from './proxmox/proxmox.connector';
import { AwsConnector } from './aws/aws.connector';
import { BackblazeConnector } from './backblaze/backblaze.connector';
import { BackupRunService } from './backblaze/backup-run.service';

@Module({
  imports: [SettingsModule],
  controllers: [ConnectorsController],
  providers: [ConnectorRegistry, ConnectorInstanceService, JobService, ConsoleService, BackupRunService],
  exports: [ConnectorRegistry, ConnectorInstanceService, ConsoleService],
})
export class ConnectorsModule implements OnModuleInit {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly backupRuns: BackupRunService,
  ) {}

  /** Register the built-in connectors with the extension host. */
  onModuleInit() {
    this.registry.register(new ProxmoxConnector());
    this.registry.register(new AwsConnector());
    // The Backblaze connector reads its restore history from the durable run store.
    this.registry.register(new BackblazeConnector(this.backupRuns));
  }
}
