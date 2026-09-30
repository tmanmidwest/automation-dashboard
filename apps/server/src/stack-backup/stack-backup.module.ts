import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { SecretsModule } from '../secrets/secrets.module';
import { BackupTargetService } from './backup-target.service';
import { SecretCaptureService } from './secret-capture';
import { StackBackupService } from './stack-backup.service';
import { StackBackupController } from './stack-backup.controller';

/**
 * Stack backup & restore — capture a Compose stack's volumes, config and metadata
 * from any Docker host into a restic repository. A feature module rather than a
 * connector, because a backup is cross-host by nature: the point is that a
 * snapshot from one host restores onto another. See docs/stack-backup.md.
 */
@Module({
  imports: [ConnectorsModule, SecretsModule],
  controllers: [StackBackupController],
  providers: [BackupTargetService, SecretCaptureService, StackBackupService],
  // Exported for the Phase 4 scheduler and the shared tool catalog.
  exports: [BackupTargetService, StackBackupService],
})
export class StackBackupModule {}
