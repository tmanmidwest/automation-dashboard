import * as net from 'net';
import * as tls from 'tls';
import { WebSocket } from 'ws';
import type { Logger } from '@nestjs/common';
import type { RawConsoleUpstream } from '@cerebro/shared';

const HEADER_TERMINATOR = Buffer.from('\r\n\r\n');

/**
 * Bridge a browser WebSocket to a raw Docker HTTP stream (exec hijack or a
 * follow-logs response). We open our own socket to the daemon, send the raw
 * HTTP request, skip the response headers, then pipe the byte stream — demuxing
 * Docker's 8-byte stdout/stderr frame headers when the stream is multiplexed
 * (non-TTY logs). Distinct from the WebSocket↔WebSocket console relay so the
 * VNC/serial path is untouched. See docs/connectors/docker.md.
 */
export function bridgeDockerRaw(client: WebSocket, raw: RawConsoleUpstream, logger: Logger): void {
  client.binaryType = 'nodebuffer';
  const socket = openSocket(raw);

  let headersParsed = false;
  let head = Buffer.alloc(0); // accumulates response bytes until headers end
  let frame = Buffer.alloc(0); // accumulates body bytes for multiplexed demux

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { socket.destroy(); } catch { /* ignore */ }
    try { if (client.readyState === WebSocket.OPEN) client.close(); } catch { /* ignore */ }
  };

  const onReady = () => {
    try { socket.write(raw.request); } catch (err) { logger.warn(`Docker bridge write failed: ${(err as Error).message}`); cleanup(); }
  };
  if (raw.tls) socket.once('secureConnect', onReady);
  else socket.once('connect', onReady);

  socket.on('data', (chunk: Buffer) => {
    if (!headersParsed) {
      head = Buffer.concat([head, chunk]);
      const idx = head.indexOf(HEADER_TERMINATOR);
      if (idx < 0) return; // more header bytes to come
      const headerText = head.slice(0, idx).toString('utf8');
      if (!/^HTTP\/1\.\d (1\d\d|2\d\d)/.test(headerText)) {
        const firstLine = headerText.split('\r\n')[0] || 'Upstream error';
        if (client.readyState === WebSocket.OPEN) client.send(`\r\n[cerebro] Docker refused the stream: ${firstLine}\r\n`);
        cleanup();
        return;
      }
      headersParsed = true;
      const rest = head.slice(idx + HEADER_TERMINATOR.length);
      head = Buffer.alloc(0);
      if (rest.length) forwardBody(rest);
      return;
    }
    forwardBody(chunk);
  });

  function forwardBody(chunk: Buffer) {
    if (client.readyState !== WebSocket.OPEN) return;
    if (raw.framing === 'docker-multiplexed') {
      frame = Buffer.concat([frame, chunk]);
      // Each frame: [1 byte stream][3 bytes 0][4 bytes BE length][payload].
      while (frame.length >= 8) {
        const len = frame.readUInt32BE(4);
        if (frame.length < 8 + len) break;
        const payload = frame.slice(8, 8 + len);
        frame = frame.slice(8 + len);
        client.send(payload);
      }
    } else {
      client.send(chunk);
    }
  }

  // Browser → container (keystrokes). Ignored for read-only log viewers.
  client.on('message', (data: Buffer) => {
    if (raw.readOnly || closed) return;
    if (!socket.destroyed) socket.write(data);
  });

  client.on('close', cleanup);
  client.on('error', cleanup);
  socket.on('close', cleanup);
  socket.on('error', (err) => { logger.warn(`Docker console bridge socket error: ${err.message}`); cleanup(); });
}

function openSocket(raw: RawConsoleUpstream): net.Socket {
  if (raw.socketPath) return net.connect(raw.socketPath);
  if (raw.tls) {
    return tls.connect({
      host: raw.host,
      port: raw.port,
      ca: raw.tls.ca,
      cert: raw.tls.cert,
      key: raw.tls.key,
      rejectUnauthorized: raw.tls.rejectUnauthorized,
    });
  }
  return net.connect({ host: raw.host ?? 'localhost', port: raw.port ?? 2375 });
}
