import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { connect as netConnect, isIP } from 'net';
import { lookup } from 'dns/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import type { WebSocket } from 'ws';
import type { FabricSessionTicket, SessionUser } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../logging/audit.service';
import { SettingsService } from '../settings/settings.service';
import { AgentRegistryService } from './agent-registry.service';
import { DockerApi, type DockerAuth } from '../connectors/docker/docker-api';
import { openRemoteBrowserProxy, type RemoteBrowserProxy } from './remote-browser-proxy';

const REMOTE_BROWSER_WS_PATH = '/api/fabric/remote-browser/ws';
/** Settings key for the operator's Remote Browser overrides. */
const REMOTE_BROWSER_CONFIG_KEY = 'fabric.remoteBrowser';

/** Operator-set Remote Browser overrides (all optional; blank = fall through). */
export interface RemoteBrowserConfig {
  image?: string;
  geometry?: string;
  /** Docker network to attach the browser container to. */
  network?: string;
  /** Hostname the browser container dials back to reach Cerebro's SOCKS bridge. */
  callbackHost?: string;
}
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
    private readonly settings: SettingsService,
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
    const docker = this.dockerApi();
    // Precedence for every setting: UI-stored → env var → auto-detect → default.
    // Auto-detect (put the browser on the app's own Docker network, callback = the
    // app's container name) makes a standard compose deploy zero-config; the UI/env
    // override it for non-standard setups (e.g. a remote Docker endpoint).
    const cfg = await this.storedConfig();
    const image = cfg.image || process.env.REMOTE_BROWSER_IMAGE || 'cerebro-remote-browser:latest';
    const geometry = cfg.geometry || process.env.REMOTE_BROWSER_GEOMETRY || '1280x800';
    const network = cfg.network || process.env.REMOTE_BROWSER_NETWORK || (await this.resolveSelfNetwork(docker));
    const callbackHost =
      cfg.callbackHost ||
      process.env.REMOTE_BROWSER_CALLBACK_HOST ||
      process.env.FABRIC_GUACD_CALLBACK_HOST ||
      (await this.resolveSelfName(docker));
    if (!callbackHost) {
      throw new BadRequestException(
        'Remote Browser could not determine how the browser container reaches Cerebro. Set REMOTE_BROWSER_CALLBACK_HOST (the app’s service/container name on the Docker network).',
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

    let containerId: string;
    try {
      // Auto-build the image the first time it's needed, so no manual `docker build`
      // step is required after install/update.
      await this.ensureImage(docker, image);
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

  /** Operator-set overrides (Fabric → Remote Browser). Empty strings are treated
   *  as unset so they fall through to env/auto-detect. */
  private async storedConfig(): Promise<RemoteBrowserConfig> {
    const c = (await this.settings.get<RemoteBrowserConfig>(REMOTE_BROWSER_CONFIG_KEY)) ?? {};
    const clean = (v?: string) => (v && v.trim() ? v.trim() : undefined);
    return { image: clean(c.image), geometry: clean(c.geometry), network: clean(c.network), callbackHost: clean(c.callbackHost) };
  }

  /** Config for the settings UI: what's stored, what's currently in effect, and
   *  what auto-detect resolves (shown as placeholders). */
  async getConfig(): Promise<{
    stored: RemoteBrowserConfig;
    effective: { image: string; geometry: string; network?: string; callbackHost?: string };
    detected: { network?: string; callbackHost?: string };
    env: { network?: string; callbackHost?: string; image?: string; geometry?: string };
  }> {
    const stored = await this.storedConfig();
    let detectedNetwork: string | undefined;
    let detectedName: string | undefined;
    try {
      const docker = this.dockerApi();
      [detectedNetwork, detectedName] = await Promise.all([this.resolveSelfNetwork(docker), this.resolveSelfName(docker)]);
    } catch {
      /* Docker unreachable — leave detected blank */
    }
    const env = {
      network: process.env.REMOTE_BROWSER_NETWORK || undefined,
      callbackHost: process.env.REMOTE_BROWSER_CALLBACK_HOST || process.env.FABRIC_GUACD_CALLBACK_HOST || undefined,
      image: process.env.REMOTE_BROWSER_IMAGE || undefined,
      geometry: process.env.REMOTE_BROWSER_GEOMETRY || undefined,
    };
    return {
      stored,
      detected: { network: detectedNetwork, callbackHost: detectedName },
      env,
      effective: {
        image: stored.image || env.image || 'cerebro-remote-browser:latest',
        geometry: stored.geometry || env.geometry || '1280x800',
        network: stored.network || env.network || detectedNetwork,
        callbackHost: stored.callbackHost || env.callbackHost || detectedName,
      },
    };
  }

  /** Save the operator overrides. Blank fields clear the override (env/auto-detect wins). */
  async setConfig(input: RemoteBrowserConfig, user: SessionUser): Promise<void> {
    const clean = (v?: string | null) => (v && `${v}`.trim() ? `${v}`.trim() : undefined);
    const cfg: RemoteBrowserConfig = {
      image: clean(input.image),
      geometry: clean(input.geometry),
      network: clean(input.network),
      callbackHost: clean(input.callbackHost),
    };
    await this.settings.set(REMOTE_BROWSER_CONFIG_KEY, cfg);
    await this.audit.record({ actorId: user.id, actorEmail: user.email, action: 'fabric.remote_browser.configured', meta: { ...cfg } });
  }

  /** The Docker network the app container is on (so the browser can share it), by
   *  inspecting our own container. Undefined if it can't be determined. */
  private async resolveSelfNetwork(docker: DockerApi): Promise<string | undefined> {
    try {
      const info = await docker.inspectContainerFull(hostname());
      const nets = Object.keys(info.NetworkSettings?.Networks ?? {});
      // Prefer the compose project network over the default bridge/host/none.
      return nets.find((n) => n !== 'bridge' && n !== 'host' && n !== 'none') ?? nets[0];
    } catch {
      return undefined;
    }
  }

  /** The app's own container name (e.g. "cerebro-app"), used as the default host
   *  the browser container dials back to. */
  private async resolveSelfName(docker: DockerApi): Promise<string | undefined> {
    try {
      const info = await docker.inspectContainerFull(hostname());
      return info.Name?.replace(/^\//, '') || undefined;
    } catch {
      return undefined;
    }
  }

  /** In-flight image build, shared so concurrent launches don't build twice. */
  private imageBuild?: Promise<void>;

  /**
   * Ensure the Remote Browser image exists, building it from the bundled context
   * (docker/remote-browser, shipped in the app image) on first use — so there's no
   * manual `docker build` step after an install/update. Concurrent launches share
   * the single in-flight build; once built, the image is cached by the daemon.
   */
  private async ensureImage(docker: DockerApi, image: string): Promise<void> {
    if (await docker.imageExists(image)) return;
    if (!this.imageBuild) {
      const context = process.env.REMOTE_BROWSER_BUILD_CONTEXT || join(process.cwd(), 'docker', 'remote-browser');
      if (!existsSync(join(context, 'Dockerfile'))) {
        throw new BadRequestException(
          `The Remote Browser image "${image}" is missing and no build context was found at ${context}. ` +
            `Build it manually: docker build -t ${image} docker/remote-browser`,
        );
      }
      this.logger.log(`Remote Browser image "${image}" not found — building from ${context} (first use; may take a few minutes)…`);
      this.imageBuild = docker
        .buildImage(context, image)
        .then(() => void this.logger.log(`Remote Browser image "${image}" built.`))
        .finally(() => {
          this.imageBuild = undefined;
        });
    }
    await this.imageBuild;
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
