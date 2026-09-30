import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { DockerApi } from '../connectors/docker/docker-api';
import { DockerStackService } from '../connectors/docker/docker-stack.service';
import { runSsh, type SshConfig } from '../connectors/docker/docker-ssh';
import type { ConnectorContext } from '@cerebro/shared';
import type {
  QuiesceMode, SaveBackupPolicyInput, SecretMode, StackBackupCandidate, StackBackupPolicy,
  StackBackupRun, TransferMode,
} from '@cerebro/shared';
import { BackupTargetService } from './backup-target.service';
import { SecretCaptureService } from './secret-capture';
import { bindSlug, inspectStack, manifestOf, type StackInspection } from './stack-inspect';
import { removeHostDir, runHelper, writeHostDir, type HelperMount } from './helper-runner';
import { friendlyRestic, parseBackupSummary, resticEnv } from './restic-cli';

const DOCKER = 'docker';
const PROJECT_LABEL = 'com.docker.compose.project';
/** A backup of a large volume set is slow; cap it well above any plausible run. */
const BACKUP_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** Keep the stored run log bounded — restic is chatty on a first (non-incremental) run. */
const MAX_LOG_CHARS = 64 * 1024;

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * Stack backup orchestration: work out what a stack is made of, stage its metadata
 * on the host, and run restic in a helper container with the volumes mounted
 * read-only. See docs/stack-backup.md.
 *
 * One policy per stack, and "back up now" runs the policy — so a manual run and a
 * (Phase 4) scheduled run capture exactly the same thing, which is the only way a
 * manual test tells you anything about the scheduled backups.
 */
@Injectable()
export class StackBackupService {
  /** Policies with a run in flight — restic would lock anyway, but this fails fast. */
  private readonly active = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: ConnectorInstanceService,
    private readonly stacks: DockerStackService,
    private readonly targets: BackupTargetService,
    private readonly secretCapture: SecretCaptureService,
    private readonly logging: LoggingService,
  ) {}

  // ── Candidates ────────────────────────────────────────────────────

  /**
   * Every compose stack on every enabled Docker host, with what a backup would
   * capture. Foreign stacks (ones Cerebro never deployed) are included — they are
   * the bare-host case this feature exists for.
   */
  async candidates(): Promise<StackBackupCandidate[]> {
    const hosts = await this.prisma.connectorInstance.findMany({
      where: { connectorId: DOCKER, enabled: true },
      orderBy: { name: 'asc' },
    });
    const configured = await this.prisma.stackBackupPolicy.findMany({
      select: { connectorInstanceId: true, stackName: true },
    });
    const configuredKeys = new Set(configured.map((p) => `${p.connectorInstanceId}/${p.stackName}`));

    const out: StackBackupCandidate[] = [];
    for (const host of hosts) {
      let ctx: ConnectorContext;
      try {
        ctx = await this.instances.contextFor(host);
      } catch {
        continue;
      }
      const ssh = this.sshFrom(ctx);
      const managedNames = new Set((await this.stacks.list(host.id)).map((s) => s.name));

      let projects: string[];
      try {
        const api = this.apiFrom(ctx);
        const containers = await api.listContainers(true);
        projects = [...new Set(containers.map((c) => (c.Labels ?? {})[PROJECT_LABEL]).filter(Boolean))].sort();
      } catch (err) {
        void this.logging.warn('stack-backup', `Could not list stacks on "${host.name}": ${msg(err)}`);
        continue;
      }

      for (const project of projects) {
        out.push({
          connectorInstanceId: host.id,
          hostName: host.name,
          stackName: project,
          containers: 0,
          volumes: [],
          binds: [],
          managed: managedNames.has(project),
          configured: configuredKeys.has(`${host.id}/${project}`),
          backupable: !!ssh,
          reason: ssh ? undefined : 'This host has no SSH configured — a backup runs a helper container over SSH.',
        });
      }
    }
    return out;
  }

  /** The detail behind one candidate: what would actually be captured. Costs an inspect. */
  async inspectCandidate(instanceId: string, stackName: string): Promise<StackBackupCandidate> {
    const host = await this.hostOrThrow(instanceId);
    const ctx = await this.instances.contextFor(host);
    const ssh = this.sshFrom(ctx);
    const inspection = await inspectStack(this.apiFrom(ctx), stackName);
    const managed = !!(await this.stacks.get(instanceId, stackName));
    const policy = await this.prisma.stackBackupPolicy.findUnique({
      where: { connectorInstanceId_stackName: { connectorInstanceId: instanceId, stackName } },
    });
    return {
      connectorInstanceId: instanceId,
      hostName: host.name,
      stackName,
      containers: inspection.containers.length,
      volumes: inspection.volumes.map((v) => v.name),
      binds: inspection.binds,
      managed,
      configured: !!policy,
      backupable: !!ssh,
      reason: ssh ? undefined : 'This host has no SSH configured — a backup runs a helper container over SSH.',
    };
  }

  // ── Policies ──────────────────────────────────────────────────────

  async listPolicies(): Promise<StackBackupPolicy[]> {
    const rows = await this.prisma.stackBackupPolicy.findMany({
      orderBy: [{ stackName: 'asc' }],
      include: { target: { select: { name: true } } },
    });
    const hostNames = await this.hostNames();
    return rows.map((r) => this.policyDto(r, hostNames.get(r.connectorInstanceId), r.target.name));
  }

  async savePolicy(input: SaveBackupPolicyInput): Promise<StackBackupPolicy> {
    if (!input.connectorInstanceId || !input.stackName) throw new BadRequestException('A host and stack are required.');
    await this.hostOrThrow(input.connectorInstanceId);
    const target = await this.prisma.stackBackupTarget.findUnique({ where: { id: input.targetId } });
    if (!target) throw new BadRequestException('Choose a backup target.');

    const quiesce = (input.quiesce ?? 'hot') as QuiesceMode;
    if (quiesce !== 'hot') {
      throw new BadRequestException("Only the 'hot' capture mode is implemented — pause/stop arrive in a later phase.");
    }
    const transfer = (input.transfer ?? 'direct') as TransferMode;
    if (transfer !== 'direct') {
      throw new BadRequestException("Only 'direct' transfer is implemented — relay arrives in a later phase.");
    }
    const secretMode = (input.secretMode ?? 'embed') as SecretMode;
    if (secretMode === 'reference') {
      throw new BadRequestException("Vault-reference secrets arrive in a later phase — choose sealed or raw.");
    }

    const data = {
      targetId: input.targetId,
      enabled: input.enabled ?? true,
      frequency: input.frequency ?? 'off',
      dayOfWeek: clamp(input.dayOfWeek ?? 0, 0, 6),
      dayOfMonth: clamp(input.dayOfMonth ?? 1, 1, 28),
      hour: clamp(input.hour ?? 3, 0, 23),
      minute: clamp(input.minute ?? 0, 0, 59),
      quiesce,
      transfer,
      secretMode,
      includeBinds: (input.includeBinds ?? []).filter((p) => p.startsWith('/')),
      excludes: (input.excludes ?? []).filter(Boolean),
    };
    const row = await this.prisma.stackBackupPolicy.upsert({
      where: {
        connectorInstanceId_stackName: {
          connectorInstanceId: input.connectorInstanceId,
          stackName: input.stackName,
        },
      },
      update: data,
      create: { connectorInstanceId: input.connectorInstanceId, stackName: input.stackName, ...data },
      include: { target: { select: { name: true } } },
    });
    const hostNames = await this.hostNames();
    return this.policyDto(row, hostNames.get(row.connectorInstanceId), row.target.name);
  }

  async removePolicy(id: string): Promise<void> {
    await this.prisma.stackBackupPolicy.delete({ where: { id } }).catch(() => {
      throw new NotFoundException('Stack backup not found.');
    });
  }

  // ── Runs ──────────────────────────────────────────────────────────

  async listRuns(policyId?: string, limit = 50): Promise<StackBackupRun[]> {
    const rows = await this.prisma.stackBackupRun.findMany({
      where: policyId ? { policyId } : undefined,
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    const hostNames = await this.hostNames();
    return rows.map((r) => this.runDto(r, hostNames.get(r.connectorInstanceId)));
  }

  async getRun(id: string): Promise<StackBackupRun> {
    const row = await this.prisma.stackBackupRun.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Backup run not found.');
    const hostNames = await this.hostNames();
    return { ...this.runDto(row, hostNames.get(row.connectorInstanceId)), log: row.log };
  }

  /**
   * Run a policy's backup now. Returns as soon as the run row exists; the work
   * continues in the background and the UI follows the run's status.
   */
  async startBackup(policyId: string, passphrase: string | undefined, trigger: 'manual' | 'schedule'): Promise<StackBackupRun> {
    const policy = await this.prisma.stackBackupPolicy.findUnique({ where: { id: policyId } });
    if (!policy) throw new NotFoundException('Stack backup not found.');
    if (this.active.has(policyId)) throw new BadRequestException('A backup for this stack is already running.');
    if (policy.secretMode === 'embed' && !passphrase) {
      throw new BadRequestException('This backup seals its secrets — supply the passphrase to continue.');
    }

    const run = await this.prisma.stackBackupRun.create({
      data: {
        policyId: policy.id,
        connectorInstanceId: policy.connectorInstanceId,
        stackName: policy.stackName,
        targetId: policy.targetId,
        trigger,
        status: 'running',
      },
    });
    this.active.add(policyId);
    void this.execute(run.id, policy.id, passphrase).finally(() => this.active.delete(policyId));

    const hostNames = await this.hostNames();
    return this.runDto(run, hostNames.get(run.connectorInstanceId));
  }

  /** The actual capture. Everything that can fail is funnelled into the run row. */
  private async execute(runId: string, policyId: string, passphrase?: string): Promise<void> {
    const started = Date.now();
    const log: string[] = [];
    const say = (line: string) => log.push(`${new Date().toISOString()}  ${line}`);

    let hostDir: string | null = null;
    let ssh: SshConfig | null = null;
    try {
      const policy = await this.prisma.stackBackupPolicy.findUniqueOrThrow({ where: { id: policyId } });
      const host = await this.hostOrThrow(policy.connectorInstanceId);
      const ctx = await this.instances.contextFor(host);
      ssh = this.sshFrom(ctx);
      if (!ssh) {
        throw new Error('This host has no SSH configured — a backup runs a helper container over SSH. Add SSH to the Docker connector.');
      }
      say(`Backing up stack "${policy.stackName}" on ${host.name}.`);

      const inspection = await inspectStack(this.apiFrom(ctx), policy.stackName);
      say(`Found ${inspection.containers.length} container(s), ${inspection.volumes.length} named volume(s), ${inspection.binds.length} bind path(s).`);

      const { compose, envFile, composeSource } = await this.resolveCompose(policy.connectorInstanceId, policy.stackName, inspection, ssh);
      say(compose ? `Compose file read from ${composeSource}.` : 'No compose file could be read — capturing the manifest only.');

      const captured = await this.secretCapture.capture({
        instanceId: policy.connectorInstanceId,
        stackName: policy.stackName,
        inspection,
        secretMode: policy.secretMode as SecretMode,
        envFile,
        passphrase,
      });
      const bound = captured.inventory.bindings.length;
      say(
        `Secrets: ${policy.secretMode} mode, ${captured.inventory.variables.length} variable(s), ` +
        `${bound} with a known vault binding, ${captured.inventory.unbound.length} unbound.`,
      );

      const files: Record<string, string> = {
        'manifest.json': manifestOf(inspection, {
          host: host.name,
          connectorInstanceId: host.id,
          policyId: policy.id,
          runId,
          secretMode: policy.secretMode,
        }),
        ...captured.files,
      };
      if (compose) files['compose.yaml'] = compose;

      hostDir = `/var/tmp/cerebro-backup-${runId}`;
      await writeHostDir(ssh, hostDir, files);
      say(`Staged ${Object.keys(files).length} metadata file(s) on the host.`);

      const included = new Set(policy.includeBinds);
      const includedBinds = inspection.binds.filter((b) => included.has(b.path));
      const bindCount = includedBinds.length;
      const mounts: HelperMount[] = [
        ...inspection.volumes.map((v) => ({
          source: v.name,
          dest: `/data/volumes/${v.name}`,
          kind: 'volume' as const,
          readOnly: true,
        })),
        ...includedBinds.map((b) => ({
          source: b.path,
          dest: `/data/binds/${bindSlug(b.path)}`,
          kind: 'bind' as const,
          readOnly: true,
        })),
        { source: hostDir, dest: '/data/meta', kind: 'bind', readOnly: true },
      ];
      say(`Capture set: ${inspection.volumes.length} volume(s), ${bindCount} bind path(s).`);

      const auth = await this.targets.hostAuthFor(policy.targetId);
      const target = await this.prisma.stackBackupTarget.findUniqueOrThrow({ where: { id: policy.targetId } });
      const args = [
        'backup', '/data', '--json',
        '--host', sanitizeHost(host.name),
        '--tag', 'cerebro',
        '--tag', 'type:stack',
        '--tag', `host:${host.id}`,
        '--tag', `stack:${policy.stackName}`,
        '--tag', `policy:${policy.id}`,
        '--tag', `run:${runId}`,
        ...policy.excludes.flatMap((e) => ['--exclude', e]),
      ];
      say(`Running ${target.helperImage} on the host…`);

      const res = await runHelper({
        ssh,
        image: target.helperImage,
        env: resticEnv(auth),
        mounts,
        args,
        timeoutMs: BACKUP_TIMEOUT_MS,
      });
      if (res.stdout.trim()) log.push(res.stdout.trim());
      if (res.stderr.trim()) log.push(res.stderr.trim());

      const summary = parseBackupSummary(res.stdout);
      // restic exits 3 when the snapshot was written but some source files could not
      // be read (a permission-denied corner of a bind mount, a socket). That is a
      // warning about coverage, not a failed backup — record it as such rather than
      // throwing away a snapshot that exists.
      const warned = res.code === 3 && !!summary.snapshotId;
      if (res.code !== 0 && !warned) {
        const err = friendlyRestic({ stderr: res.stderr || res.stdout, message: `helper exited ${res.code}` });
        if (err.code === 'norepo') {
          throw new Error(`${err.message} Initialize the target repository first (Repositories → Initialize).`);
        }
        throw err;
      }

      const message = summary.snapshotId
        ? `Snapshot ${summary.snapshotId.slice(0, 8)} — ${fmtBytes(summary.bytesAdded)} added of ${fmtBytes(summary.bytesTotal)} processed.` +
          (warned ? ' Some files could not be read — see the log.' : '')
        : 'Backup completed.';
      say(message);

      await this.finish(runId, policyId, {
        status: 'success',
        message,
        snapshotId: summary.snapshotId ?? null,
        bytesAdded: summary.bytesAdded,
        bytesTotal: summary.bytesTotal,
        filesNew: summary.filesNew,
        filesTotal: summary.filesTotal,
        volumes: inspection.volumes.length,
        binds: bindCount,
        durationMs: Date.now() - started,
        log: log.join('\n'),
      });
      void this.logging.info('stack-backup', `[${host.name}/${policy.stackName}] ${message}`);
    } catch (err) {
      const message = msg(err);
      say(`Failed: ${message}`);
      await this.finish(runId, policyId, {
        status: 'error',
        message,
        durationMs: Date.now() - started,
        log: log.join('\n'),
      });
      void this.logging.error('stack-backup', `Backup run ${runId} failed: ${message}`);
    } finally {
      if (ssh && hostDir) await removeHostDir(ssh, hostDir);
    }
  }

  private async finish(
    runId: string,
    policyId: string,
    data: {
      status: string; message: string; snapshotId?: string | null; bytesAdded?: number; bytesTotal?: number;
      filesNew?: number; filesTotal?: number; volumes?: number; binds?: number; durationMs: number; log: string;
    },
  ): Promise<void> {
    await this.prisma.stackBackupRun.update({
      where: { id: runId },
      data: {
        status: data.status,
        message: data.message,
        snapshotId: data.snapshotId ?? null,
        bytesAdded: data.bytesAdded != null ? BigInt(Math.round(data.bytesAdded)) : null,
        bytesTotal: data.bytesTotal != null ? BigInt(Math.round(data.bytesTotal)) : null,
        filesNew: data.filesNew ?? null,
        filesTotal: data.filesTotal ?? null,
        volumes: data.volumes ?? 0,
        binds: data.binds ?? 0,
        durationMs: data.durationMs,
        log: data.log.slice(-MAX_LOG_CHARS),
        finishedAt: new Date(),
      },
    }).catch(() => { /* the run row may have been deleted mid-flight */ });
    await this.prisma.stackBackupPolicy.update({
      where: { id: policyId },
      data: { lastRunAt: new Date(), lastStatus: data.status, lastMessage: data.message },
    }).catch(() => { /* ditto */ });
  }

  // ── Helpers ───────────────────────────────────────────────────────

  /**
   * The stack's compose + `.env`. Cerebro's own copy wins when it manages the
   * stack; otherwise they are read off the host at the paths compose itself
   * recorded in the container labels — which is what makes foreign stacks work.
   */
  private async resolveCompose(
    instanceId: string,
    stackName: string,
    inspection: StackInspection,
    ssh: SshConfig,
  ): Promise<{ compose?: string; envFile?: string; composeSource: string }> {
    const managed = await this.stacks.get(instanceId, stackName);
    if (managed?.compose) {
      return { compose: managed.compose, envFile: managed.env ?? undefined, composeSource: "Cerebro's stored copy" };
    }

    const paths = (inspection.composePath ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    const parts: string[] = [];
    for (const path of paths) {
      if (!path.startsWith('/') || path.includes("'")) continue;
      const res = await runSsh(ssh, `cat '${path}'`).catch(() => null);
      if (res?.code === 0 && res.stdout) parts.push(`# ── ${path}\n${res.stdout}`);
    }

    let envFile: string | undefined;
    const dir = inspection.workingDir;
    if (dir && dir.startsWith('/') && !dir.includes("'")) {
      const res = await runSsh(ssh, `cat '${dir}/.env' 2>/dev/null || true`).catch(() => null);
      if (res?.code === 0 && res.stdout.trim()) envFile = res.stdout;
    }
    return {
      compose: parts.length ? parts.join('\n') : undefined,
      envFile,
      composeSource: paths.join(', ') || 'the host',
    };
  }

  private apiFrom(ctx: ConnectorContext): DockerApi {
    return new DockerApi({
      endpoint: str(ctx.config.endpoint),
      tlsCaCert: str(ctx.config.tlsCaCert),
      tlsClientCert: str(ctx.config.tlsClientCert),
      tlsClientKey: str(ctx.config.tlsClientKey),
      insecureSkipVerify: ctx.config.insecureSkipVerify === true,
    });
  }

  /** The host's SSH config with its key pinned, or null when SSH isn't configured. */
  private sshFrom(ctx: ConnectorContext): SshConfig | null {
    const host = str(ctx.config.sshHost);
    const privateKey = str(ctx.config.sshPrivateKey);
    const password = str(ctx.config.sshPassword);
    if (!host || (!privateKey && !password)) return null;
    const target = this.stacks.withHostPin({
      ssh: {
        host,
        port: Number(ctx.config.sshPort) || 22,
        username: str(ctx.config.sshUser) || 'root',
        privateKey,
        password,
      },
      stacksDir: str(ctx.config.stacksDir) || '/opt/cerebro-stacks',
    });
    return target.ssh;
  }

  private async hostOrThrow(id: string) {
    const host = await this.prisma.connectorInstance.findUnique({ where: { id } });
    if (!host || host.connectorId !== DOCKER) throw new BadRequestException('That Docker host no longer exists.');
    return host;
  }

  private async hostNames(): Promise<Map<string, string>> {
    const rows = await this.prisma.connectorInstance.findMany({
      where: { connectorId: DOCKER },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private policyDto(
    row: {
      id: string; connectorInstanceId: string; stackName: string; targetId: string; enabled: boolean;
      frequency: string; dayOfWeek: number; dayOfMonth: number; hour: number; minute: number;
      quiesce: string; transfer: string; secretMode: string; includeBinds: string[]; excludes: string[];
      lastRunAt: Date | null; lastStatus: string; lastMessage: string | null; createdAt: Date;
    },
    hostName?: string,
    targetName?: string,
  ): StackBackupPolicy {
    return {
      id: row.id,
      connectorInstanceId: row.connectorInstanceId,
      hostName,
      stackName: row.stackName,
      targetId: row.targetId,
      targetName,
      enabled: row.enabled,
      frequency: row.frequency as StackBackupPolicy['frequency'],
      dayOfWeek: row.dayOfWeek,
      dayOfMonth: row.dayOfMonth,
      hour: row.hour,
      minute: row.minute,
      quiesce: row.quiesce as QuiesceMode,
      transfer: row.transfer as TransferMode,
      secretMode: row.secretMode as SecretMode,
      includeBinds: row.includeBinds,
      excludes: row.excludes,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      lastStatus: row.lastStatus,
      lastMessage: row.lastMessage,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private runDto(
    row: {
      id: string; policyId: string | null; connectorInstanceId: string; stackName: string; targetId: string;
      trigger: string; status: string; snapshotId: string | null; bytesAdded: bigint | null; bytesTotal: bigint | null;
      filesNew: number | null; filesTotal: number | null; volumes: number; binds: number; durationMs: number | null;
      message: string | null; startedAt: Date; finishedAt: Date | null;
    },
    hostName?: string,
  ): StackBackupRun {
    return {
      id: row.id,
      policyId: row.policyId,
      connectorInstanceId: row.connectorInstanceId,
      hostName,
      stackName: row.stackName,
      targetId: row.targetId,
      trigger: row.trigger as 'manual' | 'schedule',
      status: row.status,
      snapshotId: row.snapshotId,
      bytesAdded: row.bytesAdded != null ? Number(row.bytesAdded) : null,
      bytesTotal: row.bytesTotal != null ? Number(row.bytesTotal) : null,
      filesNew: row.filesNew,
      filesTotal: row.filesTotal,
      volumes: row.volumes,
      binds: row.binds,
      durationMs: row.durationMs,
      message: row.message,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(Number(n) || 0)));
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** restic records a snapshot's hostname; keep it recognisable and shell-safe. */
function sanitizeHost(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'cerebro';
}

function fmtBytes(n?: number): string {
  if (n == null) return 'n/a';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
