import { createServer, type Server, type Socket } from 'net';
import type { Logger } from '@nestjs/common';
import type { AgentRegistryService } from './agent-registry.service';
import type { TunnelStream } from './stream-mux';

/**
 * A per-session SOCKS5 bridge for **Remote Browser** (see docs/fabric-waypoints.md).
 *
 * The ephemeral browser container is launched with `--proxy-server=socks5://…`
 * pointing here; every request the page makes arrives as a SOCKS5 CONNECT, and
 * we open a Fabric tunnel stream to that host:port through the Waypoint. The
 * **agent** is the security gate — it refuses any host:port not on its allow-list
 * (the remote browser item's host, plus the Waypoint's egress CIDRs), so a page that
 * pulls a sub-resource from an off-list host simply fails to load, exactly like a
 * restricted network. We keep the bridge itself minimal (no auth: it only listens
 * for the one container on the internal Docker network) with a concurrency cap.
 */

const SOCKS_VERSION = 0x05;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_OK = 0x00;
const REP_GENERAL_FAIL = 0x01;
const REP_NOT_ALLOWED = 0x02;
const REP_CMD_NOT_SUPPORTED = 0x07;

export interface RemoteBrowserProxy {
  /** Port the SOCKS5 bridge listens on (the browser dials `bindHost:port`). */
  port: number;
  /** Number of tunnel streams currently open through the bridge. */
  active: () => number;
  close: () => void;
}

export function openRemoteBrowserProxy(
  registry: AgentRegistryService,
  opts: {
    agentId: string;
    bindHost?: string;
    maxStreams?: number;
    logger?: Logger;
  },
): Promise<RemoteBrowserProxy> {
  const { agentId, bindHost = '0.0.0.0', maxStreams = 64 } = opts;
  const server: Server = createServer();
  let closed = false;
  let active = 0;

  const closeAll = () => {
    if (closed) return;
    closed = true;
    try {
      server.close();
    } catch {
      /* noop */
    }
  };

  server.on('connection', (socket) => {
    handleSocksConnection(socket, {
      agentId,
      registry,
      logger: opts.logger,
      canOpen: () => active < maxStreams,
      onOpen: () => { active++; },
      onClose: () => { active = Math.max(0, active - 1); },
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', (e) => {
      if (!closed) reject(e);
    });
    server.listen(0, bindHost, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, active: () => active, close: closeAll });
    });
  });
}

function handleSocksConnection(
  socket: Socket,
  ctx: {
    agentId: string;
    registry: AgentRegistryService;
    logger?: Logger;
    canOpen: () => boolean;
    onOpen: () => void;
    onClose: () => void;
  },
): void {
  let phase: 'greeting' | 'request' | 'piping' = 'greeting';
  let buf = Buffer.alloc(0);
  let stream: TunnelStream | null = null;

  const fail = (rep: number) => {
    // Minimal SOCKS5 failure reply (IPv4 0.0.0.0:0), then close.
    try {
      socket.write(Buffer.from([SOCKS_VERSION, rep, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]));
    } catch {
      /* noop */
    }
    socket.destroy();
  };

  socket.on('data', (chunk) => {
    if (phase === 'piping') {
      stream?.write(chunk);
      return;
    }
    buf = Buffer.concat([buf, chunk]);

    if (phase === 'greeting') {
      if (buf.length < 2) return;
      if (buf[0] !== SOCKS_VERSION) return fail(REP_GENERAL_FAIL);
      const nMethods = buf[1];
      if (buf.length < 2 + nMethods) return;
      buf = buf.subarray(2 + nMethods);
      // Reply: version 5, no authentication required.
      socket.write(Buffer.from([SOCKS_VERSION, 0x00]));
      phase = 'request';
    }

    if (phase === 'request') {
      if (buf.length < 4) return;
      if (buf[0] !== SOCKS_VERSION) return fail(REP_GENERAL_FAIL);
      if (buf[1] !== CMD_CONNECT) return fail(REP_CMD_NOT_SUPPORTED);
      const atyp = buf[3];
      let host: string;
      let offset: number;
      if (atyp === ATYP_IPV4) {
        if (buf.length < 10) return;
        host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
        offset = 8;
      } else if (atyp === ATYP_DOMAIN) {
        const len = buf[4];
        if (buf.length < 5 + len + 2) return;
        host = buf.subarray(5, 5 + len).toString('utf8');
        offset = 5 + len;
      } else if (atyp === ATYP_IPV6) {
        if (buf.length < 22) return;
        const seg: string[] = [];
        for (let i = 0; i < 8; i++) seg.push(buf.readUInt16BE(4 + i * 2).toString(16));
        host = seg.join(':');
        offset = 20;
      } else {
        return fail(REP_CMD_NOT_SUPPORTED);
      }
      const port = buf.readUInt16BE(offset);
      buf = buf.subarray(offset + 2);

      if (!ctx.canOpen()) return fail(REP_NOT_ALLOWED);

      void ctx.registry
        .openStream(ctx.agentId, host, port)
        .then((s) => {
          if (socket.destroyed) {
            s.close();
            return;
          }
          stream = s;
          ctx.onOpen();
          let done = false;
          const tearDown = () => {
            if (done) return;
            done = true;
            ctx.onClose();
            try {
              s.close();
            } catch {
              /* noop */
            }
            try {
              socket.end();
            } catch {
              /* noop */
            }
          };
          s.onData = (b: Buffer) => {
            if (!socket.destroyed) socket.write(b);
          };
          s.onClose = tearDown;
          socket.on('close', tearDown);
          socket.on('error', tearDown);
          // Success reply, then flush any bytes the client already sent.
          socket.write(Buffer.from([SOCKS_VERSION, REP_OK, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]));
          phase = 'piping';
          if (buf.length) {
            s.write(buf);
            buf = Buffer.alloc(0);
          }
        })
        .catch((e) => {
          ctx.logger?.debug?.(`remote-browser proxy: ${host}:${port} refused (${e instanceof Error ? e.message : e})`);
          fail(REP_NOT_ALLOWED);
        });
    }
  });

  socket.on('error', () => {
    try {
      stream?.close();
    } catch {
      /* noop */
    }
  });
}
