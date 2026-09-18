import { createServer } from 'net';
import type { Logger } from '@nestjs/common';
import type { AgentRegistryService } from './agent-registry.service';
import type { TunnelStream } from './stream-mux';

export interface TunnelForward {
  /** Port the forward listens on (bindHost:port). */
  port: number;
  /** Tear the forward + its tunnel stream down. */
  close: () => void;
}

/**
 * Opens a short-lived local TCP listener that bridges its first (and only)
 * connection to a target on the agent, over the Fabric tunnel. Used by the RDP
 * path: guacd needs a real host:port to dial, so we hand it `bindHost:port` and
 * pipe that socket through the tunnel to `127.0.0.1:3389` on the box.
 *
 * The listener accepts exactly one connection then stops listening; if nothing
 * connects within `idleTimeoutMs` it closes itself. `onClosed` fires once when
 * everything is torn down (used to stamp the session's end).
 */
export function openTunnelForward(
  registry: AgentRegistryService,
  opts: {
    agentId: string;
    host: string;
    port: number;
    bindHost?: string;
    idleTimeoutMs?: number;
    onClosed?: () => void;
    logger?: Logger;
  },
): Promise<TunnelForward> {
  const { agentId, host, port, bindHost = '0.0.0.0', idleTimeoutMs = 30_000 } = opts;
  return new Promise((resolve, reject) => {
    const server = createServer();
    let stream: TunnelStream | null = null;
    let closed = false;

    const closeAll = () => {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      try {
        server.close();
      } catch {
        /* noop */
      }
      try {
        stream?.close();
      } catch {
        /* noop */
      }
      opts.onClosed?.();
    };

    const idle = setTimeout(() => {
      if (!stream) closeAll();
    }, idleTimeoutMs);
    idle.unref?.();

    server.on('connection', async (socket) => {
      server.close(); // only the first connection is honored
      try {
        stream = await registry.openStream(agentId, host, port);
      } catch (e) {
        opts.logger?.warn(`Tunnel forward failed to open stream: ${e instanceof Error ? e.message : e}`);
        socket.destroy();
        closeAll();
        return;
      }
      stream.onData = (b: Buffer) => {
        if (!socket.destroyed) socket.write(b);
      };
      stream.onClose = () => {
        try {
          socket.end();
        } catch {
          /* noop */
        }
      };
      socket.on('data', (b: Buffer) => stream?.write(b));
      socket.on('close', closeAll);
      socket.on('error', closeAll);
    });

    server.on('error', (e) => {
      clearTimeout(idle);
      reject(e);
    });

    server.listen(0, bindHost, () => {
      const addr = server.address();
      const listenPort = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port: listenPort, close: closeAll });
    });
  });
}
