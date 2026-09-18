import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'crypto';
import { lookup } from 'dns/promises';
import { hostname, networkInterfaces } from 'os';
import type { FabricSessionTicket } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../logging/audit.service';
import { LoggingService } from '../logging/logging.service';
import { AgentRegistryService } from './agent-registry.service';
import { openTunnelForward } from './tunnel-forward';

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
  private readonly tickets = new Map<string, { desc: RdpDescriptor; expiresAt: number }>();
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

  /** Mint an encrypted RDP token the browser opens the guac WS with. */
  issue(desc: RdpDescriptor, ttlMs = 30_000): FabricSessionTicket {
    const id = randomUUID();
    this.tickets.set(id, { desc, expiresAt: Date.now() + ttlMs });
    this.prune();
    const token = this.encryptToken({ connection: { type: 'rdp', settings: { _ticket: id } } });
    return { token, wsPath: GUAC_WS_PATH };
  }

  /**
   * guacamole-lite hook: redeem the ticket, open a forward through the tunnel,
   * and return the real guacd RDP settings pointing at it. Mutates and returns
   * the passed settings object (its `.connection.settings` becomes guacd's args).
   */
  async resolveConnection(settings: {
    connection: Record<string, unknown>;
  }): Promise<typeof settings> {
    // guacamole-lite flattens the token's `connection.settings` onto `connection`
    // before this callback, so the ticket arrives at `connection._ticket` (older
    // versions used `connection.settings._ticket` — accept both).
    const conn = (settings.connection ?? {}) as Record<string, unknown> & {
      settings?: Record<string, unknown>;
    };
    const id = String(conn._ticket ?? conn.settings?._ticket ?? '');
    const entry = id ? this.tickets.get(id) : undefined;
    if (id) this.tickets.delete(id);
    if (!entry || entry.expiresAt < Date.now()) throw new Error('Invalid or expired RDP ticket.');
    const d = entry.desc;

    const row = await this.prisma.fabricSession
      .create({ data: { agentId: d.agentId, targetKind: 'rdp', userId: d.userId }, select: { id: true } })
      .catch(() => null);
    await this.audit.record({
      actorId: d.userId,
      actorEmail: d.userEmail,
      action: 'fabric.session.start',
      target: d.agentId,
      meta: { targetId: d.targetId, kind: 'rdp', port: d.port, username: d.username },
    });

    const forward = await openTunnelForward(this.registry, {
      agentId: d.agentId,
      host: d.host,
      port: d.port,
      bindHost: '0.0.0.0',
      logger: this.logger,
      onClosed: () => {
        if (row?.id) {
          void this.prisma.fabricSession
            .update({ where: { id: row.id }, data: { endedAt: new Date() } })
            .catch(() => undefined);
        }
        void this.audit.record({
          actorId: d.userId,
          actorEmail: d.userEmail,
          action: 'fabric.session.end',
          target: d.agentId,
          meta: { targetId: d.targetId, kind: 'rdp' },
        });
      },
    });

    // The address guacd will dial to reach our forward. An explicit env override
    // wins; otherwise use this container's IP ON THE SAME SUBNET AS guacd (the app
    // may be on several Docker networks — e.g. a reverse-proxy network — and only
    // one is shared with guacd); fall back to the first non-internal IP, then
    // hostname. No DNS resolution is required of guacd this way.
    const callbackHost =
      process.env.FABRIC_GUACD_CALLBACK_HOST || (await this.guacdReachableIp()) || selfIp() || hostname();
    // Route through the DB logger so it lands in the Ship's Log (readable remotely).
    this.logging.info(
      'fabric',
      `RDP forward on ${callbackHost}:${forward.port} -> ${d.host}:${d.port} (agent ${d.agentId})`,
    );

    // guacd reads its connect args directly from `connection` (the flattened
    // object), so replace it with the RDP settings pointing at the forward.
    settings.connection = {
      hostname: callbackHost,
      port: String(forward.port),
      username: d.username,
      password: d.password,
      domain: d.domain || '',
      security: 'any',
      'ignore-cert': 'true',
      'resize-method': 'display-update',
      width: '1024',
      height: '768',
      dpi: '96',
    };
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
