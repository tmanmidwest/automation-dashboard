import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { TokenAuthService } from './token-auth.service';
import { OAuthTokenService } from './oauth-token.service';
import { TotpService } from './totp.service';
import { LoginThrottleService } from './login-throttle.service';
import { LocalLoginPolicyService } from './local-login-policy.service';
import { LocalLoginAdminController } from './local-login-admin.controller';

@Module({
  imports: [SettingsModule], // OAuthTokenService reads/writes the JWT secret in the vault
  controllers: [AuthController, LocalLoginAdminController],
  providers: [AuthService, TokenAuthService, OAuthTokenService, TotpService, LoginThrottleService, LocalLoginPolicyService],
  exports: [AuthService, TokenAuthService, OAuthTokenService, TotpService, LoginThrottleService, LocalLoginPolicyService],
})
export class AuthModule {}
