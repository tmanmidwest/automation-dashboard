import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** A run row as the connector's "Sync history" tab consumes it. */
export interface BackupRunView {
  id: string;
  trigger: string;
  status: string;
  message: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

/**
 * Durable record of scheduled-sync executions. Unlike the in-memory JobService,
 * these survive restarts so the "Sync history" tab and the scheduler's
 * de-duplication both have a persistent source of truth.
 */
@Injectable()
export class BackupRunService {
  constructor(private readonly prisma: PrismaService) {}

  /** Open a run row in the 'running' state; returns its id. */
  async begin(connectorInstanceId: string, trigger: 'schedule' | 'manual' | 'restore'): Promise<string> {
    const run = await this.prisma.backupRun.create({
      data: { connectorInstanceId, trigger, status: 'running' },
    });
    return run.id;
  }

  /** Close a run row with its outcome. */
  async finish(id: string, status: 'success' | 'error', message: string): Promise<void> {
    await this.prisma.backupRun.update({
      where: { id },
      data: { status, message, finishedAt: new Date() },
    });
  }

  /** Most recent runs for an instance, newest first. */
  async list(connectorInstanceId: string, limit = 50): Promise<BackupRunView[]> {
    return this.prisma.backupRun.findMany({
      where: { connectorInstanceId },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
  }

  async get(id: string): Promise<BackupRunView | null> {
    return this.prisma.backupRun.findUnique({ where: { id } });
  }

  /** The most recent BACKUP run (schedule or manual — not a restore) for an instance. */
  async latestBackup(connectorInstanceId: string): Promise<BackupRunView | null> {
    return this.prisma.backupRun.findFirst({
      where: { connectorInstanceId, trigger: { in: ['schedule', 'manual'] } },
      orderBy: { startedAt: 'desc' },
    });
  }

  /** True if a run for this instance started at or after `since` (restart-safe schedule de-dup). */
  async hasRunSince(connectorInstanceId: string, since: Date): Promise<boolean> {
    const n = await this.prisma.backupRun.count({
      where: { connectorInstanceId, startedAt: { gte: since } },
    });
    return n > 0;
  }
}
