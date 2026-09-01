import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../../settings/settings.service';
import { LoggingService } from '../../logging/logging.service';
import { ConnectorInstanceService } from '../connector-instance.service';

const CACHE_KEY = 'backblaze:vmnames';
const PROXMOX_ID = 'proxmox';
const VM_KINDS = ['qemu', 'lxc'];

interface CachedNames {
  map: Record<string, string>;
  at: string; // ISO
}

/**
 * Resolves Proxmox VMID → friendly name for the Backblaze connector's display,
 * WITHOUT the connector talking to Proxmox directly. It reads names from the
 * Proxmox connector(s), caches them in the DB (Setting table), and — critically
 * for DR — the map it returns is what the backup writes into the repo, so names
 * survive even if Proxmox (and this live lookup) is gone.
 *
 * VMIDs are unique within a Proxmox cluster; with multiple clusters that reuse
 * ids the last one wins (logged).
 */
@Injectable()
export class VmNameService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly instances: ConnectorInstanceService,
    private readonly logging: LoggingService,
  ) {}

  /** The last cached map (DB only — never touches Proxmox). Safe when Proxmox is down. */
  async cachedMap(): Promise<Record<string, string>> {
    const c = await this.settings.get<CachedNames>(CACHE_KEY);
    return c?.map ?? {};
  }

  /** Cached map if newer than maxAgeMs, else a fresh pull (which also refreshes the cache). */
  async mapFresh(maxAgeMs: number): Promise<Record<string, string>> {
    const c = await this.settings.get<CachedNames>(CACHE_KEY);
    if (c?.at && Date.now() - new Date(c.at).getTime() < maxAgeMs) return c.map;
    return this.currentMap();
  }

  /** Query every enabled Proxmox connector for VMID→name, cache it, and return it. Falls back to cache on failure. */
  async currentMap(): Promise<Record<string, string>> {
    try {
      const proxmoxInstances = await this.prisma.connectorInstance.findMany({
        where: { connectorId: PROXMOX_ID, enabled: true },
      });
      if (proxmoxInstances.length === 0) return this.cachedMap();

      const map: Record<string, string> = {};
      for (const inst of proxmoxInstances) {
        for (const kind of VM_KINDS) {
          try {
            const resources = await this.instances.listResources(inst.id, kind);
            for (const r of resources) {
              if (r.id && r.name) map[r.id] = r.name;
            }
          } catch (err) {
            this.logging.warn('connector:backblaze', `VM-name refresh: ${inst.name}/${kind} failed: ${err instanceof Error ? err.message : err}`);
          }
        }
      }

      // Only overwrite the cache if we actually learned something (don't wipe good names on a transient failure).
      if (Object.keys(map).length > 0) {
        await this.settings.set(CACHE_KEY, { map, at: new Date().toISOString() } satisfies CachedNames);
        return map;
      }
      return this.cachedMap();
    } catch (err) {
      this.logging.warn('connector:backblaze', `VM-name refresh failed, using cache: ${err instanceof Error ? err.message : err}`);
      return this.cachedMap();
    }
  }
}
