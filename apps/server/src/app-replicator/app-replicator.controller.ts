import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser, RequirePermissions, SessionOnly } from '../auth/decorators';
import { ReplicatorService } from './replicator.service';
import { DeploymentService } from './deployment.service';
import type {
  SessionUser, IntrospectRepoInput, RegisterAppInput, DeployInput,
} from '@cerebro/shared';

/**
 * App Replicator: register Git-repo apps and deploy them as isolated instances
 * onto a Docker host. Write routes are session-only (deploying runs infra — never
 * a bearer-token capability). See docs/app-replicator.md.
 */
@Controller('api/replicator')
export class AppReplicatorController {
  constructor(
    private readonly replicator: ReplicatorService,
    private readonly deployments: DeploymentService,
  ) {}

  // ── Catalog ──
  @Get('apps')
  @RequirePermissions('replicator:read')
  listApps() {
    return this.replicator.listApps();
  }

  @Get('apps/:id')
  @RequirePermissions('replicator:read')
  getApp(@Param('id') id: string) {
    return this.replicator.getApp(id);
  }

  @Post('introspect')
  @RequirePermissions('replicator:write')
  @SessionOnly()
  introspect(@Body() body: IntrospectRepoInput) {
    return this.replicator.introspect(body);
  }

  @Post('apps')
  @RequirePermissions('replicator:write')
  @SessionOnly()
  register(@Body() body: RegisterAppInput) {
    return this.replicator.registerApp(body);
  }

  @Patch('apps/:id')
  @RequirePermissions('replicator:write')
  @SessionOnly()
  update(@Param('id') id: string, @Body() body: Partial<RegisterAppInput>) {
    return this.replicator.updateApp(id, body);
  }

  @Delete('apps/:id')
  @RequirePermissions('replicator:write')
  @SessionOnly()
  async removeApp(@Param('id') id: string) {
    await this.replicator.removeApp(id);
    return { ok: true };
  }

  // ── Targets / deploy planning ──
  @Get('targets')
  @RequirePermissions('replicator:read')
  targets() {
    return this.replicator.listTargets();
  }

  @Post('apps/:id/plan')
  @RequirePermissions('replicator:read')
  async plan(@Param('id') id: string, @Body() body: { dockerInstanceId: string }) {
    const app = await this.replicator.getApp(id);
    return this.deployments.targetInfo(body.dockerInstanceId, app.variables);
  }

  // ── Deployments ──
  @Get('deployments')
  @RequirePermissions('replicator:read')
  listAll() {
    return this.deployments.listAll();
  }

  @Get('apps/:id/deployments')
  @RequirePermissions('replicator:read')
  listForApp(@Param('id') id: string) {
    return this.deployments.listForApp(id);
  }

  @Post('apps/:id/deploy')
  @RequirePermissions('replicator:write')
  @SessionOnly()
  deploy(@Param('id') id: string, @Body() body: DeployInput, @CurrentUser() user: SessionUser) {
    return this.deployments.deploy(id, body, { actorId: user.id, actorEmail: user.email });
  }

  @Post('deployments/:id/redeploy')
  @RequirePermissions('replicator:write')
  @SessionOnly()
  redeploy(@Param('id') id: string, @Body() body: { forceRebuild?: boolean }, @CurrentUser() user: SessionUser) {
    return this.deployments.redeploy(id, body ?? {}, { actorId: user.id, actorEmail: user.email });
  }

  @Get('deployments/:id/check-update')
  @RequirePermissions('replicator:read')
  checkUpdate(@Param('id') id: string) {
    return this.deployments.checkUpdate(id);
  }

  @Delete('deployments/:id')
  @RequirePermissions('replicator:write')
  @SessionOnly()
  remove(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.deployments.remove(id, { actorId: user.id, actorEmail: user.email });
  }
}
