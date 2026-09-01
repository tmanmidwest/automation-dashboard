import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  NOTIFICATION_SEVERITIES,
  type NotificationChannelId,
  type NotificationSeverity,
  type SessionUser,
} from '@cerebro/shared';
import { NotificationsService } from './notifications.service';
import { AuditService } from '../logging/audit.service';
import { RequirePermissions, CurrentUser } from '../auth/decorators';

const CHANNEL_IDS = ['email', 'textbelt', 'signal'];

class ChannelDto {
  @IsBoolean() enabled!: boolean;
  @IsString() recipients!: string;
}

class TextbeltDto extends ChannelDto {
  @IsOptional() @IsString() endpoint?: string;
  @IsOptional() @IsString() key?: string;
}

class QuietHoursDto {
  @IsBoolean() enabled!: boolean;
  @Matches(/^\d{2}:\d{2}$/, { message: 'Time must be HH:MM' }) start!: string;
  @Matches(/^\d{2}:\d{2}$/, { message: 'Time must be HH:MM' }) end!: string;
  @IsIn(NOTIFICATION_SEVERITIES) floor!: NotificationSeverity;
  @IsArray() @IsIn(CHANNEL_IDS, { each: true }) channels!: NotificationChannelId[];
}

class NotificationConfigDto {
  @ValidateNested() @Type(() => ChannelDto) email!: ChannelDto;
  @ValidateNested() @Type(() => TextbeltDto) textbelt!: TextbeltDto;
  @ValidateNested() @Type(() => ChannelDto) signal!: ChannelDto;
  @IsInt() @Min(0) throttleWindowSec!: number;
  @ValidateNested() @Type(() => QuietHoursDto) quiet!: QuietHoursDto;
}

class TestDto {
  @IsIn(CHANNEL_IDS) channel!: 'email' | 'textbelt' | 'signal';
  @IsOptional() @IsString() to?: string;
}

class AlertRuleDto {
  @IsString() key!: string;
  @IsBoolean() enabled!: boolean;
  @IsIn(NOTIFICATION_SEVERITIES) severity!: NotificationSeverity;
  @IsArray() @IsIn(CHANNEL_IDS, { each: true }) channels!: NotificationChannelId[];
}

class SaveAlertsDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => AlertRuleDto) alerts!: AlertRuleDto[];
}

class SaveConnectorMutesDto {
  @IsArray() @IsString({ each: true }) muted!: string[];
  /** Per-connector metric thresholds keyed by def id (e.g. { cost: 50, storage: 100 }). */
  @IsOptional() @IsObject() thresholds?: Record<string, number>;
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
      meta: { email: dto.email.enabled, textbelt: dto.textbelt.enabled, signal: dto.signal.enabled },
    });
    return { ok: true };
  }

  @Post('test')
  @RequirePermissions('settings:write')
  test(@Body() dto: TestDto) {
    return this.notifications.test(dto.channel, dto.to);
  }

  @Get('alerts')
  @RequirePermissions('settings:read')
  readAlerts() {
    return this.notifications.getAlerts();
  }

  @Put('alerts')
  @RequirePermissions('settings:write')
  async updateAlerts(@Body() dto: SaveAlertsDto, @CurrentUser() user: SessionUser) {
    await this.notifications.saveAlerts(dto.alerts);
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'settings.notification_alerts_updated',
      meta: { count: dto.alerts.length },
    });
    return { ok: true };
  }

  @Get('connectors/:id/alerts')
  @RequirePermissions('settings:read')
  readConnectorAlerts(@Param('id') id: string) {
    return this.notifications.getConnectorAlerts(id);
  }

  @Put('connectors/:id/alerts')
  @RequirePermissions('settings:write')
  async updateConnectorAlerts(
    @Param('id') id: string,
    @Body() dto: SaveConnectorMutesDto,
    @CurrentUser() user: SessionUser,
  ) {
    await this.notifications.saveConnectorAlertConfig(id, {
      muted: dto.muted,
      thresholds: dto.thresholds,
    });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'settings.connector_alerts_muted',
      target: id,
      meta: { muted: dto.muted, thresholds: dto.thresholds },
    });
    return { ok: true };
  }
}
