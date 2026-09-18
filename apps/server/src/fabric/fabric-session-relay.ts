import type { Server } from 'http';
import { WebSocketServer } from 'ws';
import { Logger } from '@nestjs/common';
import { FabricSessionService } from './fabric-session.service';

const SESSION_PATH = '/api/fabric/session/ws';
const logger = new Logger('FabricSessionRelay');

/**
 * Browser-facing session relay (Phase 3). The browser opens
 * `/api/fabric/session/ws?token=…` with a one-time ticket minted over its
 * authenticated app session; we redeem it and hand the socket to the session
 * service, which runs SSH over the tunnel and pipes the shell. Mirrors the
 * console relay in main.ts.
 */
export function attachFabricSessionRelay(server: Server, sessions: FabricSessionService): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '', 'http://localhost');
    } catch {
      return;
    }
    if (url.pathname !== SESSION_PATH) return; // not ours

    const token = url.searchParams.get('token') ?? '';
    const desc = sessions.consume(token);
    if (!desc) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      void sessions.handleSession(client, desc);
    });
  });

  logger.log(`Fabric session relay listening on ${SESSION_PATH}`);
}
