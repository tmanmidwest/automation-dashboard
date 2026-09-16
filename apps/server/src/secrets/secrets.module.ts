import { Global, Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { SecretsService } from './secrets.service';
import { SecretsRotationService } from './secrets-rotation.service';
import { SecretsController } from './secrets.controller';

/**
 * The secrets vault. Global so SettingsService (and any future consumer) can
 * inject SecretsService without an import edge — the vault sits underneath the
 * config layer.
 *
 * NB: the step-up **reveal** endpoint lives in its own {@link SecretsRevealModule},
 * NOT here — it needs AuthModule (password/TOTP re-check), and AuthModule → Settings
 * → SecretsService(global) already, so importing AuthModule here would form a module
 * cycle. Keeping reveal in a separate module (that imports AuthModule and uses the
 * global SecretsService) breaks the cycle. See docs/secrets-vault.md.
 */
@Global()
@Module({
  imports: [NotificationsModule],
  controllers: [SecretsController],
  providers: [SecretsService, SecretsRotationService],
  exports: [SecretsService],
})
export class SecretsModule {}
