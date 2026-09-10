import { BadRequestException, Injectable } from '@nestjs/common';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { join, relative, dirname } from 'path';
import { promisify } from 'util';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { LoggingService } from '../logging/logging.service';
import { sealBundle, openBundle } from './bundle';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 512 * 1024 * 1024; // pg_dump stdout can be large.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../package.json') as { version: string };

interface BackupManifest {
  format: 1;
  appVersion: string;
  /** Latest applied Prisma migration (its NNNN prefix drives restore compatibility). */
  migration: string | null;
  createdAt: string;
  /** Source APP_ENCRYPTION_KEY, so a restore onto a machine with a different key can re-key. */
  encryptionKey: string;
}

interface Bundle {
  manifest: BackupManifest;
  /** Full `pg_dump` SQL (plain format, --clean --if-exists). */
  database: string;
  /** signal-cli data dir: relative path → base64 contents. */
  signal: Record<string, string>;
}

/**
 * Full system backup & restore. Bundles a pg_dump + the signal-cli data dir + a manifest,
 * passphrase-encrypts it, and on restore reloads the DB and re-keys the vault to this
 * machine's own APP_ENCRYPTION_KEY. Admin + session-only. See docs/system-backup.md.
 */
@Injectable()
export class SystemBackupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly logging: LoggingService,
  ) {}

  private dbUrl(): string {
    const raw = process.env.DATABASE_URL;
    if (!raw) throw new BadRequestException('DATABASE_URL is not set.');
    // Strip Prisma-only query params libpq/pg_dump don't understand (e.g. ?schema=public
    // → "invalid URI query parameter"). Keep libpq-valid ones like sslmode.
    try {
      const u = new URL(raw);
      for (const k of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'socket_timeout', 'sslaccept', 'connect_timeout']) {
        u.searchParams.delete(k);
      }
      return u.toString();
    } catch {
      return raw;
    }
  }

  private signalDir(): string {
    return process.env.SIGNAL_CLI_DATA_DIR || '/data/signal';
  }

  /** Latest applied migration name, e.g. "0015_telemetry_snapshots". */
  private async currentMigration(): Promise<string | null> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ migration_name: string }[]>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1',
      );
      return rows[0]?.migration_name ?? null;
    } catch {
      return null;
    }
  }

  private async pgToolsAvailable(): Promise<boolean> {
    try { await execFileAsync('pg_dump', ['--version']); return true; } catch { return false; }
  }

  async info(): Promise<{ version: string; migration: string | null; pgTools: boolean; signalDir: string }> {
    return {
      version: pkg.version,
      migration: await this.currentMigration(),
      pgTools: await this.pgToolsAvailable(),
      signalDir: this.signalDir(),
    };
  }

  async createBackup(passphrase: string): Promise<{ filename: string; data: Buffer }> {
    if (!passphrase || passphrase.length < 8) throw new BadRequestException('A passphrase of at least 8 characters is required.');
    if (!(await this.pgToolsAvailable())) throw new BadRequestException('pg_dump is not available in this image — rebuild with postgresql-client.');

    const { stdout } = await execFileAsync(
      'pg_dump',
      [this.dbUrl(), '--clean', '--if-exists', '--no-owner', '--no-privileges'],
      { maxBuffer: MAX_BUFFER },
    );

    const bundle: Bundle = {
      manifest: {
        format: 1,
        appVersion: pkg.version,
        migration: await this.currentMigration(),
        createdAt: new Date().toISOString(),
        encryptionKey: this.crypto.rawKey,
      },
      database: stdout,
      signal: await this.readSignal(),
    };

    const data = sealBundle(bundle, passphrase);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    void this.logging.info('system-backup', `Backup created (${(data.length / 1024).toFixed(0)} KB).`);
    return { filename: `cerebro-backup-${stamp}.cbak`, data };
  }

  async restore(file: Buffer, passphrase: string): Promise<{ ok: boolean; message: string }> {
    if (!passphrase) throw new BadRequestException('The passphrase is required.');
    if (!(await this.pgToolsAvailable())) throw new BadRequestException('psql is not available in this image — rebuild with postgresql-client.');

    let bundle: Bundle;
    try {
      bundle = openBundle<Bundle>(file, passphrase);
    } catch (err) {
      // Wrong passphrase / bad magic / corrupt file → a clean 400, not a 500.
      throw new BadRequestException(err instanceof Error ? err.message : 'Could not open the backup file.');
    }
    if (bundle?.manifest?.format !== 1 || typeof bundle.database !== 'string') {
      throw new BadRequestException('This file is not a valid Cerebro backup.');
    }

    // Compatibility: refuse a backup from a newer schema than this server's code.
    const order = (name: string | null) => (name ? parseInt(name.slice(0, 4), 10) || 0 : 0);
    const backupOrder = order(bundle.manifest.migration);
    const currentOrder = order(await this.currentMigration());
    if (backupOrder > currentOrder) {
      throw new BadRequestException(
        `This backup is from a newer version (schema ${bundle.manifest.migration}) than this server (${currentOrder || 'unknown'}). Deploy the matching Cerebro version first, then restore.`,
      );
    }

    // Load the dump in a single transaction (it drops & recreates via --clean --if-exists).
    const tmp = join('/tmp', `cerebro-restore-${Date.now()}.sql`);
    await fs.writeFile(tmp, bundle.database, 'utf8');
    try {
      await execFileAsync('psql', [this.dbUrl(), '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', tmp], { maxBuffer: MAX_BUFFER });
    } catch (err) {
      const msg = err instanceof Error ? (err as Error & { stderr?: string }).stderr || err.message : String(err);
      void this.logging.error('system-backup', `Restore failed loading the database: ${msg}`);
      throw new BadRequestException(`Restore failed while loading the database: ${msg.slice(0, 400)}`);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }

    // Re-key the vault + TOTP to THIS machine's key if the backup used a different one.
    let rekeyed = 0;
    const sourceKey = bundle.manifest.encryptionKey;
    if (sourceKey && sourceKey !== this.crypto.rawKey) rekeyed = await this.rekey(sourceKey);

    await this.writeSignal(bundle.signal ?? {});

    void this.logging.warn('system-backup', `System restored from backup (${bundle.manifest.createdAt}); re-keyed ${rekeyed} secret(s).`);
    return {
      ok: true,
      message: `Restore complete${rekeyed ? ` (re-keyed ${rekeyed} secret${rekeyed === 1 ? '' : 's'} to this machine's key)` : ''}. Restart the Cerebro container to finish, then sign in again.`,
    };
  }

  /** Decrypt every encrypted field with the backup's key and re-encrypt with the current key. */
  private async rekey(sourceKey: string): Promise<number> {
    let n = 0;
    const secrets = await this.prisma.secret.findMany();
    for (const s of secrets) {
      try {
        const plain = this.crypto.decryptWithKey(s.ciphertext, sourceKey);
        await this.prisma.secret.update({ where: { key: s.key }, data: { ciphertext: this.crypto.encrypt(plain) } });
        n++;
      } catch (err) {
        void this.logging.error('system-backup', `Re-key failed for secret "${s.key}": ${err instanceof Error ? err.message : err}`);
      }
    }
    const users = await this.prisma.user.findMany({ where: { totpSecret: { not: null } }, select: { id: true, totpSecret: true } });
    for (const u of users) {
      try {
        const plain = this.crypto.decryptWithKey(u.totpSecret as string, sourceKey);
        await this.prisma.user.update({ where: { id: u.id }, data: { totpSecret: this.crypto.encrypt(plain) } });
        n++;
      } catch (err) {
        void this.logging.error('system-backup', `Re-key failed for user ${u.id} TOTP: ${err instanceof Error ? err.message : err}`);
      }
    }
    return n;
  }

  // ── signal-cli data dir ↔ base64 map ──────────────────────────────
  private async readSignal(): Promise<Record<string, string>> {
    const dir = this.signalDir();
    const out: Record<string, string> = {};
    const walk = async (d: string): Promise<void> => {
      let entries: import('fs').Dirent[];
      try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) {
          try { out[relative(dir, full)] = (await fs.readFile(full)).toString('base64'); } catch { /* skip unreadable */ }
        }
      }
    };
    await walk(dir);
    return out;
  }

  private async writeSignal(files: Record<string, string>): Promise<void> {
    const dir = this.signalDir();
    for (const [rel, b64] of Object.entries(files)) {
      // Guard against path traversal in the archive.
      if (rel.includes('..')) continue;
      const dest = join(dir, rel);
      try {
        await fs.mkdir(dirname(dest), { recursive: true });
        await fs.writeFile(dest, Buffer.from(b64, 'base64'));
      } catch (err) {
        void this.logging.error('system-backup', `Restore of signal file ${rel} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
