import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OAuthClientService } from './oauth-client.service';
import { OAuthFlowService } from './oauth-flow.service';
import { OAuthAdminController } from './oauth-admin.controller';
import { OAuthMetadataController } from './oauth-metadata.controller';
import { OAuthAuthorizeController } from './oauth-authorize.controller';
import { OAuthConsentController } from './oauth-consent.controller';
import { OAuthTokenController } from './oauth-token.controller';
import { OAuthGrantsController } from './oauth-grants.controller';

@Module({
  // AuthModule exports OAuthTokenService (JWT) + AuthService (session → SessionUser).
  imports: [AuthModule],
  controllers: [
    OAuthAdminController,
    OAuthMetadataController,
    OAuthAuthorizeController,
    OAuthConsentController,
    OAuthTokenController,
    OAuthGrantsController,
  ],
  providers: [OAuthClientService, OAuthFlowService],
  exports: [OAuthClientService],
})
export class OAuthModule {}
