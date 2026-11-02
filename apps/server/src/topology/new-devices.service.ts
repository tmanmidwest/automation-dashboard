import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { NetworkDevice } from '@prisma/client';
import type { ConnectorResource } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { isPrivateMac } from '../common/oui';

/** How often each UniFi connector's client list is re-read for new MACs. */
const SCAN_MS = 2 * 60_000;
const ALERT_PRIVATE_KEY = 'devices.alertPrivateMacs';
const baselineKey = (instanceId: string) => `devices.baseline.${instanceId}`;

export type DeviceReview = 'known' | 'blocked';

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/**
 * New-device detection: remembers every client MAC each UniFi connector reports and
 * raises `unifi.new_device` for one it has never seen. A connector's first scan records
 * what's already on the network as known, without alerting.
 */
@Injectable()
export class NewDevicesService {
  private readonly lastScan = new Map<string, number>();
  private readonly active = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: ConnectorInstanceService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly logging: LoggingService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    let rows: { id: string; name: string }[];
    try {
      rows = await this.prisma.connectorInstance.findMany({ where: { enabled: true, connectorId: 'unifi' }, select: { id: true, name: true } });
    } catch {
      return;
    }
    for (const inst of rows) {
      if (this.active.has(inst.id) || Date.now() - (this.lastScan.get(inst.id) ?? 0) < SCAN_MS) continue;
      this.active.add(inst.id);
      this.lastScan.set(inst.id, Date.now());
      this.scan(inst)
        .catch((err) => void this.logging.warn('devices', `New-device scan of ${inst.name} failed: ${err instanceof Error ? err.message : err}`))
        .finally(() => this.active.delete(inst.id));
    }
  }

  /** Read one connector's clients, record them, and alert on any never seen before. */
  async scan(inst: { id: string; name: string }): Promise<number> {
    const clients = await this.instances.listResources(inst.id, 'client');
    const baselined = !!(await this.settings.get<string>(baselineKey(inst.id)));
    const alertPrivate = !!(await this.settings.get<boolean>(ALERT_PRIVATE_KEY));
    const seen = new Map<string, ConnectorResource>();
    for (const c of clients) {
      const mac = str(c.details?.mac ?? c.id)?.toLowerCase();
      if (mac && /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(mac)) seen.set(mac, c);
    }
    if (!seen.size) return 0;
    const existing = new Set(
      (await this.prisma.networkDevice.findMany({ where: { mac: { in: [...seen.keys()] } }, select: { mac: true } })).map((d) => d.mac),
    );
    const now = new Date();
    const fields = (c: ConnectorResource) => ({
      name: c.name ?? null,
      vendor: str(c.details?.vendor),
      ip: str(c.details?.ip),
      network: str(c.details?.network) ?? str(c.tags?.network),
      via: str(c.details?.via),
      deviceType: str(c.details?.deviceType),
    });

    const fresh: NetworkDevice[] = [];
    for (const [mac, c] of seen) {
      if (existing.has(mac)) {
        await this.prisma.networkDevice.update({ where: { mac }, data: { ...fields(c), lastSeenAt: now } });
        continue;
      }
      const row = await this.prisma.networkDevice.create({
        data: {
          mac,
          instanceId: inst.id,
          ...fields(c),
          privateMac: isPrivateMac(mac),
          status: baselined ? 'new' : 'known',
          reviewedAt: baselined ? null : now,
          reviewedBy: baselined ? null : 'first scan',
          firstSeenAt: now,
          lastSeenAt: now,
        },
      });
      if (baselined) fresh.push(row);
    }
    if (!baselined) {
      await this.settings.set(baselineKey(inst.id), now.toISOString());
      void this.logging.info('devices', `Recorded ${seen.size} existing client(s) on ${inst.name} as known.`);
      return 0;
    }

    for (const d of fresh) {
      void this.logging.info('devices', `New device on ${inst.name}: ${d.name ?? d.mac} (${d.mac})`);
      if (d.privateMac && !alertPrivate) continue;
      await this.notifications.dispatchAlert('unifi.new_device', {
        title: `New device on the network: ${d.name ?? d.mac}`,
        body: [
          `${d.name ?? 'Unnamed device'} joined the network (seen by ${inst.name}).`,
          `MAC: ${d.mac}${d.privateMac ? ' (private / randomized)' : ''}`,
          d.deviceType ? `Looks like: ${d.deviceType}` : null,
          d.vendor && !d.privateMac ? `Maker: ${d.vendor}` : null,
          d.ip ? `IP: ${d.ip}` : null,
          d.network ? `Network: ${d.network}` : null,
          d.via ? `Connected via: ${d.via}` : null,
          'Review it on the Architecture Map (Needs attention → New devices): mark it as known, or block it.',
        ].filter(Boolean).join('\n'),
        dedupeKey: `unifi.new_device:${d.mac}`,
        connectorId: inst.id,
      });
    }
    return fresh.length;
  }

  async list(status?: string) {
    const devices = await this.prisma.networkDevice.findMany({
      where: status ? { status } : undefined,
      orderBy: { firstSeenAt: 'desc' },
      take: 500,
    });
    return { devices, alertPrivateMacs: !!(await this.settings.get<boolean>(ALERT_PRIVATE_KEY)) };
  }

  async review(mac: string, status: DeviceReview, by: string) {
    return this.prisma.networkDevice.update({
      where: { mac: mac.toLowerCase() },
      data: { status, reviewedAt: new Date(), reviewedBy: by },
    });
  }

  /** Set (or clear, with null) what a device is. Creates the row if the scan hasn't yet. */
  async setType(mac: string, instanceId: string, type: string | null, by: string) {
    const m = mac.toLowerCase();
    const typeOverride = type?.trim() || null;
    return this.prisma.networkDevice.upsert({
      where: { mac: m },
      update: { typeOverride },
      create: { mac: m, instanceId, typeOverride, privateMac: isPrivateMac(m), status: 'known', reviewedAt: new Date(), reviewedBy: by },
    });
  }

  /** MAC → the type the user set, for the map. */
  async overrides(): Promise<Map<string, string>> {
    const rows = await this.prisma.networkDevice.findMany({ where: { typeOverride: { not: null } }, select: { mac: true, typeOverride: true } });
    return new Map(rows.map((r) => [r.mac, r.typeOverride!]));
  }

  async reviewAllNew(by: string) {
    const r = await this.prisma.networkDevice.updateMany({
      where: { status: 'new' },
      data: { status: 'known', reviewedAt: new Date(), reviewedBy: by },
    });
    return { count: r.count };
  }

  async setAlertPrivate(on: boolean) {
    await this.settings.set(ALERT_PRIVATE_KEY, on);
    return { alertPrivateMacs: on };
  }
}
