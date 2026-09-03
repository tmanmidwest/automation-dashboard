import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsString, MinLength, MaxLength } from 'class-validator';
import type { SessionUser } from '@cerebro/shared';
import { CurrentUser, SessionOnly } from '../auth/decorators';
import { TotpService } from '../auth/totp.service';
import { AccountService } from './account.service';

class ConfirmDto {
  @IsString() code!: string;
  @IsString() @MinLength(10) newPassword!: string;
}

class MfaCodeDto {
  @IsString() @MinLength(1) @MaxLength(32) code!: string;
}

// No @RequirePermissions — any authenticated user may manage their OWN password / MFA.
@Controller('api/account')
export class AccountController {
  constructor(
    private readonly account: AccountService,
    private readonly totp: TotpService,
  ) {}

  @Post('password/request')
  request(@CurrentUser() user: SessionUser) {
    return this.account.requestPasswordChange(user.id);
  }

  @Post('password/confirm')
  confirm(@Body() dto: ConfirmDto, @CurrentUser() user: SessionUser) {
    return this.account.confirmPasswordChange(user.id, dto.code, dto.newPassword);
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

  @Post('mfa/enable')
  @SessionOnly()
  mfaEnable(@Body() dto: MfaCodeDto, @CurrentUser() user: SessionUser) {
    return this.totp.confirmEnrollment(user.id, dto.code);
  }

  @Post('mfa/disable')
  @SessionOnly()
  mfaDisable(@Body() dto: MfaCodeDto, @CurrentUser() user: SessionUser) {
    return this.totp.disable(user.id, dto.code);
  }

  @Post('mfa/recovery-codes')
  @SessionOnly()
  mfaRecoveryCodes(@Body() dto: MfaCodeDto, @CurrentUser() user: SessionUser) {
    return this.totp.regenerateRecoveryCodes(user.id, dto.code);
  }
}
