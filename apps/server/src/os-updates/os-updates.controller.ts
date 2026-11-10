import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import type {
  OsUpdateInstallRequest,
  OsUpdateMachineDetail,
  OsUpdateOverview,
  OsUpdateRebootRequest,
  OsUpdateRun,
  OsUpdateSchedule,
  SessionUser,
} from '@cerebro/shared';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { OsUpdatesService } from './os-updates.service';

/** OS updates API (docs/os-updates.md). Reads use fabric:read; installs, restarts and schedules fabric:manage. */
@Controller('api/os-updates')
export class OsUpdatesController {
  constructor(private readonly updates: OsUpdatesService) {}

  @Get()
  @RequirePermissions('fabric:read')
  overview(): Promise<OsUpdateOverview> {
    return this.updates.overview();
  }

  @Get('machines/:agentId')
  @RequirePermissions('fabric:read')
  machine(@Param('agentId') agentId: string): Promise<OsUpdateMachineDetail> {
    return this.updates.machineDetail(agentId);
  }

  /** Ask the agent to look for updates now (read-only on the machine). */
  @Post('machines/:agentId/check')
  @RequirePermissions('fabric:read')
  check(@Param('agentId') agentId: string): { requested: boolean } {
    return this.updates.check(agentId);
  }

  @Post('install')
  @RequirePermissions('fabric:manage')
  install(@Body() body: OsUpdateInstallRequest, @CurrentUser() user: SessionUser) {
    return this.updates.requestInstall(body, user);
  }

  @Post('reboot')
  @RequirePermissions('fabric:manage')
  reboot(@Body() body: OsUpdateRebootRequest, @CurrentUser() user: SessionUser) {
    return this.updates.requestReboot(body, user);
  }

  @Get('runs/:id')
  @RequirePermissions('fabric:read')
  run(@Param('id') id: string): Promise<OsUpdateRun> {
    return this.updates.run(id);
  }

  @Post('runs/:id/cancel')
  @RequirePermissions('fabric:manage')
  cancel(@Param('id') id: string, @CurrentUser() user: SessionUser): Promise<OsUpdateRun> {
    return this.updates.cancel(id, user);
  }

  @Get('schedules')
  @RequirePermissions('fabric:read')
  schedules(): Promise<OsUpdateSchedule[]> {
    return this.updates.listSchedules();
  }

  @Post('schedules')
  @RequirePermissions('fabric:manage')
  createSchedule(@Body() body: unknown, @CurrentUser() user: SessionUser): Promise<OsUpdateSchedule> {
    return this.updates.createSchedule(body, user);
  }

  @Put('schedules/:id')
  @RequirePermissions('fabric:manage')
  updateSchedule(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: SessionUser): Promise<OsUpdateSchedule> {
    return this.updates.updateSchedule(id, body, user);
  }

  @Delete('schedules/:id')
  @RequirePermissions('fabric:manage')
  deleteSchedule(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.updates.deleteSchedule(id, user);
  }

  @Post('schedules/:id/run-now')
  @RequirePermissions('fabric:manage')
  runNow(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.updates.runScheduleNow(id, user);
  }
}
