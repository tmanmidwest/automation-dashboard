import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Append-only audit trail: who did what. Distinct from diagnostic app logs.
 * Never updated or deleted from application code.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: {
    actorId?: string | null;
    actorEmail?: string | null;
    action: string;
    target?: string | null;
    meta?: Record<string, unknown>;
  }) {
    await this.prisma.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        actorEmail: entry.actorEmail ?? null,
        action: entry.action,
        target: entry.target ?? null,
        meta: (entry.meta as object) ?? undefined,
      },
    });
  }

  async query(opts: { limit?: number; before?: Date; actorId?: string }) {
    const limit = Math.min(opts.limit ?? 100, 500);
    return this.prisma.auditLog.findMany({
      where: {
        actorId: opts.actorId,
        createdAt: opts.before ? { lt: opts.before } : undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
