import { BadRequestException } from '@nestjs/common';

/**
 * Hardening for every place Cerebro shells out to `git` with a user-supplied
 * repository URL (App Replicator introspect/update-check, Docker Git stacks, ECS
 * builder).
 *
 * Git's `ext::` and `fd::` "smart transports" — and `file://` — turn a repo URL
 * into arbitrary command execution (`ext::sh -c "…"`), which is remote code
 * execution on whatever host runs the git process (the Cerebro server for the
 * replicator paths, the Docker host for the stack paths). The authoritative
 * defense is `GIT_ALLOW_PROTOCOL`, enforced by git itself; `assertSafeGitUrl`
 * rejects the obvious cases early with a clear error, and callers must also place
 * `--` before the URL positional so a `-`-leading URL can't be read as a flag.
 */

/** Transports git is permitted to use. Everything else — notably ext, fd, file —
 *  is refused by git when GIT_ALLOW_PROTOCOL is set. */
export const GIT_ALLOWED_PROTOCOLS = 'https:http:ssh:git';

/** Env to merge into every git invocation (server-side execFile). */
export function gitSafeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, GIT_ALLOW_PROTOCOL: GIT_ALLOWED_PROTOCOLS, GIT_PROTOCOL_FROM_USER: '0' };
}

/** Shell prefix for git invoked over SSH on a remote host (runSsh). Applies the
 *  same protocol allow-list to every git command in the command list. */
export const GIT_SAFE_SH_PREFIX = `export GIT_ALLOW_PROTOCOL='${GIT_ALLOWED_PROTOCOLS}' GIT_PROTOCOL_FROM_USER=0;`;

/**
 * Reject dangerous git URLs early. The real enforcement is GIT_ALLOW_PROTOCOL;
 * this gives a friendly, fail-closed error before we ever spawn git. Returns the
 * trimmed URL for convenience.
 */
export function assertSafeGitUrl(url: string | null | undefined): string {
  const u = (url ?? '').trim();
  if (!u) throw new BadRequestException('A git repository URL is required.');
  if (u.startsWith('-')) throw new BadRequestException('Invalid git repository URL.');
  if (/^(?:ext|fd)::/i.test(u) || /^file:/i.test(u)) {
    throw new BadRequestException('Unsupported git URL scheme — only http, https, ssh and git are allowed.');
  }
  return u;
}

/**
 * Sanitize a git ref (branch/tag/commit). A ref is passed to `git checkout`/
 * `ls-remote`/`--branch` as a positional, where `--` can't shield it (for checkout
 * `--` marks a pathspec, not a ref), so a `-`-leading ref would be read as an
 * option (e.g. `--upload-pack=…`). Empty is allowed (caller falls back to HEAD).
 * Returns the trimmed ref.
 */
export function assertSafeGitRef(ref: string | null | undefined): string {
  const r = (ref ?? '').trim();
  if (r.startsWith('-')) throw new BadRequestException('Invalid git ref (cannot start with "-").');
  return r;
}
