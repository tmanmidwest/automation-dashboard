import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { PublicIdentityProvider } from '@cerebro/shared';
import { Public } from '../auth/decorators';
import { IdentityProviderService } from './identity-provider.service';
import { SsoService } from './sso.service';

@Controller('api/auth')
export class SsoController {
  constructor(
    private readonly providers: IdentityProviderService,
    private readonly sso: SsoService,
  ) {}

  /** Enabled providers for the login screen. */
  @Public()
  @Get('providers')
  async listProviders(): Promise<PublicIdentityProvider[]> {
    const enabled = await this.providers.listEnabled();
    return enabled.map((p) => ({
      slug: p.slug,
      label: p.label,
      buttonLabel: p.buttonLabel,
      icon: p.icon,
    }));
  }

  @Public()
  @Get('sso/:slug/login')
  async login(@Param('slug') slug: string, @Req() req: Request, @Res() res: Response) {
    try {
      const url = await this.sso.buildAuthUrl(req, slug);
      res.redirect(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'sign-in failed';
      res.redirect(`/login?error=${encodeURIComponent(msg)}`);
    }
  }

  /**
   * Begin a step-up re-authentication for the CURRENT user. Opened in a popup by the
   * reveal dialog; requires an existing session (no `@Public` login, just a session
   * check) — an unauthenticated hit is bounced to the login screen.
   */
  @Public()
  @Get('sso/:slug/reauth')
  async reauth(@Param('slug') slug: string, @Req() req: Request, @Res() res: Response) {
    if (!req.session.userId) return res.redirect('/login');
    try {
      const url = await this.sso.buildReauthUrl(req, slug);
      res.redirect(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 're-authentication failed';
      res.status(400).send(this.reauthResultPage(false, msg));
    }
  }

  @Public()
  @Get('sso/:slug/callback')
  async callback(@Param('slug') slug: string, @Req() req: Request, @Res() res: Response) {
    // A pending step-up re-auth reuses this same redirect URI — handle it here and
    // never touch `userId`, so a step-up can't be turned into a login.
    if (req.session.ssoReauth) {
      try {
        const userId = req.session.userId;
        if (!userId) throw new Error('Your session has expired. Sign in again.');
        await this.sso.handleReauthCallback(req, slug, userId);
        req.session.reauthAt = Date.now();
        await new Promise<void>((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));
        return res.send(this.reauthResultPage(true));
      } catch (err) {
        const msg = err instanceof Error ? err.message : 're-authentication failed';
        return res.status(400).send(this.reauthResultPage(false, msg));
      }
    }

    try {
      const userId = await this.sso.handleCallback(req, slug);
      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((err) => {
          if (err) return reject(err);
          req.session.userId = userId;
          req.session.save((e) => (e ? reject(e) : resolve()));
        });
      });
      res.redirect('/');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'sign-in failed';
      res.redirect(`/login?error=${encodeURIComponent(msg)}`);
    }
  }

  /**
   * The page the re-auth popup lands on. It messages the opener (so the reveal
   * dialog can enable itself) and closes. Text is a fallback for a blocked close.
   */
  private reauthResultPage(ok: boolean, message = ''): string {
    const payload = JSON.stringify({ type: 'cerebro-reauth', ok, message });
    const heading = ok ? 'Re-authentication complete' : 'Re-authentication failed';
    const detail = ok ? 'You can close this window and return to Cerebro.' : escapeHtml(message);
    return `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title>
<style>body{font:14px system-ui,sans-serif;background:#0b0f14;color:#cdd6e4;display:grid;place-items:center;height:100vh;margin:0}main{text-align:center;max-width:24rem;padding:1.5rem}h1{font-size:1rem;margin:0 0 .5rem}p{color:#8b98ac;margin:0}</style></head>
<body><main><h1>${heading}</h1><p>${detail}</p></main>
<script>try{if(window.opener){window.opener.postMessage(${payload},window.location.origin);}}catch(e){}setTimeout(function(){try{window.close();}catch(e){}},${ok ? 300 : 2500});</script>
</body></html>`;
  }
}

/** Minimal HTML-escape for the one interpolated (error) string above. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
