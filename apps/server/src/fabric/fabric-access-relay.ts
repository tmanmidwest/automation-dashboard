import type { Server } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Logger } from '@nestjs/common';
import type { AgentTarget } from '@prisma/client';
import type { SessionUser } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../logging/audit.service';
import { TokenAuthService } from '../auth/token-auth.service';
import { AgentRegistryService } from './agent-registry.service';

const ACCESS_PATH = '/api/fabric/access/ws';
const logger = new Logger('FabricAccessRelay');

export interface FabricAccessDeps {
  tokenAuth: TokenAuthService;
  registry: AgentRegistryService;
  prisma: PrismaService;
  audit: AuditService;
}

/**
 * Raw TCP-over-WebSocket relay for the native `cerebro access` CLI (Phase 5).
 * The CLI opens a local listener; each local connection dials
 * `/api/fabric/access/ws?target=<targetId>` with a bearer API token
 * (`fabric:connect`). We authenticate, open a tunnel stream to the target, and
 * pipe raw bytes — so `ssh`/`scp`/`mstsc` ride the same tunnel as the browser.
 */
export function attachFabricAccessRelay(server: Server, deps: FabricAccessDeps): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '', 'http://localhost');
    } catch {
      return;
    }
    if (url.pathname !== ACCESS_PATH) return; // not ours

    const header = req.headers['authorization'];
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    // Header only — the `cerebro access` CLI always sends Authorization; a query-param
    // token would leak into proxy/access logs.
    const token = bearer;
    const targetId = url.searchParams.get('target') || '';

    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`);
      socket.destroy();
    };

    (async () => {
      const principal = await deps.tokenAuth.resolve(`Bearer ${token}`).catch(() => null);
      if (!principal || !principal.user.permissions.includes('fabric:connect')) {
        return reject(401, 'Unauthorized');
      }
      if (!targetId) return reject(400, 'Bad Request');
      const target = await deps.prisma.agentTarget.findUnique({ where: { id: targetId } }).catch(() => null);
      if (!target) return reject(404, 'Not Found');
      // The raw CLI tunnel has no per-session approval step, so it must not become a
      // way around a four-eyes agent's requireApproval gate. Refuse those here — the
      // approval-gated flows (browser SSH/RDP/VNC/Remote Browser) remain available.
      const agent = await deps.prisma.agent
        .findUnique({ where: { id: target.agentId }, select: { requireApproval: true } })
        .catch(() => null);
      if (agent?.requireApproval) {
        await deps.audit.record({
          actorId: principal.user.id,
          actorEmail: principal.user.email,
          action: 'fabric.session.denied',
          target: target.agentId,
          meta: { targetId: target.id, kind: target.kind, via: 'cli', reason: 'approval-required' },
        });
        return reject(403, 'Approval Required — use the browser');
      }
      if (!deps.registry.isOnline(target.agentId)) return reject(409, 'Agent Offline');

      wss.handleUpgrade(req, socket, head, (client) => {
        void bridgeAccess(client, target, principal.user, deps);
      });
    })().catch((err) => {
      logger.warn(`Access auth error: ${err?.message ?? err}`);
      try {
        socket.destroy();
      } catch {
        /* noop */
      }
    });
  });

  logger.log(`Fabric access relay listening on ${ACCESS_PATH}`);
}

async function bridgeAccess(
  ws: WebSocket,
  target: AgentTarget,
  user: SessionUser,
  deps: FabricAccessDeps,
): Promise<void> {
  ws.binaryType = 'nodebuffer';
  let stream;
  try {
    stream = await deps.registry.openStream(target.agentId, target.host, target.port);
  } catch {
    try {
      ws.close(1011, 'tunnel failed');
    } catch {
      /* noop */
    }
    return;
  }

  const row = await deps.prisma.fabricSession
    .create({
      data: {
        agentId: target.agentId,
        targetKind: target.kind,
        userId: user.id,
        targetHost: target.host,
        targetPort: target.port,
      },
      select: { id: true },
    })
    .catch(() => null);
  await deps.audit.record({
    actorId: user.id,
    actorEmail: user.email,
    action: 'fabric.session.start',
    target: target.agentId,
    meta: { targetId: target.id, kind: target.kind, via: 'cli' },
  });

  let up = 0;
  let down = 0;
  let cleaning = false;
  const cleanup = async () => {
    if (cleaning) return;
    cleaning = true;
    try {
      stream.close();
    } catch {
      /* noop */
    }
    try {
      ws.close();
    } catch {
      /* noop */
    }
    if (row?.id) {
      await deps.prisma.fabricSession
        .update({ where: { id: row.id }, data: { endedAt: new Date(), bytesUp: BigInt(up), bytesDown: BigInt(down) } })
        .catch(() => undefined);
    }
    await deps.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'fabric.session.end',
      target: target.agentId,
      meta: { targetId: target.id, kind: target.kind, via: 'cli', bytesUp: up, bytesDown: down },
    });
  };

  stream.onData = (b: Buffer) => {
    down += b.length;
    if (ws.readyState === ws.OPEN) ws.send(b);
  };
  stream.onClose = () => void cleanup();

  ws.on('message', (data) => {
    const buf = data as Buffer;
    up += buf.length;
    stream.write(buf);
  });
  ws.on('close', () => void cleanup());
  ws.on('error', () => void cleanup());
}
