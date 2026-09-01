import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { NOTIFICATION_SEVERITIES, type NotificationSeverity, type SessionUser } from '@cerebro/shared';
import { NotificationsService } from './notifications.service';
import { AuditService } from '../logging/audit.service';
import { RequirePermissions, CurrentUser } from '../auth/decorators';

class ChannelDto {
  @IsBoolean() enabled!: boolean;
  @IsIn(NOTIFICATION_SEVERITIES) minSeverity!: NotificationSeverity;
  @IsString() recipients!: string;
}

class TextbeltDto extends ChannelDto {
  @IsOptional() @IsString() endpoint?: string;
  @IsOptional() @IsString() key?: string;
}

class NotificationConfigDto {
  @ValidateNested() @Type(() => ChannelDto) email!: ChannelDto;
  @ValidateNested() @Type(() => TextbeltDto) textbelt!: TextbeltDto;
  @ValidateNested() @Type(() => ChannelDto) signal!: ChannelDto;
  @IsInt() @Min(0) throttleWindowSec!: number;
}

class TestDto {
  @IsIn(['email', 'textbelt', 'signal']) channel!: 'email' | 'textbelt' | 'signal';
  @IsOptional() @IsString() to?: string;
}

@Controller('api/settings/notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('settings:read')
  read() {
    return this.notifications.getConfig();
  }

  @Put()
  @RequirePermissions('settings:write')
  async update(@Body() dto: NotificationConfigDto, @CurrentUser() user: SessionUser) {
    await this.notifications.saveConfig(dto);
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'settings.notifications_updated',
      meta: { email: dto.email.enabled, textbelt: dto.textbelt.enabled },
    });
    return { ok: true };
  }

  @Post('test')
  @RequirePermissions('settings:write')
  test(@Body() dto: TestDto) {
    return this.notifications.test(dto.channel, dto.to);
  }
}
