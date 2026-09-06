import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { AuditService } from '../logging/audit.service';
import { LoggingService } from '../logging/logging.service';
import type { SecretCategory, SecretHealth, SecretMetaInput, SecretSummary } from '@cerebro/shared';

/** Who is performing an administrative secret write, for the audit trail. */
export interface ActorCtx {
  actorId?: string | null;
  actorEmail?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Only re-stamp lastUsedAt if the stored value is older than this (throttle polls). */
const TOUCH_THROTTLE_MS = 5 * 60 * 1000;
/** A secret with an expiry is "due" once it is within this window of expiring. */
const EXPIRY_WARN_DAYS = 14;

/**
 * The vault's single choke point over the Secret + SecretMeta pair. All secret
 * reads and writes funnel through here so that (a) every stored value gains
 * management metadata and (b) reads stamp lastUsedAt. See docs/secrets-vault.md.
 *
 * There is deliberately no method that returns a value to an interactive client
 * — reveal() exists only for server-side consumers (connectors, mail, SSO, …),
 * so reads are NOT audited (that would flood the log on every telemetry poll);
 * only administrative writes are.
 */
@Injectable()
export class SecretsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly logging: LoggingService,
  ) {}

  async onModuleInit() {
    // Backfill metadata for any secret that predates the vault.
    await this.backfillMeta().catch((err) =>
      this.logging.warn('secrets', `Metadata backfill failed: ${err instanceof Error ? err.message : err}`),
    );
  }

  // ── Read path ───────────────────────────────────────────────────

  /** Decrypt a secret. The ONLY read path. Stamps lastUsedAt (throttled). */
  async reveal(key: string): Promise<string | null> {
    const row = await this.prisma.secret.findUnique({ where: { key } });
    if (!row) return null;
    const value = this.crypto.decrypt(row.ciphertext);
    void this.touch(key);
    return value;
  }

  async has(key: string): Promise<boolean> {
    const row = await this.prisma.secret.findUnique({ where: { key }, select: { key: true } });
    return !!row;
  }

  /** Throttled lastUsedAt stamp — a single write that no-ops when recently touched. */
  private async touch(key: string): Promise<void> {
    const cutoff = new Date(Date.now() - TOUCH_THROTTLE_MS);
    try {
      await this.prisma.secretMeta.updateMany({
        where: { key, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: cutoff } }] },
        data: { lastUsedAt: new Date() },
      });
    } catch {
      /* last-used tracking is best-effort — never break a credential read */
    }
  }

  // ── Write path ──────────────────────────────────────────────────

  /**
   * Store/replace a secret value and ensure its metadata exists. Bumps
   * rotatedAt (the value changed). Inferred metadata is applied only on first
   * create, so an admin's customized label/policy survives later value writes.
   */
  async set(key: string, plaintext: string, meta?: SecretMetaInput, ctx?: ActorCtx): Promise<void> {
    const ciphertext = this.crypto.encrypt(plaintext);
    const existing = await this.prisma.secretMeta.findUnique({ where: { key } });
    const patch = cleanMeta(meta);

    await this.prisma.$transaction([
      this.prisma.secret.upsert({ where: { key }, update: { ciphertext }, create: { key, ciphertext } }),
      existing
        ? this.prisma.secretMeta.update({ where: { key }, data: { rotatedAt: new Date(), ...patch } })
        : this.prisma.secretMeta.create({ data: { key, ...inferMeta(key), ...patch, rotatedAt: new Date() } }),
    ]);

    if (ctx?.actorId || ctx?.actorEmail) {
      await this.audit.record({
        actorId: ctx.actorId,
        actorEmail: ctx.actorEmail,
        action: existing ? 'secret.rotated' : 'secret.created',
        target: key,
        meta: { category: (patch.category ?? existing?.category ?? inferMeta(key).category) as string },
      });
    }
  }

  /** Edit metadata only — never touches the value or rotatedAt. */
  async updateMeta(key: string, meta: SecretMetaInput, ctx?: ActorCtx): Promise<void> {
    if (!(await this.has(key))) return;
    const patch = cleanMeta(meta);
    const existing = await this.prisma.secretMeta.findUnique({ where: { key } });
    if (existing) {
      await this.prisma.secretMeta.update({ where: { key }, data: patch });
    } else {
      await this.prisma.secretMeta.create({ data: { key, ...inferMeta(key), ...patch } });
    }
    if (ctx?.actorId || ctx?.actorEmail) {
      await this.audit.record({
        actorId: ctx.actorId,
        actorEmail: ctx.actorEmail,
        action: 'secret.meta_updated',
        target: key,
      });
    }
  }

  /** Delete a secret and its metadata. */
  async remove(key: string, ctx?: ActorCtx): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.secret.deleteMany({ where: { key } }),
      this.prisma.secretMeta.deleteMany({ where: { key } }),
    ]);
    if (ctx?.actorId || ctx?.actorEmail) {
      await this.audit.record({
        actorId: ctx.actorId,
        actorEmail: ctx.actorEmail,
        action: 'secret.deleted',
        target: key,
      });
    }
  }

  // ── Listing / health ────────────────────────────────────────────

  /** All vault entries as metadata-only summaries (never the value). */
  async list(): Promise<SecretSummary[]> {
    const [secrets, metas] = await Promise.all([
      this.prisma.secret.findMany({ select: { key: true, updatedAt: true } }),
      this.prisma.secretMeta.findMany(),
    ]);
    const metaByKey = new Map(metas.map((m) => [m.key, m]));
    return secrets
      .map((s) => this.toSummary(s.key, metaByKey.get(s.key), s.updatedAt))
      .sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
  }

  /** Entries whose rotation policy makes them due or expired (for the reminder cron). */
  async dueForRotation(): Promise<SecretSummary[]> {
    return (await this.list()).filter((s) => s.health !== 'ok');
  }

  private toSummary(
    key: string,
    meta: {
      label: string;
      description: string | null;
      category: string;
      owningConnectorId: string | null;
      rotateAfterDays: number | null;
      expiresAt: Date | null;
      lastUsedAt: Date | null;
      rotatedAt: Date;
      createdAt: Date;
    } | undefined,
    fallbackTs: Date,
  ): SecretSummary {
    const inferred = inferMeta(key);
    const rotatedAt = meta?.rotatedAt ?? fallbackTs;
    const expiresAt = meta?.expiresAt ?? null;
    const rotateAfterDays = meta?.rotateAfterDays ?? null;
    const ageDays = Math.floor((Date.now() - rotatedAt.getTime()) / DAY_MS);
    return {
      key,
      label: meta?.label ?? inferred.label,
      description: meta?.description ?? null,
      category: (meta?.category ?? inferred.category) as SecretCategory,
      owningConnectorId: meta?.owningConnectorId ?? inferred.owningConnectorId ?? null,
      rotateAfterDays,
      expiresAt: expiresAt?.toISOString() ?? null,
      lastUsedAt: meta?.lastUsedAt?.toISOString() ?? null,
      rotatedAt: rotatedAt.toISOString(),
      createdAt: (meta?.createdAt ?? fallbackTs).toISOString(),
      health: computeHealth(ageDays, rotateAfterDays, expiresAt),
      ageDays,
    };
  }

  /** Create metadata rows for any secret that lacks one (idempotent). */
  private async backfillMeta(): Promise<void> {
    const [secrets, metas] = await Promise.all([
      this.prisma.secret.findMany({ select: { key: true } }),
      this.prisma.secretMeta.findMany({ select: { key: true } }),
    ]);
    const have = new Set(metas.map((m) => m.key));
    const missing = secrets.filter((s) => !have.has(s.key));
    if (missing.length === 0) return;
    await this.prisma.secretMeta.createMany({
      data: missing.map((s) => ({ key: s.key, ...inferMeta(s.key) })),
      skipDuplicates: true,
    });
    await this.logging.info('secrets', `Backfilled metadata for ${missing.length} vault entries.`);
  }
}

// ── Pure helpers ──────────────────────────────────────────────────

function computeHealth(ageDays: number, rotateAfterDays: number | null, expiresAt: Date | null): SecretHealth {
  const now = Date.now();
  if (expiresAt && expiresAt.getTime() <= now) return 'expired';
  if (rotateAfterDays != null && ageDays >= rotateAfterDays) return 'due';
  if (expiresAt && expiresAt.getTime() - now <= EXPIRY_WARN_DAYS * DAY_MS) return 'due';
  return 'ok';
}

/** Strip undefined keys; coerce expiresAt string → Date so Prisma accepts it. */
function cleanMeta(meta?: SecretMetaInput): Record<string, unknown> {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  if (meta.label !== undefined) out.label = meta.label;
  if (meta.description !== undefined) out.description = meta.description;
  if (meta.category !== undefined) out.category = meta.category;
  if (meta.rotateAfterDays !== undefined) out.rotateAfterDays = meta.rotateAfterDays;
  if (meta.expiresAt !== undefined) out.expiresAt = meta.expiresAt ? new Date(meta.expiresAt) : null;
  return out;
}

/** Infer a label + category from a secret's key naming convention. */
function inferMeta(key: string): { label: string; category: SecretCategory; owningConnectorId?: string } {
  if (key.startsWith('connector:')) {
    const [, connectorId, field] = key.split(':');
    return {
      label: `Connector ${connectorId ?? ''} · ${field ?? 'secret'}`.trim(),
      category: 'connector',
      owningConnectorId: connectorId,
    };
  }
  if (key === 'smtp.password') return { label: 'SMTP password', category: 'notification' };
  if (key.startsWith('notify.')) return { label: humanize(key), category: 'notification' };
  if (key === 'oauth:jwtSecret') return { label: 'OAuth signing key', category: 'api' };
  if (key.startsWith('idp:')) {
    const id = key.split(':')[1];
    return { label: `SSO client secret · ${id ?? ''}`.trim(), category: 'api' };
  }
  return { label: humanize(key), category: 'manual' };
}

function humanize(key: string): string {
  const s = key.replace(/[.:_]/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
