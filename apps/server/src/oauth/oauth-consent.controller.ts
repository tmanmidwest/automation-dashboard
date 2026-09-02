import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import type { SessionUser } from '@cerebro/shared';
import { CurrentUser, SessionOnly } from '../auth/decorators';
import { AuditService } from '../logging/audit.service';
import { OAuthFlowService, OAuthFlowError } from './oauth-flow.service';

class DecisionDto {
  @IsString() client_id!: string;
  @IsString() redirect_uri!: string;
  @IsOptional() @IsString() scope?: string;
  @IsOptional() @IsString() state?: string;
  @IsString() code_challenge!: string;
  @IsOptional() @IsString() code_challenge_method?: string;
  @IsOptional() @IsString() response_type?: string;
  @IsOptional() @IsString() resource?: string;
  @IsBoolean() approve!: boolean;
}

/**
 * Backs the consent screen. Session-only: a bearer token can never approve an authorization.
 * `consent-info` describes what is being asked; `authorize/decision` records the grant (on
 * approve) and returns the URL the browser should navigate to next.
 */
@SessionOnly()
@Controller('api/oauth')
export class OAuthConsentController {
  constructor(
    private readonly flow: OAuthFlowService,
    private readonly audit: AuditService,
  ) {}

  @Get('consent-info')
  async consentInfo(
    @Query('client_id') clientId: string,
    @Query('redirect_uri') redirectUri: string,
    @Query('scope') scope: string | undefined,
    @CurrentUser() user: SessionUser,
  ) {
    const client = await this.flow.getEnabledClient(clientId);
    if (!client) throw new BadRequestException('Unknown or disabled client.');
    if (!redirectUri || !this.flow.redirectUriMatches(client.redirectUris, redirectUri)) {
      throw new BadRequestException('redirect_uri is not registered for this client.');
    }
    const scopes = this.flow.effectiveScopes(user.permissions, this.flow.parseScopes(scope));
    return { clientId: client.clientId, clientName: client.name, scopes };
  }

  @Post('authorize/decision')
  async decide(@Body() dto: DecisionDto, @CurrentUser() user: SessionUser) {
    let redirectUri: string;
    try {
      ({ redirectUri } = await this.flow.validateAuthorize(dto));
    } catch (err) {
      const message = err instanceof OAuthFlowError ? err.description : 'Invalid request.';
      throw new BadRequestException(message);
    }

    if (!dto.approve) {
      await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'oauth.consent_denied', target: dto.client_id });
      return { redirectTo: this.flow.buildRedirect(redirectUri, { error: 'access_denied', error_description: 'The user denied the request.', state: dto.state }) };
    }

    const scopes = this.flow.effectiveScopes(user.permissions, this.flow.parseScopes(dto.scope));
    if (scopes.length === 0) {
      return { redirectTo: this.flow.buildRedirect(redirectUri, { error: 'invalid_scope', error_description: 'None of the requested scopes are available to you.', state: dto.state }) };
    }

    await this.flow.rememberGrant(user.id, dto.client_id, scopes);
    const code = await this.flow.issueCode({
      clientId: dto.client_id,
      userId: user.id,
      scopes,
      redirectUri,
      codeChallenge: dto.code_challenge,
      resource: dto.resource,
    });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'oauth.consent_granted',
      target: dto.client_id,
      meta: { scopes },
    });
    return { redirectTo: this.flow.buildRedirect(redirectUri, { code, state: dto.state }) };
  }
}
