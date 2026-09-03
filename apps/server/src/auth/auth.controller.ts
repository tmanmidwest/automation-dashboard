import { Body, Controller, Get, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { FirstRunStatus, SessionUser } from '@cerebro/shared';
import { AuthService } from './auth.service';
import { TotpService } from './totp.service';
import { AuditService } from '../logging/audit.service';
import { Public, CurrentUser } from './decorators';
import { LoginDto, LoginTotpDto, SetupDto } from './dto';

/** How long a half-authenticated session may wait for its TOTP code. */
const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Wrong TOTP codes tolerated before the challenge is torn down. */
const MFA_MAX_ATTEMPTS = 5;

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly totp: TotpService,
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
  async login(@Body() dto: LoginDto, @Req() req: Request): Promise<{ ok: true } | { mfaRequired: true }> {
    const userId = await this.auth.validateLocal(dto.email, dto.password);
    if (!userId) {
      await this.audit.record({
        actorEmail: dto.email,
        action: 'auth.login_failed',
        target: dto.email,
      });
      throw new UnauthorizedException('Invalid email or password.');
    }

    // Password is correct. If this account has TOTP enabled, don't establish a full
    // session yet — hold a half-authenticated challenge and demand the second factor.
    const { enabled } = await this.totp.getStatus(userId);
    if (enabled) {
      await this.beginMfaChallenge_(req, userId);
      return { mfaRequired: true };
    }

    await this.login_(req, userId);
    await this.audit.record({ actorId: userId, actorEmail: dto.email, action: 'auth.login' });
    return { ok: true };
  }

  @Public()
  @Post('login/totp')
  async loginTotp(@Body() dto: LoginTotpDto, @Req() req: Request): Promise<{ ok: true }> {
    const pending = req.session.pendingMfa;
    if (!pending) {
      throw new UnauthorizedException('No sign-in is awaiting a code. Start over.');
    }
    if (Date.now() > pending.expiresAt) {
      await this.clearPendingMfa_(req);
      throw new UnauthorizedException('The sign-in request expired. Start over.');
    }
    if (pending.attempts >= MFA_MAX_ATTEMPTS) {
      await this.clearPendingMfa_(req);
      throw new UnauthorizedException('Too many incorrect codes. Start over.');
    }

    const ok = await this.totp.verifyForLogin(pending.userId, dto.code);
    if (!ok) {
      pending.attempts++;
      await this.saveSession_(req);
      throw new UnauthorizedException('That code is incorrect.');
    }

    // Second factor satisfied — promote to a full session (regenerate drops pendingMfa).
    const userId = pending.userId;
    await this.login_(req, userId);
    await this.audit.record({ actorId: userId, action: 'auth.login', meta: { mfa: true } });
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

  /**
   * Start a half-authenticated MFA challenge. Regenerate the session (fixation guard,
   * as with login_) but store `pendingMfa` instead of `userId`, so the caller is not
   * yet authenticated for any protected route.
   */
  private beginMfaChallenge_(req: Request, userId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) return reject(err);
        req.session.pendingMfa = { userId, expiresAt: Date.now() + MFA_CHALLENGE_TTL_MS, attempts: 0 };
        req.session.save((err2) => (err2 ? reject(err2) : resolve()));
      });
    });
  }

  private clearPendingMfa_(req: Request): Promise<void> {
    delete req.session.pendingMfa;
    return this.saveSession_(req);
  }

  private saveSession_(req: Request): Promise<void> {
    return new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });
  }
}
