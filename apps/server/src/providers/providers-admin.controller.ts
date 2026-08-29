import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';
import type { IdentityProviderConfig, SessionUser } from '@cerebro/shared';
import { RequirePermissions, CurrentUser } from '../auth/decorators';
import { AuditService } from '../logging/audit.service';
import { IdentityProviderService, ProviderInput } from './identity-provider.service';
import { SsoService } from './sso.service';
import type { IdentityProvider } from '@prisma/client';

class ProviderDto implements ProviderInput {
  @IsString() label!: string;
  @IsString() issuer!: string;
  @IsString() clientId!: string;
  @IsOptional() @IsString() buttonLabel?: string;
  @IsOptional() @IsString() icon?: string;
  @IsOptional() @IsString() scopes?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() autoCreateUsers?: boolean;
  @IsOptional() @IsString() defaultRoleSlug?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) allowedDomains?: string[];
  @IsOptional() @IsString() clientSecret?: string;
}
class EnabledDto {
  @IsBoolean() enabled!: boolean;
}

@Controller('api/settings/auth/providers')
export class ProvidersAdminController {
  constructor(
    private readonly providers: IdentityProviderService,
    private readonly sso: SsoService,
    private readonly audit: AuditService,
  ) {}

  private async toConfig(p: IdentityProvider): Promise<IdentityProviderConfig> {
    return {
      id: p.id,
      slug: p.slug,
      label: p.label,
      type: 'oidc',
      issuer: p.issuer,
      clientId: p.clientId,
      buttonLabel: p.buttonLabel,
      icon: p.icon,
      scopes: p.scopes,
      enabled: p.enabled,
      autoCreateUsers: p.autoCreateUsers,
      defaultRoleSlug: p.defaultRoleSlug,
      allowedDomains: p.allowedDomains,
      sortOrder: p.sortOrder,
      clientSecretSet: await this.providers.hasSecret(p.id),
      redirectUri: this.providers.redirectUri(p.slug),
    };
  }

  @Get()
  @RequirePermissions('settings:read')
  async list(): Promise<IdentityProviderConfig[]> {
    const all = await this.providers.list();
    return Promise.all(all.map((p) => this.toConfig(p)));
  }

  @Post()
  @RequirePermissions('settings:write')
  async create(@Body() dto: ProviderDto, @CurrentUser() user: SessionUser) {
    const p = await this.providers.create(dto);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'settings.provider_created', target: p.label });
    return this.toConfig(p);
  }

  @Put(':id')
  @RequirePermissions('settings:write')
  async update(@Param('id') id: string, @Body() dto: ProviderDto, @CurrentUser() user: SessionUser) {
    const p = await this.providers.update(id, dto);
    this.sso.invalidate(id);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'settings.provider_updated', target: p.label });
    return this.toConfig(p);
  }

  @Patch(':id/enabled')
  @RequirePermissions('settings:write')
  async setEnabled(@Param('id') id: string, @Body() dto: EnabledDto, @CurrentUser() user: SessionUser) {
    await this.providers.setEnabled(id, dto.enabled);
    this.sso.invalidate(id);
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: dto.enabled ? 'settings.provider_enabled' : 'settings.provider_disabled',
      target: id,
    });
    return { ok: true };
  }

  @Post(':id/test')
  @RequirePermissions('settings:write')
  async test(@Param('id') id: string) {
    return this.sso.testProvider(id);
  }

  @Delete(':id')
  @RequirePermissions('settings:write')
  async remove(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    await this.providers.remove(id);
    this.sso.invalidate(id);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'settings.provider_deleted', target: id });
    return { ok: true };
  }
}
