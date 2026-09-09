import { Module } from '@nestjs/common';
import { SystemBackupService } from './system-backup.service';
import { SystemBackupController } from './system-backup.controller';

/** Full system backup & restore (pg_dump + signal-cli state + vault re-key). See docs/system-backup.md. */
@Module({
  controllers: [SystemBackupController],
  providers: [SystemBackupService],
})
export class SystemBackupModule {}
