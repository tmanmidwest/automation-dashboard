import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, RequirePermissions, SessionOnly } from '../auth/decorators';
import { BackupTargetService } from './backup-target.service';
import { StackBackupService } from './stack-backup.service';
import type { RunBackupInput, SaveBackupPolicyInput, SaveBackupTargetInput, SessionUser } from '@cerebro/shared';

/**
 * Stack backup & restore. Writes are session-only: configuring a target stores
 * credentials in the vault, and starting a backup runs a container on a Docker
 * host — neither is a bearer-token capability. See docs/stack-backup.md.
 */
@Controller('api/stack-backup')
export class StackBackupController {
  constructor(
    private readonly targets: BackupTargetService,
    private readonly backups: StackBackupService,
  ) {}

  // ── Targets ──
  @Get('targets')
  @RequirePermissions('backup:read')
  listTargets() {
    return this.targets.list();
  }

  @Post('targets')
  @RequirePermissions('backup:write')
  @SessionOnly()
  createTarget(@Body() body: SaveBackupTargetInput, @CurrentUser() user: SessionUser) {
    return this.targets.create(body, { actorId: user.id, actorEmail: user.email });
  }

  @Put('targets/:id')
  @RequirePermissions('backup:write')
  @SessionOnly()
  updateTarget(@Param('id') id: string, @Body() body: SaveBackupTargetInput, @CurrentUser() user: SessionUser) {
    return this.targets.update(id, body, { actorId: user.id, actorEmail: user.email });
  }

  @Delete('targets/:id')
  @RequirePermissions('backup:write')
  @SessionOnly()
  async removeTarget(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    await this.targets.remove(id, { actorId: user.id, actorEmail: user.email });
    return { ok: true };
  }

  /** Open the repository. `?init=1` creates it when it does not exist yet. */
  @Post('targets/:id/check')
  @RequirePermissions('backup:write')
  @SessionOnly()
  checkTarget(@Param('id') id: string, @Query('init') init?: string) {
    return this.targets.check(id, init === '1' || init === 'true');
  }

  // ── Candidates ──
  @Get('candidates')
  @RequirePermissions('backup:read')
  candidates() {
    return this.backups.candidates();
  }

  @Get('candidates/:instanceId/:stackName')
  @RequirePermissions('backup:read')
  candidate(@Param('instanceId') instanceId: string, @Param('stackName') stackName: string) {
    return this.backups.inspectCandidate(instanceId, stackName);
  }

  // ── Policies ──
  @Get('policies')
  @RequirePermissions('backup:read')
  listPolicies() {
    return this.backups.listPolicies();
  }

  @Post('policies')
  @RequirePermissions('backup:write')
  @SessionOnly()
  savePolicy(@Body() body: SaveBackupPolicyInput) {
    return this.backups.savePolicy(body);
  }

  @Delete('policies/:id')
  @RequirePermissions('backup:write')
  @SessionOnly()
  async removePolicy(@Param('id') id: string) {
    await this.backups.removePolicy(id);
    return { ok: true };
  }

  @Post('policies/:id/run')
  @RequirePermissions('backup:write')
  @SessionOnly()
  run(@Param('id') id: string, @Body() body: RunBackupInput) {
    return this.backups.startBackup(id, body?.passphrase, 'manual');
  }

  // ── Runs ──
  @Get('runs')
  @RequirePermissions('backup:read')
  listRuns(@Query('policyId') policyId?: string, @Query('limit') limit?: string) {
    return this.backups.listRuns(policyId, limit ? Number(limit) : undefined);
  }

  @Get('runs/:id')
  @RequirePermissions('backup:read')
  getRun(@Param('id') id: string) {
    return this.backups.getRun(id);
  }
}
