import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import { GRANTABLE_TOKEN_SCOPES } from '@cerebro/shared';
import { Public } from '../auth/decorators';

/** Scopes an OAuth token may request — the grantable catalog (read + action scopes). */
const SUPPORTED_SCOPES = GRANTABLE_TOKEN_SCOPES;

/**
 * OAuth 2.1 discovery metadata. Both documents are public (unauthenticated) so MCP clients
 * can bootstrap the flow. Admin-gated registration means there is deliberately no
 * `registration_endpoint`. The `/oauth/authorize` and `/oauth/token` endpoints advertised
 * here are implemented in slice 3b.
 */
@Public()
@Controller('.well-known')
export class OAuthMetadataController {
  /** APP_URL if set, else derived from the request (honours the reverse-proxy X-Forwarded-* via `trust proxy`). */
  private baseUrl(req: Request): string {
    const configured = process.env.APP_URL;
    if (configured) return configured.replace(/\/$/, '');
    return `${req.protocol}://${req.get('host')}`;
  }

  @Get('oauth-authorization-server')
  authorizationServer(@Req() req: Request) {
    const base = this.baseUrl(req);
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: SUPPORTED_SCOPES,
    };
  }

  @Get('oauth-protected-resource')
  protectedResource(@Req() req: Request) {
    const base = this.baseUrl(req);
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: SUPPORTED_SCOPES,
      bearer_methods_supported: ['header'],
    };
  }
}
