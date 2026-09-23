import { BadRequestException, Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve, sep } from 'node:path';
import { SecretsService } from '../secrets/secrets.service';
import { assertSafeGitUrl, assertSafeGitRef, gitSafeEnv } from '../common/git-safety';
import type { GitCredential, IntrospectRepoInput, IntrospectResult, ReplicatorVariable } from '@cerebro/shared';
import { introspectCompose, generateComposeWrapper, exposedPortOf, parseDotenv, envFileVariables, mergeEnvFileVars } from './compose-introspect';

/** Standard compose filenames to auto-detect when no explicit path is given. */
const COMPOSE_CANDIDATES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/**
 * Suffixes to try for a declared `env_file:` target. The real file is nearly always
 * gitignored, so what the repo actually commits is a sample alongside it.
 */
const ENV_SAMPLE_SUFFIXES = ['', '.example', '.sample', '.template', '.dist'];

/**
 * Committed env files to look for when compose declares no `env_file:` — compose
 * auto-loads a `.env` next to the compose file, so a repo documenting that file
 * is describing variables the app expects just as much as an explicit declaration.
 */
const ENV_FALLBACKS = ['.env.example', '.env.sample', '.env.template', '.env.dist', 'example.env', 'env.example'];

/** Guard rails on a repo-supplied env file: it's untrusted content. */
const ENV_FILE_MAX_BYTES = 256 * 1024;
const ENV_FILE_MAX_VARS = 300;

/**
 * Reads an app's compose file straight from its Git repo (a shallow clone into a
 * temp dir, private repos authenticated with a vault Git credential) and derives
 * the variable/port schema. Runs at register time, before a deploy target is
 * chosen, so it clones locally on the Cerebro host rather than over SSH. See
 * docs/app-replicator.md.
 */
@Injectable()
export class RepoIntrospectService {
  constructor(private readonly secrets: SecretsService) {}

  async introspect(input: IntrospectRepoInput): Promise<IntrospectResult> {
    const gitUrl = assertSafeGitUrl(input.gitUrl);
    const ref = assertSafeGitRef(input.gitRef);

    const cred = await this.resolveCred(input.gitCredKey);
    const workdir = await mkdtemp(join(tmpdir(), 'cerebro-replicator-'));
    const credFile = join(workdir, '.gitcred');
    const repoDir = join(workdir, 'repo');

    try {
      const env = gitSafeEnv({
        ...process.env,
        GIT_TERMINAL_PROMPT: '0', // never block on an interactive auth prompt
        GIT_ASKPASS: '/bin/true',
      });
      const helper = cred ? ['-c', `credential.helper=store --file=${credFile}`] : [];
      if (cred?.secret) {
        const host = cred.host?.trim() || hostFromUrl(gitUrl);
        const line = `https://${encodeURIComponent(cred.username || 'x-access-token')}:${encodeURIComponent(cred.secret)}@${host}\n`;
        await this.run('bash', ['-c', `umask 177 && cat > '${credFile}'`], workdir, env, line);
      }

      // Shallow clone at the ref. A ref that's a commit SHA can't be --branch'd,
      // so fall back to a default clone + checkout.
      try {
        await this.run('git', [...helper, 'clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', gitUrl, repoDir], workdir, env);
      } catch (err) {
        if (!ref) throw err;
        await this.run('git', [...helper, 'clone', '--', gitUrl, repoDir], workdir, env);
        await this.run('git', ['-C', repoDir, 'checkout', ref], workdir, env);
      }

      // Locate the compose file (explicit path, else auto-detect).
      const explicit = input.gitPath?.trim().replace(/^\/+/, '');
      let composePath: string | null = null;
      if (explicit) {
        if (await exists(join(repoDir, explicit))) composePath = explicit;
        else throw new BadRequestException(`No file at "${explicit}" in the repo.`);
      } else {
        for (const c of COMPOSE_CANDIDATES) {
          if (await exists(join(repoDir, c))) { composePath = c; break; }
        }
      }

      if (composePath) {
        const text = await readFile(join(repoDir, composePath), 'utf8');
        const parsed = introspectCompose(text);
        const env = await this.readEnvFiles(repoDir, composePath, parsed.envFiles);
        return {
          variables: mergeEnvFileVars(parsed.variables, env.variables),
          services: parsed.services,
          composePath,
          usesGeneratedCompose: false,
          envFiles: env.files,
          warnings: [...parsed.warnings, ...env.warnings],
        };
      }

      // No compose file — synthesize a wrapper from the Dockerfile if present.
      if (await exists(join(repoDir, 'Dockerfile'))) {
        const dockerfile = await readFile(join(repoDir, 'Dockerfile'), 'utf8');
        const exposed = exposedPortOf(dockerfile) ?? 8080;
        const wrapper = generateComposeWrapper(exposed);
        const parsed = introspectCompose(wrapper);
        parsed.warnings.unshift(
          `No compose file found; generated a wrapper exposing port ${exposed}. Committing a docker-compose.yml is recommended before deploying.`,
        );
        return { ...parsed, composePath: 'docker-compose.yml (generated)', usesGeneratedCompose: true, envFiles: [] };
      }

      throw new BadRequestException('No docker-compose.yml or Dockerfile found in the repository.');
    } catch (err) {
      const msg = redact(err instanceof Error ? err.message : 'Failed to read the repository.', cred);
      throw err instanceof BadRequestException ? new BadRequestException(msg) : new BadRequestException(`Could not introspect the repo: ${msg}`);
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Read the app's env file(s) out of the clone and derive variables from them.
   *
   * Which file: every path the compose declares via `env_file:` (each tried as-is
   * and then with a sample suffix, since the real file is normally gitignored),
   * or — when compose declares none — the committed `.env.example`-style file
   * beside the compose or at the repo root, which is what compose's own auto-loaded
   * `.env` would have contained.
   *
   * Everything here is repo-controlled content, so paths are resolved and confined
   * to the clone, files are size-capped, and the variable count is capped.
   */
  private async readEnvFiles(
    repoDir: string,
    composePath: string,
    declared: string[],
  ): Promise<{ variables: ReplicatorVariable[]; files: string[]; warnings: string[] }> {
    const composeDir = posix.dirname(composePath.split(sep).join('/'));
    const rel = (p: string) => posix.normalize(composeDir === '.' ? p : posix.join(composeDir, p));
    const warnings: string[] = [];
    const files: string[] = [];
    let variables: ReplicatorVariable[] = [];

    const candidates = declared.length
      ? declared.map((d) => ({ declared: d, tries: ENV_SAMPLE_SUFFIXES.map((sfx) => rel(d) + sfx) }))
      : [{ declared: null, tries: [...ENV_FALLBACKS.map(rel), ...(composeDir === '.' ? [] : ENV_FALLBACKS)] }];

    for (const c of candidates) {
      let found: string | null = null;
      for (const t of c.tries) {
        const abs = this.insideRepo(repoDir, t);
        if (abs && (await exists(abs))) { found = t; break; }
      }
      if (!found) {
        if (c.declared) {
          warnings.push(
            `The compose file reads "${c.declared}" via env_file:, but neither it nor a sample of it is committed — add those variables by hand so Cerebro can write them.`,
          );
        }
        continue;
      }
      const abs = this.insideRepo(repoDir, found)!;
      const text = await readFile(abs, 'utf8').catch(() => null);
      if (text == null) continue;
      if (Buffer.byteLength(text) > ENV_FILE_MAX_BYTES) {
        warnings.push(`Skipped "${found}" — it is larger than ${Math.round(ENV_FILE_MAX_BYTES / 1024)}KB.`);
        continue;
      }
      const entries = parseDotenv(text);
      if (!entries.length) continue;
      files.push(found);
      variables = mergeEnvFileVars(variables, envFileVariables(entries.slice(0, ENV_FILE_MAX_VARS), found));
      if (entries.length > ENV_FILE_MAX_VARS) {
        warnings.push(`"${found}" declares ${entries.length} variables; only the first ${ENV_FILE_MAX_VARS} were imported.`);
      }

      // Cerebro writes exactly one file — `.env` beside the compose, which is both
      // the compose default and the usual `env_file:` target. When the compose
      // reads somewhere else, the values are still collected (they're the app's
      // real settings) but say plainly that they land in `.env`, not there.
      if (c.declared && rel(c.declared) !== rel('.env')) {
        warnings.push(
          `The compose reads "${c.declared}", but Cerebro only ever writes ".env" beside the compose file — the values you set for the variables imported from "${found}" land there, so they take effect only if the repo also loads ".env".`,
        );
      }
    }

    if (files.length) {
      const secrets = variables.filter((v) => v.secret).length;
      warnings.push(
        `Imported ${variables.length} variable(s) from ${files.join(', ')}${secrets ? ` (${secrets} flagged secret — supply a value per deployment; the sample value is never reused)` : ''}.`,
      );
    }
    return { variables, files, warnings };
  }

  /**
   * Resolve a repo-relative path to an absolute one, or null when it escapes the
   * clone — compose content is untrusted, so `env_file: ../../etc/passwd` must not
   * be readable.
   */
  private insideRepo(repoDir: string, relPath: string): string | null {
    if (posix.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) return null;
    const base = resolve(repoDir);
    const abs = resolve(base, relPath);
    return abs === base || abs.startsWith(base + sep) ? abs : null;
  }

  /**
   * Shallow-clone the repo and return the raw compose file text — what the ECS
   * target needs to translate the compose into a Fargate task definition (the
   * register-time introspector only returns the derived variable schema). A
   * Dockerfile-only repo yields the generated wrapper text. See
   * docs/app-replicator-ecs-target.md.
   */
  async fetchComposeText(input: IntrospectRepoInput): Promise<{ text: string; composePath: string; usesGeneratedCompose: boolean }> {
    const gitUrl = assertSafeGitUrl(input.gitUrl);
    const ref = assertSafeGitRef(input.gitRef);
    const cred = await this.resolveCred(input.gitCredKey);
    const workdir = await mkdtemp(join(tmpdir(), 'cerebro-ecs-compose-'));
    const credFile = join(workdir, '.gitcred');
    const repoDir = join(workdir, 'repo');
    try {
      const env = gitSafeEnv({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true' });
      const helper = cred ? ['-c', `credential.helper=store --file=${credFile}`] : [];
      if (cred?.secret) {
        const host = cred.host?.trim() || hostFromUrl(gitUrl);
        const line = `https://${encodeURIComponent(cred.username || 'x-access-token')}:${encodeURIComponent(cred.secret)}@${host}\n`;
        await this.run('bash', ['-c', `umask 177 && cat > '${credFile}'`], workdir, env, line);
      }
      try {
        await this.run('git', [...helper, 'clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', gitUrl, repoDir], workdir, env);
      } catch (err) {
        if (!ref) throw err;
        await this.run('git', [...helper, 'clone', '--', gitUrl, repoDir], workdir, env);
        await this.run('git', ['-C', repoDir, 'checkout', ref], workdir, env);
      }
      const explicit = input.gitPath?.trim().replace(/^\/+/, '');
      let composePath: string | null = null;
      if (explicit) {
        if (await exists(join(repoDir, explicit))) composePath = explicit;
        else throw new BadRequestException(`No file at "${explicit}" in the repo.`);
      } else {
        for (const c of COMPOSE_CANDIDATES) if (await exists(join(repoDir, c))) { composePath = c; break; }
      }
      if (composePath) {
        const text = await readFile(join(repoDir, composePath), 'utf8');
        return { text, composePath, usesGeneratedCompose: false };
      }
      if (await exists(join(repoDir, 'Dockerfile'))) {
        const dockerfile = await readFile(join(repoDir, 'Dockerfile'), 'utf8');
        const wrapper = generateComposeWrapper(exposedPortOf(dockerfile) ?? 8080);
        return { text: wrapper, composePath: 'docker-compose.yml (generated)', usesGeneratedCompose: true };
      }
      throw new BadRequestException('No docker-compose.yml or Dockerfile found in the repository.');
    } catch (err) {
      const msg = redact(err instanceof Error ? err.message : 'Failed to read the repository.', cred);
      throw err instanceof BadRequestException ? new BadRequestException(msg) : new BadRequestException(`Could not read the compose file: ${msg}`);
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * The current commit at the tip of a repo's ref, without cloning
   * (`git ls-remote`). Used by the update-check sweep to tell whether a
   * deployment's repo has moved ahead of its deployed commit. Returns null on
   * any failure (unreachable/auth) — the caller treats that as "no update".
   */
  async remoteCommit(input: { gitUrl: string; gitRef?: string | null; gitCredKey?: string | null }): Promise<string | null> {
    let gitUrl: string;
    let ref: string;
    try { gitUrl = assertSafeGitUrl(input.gitUrl); ref = assertSafeGitRef(input.gitRef) || 'HEAD'; } catch { return null; }
    const cred = await this.resolveCred(input.gitCredKey);
    const workdir = await mkdtemp(join(tmpdir(), 'cerebro-lsremote-'));
    const credFile = join(workdir, '.gitcred');
    try {
      const env = gitSafeEnv({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true' });
      const helper = cred ? ['-c', `credential.helper=store --file=${credFile}`] : [];
      if (cred?.secret) {
        const host = cred.host?.trim() || hostFromUrl(gitUrl);
        const line = `https://${encodeURIComponent(cred.username || 'x-access-token')}:${encodeURIComponent(cred.secret)}@${host}\n`;
        await this.run('bash', ['-c', `umask 177 && cat > '${credFile}'`], workdir, env, line);
      }
      const out = await this.run('git', [...helper, 'ls-remote', gitUrl, ref], workdir, env);
      const sha = out.split(/\s+/)[0]?.trim() ?? '';
      return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
    } catch {
      return null;
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async resolveCred(credKey?: string | null): Promise<GitCredential | null> {
    if (!credKey) return null;
    const raw = await this.secrets.reveal(credKey).catch(() => null);
    if (!raw) return null;
    try { return JSON.parse(raw) as GitCredential; } catch { return { secret: raw }; }
  }

  /** Promise wrapper over execFile with a hard timeout; feeds optional stdin. */
  private run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(cmd, args, { cwd, env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || stdout || err.message).toString().trim()));
        else resolve(stdout.toString());
      });
      if (stdin != null) { child.stdin?.end(stdin); }
    });
  }
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(() => true).catch(() => false);
}

function hostFromUrl(url: string): string {
  try { return new URL(url).host; } catch { return url.match(/^https?:\/\/([^/]+)/i)?.[1] ?? ''; }
}

function redact(text: string, cred: GitCredential | null): string {
  if (!cred?.secret) return text;
  return (text || '').split(cred.secret).join('***');
}
