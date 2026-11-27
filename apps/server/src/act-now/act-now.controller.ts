import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { ActNowList, ActNowSummary, SessionUser } from '@cerebro/shared';
import { CurrentUser } from '../auth/decorators';
import { AuditService } from '../logging/audit.service';
import { ActNowService } from './act-now.service';

class SnoozeDto {
  @IsString()
  @MaxLength(500)
  key!: string;

  @IsInt()
  @Min(1)
  @Max(90)
  days!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/**
 * Act Now worklist (docs/act-now.md). Open to anyone signed in; each source is read only
 * with its own permission (fabric:read updates, connectors:read posture, backup:read backups).
 */
@Controller('api/act-now')
export class ActNowController {
  constructor(
    private readonly actNow: ActNowService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@CurrentUser() user: SessionUser, @Query('refresh') refresh?: string): Promise<ActNowList> {
    return this.actNow.list(user, { fresh: refresh === '1' });
  }

  /** Counts and the top three, for the sidebar badge and the Dashboard tile. */
  @Get('summary')
  summary(@CurrentUser() user: SessionUser): Promise<ActNowSummary> {
    return this.actNow.summary(user);
  }

  /** Snooze an update or backup item (needs fabric:manage or backup:write, checked per item). */
  @Post('snooze')
  async snooze(@Body() dto: SnoozeDto, @CurrentUser() user: SessionUser) {
    const r = await this.actNow.snooze(user, dto.key, dto.days, dto.note);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'act-now.snoozed', target: dto.key, meta: { days: dto.days, note: dto.note ?? null } });
    return r;
  }

  @Delete('snooze/:key')
  async unsnooze(@Param('key') key: string, @CurrentUser() user: SessionUser) {
    const r = await this.actNow.unsnooze(user, key);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'act-now.reopened', target: key });
    return r;
  }
}
