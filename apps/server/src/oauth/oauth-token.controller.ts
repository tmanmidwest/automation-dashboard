import { Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators';
import { OAuthFlowService, OAuthFlowError, TokenResponse } from './oauth-flow.service';

/**
 * OAuth token endpoint. Public — clients authenticate with their own credentials (PKCE for
 * public clients, client secret for confidential), not a Cerebro session. Accepts
 * application/x-www-form-urlencoded or JSON. Supports the authorization_code and
 * refresh_token grants.
 */
@Public()
@Controller('oauth')
export class OAuthTokenController {
  constructor(private readonly flow: OAuthFlowService) {}

  @Post('token')
  async token(@Req() req: Request, @Res() res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');

    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const { clientId, clientSecret } = this.clientCredentials(req, body);

    try {
      let result: TokenResponse;
      switch (body.grant_type) {
        case 'authorization_code':
          result = await this.flow.exchangeAuthCode({
            clientId,
            clientSecret,
            code: body.code,
            redirectUri: body.redirect_uri,
            codeVerifier: body.code_verifier,
          });
          break;
        case 'refresh_token':
          result = await this.flow.refreshTokens({ clientId, clientSecret, refreshToken: body.refresh_token });
          break;
        default:
          throw new OAuthFlowError('unsupported_grant_type', 'Unsupported grant_type.', false);
      }
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof OAuthFlowError) {
        const status = err.code === 'invalid_client' ? 401 : 400;
        if (status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="oauth"');
        res.status(status).json({ error: err.code, error_description: err.description });
        return;
      }
      res.status(500).json({ error: 'server_error', error_description: 'Unexpected error.' });
    }
  }

  @Post('revoke')
  async revoke(@Req() req: Request, @Res() res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const { clientId, clientSecret } = this.clientCredentials(req, body);
    try {
      await this.flow.revokeToken({ clientId, clientSecret, token: body.token });
      res.status(200).json({}); // RFC 7009: 200 for success (including unknown tokens)
    } catch (err) {
      if (err instanceof OAuthFlowError) {
        const status = err.code === 'invalid_client' ? 401 : 400;
        if (status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="oauth"');
        res.status(status).json({ error: err.code, error_description: err.description });
        return;
      }
      res.status(500).json({ error: 'server_error', error_description: 'Unexpected error.' });
    }
  }

  /** client_secret_post (body) or client_secret_basic (Authorization: Basic base64(id:secret)). */
  private clientCredentials(req: Request, body: Record<string, string | undefined>): { clientId?: string; clientSecret?: string } {
    const header = req.headers.authorization;
    if (header?.toLowerCase().startsWith('basic ')) {
      try {
        const [id, secret] = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8').split(':');
        if (id) return { clientId: decodeURIComponent(id), clientSecret: secret ? decodeURIComponent(secret) : undefined };
      } catch {
        /* fall through to body credentials */
      }
    }
    return { clientId: body.client_id, clientSecret: body.client_secret };
  }
}
