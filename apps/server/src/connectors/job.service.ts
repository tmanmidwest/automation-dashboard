import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { OperationResult, OperationProgress } from '@cerebro/shared';
import { LoggingService } from '../logging/logging.service';

interface JobRecord {
  id: string;
  instanceId: string;
  label: string;
  status: 'running' | 'success' | 'error';
  steps: string[];
  message?: string;
  createdResourceId?: string;
  startedAt: number;
  finishedAt?: number;
}

/**
 * Runs connector operations in the background and tracks their progress so the
 * UI can poll for status. In-memory (single-instance app); jobs are pruned
 * after a while. If the process restarts mid-job the underlying work (e.g. a
 * Proxmox clone) still completes — only the progress record is lost.
 */
@Injectable()
export class JobService {
  private readonly jobs = new Map<string, JobRecord>();
  /** Abort controllers for in-flight jobs, so a user can cancel a long operation. */
  private readonly aborts = new Map<string, AbortController>();

  constructor(private readonly logging: LoggingService) {}

  start(
    instanceId: string,
    label: string,
    runner: (onProgress: OperationProgress, signal: AbortSignal) => Promise<OperationResult>,
  ): string {
    const id = randomUUID();
    const record: JobRecord = { id, instanceId, label, status: 'running', steps: [], startedAt: Date.now() };
    this.jobs.set(id, record);
    const abort = new AbortController();
    this.aborts.set(id, abort);

    const onProgress: OperationProgress = (step) => {
      record.steps.push(step);
      void this.logging.info('connector:job', `[${label}] ${step}`);
    };

    // Fire and forget — the endpoint returns the job id immediately.
    runner(onProgress, abort.signal)
      .then((result) => {
        // A cancel may have already settled the record; don't overwrite it.
        if (record.status !== 'running') return;
        record.status = result.ok ? 'success' : 'error';
        record.message = result.message;
        record.createdResourceId = result.createdResourceId;
        record.finishedAt = Date.now();
      })
      .catch((err) => {
        if (record.status !== 'running') return;
        record.status = 'error';
        record.message = err instanceof Error ? err.message : 'Operation failed.';
        record.finishedAt = Date.now();
      })
      .finally(() => { this.aborts.delete(id); this.prune(); });

    return id;
  }

  /** Cancel a running job: abort its work and mark it stopped. Returns false if not running. */
  cancel(id: string): boolean {
    const record = this.jobs.get(id);
    if (!record || record.status !== 'running') return false;
    this.aborts.get(id)?.abort();
    record.status = 'error';
    record.message = 'Cancelled.';
    record.finishedAt = Date.now();
    void this.logging.warn('connector:job', `[${record.label}] cancelled by user.`);
    return true;
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  /** Currently-running jobs for one connector instance (for the page's running-operation banner). */
  listRunning(instanceId: string): JobRecord[] {
    return [...this.jobs.values()].filter((j) => j.instanceId === instanceId && j.status === 'running');
  }

  /** Drop finished jobs older than 30 minutes. */
  private prune() {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && job.finishedAt < cutoff) this.jobs.delete(id);
    }
  }
}
