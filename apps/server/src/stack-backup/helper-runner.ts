import { runSsh, type SshConfig, type SshResult } from '../connectors/docker/docker-ssh';

/**
 * Runs a short-lived helper container on a Docker host over SSH — the execution
 * engine behind `transfer: 'direct'` backups. The host's own Docker runs
 * `restic/restic` with the stack's volumes mounted read-only, so bulk data goes
 * straight from the host to the repository and never crosses Cerebro.
 *
 * SSH rather than the Engine API because it is one round-trip with a real exit
 * code and combined output for the run log, and because stack deploys already
 * require it. Phase 5 adds an Engine-API launcher for socket-proxy-only hosts.
 * See docs/stack-backup.md.
 */

export interface HelperMount {
  /** Named volume, or an absolute host path for a bind. */
  source: string;
  /** Absolute path inside the helper. */
  dest: string;
  kind: 'volume' | 'bind';
  readOnly: boolean;
}

export interface HelperRunInput {
  ssh: SshConfig;
  image: string;
  /** Passed via a stdin-fed --env-file, never on the command line. */
  env: Record<string, string>;
  mounts: HelperMount[];
  /** Arguments to the image's entrypoint (`restic` for restic/restic). */
  args: string[];
  timeoutMs?: number;
}

/** A volume name Docker will accept — keeps anything shell-ish out of the command. */
const VOLUME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Single-quote a value for /bin/sh. */
function q(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Reject anything that cannot be expressed safely in a shell command or an env file. */
function assertSafe(input: HelperRunInput): void {
  for (const m of input.mounts) {
    if (m.kind === 'volume') {
      if (!VOLUME_RE.test(m.source)) throw new Error(`Refusing to mount volume with an unexpected name: ${m.source}`);
    } else if (!m.source.startsWith('/') || m.source.includes('\n')) {
      throw new Error(`Refusing to mount bind path that is not a plain absolute path: ${m.source}`);
    }
    if (!m.dest.startsWith('/') || m.dest.includes('\n')) throw new Error(`Bad helper mount destination: ${m.dest}`);
  }
  for (const [k, v] of Object.entries(input.env)) {
    // docker --env-file is line-oriented with no escaping: a newline would split
    // one credential into two bogus variables.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Bad environment variable name: ${k}`);
    if (v.includes('\n')) throw new Error(`Environment value for ${k} contains a newline, which docker --env-file cannot carry.`);
  }
  if (!/^[\w./:@-]+$/.test(input.image)) throw new Error(`Refusing to run an unexpected helper image reference: ${input.image}`);
}

/**
 * Run the helper. Credentials are streamed over the SSH channel into a `mktemp`
 * file created under `umask 077`, handed to docker as `--env-file`, and removed
 * in the same command whatever the exit code — so they never appear in `argv`,
 * the host's process list, or shell history.
 */
export async function runHelper(input: HelperRunInput): Promise<SshResult> {
  assertSafe(input);

  const mountArgs = input.mounts
    .map((m) => `-v ${q(`${m.source}:${m.dest}${m.readOnly ? ':ro' : ''}`)}`)
    .join(' ');
  const cmd = [
    'umask 077',
    'f="$(mktemp /tmp/cerebro-backup.XXXXXX)"',
    'cat > "$f"',
    `docker run --rm --env-file "$f" ${mountArgs} ${q(input.image)} ${input.args.map(q).join(' ')}`,
    'rc=$?',
    'rm -f "$f"',
    'exit $rc',
  ].join('\n');

  const envFile = Object.entries(input.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  return runSsh(input.ssh, cmd, envFile, input.timeoutMs ?? 6 * 60 * 60 * 1000);
}

/**
 * Write the capture's metadata files into a fresh 0700 directory on the host and
 * return its path. The helper mounts this read-only so compose/manifest land in
 * the snapshot alongside the volume data.
 */
export async function writeHostDir(
  ssh: SshConfig,
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  if (!dir.startsWith('/var/tmp/') && !dir.startsWith('/tmp/')) {
    throw new Error(`Refusing to write a staging directory outside /tmp or /var/tmp: ${dir}`);
  }
  await runSsh(ssh, `umask 077; rm -rf ${q(dir)} && mkdir -p ${q(dir)}`);
  for (const [name, content] of Object.entries(files)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Bad metadata file name: ${name}`);
    // Content goes over stdin, so nothing in it is ever interpreted by the shell.
    const res = await runSsh(ssh, `umask 077; cat > ${q(`${dir}/${name}`)}`, content);
    if (res.code !== 0) throw new Error(`Could not write ${name} to the host: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
}

/**
 * Add files to a staging directory that already exists — hook output joins the
 * metadata that was staged before the hooks ran.
 */
export async function appendHostFiles(
  ssh: SshConfig,
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  if (!dir.startsWith('/var/tmp/') && !dir.startsWith('/tmp/')) {
    throw new Error(`Refusing to write into a directory outside /tmp or /var/tmp: ${dir}`);
  }
  for (const [name, content] of Object.entries(files)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Bad metadata file name: ${name}`);
    const res = await runSsh(ssh, `umask 077; cat > ${q(`${dir}/${name}`)}`, content);
    if (res.code !== 0) throw new Error(`Could not write ${name} to the host: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
}

/** Remove a staging directory written by {@link writeHostDir}. Best-effort. */
export async function removeHostDir(ssh: SshConfig, dir: string): Promise<void> {
  if (!dir.startsWith('/var/tmp/') && !dir.startsWith('/tmp/')) return;
  await runSsh(ssh, `rm -rf ${q(dir)}`).catch(() => { /* best-effort cleanup */ });
}
