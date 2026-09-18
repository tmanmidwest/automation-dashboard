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
  // IMPORTANT: run guacamole-lite in `noServer` mode and route only its own path
  // to it. In `{ server }` mode the underlying `ws` server attaches a global
  // upgrade listener that aborts EVERY upgrade whose path doesn't match — which
  // would kill the agent, session, and console WebSockets. `port: null` cancels
  // guacamole-lite's default `port: 8080` merge so nothing binds a port.
  const websocketOptions = { noServer: true, port: null };
  const guacdOptions = {
    host: process.env.GUACD_HOST || 'guacd',
    port: Number(process.env.GUACD_PORT || 4822),
  };
  const clientOptions = {
    // GUAC_LOG_LEVEL (QUIET|ERRORS|NORMAL|VERBOSE|DEBUG) tunes guacd-tunnel logging
    // in the app log; NORMAL surfaces connection open/close + errors for diagnosis.
    crypt: { cipher: 'AES-256-CBC', key: guac.cryptKey },
    log: { level: process.env.GUAC_LOG_LEVEL || 'NORMAL' },
  };
  const callbacks = {
    // Must resolve SYNCHRONOUSLY — guacamole-lite dials guacd immediately after
    // this returns and does not await it (all async work is done at issue time).
    processConnectionSettings: (
      settings: { connection: Record<string, unknown> },
      cb: (err: unknown, settings?: unknown) => void,
    ) => {
      try {
        cb(null, guac.resolveConnection(settings));
      } catch (e) {
        cb(e);
      }
    },
  };

  const guacServer = new GuacamoleLite(websocketOptions, guacdOptions, clientOptions, callbacks);

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '', 'http://localhost');
    } catch {
      return;
    }
    if (url.pathname !== guac.wsPath) return; // not ours — leave it for the other relays
    guacServer.webSocketServer.handleUpgrade(req, socket, head, (ws) => {
      guacServer.webSocketServer.emit('connection', ws, req);
    });
  });

  logger.log(`Fabric guac (RDP) relay listening on ${guac.wsPath} → guacd ${guacdOptions.host}:${guacdOptions.port}`);
}
