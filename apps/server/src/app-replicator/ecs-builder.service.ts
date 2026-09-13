import { BadRequestException, Injectable } from '@nestjs/common';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { SecretsService } from '../secrets/secrets.service';
import { runSsh } from '../connectors/docker/docker-ssh';
import { dockerTargetFrom, type DockerTarget } from './docker-target';
import type { GitCredential } from '@cerebro/shared';

const GIT_TIMEOUT_MS = 5 * 60_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;
const PUSH_TIMEOUT_MS = 20 * 60_000;

/** Single-quote a value for a bash command (wrap and escape embedded quotes). */
const sq = (s: string) => String(s).replace(/'/g, `'\\''`);
const trimSlash = (s: string) => s.replace(/\/+$/, '');
const tail = (s: string, n: number) => (s || '').slice(-n).trim();
function hostFromUrl(url: string): string {
  try { return new URL(url).host; } catch { return url.match(/^https?:\/\/([^/]+)/i)?.[1] ?? ''; }
}

export interface BuildAndPushInput {
  /** Docker connector instance whose host runs the build. */
  builderInstanceId: string;
  project: string;
  source: { gitUrl: string; gitRef: string | null; gitPath: string | null; credKey: string | null };
  /** Full image reference to build + push, e.g. <acct>.dkr.ecr.<region>.amazonaws.com/cerebro/foo:<tag>. */
  imageRef: string;
  /** ECR registry login (from the connector's ecr-auth-token op). */
  registryEndpoint: string;
  username: string;
  password: string;
  forceRebuild?: boolean;
}

/**
 * Builds an app's image on an existing Docker connector host over SSH and pushes
 * it to ECR — the App Replicator's ECS target has no build farm of its own, so it
 * borrows a Docker host as the builder (reusing the connector's SSH transport).
 * Mirrors DockerStackService.deployGit's clone/credential handling. See
 * docs/app-replicator-ecs-target.md.
 */
@Injectable()
export class EcsBuilderService {
  constructor(
    private readonly instances: ConnectorInstanceService,
    private readonly secrets: SecretsService,
  ) {}

  private async builderTarget(instanceId: string): Promise<DockerTarget> {
    const instance = await this.instances.get(instanceId).catch(() => null);
    if (!instance) throw new BadRequestException('The image builder Docker connector no longer exists.');
    if (instance.connectorId !== 'docker') throw new BadRequestException('The configured image builder is not a Docker connector.');
    const ctx = await this.instances.contextFor(instance);
    const target = dockerTargetFrom(ctx);
    if (!target.deployable) throw new BadRequestException('The image builder Docker connector has no SSH configured.');
    return target;
  }

  async buildAndPush(input: BuildAndPushInput, onPhase: (phase: string) => void): Promise<{ commit: string | null }> {
    const target = await this.builderTarget(input.builderInstanceId);
    const ssh = target.ssh;
    const base = `${trimSlash(target.stacksDir)}/.replicator-ecs/${input.project}`;
    const dir = `${base}/repo`;
    const credFile = `${base}/.gitcred`;
    const relCompose = (input.source.gitPath?.trim() || 'docker-compose.yml').replace(/^\/+/, '');
    // Build context = the directory holding the compose file (repo root for a top-level compose).
    const composeFile = `${dir}/${relCompose}`;
    const contextDir = composeFile.replace(/\/[^/]*$/, '') || dir;
    const ref = input.source.gitRef?.trim();

    let cred: GitCredential | null = null;
    if (input.source.credKey) {
      const raw = await this.secrets.reveal(input.source.credKey).catch(() => null);
      if (raw) { try { cred = JSON.parse(raw) as GitCredential; } catch { cred = { secret: raw }; } }
    }
    const helper = cred ? `-c credential.helper='store --file=${credFile}'` : '';
    const redact = (s: string) => (cred?.secret ? (s || '').split(cred.secret).join('***') : s);

    try {
      await runSsh(ssh, `mkdir -p '${base}'`);
      if (cred?.secret) {
        const host = cred.host?.trim() || hostFromUrl(input.source.gitUrl);
        const line = `https://${encodeURIComponent(cred.username || 'x-access-token')}:${encodeURIComponent(cred.secret)}@${host}\n`;
        const w = await runSsh(ssh, `cat > '${credFile}' && chmod 600 '${credFile}'`, line);
        if (w.code !== 0) throw new Error('Failed to write git credentials on the builder host.');
      }

      const isRepo = (await runSsh(ssh, `test -d '${dir}/.git' && echo yes || echo no`)).stdout.trim() === 'yes';
      onPhase(isRepo ? 'Updating repository…' : 'Cloning repository…');
      const g = isRepo
        ? await runSsh(ssh, `git -C '${dir}' ${helper} fetch --all --prune && git -C '${dir}' checkout ${ref ? `'${sq(ref)}'` : 'HEAD'} && git -C '${dir}' ${helper} reset --hard ${ref ? `'origin/${sq(ref)}'` : '@{u}'} 2>/dev/null || git -C '${dir}' ${helper} pull --ff-only`, undefined, GIT_TIMEOUT_MS)
        : await runSsh(ssh, `rm -rf '${dir}' && git ${helper} clone ${ref ? `--branch '${sq(ref)}'` : ''} '${sq(input.source.gitUrl)}' '${dir}'`, undefined, GIT_TIMEOUT_MS);
      if (g.code !== 0) throw new Error(`Git ${isRepo ? 'update' : 'clone'} failed: ${redact(tail(g.stderr || g.stdout, 2000))}`);

      onPhase('Logging in to ECR…');
      const login = await runSsh(ssh, `docker login --username '${sq(input.username)}' --password-stdin '${sq(input.registryEndpoint)}'`, `${input.password}\n`);
      if (login.code !== 0) throw new Error(`docker login to ECR failed: ${tail(login.stderr || login.stdout, 1000)}`);

      onPhase('Building image…');
      const noCache = input.forceRebuild ? '--no-cache --pull ' : '';
      const b = await runSsh(ssh, `docker build ${noCache}-t '${sq(input.imageRef)}' '${contextDir}'`, undefined, BUILD_TIMEOUT_MS);
      if (b.code !== 0) throw new Error(`Image build failed: ${tail(b.stderr || b.stdout, 3000)}`);

      onPhase('Pushing to ECR…');
      const p = await runSsh(ssh, `docker push '${sq(input.imageRef)}'`, undefined, PUSH_TIMEOUT_MS);
      if (p.code !== 0) throw new Error(`docker push failed: ${tail(p.stderr || p.stdout, 2000)}`);

      const commit = (await runSsh(ssh, `git -C '${dir}' rev-parse HEAD`).catch(() => null))?.stdout.trim() || null;
      return { commit: commit && /^[0-9a-f]{40}$/i.test(commit) ? commit : null };
    } finally {
      await runSsh(ssh, `rm -f '${credFile}'`).catch(() => { /* best-effort */ });
      // Reclaim the local build image so the builder host doesn't accumulate layers.
      await runSsh(ssh, `docker image rm '${sq(input.imageRef)}' 2>/dev/null || true`).catch(() => {});
    }
  }
}
