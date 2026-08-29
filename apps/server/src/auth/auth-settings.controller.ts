import { Body, Controller, Get, Put } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { SettingsService } from '../settings/settings.service';
import { OidcService } from './oidc.service';
import { AuditService } from '../logging/audit.service';
import { RequirePermissions, CurrentUser } from './decorators';
import type { SessionUser } from '@cerebro/shared';

class OidcConfigDto {
  @IsBoolean() enabled!: boolean;
  @IsString() issuer!: string;
  @IsString() clientId!: string;
  @IsOptional() @IsString() buttonLabel?: string;
  /** Only sent when the operator wants to set/replace it; blank leaves it unchanged. */
  @IsOptional() @IsString() clientSecret?: string;
}

@Controller('api/settings/auth')
export class AuthSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly oidc: OidcService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('settings:read')
  async read() {
    const cfg = await this.oidc.getConfig();
    return {
      ...cfg,
      redirectUri: `${(process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/api/auth/oidc/callback`,
      clientSecretSet: await this.settings.hasSecret('oidc.clientSecret'),
    };
  }

  @Put()
  @RequirePermissions('settings:write')
  async update(@Body() dto: OidcConfigDto, @CurrentUser() user: SessionUser) {
    await this.settings.set('oidc.enabled', dto.enabled);
    await this.settings.set('oidc.issuer', dto.issuer.trim());
    await this.settings.set('oidc.clientId', dto.clientId.trim());
    await this.settings.set('oidc.buttonLabel', dto.buttonLabel?.trim() || 'Sign in with SSO');
    if (dto.clientSecret) {
      await this.settings.setSecret('oidc.clientSecret', dto.clientSecret);
    }
    this.oidc.invalidate();
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'settings.auth_updated',
      meta: { enabled: dto.enabled, issuer: dto.issuer },
    });
    return { ok: true };
  }
}
