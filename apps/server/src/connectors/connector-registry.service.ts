import { Injectable } from '@nestjs/common';
import type { Connector, ConnectorManifest } from '@cerebro/shared';

/**
 * The extension host. Phase 1 ships the seam only — the registry is empty.
 * Phase 3 wires in real connectors (Proxmox first) by calling register().
 */
@Injectable()
export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  register(connector: Connector) {
    this.connectors.set(connector.manifest.id, connector);
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  manifests(): ConnectorManifest[] {
    return [...this.connectors.values()].map((c) => c.manifest);
  }
}
