import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { SecretsService } from './secrets.service';
import { AuthService } from '../auth/auth.service';
import { TotpService } from '../auth/totp.service';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, RequirePermissions, SessionOnly } from '../auth/decorators';
import type { RevealSecretResult, SessionUser } from '@cerebro/shared';

/** How long an SSO step-up re-authentication stays valid for reveals (sudo-style window). */
const REAUTH_WINDOW_MS = 5 * 60 * 1000;

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
  /**
   * The caller signs in via SSO (no password/TOTP) and must re-authenticate with
   * their identity provider — the UI opens the step-up popup instead of a field.
   */
  oidc: boolean;
  /** Slug of the provider to re-authenticate against (present when `oidc`). */
  oidcProviderSlug?: string;
  /** Human label of that provider, for the button (present when `oidc`). */
  oidcProviderLabel?: string;
  /** True when an SSO step-up completed recently and a reveal can proceed now. */
  reauthFresh: boolean;
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
    private readonly prisma: PrismaService,
  ) {}

  /** Which factors the current user must supply to reveal a value (drives the dialog). */
  @Get('reveal-requirements')
  @RequirePermissions('secrets:read')
  async revealRequirements(
    @CurrentUser() user: SessionUser,
    @Req() req: Request,
  ): Promise<RevealRequirements> {
    return this.requirementsFor(user.id, req);
  }

  @Post(':key/reveal')
  @RequirePermissions('secrets:read')
  async reveal(
    @Param('key') key: string,
    @Body() body: RevealSecretDto,
    @CurrentUser() user: SessionUser,
    @Req() req: Request,
  ): Promise<RevealSecretResult> {
    const reqs = await this.requirementsFor(user.id, req);
    if (!reqs.canReveal) {
      throw new BadRequestException(
        'This account has no way to re-authenticate. Set an account password, enable two-factor authentication, or link a single sign-on provider before revealing secrets.',
      );
    }
    if (reqs.password && !(await this.auth.verifyPassword(user.id, body?.password ?? ''))) {
      throw new UnauthorizedException('Your account password is incorrect.');
    }
    if (reqs.totp && !(await this.totp.verifyCode(user.id, body?.totp ?? ''))) {
      throw new UnauthorizedException('That authenticator code is incorrect.');
    }
    if (reqs.oidc && !reqs.reauthFresh) {
      throw new UnauthorizedException('Re-authenticate with your identity provider before revealing this value.');
    }

    const value = await this.secrets.revealForActor(key, { actorId: user.id, actorEmail: user.email });
    if (value === null) throw new NotFoundException('Secret not found.');

    // The SSO step-up is a short sudo-style window (REAUTH_WINDOW_MS): reveals within
    // it don't re-pop the IdP. The window is left to lapse on its own rather than being
    // burned per-secret, matching how OS sudo and other SSO step-ups behave.
    return { value };
  }

  private async requirementsFor(userId: string, req: Request): Promise<RevealRequirements> {
    const [password, { enabled: totp }] = await Promise.all([
      this.auth.hasPassword(userId),
      this.totp.getStatus(userId),
    ]);

    // Only fall back to SSO step-up when there's no local factor to re-check.
    let oidc = false;
    let oidcProviderSlug: string | undefined;
    let oidcProviderLabel: string | undefined;
    if (!password && !totp) {
      const identities = await this.prisma.userIdentity.findMany({
        where: { userId },
        include: { provider: true },
      });
      const usable = identities.find((i) => i.provider.enabled);
      if (usable) {
        oidc = true;
        oidcProviderSlug = usable.provider.slug;
        oidcProviderLabel = usable.provider.label;
      }
    }

    const at = req.session?.reauthAt;
    const reauthFresh = oidc && typeof at === 'number' && Date.now() - at < REAUTH_WINDOW_MS;

    return {
      password,
      totp,
      oidc,
      oidcProviderSlug,
      oidcProviderLabel,
      reauthFresh,
      canReveal: password || totp || oidc,
    };
  }
}
