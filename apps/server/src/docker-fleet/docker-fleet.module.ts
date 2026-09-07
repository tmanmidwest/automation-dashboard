import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { DockerFleetService } from './docker-fleet.service';
import { DockerFleetController } from './docker-fleet.controller';

/** Aggregated multi-host Docker view. See docker-fleet.service.ts. */
@Module({
  imports: [ConnectorsModule],
  controllers: [DockerFleetController],
  providers: [DockerFleetService],
})
export class DockerFleetModule {}
