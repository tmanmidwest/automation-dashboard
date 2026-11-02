import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { TopologyService } from './topology.service';
import { TopologyController } from './topology.controller';

/** Architecture map: one graph joined across connectors. See topology.builder.ts. */
@Module({
  imports: [ConnectorsModule],
  controllers: [TopologyController],
  providers: [TopologyService],
})
export class TopologyModule {}
