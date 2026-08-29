import { Module, OnModuleInit } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { ConnectorRegistry } from './connector-registry.service';
import { ConnectorInstanceService } from './connector-instance.service';
import { JobService } from './job.service';
import { ConnectorsController } from './connectors.controller';
import { ProxmoxConnector } from './proxmox/proxmox.connector';

@Module({
  imports: [SettingsModule],
  controllers: [ConnectorsController],
  providers: [ConnectorRegistry, ConnectorInstanceService, JobService],
  exports: [ConnectorRegistry, ConnectorInstanceService],
})
export class ConnectorsModule implements OnModuleInit {
  constructor(private readonly registry: ConnectorRegistry) {}

  /** Register the built-in connectors with the extension host. */
  onModuleInit() {
    this.registry.register(new ProxmoxConnector());
  }
}
