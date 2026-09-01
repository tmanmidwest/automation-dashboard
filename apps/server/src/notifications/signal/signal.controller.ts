import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';
import type { SessionUser } from '@cerebro/shared';
import { SignalService } from './signal.service';
import { AuditService } from '../../logging/audit.service';
import { RequirePermissions, CurrentUser } from '../../auth/decorators';

class LinkDto {
  @IsOptional() @IsString() deviceName?: string;
}
class RegisterDto {
  @Matches(/^\+\d{6,15}$/, { message: 'Number must be E.164, e.g. +15551234567' })
  number!: string;
  @IsOptional() @IsString() captcha?: string;
  @IsOptional() @IsBoolean() voice?: boolean;
}
class VerifyDto {
  @Matches(/^\+\d{6,15}$/, { message: 'Number must be E.164, e.g. +15551234567' })
  number!: string;
  @IsString() code!: string;
  @IsOptional() @IsString() pin?: string;
}

@Controller('api/settings/notifications/signal')
export class SignalController {
  constructor(
    private readonly signal: SignalService,
    private readonly audit: AuditService,
  ) {}

  @Get('status')
  @RequirePermissions('settings:read')
  status() {
    return this.signal.status();
  }

  @Post('link')
  @RequirePermissions('settings:write')
  async link(@Body() dto: LinkDto, @CurrentUser() user: SessionUser) {
    const res = await this.signal.startLink(dto.deviceName ?? 'Cerebro');
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'settings.signal_link_started',
    });
    return res;
  }

  @Get('link/:id')
  @RequirePermissions('settings:read')
  linkStatus(@Param('id') id: string) {
    const s = this.signal.linkStatus(id);
    if (!s) return { status: 'error', error: 'Link session not found or expired.' };
    return { status: s.status, uri: s.uri, account: s.account, error: s.error };
  }

  @Post('register')
  @RequirePermissions('settings:write')
  register(@Body() dto: RegisterDto) {
    return this.signal.register(dto.number, dto.captcha, dto.voice ?? false);
  }

  @Post('verify')
  @RequirePermissions('settings:write')
  async verify(@Body() dto: VerifyDto, @CurrentUser() user: SessionUser) {
    const res = await this.signal.verify(dto.number, dto.code, dto.pin);
    if (res.ok) {
      await this.audit.record({
        actorId: user.id,
        actorEmail: user.email,
        action: 'settings.signal_registered',
        meta: { number: dto.number },
      });
    }
    return res;
  }
}
