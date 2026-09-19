import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { posix } from 'path';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';
import type { Readable } from 'stream';
import { Client } from 'ssh2';
import type { FileEntry, SFTPWrapper } from 'ssh2';
import type { FabricSftpEntry, FabricSftpListing, FabricSftpOpenResult, FabricSshConnectInput, SessionUser } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../logging/audit.service';
import { AgentRegistryService } from './agent-registry.service';
import { FabricService } from './fabric.service';
import { TunnelSocket } from './tunnel-socket';
import { checkHostKey } from './fabric-hostkey';
import type { TunnelStream } from './stream-mux';

/** Idle lifetime of an SFTP session — closed after this long with no activity. */
const IDLE_TTL_MS = 5 * 60 * 1000;

interface SftpSession {
  conn: Client;
  sftp: SFTPWrapper;
  stream: TunnelStream;
  agentId: string;
  targetId: string;
  userId: string;
  userEmail?: string | null;
  timer: NodeJS.Timeout;
  closed: boolean;
}

/**
 * SFTP file browser for a Fabric host. Rides the same SSH connection over the
 * tunnel as the in-browser terminal (ssh2 `sock` = {@link TunnelSocket}), so it
 * needs no agent changes and reuses the credential picker + host-key pin. A
 * session is opened once and then browsed/transferred by its id until it idles
 * out. See docs/fabric-remote-access.md.
 */
@Injectable()
export class FabricSftpService {
  private readonly logger = new Logger(FabricSftpService.name);
  private readonly sessions = new Map<string, SftpSession>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly registry: AgentRegistryService,
    private readonly fabric: FabricService,
  ) {}

  /** Open an SFTP session to a host's SSH target and return the home listing. */
  async open(
    agentId: string,
    targetId: string,
    input: FabricSshConnectInput,
    user: SessionUser,
  ): Promise<FabricSftpOpenResult> {
    const target = await this.prisma.agentTarget.findFirst({ where: { id: targetId, agentId } });
    if (!target) throw new NotFoundException('Target not found.');
    if (target.kind !== 'ssh') {
      throw new BadRequestException('File transfer needs an SSH target on this host (enable SSH / Remote Login).');
    }
    if (!this.registry.isOnline(agentId)) throw new BadRequestException('Agent is offline.');

    const creds = await this.fabric.resolveSshCreds(target, input, user);
    const stream = await this.registry.openStream(agentId, target.host, target.port);

    const conn = new Client();
    let sftp: SFTPWrapper;
    try {
      sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        let settled = false;
        const fail = (e: Error) => {
          if (settled) return;
          settled = true;
          try { conn.end(); } catch { /* noop */ }
          try { stream.close(); } catch { /* noop */ }
          reject(e);
        };
        conn.on('ready', () =>
          conn.sftp((err, s) => {
            if (err) return fail(err);
            settled = true;
            resolve(s);
          }),
        );
        conn.on('error', (e) => fail(friendly(e as Error & { level?: string })));
        if (creds.password) {
          conn.on('keyboard-interactive', (_n, _i, _l, _p, cb) => cb([creds.password as string]));
        }
        conn.connect({
          sock: new TunnelSocket(stream),
          username: creds.username,
          password: creds.password || undefined,
          privateKey: creds.privateKey || undefined,
          passphrase: creds.passphrase || undefined,
          tryKeyboard: !!creds.password,
          readyTimeout: 20_000,
          hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
            void checkHostKey(this.prisma, this.audit, { userId: user.id, userEmail: user.email, agentId, targetId }, key)
              .then((r) => verify(r.ok))
              .catch(() => verify(false));
          },
        });
      });
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : 'Failed to open the file session.');
    }

    const sessionId = randomUUID();
    const session: SftpSession = {
      conn,
      sftp,
      stream,
      agentId,
      targetId,
      userId: user.id,
      userEmail: user.email,
      timer: setTimeout(() => this.dispose(sessionId), IDLE_TTL_MS),
      closed: false,
    };
    session.timer.unref?.();
    this.sessions.set(sessionId, session);
    // The connection dying (network, idle server) must clean the session up too.
    conn.on('close', () => this.dispose(sessionId));
    conn.on('error', () => this.dispose(sessionId));

    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'fabric.sftp.open',
      target: agentId,
      meta: { targetId },
    });

    const listing = await this.list(sessionId, user, '.');
    return { sessionId, listing };
  }

  /** List a directory (resolving `.`/`..`/symlinks via realpath first). */
  async list(sessionId: string, user: SessionUser, path: string): Promise<FabricSftpListing> {
    const s = this.require(sessionId, user);
    const realpath = promisify(s.sftp.realpath.bind(s.sftp));
    const readdir = promisify(s.sftp.readdir.bind(s.sftp)) as (p: string) => Promise<FileEntry[]>;
    const abs = await realpath(path).catch(() => path);
    const entries = await readdir(abs).catch((e: Error) => {
      throw new BadRequestException(`Cannot open ${abs}: ${e.message}`);
    });
    return { path: abs, entries: entries.map(mapEntry).sort(byDirThenName) };
  }

  async mkdir(sessionId: string, user: SessionUser, path: string): Promise<void> {
    const s = this.require(sessionId, user);
    await promisify(s.sftp.mkdir.bind(s.sftp))(path).catch((e: Error) => {
      throw new BadRequestException(e.message);
    });
    await this.record(s, 'fabric.sftp.mkdir', { path });
  }

  async rename(sessionId: string, user: SessionUser, from: string, to: string): Promise<void> {
    const s = this.require(sessionId, user);
    await promisify(s.sftp.rename.bind(s.sftp))(from, to).catch((e: Error) => {
      throw new BadRequestException(e.message);
    });
    await this.record(s, 'fabric.sftp.rename', { from, to });
  }

  async remove(sessionId: string, user: SessionUser, path: string, dir: boolean): Promise<void> {
    const s = this.require(sessionId, user);
    const op = dir ? s.sftp.rmdir.bind(s.sftp) : s.sftp.unlink.bind(s.sftp);
    await promisify(op)(path).catch((e: Error) => {
      throw new BadRequestException(e.message);
    });
    await this.record(s, 'fabric.sftp.remove', { path, dir });
  }

  /** Open a download stream for a file (rejects directories). */
  async download(
    sessionId: string,
    user: SessionUser,
    path: string,
  ): Promise<{ stream: Readable; name: string; size: number }> {
    const s = this.require(sessionId, user);
    const stat = await promisify(s.sftp.stat.bind(s.sftp))(path).catch((e: Error) => {
      throw new NotFoundException(e.message);
    });
    if (stat.isDirectory()) throw new BadRequestException('That path is a directory.');
    this.touch(s);
    await this.record(s, 'fabric.sftp.download', { path, bytes: stat.size });
    return { stream: s.sftp.createReadStream(path), name: posix.basename(path), size: stat.size };
  }

  /** Stream an uploaded file into `dir/<filename>` on the remote host. */
  async upload(sessionId: string, user: SessionUser, dir: string, filename: string, source: Readable): Promise<void> {
    const s = this.require(sessionId, user);
    const name = posix.basename(filename || '').trim();
    if (!name) throw new BadRequestException('A filename is required.');
    const remote = posix.join(dir, name);
    this.touch(s);
    await pipeline(source, s.sftp.createWriteStream(remote)).catch((e: Error) => {
      throw new BadRequestException(`Upload failed: ${e.message}`);
    });
    await this.record(s, 'fabric.sftp.upload', { path: remote });
  }

  /** Explicitly close a session (the browser closed the file panel). */
  close(sessionId: string, user: SessionUser): void {
    const s = this.sessions.get(sessionId);
    if (s && s.userId !== user.id) throw new ForbiddenException('Not your session.');
    this.dispose(sessionId);
  }

  // ── internals ─────────────────────────────────────────────────

  /** Fetch a session, enforcing ownership + liveness, and bump its idle timer. */
  private require(sessionId: string, user: SessionUser): SftpSession {
    const s = this.sessions.get(sessionId);
    if (!s || s.closed) throw new NotFoundException('File session not found or expired.');
    if (s.userId !== user.id) throw new ForbiddenException('Not your session.');
    this.touch(s);
    return s;
  }

  private touch(s: SftpSession): void {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      for (const [id, sess] of this.sessions) if (sess === s) this.dispose(id);
    }, IDLE_TTL_MS);
    s.timer.unref?.();
  }

  private dispose(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.closed) return;
    s.closed = true;
    this.sessions.delete(sessionId);
    clearTimeout(s.timer);
    try { s.conn.end(); } catch { /* noop */ }
    try { s.stream.close(); } catch { /* noop */ }
    void this.audit
      .record({ actorId: s.userId, actorEmail: s.userEmail, action: 'fabric.sftp.close', target: s.agentId, meta: { targetId: s.targetId } })
      .catch(() => undefined);
  }

  private async record(s: SftpSession, action: string, meta: Record<string, unknown>): Promise<void> {
    await this.audit
      .record({ actorId: s.userId, actorEmail: s.userEmail, action, target: s.agentId, meta: { targetId: s.targetId, ...meta } })
      .catch(() => undefined);
  }
}

// POSIX file-type bits (readdir returns Attributes — mode bits only, no Stats helpers).
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

/** Map an ssh2 dir entry to the wire shape, deriving the kind from its mode bits. */
function mapEntry(e: FileEntry): FabricSftpEntry {
  const a = e.attrs;
  const fmt = (a.mode ?? 0) & S_IFMT;
  const type: FabricSftpEntry['type'] =
    fmt === S_IFDIR ? 'dir' : fmt === S_IFLNK ? 'link' : fmt === S_IFREG ? 'file' : 'other';
  return { name: e.filename, type, size: a.size ?? 0, mtime: (a.mtime ?? 0) * 1000, mode: a.mode ?? 0 };
}

/** Directories first, then case-insensitive name order. */
function byDirThenName(a: FabricSftpEntry, b: FabricSftpEntry): number {
  const ad = a.type === 'dir' ? 0 : 1;
  const bd = b.type === 'dir' ? 0 : 1;
  if (ad !== bd) return ad - bd;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function friendly(err: Error & { level?: string }): Error {
  if (err.level === 'client-authentication') return new Error('Authentication failed — check the username and password/key.');
  if (err.level === 'client-timeout') return new Error('Connection timed out.');
  return err;
}
