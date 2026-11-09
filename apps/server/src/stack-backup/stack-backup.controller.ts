import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, RequirePermissions, SessionOnly } from '../auth/decorators';
import { BackupTargetService } from './backup-target.service';
import { StackBackupService } from './stack-backup.service';
import { StackRestoreService } from './stack-restore.service';
import { StackBackupSetService } from './stack-backup-set.service';
import type {
  AddSetMembersInput, IgnoreStackInput, SaveBackupSetInput,
  BindSecretInput, ExecuteRestoreInput, RestorePlanInput, RunBackupInput, SaveBackupPolicyInput,
  SaveBackupTargetInput, SessionUser, VerifyRestoreInput,
} from '@cerebro/shared';

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
    private readonly restores: StackRestoreService,
    private readonly sets: StackBackupSetService,
  ) {}

  // ── Coverage ──
  /** Every compose stack on every Docker host, and how well each one is backed up. */
  @Get('coverage')
  @RequirePermissions('backup:read')
  coverage() {
    return this.sets.coverage();
  }

  /** Mark a stack as not needing a backup (or undo it). */
  @Put('coverage/:instanceId/:stackName/ignore')
  @RequirePermissions('backup:write')
  @SessionOnly()
  async ignore(@Param('instanceId') instanceId: string, @Param('stackName') stackName: string, @Body() body: IgnoreStackInput) {
    await this.sets.setIgnored(instanceId, stackName, body ?? { ignored: true });
    return { ok: true };
  }

  // ── Backup sets ──
  @Get('sets')
  @RequirePermissions('backup:read')
  listSets() {
    return this.sets.listSets();
  }

  @Get('sets/:id')
  @RequirePermissions('backup:read')
  getSet(@Param('id') id: string) {
    return this.sets.getSet(id);
  }

  @Post('sets')
  @RequirePermissions('backup:write')
  @SessionOnly()
  createSet(@Body() body: SaveBackupSetInput) {
    return this.sets.saveSet(null, body);
  }

  @Put('sets/:id')
  @RequirePermissions('backup:write')
  @SessionOnly()
  updateSet(@Param('id') id: string, @Body() body: SaveBackupSetInput) {
    return this.sets.saveSet(id, body);
  }

  /** Delete a set. Its stacks keep their backups as standalone ones. */
  @Delete('sets/:id')
  @RequirePermissions('backup:write')
  @SessionOnly()
  async deleteSet(@Param('id') id: string) {
    await this.sets.deleteSet(id);
    return { ok: true };
  }

  @Post('sets/:id/members')
  @RequirePermissions('backup:write')
  @SessionOnly()
  addMembers(@Param('id') id: string, @Body() body: AddSetMembersInput) {
    return this.sets.addMembers(id, body);
  }

  /** `?mode=delete` also removes the stack's backup configuration; default keeps it standalone. */
  @Delete('sets/:id/members/:policyId')
  @RequirePermissions('backup:write')
  @SessionOnly()
  removeMember(@Param('id') id: string, @Param('policyId') policyId: string, @Query('mode') mode?: string) {
    return this.sets.removeMember(id, policyId, mode === 'delete' ? 'delete' : 'keep');
  }

  @Post('sets/:id/sync')
  @RequirePermissions('backup:write')
  @SessionOnly()
  syncSet(@Param('id') id: string) {
    return this.sets.syncSet(id);
  }

  @Post('sets/:id/run')
  @RequirePermissions('backup:write')
  @SessionOnly()
  runSet(@Param('id') id: string) {
    return this.sets.runSet(id);
  }

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

  // ── Hosts & candidates ──
  @Get('hosts')
  @RequirePermissions('backup:read')
  hosts() {
    return this.backups.hosts();
  }

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

  // ── Secret bindings ──
  /** What the vault knows about a stack's credentials — live off the host. */
  @Get('secrets/:instanceId/:stackName')
  @RequirePermissions('backup:read')
  stackSecrets(@Param('instanceId') instanceId: string, @Param('stackName') stackName: string) {
    return this.backups.secretsReport(instanceId, stackName);
  }

  /** Bind a variable to a vault key, optionally promoting its live value first. */
  @Post('secrets/:instanceId/:stackName/bind')
  @RequirePermissions('backup:write')
  @SessionOnly()
  bindSecret(
    @Param('instanceId') instanceId: string,
    @Param('stackName') stackName: string,
    @Body() body: BindSecretInput,
    @CurrentUser() user: SessionUser,
  ) {
    return this.backups.bindSecret(instanceId, stackName, body, { actorId: user.id, actorEmail: user.email });
  }

  @Delete('secrets/:instanceId/:stackName/bind/:varName')
  @RequirePermissions('backup:write')
  @SessionOnly()
  unbindSecret(
    @Param('instanceId') instanceId: string,
    @Param('stackName') stackName: string,
    @Param('varName') varName: string,
  ) {
    return this.backups.unbindSecret(instanceId, stackName, varName);
  }

  /** The vault's reverse index: which stacks reference each key. */
  @Get('secret-usage')
  @RequirePermissions('backup:read')
  secretUsage() {
    return this.backups.secretUsage();
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

  // ── Snapshots ──
  @Get('targets/:targetId/snapshots')
  @RequirePermissions('backup:read')
  snapshots(
    @Param('targetId') targetId: string,
    @Query('stack') stack?: string,
    @Query('host') host?: string,
  ) {
    return this.restores.listSnapshots(targetId, stack, host);
  }

  @Get('targets/:targetId/snapshots/:snapshotId/browse')
  @RequirePermissions('backup:read')
  browse(
    @Param('targetId') targetId: string,
    @Param('snapshotId') snapshotId: string,
    @Query('path') path?: string,
  ) {
    return this.restores.browse(targetId, snapshotId, path);
  }

  // ── Restore ──
  /** Dry run: resolves the snapshot against the destination and reports conflicts.
   *  Writes nothing, which is why it is a read permission with a POST body. */
  @Post('restore/plan')
  @RequirePermissions('backup:read')
  @SessionOnly()
  plan(@Body() body: RestorePlanInput) {
    return this.restores.plan(body);
  }

  @Post('restore')
  @RequirePermissions('backup:restore')
  @SessionOnly()
  restore(@Body() body: ExecuteRestoreInput) {
    return this.restores.start(body);
  }

  /**
   * Prove a snapshot restores: bring it up in a throwaway sandbox with no
   * published ports, health-check it, tear it down. Gated on backup:restore —
   * it runs real containers on a real host.
   */
  @Post('restore/verify')
  @RequirePermissions('backup:restore')
  @SessionOnly()
  verify(@Body() body: VerifyRestoreInput) {
    return this.restores.startVerify(body);
  }

  /** Download one file out of a snapshot. backup:restore — it hands back stack data. */
  @Get('targets/:targetId/snapshots/:snapshotId/file')
  @RequirePermissions('backup:restore')
  @SessionOnly()
  async downloadFile(
    @Param('targetId') targetId: string,
    @Param('snapshotId') snapshotId: string,
    @Query('path') path: string,
    @Res() res: Response,
  ) {
    if (!path) throw new BadRequestException('A path is required.');
    const file = await this.restores.readSnapshotFile(targetId, snapshotId, path);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.send(file.content);
  }

  @Get('restores')
  @RequirePermissions('backup:read')
  listRestores(@Query('limit') limit?: string) {
    return this.restores.listRuns(limit ? Number(limit) : undefined);
  }

  @Get('restores/:id')
  @RequirePermissions('backup:read')
  getRestore(@Param('id') id: string) {
    return this.restores.getRun(id);
  }
}
