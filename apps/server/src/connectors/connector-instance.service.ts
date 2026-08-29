import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { LoggingService } from '../logging/logging.service';
import { ConnectorRegistry } from './connector-registry.service';
import { JobService } from './job.service';
import type {
  ConnectorContext, ConnectorResource, ConnectorOption, ConnectorConsoleTarget, ConnectorNode,
  DashboardOverview, OverviewMetric, OverviewGuest, OverviewSource,
} from '@cerebro/shared';
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

  async listSubResources(id: string, kind: string, resourceId: string, subKind: string) {
    const instance = await this.get(id);
    if (!instance.enabled) throw new BadRequestException('This connector is disabled.');
    const connector = this.connectorFor(instance);
    if (!connector.listSubResources) return [];
    const ctx = await this.buildContext(instance);
    try {
      return await connector.listSubResources(ctx, kind, resourceId, subKind);
    } catch (err) {
      throw new BadGatewayException(err instanceof Error ? err.message : 'Failed to reach the connector.');
    }
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

  async operationDefaults(id: string, operationId: string, resourceId: string | undefined, values: Record<string, unknown>) {
    const instance = await this.get(id);
    const connector = this.connectorFor(instance);
    if (!connector.operationDefaults) return {};
    const ctx = await this.buildContext(instance);
    try {
      return await connector.operationDefaults(ctx, operationId, resourceId, values);
    } catch {
      return {};
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

  async listNodes(id: string): Promise<ConnectorNode[]> {
    const instance = await this.get(id);
    if (!instance.enabled) throw new BadRequestException('This connector is disabled.');
    const connector = this.connectorFor(instance);
    if (!connector.listNodes) return [];
    const ctx = await this.buildContext(instance);
    try {
      return await connector.listNodes(ctx);
    } catch (err) {
      throw new BadGatewayException(err instanceof Error ? err.message : 'Failed to reach the connector.');
    }
  }

  private overviewCache?: { at: number; data: DashboardOverview };
  /**
   * Per-connector last-good telemetry. When one connector has a transient
   * failure (a slow/timed-out AWS call, say) while others succeed, we keep
   * folding its last-good numbers into the aggregate for a short window — so
   * the dashboard totals stay steady instead of flickering down and back up.
   * Source health (`sources`/`ok`) still reflects the real, current failure.
   */
  private connectorTelemetry = new Map<string, { at: number; metrics: OverviewMetric[]; guests: { name: string; kind: string; status: string; node: string }[] }>();
  private static readonly TELEMETRY_STALE_MS = 60000;

  /** Aggregated telemetry across all enabled connectors (short-cached to survive polling). */
  async dashboardOverview(): Promise<DashboardOverview> {
    const now = Date.now();
    if (this.overviewCache && now - this.overviewCache.at < 3000) return this.overviewCache.data;

    const instances = (await this.list()).filter((i) => i.enabled);
    const metricMap = new Map<string, { label: string; unit?: string; values: number[] }>();
    const guests: OverviewGuest[] = [];
    const sources: OverviewSource[] = [];
    let ok = 0;

    await Promise.all(
      instances.map(async (inst) => {
        const connector = this.registry.get(inst.connectorId);
        if (!connector?.overview) return;
        let contribution: { metrics: OverviewMetric[]; guests: { name: string; kind: string; status: string; node: string }[] } | undefined;
        try {
          const ctx = await this.buildContext(inst);
          const ov = await connector.overview(ctx);
          ok++;
          sources.push({ name: inst.name, ok: true });
          contribution = { metrics: ov.metrics, guests: ov.guests };
          this.connectorTelemetry.set(inst.id, { at: now, ...contribution });
        } catch (err) {
          sources.push({ name: inst.name, ok: false, message: err instanceof Error ? err.message : 'unreachable' });
          // Substitute this connector's last-good numbers so a blip doesn't drop it from the totals.
          const cached = this.connectorTelemetry.get(inst.id);
          if (cached && now - cached.at < ConnectorInstanceService.TELEMETRY_STALE_MS) {
            contribution = { metrics: cached.metrics, guests: cached.guests };
          }
        }
        if (contribution) {
          for (const m of contribution.metrics) {
            const e = metricMap.get(m.key) ?? { label: m.label, unit: m.unit, values: [] };
            e.values.push(m.value);
            metricMap.set(m.key, e);
          }
          for (const g of contribution.guests) guests.push({ ...g, connector: inst.name });
        }
      }),
    );
    sources.sort((a, b) => Number(a.ok) - Number(b.ok) || a.name.localeCompare(b.name));

    // Percentages average across connectors; everything else sums.
    const metrics: OverviewMetric[] = [...metricMap.entries()].map(([key, e]) => {
      const value = e.unit === '%'
        ? Math.round(e.values.reduce((s, v) => s + v, 0) / e.values.length)
        : e.values.reduce((s, v) => s + v, 0);
      return { key, label: e.label, value, unit: e.unit };
    });

    // Forget telemetry for connectors that no longer exist.
    const liveIds = new Set(instances.map((i) => i.id));
    for (const id of this.connectorTelemetry.keys()) if (!liveIds.has(id)) this.connectorTelemetry.delete(id);

    const data: DashboardOverview = { connectors: { total: instances.length, ok }, sources, metrics, guests: guests.slice(0, 60) };
    this.overviewCache = { at: now, data };
    return data;
  }

  async openConsole(id: string, kind: string, resourceId: string, mode: 'vnc' | 'serial'): Promise<ConnectorConsoleTarget> {
    const instance = await this.get(id);
    if (!instance.enabled) throw new BadRequestException('This connector is disabled.');
    const connector = this.connectorFor(instance);
    if (!connector.openConsole) throw new BadRequestException('This connector does not support a console.');
    const ctx = await this.buildContext(instance);
    try {
      return await connector.openConsole(ctx, kind, resourceId, mode);
    } catch (err) {
      throw new BadGatewayException(err instanceof Error ? err.message : 'Failed to open the console.');
    }
  }
}
