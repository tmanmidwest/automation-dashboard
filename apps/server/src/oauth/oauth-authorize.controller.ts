import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Permission } from '@cerebro/shared';
import { Public } from '../auth/decorators';
import { AuthService } from '../auth/auth.service';
import { OAuthFlowService, OAuthFlowError } from './oauth-flow.service';

interface AuthorizeQuery {
  client_id?: string;
  redirect_uri?: string;
  response_type?: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  resource?: string;
}

/**
 * OAuth authorization endpoint. Public (the user may have no session yet). Flow:
 *   validate client/redirect → no session ? bounce to login : (remembered grant ? mint code
 *   and redirect back : send the user to the consent page). Errors before redirect_uri is
 *   validated render an HTML page; afterwards they redirect back with ?error=.
 */
@Public()
@Controller('oauth')
export class OAuthAuthorizeController {
  constructor(
    private readonly flow: OAuthFlowService,
    private readonly auth: AuthService,
  ) {}

  @Get('authorize')
  async authorize(@Query() q: AuthorizeQuery, @Req() req: Request, @Res() res: Response): Promise<void> {
    let redirectUri: string;
    try {
      ({ redirectUri } = await this.flow.validateAuthorize(q));
    } catch (err) {
      if (err instanceof OAuthFlowError && err.redirectable && q.redirect_uri) {
        return void res.redirect(this.flow.buildRedirect(q.redirect_uri, { error: err.code, error_description: err.description, state: q.state }));
      }
      const msg = err instanceof OAuthFlowError ? err.description : 'Invalid authorization request.';
      return void res.status(400).type('html').send(this.errorPage(msg));
    }

    // Not signed in → bounce through the existing login and come back here.
    const userId = req.session?.userId;
    const user = userId ? await this.auth.buildSessionUser(userId) : null;
    if (!user) {
      const returnTo = encodeURIComponent(req.originalUrl);
      return void res.redirect(`/login?returnTo=${returnTo}`);
    }

    const requested = this.flow.parseScopes(q.scope);
    const scopes = this.flow.effectiveScopes(user.permissions, requested);
    if (scopes.length === 0) {
      return void res.redirect(this.flow.buildRedirect(redirectUri, { error: 'invalid_scope', error_description: 'None of the requested scopes are available to you.', state: q.state }));
    }

    // Remembered consent → skip the screen and issue a code immediately.
    if (await this.flow.hasRememberedGrant(user.id, q.client_id!, scopes)) {
      return void (await this.redirectWithCode(res, { clientId: q.client_id!, userId: user.id, scopes, redirectUri, codeChallenge: q.code_challenge!, resource: q.resource, state: q.state }));
    }

    // Otherwise show the consent page (SPA), preserving the original query.
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    return void res.redirect(`/consent?${qs}`);
  }

  private async redirectWithCode(
    res: Response,
    input: { clientId: string; userId: string; scopes: Permission[]; redirectUri: string; codeChallenge: string; resource?: string; state?: string },
  ): Promise<void> {
    const code = await this.flow.issueCode({
      clientId: input.clientId,
      userId: input.userId,
      scopes: input.scopes,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      resource: input.resource,
    });
    res.redirect(this.flow.buildRedirect(input.redirectUri, { code, state: input.state }));
  }

  private errorPage(message: string): string {
    const safe = message.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
    return `<!doctype html><html><head><meta charset="utf-8"><title>Authorization error</title></head><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>Authorization error</h1><p>${safe}</p></body></html>`;
  }
}
