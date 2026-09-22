import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { connect as netConnect, isIP } from 'net';
import { lookup } from 'dns/promises';
import { randomUUID } from 'crypto';
import type { WebSocket } from 'ws';
import type { FabricSessionTicket, SessionUser } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../logging/audit.service';
import { AgentRegistryService } from './agent-registry.service';
import { DockerApi, type DockerAuth } from '../connectors/docker/docker-api';
import { openRemoteBrowserProxy, type RemoteBrowserProxy } from './remote-browser-proxy';

const REMOTE_BROWSER_WS_PATH = '/api/fabric/remote-browser/ws';
const REDEEM_TTL_MS = 60_000; // tear the browser down if the ticket is never opened
const MAX_SESSION_MS = 8 * 60 * 60 * 1000; // hard safety cap on a browser's lifetime
const VNC_PORT = 5900;

interface RemoteBrowserSession {
  token: string;
  agentId: string;
  targetId: string;
  userId: string;
  userEmail?: string | null;
  url: string;
  host: string;
  port: number;
  containerId: string;
  proxy: RemoteBrowserProxy;
  vncHost: string;
  redeemed: boolean;
  redeemTimer?: NodeJS.Timeout;
  maxTimer?: NodeJS.Timeout;
  sessionRowId?: string;
}

/**
 * Remote Browser (see docs/fabric-waypoints.md): an operator connects to an internal web
 * app that is only reachable from a Waypoint's network. We spin an **ephemeral,
 * per-session headless-Chromium container** whose browser is proxied (SOCKS5)
 * through the Waypoint tunnel, and stream its screen back over VNC (reusing the
 * noVNC viewer). The browser is isolated (fresh profile, own container) and torn
 * down when the operator disconnects.
 */
@Injectable()
export class RemoteBrowserService {
  private readonly logger = new Logger('RemoteBrowser');
  private readonly sessions = new Map<string, RemoteBrowserSession>();
  private docker?: DockerApi;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly registry: AgentRegistryService,
  ) {}

  private dockerApi(): DockerApi {
    if (this.docker) return this.docker;
    const auth: DockerAuth = {
      endpoint: process.env.REMOTE_BROWSER_DOCKER_ENDPOINT || 'unix:///var/run/docker.sock',
      tlsCaCert: process.env.REMOTE_BROWSER_DOCKER_TLS_CA || undefined,
      tlsClientCert: process.env.REMOTE_BROWSER_DOCKER_TLS_CERT || undefined,
      tlsClientKey: process.env.REMOTE_BROWSER_DOCKER_TLS_KEY || undefined,
      insecureAllowPlaintext: true,
    };
    this.docker = new DockerApi(auth);
    return this.docker;
  }

  /**
   * Launch a browser for a remote browser item and mint a one-time VNC ticket. The
   * caller (FabricService) has already checked the target is a `web` route on
   * an online Waypoint.
   */
  async launch(params: {
    agentId: string;
    targetId: string;
    url: string;
    host: string;
    port: number;
    user: SessionUser;
  }): Promise<FabricSessionTicket> {
    const image = process.env.REMOTE_BROWSER_IMAGE || 'cerebro-remote-browser:latest';
    const network = process.env.REMOTE_BROWSER_NETWORK || undefined;
    const callbackHost = process.env.REMOTE_BROWSER_CALLBACK_HOST || process.env.FABRIC_GUACD_CALLBACK_HOST;
    const geometry = process.env.REMOTE_BROWSER_GEOMETRY || '1280x800';
    if (!callbackHost) {
      throw new BadRequestException(
        'Remote Browser is not configured: set REMOTE_BROWSER_CALLBACK_HOST (the Cerebro service name reachable from the browser container).',
      );
    }

    const token = randomUUID();
    // Bind the SOCKS bridge to the exact interface the browser reaches us on (the
    // IP `callbackHost` resolves to) instead of all interfaces, so it isn't a
    // credential-free pivot open to any peer on another network this container is on.
    // Fail-open to 0.0.0.0 if we can't resolve it (keeps the feature working).
    const bindHost = await this.resolveBindHost(callbackHost);
    const proxy = await openRemoteBrowserProxy(this.registry, { agentId: params.agentId, bindHost, logger: this.logger });
    const name = `cerebro-remote-browser-${token.slice(0, 8)}`;
    const docker = this.dockerApi();

    let containerId: string;
    try {
      containerId = await docker.createContainer(name, {
        Image: image,
        Env: [
          `START_URL=${params.url}`,
          `CHROME_PROXY=socks5://${callbackHost}:${proxy.port}`,
          `GEOMETRY=${geometry}`,
        ],
        Labels: { 'cerebro.remote-browser': 'true', 'cerebro.remote-browser.session': token },
        HostConfig: {
          AutoRemove: true,
          ShmSize: 1073741824, // 1 GiB — Chromium is unhappy with a tiny /dev/shm
          ...(network ? { NetworkMode: network } : {}),
        },
      });
      await docker.startContainer(containerId);
    } catch (e) {
      proxy.close();
      this.logger.warn(`Remote Browser container failed to start: ${e instanceof Error ? e.message : e}`);
      throw new BadRequestException(
        `Could not start the Remote Browser (image "${image}"). ${e instanceof Error ? e.message : ''}`.trim(),
      );
    }

    const vncHost = await this.resolveContainerIp(docker, containerId, network);
    if (!vncHost) {
      await docker.removeContainer(containerId).catch(() => undefined);
      proxy.close();
      throw new BadRequestException('Could not determine the Remote Browser container IP (check REMOTE_BROWSER_NETWORK).');
    }

    const session: RemoteBrowserSession = {
      token,
      agentId: params.agentId,
      targetId: params.targetId,
      userId: params.user.id,
      userEmail: params.user.email,
      url: params.url,
      host: params.host,
      port: params.port,
      containerId,
      proxy,
      vncHost,
      redeemed: false,
    };
    // If the browser is never opened, reclaim it.
    session.redeemTimer = setTimeout(() => {
      if (!session.redeemed) void this.teardown(session, 'unredeemed');
    }, REDEEM_TTL_MS);
    session.redeemTimer.unref?.();
    session.maxTimer = setTimeout(() => void this.teardown(session, 'max-lifetime'), MAX_SESSION_MS);
    session.maxTimer.unref?.();
    this.sessions.set(token, session);

    await this.audit.record({
      actorId: params.user.id,
      actorEmail: params.user.email,
      action: 'fabric.remoteBrowser.launched',
      target: params.agentId,
      meta: { targetId: params.targetId, url: params.url, host: params.host, port: params.port },
    });

    return { token, wsPath: REMOTE_BROWSER_WS_PATH };
  }

  /** Redeem a one-time ticket (called by the WS relay on upgrade). */
  consume(token: string): RemoteBrowserSession | null {
    const s = this.sessions.get(token);
    if (!s || s.redeemed) return null;
    s.redeemed = true;
    if (s.redeemTimer) clearTimeout(s.redeemTimer);
    return s;
  }

  /** Relay the browser's VNC display to the operator's noVNC client. */
  async handleWs(ws: WebSocket, session: RemoteBrowserSession): Promise<void> {
    ws.binaryType = 'nodebuffer';
    const tcp = netConnect(VNC_PORT, session.vncHost);

    const row = await this.prisma.fabricSession
      .create({
        data: {
          agentId: session.agentId,
          targetKind: 'web',
          userId: session.userId,
          targetHost: session.host,
          targetPort: session.port,
          targetLabel: session.url,
        },
        select: { id: true },
      })
      .catch(() => null);
    session.sessionRowId = row?.id;

    let down = false;
    const end = () => {
      if (down) return;
      down = true;
      try { tcp.destroy(); } catch { /* noop */ }
      try { ws.close(); } catch { /* noop */ }
      if (row?.id) {
        this.prisma.fabricSession
          .update({ where: { id: row.id }, data: { endedAt: new Date() } })
          .catch(() => undefined);
      }
      void this.teardown(session, 'disconnect');
    };

    tcp.on('connect', () => { /* connected to the container's VNC server */ });
    tcp.on('data', (d) => {
      try {
        if (ws.readyState === ws.OPEN) ws.send(d);
      } catch { /* noop */ }
    });
    tcp.on('close', end);
    tcp.on('error', end);
    ws.on('message', (data) => {
      const buf = Array.isArray(data) ? Buffer.concat(data as Buffer[]) : (data as Buffer);
      if (!tcp.destroyed) tcp.write(buf);
    });
    ws.on('close', end);
    ws.on('error', end);
  }

  private async teardown(session: RemoteBrowserSession, reason: string): Promise<void> {
    if (!this.sessions.has(session.token)) return;
    this.sessions.delete(session.token);
    if (session.redeemTimer) clearTimeout(session.redeemTimer);
    if (session.maxTimer) clearTimeout(session.maxTimer);
    try { session.proxy.close(); } catch { /* noop */ }
    // AutoRemove:true means stopping the container removes it; force-remove anyway.
    await this.dockerApi().removeContainer(session.containerId).catch(() => undefined);
    this.logger.log(`Remote Browser ${session.token.slice(0, 8)} torn down (${reason}).`);
  }

  /** Read the container's IP on the chosen network (retrying past the start race). */
  private async resolveContainerIp(
    docker: DockerApi,
    containerId: string,
    network?: string,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const info = await docker.inspectContainerFull(containerId);
        const nets = info.NetworkSettings?.Networks ?? {};
        const pick = network && nets[network] ? nets[network] : Object.values(nets)[0];
        const ip = (pick as { IPAddress?: string } | undefined)?.IPAddress;
        if (ip) return ip;
      } catch {
        /* container may not be inspectable yet */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  }

  /** The interface IP to bind the SOCKS bridge to: the address `callbackHost`
   *  resolves to (what the browser dials), or 0.0.0.0 if it can't be resolved. */
  private async resolveBindHost(callbackHost: string): Promise<string> {
    if (isIP(callbackHost)) return callbackHost;
    try {
      const { address } = await lookup(callbackHost);
      return address || '0.0.0.0';
    } catch {
      return '0.0.0.0';
    }
  }
}
