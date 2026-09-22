import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../secrets/secrets.service';

/**
 * Central store for all UI-driven configuration.
 * - Plain values → Setting table (JSON).
 * - Secret values → the vault (SecretsService), encrypted at rest. These methods
 *   are thin delegates so every write also gains vault metadata and every read
 *   stamps last-used — see docs/secrets-vault.md.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
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

  // ── Secret vault (delegated to SecretsService) ────────────────

  setSecret(key: string, plaintext: string): Promise<void> {
    return this.secrets.set(key, plaintext);
  }

  getSecret(key: string): Promise<string | null> {
    return this.secrets.reveal(key);
  }

  hasSecret(key: string): Promise<boolean> {
    return this.secrets.has(key);
  }

  deleteSecret(key: string): Promise<void> {
    return this.secrets.remove(key);
  }

  /**
   * The set of user-managed ("manual") vault secret keys — the only ones a
   * connector field may {$secretRef}. Internal keys (other connectors, OAuth/SSO,
   * Fabric, mail) are deliberately excluded so a reference can't be used to
   * exfiltrate a system secret through a connector's config. See fabric/secrets audit.
   */
  async manualSecretKeys(): Promise<Set<string>> {
    const all = await this.secrets.list();
    return new Set(all.filter((s) => s.category === 'manual').map((s) => s.key));
  }
}
