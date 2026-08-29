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

  @Public()
  @Get('sso/:slug/callback')
  async callback(@Param('slug') slug: string, @Req() req: Request, @Res() res: Response) {
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
}
