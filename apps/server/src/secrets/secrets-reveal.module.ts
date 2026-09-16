import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SecretsRevealController } from './secrets-reveal.controller';

/**
 * Hosts the step-up **reveal** endpoint only. Split out from {@link SecretsModule}
 * to break a module cycle: reveal needs AuthModule (password/TOTP re-check), and
 * AuthModule → SettingsModule → SecretsService(global). This module imports
 * AuthModule and reaches the vault via the global SecretsService, so no cycle forms.
 * See docs/secrets-vault.md.
 */
@Module({
  imports: [AuthModule],
  controllers: [SecretsRevealController],
})
export class SecretsRevealModule {}
