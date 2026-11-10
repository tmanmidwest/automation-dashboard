import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { SessionUser } from '@cerebro/shared';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { AuditService } from '../logging/audit.service';
import { PostureTrackingService, type ItemAction } from './posture-tracking.service';
import { TopologyService } from './topology.service';

class ItemsDto {
  @IsIn(['snooze', 'accept', 'reopen'])
  action!: ItemAction;

  /** Affected item labels; empty or missing = every open item (or every set-aside one, to reopen). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  labels?: string[];

  /** Snooze length, or how long an acceptance lasts (missing = until something changes). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;

  /** Why the risk is acceptable (shown on the item and in its history). */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/**
 * The Posture page: open findings come from GET /api/topology (with per-item state); this adds
 * fixed findings, history, and per-item snooze / accept risk / reopen. See docs/posture.md.
 */
@Controller('api/posture')
export class PostureController {
  constructor(
    private readonly tracking: PostureTrackingService,
    private readonly topology: TopologyService,
    private readonly audit: AuditService,
  ) {}

  /** Findings no longer found in the last `days` days (default 30). */
  @Get('fixed')
  @RequirePermissions('connectors:read')
  fixed(@Query('days') days?: string) {
    const n = Math.min(365, Math.max(1, Number(days) || 30));
    return this.tracking.fixed(n);
  }

  @Get('findings/:id/history')
  @RequirePermissions('connectors:read')
  history(@Param('id') id: string) {
    return this.tracking.history(id);
  }

  @Post('findings/:id/items')
  @RequirePermissions('connectors:action')
  async items(@Param('id') id: string, @Body() dto: ItemsDto, @CurrentUser() user: SessionUser) {
    const f = (await this.topology.graph()).findings?.find((x) => x.id === id);
    if (!f) throw new NotFoundException('That finding is no longer open.');
    const changed = await this.tracking.setItems(id, dto.labels ?? [], dto.action, {
      days: dto.days,
      note: dto.note,
      actor: user.displayName || user.email,
      severity: f.severity,
    });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: dto.action === 'snooze' ? 'posture.snoozed' : dto.action === 'accept' ? 'posture.risk_accepted' : 'posture.reopened',
      target: f.title,
      meta: { id, labels: dto.labels ?? 'all', days: dto.days ?? null, note: dto.note ?? null },
    });
    return { changed, finding: (await this.topology.graph()).findings?.find((x) => x.id === id) ?? null };
  }
}
