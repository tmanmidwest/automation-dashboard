import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';
import type { ConnectorJobStatus } from '@cerebro/shared';
import type {
  ConnectorInstanceConfig,
  ConnectorInstanceSummary,
  ConnectorManifest,
  SessionUser,
} from '@cerebro/shared';
import { ConnectorRegistry } from './connector-registry.service';
import { ConnectorInstanceService } from './connector-instance.service';
import { AuditService } from '../logging/audit.service';
import { RequirePermissions, CurrentUser } from '../auth/decorators';
import type { ConnectorInstance } from '@prisma/client';

class CreateInstanceDto {
  @IsString() connectorId!: string;
  @IsString() name!: string;
  @IsObject() values!: Record<string, unknown>;
}
class UpdateInstanceDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsObject() values?: Record<string, unknown>;
}
class EnabledDto {
  @IsBoolean() enabled!: boolean;
}
class OptionsDto {
  @IsString() sourceId!: string;
  @IsObject() values!: Record<string, unknown>;
}
class RunOperationDto {
  @IsOptional() @IsString() resourceId?: string;
  @IsObject() values!: Record<string, unknown>;
}

@Controller('api/connectors')
export class ConnectorsController {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly instances: ConnectorInstanceService,
    private readonly audit: AuditService,
  ) {}

  private summary(inst: ConnectorInstance): ConnectorInstanceSummary {
    const manifest = this.registry.get(inst.connectorId)?.manifest;
    return {
      id: inst.id,
      connectorId: inst.connectorId,
      connectorName: manifest?.name ?? inst.connectorId,
      icon: manifest?.icon ?? 'generic',
      name: inst.name,
      enabled: inst.enabled,
      createdAt: inst.createdAt.toISOString(),
    };
  }

  // ── Available connectors (from the extension host) ──

  @Get('available')
  @RequirePermissions('connectors:read')
  available(): ConnectorManifest[] {
    return this.registry.manifests();
  }

  @Get('available/:connectorId')
  @RequirePermissions('connectors:read')
  manifest(@Param('connectorId') connectorId: string): ConnectorManifest {
    const connector = this.registry.get(connectorId);
    if (!connector) throw new NotFoundException('Connector not found.');
    return connector.manifest;
  }

  // ── Installed instances ──

  @Get('instances')
  @RequirePermissions('connectors:read')
  async list(): Promise<ConnectorInstanceSummary[]> {
    const rows = await this.instances.list();
    return rows.map((r) => this.summary(r));
  }

  @Get('instances/:id')
  @RequirePermissions('connectors:read')
  async getOne(@Param('id') id: string): Promise<ConnectorInstanceConfig> {
    const inst = await this.instances.get(id);
    return {
      ...this.summary(inst),
      config: inst.config as Record<string, unknown>,
      secretFieldsSet: await this.instances.secretFieldsSet(inst),
    };
  }

  @Post('instances')
  @RequirePermissions('connectors:write')
  async create(@Body() dto: CreateInstanceDto, @CurrentUser() user: SessionUser) {
    const inst = await this.instances.create(dto.connectorId, dto.name, dto.values);
    await this.audit.record({
      actorId: user.id, actorEmail: user.email,
      action: 'connectors.instance_created', target: inst.name,
      meta: { connectorId: dto.connectorId },
    });
    return this.summary(inst);
  }

  @Put('instances/:id')
  @RequirePermissions('connectors:write')
  async update(@Param('id') id: string, @Body() dto: UpdateInstanceDto, @CurrentUser() user: SessionUser) {
    const inst = await this.instances.update(id, { name: dto.name, values: dto.values });
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'connectors.instance_updated', target: inst.name });
    return this.summary(inst);
  }

  @Patch('instances/:id/enabled')
  @RequirePermissions('connectors:write')
  async setEnabled(@Param('id') id: string, @Body() dto: EnabledDto, @CurrentUser() user: SessionUser) {
    const inst = await this.instances.update(id, { enabled: dto.enabled });
    await this.audit.record({
      actorId: user.id, actorEmail: user.email,
      action: dto.enabled ? 'connectors.instance_enabled' : 'connectors.instance_disabled', target: inst.name,
    });
    return this.summary(inst);
  }

  @Delete('instances/:id')
  @RequirePermissions('connectors:write')
  async remove(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    const inst = await this.instances.get(id);
    await this.instances.remove(id);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'connectors.instance_deleted', target: inst.name });
    return { ok: true };
  }

  @Post('instances/:id/test')
  @RequirePermissions('connectors:write')
  async test(@Param('id') id: string) {
    return this.instances.test(id);
  }

  // ── Resources & actions ──

  @Get('instances/:id/resources')
  @RequirePermissions('connectors:read')
  async resources(@Param('id') id: string, @Query('kind') kind: string) {
    return this.instances.listResources(id, kind);
  }

  @Get('instances/:id/resources/:kind/:resourceId')
  @RequirePermissions('connectors:read')
  async resourceDetail(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Param('resourceId') resourceId: string,
  ) {
    return this.instances.describeResource(id, kind, resourceId);
  }

  @Get('instances/:id/resources/:kind/:resourceId/subresources/:subKind')
  @RequirePermissions('connectors:read')
  async subResources(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Param('resourceId') resourceId: string,
    @Param('subKind') subKind: string,
  ) {
    return this.instances.listSubResources(id, kind, resourceId, subKind);
  }

  @Delete('instances/:id/resources/:kind/:resourceId')
  @RequirePermissions('connectors:action')
  async deleteResource(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Param('resourceId') resourceId: string,
    @CurrentUser() user: SessionUser,
  ) {
    const result = await this.instances.deleteResource(id, kind, resourceId);
    await this.audit.record({
      actorId: user.id, actorEmail: user.email,
      action: 'connectors.resource_deleted', target: `${id}/${kind}/${resourceId}`,
      meta: { ok: result.ok },
    });
    return result;
  }

  // ── Operations, dynamic options & jobs (Phase B) ──

  @Get('instances/:id/operations')
  @RequirePermissions('connectors:read')
  async operations(@Param('id') id: string, @Query('kind') kind?: string, @Query('scope') scope?: string) {
    const inst = await this.instances.get(id);
    return this.instances.operations(inst).filter(
      (o) => (!kind || o.kind === kind) && (!scope || o.scope === scope),
    );
  }

  @Post('instances/:id/options')
  @RequirePermissions('connectors:read')
  async options(@Param('id') id: string, @Body() dto: OptionsDto) {
    return this.instances.resolveOptions(id, dto.sourceId, dto.values);
  }

  @Post('instances/:id/operations/:operationId')
  @RequirePermissions('connectors:action')
  async runOperation(
    @Param('id') id: string,
    @Param('operationId') operationId: string,
    @Body() dto: RunOperationDto,
    @CurrentUser() user: SessionUser,
  ) {
    const jobId = await this.instances.startOperation(id, operationId, dto.resourceId, dto.values);
    await this.audit.record({
      actorId: user.id, actorEmail: user.email,
      action: 'connectors.operation_started', target: `${id}/${operationId}`,
      meta: { jobId },
    });
    return { jobId };
  }

  @Get('instances/:id/jobs/:jobId')
  @RequirePermissions('connectors:read')
  job(@Param('id') id: string, @Param('jobId') jobId: string): ConnectorJobStatus {
    const job = this.instances.getJob(jobId);
    if (!job || job.instanceId !== id) throw new NotFoundException('Job not found.');
    return { id: job.id, label: job.label, status: job.status, steps: job.steps, message: job.message, createdResourceId: job.createdResourceId };
  }

  @Post('instances/:id/resources/:kind/:resourceId/actions/:actionId')
  @RequirePermissions('connectors:action')
  async action(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Param('resourceId') resourceId: string,
    @Param('actionId') actionId: string,
    @CurrentUser() user: SessionUser,
  ) {
    const result = await this.instances.performAction(id, kind, resourceId, actionId);
    await this.audit.record({
      actorId: user.id, actorEmail: user.email,
      action: 'connectors.action', target: `${id}/${kind}/${resourceId}`,
      meta: { actionId, ok: result.ok },
    });
    return result;
  }
}
