import { Module } from '@nestjs/common';
import { ConnectorRegistry } from './connector-registry.service';
import { ConnectorsController } from './connectors.controller';

@Module({
  controllers: [ConnectorsController],
  providers: [ConnectorRegistry],
  exports: [ConnectorRegistry],
})
export class ConnectorsModule {}
