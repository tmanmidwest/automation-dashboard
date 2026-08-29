import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';

/**
 * Central store for all UI-driven configuration.
 * - Plain values → Setting table (JSON).
 * - Secret values → Secret table (encrypted at rest via CryptoService).
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async get<T = unknown>(key: string, fallback?: T): Promise<T | undefined> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row ? (row.value as T) : fallback;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.prisma.setting.upsert({
      where: { key },
      update: { value: value as object },
      create: { key, value: value as object },
    });
  }

  async getMany(prefix: string): Promise<Record<string, unknown>> {
    const rows = await this.prisma.setting.findMany({
      where: { key: { startsWith: prefix } },
    });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  // ── Secret vault ──────────────────────────────────────────────

  async setSecret(key: string, plaintext: string): Promise<void> {
    const ciphertext = this.crypto.encrypt(plaintext);
    await this.prisma.secret.upsert({
      where: { key },
      update: { ciphertext },
      create: { key, ciphertext },
    });
  }

  async getSecret(key: string): Promise<string | null> {
    const row = await this.prisma.secret.findUnique({ where: { key } });
    if (!row) return null;
    return this.crypto.decrypt(row.ciphertext);
  }

  async hasSecret(key: string): Promise<boolean> {
    const row = await this.prisma.secret.findUnique({ where: { key } });
    return !!row;
  }

  async deleteSecret(key: string): Promise<void> {
    await this.prisma.secret.deleteMany({ where: { key } });
  }
}
