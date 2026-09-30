import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { SecretsService } from '../secrets/secrets.service';
import { CryptoService } from '../common/crypto.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { DockerStackService } from '../connectors/docker/docker-stack.service';
import { openBundle } from '../system-backup/bundle';
import type {
  ExecuteRestoreInput, RestoreBindPlan, RestoreMode, RestorePlan, RestorePlanInput, RestoreSecret,
  RestoreVolumePlan, SecretMode, SnapshotEntry, StackRestoreRun, StackSnapshot,
} from '@cerebro/shared';
import { BackupTargetService } from './backup-target.service';
import type { SecretInventory, SecretPayload } from './secret-capture';
import { bindSlug } from './stack-inspect';
import { hostAccess, NO_SSH_REASON } from './docker-host';
import { runHelper, type HelperMount } from './helper-runner';
import {
  decodeTags, dumpFile, listFiles, listSnapshots, resticEnv, type ResticRepoAuth,
} from './restic-cli';

const DOCKER = 'docker';
const META = '/data/meta';
const RESTORE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_LOG_CHARS = 64 * 1024;

/** What a snapshot's manifest.json carries that a restore needs. */
interface Manifest {
  project?: string;
  host?: string;
  connectorInstanceId?: string;
  secretMode?: SecretMode;
  volumes?: { name: string; driver?: string; options?: Record<string, string> | null; labels?: Record<string, string> | null }[];
  capture?: { volumes?: string[]; binds?: string[]; hasCompose?: boolean; hasEnv?: boolean };
}

/**
 * Restoring a stack: read a snapshot's metadata from the server, show the operator
 * exactly what would be written where, then write it — volumes first, then the
 * configuration, then optionally bring the stack up.
 *
 * Planning never touches the destination beyond read-only checks, and nothing is
 * written until the plan is executed. See docs/stack-backup.md.
 */
@Injectable()
export class StackRestoreService {
  private readonly active = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: ConnectorInstanceService,
    private readonly stacks: DockerStackService,
    private readonly targets: BackupTargetService,
    private readonly secrets: SecretsService,
    private readonly crypto: CryptoService,
    private readonly logging: LoggingService,
  ) {}

  // ── Browsing ──────────────────────────────────────────────────────

  async listSnapshots(targetId: string, stackName?: string, hostId?: string): Promise<StackSnapshot[]> {
    const auth = await this.targets.authFor(targetId);
    const snaps = await listSnapshots(auth, { stackName, hostId });
    const hostNames = await this.hostNames();
    return snaps.map((s) => {
      const t = decodeTags(s.tags);
      return {
        id: s.id,
        shortId: s.shortId,
        time: s.time,
        hostname: s.hostname,
        stackName: t.stackName,
        hostId: t.hostId,
        hostLabel: t.hostId ? hostNames.get(t.hostId) : undefined,
        policyId: t.policyId,
        runId: t.runId,
      };
    });
  }

  /** Browse a snapshot's contents, so an operator can confirm the data is really in there. */
  async browse(targetId: string, snapshotId: string, subtree?: string): Promise<SnapshotEntry[]> {
    const auth = await this.targets.authFor(targetId);
    const path = subtree && subtree.startsWith('/data') ? subtree : '/data';
    const entries = await listFiles(auth, snapshotId, path);
    // One level below the requested subtree — a full recursive listing of a volume
    // is unreadable and can be enormous.
    const depth = path.split('/').filter(Boolean).length;
    return entries
      .filter((e) => e.path.split('/').filter(Boolean).length === depth + 1)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── Planning ──────────────────────────────────────────────────────

  async plan(input: RestorePlanInput): Promise<RestorePlan> {
    const auth = await this.targets.authFor(input.targetId);
    const snapshot = await this.findSnapshot(input.targetId, input.snapshotId);

    const meta = await listFiles(auth, snapshot.id, META).catch(() => []);
    const has = (name: string) => meta.some((e) => e.path === `${META}/${name}`);
    if (!has('manifest.json')) {
      throw new BadRequestException('That snapshot has no manifest — it was not written by a Cerebro stack backup.');
    }

    const manifest = JSON.parse(await dumpFile(auth, snapshot.id, `${META}/manifest.json`)) as Manifest;
    const inventory = has('secrets.json')
      ? (JSON.parse(await dumpFile(auth, snapshot.id, `${META}/secrets.json`)) as SecretInventory)
      : null;

    const sourceStackName = manifest.project ?? snapshot.stackName ?? 'unknown';
    const destStackName = projectName(input.destStackName || sourceStackName);
    const host = await this.hostOrThrow(input.destInstanceId);
    const ctx = await this.instances.contextFor(host);
    const { api, ssh } = hostAccess(ctx, this.stacks);

    const conflicts: string[] = [];
    const warnings: string[] = [];
    if (!ssh) conflicts.push(NO_SSH_REASON);

    // Volumes. Compose derives a volume's name from the project, so a renamed
    // restore must rename the volumes too — otherwise the new stack comes up
    // pointing at freshly created empty volumes while the restored data sits in
    // the old names, which looks like the restore silently did nothing.
    const renaming = destStackName !== sourceStackName;
    const captured = manifest.capture?.volumes ?? (manifest.volumes ?? []).map((v) => v.name);
    const volumes: RestoreVolumePlan[] = [];
    for (const name of captured) {
      const info = (manifest.volumes ?? []).find((v) => v.name === name);
      const prefix = `${sourceStackName}_`;
      const renamed = renaming && name.startsWith(prefix);
      const dest = renamed ? `${destStackName}_${name.slice(prefix.length)}` : name;
      let exists = false;
      try {
        exists = await api.volumeExists(dest);
      } catch {
        warnings.push(`Could not check whether volume "${dest}" already exists on ${host.name}.`);
      }
      volumes.push({ source: name, dest, exists, driver: info?.driver, renamed });
      if (renaming && !renamed) {
        warnings.push(`Volume "${name}" is not named after the source stack, so it keeps its name — the restored stack will share it with the original.`);
      }
    }
    const existing = volumes.filter((v) => v.exists).map((v) => v.dest);
    if (existing.length) {
      conflicts.push(`These volumes already exist on ${host.name} and would be written into: ${existing.join(', ')}.`);
    }

    // Binds restore to the path they were captured from. Cross-host path remapping
    // is a later phase; here the operator sees the exact paths and opts in per path.
    const binds: RestoreBindPlan[] = (manifest.capture?.binds ?? []).map((p) => ({ source: p, dest: p }));
    if (binds.length) {
      warnings.push('Bind paths restore over the existing host directories — they are opt-in for that reason.');
    }

    // Is something already running under the destination name?
    try {
      const containers = await api.listContainers(true);
      const inUse = containers.filter((c) => (c.Labels ?? {})['com.docker.compose.project'] === destStackName);
      const running = inUse.filter((c) => c.State === 'running' || c.State === 'restarting');
      if (running.length) {
        // Writing into the volumes of a live database is how a restore corrupts the
        // thing it was meant to rescue, so this one is a hard stop.
        conflicts.push(`"${destStackName}" is running on ${host.name} (${running.length} container(s)) — stop it before restoring into its data.`);
      } else if (inUse.length) {
        warnings.push(`A stopped stack named "${destStackName}" already exists on ${host.name}; its data will be written into.`);
      }
    } catch {
      warnings.push(`Could not check for an existing "${destStackName}" stack on ${host.name}.`);
    }

    const secretMode = (manifest.secretMode ?? inventory?.secretMode ?? 'raw') as SecretMode;
    const secrets = await this.resolveSecrets(inventory, secretMode);
    if (secrets.some((s) => s.state === 'drifted')) {
      warnings.push('Some vault values changed since this snapshot. The restore writes the snapshot\'s values, so they match the restored data — rotate afterwards if you need the newer ones.');
    }
    if (secrets.some((s) => s.state === 'missing')) {
      warnings.push('Some vault keys this stack referenced no longer exist. The snapshot\'s own values are used instead.');
    }

    const hasCompose = has('compose.yaml');
    if (!hasCompose) warnings.push('This snapshot has no compose file, so only the data can be restored.');
    if (renaming && hasCompose) {
      const compose = await dumpFile(auth, snapshot.id, `${META}/compose.yaml`).catch(() => '');
      if (/^\s*container_name\s*:/m.test(compose)) {
        warnings.push('The compose file pins container_name, which is global to the host — a renamed copy will collide with the original stack if both run here.');
      }
    }

    return {
      snapshot,
      targetId: input.targetId,
      destInstanceId: host.id,
      destHostName: host.name,
      destStackName,
      sourceStackName,
      secretMode,
      volumes,
      binds,
      hasCompose,
      hasEnv: !!manifest.capture?.hasEnv || has('stack.env') || has('stack.env.redacted'),
      secrets,
      needsPassphrase: secretMode === 'embed',
      conflicts,
      warnings,
    };
  }

  /**
   * Compare what the vault holds now with what the snapshot was taken with. The
   * keyed digest makes this possible without either side handling the other's
   * plaintext, and separates "the key is gone" from "someone rotated it" — which
   * matters, because restoring a database volume next to a rotated password
   * produces a stack that comes up broken in a confusing way.
   */
  private async resolveSecrets(inventory: SecretInventory | null, secretMode: SecretMode): Promise<RestoreSecret[]> {
    if (!inventory) return [];
    const out: RestoreSecret[] = [];
    for (const v of inventory.variables) {
      if (!v.vaultKey) {
        out.push({ name: v.name, state: secretMode === 'embed' ? 'sealed' : 'plain' });
        continue;
      }
      const current = await this.secrets.reveal(v.vaultKey).catch(() => null);
      const state = current == null
        ? 'missing'
        : this.crypto.valueDigest(current) === v.digest
          ? 'resolved'
          : 'drifted';
      out.push({ name: v.name, vaultKey: v.vaultKey, origin: v.origin, state });
    }
    return out;
  }

  // ── Executing ─────────────────────────────────────────────────────

  async start(input: ExecuteRestoreInput): Promise<StackRestoreRun> {
    const plan = await this.plan(input);
    if (plan.conflicts.length && !input.force) {
      throw new BadRequestException(`Restore blocked: ${plan.conflicts.join(' ')}`);
    }
    if (input.mode === 'full' && !plan.hasCompose) {
      throw new BadRequestException('This snapshot has no compose file — restore the data only.');
    }
    if (input.mode === 'full' && plan.needsPassphrase && plan.hasEnv && !input.passphrase) {
      throw new BadRequestException("This snapshot's secrets are sealed — supply the passphrase to rebuild the stack's .env.");
    }

    const key = `${plan.destInstanceId}/${plan.destStackName}`;
    if (this.active.has(key)) throw new BadRequestException('A restore is already running for that stack.');

    const volumes = plan.volumes.filter((v) => !input.volumes || input.volumes.includes(v.source));
    const binds = plan.binds.filter((b) => (input.binds ?? []).includes(b.source));
    if (!volumes.length && !binds.length && input.mode === 'data') {
      throw new BadRequestException('Nothing selected to restore.');
    }

    const run = await this.prisma.stackRestoreRun.create({
      data: {
        snapshotId: plan.snapshot.id,
        targetId: input.targetId,
        sourceStackName: plan.sourceStackName,
        destInstanceId: plan.destInstanceId,
        destStackName: plan.destStackName,
        mode: input.mode,
        status: 'running',
        volumes: volumes.length,
        binds: binds.length,
      },
    });

    this.active.add(key);
    void this.execute(run.id, plan, input, volumes, binds).finally(() => this.active.delete(key));
    return this.runDto(run, plan.destHostName);
  }

  private async execute(
    runId: string,
    plan: RestorePlan,
    input: ExecuteRestoreInput,
    volumes: RestoreVolumePlan[],
    binds: RestoreBindPlan[],
  ): Promise<void> {
    const started = Date.now();
    const log: string[] = [];
    const say = (line: string) => log.push(`${new Date().toISOString()}  ${line}`);
    let deployed = false;

    try {
      const auth = await this.targets.authFor(input.targetId);
      const hostAuth = await this.targets.hostAuthFor(input.targetId);
      const target = await this.prisma.stackBackupTarget.findUniqueOrThrow({ where: { id: input.targetId } });
      const host = await this.hostOrThrow(plan.destInstanceId);
      const ctx = await this.instances.contextFor(host);
      const access = hostAccess(ctx, this.stacks);
      if (!access.ssh || !access.target) throw new Error(NO_SSH_REASON);

      say(`Restoring snapshot ${plan.snapshot.shortId} (${plan.sourceStackName}) to ${host.name} as "${plan.destStackName}".`);

      // 1) Volumes must exist before the helper can mount them, and must be created
      //    with the driver they had — an NFS volume recreated as a local one would
      //    silently hold a copy instead of pointing at the share.
      const manifest = JSON.parse(await dumpFile(auth, plan.snapshot.id, `${META}/manifest.json`)) as Manifest;
      for (const v of volumes) {
        const info = (manifest.volumes ?? []).find((m) => m.name === v.source);
        if (v.exists) {
          say(`Volume ${v.dest} already exists — restoring into it.`);
          continue;
        }
        await access.api.createVolume({
          Name: v.dest,
          Driver: info?.driver || 'local',
          DriverOpts: info?.options ?? undefined,
          Labels: {
            'com.docker.compose.project': plan.destStackName,
            'cerebro.restored-from': plan.snapshot.shortId,
          },
        });
        say(`Created volume ${v.dest}${info?.driver && info.driver !== 'local' ? ` (driver ${info.driver})` : ''}.`);
      }

      // 2) Restore the data. The helper mounts each destination volume at the path
      //    the snapshot stored it under, so a rename needs no path rewriting:
      //    restic writes to /data/volumes/<source>, which IS the new volume.
      if (volumes.length || binds.length) {
        const mounts: HelperMount[] = [
          ...volumes.map((v) => ({
            source: v.dest,
            dest: `/data/volumes/${v.source}`,
            kind: 'volume' as const,
            readOnly: false,
          })),
          ...binds.map((b) => ({
            source: b.dest,
            dest: `/data/binds/${bindSlug(b.source)}`,
            kind: 'bind' as const,
            readOnly: false,
          })),
        ];
        const includes = [
          ...volumes.map((v) => `/data/volumes/${v.source}`),
          ...binds.map((b) => `/data/binds/${bindSlug(b.source)}`),
        ];
        const args = [
          'restore', plan.snapshot.id, '--target', '/',
          ...includes.flatMap((i) => ['--include', i]),
        ];
        say(`Running ${target.helperImage} to restore ${volumes.length} volume(s) and ${binds.length} bind path(s)…`);
        const res = await runHelper({
          ssh: access.ssh,
          image: target.helperImage,
          env: resticEnv(hostAuth),
          mounts,
          args,
          timeoutMs: RESTORE_TIMEOUT_MS,
        });
        if (res.stdout.trim()) log.push(res.stdout.trim());
        if (res.stderr.trim()) log.push(res.stderr.trim());
        if (res.code !== 0) throw new Error(`restic restore failed (exit ${res.code}). See the log.`);
        say('Data restored.');
      }

      // 3) Configuration. Writing it through DockerStackService makes the restored
      //    stack Cerebro-managed at the destination, with revision history, rather
      //    than an orphan nobody can redeploy.
      if (input.mode === 'full') {
        const compose = await dumpFile(auth, plan.snapshot.id, `${META}/compose.yaml`);
        const env = await this.resolveEnv(auth, plan, input.passphrase);
        say(`Restoring configuration: compose${env ? ' + .env' : ''} (${compose.length} bytes).`);
        if (input.deploy) {
          const result = await this.stacks.deploy(access.target, host.id, plan.destStackName, compose, env);
          deployed = result.ok;
          say(result.message);
          if (!result.ok) throw new Error(result.message);
        } else {
          // Adopt the configuration without starting anything, so a recovered stack
          // can be reviewed before it comes up and starts talking to the network.
          await this.stacks.store(host.id, plan.destStackName, compose, env);
          say(`Stored as a Cerebro-managed stack — deploy it from the Docker screen when ready.`);
        }
      }

      const message = `Restored ${volumes.length} volume(s)${binds.length ? `, ${binds.length} bind path(s)` : ''} to "${plan.destStackName}" on ${host.name}${deployed ? ' and brought it up' : ''}.`;
      say(message);
      await this.finish(runId, { status: 'success', message, deployed, durationMs: Date.now() - started, log: log.join('\n') });
      void this.logging.info('stack-backup', message);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      say(`Failed: ${message}`);
      await this.finish(runId, { status: 'error', message, deployed, durationMs: Date.now() - started, log: log.join('\n') });
      void this.logging.error('stack-backup', `Restore ${runId} failed: ${message}`);
    }
  }

  /**
   * The `.env` to write beside the restored compose. It comes from the snapshot,
   * not the vault: the restored volumes hold whatever state those values produced,
   * so pairing them with a newer rotated credential is how a restore "succeeds"
   * into a stack that cannot start. Drift is surfaced in the plan instead.
   */
  private async resolveEnv(auth: ResticRepoAuth, plan: RestorePlan, passphrase?: string): Promise<string> {
    if (plan.secretMode === 'embed') {
      if (!passphrase) return '';
      const b64 = await dumpFile(auth, plan.snapshot.id, `${META}/secrets.sealed.b64`).catch(() => '');
      if (!b64.trim()) return '';
      let payload: SecretPayload;
      try {
        payload = openBundle<SecretPayload>(Buffer.from(b64.trim(), 'base64'), passphrase);
      } catch {
        throw new Error('Wrong passphrase — the sealed secrets could not be opened.');
      }
      return payload.env ?? '';
    }
    const raw = await dumpFile(auth, plan.snapshot.id, `${META}/secrets.raw.json`).catch(() => '');
    if (raw.trim()) {
      const payload = JSON.parse(raw) as SecretPayload;
      if (payload.env) return payload.env;
    }
    return dumpFile(auth, plan.snapshot.id, `${META}/stack.env`).catch(() => '');
  }

  private async finish(
    runId: string,
    data: { status: string; message: string; deployed: boolean; durationMs: number; log: string },
  ): Promise<void> {
    await this.prisma.stackRestoreRun.update({
      where: { id: runId },
      data: {
        status: data.status,
        message: data.message,
        deployed: data.deployed,
        durationMs: data.durationMs,
        log: data.log.slice(-MAX_LOG_CHARS),
        finishedAt: new Date(),
      },
    }).catch(() => { /* the row may have been removed mid-flight */ });
  }

  // ── History ───────────────────────────────────────────────────────

  async listRuns(limit = 25): Promise<StackRestoreRun[]> {
    const rows = await this.prisma.stackRestoreRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    const hostNames = await this.hostNames();
    return rows.map((r) => this.runDto(r, hostNames.get(r.destInstanceId)));
  }

  async getRun(id: string): Promise<StackRestoreRun> {
    const row = await this.prisma.stackRestoreRun.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Restore run not found.');
    const hostNames = await this.hostNames();
    return { ...this.runDto(row, hostNames.get(row.destInstanceId)), log: row.log };
  }

  // ── Helpers ───────────────────────────────────────────────────────

  /** Accepts a full or short snapshot id. */
  private async findSnapshot(targetId: string, snapshotId: string): Promise<StackSnapshot> {
    const all = await this.listSnapshots(targetId);
    const hit = all.find((s) => s.id === snapshotId || s.shortId === snapshotId);
    if (!hit) throw new NotFoundException('That snapshot is not in this repository.');
    return hit;
  }

  private async hostOrThrow(id: string) {
    const host = await this.prisma.connectorInstance.findUnique({ where: { id } });
    if (!host || host.connectorId !== DOCKER) throw new BadRequestException('Choose a Docker host to restore onto.');
    return host;
  }

  private async hostNames(): Promise<Map<string, string>> {
    const rows = await this.prisma.connectorInstance.findMany({
      where: { connectorId: DOCKER },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private runDto(
    row: {
      id: string; snapshotId: string; targetId: string; sourceStackName: string; destInstanceId: string;
      destStackName: string; mode: string; status: string; message: string | null; volumes: number;
      binds: number; deployed: boolean; durationMs: number | null; startedAt: Date; finishedAt: Date | null;
    },
    destHostName?: string,
  ): StackRestoreRun {
    return {
      id: row.id,
      snapshotId: row.snapshotId,
      targetId: row.targetId,
      sourceStackName: row.sourceStackName,
      destInstanceId: row.destInstanceId,
      destHostName,
      destStackName: row.destStackName,
      mode: row.mode as RestoreMode,
      status: row.status,
      message: row.message,
      volumes: row.volumes,
      binds: row.binds,
      deployed: row.deployed,
      durationMs: row.durationMs,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    };
  }
}

/** Compose's own project-name rules: lowercase, alphanumerics, dash and underscore. */
function projectName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}
