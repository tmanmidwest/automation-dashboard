import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { SecretsService } from './secrets.service';
import { AuthService } from '../auth/auth.service';
import { TotpService } from '../auth/totp.service';
import { CurrentUser, RequirePermissions, SessionOnly } from '../auth/decorators';
import type { RevealSecretResult, SessionUser } from '@cerebro/shared';

/** Body for the step-up reveal challenge. Both factors are optional at the DTO level;
 *  which are actually required is decided per-account, server-side. */
class RevealSecretDto {
  @IsOptional() @IsString() @MaxLength(200) password?: string;
  @IsOptional() @IsString() @MaxLength(32) totp?: string;
}

/** What a caller must provide to reveal a value, so the UI can prompt correctly. */
interface RevealRequirements {
  /** The caller must enter their account password (local account). */
  password: boolean;
  /** The caller must enter a live authenticator code (TOTP enabled). */
  totp: boolean;
  /** False when the account has no step-up factor at all and can never reveal. */
  canReveal: boolean;
}

/**
 * The vault's single read-to-a-human path: reveal a secret's plaintext, but only
 * after the caller re-authenticates on that very request (step-up). Nothing is
 * cached — every reveal re-verifies the account password and, when enabled, a live
 * TOTP code, and is audited as `secret.revealed`.
 *
 * This lives in its own module (not `SecretsModule`) on purpose: it needs
 * `AuthModule`, and AuthModule → SettingsModule → SecretsService(global) already,
 * so importing AuthModule into the global SecretsModule would form a cycle. Here it
 * imports AuthModule and reaches the vault through the global SecretsService.
 * `@SessionOnly` keeps a bearer token from ever revealing a value. See
 * docs/secrets-vault.md.
 */
@Controller('api/secrets')
@SessionOnly()
export class SecretsRevealController {
  constructor(
    private readonly secrets: SecretsService,
    private readonly auth: AuthService,
    private readonly totp: TotpService,
  ) {}

  /** Which factors the current user must supply to reveal a value (drives the dialog). */
  @Get('reveal-requirements')
  @RequirePermissions('secrets:read')
  async revealRequirements(@CurrentUser() user: SessionUser): Promise<RevealRequirements> {
    return this.requirementsFor(user.id);
  }

  @Post(':key/reveal')
  @RequirePermissions('secrets:read')
  async reveal(
    @Param('key') key: string,
    @Body() body: RevealSecretDto,
    @CurrentUser() user: SessionUser,
  ): Promise<RevealSecretResult> {
    const req = await this.requirementsFor(user.id);
    if (!req.canReveal) {
      throw new BadRequestException(
        'This account has no way to re-authenticate. Set an account password or enable two-factor authentication before revealing secrets.',
      );
    }
    if (req.password && !(await this.auth.verifyPassword(user.id, body?.password ?? ''))) {
      throw new UnauthorizedException('Your account password is incorrect.');
    }
    if (req.totp && !(await this.totp.verifyCode(user.id, body?.totp ?? ''))) {
      throw new UnauthorizedException('That authenticator code is incorrect.');
    }

    const value = await this.secrets.revealForActor(key, { actorId: user.id, actorEmail: user.email });
    if (value === null) throw new NotFoundException('Secret not found.');
    return { value };
  }

  private async requirementsFor(userId: string): Promise<RevealRequirements> {
    const [password, { enabled: totp }] = await Promise.all([
      this.auth.hasPassword(userId),
      this.totp.getStatus(userId),
    ]);
    return { password, totp, canReveal: password || totp };
  }
}
