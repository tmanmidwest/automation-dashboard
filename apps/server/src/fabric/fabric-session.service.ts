import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Client } from 'ssh2';
import type { WebSocket } from 'ws';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../logging/audit.service';
import { AgentRegistryService } from './agent-registry.service';
import { TunnelSocket } from './tunnel-socket';

/** Everything needed to establish one interactive session, held for one use. */
export interface FabricSessionDescriptor {
  agentId: string;
  targetId: string;
  userId: string;
  userEmail?: string | null;
  host: string;
  port: number;
  kind: string; // 'ssh' (Phase 3)
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

/**
 * Brokers interactive SSH sessions: mints one-time tickets (the browser opens
 * the session WebSocket with one), then, on connect, runs ssh2 over the Fabric
 * tunnel to the target and pipes the shell to the browser. Records each session
 * to FabricSession + the Ship's Log. See docs/fabric-remote-access.md (Phase 3).
 */
@Injectable()
export class FabricSessionService {
  private readonly logger = new Logger(FabricSessionService.name);
  private readonly tickets = new Map<string, { desc: FabricSessionDescriptor; expiresAt: number }>();

  constructor(
    private readonly registry: AgentRegistryService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Mint a one-time session ticket (default 30s TTL). */
  issue(desc: FabricSessionDescriptor, ttlMs = 30_000): string {
    const token = randomUUID();
    this.tickets.set(token, { desc, expiresAt: Date.now() + ttlMs });
    this.prune();
    return token;
  }

  /** Redeem a ticket exactly once. */
  consume(token: string): FabricSessionDescriptor | null {
    const entry = this.tickets.get(token);
    this.tickets.delete(token);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry.desc;
  }

  private prune(): void {
    const now = Date.now();
    for (const [t, e] of this.tickets) if (e.expiresAt < now) this.tickets.delete(t);
  }

  /**
   * Drive one session over an already-open browser WebSocket: open a tunnel
   * stream to the target, run ssh2 over it, and pipe the shell. Binary WS
   * messages are terminal bytes; text messages are `{resize:{cols,rows}}`.
   */
  async handleSession(ws: WebSocket, desc: FabricSessionDescriptor): Promise<void> {
    ws.binaryType = 'nodebuffer';

    let stream;
    try {
      stream = await this.registry.openStream(desc.agentId, desc.host, desc.port);
    } catch (e) {
      this.term(ws, `Tunnel failed: ${msg(e)}`);
      try {
        ws.close();
      } catch {
        /* noop */
      }
      return;
    }

    const conn = new Client();
    const sock = new TunnelSocket(stream);
    let shell: import('ssh2').ClientChannel | null = null;
    let sessionRowId: string | null = null;
    let bytesUp = 0;
    let bytesDown = 0;
    let cleaning = false;

    const cleanup = async () => {
      if (cleaning) return;
      cleaning = true;
      try {
        conn.end();
      } catch {
        /* noop */
      }
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
      if (sessionRowId) {
        await this.prisma.fabricSession
          .update({
            where: { id: sessionRowId },
            data: { endedAt: new Date(), bytesUp: BigInt(bytesUp), bytesDown: BigInt(bytesDown) },
          })
          .catch(() => undefined);
        await this.audit.record({
          actorId: desc.userId,
          actorEmail: desc.userEmail,
          action: 'fabric.session.end',
          target: desc.agentId,
          meta: { targetId: desc.targetId, kind: desc.kind, bytesUp, bytesDown },
        });
      }
    };

    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, async (err, channel) => {
        if (err) {
          this.term(ws, `Shell failed: ${err.message}`);
          void cleanup();
          return;
        }
        shell = channel;
        const row = await this.prisma.fabricSession
          .create({
            data: { agentId: desc.agentId, targetKind: desc.kind, userId: desc.userId },
            select: { id: true },
          })
          .catch(() => null);
        sessionRowId = row?.id ?? null;
        await this.audit.record({
          actorId: desc.userId,
          actorEmail: desc.userEmail,
          action: 'fabric.session.start',
          target: desc.agentId,
          meta: { targetId: desc.targetId, kind: desc.kind, port: desc.port, username: desc.username },
        });

        channel.on('data', (d: Buffer) => {
          bytesDown += d.length;
          if (ws.readyState === ws.OPEN) ws.send(d);
        });
        channel.stderr?.on('data', (d: Buffer) => {
          bytesDown += d.length;
          if (ws.readyState === ws.OPEN) ws.send(d);
        });
        channel.on('close', () => void cleanup());
      });
    });

    conn.on('error', (err) => {
      this.term(ws, friendlySsh(err));
      void cleanup();
    });
    // Many sshd setups answer the password via keyboard-interactive.
    if (desc.password) {
      conn.on('keyboard-interactive', (_n, _i, _l, _p, cb) => cb([desc.password as string]));
    }

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const m = JSON.parse(data.toString());
          if (m?.resize && shell) shell.setWindow(m.resize.rows, m.resize.cols, 0, 0);
        } catch {
          /* ignore malformed control */
        }
        return;
      }
      const buf = data as Buffer;
      bytesUp += buf.length;
      if (shell) shell.write(buf);
    });
    ws.on('close', () => void cleanup());
    ws.on('error', () => void cleanup());

    try {
      conn.connect({
        sock,
        username: desc.username,
        password: desc.password || undefined,
        privateKey: desc.privateKey || undefined,
        passphrase: desc.passphrase || undefined,
        tryKeyboard: !!desc.password,
        readyTimeout: 20_000,
        // Trust-on-first-use host-key pinning: learn the key on the first
        // connection, then refuse a changed key (possible MITM).
        hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
          const fp = createHash('sha256').update(key).digest('base64');
          void this.verifyHostKey(desc, fp, ws).then(verify);
        },
      });
    } catch (e) {
      this.term(ws, `Connect failed: ${msg(e)}`);
      void cleanup();
    }
  }

  /**
   * TOFU host-key check: learn the fingerprint on first connect, accept a match,
   * refuse a mismatch. A rebuilt host needs its pinned key cleared in Cerebro.
   */
  private async verifyHostKey(desc: FabricSessionDescriptor, fp: string, ws: WebSocket): Promise<boolean> {
    const target = await this.prisma.agentTarget
      .findUnique({ where: { id: desc.targetId }, select: { hostKey: true } })
      .catch(() => null);
    const stored = target?.hostKey ?? null;

    if (!stored) {
      await this.prisma.agentTarget
        .update({ where: { id: desc.targetId }, data: { hostKey: fp } })
        .catch(() => undefined);
      await this.audit.record({
        actorId: desc.userId,
        actorEmail: desc.userEmail,
        action: 'fabric.hostkey.pinned',
        target: desc.agentId,
        meta: { targetId: desc.targetId, fingerprint: fp },
      });
      return true;
    }
    if (stored === fp) return true;

    await this.audit.record({
      actorId: desc.userId,
      actorEmail: desc.userEmail,
      action: 'fabric.hostkey.mismatch',
      target: desc.agentId,
      meta: { targetId: desc.targetId, expected: stored, got: fp },
    });
    this.term(
      ws,
      'Host key mismatch — refusing to connect (possible MITM, or the host was rebuilt). ' +
        'If the host is legitimately new, reset its pinned key in Cerebro and reconnect.',
    );
    return false;
  }

  /** Write a red status line into the browser terminal (text WS frame). */
  private term(ws: WebSocket, message: string): void {
    try {
      if (ws.readyState === ws.OPEN) ws.send(`\r\n\x1b[31m[cerebro] ${message}\x1b[0m\r\n`);
    } catch {
      /* noop */
    }
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function friendlySsh(err: Error & { level?: string }): string {
  if (err.level === 'client-authentication') return 'Authentication failed — check the username and password/key.';
  if (err.level === 'client-timeout') return 'Connection timed out.';
  return `SSH error: ${err.message}`;
}
