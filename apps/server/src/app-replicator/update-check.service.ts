import { Injectable, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../logging/audit.service';
import { LoggingService } from '../logging/logging.service';
import { RepoIntrospectService } from './repo-introspect.service';
import type { ReplicatorApp as AppRow, ReplicatorDeployment as DeploymentRow } from '@prisma/client';

type DeploymentWithApp = DeploymentRow & { app: AppRow };

/**
 * App Replicator Phase 3 — the update-check sweep. Periodically resolves each
 * app's remote tip commit (`git ls-remote`, deduped per repo+ref, no clone) and
 * flags a deployment `updateAvailable` when its repo has moved ahead of the
 * deployed commit. On the transition into "available" it records an audit event
 * (`replicator.update_available`) that lands on the timeline bus, so an
 * Automations rule can opt into auto-redeploy. Nothing auto-redeploys by default.
 * See docs/app-replicator.md.
 */
@Injectable()
export class UpdateCheckService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: RepoIntrospectService,
    private readonly audit: AuditService,
    private readonly logging: LoggingService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweep(): Promise<void> {
    try {
      const n = await this.checkAll();
      if (n) void this.logging.info('replicator', `Update check: ${n} deployment(s) changed state.`);
    } catch (err) {
      void this.logging.warn('replicator', `Update check failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Recompute update-available for every deployed deployment. Returns how many changed. */
  async checkAll(): Promise<number> {
    const deps = await this.prisma.replicatorDeployment.findMany({
      where: { deployedCommit: { not: null } },
      include: { app: true },
    });
    const tipCache = new Map<string, string | null>();
    let changed = 0;
    for (const d of deps) if (await this.evaluate(d, tipCache)) changed++;
    return changed;
  }

  /** Recompute a single deployment; returns its (possibly updated) flags. */
  async checkOne(id: string): Promise<{ updateAvailable: boolean; availableCommit: string | null }> {
    const d = await this.prisma.replicatorDeployment.findUnique({ where: { id }, include: { app: true } });
    if (!d) throw new NotFoundException('Deployment not found.');
    await this.evaluate(d, new Map());
    const fresh = await this.prisma.replicatorDeployment.findUnique({ where: { id }, select: { updateAvailable: true, availableCommit: true } });
    return { updateAvailable: !!fresh?.updateAvailable, availableCommit: fresh?.availableCommit ?? null };
  }

  /** Core: resolve remote tip, diff against the deployed commit, persist + emit on transition. */
  private async evaluate(d: DeploymentWithApp, tipCache: Map<string, string | null>): Promise<boolean> {
    if (!d.deployedCommit) return false;
    const key = `${d.app.gitUrl}#${d.app.gitRef}`;
    let tip = tipCache.get(key);
    if (tip === undefined) {
      tip = await this.repo.remoteCommit({ gitUrl: d.app.gitUrl, gitRef: d.app.gitRef, gitCredKey: d.app.gitCredKey }).catch(() => null);
      tipCache.set(key, tip);
    }
    // Unreachable/unknown tip → leave the current flag as-is (don't clear a real signal on a blip).
    if (!tip) return false;

    const available = tip !== d.deployedCommit;
    const flagChanged = available !== d.updateAvailable;
    const commitChanged = available && tip !== d.availableCommit;
    if (!flagChanged && !commitChanged) return false;

    await this.prisma.replicatorDeployment.update({
      where: { id: d.id },
      data: { updateAvailable: available, availableCommit: available ? tip : null },
    });

    // Emit only on the rising edge (not-available → available), so a rule fires once.
    if (available && !d.updateAvailable) {
      await this.audit.record({
        action: 'replicator.update_available',
        target: `${d.app.name}/${d.project}`,
        meta: {
          deploymentId: d.id, appId: d.appId, dockerInstanceId: d.dockerInstanceId, project: d.project,
          from: d.deployedCommit.slice(0, 7), to: tip.slice(0, 7),
        },
      });
    }
    return true;
  }
}
