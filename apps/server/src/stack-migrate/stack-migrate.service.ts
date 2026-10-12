import { BadRequestException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type {
  MigrateImagePlanItem, MigrateIngressSpec, MigratePlan, MigratePlanInput, MigrateStep, SecretMode,
  StackMigrationRun, StartMigrateInput,
} from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { AuditService } from '../logging/audit.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { DockerStackService } from '../connectors/docker/docker-stack.service';
import type { DockerApi } from '../connectors/docker/docker-api';
import { StackBackupService } from '../stack-backup/stack-backup.service';
import { StackRestoreService } from '../stack-backup/stack-restore.service';
import { BackupTargetService } from '../stack-backup/backup-target.service';
import { hostAccess, NO_SSH_REASON, type DockerHostAccess } from '../stack-backup/docker-host';
import { inspectStack } from '../stack-backup/stack-inspect';
import { PortAllocatorService } from '../app-replicator/port-allocator.service';
import { IngressOps } from '../app-replicator/ingress-ops.service';
import { IngressService } from '../app-replicator/ingress.service';
import { DeploymentService } from '../app-replicator/deployment.service';
import { dockerTargetFrom } from '../app-replicator/docker-target';
import { runSsh } from '../connectors/docker/docker-ssh';
import type { PreflightCheck, MigrateIngressSuggestion } from '@cerebro/shared';
import { ensureImagesOnTarget } from './image-transfer';

const DOCKER = 'docker';
const MAX_LOG_CHARS = 64 * 1024;
const POLL_MS = 3000;
const CAPTURE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const RESTORE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 3 * 60_000;
const RUNNING = new Set(['running', 'restarting']);

/** Who initiated a migration action, for the audit trail (from the session user). */
type MigrateActor = { id?: string; email?: string };

/** Thrown through the step pipeline when the operator cancels a running migration. */
class CancelledError extends Error {
  constructor() { super('cancelled'); this.name = 'CancelledError'; }
}

/**
 * Move a Compose stack from one Docker host to another (docs/stack-migrator.md).
 *
 * This is a conductor over machinery that already exists: it captures the source
 * with the stack-backup pipeline, moves each image to the target (pulling what it
 * can, `docker save|load`-ing what was built on the host), restores+deploys onto
 * the target with the restore pipeline, and health-checks it. The cold model —
 * quiesce the source before the final copy — keeps stateful volumes consistent;
 * cutover (flip ingress) and teardown are operator-driven in P1.
 */
@Injectable()
export class StackMigrateService implements OnModuleInit {
  private readonly active = new Set<string>();
  /** Abort controllers for in-flight migrations, keyed by run id — drives cancel(). */
  private readonly cancels = new Map<string, AbortController>();

  /**
   * A migration runs in a background promise guarded by an in-memory lock. If the
   * server restarts mid-flight, the row is stranded as `running` (eternal spinner)
   * and the lock is gone. On boot, fail those so the operator can roll back the
   * partial target; and bump a stranded `completing` back to `awaiting-cutover`.
   */
  async onModuleInit(): Promise<void> {
    await this.prisma.stackMigrationRun.updateMany({
      where: { status: 'running' },
      data: { status: 'error', step: 'failed', message: 'Interrupted by a server restart — roll back to clean up the target if it was partially created.', finishedAt: new Date() },
    }).catch(() => undefined);
    await this.prisma.stackMigrationRun.updateMany({
      where: { step: 'completing' },
      data: { step: 'awaiting-cutover', message: 'Cutover was interrupted by a server restart — retry Complete or Rollback.' },
    }).catch(() => undefined);
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: ConnectorInstanceService,
    private readonly stacks: DockerStackService,
    private readonly backups: StackBackupService,
    private readonly restores: StackRestoreService,
    private readonly targets: BackupTargetService,
    private readonly ports: PortAllocatorService,
    private readonly ingressOps: IngressOps,
    private readonly ingress: IngressService,
    private readonly deployments: DeploymentService,
    private readonly logging: LoggingService,
    private readonly audit: AuditService,
  ) {}

  // ── Planning ──────────────────────────────────────────────────────

  async plan(input: MigratePlanInput): Promise<MigratePlan> {
    const source = await this.hostOrThrow(input.sourceInstanceId);
    const dest = await this.hostOrThrow(input.destInstanceId);
    if (source.id === dest.id) throw new BadRequestException('Pick two different hosts — the source and target are the same.');
    await this.targets.get(input.repoTargetId); // validate the repo exists

    const srcAccess = await this.accessFor(source.id);
    const dstAccess = await this.accessFor(dest.id);

    const conflicts: string[] = [];
    const warnings: string[] = [];
    if (!srcAccess.ssh) conflicts.push(`Source: ${NO_SSH_REASON}`);
    if (!dstAccess.ssh) conflicts.push(`Target: ${NO_SSH_REASON}`);

    const project = projectName(input.stackName);
    const destStackName = projectName(input.destStackName || input.stackName);

    const inspection = await inspectStack(srcAccess.api, project).catch(() => null);
    if (!inspection || !inspection.containers.length) {
      conflicts.push(`No running stack named "${project}" was found on ${source.name}.`);
    }

    const volumes = (inspection?.volumes ?? []).map((v) => v.name);
    const binds = (inspection?.binds ?? []).map((b) => b.path);

    // Image classification: already on the target → pull if it came from a registry
    // (has RepoDigests) → otherwise it was built on the source host, so transfer it.
    const images: MigrateImagePlanItem[] = [];
    const refs = [...new Set((inspection?.containers ?? []).map((c) => c.image).filter((r): r is string => !!r))];
    for (const ref of refs) {
      if (await dstAccess.api.imageExists(ref)) {
        images.push({ ref, method: 'present' });
        continue;
      }
      const pullable = await this.looksPullable(srcAccess.api, ref);
      images.push({ ref, method: pullable ? 'pull' : 'transfer' });
    }
    const transferring = images.filter((i) => i.method === 'transfer').map((i) => i.ref);
    if (transferring.length) {
      warnings.push(`${transferring.length} image(s) were built on the source and will be transferred (save→load): ${transferring.join(', ')}.`);
    }

    // Resolve the capture secret mode: reuse an existing policy's, else the input's.
    const existingPolicy = await this.prisma.stackBackupPolicy.findUnique({
      where: { connectorInstanceId_stackName: { connectorInstanceId: source.id, stackName: project } },
    }).catch(() => null);
    // Default to `embed` (sealed, passphrase) so a migration never leaves plaintext
    // secrets sitting in the restic repo unless the operator explicitly chooses raw.
    const secretMode = (existingPolicy?.secretMode ?? input.secretMode ?? 'embed') as SecretMode;

    // Ports the stack publishes, flagged against what's taken on the target.
    const wanted = new Set<number>();
    for (const c of inspection?.containers ?? []) {
      for (const p of c.ports ?? []) {
        const n = Number(p.hostPort);
        if (Number.isFinite(n) && n > 0) wanted.add(n);
      }
    }
    const ports: { hostPort: number; inUse: boolean }[] = [];
    if (wanted.size && dstAccess.ssh) {
      const used = new Set(await this.ports.usedPorts(dstAccess.ssh).catch(() => []));
      for (const hostPort of [...wanted].sort((a, b) => a - b)) {
        const inUse = used.has(hostPort);
        ports.push({ hostPort, inUse });
      }
      const clashes = ports.filter((p) => p.inUse).map((p) => p.hostPort);
      if (clashes.length) warnings.push(`Host port(s) already in use on ${dest.name}: ${clashes.join(', ')}. The migrated stack will fail to start until they are free.`);
    }

    // Already something under the destination name?
    try {
      const containers = await dstAccess.api.listContainers(true);
      const running = containers.filter((c) => (c.Labels ?? {})['com.docker.compose.project'] === destStackName && RUNNING.has(c.State ?? ''));
      if (running.length) conflicts.push(`"${destStackName}" is already running on ${dest.name} — choose another target name or remove it first.`);
    } catch {
      warnings.push(`Could not check for an existing "${destStackName}" on ${dest.name}.`);
    }

    // Optional automated-cutover ingress (P2): validate each chosen CF/NPM route.
    const ingressRoutes = input.ingressRoutes ?? [];
    for (let i = 0; i < ingressRoutes.length; i++) {
      const ing = ingressRoutes[i];
      const where = ingressRoutes.length > 1 ? ` (route ${i + 1}${ing.hostname ? `, ${ing.hostname}` : ''})` : '';
      try {
        const kind = await this.ingressOps.kindOf(ing.instanceId);
        if (kind === 'cloudflare' && !ing.tunnelId) conflicts.push(`Pick a Cloudflare tunnel for the ingress route${where}.`);
      } catch {
        conflicts.push(`The chosen ingress connector is not a Cloudflare or Nginx Proxy Manager instance${where}.`);
      }
      if (!ing.hostname?.trim()) conflicts.push(`The ingress route needs a hostname${where}.`);
      if (wanted.size && !wanted.has(ing.port)) {
        warnings.push(`Ingress route${where} is set to port ${ing.port}, which this stack does not publish — double-check the port.`);
      }
    }
    // Two routes to the same hostname on the same connector would fight each other.
    const dupe = new Map<string, number>();
    for (const ing of ingressRoutes) {
      const k = `${ing.instanceId}|${(ing.hostname ?? '').trim().toLowerCase()}|${ing.path ?? ''}`;
      dupe.set(k, (dupe.get(k) ?? 0) + 1);
    }
    for (const [k, n] of dupe) {
      const [, host, path] = k.split('|');
      if (n > 1 && host) conflicts.push(`The same route "${host}${path}" is listed more than once for one connector — remove the duplicate.`);
    }

    // Is the source an App Replicator deployment? If so we can re-point it (else it orphans).
    const repl = await this.prisma.replicatorDeployment.findFirst({
      where: { dockerInstanceId: source.id, project },
    }).catch(() => null);
    const replicator = repl ? { deploymentId: repl.id, name: repl.name } : null;
    if (replicator) {
      warnings.push(`This stack is an App Replicator deployment ("${repl!.name}"). The migration will re-point it to the target so the replicator keeps managing it — otherwise the replicator would still point at the old host (and a redeploy would recreate it there).`);
    }

    // Detect existing ingress routes pointing at the source stack (all of them), to
    // pre-fill the cutover flip. Skip when it's a replicator deployment — its ingress
    // moves via the re-point path, so a manual flip would double-handle those routes.
    const ingressSuggestions = replicator ? [] : await this.detectIngress(source.id, wanted).catch(() => []);
    if (ingressSuggestions.length === 1) {
      warnings.push(`Detected an existing route for this stack: ${ingressSuggestions[0].label}. Enable "automatically flip ingress" to move it to the target on cutover (the fields pre-fill).`);
    } else if (ingressSuggestions.length > 1) {
      warnings.push(`Detected ${ingressSuggestions.length} existing routes for this stack: ${ingressSuggestions.map((s) => s.label).join('; ')}. Enable "automatically flip ingress" to move them all to the target on cutover (the fields pre-fill).`);
    }

    // Pre-flight readiness checks (surfaced as a checklist; a `fail` blocks Start).
    const { checks, estimatedDataBytes } = await this.runPreflight({
      sourceName: source.name, destName: dest.name, project, srcAccess, dstAccess,
      inspection, volumes, repoTargetId: input.repoTargetId, sourceId: source.id,
    });

    return {
      sourceInstanceId: source.id,
      sourceHostName: source.name,
      stackName: project,
      destInstanceId: dest.id,
      destHostName: dest.name,
      destStackName,
      repoTargetId: input.repoTargetId,
      usingExistingPolicy: !!existingPolicy,
      secretMode,
      volumes,
      binds,
      images,
      ports,
      needsPassphrase: secretMode === 'embed',
      ingressRoutes,
      checks,
      estimatedDataBytes,
      replicator,
      ingressSuggestions,
      conflicts,
      warnings,
    };
  }

  /**
   * On-demand lookup for the UI's "Fetch existing route" button: inspect the source
   * stack to learn its published ports, then scan ingress connectors for a matching
   * route. Lets the operator pre-fill the cutover flip without running a full plan.
   */
  async detectIngressForStack(sourceInstanceId: string, stackName: string): Promise<MigrateIngressSuggestion[]> {
    const source = await this.hostOrThrow(sourceInstanceId);
    const srcAccess = await this.accessFor(source.id);
    const project = projectName(stackName);
    const inspection = await inspectStack(srcAccess.api, project).catch(() => null);
    const wanted = new Set<number>();
    for (const c of inspection?.containers ?? []) {
      for (const p of c.ports ?? []) {
        const n = Number(p.hostPort);
        if (Number.isFinite(n) && n > 0) wanted.add(n);
      }
    }
    return this.detectIngress(source.id, wanted).catch(() => []);
  }

  /**
   * Scan the configured Cloudflare/NPM connectors for an existing route whose upstream
   * matches the source host's IP + one of the stack's published ports — so the cutover
   * flip can be pre-filled. NPM: one list call, parse `details.forward` ("http://host:port").
   * Cloudflare: list tunnels, then each tunnel's routes, match `details.service`. The
   * upstream host equals `hostIpFor(source)` (the same value baked into routes at creation).
   */
  private async detectIngress(sourceInstanceId: string, wantedPorts: Set<number>): Promise<MigrateIngressSuggestion[]> {
    if (!wantedPorts.size) return [];
    const sourceIp = await this.hostIpFor(sourceInstanceId);
    if (!sourceIp) return [];
    const upstream = (svc: string): { host: string; port: number } | null => {
      const m = /^[a-z0-9]+:\/\/\[?([^\]:/]+)\]?:(\d+)/i.exec(svc.trim());
      return m ? { host: m[1], port: Number(m[2]) } : null;
    };
    // Collect EVERY route that points at the source stack (a stack can front several
    // hostnames — and several path-based rules per hostname — across one or more CF/NPM
    // connectors), deduped by instance+hostname+port+path.
    const found: MigrateIngressSuggestion[] = [];
    const seen = new Set<string>();
    const add = (s: MigrateIngressSuggestion) => {
      const key = `${s.instanceId}|${s.hostname}|${s.port}|${s.path ?? ''}`;
      if (!seen.has(key)) { seen.add(key); found.push(s); }
    };
    const targets = await this.ingress.listTargets().catch(() => []);
    for (const t of targets) {
      try {
        if (t.kind === 'npm') {
          const rows = await this.instances.listResources(t.instanceId, 'proxy_host');
          for (const r of rows) {
            const u = upstream(String(r.details?.forward ?? ''));
            if (u && u.host === sourceIp && wantedPorts.has(u.port)) {
              add({ source: 'npm', label: `${r.name} via ${t.name} (NPM)`, instanceId: t.instanceId, hostname: r.name, port: u.port });
            }
          }
        } else if (t.kind === 'cloudflare') {
          const tunnels = await this.instances.listResources(t.instanceId, 'tunnel');
          for (const tun of tunnels) {
            const routes = await this.instances.listSubResources(t.instanceId, 'tunnel', tun.id, 'route').catch(() => []);
            for (const r of routes) {
              const u = upstream(String(r.details?.service ?? ''));
              if (u && u.host === sourceIp && wantedPorts.has(u.port)) {
                const hostname = String(r.details?.hostname ?? r.name);
                const path = r.details?.path != null ? String(r.details.path) : undefined;
                const order = typeof r.details?.order === 'number' ? r.details.order : undefined;
                add({ source: 'cloudflare', label: `${hostname}${path ?? ''} via ${t.name} (Cloudflare)`, instanceId: t.instanceId, hostname, port: u.port, tunnelId: tun.id, path, order });
              }
            }
          }
        }
      } catch { /* a connector that can't be scanned shouldn't block the plan */ }
    }
    // Present in priority order: group by connector, then by the tunnel's real ingress
    // order (first-match-wins), NPM rows (no inherent order) trailing by hostname.
    const BIG = Number.MAX_SAFE_INTEGER;
    found.sort((a, b) =>
      a.instanceId.localeCompare(b.instanceId) ||
      (a.order ?? BIG) - (b.order ?? BIG) ||
      a.hostname.localeCompare(b.hostname, undefined, { sensitivity: 'base' }),
    );
    return found;
  }

  /** Readiness checks for the plan card: disk, compose plugin, repo, arch, compose
   *  readability, external volumes, host-specific directives, healthchecks. */
  private async runPreflight(a: {
    sourceName: string; destName: string; project: string;
    srcAccess: DockerHostAccess; dstAccess: DockerHostAccess;
    inspection: Awaited<ReturnType<typeof inspectStack>> | null;
    volumes: string[]; repoTargetId: string; sourceId: string;
  }): Promise<{ checks: PreflightCheck[]; estimatedDataBytes?: number }> {
    const checks: PreflightCheck[] = [];
    const add = (id: string, label: string, status: PreflightCheck['status'], detail?: string) => checks.push({ id, label, status, detail });

    add('source-ssh', 'Source reachable over SSH', a.srcAccess.ssh ? 'pass' : 'fail', a.srcAccess.ssh ? undefined : 'The source Docker connector has no SSH — capture needs it.');
    add('target-ssh', 'Target reachable over SSH', a.dstAccess.ssh ? 'pass' : 'fail', a.dstAccess.ssh ? undefined : 'The target Docker connector has no SSH — deploy needs it.');

    // Compose readable → without it only data (not a running stack) can move.
    const managed = await this.stacks.get(a.sourceId, a.project).catch(() => null) as { compose?: string } | null;
    const composeReadable = !!managed?.compose || (!!a.srcAccess.ssh && !!a.inspection?.composePath);
    add('compose', 'Compose file readable', composeReadable ? 'pass' : 'fail',
      composeReadable ? undefined : 'No compose is readable (stack isn’t Cerebro-managed and has no compose labels/SSH) — only its data could move, not a running stack.');

    // `docker compose` present on the target (restore deploys over SSH).
    if (a.dstAccess.ssh) {
      const res = await runSsh(a.dstAccess.ssh, 'docker compose version').catch(() => null);
      add('target-compose', 'Compose plugin on the target', res && res.code === 0 ? 'pass' : 'fail',
        res && res.code === 0 ? undefined : 'The target host has no `docker compose` — install the Compose plugin.');
    }

    // Estimated data size (source volume usage) + target free disk.
    let estimatedDataBytes: number | undefined;
    try {
      const df = await a.srcAccess.api.df();
      const sizes = new Map((df.Volumes ?? []).map((v) => [v.Name ?? '', v.UsageData?.Size ?? 0]));
      estimatedDataBytes = a.volumes.reduce((s, n) => s + (sizes.get(n) ?? 0), 0);
    } catch { /* best-effort */ }
    if (a.dstAccess.ssh && estimatedDataBytes != null) {
      const res = await runSsh(a.dstAccess.ssh, "df -Pk /var/lib/docker 2>/dev/null | tail -1 | awk '{print $4}'").catch(() => null);
      const freeKb = res && res.code === 0 ? Number(res.stdout.trim()) : NaN;
      if (Number.isFinite(freeKb)) {
        const freeBytes = freeKb * 1024;
        const need = estimatedDataBytes;
        add('disk', `Target disk space (${fmtBytes(need)} needed, ${fmtBytes(freeBytes)} free)`,
          freeBytes < need ? 'fail' : freeBytes < need * 1.2 ? 'warn' : 'pass',
          freeBytes < need ? 'Not enough free space on the target for the volume data.' : freeBytes < need * 1.2 ? 'Free space is tight (<20% headroom).' : undefined);
      } else {
        add('disk', 'Target disk space', 'warn', 'Could not read target free space (checked /var/lib/docker).');
      }
    }

    // Transfer repository reachable/writable.
    const repo = await this.targets.check(a.repoTargetId).catch((e) => ({ ok: false, message: e instanceof Error ? e.message : 'unreachable', exists: false }));
    add('repo', 'Transfer repository reachable', repo.ok ? 'pass' : 'fail', repo.ok ? undefined : `Repo check failed: ${repo.message}`);

    // Architecture match (matters for save/load of host-built images).
    const [sa, da] = await Promise.all([
      a.srcAccess.api.info().then((i) => (i as { Architecture?: string }).Architecture).catch(() => null),
      a.dstAccess.api.info().then((i) => (i as { Architecture?: string }).Architecture).catch(() => null),
    ]);
    if (sa && da) add('arch', `Architecture (${sa} → ${da})`, sa === da ? 'pass' : 'warn', sa === da ? undefined : 'Different CPU architectures — images built on the source may not run on the target.');

    // External volumes won't be recreated out-of-band on the target.
    const ext = (a.inspection?.volumes ?? []).filter((v) => v.external).map((v) => v.name);
    if (ext.length) add('external-vols', `External volume(s): ${ext.join(', ')}`, 'warn', 'Created outside the stack — they must already exist on the target; data copies only if currently mounted.');

    // Host-specific compose directives that may not translate.
    const composeText = managed?.compose ?? '';
    if (composeText) {
      const risky: string[] = [];
      if (/network_mode:\s*["']?host/i.test(composeText)) risky.push('network_mode: host');
      if (/privileged:\s*true/i.test(composeText)) risky.push('privileged');
      if (/^\s*devices:/m.test(composeText)) risky.push('devices');
      if (/extra_hosts:/i.test(composeText)) risky.push('extra_hosts');
      if (/nvidia|capabilities:\s*\[?\s*gpu/i.test(composeText)) risky.push('GPU');
      if (risky.length) add('host-specific', `Host-specific compose: ${risky.join(', ')}`, 'warn', 'These may not translate to the target — verify after cutover.');
    }

    // Healthchecks — verify is shallow without them.
    let anyHealth = false;
    for (const c of a.inspection?.containers ?? []) {
      const insp = await a.srcAccess.api.inspectContainer(c.id).catch(() => null);
      if (insp?.State?.Health) { anyHealth = true; break; }
    }
    if ((a.inspection?.containers.length ?? 0) > 0 && !anyHealth) {
      add('healthchecks', 'Container healthchecks', 'warn', 'No healthchecks declared — post-migration verify only confirms containers start, not that the app works.');
    }

    return { checks, estimatedDataBytes };
  }

  /** Did this image come from a registry (so the target can pull it)? A locally
   *  built image has no RepoDigests — that is the "built on the host" signal. */
  private async looksPullable(api: DockerApi, ref: string): Promise<boolean> {
    try {
      const info = await api.inspectImage(ref);
      return (info.RepoDigests?.length ?? 0) > 0;
    } catch {
      return true; // can't tell → assume pullable; execute() falls back to transfer anyway
    }
  }

  // ── Executing ─────────────────────────────────────────────────────

  async start(input: StartMigrateInput, actor?: MigrateActor): Promise<StackMigrationRun> {
    const plan = await this.plan(input);
    const failed = plan.checks.filter((c) => c.status === 'fail').map((c) => c.label);
    if ((plan.conflicts.length || failed.length) && !input.force) {
      throw new BadRequestException(`Migration blocked: ${[...plan.conflicts, ...failed].join(' · ')}`);
    }
    if (plan.needsPassphrase && !input.passphrase) {
      throw new BadRequestException("This stack's backup seals its secrets — supply the passphrase so the target .env can be rebuilt.");
    }
    const key = `${plan.destInstanceId}/${plan.destStackName}`;
    if (this.active.has(key)) throw new BadRequestException('A migration is already running for that target.');

    // Re-point the replicator deployment on cutover unless the operator opted out.
    const replicatorDeploymentId = plan.replicator && input.repointReplicator !== false ? plan.replicator.deploymentId : null;

    const run = await this.prisma.stackMigrationRun.create({
      data: {
        sourceInstanceId: plan.sourceInstanceId,
        stackName: plan.stackName,
        destInstanceId: plan.destInstanceId,
        destStackName: plan.destStackName,
        repoTargetId: plan.repoTargetId,
        step: 'planned',
        status: 'running',
        images: plan.images as unknown as object,
        ingress: (plan.ingressRoutes?.length ? plan.ingressRoutes : undefined) as unknown as object,
        replicatorDeploymentId,
      },
    });
    await this.audit.record({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'stack.migrate.started',
      target: `${plan.stackName} → ${plan.destStackName}`,
      meta: { source: plan.sourceInstanceId, dest: plan.destInstanceId, repo: plan.repoTargetId, replicator: !!replicatorDeploymentId },
    }).catch(() => undefined);
    const ac = new AbortController();
    this.cancels.set(run.id, ac);
    this.active.add(key);
    void this.execute(run.id, input, plan, ac.signal).finally(() => { this.active.delete(key); this.cancels.delete(run.id); });
    return this.getRun(run.id);
  }

  /**
   * Cancel a running migration: abort its background task (poll waits, image
   * pull/transfer stop promptly; a restic capture/restore already in flight can't be
   * hard-killed and may still finish into its own run), then clean up — restart the
   * source if it was stopped, remove any partial target — and return a summary.
   */
  async cancel(id: string, actor?: MigrateActor): Promise<StackMigrationRun> {
    const row = await this.prisma.stackMigrationRun.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Migration run not found.');
    if (row.status !== 'running') throw new BadRequestException('Only a running migration can be cancelled.');
    const ac = this.cancels.get(id);
    if (!ac) {
      // No live task in this process (e.g. after a failover) — settle the row directly.
      await this.finish(id, { status: 'cancelled', step: 'cancelled', message: 'Cancelled — no active task was found on this server; roll back if a partial target remains.', durationMs: row.durationMs ?? 0, log: `${row.log ?? ''}` });
    } else {
      ac.abort();
      // Wait for execute()'s cancel path to clean up and settle the row.
      await this.poll(() => this.prisma.stackMigrationRun.findUnique({ where: { id } }), 120_000);
    }
    await this.audit.record({ actorId: actor?.id, actorEmail: actor?.email, action: 'stack.migrate.cancelled', target: `${row.stackName} → ${row.destStackName}` }).catch(() => undefined);
    return this.getRun(id);
  }

  private async execute(runId: string, input: StartMigrateInput, plan: MigratePlan, signal: AbortSignal): Promise<void> {
    const started = Date.now();
    const log: string[] = [];
    const say = (line: string) => { log.push(`${new Date().toISOString()}  ${line}`); void this.patch(runId, { log: log.join('\n').slice(-MAX_LOG_CHARS) }); };
    const ck = () => { if (signal.aborted) throw new CancelledError(); };
    const quiesce = input.quiesceSource !== false;
    let sourceStopped = false;

    // Warm pre-copy only helps when we're going to quiesce: seed the repo + move
    // images while the source still runs, so the downtime window is just the
    // quiesced delta capture + restore. Pointless (and skipped) for a warm/stateless
    // copy that never quiesces.
    const warm = quiesce && input.warmPrecopy !== false;
    // Live-ish (P4): also PRE-RESTORE the warm snapshot onto the target while the
    // source still runs, so the stop-the-world window is just a fast delta capture +
    // delta restore, not a full restore. Only meaningful on top of a warm pre-copy.
    const live = warm && input.preRestore !== false;

    try {
      const source = await this.hostOrThrow(plan.sourceInstanceId);
      const dest = await this.hostOrThrow(plan.destInstanceId);
      const srcAccess = await this.accessFor(source.id);
      const dstAccess = await this.accessFor(dest.id);
      say(`Migrating "${plan.stackName}" from ${source.name} → "${plan.destStackName}" on ${dest.name}${live ? ' (live-ish)' : warm ? ' (warm pre-copy)' : ' (cold)'}.`);

      // One capture policy, reused for the warm pre-copy and the quiesced delta.
      const policy = await this.ensureCapturePolicy(source.id, plan, input.includeBinds ?? [], say);
      try {
        // 1) Image transfer FIRST, while the source still runs — images are static,
        //    so moving them now keeps them out of the downtime window (every mode).
        ck();
        await this.setStep(runId, 'transferring-images');
        const refs = plan.images.map((i) => i.ref);
        const outcomes = await ensureImagesOnTarget(
          srcAccess.api, dstAccess.api, refs, say,
          (done, imgTotal) => { void this.patch(runId, { message: `Transferring images (${done}/${imgTotal})…` }); },
          signal,
        );
        await this.patch(runId, { images: outcomes.map((o) => ({ ref: o.ref, method: o.method === 'loaded' ? 'transfer' : o.method === 'pulled' ? 'pull' : 'present' })) as unknown as object });

        // 2) Warm pre-copy (source running): seed the repo so the quiesced delta is
        //    small. restic dedups, so the final capture only uploads what changed.
        if (warm) {
          ck();
          await this.setStep(runId, 'pre-copying');
          say('Warm pre-copy: backing up the running stack to seed the repo (no downtime)…');
          const warmSnap = await this.runBackup(policy.policyId, input.passphrase, say, signal);
          // 2b) Live-ish: pre-restore that warm snapshot's volumes onto the target now,
          //     while the source keeps serving — the bulk of the restore, out of the
          //     downtime window. The target volumes are created and seeded (stale);
          //     the quiesced delta restore below brings them current.
          if (live && warmSnap.snapshotId) {
            ck();
            await this.setStep(runId, 'pre-restoring');
            say('Pre-restoring the warm snapshot onto the target (data only, source still live)…');
            await this.restoreDataToTarget(plan, warmSnap.snapshotId, input.passphrase, say, signal);
          }
        }

        // 3) Quiesce the source so the FINAL capture is consistent.
        ck();
        if (quiesce) {
          await this.setStep(runId, 'quiescing');
          const stopped = await this.stopProject(srcAccess.api, plan.stackName, say);
          sourceStopped = stopped > 0;
          say(`Stopped ${stopped} source container(s) for a consistent copy.`);
        } else {
          say('Warm copy requested — the source stays running (only safe for stateless stacks).');
        }

        // 4) Capture — a fast delta when the warm pre-copy seeded the repo, else full.
        ck();
        await this.setStep(runId, 'capturing');
        const final = await this.runBackup(policy.policyId, input.passphrase, say, signal);
        const snapshotId = final.snapshotId as string;
        await this.patch(runId, { snapshotId });
        say(`Captured ${warm ? 'delta ' : ''}snapshot ${snapshotId.slice(0, 8)}.`);

        // 5) Restore + deploy onto the target. When we pre-restored, restic writes
        //    only the files that changed since the warm copy — a fast delta restore.
        ck();
        await this.setStep(runId, 'restoring');
        await this.restoreToTarget(plan, snapshotId, input, say, signal);

        // 6) Verify it came up healthy before declaring the target good.
        ck();
        await this.setStep(runId, 'verifying');
        const health = await this.waitHealthy(dstAccess.api, plan.destStackName, say, signal);
        if (!health.ok) throw new Error(`The migrated stack did not come up healthy — ${health.detail}`);
      } finally {
        await policy.cleanup();
      }

      const message = `Migrated "${plan.stackName}" to "${plan.destStackName}" on ${dest.name} and it came up healthy. The source is stopped — repoint ingress, then Complete to tear it down (or Rollback to restore it).`;
      say(message);
      await this.finish(runId, { status: 'success', step: 'awaiting-cutover', message, durationMs: Date.now() - started, log: log.join('\n') });
      void this.logging.info('stack-migrate', message);
    } catch (err) {
      // Operator cancel: clean up (restart source, remove the partial target) and summarize.
      if (err instanceof CancelledError || signal.aborted) {
        await this.setStep(runId, 'cancelling');
        say('Cancelled — cleaning up…');
        const summary: string[] = [];
        if (sourceStopped) {
          try {
            const n = await this.startProject((await this.accessFor(plan.sourceInstanceId)).api, plan.stackName, say);
            summary.push(`source restarted (${n} container(s))`);
          } catch (e) { summary.push(`source restart FAILED (${msg(e)} — start it by hand)`); }
        } else {
          summary.push('source left running');
        }
        try {
          const dst = await this.accessFor(plan.destInstanceId);
          const c = await this.removeProjectContainers(dst.api, plan.destStackName, say);
          const v = await this.removeProjectVolumes(dst.api, plan.destStackName, say);
          if (dst.target) await this.stacks.remove(plan.destInstanceId, plan.destStackName).catch(() => undefined);
          summary.push(`target cleaned up (${c} container(s), ${v} volume(s))`);
        } catch (e) { summary.push(`target cleanup had issues (${msg(e)})`); }
        const cmsg = `Cancelled. ${summary.join('; ')}. A capture/restore already in flight may still finish on its own — the target cleanup above removes whatever it would land.`;
        say(cmsg);
        await this.finish(runId, { status: 'cancelled', step: 'cancelled', message: cmsg, durationMs: Date.now() - started, log: log.join('\n') });
        void this.logging.info('stack-migrate', `Migration ${runId} cancelled.`);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      say(`Failed: ${message}`);
      // Don't leave the operator with nothing running: bring the source back up.
      if (sourceStopped) {
        try {
          const srcAccess = await this.accessFor(plan.sourceInstanceId);
          const n = await this.startProject(srcAccess.api, plan.stackName, say);
          say(`Restarted ${n} source container(s) after the failure — the source is serving again.`);
        } catch (resumeErr) {
          say(`WARNING: could not restart the source: ${resumeErr instanceof Error ? resumeErr.message : resumeErr}. Start it by hand.`);
        }
      }
      await this.finish(runId, { status: 'error', step: 'failed', message, durationMs: Date.now() - started, log: log.join('\n') });
      void this.logging.error('stack-migrate', `Migration ${runId} failed: ${message}`);
    }
  }

  /** Resolve the capture policy for the source stack — reuse an existing one, or
   *  create a transient disabled one — and return a cleanup that deletes a transient
   *  policy afterwards (StackBackupRun.policyId is SetNull, so run history survives).
   *  The same policy backs both the warm pre-copy and the quiesced delta capture. */
  private async ensureCapturePolicy(sourceId: string, plan: MigratePlan, includeBinds: string[], say: (l: string) => void): Promise<{ policyId: string; cleanup: () => Promise<void> }> {
    const existing = await this.prisma.stackBackupPolicy.findUnique({
      where: { connectorInstanceId_stackName: { connectorInstanceId: sourceId, stackName: plan.stackName } },
    }).catch(() => null);
    if (existing) {
      say(`Using the existing backup policy for "${plan.stackName}".`);
      if (includeBinds.length && !includeBinds.every((b) => (existing.includeBinds ?? []).includes(b))) {
        say('NOTE: the existing backup policy does not capture all the bind paths you selected — they may be missing from the snapshot. Edit the policy, or remove the policy, to capture them.');
      }
      return { policyId: existing.id, cleanup: async () => undefined };
    }
    const created = await this.prisma.stackBackupPolicy.create({
      data: {
        connectorInstanceId: sourceId,
        stackName: plan.stackName,
        targetId: plan.repoTargetId,
        enabled: false, // the scheduler must never pick up a migration's scratch policy
        frequency: 'off',
        quiesce: 'hot', // the migrator manages quiesce itself (cold / warm-precopy)
        transfer: 'direct',
        secretMode: plan.secretMode,
        includeBinds, // bind-mount host paths the operator opted to copy
      },
    });
    say('Created a one-off capture for this migration.');
    return {
      policyId: created.id,
      cleanup: async () => { await this.prisma.stackBackupPolicy.delete({ where: { id: created.id } }).catch(() => undefined); },
    };
  }

  /**
   * Surface the tail of a child run's own log (the restic stdout/stderr lives on the
   * capture/restore run, not here) into the migrator log, so a failure is diagnosable
   * on THIS screen instead of a bare "see the log" that points at a different run.
   */
  private surfaceChildLog(childLog: string | null | undefined, say: (l: string) => void, label = 'restore'): void {
    const text = (childLog ?? '').trim();
    if (!text) return;
    const tail = text.split('\n').slice(-15);
    say(`— ${label} log (last ${tail.length} line${tail.length === 1 ? '' : 's'}) —`);
    for (const l of tail) say(l);
    say(`— end ${label} log —`);
  }

  /** Run one backup on the policy and wait for it; returns the finished run (with
   *  its snapshotId). restic dedups, so a second run on the same policy uploads only
   *  the delta. Throws on failure. */
  private async runBackup(policyId: string, passphrase: string | undefined, say: (l: string) => void, signal?: AbortSignal): Promise<{ snapshotId: string | null; status: string }> {
    const run = await this.backups.startBackup(policyId, passphrase, 'manual');
    const final = await this.poll(() => this.prisma.stackBackupRun.findUnique({ where: { id: run.id } }), CAPTURE_TIMEOUT_MS, signal);
    if (!final || final.status !== 'success' || !final.snapshotId) {
      this.surfaceChildLog(final?.log, say, 'capture');
      throw new Error(`Capture failed: ${final?.message ?? 'no snapshot produced'}`);
    }
    if (final.message) say(final.message);
    return { snapshotId: final.snapshotId, status: final.status };
  }

  /** Restore+deploy onto the target via the restore pipeline, then wait for the run.
   *  Carries the operator's bind-path selection (+ remap) and credential-file choice. */
  private async restoreToTarget(plan: MigratePlan, snapshotId: string, input: StartMigrateInput, say: (l: string) => void, signal?: AbortSignal): Promise<void> {
    const binds = input.includeBinds?.length ? input.includeBinds : undefined;
    const run = await this.restores.start({
      targetId: plan.repoTargetId,
      snapshotId,
      destInstanceId: plan.destInstanceId,
      destStackName: plan.destStackName,
      mode: 'full',
      deploy: true,
      force: true, // our own plan already gated conflicts; the target is a fresh name
      passphrase: input.passphrase,
      binds,
      bindMap: input.bindMap,
      restoreCredentialFiles: input.restoreCredentialFiles,
    });
    const final = await this.poll(() => this.prisma.stackRestoreRun.findUnique({ where: { id: run.id } }), RESTORE_TIMEOUT_MS, signal);
    if (!final || final.status !== 'success') {
      this.surfaceChildLog(final?.log, say);
      if (/device or resource busy|resource busy/i.test(`${final?.message ?? ''}\n${final?.log ?? ''}`)) {
        say('Hint: a bind-mounted file on the target is in use — usually a same-named stack already running there (or a leftover from a prior attempt), which holds its single-file bind mounts open. Remove/stop that target stack (or migrate to a new target stack name), or turn off “Copy bind-mount host paths” for files the deploy recreates from the repo, then retry.');
      }
      throw new Error(`Restore to the target failed: ${final?.message ?? 'unknown error'}`);
    }
    say(`Restored and deployed on the target (${final.volumes} volume(s)${final.binds ? `, ${final.binds} bind path(s)` : ''}).`);
  }

  /**
   * Live-ish pre-restore (P4): restore a warm snapshot's volumes onto the target
   * WITHOUT deploying, while the source is still serving. Creates + seeds the target
   * volumes so the later quiesced restore only writes the delta. Data-only so nothing
   * starts against the (stale) warm data.
   */
  private async restoreDataToTarget(plan: MigratePlan, snapshotId: string, passphrase: string | undefined, say: (l: string) => void, signal?: AbortSignal): Promise<void> {
    const run = await this.restores.start({
      targetId: plan.repoTargetId,
      snapshotId,
      destInstanceId: plan.destInstanceId,
      destStackName: plan.destStackName,
      mode: 'data',
      deploy: false,
      force: true,
      passphrase,
    });
    const final = await this.poll(() => this.prisma.stackRestoreRun.findUnique({ where: { id: run.id } }), RESTORE_TIMEOUT_MS, signal);
    if (!final || final.status !== 'success') {
      // A pre-restore failure is not fatal — fall back to a full restore in the
      // downtime window. Log and continue rather than aborting the migration.
      say(`WARNING: pre-restore did not complete (${final?.message ?? 'unknown'}). The final restore will copy everything instead.`);
      this.surfaceChildLog(final?.log, say, 'pre-restore');
      return;
    }
    say(`Pre-restored ${final.volumes} volume(s) to the target (source still live).`);
  }

  // ── Cutover / rollback ────────────────────────────────────────────

  /**
   * Cut over: flip the ingress hostname to the target (if one was configured) so
   * traffic moves first, then tear the (already stopped) source stack down.
   */
  async complete(id: string, actor?: MigrateActor): Promise<StackMigrationRun> {
    const row = await this.prisma.stackMigrationRun.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Migration run not found.');
    if (row.step !== 'awaiting-cutover') throw new BadRequestException('This migration is not awaiting cutover.');
    await this.patch(id, { step: 'completing' });
    const log = (row.log ? row.log + '\n' : '');
    const say = (l: string) => void this.patch(id, { log: (log + `${new Date().toISOString()}  ${l}`).slice(-MAX_LOG_CHARS) });
    try {
      // 1) Repoint every ingress route at the target BEFORE stopping the source → minimal
      //    downtime. A stack can front several hostnames; flip them all.
      const routes = this.ingressFromRow(row.ingress);
      if (routes.length) {
        const targetIp = await this.hostIpFor(row.destInstanceId);
        if (!targetIp) throw new BadRequestException('Could not resolve the target host IP for the ingress flip.');
        let flipped = 0;
        for (const r of routes) {
          say(`Repointing ${r.hostname}${r.path ?? ''} → ${targetIp}:${r.port} on the ingress connector…`);
          await this.ingressOps.setRoute({
            instanceId: r.instanceId, hostname: r.hostname, upstreamHost: targetIp, port: r.port,
            tunnelId: r.tunnelId, certificateId: r.certificateId, path: r.path,
          });
          flipped++;
        }
        await this.patch(id, { ingressFlipped: true });
        say(`Ingress now serves the target (${flipped} route${flipped === 1 ? '' : 's'} repointed).`);
      }
      // 2) Re-point an App Replicator deployment (+ its own ingress routes) to the
      //    target, so the replicator keeps managing the app instead of the dead source.
      if (row.replicatorDeploymentId) {
        const targetIp = await this.hostIpFor(row.destInstanceId);
        say(`Re-pointing the App Replicator deployment to the target…`);
        if (targetIp) {
          const probs = await this.ingress.repointForDeployment(row.replicatorDeploymentId, targetIp);
          probs.forEach((p) => say(`Ingress re-point warning: ${p}`));
        }
        await this.deployments.repoint(row.replicatorDeploymentId, row.destInstanceId, row.destStackName);
        await this.patch(id, { replicatorRepointed: true });
        say('Replicator now points at the migrated stack on the target.');
      }
      // 3) Tear the source down.
      const access = await this.accessFor(row.sourceInstanceId);
      const removed = await this.removeProjectContainers(access.api, row.stackName, say);
      say(`Removed ${removed} source container(s). Source volumes are kept — prune them by hand once you're satisfied.`);
      const flipNote = routes.length ? ` and repointed ${routes.length === 1 ? routes[0].hostname : `${routes.length} routes`}` : '';
      await this.finish(id, { status: 'success', step: 'done', message: `Cut over to the target${flipNote}. Source "${row.stackName}" torn down.`, durationMs: row.durationMs ?? 0, log: `${row.log ?? ''}` });
      await this.prisma.stackMigrationRun.update({ where: { id }, data: { sourceKept: false } });
      await this.audit.record({ actorId: actor?.id, actorEmail: actor?.email, action: 'stack.migrate.cutover', target: `${row.stackName} → ${row.destStackName}`, meta: { dest: row.destInstanceId, ingressRoutesFlipped: routes.length, replicatorRepointed: !!row.replicatorDeploymentId } }).catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.patch(id, { step: 'awaiting-cutover', message: `Cutover failed: ${message}` });
      throw new BadRequestException(`Could not cut over: ${message}`);
    }
    return this.getRun(id);
  }

  /** Undo: flip ingress back to the source, restart it, remove the migrated target. */
  async rollback(id: string, actor?: MigrateActor): Promise<StackMigrationRun> {
    const row = await this.prisma.stackMigrationRun.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Migration run not found.');
    if (row.step !== 'awaiting-cutover' && row.step !== 'failed') {
      throw new BadRequestException('Only a migration awaiting cutover (or a failed one) can be rolled back.');
    }
    const say = (l: string) => void this.patch(id, { log: ((row.log ? row.log + '\n' : '') + `${new Date().toISOString()}  ${l}`).slice(-MAX_LOG_CHARS) });
    try {
      // 1) Bring the source back up.
      const src = await this.accessFor(row.sourceInstanceId);
      const resumed = await this.startProject(src.api, row.stackName, say);
      say(`Restarted ${resumed} source container(s) — the source is serving again.`);
      // 2) If ingress was flipped to the target, point every route back at the source.
      const routes = this.ingressFromRow(row.ingress);
      if (routes.length && row.ingressFlipped) {
        const sourceIp = await this.hostIpFor(row.sourceInstanceId);
        if (sourceIp) {
          for (const r of routes) {
            say(`Repointing ${r.hostname}${r.path ?? ''} → ${sourceIp}:${r.port} back to the source…`);
            await this.ingressOps.setRoute({
              instanceId: r.instanceId, hostname: r.hostname, upstreamHost: sourceIp, port: r.port,
              tunnelId: r.tunnelId, certificateId: r.certificateId, path: r.path,
            }).catch((e) => say(`WARNING: could not flip ${r.hostname}${r.path ?? ''} back: ${msg(e)}. Repoint it by hand.`));
          }
          await this.patch(id, { ingressFlipped: false });
        }
      }
      // 2b) If the replicator deployment was re-pointed, point it back at the source.
      if (row.replicatorDeploymentId && row.replicatorRepointed) {
        const sourceIp = await this.hostIpFor(row.sourceInstanceId);
        if (sourceIp) {
          const probs = await this.ingress.repointForDeployment(row.replicatorDeploymentId, sourceIp).catch(() => [] as string[]);
          probs.forEach((p) => say(`Ingress re-point warning: ${p}`));
        }
        await this.deployments.repoint(row.replicatorDeploymentId, row.sourceInstanceId, row.stackName);
        await this.patch(id, { replicatorRepointed: false });
        say('Reverted the App Replicator deployment back to the source.');
      }
      // 3) Remove the target stack + the volumes the restore created there.
      const dst = await this.accessFor(row.destInstanceId);
      const removed = await this.removeProjectContainers(dst.api, row.destStackName, say);
      const vols = await this.removeProjectVolumes(dst.api, row.destStackName, say);
      if (dst.target) await this.stacks.remove(row.destInstanceId, row.destStackName).catch(() => undefined);
      say(`Removed the target stack (${removed} container(s), ${vols} volume(s)).`);
      await this.finish(id, { status: 'success', step: 'rolled_back', message: 'Rolled back — source restored, target removed.', durationMs: row.durationMs ?? 0, log: `${row.log ?? ''}` });
      await this.audit.record({ actorId: actor?.id, actorEmail: actor?.email, action: 'stack.migrate.rolledback', target: `${row.stackName} → ${row.destStackName}`, meta: { source: row.sourceInstanceId } }).catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Rollback failed: ${message}`);
    }
    return this.getRun(id);
  }

  /**
   * Operator escape hatch: mark a stuck `running` migration as failed so it can be
   * rolled back, without waiting on its background task (a hung pull / restic). The
   * background promise can't be force-killed, so it MAY still finish on its own — if
   * it actually succeeds it will overwrite this to success; if it's truly stuck, the
   * row stays failed and Rollback cleans up the partial target.
   */
  async forceFail(id: string, actor?: MigrateActor): Promise<StackMigrationRun> {
    const row = await this.prisma.stackMigrationRun.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Migration run not found.');
    if (row.status !== 'running') throw new BadRequestException('Only a running migration can be force-failed.');
    await this.finish(id, {
      status: 'error',
      step: 'failed',
      message: 'Force-failed by the operator. Its background task may still be finishing; roll back to clean up the target.',
      durationMs: row.durationMs ?? 0,
      log: `${row.log ?? ''}`,
    });
    await this.audit.record({ actorId: actor?.id, actorEmail: actor?.email, action: 'stack.migrate.force_failed', target: `${row.stackName} → ${row.destStackName}` }).catch(() => undefined);
    return this.getRun(id);
  }

  /** The reachable LAN IP a tunnel/proxy should forward to for a Docker host. */
  private async hostIpFor(instanceId: string): Promise<string> {
    const inst = await this.prisma.connectorInstance.findUnique({ where: { id: instanceId } }).catch(() => null);
    if (!inst) return '';
    const ctx = await this.instances.contextFor(inst);
    return dockerTargetFrom(ctx).hostIp;
  }

  /** Normalize the stored `ingress` column into a route array. Accepts the current
   *  array shape and legacy single-object rows (object → [object]) for back-compat. */
  private ingressFromRow(raw: unknown): MigrateIngressSpec[] {
    if (!raw) return [];
    const arr = Array.isArray(raw) ? raw : [raw];
    const out: MigrateIngressSpec[] = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Partial<MigrateIngressSpec>;
      if (!o.instanceId || !o.hostname || typeof o.port !== 'number') continue;
      out.push({ instanceId: o.instanceId, hostname: o.hostname, port: o.port, tunnelId: o.tunnelId, certificateId: o.certificateId, path: o.path, order: o.order });
    }
    return out;
  }

  // ── Engine-API stack ops (work for foreign/unmanaged stacks too) ──

  private projectContainers(api: DockerApi, project: string) {
    return api.listContainers(true).then((cs) => cs.filter((c) => (c.Labels ?? {})['com.docker.compose.project'] === project));
  }

  private async stopProject(api: DockerApi, project: string, say: (l: string) => void): Promise<number> {
    const cs = (await this.projectContainers(api, project))
      .filter((c) => RUNNING.has(c.State ?? ''))
      .sort((a, b) => (b.Created ?? 0) - (a.Created ?? 0)); // dependents first
    let n = 0;
    for (const c of cs) {
      try { await api.stopContainer(c.Id); n++; } catch (e) { say(`Could not stop ${(c.Names ?? [])[0] ?? c.Id.slice(0, 12)}: ${msg(e)}`); }
    }
    return n;
  }

  private async startProject(api: DockerApi, project: string, say: (l: string) => void): Promise<number> {
    const cs = (await this.projectContainers(api, project))
      .filter((c) => !RUNNING.has(c.State ?? ''))
      .sort((a, b) => (a.Created ?? 0) - (b.Created ?? 0)); // dependencies first
    let n = 0;
    for (const c of cs) {
      try { await api.startContainer(c.Id); n++; } catch (e) { say(`Could not start ${(c.Names ?? [])[0] ?? c.Id.slice(0, 12)}: ${msg(e)}`); }
    }
    return n;
  }

  private async removeProjectContainers(api: DockerApi, project: string, say: (l: string) => void): Promise<number> {
    const cs = await this.projectContainers(api, project);
    let n = 0;
    for (const c of cs) {
      try { await api.removeContainer(c.Id); n++; } catch (e) { say(`Could not remove ${(c.Names ?? [])[0] ?? c.Id.slice(0, 12)}: ${msg(e)}`); }
    }
    return n;
  }

  private async removeProjectVolumes(api: DockerApi, project: string, say: (l: string) => void): Promise<number> {
    let n = 0;
    try {
      const vols = await api.listVolumes();
      for (const v of vols) {
        if ((v.Labels ?? {})['com.docker.compose.project'] !== project) continue;
        const ok = await api.removeVolume(v.Name).then(() => true).catch(() => false);
        if (ok) n++; else say(`Could not remove volume ${v.Name} (still in use?).`);
      }
    } catch (e) {
      say(`Could not list volumes to remove: ${msg(e)}`);
    }
    return n;
  }

  /** Every container of the project running (and healthy, if it declares a check),
   *  twice in a row — the same bar the restore verify uses. */
  private async waitHealthy(api: DockerApi, project: string, say: (l: string) => void, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let consecutive = 0;
    let last = 'no containers yet';
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new CancelledError();
      await sleep(5000);
      let cs;
      try { cs = await this.projectContainers(api, project); } catch (e) { last = `inspect failed: ${msg(e)}`; continue; }
      if (!cs.length) { last = 'no containers were created'; continue; }
      const states: string[] = [];
      let allGood = true;
      for (const c of cs) {
        const name = (c.Names ?? [])[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12);
        const inspect = await api.inspectContainer(c.Id).catch(() => null);
        const health = inspect?.State?.Health?.Status;
        const running = inspect?.State?.Running ?? c.State === 'running';
        const finishedCleanly = !running && inspect?.State?.Status === 'exited' && c.Status?.includes('(0)');
        const good = health ? health === 'healthy' : running || !!finishedCleanly;
        states.push(`${name}=${health ?? (running ? 'running' : c.State ?? 'unknown')}`);
        if (!good) allGood = false;
      }
      last = states.join(', ');
      if (allGood) { if (++consecutive >= 2) return { ok: true, detail: last }; }
      else consecutive = 0;
      say(`Waiting for the target stack: ${last}`);
    }
    return { ok: false, detail: `timed out after ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s — ${last}` };
  }

  // ── History ───────────────────────────────────────────────────────

  async listRuns(limit = 25, includeArchived = false): Promise<StackMigrationRun[]> {
    const rows = await this.prisma.stackMigrationRun.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    const names = await this.hostNames();
    return rows.map((r) => this.runDto(r, names));
  }

  /** Dismiss (soft-archive) a terminal run so it drops out of the default list. Kept for
   *  history; un-dismiss with `restore`. Refused while the run is still in flight or
   *  awaiting cutover (those have their own Cancel / Complete / Rollback actions). */
  async dismiss(id: string, actor?: MigrateActor): Promise<StackMigrationRun> {
    const row = await this.prisma.stackMigrationRun.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Migration run not found.');
    if (row.status === 'running' || row.step === 'awaiting-cutover') {
      throw new BadRequestException('This migration is still active — cancel, complete or roll it back before dismissing it.');
    }
    await this.prisma.stackMigrationRun.update({ where: { id }, data: { archivedAt: new Date() } });
    await this.audit.record({ actorId: actor?.id, actorEmail: actor?.email, action: 'stack.migrate.dismiss', target: `${row.stackName} → ${row.destStackName}`, meta: { step: row.step } }).catch(() => undefined);
    return this.getRun(id);
  }

  /** Dismiss every finished (terminal, not-yet-archived) run in one go — the test-churn
   *  declutter. Leaves running and awaiting-cutover runs alone. Returns how many it hid. */
  async dismissFinished(actor?: MigrateActor): Promise<{ dismissed: number }> {
    const res = await this.prisma.stackMigrationRun.updateMany({
      where: { archivedAt: null, status: { not: 'running' }, step: { not: 'awaiting-cutover' } },
      data: { archivedAt: new Date() },
    });
    if (res.count) {
      await this.audit.record({ actorId: actor?.id, actorEmail: actor?.email, action: 'stack.migrate.dismiss-all', target: 'finished migrations', meta: { count: res.count } }).catch(() => undefined);
    }
    return { dismissed: res.count };
  }

  /** Un-dismiss a previously archived run (bring it back to the default list). */
  async restoreToList(id: string): Promise<StackMigrationRun> {
    const row = await this.prisma.stackMigrationRun.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Migration run not found.');
    await this.prisma.stackMigrationRun.update({ where: { id }, data: { archivedAt: null } });
    return this.getRun(id);
  }

  async getRun(id: string): Promise<StackMigrationRun> {
    const row = await this.prisma.stackMigrationRun.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Migration run not found.');
    const names = await this.hostNames();
    return { ...this.runDto(row, names), log: row.log };
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private async accessFor(instanceId: string): Promise<DockerHostAccess> {
    const host = await this.hostOrThrow(instanceId);
    const ctx = await this.instances.contextFor(host);
    return hostAccess(ctx, this.stacks);
  }

  private async hostOrThrow(id: string) {
    const host = await this.prisma.connectorInstance.findUnique({ where: { id } });
    if (!host || host.connectorId !== DOCKER) throw new BadRequestException('Choose a Docker host.');
    return host;
  }

  private async hostNames(): Promise<Map<string, string>> {
    const rows = await this.prisma.connectorInstance.findMany({ where: { connectorId: DOCKER }, select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async poll<T extends { status: string }>(get: () => Promise<T | null>, timeoutMs: number, signal?: AbortSignal): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) throw new CancelledError();
      const row = await get();
      if (row && row.status !== 'running') return row;
      if (Date.now() > deadline) return row;
      await sleep(POLL_MS);
    }
  }

  private async setStep(id: string, step: MigrateStep): Promise<void> {
    await this.patch(id, { step });
  }

  private async patch(id: string, data: Record<string, unknown>): Promise<void> {
    await this.prisma.stackMigrationRun.update({ where: { id }, data }).catch(() => undefined);
  }

  private async finish(id: string, data: { status: string; step: MigrateStep; message: string; durationMs: number; log: string }): Promise<void> {
    await this.prisma.stackMigrationRun.update({
      where: { id },
      data: { status: data.status, step: data.step, message: data.message, durationMs: data.durationMs, log: data.log.slice(-MAX_LOG_CHARS), finishedAt: new Date() },
    }).catch(() => undefined);
  }

  private runDto(
    row: {
      id: string; sourceInstanceId: string; stackName: string; destInstanceId: string; destStackName: string;
      repoTargetId: string; step: string; status: string; message: string | null; snapshotId: string | null;
      images: unknown; ingress: unknown; ingressFlipped: boolean; replicatorDeploymentId: string | null;
      replicatorRepointed: boolean; sourceKept: boolean; durationMs: number | null;
      startedAt: Date; finishedAt: Date | null; archivedAt?: Date | null;
    },
    names: Map<string, string>,
  ): StackMigrationRun {
    return {
      id: row.id,
      sourceInstanceId: row.sourceInstanceId,
      sourceHostName: names.get(row.sourceInstanceId),
      stackName: row.stackName,
      destInstanceId: row.destInstanceId,
      destHostName: names.get(row.destInstanceId),
      destStackName: row.destStackName,
      repoTargetId: row.repoTargetId,
      step: row.step as MigrateStep,
      status: row.status,
      message: row.message,
      snapshotId: row.snapshotId,
      images: Array.isArray(row.images) ? (row.images as MigrateImagePlanItem[]) : [],
      sourceKept: row.sourceKept,
      ingressRoutes: this.ingressFromRow(row.ingress),
      ingressFlipped: row.ingressFlipped,
      replicatorDeploymentId: row.replicatorDeploymentId,
      replicatorRepointed: row.replicatorRepointed,
      durationMs: row.durationMs,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      archived: !!row.archivedAt,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/** Compose's project-name rules: lowercase, alphanumerics, dash and underscore. */
function projectName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}
