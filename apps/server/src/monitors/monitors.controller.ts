import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { tmpdir } from 'os';
import { unlink } from 'fs/promises';
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { MonitorChartRange, SessionUser } from '@cerebro/shared';
import { MonitorsService } from './monitors.service';
import { ProbeRegistry } from './probe-registry.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../logging/audit.service';
import { RequirePermissions, CurrentUser } from '../auth/decorators';

class MonitorDto {
  @IsString() @MaxLength(120) name!: string;
  @IsString() type!: string;
  @IsObject() config!: Record<string, unknown>;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsInt() @Min(1) @Max(86400) intervalSec!: number;
  @IsInt() @Min(0) @Max(10) retries!: number;
  @IsInt() @Min(1) @Max(86400) retryIntervalSec!: number;
  @IsInt() @Min(1) @Max(300) timeoutSec!: number;
  @IsInt() @Min(0) @Max(1000) resendEveryN!: number;
  @IsBoolean() upsideDown!: boolean;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
}

/** The subset of multer's file object we use (avoids a @types/multer dependency). */
interface UploadedTempFile {
  path: string;
  size: number;
  originalname: string;
}

class EnabledDto {
  @IsBoolean() enabled!: boolean;
}

class MutesDto {
  @IsArray() @IsString({ each: true }) muted!: string[];
}

class ImportDto {
  /** The parsed Kuma backup JSON (object with monitorList). */
  @IsObject() backup!: Record<string, unknown>;
}

@Controller('api/monitors')
export class MonitorsController {
  constructor(
    private readonly monitors: MonitorsService,
    private readonly probes: ProbeRegistry,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  @Get('types')
  @RequirePermissions('monitors:read')
  types() {
    return this.probes.manifests();
  }

  @Get('stats')
  @RequirePermissions('monitors:read')
  stats() {
    return this.monitors.stats();
  }

  @Get()
  @RequirePermissions('monitors:read')
  list() {
    return this.monitors.list();
  }

  @Post()
  @RequirePermissions('monitors:write')
  async create(@Body() dto: MonitorDto, @CurrentUser() user: SessionUser) {
    const m = await this.monitors.create(dto);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'monitor.created', target: m.id, meta: { name: m.name, type: m.type } });
    return m;
  }

  @Post('import/kuma')
  @RequirePermissions('monitors:write')
  async importKuma(@Body() dto: ImportDto, @CurrentUser() user: SessionUser) {
    const r = await this.monitors.importKuma(dto.backup);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'monitor.imported', meta: { imported: r.imported, skipped: r.skipped.length } });
    return r;
  }

  /**
   * Import straight from Kuma's SQLite database (`data/kuma.db`). Multipart
   * field "file". Streamed to a temp file by multer (the DB can be hundreds of
   * MB of heartbeats), read once, then deleted.
   */
  @Post('import/kuma-db')
  @RequirePermissions('monitors:write')
  @UseInterceptors(FileInterceptor('file', { dest: tmpdir(), limits: { fileSize: 4 * 1024 * 1024 * 1024 } }))
  async importKumaDb(@UploadedFile() file: UploadedTempFile | undefined, @CurrentUser() user: SessionUser) {
    if (!file?.path) throw new BadRequestException('Upload the kuma.db file in the "file" field.');
    try {
      const r = await this.monitors.importKumaDb(file.path);
      await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'monitor.imported', meta: { source: 'kuma.db', imported: r.imported, skipped: r.skipped.length } });
      return r;
    } finally {
      await unlink(file.path).catch(() => {});
    }
  }

  @Get(':id')
  @RequirePermissions('monitors:read')
  get(@Param('id') id: string) {
    return this.monitors.get(id);
  }

  @Put(':id')
  @RequirePermissions('monitors:write')
  async update(@Param('id') id: string, @Body() dto: MonitorDto, @CurrentUser() user: SessionUser) {
    const m = await this.monitors.update(id, dto);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'monitor.updated', target: id, meta: { name: m.name } });
    return m;
  }

  @Patch(':id/enabled')
  @RequirePermissions('monitors:write')
  async setEnabled(@Param('id') id: string, @Body() dto: EnabledDto, @CurrentUser() user: SessionUser) {
    const m = await this.monitors.setEnabled(id, dto.enabled);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: dto.enabled ? 'monitor.resumed' : 'monitor.paused', target: id, meta: { name: m.name } });
    return m;
  }

  @Delete(':id')
  @RequirePermissions('monitors:write')
  async remove(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    await this.monitors.remove(id);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'monitor.deleted', target: id });
    return { ok: true };
  }

  @Post(':id/check')
  @RequirePermissions('monitors:write')
  check(@Param('id') id: string) {
    return this.monitors.checkNow(id);
  }

  @Get(':id/chart')
  @RequirePermissions('monitors:read')
  chart(@Param('id') id: string, @Query('range') range?: string) {
    const r = (['1h', '24h', '7d', '30d'].includes(range ?? '') ? range : '24h') as MonitorChartRange;
    return this.monitors.chart(id, r);
  }

  @Get(':id/events')
  @RequirePermissions('monitors:read')
  events(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.monitors.events(id, limit ? parseInt(limit, 10) || 100 : 100);
  }

  // ── Per-monitor alert muting (inherits the global alert rules) ──

  @Get(':id/alerts')
  @RequirePermissions('monitors:read')
  async alerts(@Param('id') id: string) {
    await this.monitors.get(id);
    return this.notifications.getMonitorAlerts(id);
  }

  @Put(':id/alerts')
  @RequirePermissions('monitors:write')
  async saveAlerts(@Param('id') id: string, @Body() dto: MutesDto, @CurrentUser() user: SessionUser) {
    await this.monitors.get(id);
    await this.notifications.saveMonitorMutes(id, dto.muted);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'monitor.alerts_updated', target: id, meta: { muted: dto.muted } });
    return { ok: true };
  }
}
