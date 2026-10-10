import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { IsString, MinLength, MaxLength } from 'class-validator';
import type { SessionUser } from '@cerebro/shared';
import { CurrentUser, SessionOnly } from '../auth/decorators';
import { TotpService } from '../auth/totp.service';
import { LoginThrottleService } from '../auth/login-throttle.service';
import { AccountService } from './account.service';

class ConfirmDto {
  @IsString() code!: string;
  @IsString() @MinLength(10) newPassword!: string;
}

class MfaCodeDto {
  @IsString() @MinLength(1) @MaxLength(32) code!: string;
}

// No @RequirePermissions — any authenticated user may manage their OWN password / MFA.
// @SessionOnly at the class level: a bearer API token must never change a human's
// password or MFA, only an interactive session may (matches SecretsController etc.).
@Controller('api/account')
@SessionOnly()
export class AccountController {
  constructor(
    private readonly account: AccountService,
    private readonly totp: TotpService,
    private readonly throttle: LoginThrottleService,
  ) {}

  /**
   * Run a code-verifying action under the login throttle (per-IP cap + per-account
   * lockout), so the emailed password code / TOTP / recovery code can't be
   * brute-forced by someone who already holds a session. A thrown error counts as a
   * failed attempt; success clears the counter. `key` is action-scoped so these
   * never lock the victim out of login.
   */
  private async throttled<T>(ip: string | undefined, key: string, fn: () => Promise<T>): Promise<T> {
    await this.throttle.assertAllowed(ip, key);
    try {
      const result = await fn();
      await this.throttle.recordSuccess(key);
      return result;
    } catch (e) {
      await this.throttle.recordFailure(ip, key);
      throw e;
    }
  }

  @Post('password/request')
  request(@CurrentUser() user: SessionUser) {
    return this.account.requestPasswordChange(user.id);
  }

  @Post('password/confirm')
  confirm(@Body() dto: ConfirmDto, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return this.throttled(req.ip, `pwchange:${user.id}`, () =>
      this.account.confirmPasswordChange(user.id, dto.code, dto.newPassword),
    );
  }

  // ── Two-factor (TOTP). @SessionOnly: an API token must not manage a human's MFA. ──

  @Get('mfa')
  @SessionOnly()
  mfaStatus(@CurrentUser() user: SessionUser) {
    return this.totp.getStatus(user.id);
  }

  @Post('mfa/setup')
  @SessionOnly()
  mfaSetup(@CurrentUser() user: SessionUser) {
    return this.totp.beginEnrollment(user.id);
  }

  // enable/disable/recovery all verify a TOTP or recovery code → share one
  // throttle key per account so guesses can't be spread across the three endpoints.
  @Post('mfa/enable')
  @SessionOnly()
  mfaEnable(@Body() dto: MfaCodeDto, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return this.throttled(req.ip, `mfa:${user.id}`, () => this.totp.confirmEnrollment(user.id, dto.code));
  }

  @Post('mfa/disable')
  @SessionOnly()
  mfaDisable(@Body() dto: MfaCodeDto, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return this.throttled(req.ip, `mfa:${user.id}`, () => this.totp.disable(user.id, dto.code));
  }

  @Post('mfa/recovery-codes')
  @SessionOnly()
  mfaRecoveryCodes(@Body() dto: MfaCodeDto, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return this.throttled(req.ip, `mfa:${user.id}`, () => this.totp.regenerateRecoveryCodes(user.id, dto.code));
  }
}
