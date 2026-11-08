import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { IsBoolean, IsInt, Max, Min } from 'class-validator';
import type { SessionUser } from '@cerebro/shared';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { AuditService } from '../logging/audit.service';
import { TopologyService } from './topology.service';

class SnoozeDto {
  @IsInt()
  @Min(1)
  @Max(365)
  days!: number;
}

class OutsideInDto {
  @IsBoolean()
  enabled!: boolean;
}

/** Read-only architecture map. `?refresh=1` re-reads every source live instead of the cache. */
@Controller('api/topology')
export class TopologyController {
  constructor(
    private readonly topology: TopologyService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('connectors:read')
  get(@Query('refresh') refresh?: string) {
    return this.topology.graph(refresh === '1' || refresh === 'true');
  }

  /** Hide a posture finding for a while (it comes back early if it gains new items). */
  @Post('findings/:id/snooze')
  @RequirePermissions('connectors:action')
  async snooze(@Param('id') id: string, @Body() dto: SnoozeDto, @CurrentUser() user: SessionUser) {
    const f = await this.topology.snooze(id, dto.days);
    if (!f) throw new NotFoundException('That finding is no longer open.');
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'posture.snoozed', target: f.title, meta: { id, days: dto.days } });
    return f;
  }

  /** Outside-in checks (Shodan InternetDB, CISA KEV, endoflife.date): on by default. */
  @Put('outside-in')
  @RequirePermissions('connectors:write')
  async outsideIn(@Body() dto: OutsideInDto, @CurrentUser() user: SessionUser) {
    await this.topology.setOutsideIn(dto.enabled);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: dto.enabled ? 'posture.outside_in_enabled' : 'posture.outside_in_disabled' });
    return { enabled: dto.enabled };
  }

  /** Container image CVE scan (Trivy, nightly): on by default. */
  @Put('image-scan')
  @RequirePermissions('connectors:write')
  async imageScan(@Body() dto: OutsideInDto, @CurrentUser() user: SessionUser) {
    await this.topology.setImageScan(dto.enabled);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: dto.enabled ? 'posture.image_scan_enabled' : 'posture.image_scan_disabled' });
    return { enabled: dto.enabled };
  }

  /** Scan every running image now instead of waiting for the nightly run. */
  @Post('image-scan')
  @RequirePermissions('connectors:action')
  async scanNow(@CurrentUser() user: SessionUser) {
    await this.topology.scanImagesNow();
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'posture.image_scan_started' });
    return { started: true };
  }

  @Delete('findings/:id/snooze')
  @RequirePermissions('connectors:action')
  async unsnooze(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    if (!(await this.topology.unsnooze(id))) throw new NotFoundException('That finding is not snoozed.');
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'posture.unsnoozed', meta: { id } });
    return { ok: true };
  }
}
