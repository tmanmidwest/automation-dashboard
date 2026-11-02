import { Body, Controller, Get, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { IsBoolean, IsIn } from 'class-validator';
import type { SessionUser } from '@cerebro/shared';
import { RequirePermissions, CurrentUser } from '../auth/decorators';
import { AuditService } from '../logging/audit.service';
import { NewDevicesService, type DeviceReview } from './new-devices.service';

class ReviewDto {
  @IsIn(['known', 'blocked'])
  status!: DeviceReview;
}

class DeviceSettingsDto {
  @IsBoolean()
  alertPrivateMacs!: boolean;
}

/** Network clients Cerebro has seen; "new" ones are waiting for review. */
@Controller('api/devices')
export class NewDevicesController {
  constructor(
    private readonly devices: NewDevicesService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('connectors:read')
  list(@Query('status') status?: string) {
    return this.devices.list(status === 'new' || status === 'known' || status === 'blocked' ? status : undefined);
  }

  @Post('review-all')
  @RequirePermissions('connectors:action')
  async reviewAll(@CurrentUser() user: SessionUser) {
    const r = await this.devices.reviewAllNew(user.email);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'devices.reviewed_all', meta: { count: r.count } });
    return r;
  }

  @Post(':mac/review')
  @RequirePermissions('connectors:action')
  async review(@Param('mac') mac: string, @Body() dto: ReviewDto, @CurrentUser() user: SessionUser) {
    try {
      const d = await this.devices.review(mac, dto.status, user.email);
      await this.audit.record({ actorId: user.id, actorEmail: user.email, action: `devices.marked_${dto.status}`, target: `${d.name ?? d.mac} (${d.mac})` });
      return d;
    } catch {
      throw new NotFoundException('That device is not in the list.');
    }
  }

  @Put('settings')
  @RequirePermissions('connectors:write')
  async settings(@Body() dto: DeviceSettingsDto, @CurrentUser() user: SessionUser) {
    const r = await this.devices.setAlertPrivate(dto.alertPrivateMacs);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'devices.settings_updated', meta: { ...r } });
    return r;
  }
}
