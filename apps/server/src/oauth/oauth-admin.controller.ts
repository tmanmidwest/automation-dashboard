import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { OAuthClientCreated, OAuthClientSummary, SessionUser } from '@cerebro/shared';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { AuditService } from '../logging/audit.service';
import { OAuthClientService } from './oauth-client.service';

class CreateClientDto {
  @IsString() @MaxLength(80) name!: string;
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) redirectUris!: string[];
  @IsOptional() @IsIn(['public', 'confidential']) type?: 'public' | 'confidential';
}

class UpdateClientDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) redirectUris?: string[];
  @IsOptional() @IsBoolean() disabled?: boolean;
}

@Controller('api/settings/oauth/clients')
export class OAuthAdminController {
  constructor(
    private readonly clients: OAuthClientService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('settings:read')
  list(): Promise<OAuthClientSummary[]> {
    return this.clients.list();
  }

  @Post()
  @RequirePermissions('settings:write')
  async create(@Body() dto: CreateClientDto, @CurrentUser() user: SessionUser): Promise<OAuthClientCreated> {
    const created = await this.clients.create(dto);
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'oauth.client_created',
      target: created.client.name,
      meta: { clientId: created.client.clientId, type: created.client.type },
    });
    return created;
  }

  @Patch(':id')
  @RequirePermissions('settings:write')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateClientDto,
    @CurrentUser() user: SessionUser,
  ): Promise<OAuthClientSummary> {
    const client = await this.clients.update(id, dto);
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'oauth.client_updated',
      target: client.name,
      meta: { clientId: client.clientId, disabled: client.disabled },
    });
    return client;
  }

  @Delete(':id')
  @RequirePermissions('settings:write')
  async remove(@Param('id') id: string, @CurrentUser() user: SessionUser): Promise<{ ok: true }> {
    await this.clients.remove(id);
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'oauth.client_deleted',
      target: id,
    });
    return { ok: true };
  }
}
