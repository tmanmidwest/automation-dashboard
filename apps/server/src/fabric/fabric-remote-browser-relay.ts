import type { Server } from 'http';
import { WebSocketServer } from 'ws';
import { Logger } from '@nestjs/common';
import { RemoteBrowserService } from './remote-browser.service';

const REMOTE_BROWSER_PATH = '/api/fabric/remote-browser/ws';
const logger = new Logger('FabricRemoteBrowserRelay');

/**
 * Browser-facing Remote Browser relay: the operator's noVNC client opens
 * `/api/fabric/remote-browser/ws?token=…` with a one-time ticket; we redeem it and pipe
 * the socket to the ephemeral browser container's VNC server. Mirrors the Fabric
 * session relay. See docs/fabric-waypoints.md.
 */
export function attachFabricRemoteBrowserRelay(server: Server, remoteBrowser: RemoteBrowserService): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '', 'http://localhost');
    } catch {
      return;
    }
    if (url.pathname !== REMOTE_BROWSER_PATH) return; // not ours

    const token = url.searchParams.get('token') ?? '';
    const session = remoteBrowser.consume(token);
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      void remoteBrowser.handleWs(client, session);
    });
  });

  logger.log(`Fabric Remote Browser relay listening on ${REMOTE_BROWSER_PATH}`);
}
