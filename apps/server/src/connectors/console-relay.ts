import type { Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { Logger } from '@nestjs/common';
import { ConsoleService } from './console.service';

const CONSOLE_PATH = '/api/console/ws';
const logger = new Logger('ConsoleRelay');

/**
 * Attaches a raw WebSocket relay to the HTTP server. The browser connects to
 * /api/console/ws?token=…; we look up the one-time token, open an upstream WS to
 * the connector's console endpoint (with its auth headers, and honoring its TLS
 * setting), and pipe bytes both ways. The relay is protocol-agnostic.
 */
export function attachConsoleRelay(server: Server, consoleService: ConsoleService) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== CONSOLE_PATH) return; // not ours — leave it alone

    const token = url.searchParams.get('token') ?? '';
    const target = consoleService.consume(token);
    if (!target) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(target.url, target.protocols ?? [], {
        headers: target.headers,
        rejectUnauthorized: target.rejectUnauthorized ?? true,
      });
      client.binaryType = 'nodebuffer';
      upstream.binaryType = 'nodebuffer';

      const pending: Array<{ data: Buffer; binary: boolean }> = [];
      let upstreamOpen = false;

      upstream.on('open', () => {
        upstreamOpen = true;
        for (const m of pending) upstream.send(m.data, { binary: m.binary });
        pending.length = 0;
      });
      client.on('message', (data: Buffer, isBinary: boolean) => {
        if (upstreamOpen) upstream.send(data, { binary: isBinary });
        else pending.push({ data, binary: isBinary });
      });
      upstream.on('message', (data: Buffer, isBinary: boolean) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });

      const closeBoth = () => {
        if (client.readyState === WebSocket.OPEN) client.close();
        if (upstream.readyState === WebSocket.OPEN) upstream.close();
      };
      client.on('close', closeBoth);
      upstream.on('close', closeBoth);
      client.on('error', closeBoth);
      upstream.on('error', (err) => {
        logger.warn(`Upstream console error: ${err.message}`);
        closeBoth();
      });
    });
  });

  logger.log(`Console relay listening on ${CONSOLE_PATH}`);
}
