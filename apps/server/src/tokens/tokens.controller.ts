import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import type { ApiTokenCreated, ApiTokenSummary, SessionUser } from '@cerebro/shared';
import { CurrentUser, SessionOnly } from '../auth/decorators';
import { TokensService } from './tokens.service';

class CreateTokenDto {
  @IsString() @MaxLength(80) name!: string;
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) scopes!: string[];
  @IsOptional() @IsISO8601() expiresAt?: string;
}

// @SessionOnly — you manage your OWN tokens from an interactive session; a bearer
// token can never mint or revoke tokens. No @RequirePermissions: any signed-in user
// may manage their own tokens, and scopes are clamped to their own permissions.
@SessionOnly()
@Controller('api/tokens')
export class TokensController {
  constructor(private readonly tokens: TokensService) {}

  @Get()
  list(@CurrentUser() user: SessionUser): Promise<ApiTokenSummary[]> {
    return this.tokens.list(user.id);
  }

  @Post()
  create(@Body() dto: CreateTokenDto, @CurrentUser() user: SessionUser): Promise<ApiTokenCreated> {
    return this.tokens.create(user, dto);
  }

  @Delete(':id')
  async revoke(@Param('id') id: string, @CurrentUser() user: SessionUser): Promise<{ ok: true }> {
    await this.tokens.revoke(user, id);
    return { ok: true };
  }
}
