import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'crypto';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { hostname, networkInterfaces } from 'os';
import { FABRIC_RDP_SECURITY, type FabricSessionTicket } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../logging/audit.service';
import { LoggingService } from '../logging/logging.service';
import { AgentRegistryService } from './agent-registry.service';
import { openTunnelForward, type TunnelForward } from './tunnel-forward';

const GUAC_WS_PATH = '/api/fabric/guac/ws';
const GUAC_CIPHER = 'AES-256-CBC';

/** Everything needed to open one RDP session, held for one use. */
export interface RdpDescriptor {
  agentId: string;
  targetId: string;
  userId: string;
  userEmail?: string | null;
  host: string;
  port: number;
  username: string;
  password: string;
  domain?: string;
  // Display / session options.
  width?: number;
  height?: number;
  colorDepth?: number;
  security?: string;
  consoleSession?: boolean;
  enableEffects?: boolean;
  disableAudio?: boolean;
}

/**
 * Brokers in-browser RDP via the guacd sidecar (Phase 4). Mints an encrypted
 * guacamole-lite token wrapping a one-time ticket; when the browser connects,
 * guacamole-lite calls back into {@link resolveConnection}, which opens an
 * ephemeral forward through the Fabric tunnel and hands guacd the RDP settings
 * pointing at it. See docs/fabric-remote-access.md.
 */
@Injectable()
export class FabricGuacService {
  private readonly logger = new Logger(FabricGuacService.name);
  private readonly tickets = new Map<
    string,
    { desc: RdpDescriptor; forward: TunnelForward; callbackHost: string; recordName?: string; expiresAt: number }
  >();
  /** 32-byte key shared with the guacamole-lite server (clientOptions.crypt.key). */
  readonly cryptKey = createHash('sha256')
    .update(process.env.APP_ENCRYPTION_KEY ?? '')
    .digest('hex')
    .slice(0, 32);

  constructor(
    private readonly registry: AgentRegistryService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logging: LoggingService,
  ) {}

  /**
   * Mint an encrypted RDP token the browser opens the guac WS with. All async
   * work (open the tunnel forward, resolve guacd's callback address, record the
   * session) happens HERE — because guacamole-lite calls the guacd connection
   * SYNCHRONOUSLY and does not await our processConnectionSettings hook, so
   * resolveConnection must be able to return the real settings synchronously.
   */
  async issue(desc: RdpDescriptor, ttlMs = 30_000): Promise<FabricSessionTicket> {
    const id = randomUUID();
    this.prune();

    const row = await this.prisma.fabricSession
      .create({
        data: {
          agentId: desc.agentId,
          targetKind: 'rdp',
          userId: desc.userId,
          targetHost: desc.host,
          targetPort: desc.port,
        },
        select: { id: true },
      })
      .catch(() => null);

    // Record the session (guacd writes it to the shared volume) unless disabled.
    // recording-name is the session row id, so the recording maps 1:1 to it.
    let recordName: string | undefined;
    if (row?.id && !process.env.FABRIC_RECORDING_DISABLED) {
      recordName = row.id;
      await this.prisma.fabricSession
        .update({ where: { id: row.id }, data: { recordPath: recordName } })
        .catch(() => undefined);
    }

    await this.audit.record({
      actorId: desc.userId,
      actorEmail: desc.userEmail,
      action: 'fabric.session.start',
      target: desc.agentId,
      meta: { targetId: desc.targetId, kind: 'rdp', port: desc.port, username: desc.username, recorded: !!recordName },
    });

    // The address guacd dials to reach our forward: explicit override, else this
    // container's IP on guacd's subnet, else first non-internal IP, else hostname.
    const callbackHost =
      process.env.FABRIC_GUACD_CALLBACK_HOST || (await this.guacdReachableIp()) || selfIp() || hostname();
    // Bind the ephemeral forward to the exact interface guacd dials (when that's an
    // IP), not 0.0.0.0 — so a co-tenant on another network this container is on can't
    // race the listener. Falls back to all-interfaces only when we can't resolve an IP.
    const bindHost = isIP(callbackHost) ? callbackHost : '0.0.0.0';

    const forward = await openTunnelForward(this.registry, {
      agentId: desc.agentId,
      host: desc.host,
      port: desc.port,
      bindHost,
      // A little slack so guacd has time to dial after the browser opens the WS.
      idleTimeoutMs: 45_000,
      logger: this.logger,
      onClosed: () => {
        if (row?.id) {
          void this.prisma.fabricSession
            .update({ where: { id: row.id }, data: { endedAt: new Date() } })
            .catch(() => undefined);
        }
        void this.audit.record({
          actorId: desc.userId,
          actorEmail: desc.userEmail,
          action: 'fabric.session.end',
          target: desc.agentId,
          meta: { targetId: desc.targetId, kind: 'rdp' },
        });
      },
    });
    this.logging.info(
      'fabric',
      `RDP forward on ${callbackHost}:${forward.port} -> ${desc.host}:${desc.port} (agent ${desc.agentId})`,
    );

    this.tickets.set(id, { desc, forward, callbackHost, recordName, expiresAt: Date.now() + ttlMs });
    const token = this.encryptToken({ connection: { type: 'rdp', settings: { _ticket: id } } });
    return { token, wsPath: GUAC_WS_PATH };
  }

  /**
   * guacamole-lite hook (SYNCHRONOUS — see issue()): redeem the ticket and fill
   * in guacd's RDP connect args pointing at the already-open forward. guacd reads
   * these directly from `connection` (the flattened settings object).
   */
  resolveConnection(settings: { connection: Record<string, unknown> }): typeof settings {
    // guacamole-lite flattens the token's `connection.settings` onto `connection`,
    // so the ticket arrives at `connection._ticket` (accept the legacy path too).
    const conn = (settings.connection ?? {}) as Record<string, unknown> & {
      settings?: Record<string, unknown>;
    };
    const id = String(conn._ticket ?? conn.settings?._ticket ?? '');
    const entry = id ? this.tickets.get(id) : undefined;
    if (id) this.tickets.delete(id);
    if (!entry || entry.expiresAt < Date.now()) throw new Error('Invalid or expired RDP ticket.');
    const d = entry.desc;

    const args: Record<string, string> = {
      ...(conn as Record<string, string>),
      hostname: entry.callbackHost,
      port: String(entry.forward.port),
      username: d.username,
      password: d.password,
      domain: d.domain || '',
      security: d.security && FABRIC_RDP_SECURITY.includes(d.security as never) ? d.security : 'any',
      'ignore-cert': 'true',
      'resize-method': 'display-update',
      dpi: '96',
      width: String(d.width && d.width > 0 ? d.width : 1024),
      height: String(d.height && d.height > 0 ? d.height : 768),
    };
    if (entry.recordName) {
      args['recording-path'] = process.env.FABRIC_RECORDING_DIR || '/recordings';
      args['recording-name'] = entry.recordName;
      args['create-recording-path'] = 'true';
    }
    if (d.colorDepth) args['color-depth'] = String(d.colorDepth);
    if (d.consoleSession) args['console'] = 'true';
    if (d.disableAudio) args['disable-audio'] = 'true';
    if (d.enableEffects) {
      args['enable-wallpaper'] = 'true';
      args['enable-theming'] = 'true';
      args['enable-font-smoothing'] = 'true';
      args['enable-full-window-drag'] = 'true';
      args['enable-desktop-composition'] = 'true';
      args['enable-menu-animations'] = 'true';
    }
    delete args._ticket;
    settings.connection = args;
    return settings;
  }

  get wsPath(): string {
    return GUAC_WS_PATH;
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.tickets) if (v.expiresAt < now) this.tickets.delete(k);
  }

  /**
   * This container's own IPv4 address on the same subnet as the guacd sidecar —
   * the address guacd can actually route back to for the forward. Resolves
   * GUACD_HOST to find guacd's network, then matches our interfaces against it.
   */
  private async guacdReachableIp(): Promise<string | null> {
    const guacdHost = process.env.GUACD_HOST || 'guacd';
    let guacdIp: string | null = null;
    try {
      guacdIp = (await lookup(guacdHost, { family: 4 })).address;
    } catch (e) {
      this.logging.warn('fabric', `Could not resolve GUACD_HOST "${guacdHost}": ${e instanceof Error ? e.message : e}`);
    }
    const ifaces = networkInterfaces();
    const candidates: string[] = [];
    let match: string | null = null;
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] ?? []) {
        if ((ni.family === 'IPv4' || (ni.family as unknown) === 4) && !ni.internal) {
          candidates.push(`${ni.address}/${ni.netmask}`);
          if (guacdIp && !match && sameSubnet(ni.address, ni.netmask, guacdIp)) match = ni.address;
        }
      }
    }
    this.logging.info(
      'fabric',
      `guacd(${guacdHost})=${guacdIp ?? '?'}; app IPv4 ${candidates.join(', ') || '(none)'}; picked ${match ?? '(none — will fall back)'}`,
    );
    return match;
  }

  /** Replicates guacamole-lite's Crypt.encrypt so its server can decrypt our token. */
  private encryptToken(payload: unknown): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv(GUAC_CIPHER, this.cryptKey, iv);
    let encrypted = cipher.update(JSON.stringify(payload), 'utf8', 'binary');
    encrypted += cipher.final('binary');
    const data = {
      iv: iv.toString('base64'),
      value: Buffer.from(encrypted, 'binary').toString('base64'),
    };
    return Buffer.from(JSON.stringify(data), 'ascii').toString('base64');
  }
}

/** This container's first non-internal IPv4 address (its Docker-network IP), or null. */
function selfIp(): string | null {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

/** True when `a` and `b` share a subnet under IPv4 `mask` (dotted-quad). */
function sameSubnet(a: string, mask: string, b: string): boolean {
  const toInt = (ip: string) =>
    ip.split('.').reduce((acc, oct) => ((acc << 8) + (parseInt(oct, 10) & 255)) >>> 0, 0) >>> 0;
  const ai = toInt(a);
  const bi = toInt(b);
  const mi = toInt(mask);
  return ((ai & mi) >>> 0) === ((bi & mi) >>> 0);
}
