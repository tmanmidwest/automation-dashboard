import type { Server } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Logger } from '@nestjs/common';
import type { FabricControlFrame } from '@cerebro/shared';
import { AgentRegistryService } from './agent-registry.service';

const AGENT_PATH = '/api/fabric/agent/ws';
const logger = new Logger('FabricAgentRelay');

/**
 * Attaches the Fabric agent control-plane WebSocket to the HTTP server, next to
 * the console relay (main.ts). Agents dial `/api/fabric/agent/ws` with their
 * bearer credential (Authorization: Bearer … or ?cred=…); we authenticate,
 * register the socket, and route JSON control frames to the registry.
 *
 * Phase 1 carries only identity + liveness frames — no data streams yet.
 */
export function attachFabricAgentRelay(server: Server, registry: AgentRegistryService): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '', 'http://localhost');
    } catch {
      return; // malformed; let another handler (or the default) deal with it
    }
    if (url.pathname !== AGENT_PATH) return; // not ours — leave it for the console relay

    const header = req.headers['authorization'];
    const bearer =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    const credential = bearer || url.searchParams.get('cred') || '';
    if (!credential) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    registry
      .authenticateOutcome(credential)
      .then((outcome) => {
        if (outcome.status === 'gone') {
          // Positively-removed credential (revoked agent): tell the box it's gone
          // so it self-uninstalls instead of reconnecting forever as a zombie.
          socket.write('HTTP/1.1 410 Gone\r\n\r\n');
          socket.destroy();
          return;
        }
        if (outcome.status !== 'ok') {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        const agentId = outcome.agentId;
        wss.handleUpgrade(req, socket, head, (client) => {
          registry.register(agentId, client);
          wireAgentSocket(agentId, client, registry);
        });
      })
      .catch((err) => {
        logger.warn(`Agent auth error: ${err?.message ?? err}`);
        try {
          socket.destroy();
        } catch {
          /* noop */
        }
      });
  });

  logger.log(`Fabric agent relay listening on ${AGENT_PATH}`);
}

function wireAgentSocket(agentId: string, client: WebSocket, registry: AgentRegistryService): void {
  client.binaryType = 'nodebuffer';
  client.on('message', (data, isBinary) => {
    // BINARY = tunnel data (streamId prefix + bytes); TEXT = JSON control frame.
    if (isBinary) {
      registry.handleAgentData(agentId, data as Buffer);
      return;
    }
    let frame: FabricControlFrame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return; // ignore non-JSON / oversized noise
    }
    if (!frame || typeof (frame as { t?: unknown }).t !== 'string') return;
    void registry.handleFrame(agentId, frame);
  });
}
