import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import type { HealthFleet, HealthMachine, HealthRange, HealthSeries, HealthSettings } from '@cerebro/shared';
import { RequirePermissions } from '../auth/decorators';
import { HealthService } from './health.service';

const RANGES: HealthRange[] = ['1h', '24h', '7d', '30d'];

/** Health monitoring API (docs/health-monitoring.md). Not /api/health — that's the container liveness probe. Reads use fabric:read; changes fabric:manage. */
@Controller('api/machine-health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @RequirePermissions('fabric:read')
  fleet(): Promise<HealthFleet> {
    return this.health.fleet();
  }

  @Get('settings')
  @RequirePermissions('fabric:read')
  getSettings(): HealthSettings {
    return this.health.getSettings();
  }

  @Put('settings')
  @RequirePermissions('fabric:manage')
  updateSettings(@Body() body: Partial<HealthSettings>): Promise<HealthSettings> {
    if (!body || typeof body !== 'object') throw new BadRequestException('Body required.');
    return this.health.updateSettings(body);
  }

  @Get(':agentId')
  @RequirePermissions('fabric:read')
  machine(@Param('agentId') agentId: string): Promise<HealthMachine> {
    return this.health.machine(agentId);
  }

  @Get(':agentId/series')
  @RequirePermissions('fabric:read')
  series(@Param('agentId') agentId: string, @Query('range') range?: string): Promise<HealthSeries> {
    const r = (range ?? '24h') as HealthRange;
    if (!RANGES.includes(r)) throw new BadRequestException(`range must be one of ${RANGES.join(', ')}`);
    return this.health.series(agentId, r);
  }

  /** Set (or clear with null) whether this machine is a server or a workstation. */
  @Patch(':agentId')
  @RequirePermissions('fabric:manage')
  setRole(@Param('agentId') agentId: string, @Body() body: { role?: 'server' | 'workstation' | null }): Promise<HealthMachine> {
    if (!body || !('role' in body)) throw new BadRequestException('role is required (server, workstation or null).');
    return this.health.setRole(agentId, body.role ?? null);
  }

  /** Ask the agent for a fresh sample now. */
  @Post(':agentId/refresh')
  @RequirePermissions('fabric:read')
  refresh(@Param('agentId') agentId: string): { requested: boolean } {
    return this.health.refresh(agentId);
  }
}
