import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { OidcService } from './oidc.service';
import { AuthController } from './auth.controller';
import { AuthSettingsController } from './auth-settings.controller';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [SettingsModule],
  controllers: [AuthController, AuthSettingsController],
  providers: [AuthService, OidcService],
  exports: [AuthService, OidcService],
})
export class AuthModule {}
