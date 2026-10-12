import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, RequirePermissions, SessionOnly } from '../auth/decorators';
import type { SessionUser } from '@cerebro/shared';
import { StackMigrateService } from './stack-migrate.service';
import { IngressService } from '../app-replicator/ingress.service';

/** Automated-cutover ingress (P2): the CF/NPM connector + hostname + port to flip. */
class MigrateIngressDto {
  @IsString() @MaxLength(64) instanceId!: string;
  @IsString() @MaxLength(255) hostname!: string;
  @IsInt() @Min(1) port!: number;
  @IsOptional() @IsString() @MaxLength(128) tunnelId?: string;
  @IsOptional() @IsInt() certificateId?: number;
}

/** Plan/start a stack migration. Mirrors the shapes in @cerebro/shared;
 *  class-validator decorators are required or the global whitelist pipe strips the
 *  field before it reaches the service. */
class MigratePlanDto {
  @IsString() @MaxLength(64) sourceInstanceId!: string;
  @IsString() @MaxLength(255) stackName!: string;
  @IsString() @MaxLength(64) destInstanceId!: string;
  @IsOptional() @IsString() @MaxLength(255) destStackName?: string;
  @IsString() @MaxLength(64) repoTargetId!: string;
  @IsOptional() @IsString() @MaxLength(16) secretMode?: string;
  @IsOptional() @IsString() @MaxLength(16) transfer?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) includeBinds?: string[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => MigrateIngressDto) ingressRoutes?: MigrateIngressDto[];
}

class StartMigrateDto extends MigratePlanDto {
  @IsOptional() @IsString() @MaxLength(256) passphrase?: string;
  @IsOptional() @IsBoolean() force?: boolean;
  @IsOptional() @IsBoolean() quiesceSource?: boolean;
  @IsOptional() @IsBoolean() warmPrecopy?: boolean;
  @IsOptional() @IsBoolean() preRestore?: boolean;
  @IsOptional() @IsObject() bindMap?: Record<string, string>;
  @IsOptional() @IsBoolean() restoreCredentialFiles?: boolean;
  @IsOptional() @IsBoolean() repointReplicator?: boolean;
}

/**
 * Stack migrator — move a Compose stack between Docker hosts (docs/stack-migrator.md).
 * Session-only + `backup:restore`: a migration stops the source and writes a target,
 * exactly the "overwrites data" gate the restore endpoints use.
 */
@Controller('api/stack-migrate')
export class StackMigrateController {
  constructor(
    private readonly migrate: StackMigrateService,
    private readonly ingress: IngressService,
  ) {}

  // Ingress pickers for the automated-cutover form (gated with the migrator's own
  // backup:read, delegating to the shared IngressService — no replicator:read needed).
  @Get('ingress/targets')
  @RequirePermissions('backup:read')
  ingressTargets() {
    return this.ingress.listTargets();
  }

  @Get('ingress/tunnels')
  @RequirePermissions('backup:read')
  ingressTunnels(@Query('instanceId') instanceId: string) {
    return this.ingress.listTunnels(instanceId);
  }

  @Get('ingress/certs')
  @RequirePermissions('backup:read')
  ingressCerts(@Query('instanceId') instanceId: string) {
    return this.ingress.listCerts(instanceId);
  }

  // On-demand "Fetch existing route" for the cutover form: inspects the source stack's
  // published ports and scans the CF/NPM connectors for a matching route to pre-fill.
  @Get('ingress/detect')
  @RequirePermissions('backup:read')
  ingressDetect(@Query('instanceId') instanceId: string, @Query('stackName') stackName: string) {
    return this.migrate.detectIngressForStack(instanceId, stackName);
  }

  @Post('plan')
  @RequirePermissions('backup:read')
  plan(@Body() body: MigratePlanDto) {
    return this.migrate.plan({ ...body, secretMode: body.secretMode as never, transfer: body.transfer as never });
  }

  @Post('start')
  @RequirePermissions('backup:restore')
  @SessionOnly()
  start(@Body() body: StartMigrateDto, @CurrentUser() user: SessionUser) {
    return this.migrate.start({ ...body, secretMode: body.secretMode as never, transfer: body.transfer as never }, { id: user.id, email: user.email });
  }

  @Get('runs')
  @RequirePermissions('backup:read')
  listRuns(@Query('limit') limit?: string) {
    return this.migrate.listRuns(limit ? Number(limit) : undefined);
  }

  @Get('runs/:id')
  @RequirePermissions('backup:read')
  getRun(@Param('id') id: string) {
    return this.migrate.getRun(id);
  }

  @Post('runs/:id/complete')
  @RequirePermissions('backup:restore')
  @SessionOnly()
  complete(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.migrate.complete(id, { id: user.id, email: user.email });
  }

  @Post('runs/:id/rollback')
  @RequirePermissions('backup:restore')
  @SessionOnly()
  rollback(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.migrate.rollback(id, { id: user.id, email: user.email });
  }

  @Post('runs/:id/cancel')
  @RequirePermissions('backup:restore')
  @SessionOnly()
  cancel(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.migrate.cancel(id, { id: user.id, email: user.email });
  }

  @Post('runs/:id/force-fail')
  @RequirePermissions('backup:restore')
  @SessionOnly()
  forceFail(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.migrate.forceFail(id, { id: user.id, email: user.email });
  }
}
