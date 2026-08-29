import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { IdentityProviderService } from './identity-provider.service';
import { SsoService } from './sso.service';
import { SsoController } from './sso.controller';
import { ProvidersAdminController } from './providers-admin.controller';

@Module({
  imports: [SettingsModule],
  controllers: [SsoController, ProvidersAdminController],
  providers: [IdentityProviderService, SsoService],
  exports: [IdentityProviderService, SsoService],
})
export class ProvidersModule {}
