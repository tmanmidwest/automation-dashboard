import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { AppReplicatorModule } from '../app-replicator/app-replicator.module';
import { StackBackupModule } from '../stack-backup/stack-backup.module';
import { StackMigrateService } from './stack-migrate.service';
import { StackMigrateController } from './stack-migrate.controller';

/**
 * Stack migrator — move a Compose stack from one Docker host to another
 * (docs/stack-migrator.md). A thin orchestrator over the backup capture pipeline
 * (StackBackupModule), the restore pipeline, the Docker connector, and the App
 * Replicator's port preflight, plus host→host image transfer. See docs/stack-migrator.md.
 */
@Module({
  imports: [ConnectorsModule, AppReplicatorModule, StackBackupModule],
  controllers: [StackMigrateController],
  providers: [StackMigrateService],
  exports: [StackMigrateService],
})
export class StackMigrateModule {}
