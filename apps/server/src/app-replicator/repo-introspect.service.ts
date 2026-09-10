import { BadRequestException, Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsService } from '../secrets/secrets.service';
import type { GitCredential, IntrospectRepoInput, IntrospectResult } from '@cerebro/shared';
import { introspectCompose, generateComposeWrapper, exposedPortOf } from './compose-introspect';

/** Standard compose filenames to auto-detect when no explicit path is given. */
const COMPOSE_CANDIDATES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

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
    const gitUrl = input.gitUrl?.trim();
    if (!gitUrl) throw new BadRequestException('A git repository URL is required.');
    const ref = input.gitRef?.trim() || '';

    const cred = await this.resolveCred(input.gitCredKey);
    const workdir = await mkdtemp(join(tmpdir(), 'cerebro-replicator-'));
    const credFile = join(workdir, '.gitcred');
    const repoDir = join(workdir, 'repo');

    try {
      const env = {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0', // never block on an interactive auth prompt
        GIT_ASKPASS: '/bin/true',
      };
      const helper = cred ? ['-c', `credential.helper=store --file=${credFile}`] : [];
      if (cred?.secret) {
        const host = cred.host?.trim() || hostFromUrl(gitUrl);
        const line = `https://${encodeURIComponent(cred.username || 'x-access-token')}:${encodeURIComponent(cred.secret)}@${host}\n`;
        await this.run('bash', ['-c', `umask 177 && cat > '${credFile}'`], workdir, env, line);
      }

      // Shallow clone at the ref. A ref that's a commit SHA can't be --branch'd,
      // so fall back to a default clone + checkout.
      try {
        await this.run('git', [...helper, 'clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), gitUrl, repoDir], workdir, env);
      } catch (err) {
        if (!ref) throw err;
        await this.run('git', [...helper, 'clone', gitUrl, repoDir], workdir, env);
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
        return { ...parsed, composePath, usesGeneratedCompose: false };
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
        return { ...parsed, composePath: 'docker-compose.yml (generated)', usesGeneratedCompose: true };
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
   * The current commit at the tip of a repo's ref, without cloning
   * (`git ls-remote`). Used by the update-check sweep to tell whether a
   * deployment's repo has moved ahead of its deployed commit. Returns null on
   * any failure (unreachable/auth) — the caller treats that as "no update".
   */
  async remoteCommit(input: { gitUrl: string; gitRef?: string | null; gitCredKey?: string | null }): Promise<string | null> {
    const gitUrl = input.gitUrl?.trim();
    if (!gitUrl) return null;
    const ref = input.gitRef?.trim() || 'HEAD';
    const cred = await this.resolveCred(input.gitCredKey);
    const workdir = await mkdtemp(join(tmpdir(), 'cerebro-lsremote-'));
    const credFile = join(workdir, '.gitcred');
    try {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true' };
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
