import { Body, Controller, Get, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import type { SessionUser, ViewscreenConfig } from '@cerebro/shared';
import { SettingsService } from './settings.service';
import { AuditService } from '../logging/audit.service';
import { RequirePermissions, CurrentUser } from '../auth/decorators';

/** Global setting key holding the Viewscreen camera-wall layout. */
const KEY = 'viewscreen.cameras';
const DEFAULT: ViewscreenConfig = { cameras: [], columns: 3 };

class CameraDto {
  @IsString() id!: string;
  @IsString() instanceId!: string;
  @IsString() entityId!: string;
  @IsString() name!: string;
  @IsIn(['mjpeg', 'snapshot']) mode!: 'mjpeg' | 'snapshot';
}

class ViewscreenConfigDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => CameraDto) cameras!: CameraDto[];
  @IsOptional() @IsInt() @Min(1) @Max(6) columns?: number;
}

/**
 * Read/write the Viewscreen layout — the curated set of camera tiles and grid
 * width. Stored globally (there is no per-user settings table today), so every
 * operator sees the same wall. Reading needs connectors:read; editing needs
 * connectors:write, matching the rest of the connector surface.
 */
@Controller('api/settings/viewscreen')
export class ViewscreenController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('connectors:read')
  async get(): Promise<ViewscreenConfig> {
    return (await this.settings.get<ViewscreenConfig>(KEY, DEFAULT)) ?? DEFAULT;
  }

  @Put()
  @RequirePermissions('connectors:write')
  async put(@Body() dto: ViewscreenConfigDto, @CurrentUser() user: SessionUser): Promise<ViewscreenConfig> {
    const config: ViewscreenConfig = { cameras: dto.cameras, columns: dto.columns ?? 3 };
    await this.settings.set(KEY, config);
    await this.audit.record({
      actorId: user.id, actorEmail: user.email,
      action: 'viewscreen.updated', target: 'viewscreen.cameras',
      meta: { count: config.cameras.length },
    });
    return config;
  }
}
