import type { Server } from 'http';
import { Logger } from '@nestjs/common';
import GuacamoleLite from 'guacamole-lite';
import { FabricGuacService } from './fabric-guac.service';

const logger = new Logger('FabricGuacRelay');

/**
 * Attaches the guacamole-lite server (Phase 4 RDP). It owns the browser WS at
 * `/api/fabric/guac/ws`, decrypts our token, and — via processConnectionSettings
 * — asks the guac service to open a tunnel forward and supply the RDP settings.
 * guacd itself runs as a sidecar (GUACD_HOST:GUACD_PORT).
 */
export function attachFabricGuacRelay(server: Server, guac: FabricGuacService): void {
  const websocketOptions = { server, path: guac.wsPath };
  const guacdOptions = {
    host: process.env.GUACD_HOST || 'guacd',
    port: Number(process.env.GUACD_PORT || 4822),
  };
  const clientOptions = {
    crypt: { cipher: 'AES-256-CBC', key: guac.cryptKey },
    log: { level: 'ERRORS' },
  };
  const callbacks = {
    processConnectionSettings: (
      settings: { connection: { type: string; settings: Record<string, unknown> } },
      cb: (err: unknown, settings?: unknown) => void,
    ) => {
      guac
        .resolveConnection(settings)
        .then((s) => cb(null, s))
        .catch((e) => cb(e));
    },
  };

  // eslint-disable-next-line no-new
  new GuacamoleLite(websocketOptions, guacdOptions, clientOptions, callbacks);
  logger.log(`Fabric guac (RDP) relay listening on ${guac.wsPath} → guacd ${guacdOptions.host}:${guacdOptions.port}`);
}
