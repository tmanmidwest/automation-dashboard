import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService, type ActorCtx } from '../secrets/secrets.service';
import { LoggingService } from '../logging/logging.service';
import type { BackupTargetKind, SaveBackupTargetInput, StackBackupTarget } from '@cerebro/shared';
import { initRepo, probeRepo, type ResticRepoAuth } from './restic-cli';

/**
 * Backup targets: a named restic repository plus the vault keys holding its
 * credentials. Credentials arrive as plaintext on the way in, go straight into the
 * vault, and are never read back out to a client — the DTO carries only metadata.
 *
 * Two credentials per target are supported: the full one Cerebro uses (and which
 * Phase 4's prune needs), and an optional append-only one handed to Docker hosts,
 * so a compromised host can add snapshots but never delete backup history. See
 * docs/stack-backup.md.
 */
@Injectable()
export class BackupTargetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly logging: LoggingService,
  ) {}

  private passwordKeyFor(id: string) { return `stack-backup:${id}:password`; }
  private credKeyFor(id: string) { return `stack-backup:${id}:provider`; }
  private hostCredKeyFor(id: string) { return `stack-backup:${id}:provider-host`; }

  async list(): Promise<StackBackupTarget[]> {
    const rows = await this.prisma.stackBackupTarget.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { policies: true } } },
    });
    return rows.map((r) => this.toDto(r, r._count.policies));
  }

  async get(id: string): Promise<StackBackupTarget> {
    const row = await this.prisma.stackBackupTarget.findUnique({
      where: { id },
      include: { _count: { select: { policies: true } } },
    });
    if (!row) throw new NotFoundException('Backup target not found.');
    return this.toDto(row, row._count.policies);
  }

  async create(input: SaveBackupTargetInput, actor?: ActorCtx): Promise<StackBackupTarget> {
    this.validate(input);
    if (!input.password) throw new BadRequestException('A restic repository password is required.');
    if (!input.accessKeyId || !input.secretAccessKey) {
      throw new BadRequestException('Storage credentials are required.');
    }

    const row = await this.prisma.stackBackupTarget.create({
      data: {
        name: input.name.trim(),
        kind: input.kind,
        repository: input.repository.trim(),
        // Filled in below — the vault keys are derived from the row id.
        passwordKey: '',
        credKey: '',
        helperImage: input.helperImage?.trim() || 'restic/restic:latest',
        ...this.retention(input),
      },
    });

    await this.writeCredentials(row.id, input, actor);
    const updated = await this.prisma.stackBackupTarget.update({
      where: { id: row.id },
      data: {
        passwordKey: this.passwordKeyFor(row.id),
        credKey: this.credKeyFor(row.id),
        hostCredKey: input.hostAccessKeyId && input.hostSecretAccessKey ? this.hostCredKeyFor(row.id) : null,
      },
      include: { _count: { select: { policies: true } } },
    });
    void this.logging.info('stack-backup', `Backup target "${updated.name}" created (${updated.repository}).`);
    return this.toDto(updated, updated._count.policies);
  }

  async update(id: string, input: SaveBackupTargetInput, actor?: ActorCtx): Promise<StackBackupTarget> {
    this.validate(input);
    const existing = await this.prisma.stackBackupTarget.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Backup target not found.');

    await this.writeCredentials(id, input, actor);
    const row = await this.prisma.stackBackupTarget.update({
      where: { id },
      data: {
        name: input.name.trim(),
        kind: input.kind,
        repository: input.repository.trim(),
        helperImage: input.helperImage?.trim() || existing.helperImage,
        passwordKey: this.passwordKeyFor(id),
        credKey: this.credKeyFor(id),
        hostCredKey:
          input.hostAccessKeyId && input.hostSecretAccessKey
            ? this.hostCredKeyFor(id)
            : existing.hostCredKey,
        ...this.retention(input),
      },
      include: { _count: { select: { policies: true } } },
    });
    return this.toDto(row, row._count.policies);
  }

  async remove(id: string, actor?: ActorCtx): Promise<void> {
    const count = await this.prisma.stackBackupPolicy.count({ where: { targetId: id } });
    if (count) {
      throw new BadRequestException(`${count} stack backup${count === 1 ? '' : 's'} still write to this target — remove them first.`);
    }
    await this.prisma.stackBackupTarget.delete({ where: { id } }).catch(() => {
      throw new NotFoundException('Backup target not found.');
    });
    // The repository itself is untouched: deleting a target in Cerebro must never
    // destroy backups. Only the stored credentials go.
    for (const key of [this.passwordKeyFor(id), this.credKeyFor(id), this.hostCredKeyFor(id)]) {
      await this.secrets.remove(key, actor).catch(() => { /* may not exist */ });
    }
    void this.logging.info('stack-backup', `Backup target ${id} removed (its repository was left intact).`);
  }

  /**
   * Open the repository with the stored credentials. `initialize` creates it when
   * it does not exist yet — the one-time step before a first backup.
   */
  async check(id: string, initialize = false): Promise<{ ok: boolean; message: string; exists: boolean }> {
    const auth = await this.authFor(id);
    let result: { ok: boolean; message: string; exists: boolean };
    try {
      const probe = await probeRepo(auth);
      if (!probe.exists && initialize) {
        await initRepo(auth);
        result = { ok: true, message: 'Repository initialized.', exists: true };
      } else {
        result = { ok: probe.exists, message: probe.message, exists: probe.exists };
      }
    } catch (err) {
      result = { ok: false, message: err instanceof Error ? err.message : String(err), exists: false };
    }
    await this.prisma.stackBackupTarget.update({
      where: { id },
      data: {
        lastStatus: result.ok ? 'ok' : 'error',
        lastMessage: result.message,
        lastCheckedAt: new Date(),
      },
    }).catch(() => { /* the probe result is the point, not the bookkeeping */ });
    return result;
  }

  /** The full credential — Cerebro's own restic calls (probe, init, Phase 4 prune). */
  async authFor(id: string): Promise<ResticRepoAuth> {
    return this.buildAuth(id, false);
  }

  /** The credential handed to a Docker host: the append-only one when configured. */
  async hostAuthFor(id: string): Promise<ResticRepoAuth> {
    return this.buildAuth(id, true);
  }

  private async buildAuth(id: string, preferHostCred: boolean): Promise<ResticRepoAuth> {
    const row = await this.prisma.stackBackupTarget.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Backup target not found.');

    const password = await this.secrets.reveal(row.passwordKey);
    if (!password) throw new BadRequestException(`The repository password for "${row.name}" is missing from the vault.`);

    const credKey = preferHostCred && row.hostCredKey ? row.hostCredKey : row.credKey;
    const raw = await this.secrets.reveal(credKey);
    if (!raw) throw new BadRequestException(`The storage credentials for "${row.name}" are missing from the vault.`);

    let parsed: { accessKeyId?: string; secretAccessKey?: string };
    try {
      parsed = JSON.parse(raw) as { accessKeyId?: string; secretAccessKey?: string };
    } catch {
      throw new BadRequestException(`The stored credentials for "${row.name}" are not readable — re-enter them.`);
    }
    if (!parsed.accessKeyId || !parsed.secretAccessKey) {
      throw new BadRequestException(`The stored credentials for "${row.name}" are incomplete — re-enter them.`);
    }
    return {
      kind: row.kind as BackupTargetKind,
      repository: row.repository,
      password,
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey,
    };
  }

  private async writeCredentials(id: string, input: SaveBackupTargetInput, actor?: ActorCtx): Promise<void> {
    const label = input.name.trim();
    if (input.password) {
      await this.secrets.set(this.passwordKeyFor(id), input.password, {
        label: `Backup repo password — ${label}`,
        description: 'restic repository password for a stack backup target.',
        category: 'manual',
      }, actor);
    }
    if (input.accessKeyId && input.secretAccessKey) {
      await this.secrets.set(
        this.credKeyFor(id),
        JSON.stringify({ accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey }),
        {
          label: `Backup storage credential — ${label}`,
          description: 'Full storage credential; Cerebro uses it for repository checks and pruning.',
          category: 'manual',
        },
        actor,
      );
    }
    if (input.hostAccessKeyId && input.hostSecretAccessKey) {
      await this.secrets.set(
        this.hostCredKeyFor(id),
        JSON.stringify({ accessKeyId: input.hostAccessKeyId, secretAccessKey: input.hostSecretAccessKey }),
        {
          label: `Backup storage credential (hosts) — ${label}`,
          description: 'Append-only storage credential pushed to Docker hosts, so a compromised host cannot delete snapshots.',
          category: 'manual',
        },
        actor,
      );
    }
  }

  private validate(input: SaveBackupTargetInput): void {
    if (!input.name?.trim()) throw new BadRequestException('A name is required.');
    if (!input.repository?.trim()) throw new BadRequestException('A restic repository string is required.');
    if (input.kind !== 'b2' && input.kind !== 's3') throw new BadRequestException('Unsupported target kind.');
    const repo = input.repository.trim();
    const expected = input.kind === 'b2' ? 'b2:' : 's3:';
    if (!repo.startsWith(expected)) {
      throw new BadRequestException(`A ${input.kind.toUpperCase()} repository string starts with "${expected}" (e.g. ${input.kind === 'b2' ? 'b2:my-bucket:/stacks' : 's3:https://nas:9000/stacks'}).`);
    }
  }

  private retention(input: SaveBackupTargetInput) {
    const n = (v: number | null | undefined) => (typeof v === 'number' && v > 0 ? Math.floor(v) : null);
    return {
      keepLast: n(input.keepLast),
      keepDaily: n(input.keepDaily),
      keepWeekly: n(input.keepWeekly),
      keepMonthly: n(input.keepMonthly),
      keepWithinDays: n(input.keepWithinDays),
    };
  }

  private toDto(
    row: {
      id: string; name: string; kind: string; repository: string; helperImage: string; hostCredKey: string | null;
      keepLast: number | null; keepDaily: number | null; keepWeekly: number | null; keepMonthly: number | null;
      keepWithinDays: number | null; lastStatus: string; lastMessage: string | null; lastCheckedAt: Date | null;
      createdAt: Date;
    },
    policyCount: number,
  ): StackBackupTarget {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind as BackupTargetKind,
      repository: row.repository,
      helperImage: row.helperImage,
      hasHostCred: !!row.hostCredKey,
      keepLast: row.keepLast,
      keepDaily: row.keepDaily,
      keepWeekly: row.keepWeekly,
      keepMonthly: row.keepMonthly,
      keepWithinDays: row.keepWithinDays,
      lastStatus: row.lastStatus,
      lastMessage: row.lastMessage,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      policyCount,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
