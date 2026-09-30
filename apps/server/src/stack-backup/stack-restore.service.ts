import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { SecretsService } from '../secrets/secrets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CryptoService } from '../common/crypto.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { DockerStackService } from '../connectors/docker/docker-stack.service';
import { runSsh, type SshConfig } from '../connectors/docker/docker-ssh';
import { openBundle } from '../system-backup/bundle';
import type {
  ExecuteRestoreInput, RestoreBindPlan, RestoreMode, RestorePlan, RestorePlanInput, RestorePortPlan,
  RestoreSecret, RestoreVolumePlan, SecretMode, SnapshotEntry, StackRestoreRun, StackSnapshot,
  VerifyRestoreInput,
} from '@cerebro/shared';
import { BackupTargetService } from './backup-target.service';
import { restoreCompose, type SecretInventory, type SecretPayload } from './secret-capture';
import { bindSlug } from './stack-inspect';
import { hostAccess, NO_SSH_REASON } from './docker-host';
import { PortAllocatorService } from '../app-replicator/port-allocator.service';
import { assertSandbox, sandboxName, unpublishPorts } from './sandbox';
import { appendHostFiles } from './helper-runner';
import { runHelper, type HelperMount } from './helper-runner';
import { pushDir, relayRoot } from './relay';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  decodeTags, dumpFile, listFiles, listSnapshots, resticEnv, runResticLocalTolerant,
  type ResticRepoAuth,
} from './restic-cli';

const DOCKER = 'docker';
const META = '/data/meta';
const RESTORE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** How long a verify sandbox gets to come up healthy before it is called a failure. */
const VERIFY_TIMEOUT_MS = 3 * 60_000;
/** A single-file download is buffered through the server, so it is deliberately bounded. */
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const MAX_LOG_CHARS = 64 * 1024;

/** What a snapshot's manifest.json carries that a restore needs. */
interface Manifest {
  project?: string;
  host?: string;
  connectorInstanceId?: string;
  secretMode?: SecretMode;
  volumes?: { name: string; driver?: string; options?: Record<string, string> | null; labels?: Record<string, string> | null }[];
  containers?: {
    name: string;
    image?: string;
    mounts?: { type?: string; name?: string; destination?: string }[];
    ports?: { hostIp?: string; hostPort?: string; containerPort?: string }[];
  }[];
  capture?: {
    /** Where the snapshot's tree is rooted: '/data' for a direct capture, the
     *  staging path for a relay one. Absent on pre-relay snapshots. */
    root?: string;
    transfer?: string;
    volumes?: string[]; binds?: string[]; hasCompose?: boolean; hasEnv?: boolean;
  };
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
    private readonly ports: PortAllocatorService,
    private readonly notifications: NotificationsService,
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

  /**
   * Read one file out of a snapshot — the everyday case of "I need yesterday's
   * config", which does not warrant restoring a whole volume. Capped, because it
   * is buffered to hand back over HTTP.
   */
  async readSnapshotFile(targetId: string, snapshotId: string, path: string): Promise<{ name: string; content: Buffer }> {
    if (!path.startsWith('/data/')) throw new BadRequestException('That path is not inside this snapshot.');
    const auth = await this.targets.authFor(targetId);
    const entry = (await listFiles(auth, snapshotId, path.slice(0, path.lastIndexOf('/')) || '/data').catch(() => []))
      .find((e) => e.path === path);
    if (entry && entry.type === 'dir') throw new BadRequestException('That is a directory, not a file.');
    if (entry?.size != null && entry.size > MAX_DOWNLOAD_BYTES) {
      throw new BadRequestException(`That file is ${Math.round(entry.size / 1024 / 1024)} MB — too large to download here. Restore the volume instead.`);
    }
    const content = await dumpFile(auth, snapshotId, path);
    return { name: path.split('/').pop() || 'file', content: Buffer.from(content, 'utf8') };
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

    // Binds restore to the path they were captured from unless the operator remaps
    // them — which is what makes a cross-host restore work when the destination
    // lays its storage out differently.
    const binds: RestoreBindPlan[] = [];
    for (const source of manifest.capture?.binds ?? []) {
      const mapped = input.bindMap?.[source]?.trim();
      if (mapped && (!mapped.startsWith('/') || mapped.includes("'"))) {
        conflicts.push(`"${mapped}" is not a usable absolute host path for ${source}.`);
      }
      const dest = mapped || source;
      binds.push({ source, dest, exists: ssh ? await pathExists(ssh, dest) : false, remapped: !!mapped && mapped !== source });
    }
    if (binds.length) {
      warnings.push('Bind paths restore over the existing host directories — they are opt-in for that reason.');
    }

    // Port preflight, using the App Replicator's own "what is taken on this host"
    // check so the two features cannot disagree about it.
    const ports: RestorePortPlan[] = [];
    const wanted = new Map<number, string | undefined>();
    for (const c of manifest.containers ?? []) {
      for (const p of c.ports ?? []) {
        const n = Number(p.hostPort);
        if (Number.isFinite(n) && n > 0) wanted.set(n, p.containerPort);
      }
    }
    if (wanted.size && ssh) {
      const used = new Set(await this.ports.usedPorts(ssh).catch(() => []));
      for (const [hostPort, containerPort] of [...wanted].sort((a, b) => a[0] - b[0])) {
        ports.push({ hostPort, containerPort, inUse: used.has(hostPort) });
      }
      const clashes = ports.filter((p) => p.inUse).map((p) => p.hostPort);
      if (clashes.length) {
        // Not a hard stop: when restoring in place over a stopped stack, the port
        // is "in use" only because the old container still holds the binding.
        warnings.push(`Host port(s) already in use on ${host.name}: ${clashes.join(', ')}. The restored stack will fail to start until they are free.`);
      }
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
    if (secretMode === 'reference') {
      const gone = secrets.filter((x) => x.state === 'missing').map((x) => x.name);
      if (gone.length) {
        // A sealed or raw snapshot carries its own values; a reference one has
        // nothing to fall back on, so this is a hard stop rather than a warning.
        conflicts.push(`This snapshot references vault keys that no longer exist, so its .env cannot be rebuilt: ${gone.join(', ')}.`);
      }
    }
    if (secrets.some((s) => s.state === 'drifted')) {
      warnings.push('Some vault values changed since this snapshot. The restore writes the snapshot\'s values, so they match the restored data — rotate afterwards if you need the newer ones.');
    }
    if (secrets.some((s) => s.state === 'missing')) {
      warnings.push('Some vault keys this stack referenced no longer exist. The snapshot\'s own values are used instead.');
    }

    // Credential files are captured (sealed) but not yet written back — say so,
    // rather than letting a stack come up missing the file it authenticates with.
    const capturedFiles = inventory?.capturedFiles ?? [];
    // A credential file can only be written back when it was a real HOST path (a
    // compose `secrets: file:` source). A `*_FILE` path was read from inside a
    // container, so the same path on the host means something different.
    const composeText = has('compose.yaml') ? await dumpFile(auth, snapshot.id, `${META}/compose.yaml`).catch(() => '') : '';
    const credentialFiles = capturedFiles.map((path) => ({
      path,
      writable: new RegExp(`^\\s*file:\\s*["']?${escapeRe(path)}["']?\\s*$`, 'm').test(composeText),
    }));
    const unwritable = credentialFiles.filter((f) => !f.writable).map((f) => f.path);
    if (unwritable.length) {
      warnings.push(`This snapshot holds ${unwritable.length} credential file(s) read from inside a container (${unwritable.join(', ')}). They cannot be written back to a host path — restore them by hand.`);
    }
    const uncaptured = (inventory?.fileSecrets ?? []).filter((f) => !capturedFiles.some((c) => f.includes(c)));
    if (uncaptured.length) {
      warnings.push(`These credential files were NOT captured and must exist on the destination already: ${uncaptured.join(', ')}.`);
    }

    const captureRoot = manifest.capture?.root || '/data';
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
      hasEnv: !!manifest.capture?.hasEnv || has('stack.env') || has('stack.env.redacted') || has('stack.env.reference'),
      secrets,
      ports,
      credentialFiles,
      captureRoot,
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
      // A non-secret-looking variable in reference mode keeps its literal value in
      // the .env, so it needs no resolution and would only add noise here.
      if (!v.vaultKey) {
        if (secretMode === 'reference' && v.secretish === false) continue;
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

  /**
   * Prove a snapshot restores. Brings it up under a throwaway name with no
   * published ports, waits for its containers to report healthy, then removes
   * the sandbox and everything it created.
   *
   * This is the difference between "the backups run" and "the backups work" —
   * every other signal in this feature says a backup was *written*, not that it
   * can be *read back into a working stack*.
   */
  async startVerify(input: VerifyRestoreInput): Promise<StackRestoreRun> {
    const snapshot = await this.findSnapshot(input.targetId, input.snapshotId);
    const base = await this.plan({
      targetId: input.targetId,
      snapshotId: input.snapshotId,
      destInstanceId: input.destInstanceId,
    });
    if (!base.hasCompose) throw new BadRequestException('This snapshot has no compose file, so there is nothing to bring up.');
    if (base.needsPassphrase && base.hasEnv && !input.passphrase) {
      throw new BadRequestException("This snapshot's secrets are sealed — supply the passphrase so the trial stack gets its .env.");
    }

    const name = sandboxName(base.sourceStackName, snapshot.shortId);
    // Re-plan under the sandbox name so volumes are renamed onto it.
    const plan = await this.plan({
      targetId: input.targetId,
      snapshotId: input.snapshotId,
      destInstanceId: input.destInstanceId,
      destStackName: name,
    });
    // A leftover sandbox from an interrupted run is the only conflict that should
    // ever appear here, and reusing it would taint the result.
    if (plan.conflicts.length) {
      throw new BadRequestException(`Cannot start a clean trial: ${plan.conflicts.join(' ')}`);
    }

    const key = `${plan.destInstanceId}/${name}`;
    if (this.active.has(key)) throw new BadRequestException('A verify is already running for that snapshot.');

    const run = await this.prisma.stackRestoreRun.create({
      data: {
        snapshotId: plan.snapshot.id,
        targetId: input.targetId,
        sourceStackName: plan.sourceStackName,
        destInstanceId: plan.destInstanceId,
        destStackName: name,
        mode: 'verify',
        status: 'running',
        volumes: plan.volumes.length,
      },
    });

    this.active.add(key);
    void this.runVerify(run.id, plan, input).finally(() => this.active.delete(key));
    return this.runDto(run, plan.destHostName);
  }

  private async runVerify(runId: string, plan: RestorePlan, input: VerifyRestoreInput): Promise<void> {
    const started = Date.now();
    const log: string[] = [];
    const say = (line: string) => log.push(`${new Date().toISOString()}  ${line}`);
    let deployed = false;

    try {
      say(`Trial restore of ${plan.snapshot.shortId} as "${plan.destStackName}" on ${plan.destHostName}.`);
      await this.execute(runId, plan, {
        targetId: plan.targetId,
        snapshotId: plan.snapshot.id,
        destInstanceId: plan.destInstanceId,
        destStackName: plan.destStackName,
        mode: 'verify',
        passphrase: input.passphrase,
        deploy: true,
        force: false,
      }, plan.volumes, [], { log, keepRunning: true });

      const row = await this.prisma.stackRestoreRun.findUnique({ where: { id: runId } });
      if (row?.status === 'error') return; // execute() already recorded why
      deployed = true;

      const host = await this.hostOrThrow(plan.destInstanceId);
      const ctx = await this.instances.contextFor(host);
      const access = hostAccess(ctx, this.stacks);

      const health = await this.waitHealthy(access.api, plan.destStackName, say);
      const message = health.ok
        ? `Verified: ${plan.sourceStackName} restored from ${plan.snapshot.shortId} and came up healthy (${health.detail}).`
        : `Verify FAILED: the restored stack did not come up healthy — ${health.detail}`;
      say(message);

      if (!input.keep) {
        await this.teardown(access, plan, say);
      } else {
        say(`Sandbox left running as "${plan.destStackName}". Remove it when you are done.`);
      }

      await this.finish(runId, {
        status: health.ok ? 'success' : 'error',
        message,
        deployed,
        durationMs: Date.now() - started,
        log: log.join('\n'),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      say(`Verify failed: ${message}`);
      // Never leave a sandbox behind because the trial itself errored.
      if (!input.keep) {
        try {
          const host = await this.hostOrThrow(plan.destInstanceId);
          const ctx = await this.instances.contextFor(host);
          await this.teardown(hostAccess(ctx, this.stacks), plan, say);
        } catch (cleanupErr) {
          say(`WARNING: could not clean up the sandbox: ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`);
        }
      }
      await this.finish(runId, { status: 'error', message, deployed, durationMs: Date.now() - started, log: log.join('\n') });
    }
  }

  /**
   * Watch a sandbox stack settle. "Healthy" means every container is running and
   * every container that declares a healthcheck reports healthy — twice in a row,
   * so a stack that comes up and immediately crash-loops is not counted as a pass.
   */
  private async waitHealthy(
    api: ReturnType<typeof hostAccess>['api'],
    project: string,
    say: (line: string) => void,
  ): Promise<{ ok: boolean; detail: string }> {
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let consecutive = 0;
    let last = 'no containers yet';

    while (Date.now() < deadline) {
      await sleep(5000);
      let containers;
      try {
        containers = (await api.listContainers(true)).filter(
          (c) => (c.Labels ?? {})['com.docker.compose.project'] === project,
        );
      } catch (err) {
        last = `could not inspect the sandbox: ${err instanceof Error ? err.message : err}`;
        continue;
      }
      if (!containers.length) { last = 'no containers were created'; continue; }

      const states: string[] = [];
      let allGood = true;
      for (const c of containers) {
        const name = (c.Names ?? [])[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12);
        const inspect = await api.inspectContainer(c.Id).catch(() => null);
        const health = inspect?.State?.Health?.Status;
        const running = inspect?.State?.Running ?? c.State === 'running';
        // A container that exits 0 (a migration/init job) is a legitimate pass.
        const finishedCleanly = !running && (inspect?.State?.Status === 'exited') && c.Status?.includes('(0)');
        const good = health ? health === 'healthy' : running || finishedCleanly;
        states.push(`${name}=${health ?? (running ? 'running' : c.State ?? 'unknown')}`);
        if (!good) allGood = false;
      }
      last = states.join(', ');

      if (allGood) {
        consecutive += 1;
        if (consecutive >= 2) return { ok: true, detail: last };
      } else {
        consecutive = 0;
      }
      say(`Waiting for the sandbox: ${last}`);
    }
    return { ok: false, detail: `timed out after ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s — ${last}` };
  }

  /** Remove the sandbox and everything it created. Guarded by the name check. */
  private async teardown(
    access: ReturnType<typeof hostAccess>,
    plan: RestorePlan,
    say: (line: string) => void,
  ): Promise<void> {
    assertSandbox(plan.destStackName);
    if (!access.target) return;

    const down = await this.stacks.down(access.target, plan.destInstanceId, plan.destStackName);
    say(down.message);

    // Only volumes this sandbox created — every one is prefixed with its name.
    let removed = 0;
    for (const v of plan.volumes) {
      if (!v.dest.startsWith(`${plan.destStackName}_`)) continue;
      const ok = await access.api.removeVolume(v.dest).then(() => true).catch(() => false);
      if (ok) removed += 1;
    }
    await this.stacks.purgeDir(access.target, plan.destStackName).catch(() => { /* best-effort */ });
    await this.stacks.remove(plan.destInstanceId, plan.destStackName).catch(() => { /* best-effort */ });
    say(`Sandbox removed (${removed} volume(s) deleted).`);
  }

  private async execute(
    runId: string,
    plan: RestorePlan,
    input: ExecuteRestoreInput,
    volumes: RestoreVolumePlan[],
    binds: RestoreBindPlan[],
    /** A verify run shares its log and finishes the row itself once it has a verdict. */
    opts: { log?: string[]; keepRunning?: boolean } = {},
  ): Promise<void> {
    const started = Date.now();
    const log = opts.log ?? [];
    const say = (line: string) => log.push(`${new Date().toISOString()}  ${line}`);
    let deployed = false;

    try {
      const auth = await this.targets.authFor(input.targetId);
      const hostAuth = await this.targets.hostAuthFor(input.targetId);
      const target = await this.prisma.stackBackupTarget.findUniqueOrThrow({ where: { id: input.targetId } });
      const host = await this.hostOrThrow(plan.destInstanceId);
      const ctx = await this.instances.contextFor(host);
      const access = hostAccess(ctx, this.stacks);
      const relayRestore = !access.ssh;
      if (relayRestore && input.mode !== 'data') {
        throw new Error(
          'This host has no SSH, so Cerebro can restore its data but cannot write a compose file or run `docker compose` on it. Restore the data only, or add SSH to the Docker connector.',
        );
      }

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
        // A snapshot records where its tree was rooted (see the capture manifest):
        // '/data' for a direct capture, a staging path for a relay one. Mount
        // destinations and restic includes both have to match it.
        const root = plan.captureRoot || '/data';
        const volPath = (name: string) => `${root}/volumes/${name}`;
        const bindPath = (source: string) => `${root}/binds/${bindSlug(source)}`;

        if (relayRestore) {
          await this.relayRestore(plan, volumes, binds, root, access, say, log);
        } else {
          const mounts: HelperMount[] = [
            ...volumes.map((v) => ({ source: v.dest, dest: volPath(v.source), kind: 'volume' as const, readOnly: false })),
            ...binds.map((b) => ({ source: b.dest, dest: bindPath(b.source), kind: 'bind' as const, readOnly: false })),
          ];
          const includes = [
            ...volumes.map((v) => volPath(v.source)),
            ...binds.map((b) => bindPath(b.source)),
          ];
          const args = [
            'restore', plan.snapshot.id, '--target', '/',
            ...includes.flatMap((i) => ['--include', i]),
          ];
          say(`Running ${target.helperImage} to restore ${volumes.length} volume(s) and ${binds.length} bind path(s)…`);
          const res = await runHelper({
            ssh: access.ssh!,
            image: target.helperImage,
            env: resticEnv(hostAuth),
            mounts,
            args,
            timeoutMs: RESTORE_TIMEOUT_MS,
          });
          if (res.stdout.trim()) log.push(res.stdout.trim());
          if (res.stderr.trim()) log.push(res.stderr.trim());
          if (res.code !== 0) throw new Error(`restic restore failed (exit ${res.code}). See the log.`);
        }
        say('Data restored.');
      }

      // 3) Configuration. Writing it through DockerStackService makes the restored
      //    stack Cerebro-managed at the destination, with revision history, rather
      //    than an orphan nobody can redeploy.
      if (input.mode === 'full' || input.mode === 'verify') {
        const stored = await dumpFile(auth, plan.snapshot.id, `${META}/compose.yaml`);
        const { env, composeSecrets, files } = await this.resolveSnapshotSecrets(auth, plan, input.passphrase);
        // Literals lifted out of the compose at capture time go back in verbatim.
        let compose = restoreCompose(stored, composeSecrets);
        if (input.mode === 'verify') {
          compose = unpublishPorts(compose);
          say('Sandbox publishes no host ports — nothing it starts can collide with the real stack.');
        }

        // Credential files are written back only on request, and only the ones
        // that came from a real host path.
        if (input.restoreCredentialFiles) {
          const writable = new Set(plan.credentialFiles.filter((f) => f.writable).map((f) => f.path));
          let written = 0;
          for (const [path, content] of Object.entries(files)) {
            if (!writable.has(path)) continue;
            const dir = path.slice(0, path.lastIndexOf('/')) || '/';
            const res = await runSsh(access.ssh!, `umask 077; mkdir -p '${dir}' && cat > '${path}'`, content);
            if (res.code !== 0) throw new Error(`Could not write credential file ${path}: ${res.stderr.trim()}`);
            written += 1;
          }
          if (written) say(`Wrote ${written} credential file(s) back to the host.`);
        }
        say(`Restoring configuration: compose${env ? ' + .env' : ''} (${compose.length} bytes).`);
        if (!access.target) throw new Error(NO_SSH_REASON);
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
      // A verify run is not finished yet — it still has to prove the stack is healthy.
      if (!opts.keepRunning) {
        await this.finish(runId, { status: 'success', message, deployed, durationMs: Date.now() - started, log: log.join('\n') });
        void this.logging.info('stack-backup', message);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      say(`Failed: ${message}`);
      await this.finish(runId, { status: 'error', message, deployed, durationMs: Date.now() - started, log: log.join('\n') });
      void this.logging.error('stack-backup', `Restore ${runId} failed: ${message}`);
    }
  }

  /**
   * Restore without SSH: restic writes into a staging tree on Cerebro, and each
   * volume is pushed into the host through a throwaway container.
   *
   * The container is created from an image the stack itself uses — taken from the
   * snapshot's manifest — so a host that can run the stack can always run this,
   * with no extra image to pull. It is never started; `PUT /archive` works on a
   * created container, which is the whole point.
   */
  private async relayRestore(
    plan: RestorePlan,
    volumes: RestoreVolumePlan[],
    binds: RestoreBindPlan[],
    root: string,
    access: ReturnType<typeof hostAccess>,
    say: (line: string) => void,
    log: string[],
  ): Promise<void> {
    if (binds.length) {
      throw new Error('Bind paths cannot be restored without SSH — they live outside any container. Restore the volumes only.');
    }
    const auth = await this.targets.authFor(plan.targetId);
    const manifest = JSON.parse(await dumpFile(auth, plan.snapshot.id, `${META}/manifest.json`)) as Manifest;

    const staging = join(relayRoot(), '..', 'restore');
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      const includes = volumes.map((v) => `${root}/volumes/${v.source}`);
      say(`Restoring ${volumes.length} volume(s) into staging on Cerebro…`);
      const res = await runResticLocalTolerant(
        auth,
        ['restore', plan.snapshot.id, '--target', staging, ...includes.flatMap((i) => ['--include', i])],
        RESTORE_TIMEOUT_MS,
      );
      if (res.stdout.trim()) log.push(res.stdout.trim());
      if (res.stderr.trim()) log.push(res.stderr.trim());
      if (res.code !== 0) throw new Error(`restic restore failed (exit ${res.code}). See the log.`);

      for (const v of volumes) {
        const dir = join(staging, root.replace(/^\//, ''), 'volumes', v.source);
        // A mount point inside the throwaway container; anything absolute works.
        const mountPath = `/cerebro-restore`;
        const image = imageForVolume(manifest, v.source);
        if (!image) throw new Error(`No image in the snapshot mounts volume ${v.source}, so there is nothing to push it through.`);

        const name = `cerebro-restore-${v.dest}-${Date.now().toString(36)}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 60);
        const id = await access.api.createContainer(name, {
          Image: image,
          // Never started — a created container is enough for PUT /archive, and
          // this way the image's entrypoint never runs against restored data.
          Entrypoint: ['/bin/true'],
          HostConfig: { Binds: [`${v.dest}:${mountPath}`], AutoRemove: false },
          Labels: { 'cerebro.restore': plan.snapshot.shortId },
        });
        try {
          say(`Pushing ${v.source} → volume ${v.dest}…`);
          await pushDir(access.api, id, mountPath, dir);
        } finally {
          await access.api.removeContainer(id).catch(() => { /* best-effort */ });
        }
      }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => { /* best-effort */ });
    }
  }

  /**
   * The `.env` to write beside the restored compose, plus any literals that were
   * lifted out of the compose file at capture time.
   *
   * For sealed and raw snapshots the values come from the snapshot, NOT the
   * vault: the restored volumes hold whatever state those values produced, so
   * pairing them with a newer rotated credential is how a restore "succeeds"
   * into a stack that cannot start. Drift is surfaced in the plan instead.
   *
   * A `reference` snapshot has no values of its own by design, so there the vault
   * is the only source — and a key that has since been rotated genuinely does
   * mean the restored data and the new credential disagree, which is why the plan
   * blocks on a missing key and warns on a drifted one.
   */
  private async resolveSnapshotSecrets(
    auth: ResticRepoAuth,
    plan: RestorePlan,
    passphrase?: string,
  ): Promise<{ env: string; composeSecrets: Record<string, string>; files: Record<string, string> }> {
    const empty = { env: '', composeSecrets: {}, files: {} };
    if (plan.secretMode === 'embed') {
      if (!passphrase) return empty;
      const b64 = await dumpFile(auth, plan.snapshot.id, `${META}/secrets.sealed.b64`).catch(() => '');
      if (!b64.trim()) return empty;
      let payload: SecretPayload;
      try {
        payload = openBundle<SecretPayload>(Buffer.from(b64.trim(), 'base64'), passphrase);
      } catch {
        throw new Error('Wrong passphrase — the sealed secrets could not be opened.');
      }
      return { env: payload.env ?? '', composeSecrets: payload.composeSecrets ?? {}, files: payload.files ?? {} };
    }

    if (plan.secretMode === 'reference') {
      const template = await dumpFile(auth, plan.snapshot.id, `${META}/stack.env.reference`).catch(() => '');
      if (!template.trim()) return empty;
      return { env: await this.fillVaultReferences(template), composeSecrets: {}, files: {} };
    }

    const raw = await dumpFile(auth, plan.snapshot.id, `${META}/secrets.raw.json`).catch(() => '');
    if (raw.trim()) {
      const payload = JSON.parse(raw) as SecretPayload;
      if (payload.env) {
        return { env: payload.env, composeSecrets: payload.composeSecrets ?? {}, files: payload.files ?? {} };
      }
    }
    const env = await dumpFile(auth, plan.snapshot.id, `${META}/stack.env`).catch(() => '');
    return { env, composeSecrets: {}, files: {} };
  }

  /** Replace every `${vault:<key>}` placeholder with the live value. */
  private async fillVaultReferences(template: string): Promise<string> {
    const missing: string[] = [];
    const lines = await Promise.all(
      template.split('\n').map(async (line) => {
        const m = /^(\s*[A-Za-z_][A-Za-z0-9_]*\s*=)\$\{vault:(.+?)\}\s*$/.exec(line);
        if (!m) return line;
        const value = await this.secrets.reveal(m[2]).catch(() => null);
        if (value == null) { missing.push(m[2]); return line; }
        return `${m[1]}${value}`;
      }),
    );
    if (missing.length) {
      throw new Error(`These vault keys are gone, so the .env cannot be rebuilt: ${missing.join(', ')}.`);
    }
    return lines.join('\n');
  }

  private async finish(
    runId: string,
    data: { status: string; message: string; deployed: boolean; durationMs: number; log: string },
  ): Promise<void> {
    const row = await this.prisma.stackRestoreRun.update({
      where: { id: runId },
      data: {
        status: data.status,
        message: data.message,
        deployed: data.deployed,
        durationMs: data.durationMs,
        log: data.log.slice(-MAX_LOG_CHARS),
        finishedAt: new Date(),
      },
    }).catch(() => null);

    // A restore overwrites data, so both outcomes are worth telling someone about
    // — the failure because it may have left a half-written stack behind.
    await this.notifications.dispatchAlert(
      data.status === 'success' ? 'restore.success' : 'restore.failure',
      {
        title: data.status === 'success'
          ? `Stack restore completed: ${row?.destStackName ?? 'stack'}`
          : `Stack restore FAILED: ${row?.destStackName ?? 'stack'}`,
        body: data.message,
        dedupeKey: `stack-restore:${runId}`,
        connectorId: row?.destInstanceId,
      },
    ).catch(() => { /* alerting must never mask the restore's own outcome */ });
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

/** Does a path exist on the destination host? Best-effort; false on any doubt. */
async function pathExists(ssh: SshConfig, path: string): Promise<boolean> {
  if (!path.startsWith('/') || path.includes("'")) return false;
  const res = await runSsh(ssh, `test -e '${path}' && echo yes || echo no`).catch(() => null);
  return res?.stdout.trim() === 'yes';
}

/** An image from the snapshot that mounted this volume — what to push through. */
function imageForVolume(manifest: Manifest, volume: string): string | undefined {
  const owner = (manifest.containers ?? []).find((c) => (c.mounts ?? []).some((m) => m.name === volume));
  return owner?.image ?? (manifest.containers ?? [])[0]?.image;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compose's own project-name rules: lowercase, alphanumerics, dash and underscore. */
function projectName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}
