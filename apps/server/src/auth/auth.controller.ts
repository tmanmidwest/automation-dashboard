import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { FirstRunStatus, SessionUser } from '@cerebro/shared';
import { AuthService } from './auth.service';
import { OidcService } from './oidc.service';
import { AuditService } from '../logging/audit.service';
import { Public, CurrentUser } from './decorators';
import { LoginDto, SetupDto } from './dto';

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly oidc: OidcService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Get('first-run')
  async firstRun(): Promise<FirstRunStatus> {
    return { needsSetup: await this.auth.isFirstRun() };
  }

  @Public()
  @Post('setup')
  async setup(@Body() dto: SetupDto, @Req() req: Request): Promise<{ ok: true }> {
    const userId = await this.auth.createInitialAdmin(dto);
    await this.login_(req, userId);
    return { ok: true };
  }

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request): Promise<{ ok: true }> {
    const userId = await this.auth.validateLocal(dto.email, dto.password);
    if (!userId) {
      await this.audit.record({
        actorEmail: dto.email,
        action: 'auth.login_failed',
        target: dto.email,
      });
      throw new UnauthorizedException('Invalid email or password.');
    }
    await this.login_(req, userId);
    await this.audit.record({ actorId: userId, actorEmail: dto.email, action: 'auth.login' });
    return { ok: true };
  }

  @Post('logout')
  async logout(@Req() req: Request, @CurrentUser() user?: SessionUser): Promise<{ ok: true }> {
    if (user) await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'auth.logout' });
    await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user?: SessionUser): SessionUser {
    if (!user) throw new UnauthorizedException();
    return user;
  }

  // ── OIDC ────────────────────────────────────────────────────

  @Public()
  @Get('oidc/status')
  oidcStatus() {
    return this.oidc.publicStatus();
  }

  @Public()
  @Get('oidc/login')
  async oidcLogin(@Req() req: Request, @Res() res: Response) {
    const url = await this.oidc.buildAuthUrl(req);
    res.redirect(url);
  }

  @Public()
  @Get('oidc/callback')
  async oidcCallback(@Req() req: Request, @Res() res: Response) {
    try {
      const userId = await this.oidc.handleCallback(req);
      await this.login_(req, userId);
      res.redirect('/');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'sign-in failed';
      res.redirect(`/login?error=${encodeURIComponent(msg)}`);
    }
  }

  /** Regenerate the session (prevents fixation) and store the user id. */
  private login_(req: Request, userId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) return reject(err);
        req.session.userId = userId;
        req.session.save((err2) => (err2 ? reject(err2) : resolve()));
      });
    });
  }
}
