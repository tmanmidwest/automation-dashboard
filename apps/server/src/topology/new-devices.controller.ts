import { Body, Controller, Get, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { SessionUser } from '@cerebro/shared';
import { RequirePermissions, CurrentUser } from '../auth/decorators';
import { AuditService } from '../logging/audit.service';
import { NewDevicesService, type DeviceReview } from './new-devices.service';
import { TopologyService } from './topology.service';

class ReviewDto {
  @IsIn(['known', 'blocked'])
  status!: DeviceReview;
}

class DeviceTypeDto {
  @IsString()
  instanceId!: string;

  /** Empty or null clears it, going back to UniFi's / Cerebro's guess. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  type?: string | null;
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
    private readonly topology: TopologyService,
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

  @Put(':mac/type')
  @RequirePermissions('connectors:action')
  async setType(@Param('mac') mac: string, @Body() dto: DeviceTypeDto, @CurrentUser() user: SessionUser) {
    if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(mac)) throw new NotFoundException('Not a MAC address.');
    const d = await this.devices.setType(mac, dto.instanceId, dto.type ?? null, user.email);
    this.topology.setDeviceType(d.mac, d.typeOverride);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'devices.type_set', target: `${d.name ?? d.mac} (${d.mac})`, meta: { type: d.typeOverride } });
    return d;
  }

  @Put('settings')
  @RequirePermissions('connectors:write')
  async settings(@Body() dto: DeviceSettingsDto, @CurrentUser() user: SessionUser) {
    const r = await this.devices.setAlertPrivate(dto.alertPrivateMacs);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'devices.settings_updated', meta: { ...r } });
    return r;
  }
}
