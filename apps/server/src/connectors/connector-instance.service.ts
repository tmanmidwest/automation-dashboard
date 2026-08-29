import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { LoggingService } from '../logging/logging.service';
import { ConnectorRegistry } from './connector-registry.service';
import { JobService } from './job.service';
import type { ConnectorContext, ConnectorResource, ConnectorOption } from '@cerebro/shared';
import type { ConnectorInstance } from '@prisma/client';

@Injectable()
export class ConnectorInstanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly logging: LoggingService,
    private readonly registry: ConnectorRegistry,
    private readonly jobs: JobService,
  ) {}

  private secretKey(instanceId: string, field: string) {
    return `connector:${instanceId}:${field}`;
  }

  /** Splits incoming config values into non-secret (stored as JSON) and secret (vault) sets. */
  private secretFields(connectorId: string): string[] {
    const connector = this.registry.get(connectorId);
    if (!connector) throw new BadRequestException(`Unknown connector "${connectorId}".`);
    return connector.manifest.configFields.filter((f) => f.secret).map((f) => f.key);
  }

  async list(): Promise<ConnectorInstance[]> {
    return this.prisma.connectorInstance.findMany({ orderBy: { createdAt: 'asc' } });
  }

  async get(id: string): Promise<ConnectorInstance> {
    const inst = await this.prisma.connectorInstance.findUnique({ where: { id } });
    if (!inst) throw new NotFoundException('Connector instance not found.');
    return inst;
  }

  async secretFieldsSet(instance: ConnectorInstance): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const field of this.secretFields(instance.connectorId)) {
      out[field] = await this.settings.hasSecret(this.secretKey(instance.id, field));
    }
    return out;
  }

  async create(connectorId: string, name: string, values: Record<string, unknown>): Promise<ConnectorInstance> {
    if (!name?.trim()) throw new BadRequestException('A name is required.');
    const secretKeys = this.secretFields(connectorId);
    const config: Record<string, unknown> = {};
    const secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (secretKeys.includes(k)) {
        if (v != null && `${v}` !== '') secrets[k] = String(v);
      } else {
        config[k] = v;
      }
    }
    const instance = await this.prisma.connectorInstance.create({
      data: { connectorId, name: name.trim(), config: config as object, enabled: true },
    });
    for (const [k, v] of Object.entries(secrets)) {
      await this.settings.setSecret(this.secretKey(instance.id, k), v);
    }
    return instance;
  }

  async update(
    id: string,
    updates: { name?: string; enabled?: boolean; values?: Record<string, unknown> },
  ): Promise<ConnectorInstance> {
    const instance = await this.get(id);
    const secretKeys = this.secretFields(instance.connectorId);
    const data: Record<string, unknown> = {};
    if (updates.name !== undefined) data.name = updates.name.trim();
    if (updates.enabled !== undefined) data.enabled = updates.enabled;

    if (updates.values) {
      const config: Record<string, unknown> = { ...(instance.config as object) };
      for (const [k, v] of Object.entries(updates.values)) {
        if (secretKeys.includes(k)) {
          // Only replace a secret when a non-blank value is supplied.
          if (v != null && `${v}` !== '') await this.settings.setSecret(this.secretKey(id, k), String(v));
        } else {
          config[k] = v;
        }
      }
      data.config = config as object;
    }
    return this.prisma.connectorInstance.update({ where: { id }, data });
  }

  async remove(id: string): Promise<void> {
    const instance = await this.get(id);
    for (const field of this.secretFields(instance.connectorId)) {
      await this.settings.deleteSecret(this.secretKey(id, field));
    }
    await this.prisma.connectorInstance.delete({ where: { id } });
  }

  /** Builds a ConnectorContext with decrypted secrets merged into config. */
  private async buildContext(instance: ConnectorInstance): Promise<ConnectorContext> {
    const config: Record<string, unknown> = { ...(instance.config as object) };
    for (const field of this.secretFields(instance.connectorId)) {
      const secret = await this.settings.getSecret(this.secretKey(instance.id, field));
      if (secret != null) config[field] = secret;
    }
    return {
      config,
      log: (level, message, meta) =>
        void this.logging[level](`connector:${instance.connectorId}`, `[${instance.name}] ${message}`, meta),
    };
  }

  private connectorFor(instance: ConnectorInstance) {
    const connector = this.registry.get(instance.connectorId);
    if (!connector) throw new BadRequestException(`Connector "${instance.connectorId}" is not installed.`);
    return connector;
  }

  async test(id: string) {
    const instance = await this.get(id);
    const ctx = await this.buildContext(instance);
    return this.connectorFor(instance).testConnection(ctx);
  }

  async listResources(id: string, kind: string): Promise<ConnectorResource[]> {
    const instance = await this.get(id);
    if (!instance.enabled) throw new BadRequestException('This connector is disabled.');
    const ctx = await this.buildContext(instance);
    try {
      return await this.connectorFor(instance).listResources(ctx, kind);
    } catch (err) {
      // Surface the connector's own error message to the UI instead of a bare 500.
      throw new BadGatewayException(err instanceof Error ? err.message : 'Failed to reach the connector.');
    }
  }

  async performAction(id: string, kind: string, resourceId: string, actionId: string) {
    const instance = await this.get(id);
    if (!instance.enabled) throw new BadRequestException('This connector is disabled.');
    const ctx = await this.buildContext(instance);
    return this.connectorFor(instance).performAction(ctx, kind, resourceId, actionId);
  }

  async describeResource(id: string, kind: string, resourceId: string) {
    const instance = await this.get(id);
    if (!instance.enabled) throw new BadRequestException('This connector is disabled.');
    const connector = this.connectorFor(instance);
    if (!connector.describeResource) {
      throw new BadRequestException('This connector does not support resource details.');
    }
    const ctx = await this.buildContext(instance);
    try {
      return await connector.describeResource(ctx, kind, resourceId);
    } catch (err) {
      throw new BadGatewayException(err instanceof Error ? err.message : 'Failed to reach the connector.');
    }
  }

  async deleteResource(id: string, kind: string, resourceId: string) {
    const instance = await this.get(id);
    if (!instance.enabled) throw new BadRequestException('This connector is disabled.');
    const connector = this.connectorFor(instance);
    if (!connector.deleteResource) {
      throw new BadRequestException('This connector does not support deleting resources.');
    }
    const ctx = await this.buildContext(instance);
    return connector.deleteResource(ctx, kind, resourceId);
  }

  // ── Operations (Phase B) ──

  operations(instance: ConnectorInstance) {
    return this.connectorFor(instance).manifest.operations ?? [];
  }

  async resolveOptions(id: string, sourceId: string, values: Record<string, unknown>): Promise<ConnectorOption[]> {
    const instance = await this.get(id);
    const connector = this.connectorFor(instance);
    if (!connector.resolveOptions) return [];
    const ctx = await this.buildContext(instance);
    try {
      return await connector.resolveOptions(ctx, sourceId, values);
    } catch (err) {
      throw new BadGatewayException(err instanceof Error ? err.message : 'Failed to load options.');
    }
  }

  /** Kicks off a background job running the operation; returns the job id. */
  async startOperation(
    id: string,
    operationId: string,
    resourceId: string | undefined,
    values: Record<string, unknown>,
  ): Promise<string> {
    const instance = await this.get(id);
    if (!instance.enabled) throw new BadRequestException('This connector is disabled.');
    const connector = this.connectorFor(instance);
    if (!connector.runOperation) throw new BadRequestException('This connector does not support operations.');
    const op = (connector.manifest.operations ?? []).find((o) => o.id === operationId);
    if (!op) throw new BadRequestException(`Unknown operation "${operationId}".`);

    const ctx = await this.buildContext(instance);
    return this.jobs.start(instance.id, op.label, (onProgress) =>
      connector.runOperation!(ctx, operationId, resourceId, values, onProgress),
    );
  }

  getJob(jobId: string) {
    return this.jobs.get(jobId);
  }
}
