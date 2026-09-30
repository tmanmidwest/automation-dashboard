import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { SecretsModule } from '../secrets/secrets.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AppReplicatorModule } from '../app-replicator/app-replicator.module';
import { BackupTargetService } from './backup-target.service';
import { SecretCaptureService } from './secret-capture';
import { StackBackupService } from './stack-backup.service';
import { StackRestoreService } from './stack-restore.service';
import { StackBackupScheduler } from './stack-backup-scheduler.service';
import { StackBackupController } from './stack-backup.controller';

/**
 * Stack backup & restore — capture a Compose stack's volumes, config and metadata
 * from any Docker host into a restic repository. A feature module rather than a
 * connector, because a backup is cross-host by nature: the point is that a
 * snapshot from one host restores onto another. See docs/stack-backup.md.
 */
@Module({
  // ScheduleModule.forRoot() is registered once app-wide (ConnectorsModule); the
  // orchestrator discovers @Cron providers everywhere, and a second forRoot risks a
  // duplicate orchestrator — which for a backup scheduler means running twice.
  // AppReplicatorModule supplies PortAllocatorService — restore's port preflight
  // uses the same "what is taken on this host" check as a replicator deploy.
  imports: [ConnectorsModule, SecretsModule, NotificationsModule, AppReplicatorModule],
  controllers: [StackBackupController],
  providers: [BackupTargetService, SecretCaptureService, StackBackupService, StackRestoreService, StackBackupScheduler],
  // Exported for the shared tool catalog (assistant / MCP).
  exports: [BackupTargetService, StackBackupService, StackRestoreService],
})
export class StackBackupModule {}
