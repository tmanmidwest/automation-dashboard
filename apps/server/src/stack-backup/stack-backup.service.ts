import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { SecretsService, type ActorCtx } from '../secrets/secrets.service';
import { CryptoService } from '../common/crypto.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { DockerStackService } from '../connectors/docker/docker-stack.service';
import { runSsh, type SshConfig } from '../connectors/docker/docker-ssh';
import { hostAccess, NO_SSH_REASON } from './docker-host';
import type { ConnectorContext } from '@cerebro/shared';
import type {
  BackupHost, BindingOrigin, BindSecretInput, QuiesceMode, SaveBackupPolicyInput, SecretMode,
  SecretUsage, StackBackupCandidate, StackBackupPolicy, StackBackupRun, StackHook,
  StackSecretsReport, StackSecretView, TransferMode,
} from '@cerebro/shared';
import { BackupTargetService } from './backup-target.service';
import { SecretCaptureService, detectFileSecrets, redactCompose } from './secret-capture';
import { bindSlug, inspectStack, manifestOf, type StackInspection } from './stack-inspect';
import { appendHostFiles, removeHostDir, runHelper, writeHostDir, type HelperMount } from './helper-runner';
import { friendlyRestic, parseBackupSummary, resticEnv, runResticLocalTolerant } from './restic-cli';
import { quiesceStack, runHooks, type Resume } from './quiesce';
import {
  estimateBytes, fmtBytes as fmtRelayBytes, freeBytes, planRelay, pullSource, relayRoot, resetStaging,
} from './relay';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeSchedule, isDue, nextRunAt, type BackupSchedule } from '../common/backup-schedule';

const DOCKER = 'docker';
const PROJECT_LABEL = 'com.docker.compose.project';
/** A backup of a large volume set is slow; cap it well above any plausible run. */
const BACKUP_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** Keep the stored run log bounded — restic is chatty on a first (non-incremental) run. */
const MAX_LOG_CHARS = 64 * 1024;

/** Shown wherever a host can only be reached by streaming through Cerebro. */
const RELAY_REQUIRED =
  'This host has no SSH, so it can only be backed up with relay transfer — Cerebro pulls the data through the Docker API and writes the snapshot itself. Dump hooks and compose capture need SSH and will be unavailable.';

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
  /** Relay stages to one stable directory (for dedup), so only one run may use it. */
  private relayBusy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: ConnectorInstanceService,
    private readonly stacks: DockerStackService,
    private readonly targets: BackupTargetService,
    private readonly secretCapture: SecretCaptureService,
    private readonly secrets: SecretsService,
    private readonly crypto: CryptoService,
    private readonly notifications: NotificationsService,
    private readonly logging: LoggingService,
  ) {}

  /**
   * Where a policy's sealing passphrase lives. A scheduled sealed backup has no
   * operator to prompt, so the passphrase has to be stored — which does mean a
   * sealed backup is only as recoverable-without-Cerebro as the operator's own
   * copy of it. The UI says so at the point of entry.
   */
  private sealKey(policyId: string): string {
    return `stack-backup:policy:${policyId}:passphrase`;
  }

  /** The schedule as the scheduler and the UI both read it. */
  scheduleOf(row: { frequency: string; dayOfWeek: number; dayOfMonth: number; hour: number; minute: number }): BackupSchedule {
    return {
      frequency: row.frequency as BackupSchedule['frequency'],
      dayOfWeek: row.dayOfWeek,
      dayOfMonth: row.dayOfMonth,
      hour: row.hour,
      minute: row.minute,
    };
  }

  /** Policies whose schedule matches this minute. */
  async duePolicies(now: Date) {
    const rows = await this.prisma.stackBackupPolicy.findMany({ where: { enabled: true, frequency: { not: 'off' } } });
    return rows.filter((r) => isDue(this.scheduleOf(r), now));
  }

  /**
   * Every Docker host, with whether it can take part in a backup or restore. A
   * plain DB read plus a config check — no fan-out — so a picker never waits on
   * unreachable hosts.
   */
  async hosts(): Promise<BackupHost[]> {
    const rows = await this.prisma.connectorInstance.findMany({
      where: { connectorId: DOCKER },
      orderBy: { name: 'asc' },
    });
    const out: BackupHost[] = [];
    for (const row of rows) {
      let backupable = false;
      try {
        backupable = !!hostAccess(await this.instances.contextFor(row), this.stacks).ssh;
      } catch {
        backupable = false;
      }
      out.push({ id: row.id, name: row.name, enabled: row.enabled, backupable });
    }
    return out;
  }

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
      const { api, ssh } = hostAccess(ctx, this.stacks);
      const managedNames = new Set((await this.stacks.list(host.id)).map((s) => s.name));

      let projects: string[];
      try {
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
          backupable: true,
          requiresRelay: !ssh,
          reason: ssh ? undefined : RELAY_REQUIRED,
        });
      }
    }
    return out;
  }

  /** The detail behind one candidate: what would actually be captured. Costs an inspect. */
  async inspectCandidate(instanceId: string, stackName: string): Promise<StackBackupCandidate> {
    const host = await this.hostOrThrow(instanceId);
    const ctx = await this.instances.contextFor(host);
    const { api, ssh } = hostAccess(ctx, this.stacks);
    const inspection = await inspectStack(api, stackName);
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
      backupable: true,
      requiresRelay: !ssh,
      reason: ssh ? undefined : RELAY_REQUIRED,
    };
  }

  // ── Policies ──────────────────────────────────────────────────────

  async listPolicies(): Promise<StackBackupPolicy[]> {
    const rows = await this.prisma.stackBackupPolicy.findMany({
      orderBy: [{ stackName: 'asc' }],
      include: { target: { select: { name: true } } },
    });
    const hostNames = await this.hostNames();
    return Promise.all(
      rows.map(async (r) =>
        this.policyDto(r, hostNames.get(r.connectorInstanceId), r.target.name, await this.secrets.has(this.sealKey(r.id))),
      ),
    );
  }

  async savePolicy(input: SaveBackupPolicyInput): Promise<StackBackupPolicy> {
    if (!input.connectorInstanceId || !input.stackName) throw new BadRequestException('A host and stack are required.');
    await this.hostOrThrow(input.connectorInstanceId);
    const target = await this.prisma.stackBackupTarget.findUnique({ where: { id: input.targetId } });
    if (!target) throw new BadRequestException('Choose a backup target.');

    const quiesce = (input.quiesce ?? 'hot') as QuiesceMode;
    if (!['hot', 'pause', 'stop'].includes(quiesce)) throw new BadRequestException('Unknown capture mode.');
    const transfer = (input.transfer ?? 'direct') as TransferMode;
    if (!['direct', 'relay'].includes(transfer)) throw new BadRequestException('Unknown transfer mode.');
    const secretMode = (input.secretMode ?? 'embed') as SecretMode;
    if (!['embed', 'raw', 'reference'].includes(secretMode)) {
      throw new BadRequestException('Unknown secret mode.');
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
      preHooks: validateHooks(input.preHooks) as unknown as Prisma.InputJsonValue,
      postHooks: validateHooks(input.postHooks) as unknown as Prisma.InputJsonValue,
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

    // The passphrase is keyed by the policy id, so it can only be written once the
    // row exists. An empty string clears it; undefined leaves it alone.
    if (input.sealPassphrase != null) {
      if (input.sealPassphrase) {
        await this.secrets.set(this.sealKey(row.id), input.sealPassphrase, {
          label: `Stack backup sealing passphrase — ${row.stackName}`,
          description: 'Seals this stack\'s secrets on every backup run, including scheduled ones.',
          category: 'manual',
        });
      } else {
        await this.secrets.remove(this.sealKey(row.id)).catch(() => { /* may not exist */ });
      }
    }

    // A sealed backup cannot run unattended without a stored passphrase, so refuse
    // to leave a schedule armed that would fail every night at 03:00.
    const hasSeal = await this.secrets.has(this.sealKey(row.id));
    if (data.frequency !== 'off' && data.secretMode === 'embed' && !hasSeal) {
      await this.prisma.stackBackupPolicy.update({ where: { id: row.id }, data: { frequency: 'off' } });
      throw new BadRequestException(
        'A scheduled sealed backup needs a stored sealing passphrase — set one, or switch this stack to raw secrets.',
      );
    }

    const hostNames = await this.hostNames();
    return this.policyDto(row, hostNames.get(row.connectorInstanceId), row.target.name, hasSeal);
  }

  async removePolicy(id: string): Promise<void> {
    await this.prisma.stackBackupPolicy.delete({ where: { id } }).catch(() => {
      throw new NotFoundException('Stack backup not found.');
    });
    await this.secrets.remove(this.sealKey(id)).catch(() => { /* may not exist */ });
  }

  /** The configured repositories — exposed here so the shared tool catalog has one
   *  service to talk to for everything stack-backup. */
  listTargets() {
    return this.targets.list();
  }

  // ── Secret bindings (Phase 2) ─────────────────────────────────────

  /**
   * What the vault knows about one stack's credentials, live off the host. This
   * is the answer to "has our vault been used here?" for a stack Cerebro never
   * deployed — matched by keyed digest, so no plaintext is compared and no
   * secret is marked as used just because we looked.
   */
  async secretsReport(instanceId: string, stackName: string): Promise<StackSecretsReport> {
    const host = await this.hostOrThrow(instanceId);
    const ctx = await this.instances.contextFor(host);
    const { api, ssh } = hostAccess(ctx, this.stacks);
    const inspection = await inspectStack(api, stackName);

    const vars = await this.secretCapture.discover(instanceId, stackName, inspection);
    await this.secretCapture.persist(instanceId, stackName, vars);

    // Resolve each binding against the vault as it stands right now.
    const variables: StackSecretView[] = [];
    for (const v of vars) {
      let state: StackSecretView['state'] = 'unbound';
      if (v.vaultKey) {
        const current = await this.secrets.reveal(v.vaultKey).catch(() => null);
        state = current == null
          ? 'missing'
          : !v.digest || this.crypto.valueDigest(current) === v.digest
            ? 'bound'
            : 'drifted';
      }
      variables.push({
        name: v.name,
        containers: v.containers,
        secretish: v.secretish,
        vaultKey: v.vaultKey ?? null,
        origin: v.origin ?? null,
        state,
      });
    }

    const { compose } = ssh
      ? await this.resolveCompose(instanceId, stackName, inspection, ssh)
      : { compose: undefined };
    const { names: inlineComposeSecrets } = redactCompose(compose);
    const fileSecrets = detectFileSecrets(compose, vars).map((f) => f.label);
    const unbound = vars.filter((v) => v.secretish && !v.vaultKey).map((v) => v.name);

    const blocked = unbound.length
      ? `${unbound.length} credential(s) are not in the vault: ${unbound.join(', ')}.`
      : inlineComposeSecrets.length
        ? `${inlineComposeSecrets.length} credential(s) are written literally in the compose file: ${inlineComposeSecrets.join(', ')}.`
        : undefined;

    return {
      connectorInstanceId: instanceId,
      stackName,
      variables,
      unbound,
      inlineComposeSecrets,
      fileSecrets,
      referenceReady: !blocked,
      referenceBlockedBy: blocked,
    };
  }

  /**
   * Bind a variable to a vault key, optionally **promoting** its live value into
   * the vault on the way. Promotion is the migration path from "a password
   * somebody typed into an .env on a bare host" to "a credential Cerebro can
   * re-materialize on restore".
   */
  async bindSecret(instanceId: string, stackName: string, input: BindSecretInput, actor?: ActorCtx): Promise<StackSecretsReport> {
    const varName = input.varName?.trim();
    if (!varName) throw new BadRequestException('A variable name is required.');

    let vaultKey = input.vaultKey?.trim();
    if (input.promote) {
      const host = await this.hostOrThrow(instanceId);
      const ctx = await this.instances.contextFor(host);
      const inspection = await inspectStack(hostAccess(ctx, this.stacks).api, stackName);
      const value = inspection.containers.map((c) => c.env[varName]).find((v) => v != null);
      if (value == null || value === '') {
        throw new BadRequestException(`"${varName}" has no value on the running stack, so there is nothing to promote.`);
      }
      vaultKey = vaultKey || `stack:${stackName}:${varName.toLowerCase()}`;
      await this.secrets.set(vaultKey, value, {
        label: `${stackName} — ${varName}`,
        description: `Promoted from the running "${stackName}" stack so backups can reference it instead of storing it.`,
        category: 'manual',
      }, actor);
    }

    if (!vaultKey) throw new BadRequestException('Choose a vault key, or promote the live value into a new one.');
    if (!(await this.secrets.has(vaultKey))) {
      throw new BadRequestException(`There is no vault entry "${vaultKey}".`);
    }

    const data = { vaultKey, origin: 'declared', lastSeenAt: new Date() };
    await this.prisma.stackSecretBinding.upsert({
      where: { connectorInstanceId_stackName_varName: { connectorInstanceId: instanceId, stackName, varName } },
      update: data,
      create: { connectorInstanceId: instanceId, stackName, varName, secretish: true, ...data },
    });
    return this.secretsReport(instanceId, stackName);
  }

  /** Drop an operator's declaration, falling back to whatever discovery finds. */
  async unbindSecret(instanceId: string, stackName: string, varName: string): Promise<StackSecretsReport> {
    await this.prisma.stackSecretBinding.deleteMany({
      where: { connectorInstanceId: instanceId, stackName, varName, origin: 'declared' },
    });
    return this.secretsReport(instanceId, stackName);
  }

  /**
   * The vault's reverse index: which stacks reference each key. Turns "can I
   * delete this secret?" from a guess into a lookup.
   */
  async secretUsage(): Promise<SecretUsage[]> {
    const rows = await this.prisma.stackSecretBinding.findMany({
      where: { vaultKey: { not: null } },
      orderBy: [{ vaultKey: 'asc' }, { stackName: 'asc' }],
    });
    const hostNames = await this.hostNames();
    const byKey = new Map<string, SecretUsage>();
    for (const r of rows) {
      const key = r.vaultKey!;
      const entry = byKey.get(key) ?? { vaultKey: key, uses: [] };
      entry.uses.push({
        connectorInstanceId: r.connectorInstanceId,
        hostName: hostNames.get(r.connectorInstanceId),
        stackName: r.stackName,
        varName: r.varName,
        origin: r.origin as BindingOrigin,
      });
      byKey.set(key, entry);
    }
    return [...byKey.values()];
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

    // A stored passphrase is what lets the scheduler seal unattended; a manual run
    // uses it too rather than asking again for something Cerebro already holds.
    let seal = passphrase;
    if (policy.secretMode === 'embed' && !seal) {
      seal = (await this.secrets.reveal(this.sealKey(policy.id))) ?? undefined;
    }
    if (policy.secretMode === 'embed' && !seal) {
      throw new BadRequestException('This backup seals its secrets — supply the passphrase, or store one on the policy.');
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
    void this.execute(run.id, policy.id, seal).finally(() => this.active.delete(policyId));

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
    let useRelay = false;
    let stagedRoot: string | null = null;
    try {
      const policy = await this.prisma.stackBackupPolicy.findUniqueOrThrow({ where: { id: policyId } });
      const host = await this.hostOrThrow(policy.connectorInstanceId);
      const ctx = await this.instances.contextFor(host);
      const access = hostAccess(ctx, this.stacks);
      ssh = access.ssh;
      useRelay = policy.transfer === 'relay';
      if (!useRelay && !ssh) {
        throw new Error(`${NO_SSH_REASON} Or switch this backup to relay transfer, which streams the data through Cerebro instead.`);
      }
      say(`Backing up stack "${policy.stackName}" on ${host.name} (${useRelay ? 'relay' : 'direct'} transfer).`);

      const inspection = await inspectStack(access.api, policy.stackName);
      say(`Found ${inspection.containers.length} container(s), ${inspection.volumes.length} named volume(s), ${inspection.binds.length} bind path(s).`);

      const { compose, envFile, composeSource } = await this.resolveCompose(policy.connectorInstanceId, policy.stackName, inspection, ssh);
      say(compose ? `Compose file read from ${composeSource}.` : 'No compose file could be read — capturing the manifest only.');

      const captured = await this.secretCapture.capture({
        instanceId: policy.connectorInstanceId,
        stackName: policy.stackName,
        inspection,
        secretMode: policy.secretMode as SecretMode,
        envFile,
        compose,
        passphrase,
        // Credential files are read through a shell, so a relay host cannot supply them.
        readHostFile: ssh ? (path) => readHostFile(ssh!, path, inspection) : undefined,
      });
      const bound = captured.inventory.bindings.length;
      say(
        `Secrets: ${policy.secretMode} mode, ${captured.inventory.variables.length} variable(s), ` +
        `${bound} bound to the vault, ${captured.inventory.unbound.length} unbound.`,
      );
      if (captured.inventory.inlineComposeSecrets?.length) {
        say(`Lifted ${captured.inventory.inlineComposeSecrets.length} literal credential(s) out of the compose file: ${captured.inventory.inlineComposeSecrets.join(', ')}.`);
      }
      if (captured.inventory.fileSecrets?.length) {
        say(`NOT captured — these credentials live in host files outside the stack: ${captured.inventory.fileSecrets.join(', ')}.`);
      }

      // Decide the capture set before writing the manifest: a restore must know
      // which of the stack's bind paths this snapshot actually contains, and the
      // policy that decided may have changed (or be gone) by then.
      const included = new Set(policy.includeBinds);
      const includedBinds = inspection.binds.filter((b) => included.has(b.path));
      const bindCount = includedBinds.length;

      // restic records absolute paths, and relay stages somewhere else entirely —
      // so the snapshot says where its tree is rooted and restore reads it back.
      const captureRoot = policy.transfer === 'relay' ? relayRoot() : '/data';
      const files: Record<string, string> = {
        'manifest.json': manifestOf(inspection, {
          host: host.name,
          connectorInstanceId: host.id,
          policyId: policy.id,
          runId,
          secretMode: policy.secretMode,
          capture: {
            root: captureRoot,
            transfer: policy.transfer,
            volumes: inspection.volumes.map((v) => v.name),
            binds: includedBinds.map((b) => b.path),
            hasCompose: !!compose,
            hasEnv: !!envFile,
          },
        }),
        ...captured.files,
      };
      // The redacted copy when the mode calls for it; identical to `compose` in raw mode.
      const composeToStore = captured.compose ?? compose;
      if (composeToStore) files['compose.yaml'] = composeToStore;

      const preHooks = hookList(policy.preHooks);
      if (useRelay && preHooks.length) {
        // Silently skipping a pg_dump would ship a snapshot that looks complete
        // and isn't, so this is an error rather than a warning.
        throw new Error('Dump hooks run over SSH, which a relay backup does not have. Remove the hooks, or give this host SSH and use direct transfer.');
      }

      const target = await this.prisma.stackBackupTarget.findUniqueOrThrow({ where: { id: policy.targetId } });
      const tags = [
        '--tag', 'cerebro',
        '--tag', 'type:stack',
        '--tag', `host:${host.id}`,
        '--tag', `stack:${policy.stackName}`,
        '--tag', `policy:${policy.id}`,
        '--tag', `run:${runId}`,
        ...policy.excludes.flatMap((e) => ['--exclude', e]),
      ];
      const quiesce = policy.quiesce as QuiesceMode;
      let res: { code: number; stdout: string; stderr: string };

      if (useRelay) {
        // ── Relay: Cerebro pulls the data and runs restic itself ──
        if (this.relayBusy) {
          throw new Error('Another relay backup is using the staging area. Relay runs are serialized because they share one staging directory.');
        }
        this.relayBusy = true;
        try {
          const root = captureRoot;
          const relay = planRelay(inspection, inspection.volumes.map((v) => v.name), includedBinds.map((b) => b.path));
          if (relay.unreachable.length) {
            // No container mounts it, so there is nothing to read it through.
            say(`WARNING: not reachable in relay mode (no container mounts them): ${relay.unreachable.join(', ')}.`);
          }

          const estimate = await estimateBytes(access.api, inspection.volumes.map((v) => v.name));
          const free = await freeBytes(root);
          if (estimate != null && free != null && free < estimate * 1.1) {
            throw new Error(
              `Relay needs about ${fmtRelayBytes(estimate)} of staging space on Cerebro but only ${fmtRelayBytes(free)} is free. ` +
              'Free some space, point STACK_BACKUP_RELAY_DIR at a larger volume, or use direct transfer.',
            );
          }
          say(`Staging locally at ${root}${estimate != null ? ` (about ${fmtRelayBytes(estimate)})` : ''}.`);

          await resetStaging(root);
          stagedRoot = root;
          for (const [name, content] of Object.entries(files)) {
            await writeFile(join(root, 'meta', name), content, { mode: 0o600 });
          }

          let resume: Resume | null = null;
          if (quiesce !== 'hot') resume = await quiesceStack(access.api, inspection, quiesce, say);
          try {
            for (const source of relay.sources) {
              say(`Pulling ${source.kind} ${source.name} through ${source.containerName}…`);
              await pullSource(access.api, source, root);
            }
          } finally {
            if (resume) await resume();
          }
          say(`Pulled ${relay.sources.length} source(s); running restic on Cerebro…`);

          const auth = await this.targets.authFor(policy.targetId);
          res = await runResticLocalTolerant(
            auth,
            ['backup', root, '--json', '--host', sanitizeHost(host.name), ...tags],
            BACKUP_TIMEOUT_MS,
          );
        } finally {
          this.relayBusy = false;
        }
      } else {
        // ── Direct: a helper container on the host talks to the repository ──
        hostDir = `/var/tmp/cerebro-backup-${runId}`;
        await writeHostDir(ssh!, hostDir, files);
        say(`Staged ${Object.keys(files).length} metadata file(s) on the host.`);

        // Pre-hooks run while the stack is still up — a dump needs a live database —
        // and anything they capture joins the metadata already staged.
        if (preHooks.length) {
          const { files: hookFiles } = await runHooks(ssh!, inspection, preHooks, 'pre', say);
          if (Object.keys(hookFiles).length) await appendHostFiles(ssh!, hostDir, hookFiles);
        }

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
        // Freeze the stack for the capture window only: everything expensive
        // (inspecting, resolving compose, dumping) has already happened, so a
        // `stop` policy's downtime is the restic run and nothing more.
        let resume: Resume | null = null;
        if (quiesce !== 'hot') resume = await quiesceStack(access.api, inspection, quiesce, say);

        say(`Running ${target.helperImage} on the host…`);
        try {
          res = await runHelper({
            ssh: ssh!,
            image: target.helperImage,
            env: resticEnv(auth),
            mounts,
            args: ['backup', '/data', '--json', '--host', sanitizeHost(host.name), ...tags],
            timeoutMs: BACKUP_TIMEOUT_MS,
          });
        } finally {
          // A stack left paused or stopped by a failed backup is a far worse
          // outcome than the failed backup itself.
          if (resume) await resume();
        }

        const postHooks = hookList(policy.postHooks);
        if (postHooks.length) await runHooks(ssh!, inspection, postHooks, 'post', say).catch((err) => {
          say(`WARNING: post-hooks failed: ${msg(err)}`);
          return { files: {} };
        });
      }

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
      // Staged data is a full copy of the stack — never leave it lying around.
      if (stagedRoot) await rm(stagedRoot, { recursive: true, force: true }).catch(() => { /* best-effort */ });
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
    const policy = await this.prisma.stackBackupPolicy.update({
      where: { id: policyId },
      data: { lastRunAt: new Date(), lastStatus: data.status, lastMessage: data.message },
    }).catch(() => null);

    // Alerting lives here rather than at each call site, so a scheduled run and a
    // manual one notify identically.
    const where = policy ? `${policy.stackName}` : 'a stack';
    await this.notifications.dispatchAlert(
      data.status === 'success' ? 'backup.success' : 'backup.failure',
      {
        title: data.status === 'success' ? `Stack backup succeeded: ${where}` : `Stack backup FAILED: ${where}`,
        body: data.message,
        dedupeKey: `stack-backup:${policyId}:${data.status}`,
        connectorId: policy?.connectorInstanceId,
      },
    ).catch(() => { /* a notification failure must never fail the run */ });
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
    ssh: SshConfig | null,
  ): Promise<{ compose?: string; envFile?: string; composeSource: string }> {
    const managed = await this.stacks.get(instanceId, stackName);
    if (managed?.compose) {
      return { compose: managed.compose, envFile: managed.env ?? undefined, composeSource: "Cerebro's stored copy" };
    }
    // Reading the host's own copy needs a shell. Without one (a relay host) an
    // unmanaged stack can only contribute its manifest.
    if (!ssh) return { composeSource: 'unavailable without SSH' };

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
      preHooks: unknown; postHooks: unknown; lastRunAt: Date | null; lastStatus: string; lastMessage: string | null; createdAt: Date;
    },
    hostName?: string,
    targetName?: string,
    hasSealPassphrase = false,
  ): StackBackupPolicy {
    const schedule = this.scheduleOf(row);
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
      preHooks: hookList(row.preHooks),
      postHooks: hookList(row.postHooks),
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      lastStatus: row.lastStatus,
      lastMessage: row.lastMessage,
      hasSealPassphrase,
      nextRunAt: row.enabled ? (nextRunAt(schedule)?.toISOString() ?? null) : null,
      scheduleText: row.enabled ? describeSchedule(schedule) : 'disabled',
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

/** Hooks are stored as JSON; read them back defensively. */
function hookList(raw: unknown): StackHook[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((h): h is StackHook => !!h && typeof h === 'object' && typeof (h as StackHook).cmd === 'string')
    .map((h) => ({
      service: h.service || undefined,
      container: h.container || undefined,
      cmd: h.cmd,
      captureTo: h.captureTo || undefined,
    }));
}

/** Reject a hook that could never run, at save time rather than at 03:00. */
function validateHooks(raw: StackHook[] | undefined): StackHook[] {
  const hooks = hookList(raw);
  for (const h of hooks) {
    if (!h.service && !h.container) {
      throw new BadRequestException(`Hook "${h.cmd}" needs a service or container to run in.`);
    }
    if (h.captureTo && !/^[A-Za-z0-9._-]+$/.test(h.captureTo)) {
      throw new BadRequestException(`Hook captureTo must be a plain filename, got "${h.captureTo}".`);
    }
  }
  return hooks;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(Number(n) || 0)));
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read a credential file for the capture. A compose `secrets:` path is on the
 * host; a `*_FILE` path is inside the container, so it is read through `docker
 * exec` in whichever container declares it. Returns null when unreadable —
 * a missing credential file is reported, never fatal.
 */
async function readHostFile(ssh: SshConfig, path: string, inspection: StackInspection): Promise<string | null> {
  if (!path.startsWith('/') || path.includes("'")) return null;

  const owner = inspection.containers.find((c) => Object.values(c.env).includes(path));
  const cmd = owner
    ? `docker exec '${owner.name}' cat '${path}' 2>/dev/null`
    : `cat '${path}' 2>/dev/null`;
  const res = await runSsh(ssh, cmd).catch(() => null);
  return res && res.code === 0 && res.stdout ? res.stdout : null;
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
