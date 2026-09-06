import { Global, Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { SecretsService } from './secrets.service';
import { SecretsRotationService } from './secrets-rotation.service';
import { SecretsController } from './secrets.controller';

/**
 * The secrets vault. Global so SettingsService (and any future consumer) can
 * inject SecretsService without an import edge — the vault sits underneath the
 * config layer. See docs/secrets-vault.md.
 */
@Global()
@Module({
  imports: [NotificationsModule],
  controllers: [SecretsController],
  providers: [SecretsService, SecretsRotationService],
  exports: [SecretsService],
})
export class SecretsModule {}
