import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SecretsService } from '../../secrets/secrets.service';
import { runSsh, type SshConfig } from './docker-ssh';
import { dockerHostVerifier, dockerHostKeyPinKey } from './docker-hostkey';
import { assertSafeGitUrl, assertSafeGitRef, GIT_SAFE_SH_PREFIX } from '../../common/git-safety';
import type { GitCredential } from '@cerebro/shared';

export interface StackDeployTarget {
  ssh: SshConfig;
  /** Base directory on the host where per-stack compose files live. */
  stacksDir: string;
}

export interface StackRunResult {
  ok: boolean;
  message: string;
}

/** `docker compose up` options exposed on redeploy (mirror Portainer's toggles). */
export interface StackDeployOpts {
  /** `--pull always` — fetch newer images. */
  pull?: boolean;
  /** `--force-recreate` — recreate containers even if config is unchanged. */
  forceRecreate?: boolean;
  /** `--remove-orphans` — remove containers for services no longer in the compose. */
  removeOrphans?: boolean;
  /** `--build` — (re)build images from the repo's Dockerfiles as part of up. */
  build?: boolean;
  /** `compose build --no-cache --pull` then recreate — force a full rebuild of locally-built images. */
  forceRebuild?: boolean;
}

/** Git source for a stack. */
export interface StackGitSource {
  gitUrl: string;
  gitRef?: string | null;
  gitPath?: string | null;
  /** Vault secret key (kind='git') to authenticate a private repo; null = public. */
  credKey?: string | null;
  env?: string;
  /**
   * An extra compose file merged over the repo's own at `up` time (a generated
   * `docker-compose.override.yml`). Used by the App Replicator to layer on
   * operator-added volume mounts without editing the repo. Absent/empty removes
   * any override previously written for this stack.
   */
  overrideCompose?: string;
  /**
   * A compose Cerebro generated for a repo that ships none (App Replicator). When
   * set, it is written to `<stack>/docker-compose.cerebro.yml` beside the checkout
   * — not inside it, so the `.env` it reads sits outside the build context — and
   * used instead of `gitPath`. Stored on the stack row so a connector-side
   * redeploy or rollback can rewrite it.
   */
  generatedCompose?: string;
}

/** Where a generated compose (see `StackGitSource.generatedCompose`) lives, relative to the stack dir. */
export const GENERATED_COMPOSE_FILE = 'docker-compose.cerebro.yml';

/**
 * SSH step timeouts for deploys — a clone/build/up can far exceed runSsh's 120s
 * default, so a slow (esp. `--no-cache`) build no longer times out mid-way.
 */
const GIT_TIMEOUT_MS = 300_000; // 5 min
const BUILD_TIMEOUT_MS = 1_800_000; // 30 min
const UP_TIMEOUT_MS = 600_000; // 10 min

/**
 * Cerebro-managed compose stacks (Docker connector Phase 5). Cerebro is the
 * versioned store for each stack's compose file; deploys run the host's own
 * `docker compose` over SSH — no agent image, full compose fidelity. See
 * docs/connectors/docker.md.
 */
@Injectable()
export class DockerStackService {
  private readonly logger = new Logger(DockerStackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
  ) {}

  /** Attach TOFU host-key pinning to a deploy target's SSH config, so every runSsh
   *  on it verifies (and pins on first use) the host key. Public so the connector can
   *  pin the target at its single construction point (covers telemetry SSH too). */
  withHostPin(target: StackDeployTarget): StackDeployTarget {
    if (target.ssh.verifyHostKey) return target; // already pinned
    const { host, port } = target.ssh;
    const verify = dockerHostVerifier(this.prisma, host, port, {
      pinned: (m) => this.logger.log(m),
      mismatch: (m) => this.logger.warn(m),
    });
    return { ...target, ssh: { ...target.ssh, verifyHostKey: verify } };
  }

  /** Forget a host's pinned SSH key (operator action) so the next connect re-learns
   *  it — used after a host is legitimately rebuilt/re-imaged. Returns whether a pin
   *  existed. */
  async clearHostKeyPin(host: string, port: number): Promise<boolean> {
    const res = await this.prisma.setting
      .deleteMany({ where: { key: dockerHostKeyPinKey(host, port) } })
      .catch(() => ({ count: 0 }));
    return res.count > 0;
  }

  list(instanceId: string) {
    return this.prisma.dockerStack.findMany({
      where: { connectorInstanceId: instanceId },
      orderBy: { name: 'asc' },
    });
  }

  get(instanceId: string, name: string) {
    return this.prisma.dockerStack.findUnique({
      where: { connectorInstanceId_name: { connectorInstanceId: instanceId, name: projectName(name) } },
    });
  }

  private saveCompose(instanceId: string, name: string, compose: string, env: string) {
    const project = projectName(name);
    const data = { compose, env: env || null, source: 'compose', gitUrl: null, gitRef: null, gitPath: null, gitCredKey: null };
    return this.prisma.dockerStack.upsert({
      where: { connectorInstanceId_name: { connectorInstanceId: instanceId, name: project } },
      update: data,
      create: { connectorInstanceId: instanceId, name: project, ...data },
    });
  }

  /**
   * Adopt a compose file as a Cerebro-managed stack WITHOUT deploying it — the
   * stack row plus a first revision, no host interaction. Used by a restore that
   * writes a stack's configuration but leaves bringing it up to the operator, so
   * a recovered stack can be reviewed before it starts touching the network.
   */
  async store(instanceId: string, name: string, compose: string, env = ''): Promise<void> {
    const project = projectName(name);
    if (!project) throw new BadRequestException('A valid stack name is required.');
    await this.saveCompose(instanceId, project, compose, env);
    await this.recordRevision(instanceId, project, { compose, env, source: 'compose' });
  }

  private saveGit(instanceId: string, name: string, src: StackGitSource) {
    const project = projectName(name);
    const data = {
      source: 'git', compose: src.generatedCompose || '', env: src.env || null,
      gitUrl: src.gitUrl, gitRef: src.gitRef || null, gitPath: src.gitPath || null, gitCredKey: src.credKey || null,
    };
    return this.prisma.dockerStack.upsert({
      where: { connectorInstanceId_name: { connectorInstanceId: instanceId, name: project } },
      update: data,
      create: { connectorInstanceId: instanceId, name: project, ...data },
    });
  }

  async remove(instanceId: string, name: string): Promise<void> {
    await this.prisma.dockerStack.deleteMany({
      where: { connectorInstanceId: instanceId, name: projectName(name) },
    });
  }

  /** Remove the on-host directory Cerebro wrote for a stack (compose/.env, or the cloned git repo). */
  async purgeDir(target: StackDeployTarget, name: string): Promise<void> {
    target = this.withHostPin(target);
    const project = projectName(name);
    if (!project) return;
    const dir = `${trimSlash(target.stacksDir)}/${project}`;
    // Guard against a stray empty stacksDir wiping something unexpected.
    if (!dir.includes(`/${project}`)) return;
    await runSsh(target.ssh, `rm -rf '${dir}'`).catch(() => { /* best-effort */ });
  }

  /**
   * Write the compose (+ optional `.env`) to the host, validate it, then
   * `docker compose up -d`. Stores compose/env so it can be edited/redeployed,
   * and records the outcome.
   */
  async deploy(
    target: StackDeployTarget,
    instanceId: string,
    name: string,
    compose: string,
    env = '',
    opts: StackDeployOpts = {},
  ): Promise<StackRunResult> {
    target = this.withHostPin(target);
    const project = projectName(name);
    if (!project) return { ok: false, message: 'A valid stack name is required.' };
    if (!compose.trim()) return { ok: false, message: 'The compose file is empty.' };

    await this.saveCompose(instanceId, name, compose, env);
    const dir = `${trimSlash(target.stacksDir)}/${project}`;
    const file = `${dir}/docker-compose.yml`;
    const envFile = `${dir}/.env`;

    try {
      // 1) write the compose + .env (stdin → cat, so no shell-escaping of contents).
      //    Always write .env (even empty) so stale variables don't linger.
      const w1 = await runSsh(target.ssh, `mkdir -p '${dir}' && cat > '${file}'`, compose);
      if (w1.code !== 0) throw new Error(w1.stderr.trim() || 'Failed to write the compose file on the host.');
      const w2 = await runSsh(target.ssh, `cat > '${envFile}'`, env);
      if (w2.code !== 0) throw new Error(w2.stderr.trim() || 'Failed to write the .env file on the host.');

      // 2) validate before applying, so a YAML/compose error fails cleanly.
      const cfg = await runSsh(target.ssh, `docker compose -p '${project}' -f '${file}' config -q`);
      if (cfg.code !== 0) {
        const detail = tail(cfg.stderr || cfg.stdout, 2000);
        await this.record(instanceId, project, 'error', detail);
        return { ok: false, message: `Compose validation failed: ${detail}` };
      }

      // 3) optional forced rebuild of locally-built images, then docker compose up -d [flags]
      if (opts.forceRebuild) {
        const b = await runSsh(target.ssh, `docker compose -p '${project}' -f '${file}' build --no-cache --pull`, undefined, BUILD_TIMEOUT_MS);
        if (b.code !== 0) {
          const detail = tail(b.stderr || b.stdout, 3000);
          await this.record(instanceId, project, 'error', detail);
          return { ok: false, message: `Image rebuild failed: ${detail}` };
        }
      }
      const flags = composeUpFlags(opts);
      const up = await runSsh(target.ssh, `docker compose -p '${project}' -f '${file}' up -d ${flags}`.trim(), undefined, UP_TIMEOUT_MS);
      const out = tail(up.stderr || up.stdout, 4000);
      if (up.code !== 0) {
        await this.record(instanceId, project, 'error', out);
        return { ok: false, message: out || `docker compose exited ${up.code}.` };
      }
      await this.record(instanceId, project, 'success', out);
      await this.recordRevision(instanceId, project, { compose, env, source: 'compose' });
      return { ok: true, message: `Deployed "${project}".${out ? `\n${out}` : ''}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Deploy failed.';
      await this.record(instanceId, project, 'error', message);
      return { ok: false, message };
    }
  }

  /**
   * Deploy a stack from a Git repository: clone/pull on the host (private repos
   * authenticate with a vault Git credential fed via a temp git-credential file,
   * removed after), then `docker compose` from the repo — with build / force-rebuild
   * options for repos that build their own images. Stores the git source + commit.
   */
  async deployGit(
    target: StackDeployTarget,
    instanceId: string,
    name: string,
    src: StackGitSource,
    opts: StackDeployOpts = {},
    onProgress?: (phase: string) => void,
  ): Promise<StackRunResult> {
    target = this.withHostPin(target);
    const project = projectName(name);
    if (!project) return { ok: false, message: 'A valid stack name is required.' };
    let ref: string | undefined;
    let relCompose: string;
    try { assertSafeGitUrl(src.gitUrl); ref = assertSafeGitRef(src.gitRef) || undefined; relCompose = safeComposeRel(src.gitPath); }
    catch (e) { return { ok: false, message: e instanceof Error ? e.message : 'Invalid git repository URL.' }; }

    const base = `${trimSlash(target.stacksDir)}/${project}`;
    const dir = `${base}/repo`;
    const generated = !!src.generatedCompose?.trim();
    const composeFile = generated ? `${base}/${GENERATED_COMPOSE_FILE}` : `${dir}/${relCompose}`;
    const composeDir = composeFile.replace(/\/[^/]*$/, '') || dir;
    const credFile = `${base}/.gitcred`;
    // Cerebro's generated compose override lives beside the repo (not inside it, so
    // a `git reset --hard` can't touch it) and is passed as an extra `-f`.
    const overrideFile = `${base}/cerebro.override.yml`;

    // Resolve the vault Git credential (kind='git' JSON), if any.
    let cred: GitCredential | null = null;
    if (src.credKey) {
      const raw = await this.secrets.reveal(src.credKey).catch(() => null);
      if (raw) { try { cred = JSON.parse(raw) as GitCredential; } catch { cred = { secret: raw }; } }
    }
    const helper = cred ? `-c credential.helper='store --file=${credFile}'` : '';

    await this.saveGit(instanceId, name, src);
    try {
      await runSsh(target.ssh, `mkdir -p '${base}'`);
      // Write the credential file over stdin so the token never appears in a command line.
      if (cred?.secret) {
        const host = cred.host?.trim() || hostFromUrl(src.gitUrl);
        const line = `https://${encodeURIComponent(cred.username || 'x-access-token')}:${encodeURIComponent(cred.secret)}@${host}\n`;
        const w = await runSsh(target.ssh, `cat > '${credFile}' && chmod 600 '${credFile}'`, line);
        if (w.code !== 0) throw new Error('Failed to write git credentials on the host.');
      }

      // Clone (first time) or fetch + hard-reset to the ref.
      const isRepo = (await runSsh(target.ssh, `test -d '${dir}/.git' && echo yes || echo no`)).stdout.trim() === 'yes';
      onProgress?.(isRepo ? 'Updating repository…' : 'Cloning repository…');
      const g = isRepo
        ? await runSsh(target.ssh, `${GIT_SAFE_SH_PREFIX} git -C '${dir}' ${helper} fetch --all --prune && git -C '${dir}' checkout ${ref ? `'${sq(ref)}'` : 'HEAD'} && git -C '${dir}' ${helper} reset --hard ${ref ? `'origin/${sq(ref)}'` : '@{u}'} 2>/dev/null || git -C '${dir}' ${helper} pull --ff-only`, undefined, GIT_TIMEOUT_MS)
        : await runSsh(target.ssh, `${GIT_SAFE_SH_PREFIX} rm -rf '${dir}' && git ${helper} clone ${ref ? `--branch '${sq(ref)}'` : ''} -- '${sq(src.gitUrl)}' '${dir}'`, undefined, GIT_TIMEOUT_MS);
      if (g.code !== 0) {
        const detail = redact(tail(g.stderr || g.stdout, 2000), cred);
        await this.record(instanceId, project, 'error', detail);
        return { ok: false, message: `Git ${isRepo ? 'update' : 'clone'} failed: ${detail}` };
      }

      // A generated compose is (re)written on every deploy, after the checkout is current.
      if (generated) {
        const wg = await runSsh(target.ssh, `cat > '${composeFile}'`, src.generatedCompose);
        if (wg.code !== 0) throw new Error('Failed to write the generated compose file on the host.');
      } else {
        await runSsh(target.ssh, `rm -f '${base}/${GENERATED_COMPOSE_FILE}'`).catch(() => { /* best-effort */ });
      }

      // Write the .env beside the compose (only if provided).
      if (src.env != null && src.env !== '') {
        const we = await runSsh(target.ssh, `mkdir -p '${composeDir}' && cat > '${composeDir}/.env'`, src.env);
        if (we.code !== 0) throw new Error('Failed to write the .env file on the host.');
      }

      // Write (or clear) the Cerebro-generated compose override, and build the
      // `-f` list — the base repo compose first (sets the project directory), then
      // the override merged over it.
      let composeArgs = `-f '${composeFile}'`;
      if (src.overrideCompose != null && src.overrideCompose.trim() !== '') {
        const wo = await runSsh(target.ssh, `mkdir -p '${base}' && cat > '${overrideFile}'`, src.overrideCompose);
        if (wo.code !== 0) throw new Error('Failed to write the compose override file on the host.');
        composeArgs += ` -f '${overrideFile}'`;
      } else {
        // No override now — remove any stale one so a removed mount actually goes away.
        await runSsh(target.ssh, `rm -f '${overrideFile}'`).catch(() => { /* best-effort */ });
      }

      // Validate, then optional force-rebuild, then up.
      onProgress?.('Validating compose…');
      const cfg = await runSsh(target.ssh, `docker compose -p '${project}' ${composeArgs} config -q`);
      if (cfg.code !== 0) {
        const detail = tail(cfg.stderr || cfg.stdout, 2000);
        await this.record(instanceId, project, 'error', detail);
        return { ok: false, message: `Compose validation failed: ${detail}` };
      }
      if (opts.forceRebuild) {
        onProgress?.('Building images…');
        const b = await runSsh(target.ssh, `docker compose -p '${project}' ${composeArgs} build --no-cache --pull`, undefined, BUILD_TIMEOUT_MS);
        if (b.code !== 0) {
          const detail = tail(b.stderr || b.stdout, 3000);
          await this.record(instanceId, project, 'error', detail);
          return { ok: false, message: `Image rebuild failed: ${detail}` };
        }
      }
      onProgress?.('Starting containers…');
      const up = await runSsh(target.ssh, `docker compose -p '${project}' ${composeArgs} up -d ${composeUpFlags(opts)}`.trim(), undefined, UP_TIMEOUT_MS);
      const out = tail(up.stderr || up.stdout, 4000);
      if (up.code !== 0) {
        await this.record(instanceId, project, 'error', out);
        return { ok: false, message: out || `docker compose exited ${up.code}.` };
      }

      const commit = (await runSsh(target.ssh, `git -C '${dir}' rev-parse HEAD`).catch(() => null))?.stdout.trim() || null;
      await this.record(instanceId, project, 'success', out);
      await this.recordRevision(instanceId, project, {
        compose: src.generatedCompose || '', env: src.env ?? '', source: 'git',
        gitUrl: src.gitUrl, gitRef: src.gitRef ?? null, gitPath: src.gitPath ?? null, commit,
      });
      return { ok: true, message: `Deployed "${project}" from git${commit ? ` @ ${commit.slice(0, 7)}` : ''}.${out ? `\n${out}` : ''}` };
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : 'Git deploy failed.', cred);
      await this.record(instanceId, project, 'error', message);
      return { ok: false, message };
    } finally {
      // Never leave credentials on disk.
      await runSsh(target.ssh, `rm -f '${credFile}'`).catch(() => { /* best-effort */ });
    }
  }

  /**
   * Clone a Git source onto a host and `docker build` the given images there —
   * build only, no deploy. Used by the Stack Migrator's "rebuild on target"
   * option: an image built on the source host is architecture-locked, so copying
   * its bytes to a different-arch target produces something that won't run;
   * rebuilding from source on the target yields a native image. The produced tags
   * are exactly the refs the restored compose will reference, so the restore's
   * `docker compose up` finds them locally. Reuses the same shallow-clone +
   * credential plumbing as deployGit. See docs/stack-migrator.md.
   */
  async buildGitImages(
    target: StackDeployTarget,
    src: { gitUrl: string; gitRef?: string | null; gitPath?: string | null; credKey?: string | null },
    builds: { image: string; context: string; dockerfile: string }[],
    onProgress?: (line: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    target = this.withHostPin(target);
    let ref: string | undefined;
    try { assertSafeGitUrl(src.gitUrl); ref = assertSafeGitRef(src.gitRef) || undefined; }
    catch (e) { throw new Error(e instanceof Error ? e.message : 'Invalid git repository URL.'); }
    if (!builds.length) return;

    // A dedicated scratch dir under the stacks root, so a failed build never touches
    // a real stack's checkout. `mktemp -d` keeps concurrent builds from colliding.
    const base = `${trimSlash(target.stacksDir)}/.cerebro-build`;
    const mk = await runSsh(target.ssh, `mkdir -p '${base}' && mktemp -d '${base}/XXXXXXXX'`);
    if (mk.code !== 0 || !mk.stdout.trim()) throw new Error('Could not create a build directory on the target.');
    const workdir = mk.stdout.trim();
    const repoDir = `${workdir}/repo`;
    const credFile = `${workdir}/.gitcred`;

    let cred: GitCredential | null = null;
    if (src.credKey) {
      const raw = await this.secrets.reveal(src.credKey).catch(() => null);
      if (raw) { try { cred = JSON.parse(raw) as GitCredential; } catch { cred = { secret: raw }; } }
    }
    const helper = cred ? `-c credential.helper='store --file=${credFile}'` : '';

    try {
      if (cred?.secret) {
        const host = cred.host?.trim() || hostFromUrl(src.gitUrl);
        const line = `https://${encodeURIComponent(cred.username || 'x-access-token')}:${encodeURIComponent(cred.secret)}@${host}\n`;
        const w = await runSsh(target.ssh, `cat > '${credFile}' && chmod 600 '${credFile}'`, line);
        if (w.code !== 0) throw new Error('Failed to write git credentials on the target.');
      }

      onProgress?.('Cloning the repository on the target…');
      const clone = await runSsh(
        target.ssh,
        `${GIT_SAFE_SH_PREFIX} git ${helper} clone --depth 1 ${ref ? `--branch '${sq(ref)}'` : ''} -- '${sq(src.gitUrl)}' '${repoDir}'`,
        undefined, GIT_TIMEOUT_MS,
      );
      if (clone.code !== 0) {
        // A SHA ref can't be --branch'd — fall back to a full clone + checkout.
        if (!ref) throw new Error(`Git clone failed: ${redact(tail(clone.stderr || clone.stdout, 2000), cred)}`);
        const full = await runSsh(target.ssh, `${GIT_SAFE_SH_PREFIX} rm -rf '${repoDir}' && git ${helper} clone -- '${sq(src.gitUrl)}' '${repoDir}' && git -C '${repoDir}' checkout '${sq(ref)}'`, undefined, GIT_TIMEOUT_MS);
        if (full.code !== 0) throw new Error(`Git clone failed: ${redact(tail(full.stderr || full.stdout, 2000), cred)}`);
      }

      // The compose file's directory within the repo — build contexts are relative to it.
      const composeDir = relDir(safeRelPath(src.gitPath));
      for (let i = 0; i < builds.length; i++) {
        if (signal?.aborted) throw new Error('cancelled');
        const b = builds[i];
        const image = safeImageRef(b.image);
        const ctxRel = safeRelPath(joinRel(composeDir, b.context || '.'));
        const dockerfileRel = safeRelPath(b.dockerfile || 'Dockerfile');
        const ctxDir = ctxRel ? `${repoDir}/${ctxRel}` : repoDir;
        const dfPath = `${ctxDir}/${dockerfileRel}`;
        onProgress?.(`Building ${image} on the target (${i + 1}/${builds.length})…`);
        const build = await runSsh(
          target.ssh,
          `docker build --pull -t '${sq(image)}' -f '${sq(dfPath)}' '${sq(ctxDir)}'`,
          undefined, BUILD_TIMEOUT_MS,
        );
        if (build.code !== 0) throw new Error(`Build of ${image} failed: ${tail(build.stderr || build.stdout, 3000)}`);
        onProgress?.(`Built ${image} natively on the target.`);
      }
    } finally {
      await runSsh(target.ssh, `rm -rf '${workdir}'`).catch(() => { /* best-effort */ });
    }
  }

  /**
   * Compare a managed stack against reality: does the compose file on the host
   * still match what Cerebro stored, and are all expected services present and
   * running? Returns a human-readable report. Read-only — runs nothing that
   * changes state.
   */
  async checkDrift(target: StackDeployTarget, instanceId: string, name: string): Promise<StackRunResult> {
    target = this.withHostPin(target);
    const project = projectName(name);
    const stored = await this.get(instanceId, name);
    if (!stored) return { ok: false, message: "This stack isn't managed by Cerebro — no stored compose to compare against." };

    const file = await this.composeFileFor(target, instanceId, name);
    const lines: string[] = [];
    let drift = false;

    try {
      // 1) Source drift.
      if (stored.source === 'git') {
        // Git stacks: compare the deployed commit to the remote tip of the ref.
        const dir = `${trimSlash(target.stacksDir)}/${project}/repo`;
        // Defend legacy stored refs (deploy now validates on write); a bad one → HEAD.
        let ref = '';
        try { ref = assertSafeGitRef(stored.gitRef); } catch { ref = ''; }
        const local = (await runSsh(target.ssh, `git -C '${dir}' rev-parse HEAD 2>/dev/null || true`)).stdout.trim();
        const remote = (await runSsh(target.ssh, `${GIT_SAFE_SH_PREFIX} git -C '${dir}' ls-remote origin ${ref ? `'${sq(ref)}'` : 'HEAD'} 2>/dev/null | awk '{print $1}' | head -1`)).stdout.trim();
        if (local && remote && local !== remote) { lines.push(`⚠ Repo has moved: deployed ${local.slice(0, 7)}, ${ref || 'HEAD'} is now ${remote.slice(0, 7)}. Redeploy to update.`); drift = true; }
        else if (local) lines.push(`✓ On the latest commit for ${ref || 'the default branch'} (${local.slice(0, 7)}).`);
        else lines.push('⚠ No git checkout found on the host.');
      } else {
        // Compose stacks: the compose on the host vs. the version Cerebro deployed.
        const read = await runSsh(target.ssh, `cat '${file}' 2>/dev/null || true`);
        const hostFile = read.stdout;
        if (!hostFile.trim()) {
          lines.push(`⚠ No compose file found on the host at ${file}.`); drift = true;
        } else if (normalizeCompose(hostFile) !== normalizeCompose(stored.compose)) {
          lines.push('⚠ The compose file on the host DIFFERS from the version Cerebro stored (edited out of band?).'); drift = true;
        } else {
          lines.push("✓ Compose file on the host matches Cerebro's stored version.");
        }
      }

      // 2) Runtime drift — expected services vs. what's actually up.
      const [svc, ps] = await Promise.all([
        runSsh(target.ssh, `docker compose -p '${project}' -f '${file}' config --services 2>/dev/null || true`),
        runSsh(target.ssh, `docker compose -p '${project}' -f '${file}' ps -a --format json 2>/dev/null || true`),
      ]);
      const expected = svc.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const running = parseComposePs(ps.stdout);
      const stateByService = new Map(running.map((r) => [r.Service, r.State]));
      if (expected.length) {
        const missing = expected.filter((s) => !stateByService.has(s));
        const notRunning = expected.filter((s) => stateByService.has(s) && stateByService.get(s) !== 'running');
        const extra = running.filter((r) => r.Service && !expected.includes(r.Service)).map((r) => r.Service);
        lines.push(`Services: ${expected.length} expected, ${stateByService.size} present.`);
        if (missing.length) { lines.push(`⚠ Missing (no container): ${missing.join(', ')}`); drift = true; }
        if (notRunning.length) { lines.push(`⚠ Not running: ${notRunning.map((s) => `${s} (${stateByService.get(s)})`).join(', ')}`); drift = true; }
        if (extra.length) { lines.push(`⚠ Orphan containers not in the compose: ${[...new Set(extra)].join(', ')}`); drift = true; }
        if (!missing.length && !notRunning.length && !extra.length) lines.push('✓ All expected services are present and running.');
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Drift check failed.' };
    }

    return { ok: true, message: `${drift ? 'DRIFT DETECTED' : 'IN SYNC'}\n\n${lines.join('\n')}` };
  }

  /** The host path to a stored stack's compose file (repo path for git stacks). */
  private async composeFileFor(target: StackDeployTarget, instanceId: string, name: string): Promise<string> {
    const project = projectName(name);
    const base = `${trimSlash(target.stacksDir)}/${project}`;
    const stored = await this.get(instanceId, name).catch(() => null);
    if (stored?.source === 'git') return gitStackComposePath(target.stacksDir, project, stored.gitPath, !!stored.compose);
    return `${base}/docker-compose.yml`;
  }

  /** `docker compose down` for a stored stack. */
  async down(target: StackDeployTarget, instanceId: string, name: string): Promise<StackRunResult> {
    target = this.withHostPin(target);
    const project = projectName(name);
    const file = await this.composeFileFor(target, instanceId, name);
    try {
      const res = await runSsh(target.ssh, `docker compose -p '${project}' -f '${file}' down`);
      const out = tail(res.stderr || res.stdout);
      if (res.code !== 0) return { ok: false, message: out || `docker compose down exited ${res.code}.` };
      await this.record(instanceId, project, 'stopped', out);
      return { ok: true, message: `Stopped "${project}".` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Stop failed.' };
    }
  }

  /** How many past versions to keep per stack. */
  private static readonly MAX_REVISIONS = 10;

  /** Snapshot a deployed version and prune old ones. Best-effort. */
  private async recordRevision(
    instanceId: string,
    project: string,
    rev: { compose: string; env: string; source: string; gitUrl?: string | null; gitRef?: string | null; gitPath?: string | null; commit?: string | null },
  ): Promise<void> {
    try {
      await this.prisma.dockerStackRevision.create({
        data: {
          connectorInstanceId: instanceId, name: project,
          compose: rev.compose, env: rev.env || null,
          source: rev.source, gitUrl: rev.gitUrl ?? null, gitRef: rev.gitRef ?? null, gitPath: rev.gitPath ?? null, commit: rev.commit ?? null,
        },
      });
      const old = await this.prisma.dockerStackRevision.findMany({
        where: { connectorInstanceId: instanceId, name: project },
        orderBy: { createdAt: 'desc' },
        skip: DockerStackService.MAX_REVISIONS,
        select: { id: true },
      });
      if (old.length) {
        await this.prisma.dockerStackRevision.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
      }
    } catch {
      /* history is best-effort */
    }
  }

  /** Recent revisions of a stack (newest first) — for the detail view's history. */
  listRevisions(instanceId: string, name: string) {
    return this.prisma.dockerStackRevision.findMany({
      where: { connectorInstanceId: instanceId, name: projectName(name) },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
  }

  /** The version deployed before the current one (for one-step rollback), or null. */
  async previousRevision(instanceId: string, name: string) {
    const recent = await this.prisma.dockerStackRevision.findMany({
      where: { connectorInstanceId: instanceId, name: projectName(name) },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    return recent[1] ?? null;
  }

  /** Revision count per stack for this connector (for the "N versions" hint). */
  async revisionCounts(instanceId: string): Promise<Record<string, number>> {
    const rows = await this.prisma.dockerStackRevision.groupBy({
      by: ['name'],
      where: { connectorInstanceId: instanceId },
      _count: { _all: true },
    });
    return Object.fromEntries(rows.map((r) => [r.name, r._count._all]));
  }

  private record(instanceId: string, project: string, status: string, message: string) {
    return this.prisma.dockerStack
      .updateMany({
        where: { connectorInstanceId: instanceId, name: project },
        data: { lastStatus: status, lastMessage: message.slice(0, 500) || null, lastDeployedAt: new Date() },
      })
      .catch(() => { /* best-effort status */ });
  }
}

/** Compose project names must be lowercase [a-z0-9][a-z0-9_-]*. Sanitize + clamp. */
export function projectName(name: string): string {
  const s = (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 63);
  return s;
}

/**
 * Where a git-sourced stack's `.env` lives on the host: beside its compose file,
 * under `<stacksDir>/<project>/repo/` — or one level up, beside a generated
 * compose (`generated`, see `StackGitSource.generatedCompose`). Exported so a caller that reads the file
 * back — the App Replicator's environment drift check — derives the path from the
 * same validated logic that wrote it, rather than re-deriving it and silently
 * comparing against the wrong file.
 */
export function gitStackEnvPath(stacksDir: string, name: string, gitPath?: string | null, generated = false): string {
  if (generated) return `${trimSlash(stacksDir)}/${projectName(name)}/.env`;
  const dir = `${trimSlash(stacksDir)}/${projectName(name)}/repo`;
  const composeFile = `${dir}/${safeComposeRel(gitPath)}`;
  return `${composeFile.replace(/\/[^/]*$/, '') || dir}/.env`;
}

/** The host path to a git stack's compose file in its cloned repo. Exported so backup
 *  can read the compose of a git-sourced stack (e.g. an App Replicator deployment),
 *  whose text is not stored in Cerebro's DB. Validates the chars like the deploy path. */
export function gitStackComposePath(stacksDir: string, name: string, gitPath?: string | null, generated = false): string {
  if (generated) return `${trimSlash(stacksDir)}/${projectName(name)}/${GENERATED_COMPOSE_FILE}`;
  return `${trimSlash(stacksDir)}/${projectName(name)}/repo/${safeComposeRel(gitPath)}`;
}

function trimSlash(p: string): string {
  const dir = (p || '/opt/cerebro-stacks').replace(/\/+$/, '');
  // stacksDir is admin-set config that gets embedded in remote shell commands
  // (inside single quotes). Reject anything outside a safe path charset so it can't
  // break out of the quoting (e.g. a single quote or shell metacharacter).
  if (!/^[A-Za-z0-9 _./-]+$/.test(dir)) {
    throw new BadRequestException('The stacks directory contains unsupported characters (use letters, digits, spaces, and _ . / -).');
  }
  return dir;
}

/** Validate a git-stack compose file path. It is embedded in remote shell commands
 *  inside single quotes (`docker compose -f '<dir>/<rel>'`), so — like stacksDir —
 *  reject quotes/metacharacters and `..` traversal so it can't break out. */
function safeComposeRel(gitPath?: string | null): string {
  const rel = (gitPath?.trim() || 'docker-compose.yml').replace(/^\/+/, '');
  if (!/^[A-Za-z0-9 _./-]+$/.test(rel) || rel.split('/').includes('..')) {
    throw new BadRequestException(
      'The compose file path contains unsupported characters — use a plain relative path like "docker-compose.yml" or "stacks/app/compose.yaml".',
    );
  }
  return rel;
}

/** `docker compose up` flags from the deploy options (shared by compose + git deploys). */
function composeUpFlags(opts: StackDeployOpts): string {
  return [
    opts.pull ? '--pull always' : '',
    (opts.build || opts.forceRebuild) ? '--build' : '',
    (opts.forceRecreate || opts.forceRebuild) ? '--force-recreate' : '',
    opts.removeOrphans ? '--remove-orphans' : '',
  ].filter(Boolean).join(' ');
}

/** Escape a string for safe embedding inside single quotes in a shell command. */
function sq(s: string): string {
  return (s || '').replace(/'/g, `'\\''`);
}

/** A repo-relative path that's safe to embed in a single-quoted remote command. */
function safeRelPath(p?: string | null): string {
  const rel = (p ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!rel) return '';
  if (!/^[A-Za-z0-9 _.\/-]+$/.test(rel) || rel.split('/').includes('..')) {
    throw new Error('Unsafe path in the build configuration.');
  }
  return rel;
}

/** Directory part of a repo-relative file path ("deploy/compose.yml" → "deploy"). */
function relDir(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(0, i) : '';
}

/** Join two repo-relative paths, dropping "." and empty segments. */
function joinRel(a: string, b: string): string {
  return [...a.split('/'), ...b.split('/')].filter((x) => x && x !== '.').join('/');
}

/** Validate a docker image reference before embedding it in a remote command. */
function safeImageRef(ref: string): string {
  const r = (ref || '').trim();
  if (!r || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(r)) throw new Error(`Unsafe image reference: ${ref}`);
  return r;
}

/** Hostname from a git URL, for the credential-store line. */
function hostFromUrl(url: string): string {
  try { return new URL(url).host; } catch { return (url.match(/^https?:\/\/([^/]+)/i)?.[1]) ?? ''; }
}

/** Strip a credential's secret out of any host output before it's stored/shown. */
function redact(text: string, cred: GitCredential | null): string {
  if (!cred?.secret) return text;
  return (text || '').split(cred.secret).join('***');
}

/** Normalize compose text for a stable comparison: strip trailing spaces + blank-line noise. */
function normalizeCompose(s: string): string {
  return (s || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Parse `docker compose ps --format json` — v2 emits either a JSON array or one object per line. */
function parseComposePs(out: string): { Service: string; State: string }[] {
  const text = (out || '').trim();
  if (!text) return [];
  const pick = (o: Record<string, unknown>) => ({ Service: String(o.Service ?? ''), State: String(o.State ?? '').toLowerCase() });
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(pick);
    return [pick(parsed)];
  } catch {
    // NDJSON: one JSON object per line.
    const rows: { Service: string; State: string }[] = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try { rows.push(pick(JSON.parse(t))); } catch { /* skip non-JSON noise */ }
    }
    return rows;
  }
}

function tail(s: string, max = 400): string {
  const t = (s || '').trim();
  return t.length > max ? '…' + t.slice(-max) : t;
}
