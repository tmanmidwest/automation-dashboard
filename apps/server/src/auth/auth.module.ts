import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { TokenAuthService } from './token-auth.service';
import { OAuthTokenService } from './oauth-token.service';
import { TotpService } from './totp.service';

@Module({
  imports: [SettingsModule], // OAuthTokenService reads/writes the JWT secret in the vault
  controllers: [AuthController],
  providers: [AuthService, TokenAuthService, OAuthTokenService, TotpService],
  exports: [AuthService, TokenAuthService, OAuthTokenService, TotpService],
})
export class AuthModule {}
