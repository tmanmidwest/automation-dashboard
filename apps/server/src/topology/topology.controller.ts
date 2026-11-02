import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { IsInt, Max, Min } from 'class-validator';
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

  @Delete('findings/:id/snooze')
  @RequirePermissions('connectors:action')
  async unsnooze(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    if (!(await this.topology.unsnooze(id))) throw new NotFoundException('That finding is not snoozed.');
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'posture.unsnoozed', meta: { id } });
    return { ok: true };
  }
}
