import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LoggingModule } from '../logging/logging.module';
import { OsUpdatesModule } from '../os-updates/os-updates.module';
import { TopologyModule } from '../topology/topology.module';
import { ActNowController } from './act-now.controller';
import { ActNowService } from './act-now.service';

/** Act Now: one worst-first worklist over updates, posture and backups. See docs/act-now.md. */
@Module({
  imports: [PrismaModule, LoggingModule, OsUpdatesModule, TopologyModule],
  controllers: [ActNowController],
  providers: [ActNowService],
  exports: [ActNowService],
})
export class ActNowModule {}
