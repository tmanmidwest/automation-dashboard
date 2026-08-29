import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { MailService } from './mail.service';
import { AuditService } from '../logging/audit.service';
import { RequirePermissions, CurrentUser } from '../auth/decorators';
import type { SessionUser } from '@cerebro/shared';

class SmtpConfigDto {
  @IsString() host!: string;
  @IsInt() @Min(1) @Max(65535) port!: number;
  @IsBoolean() secure!: boolean;
  @IsString() username!: string;
  @IsEmail() fromAddress!: string;
  @IsString() fromName!: string;
  @IsOptional() @IsString() password?: string;
}
class TestEmailDto {
  @IsEmail() to!: string;
}

@Controller('api/settings/smtp')
export class MailController {
  constructor(
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('settings:read')
  async read() {
    return { ...(await this.mail.getConfig()), passwordSet: await this.mail.passwordSet() };
  }

  @Put()
  @RequirePermissions('settings:write')
  async update(@Body() dto: SmtpConfigDto, @CurrentUser() user: SessionUser) {
    await this.mail.saveConfig(dto);
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'settings.smtp_updated',
      meta: { host: dto.host, port: dto.port },
    });
    return { ok: true };
  }

  @Post('test')
  @RequirePermissions('settings:write')
  async test(@Body() dto: TestEmailDto) {
    return this.mail.sendTest(dto.to);
  }
}
