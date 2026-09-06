import { Client } from 'ssh2';

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  /** Provide a private key OR a password. */
  privateKey?: string;
  passphrase?: string;
  password?: string;
}

export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one command over SSH, optionally feeding `stdin` (used to write a compose
 * file via `cat >`). Resolves with the exit code + captured output; rejects on a
 * connection/auth failure. Pure transport — the caller decides what a non-zero
 * exit means. See docs/connectors/docker.md (Phase 5).
 */
export function runSsh(cfg: SshConfig, command: string, stdin?: string, timeoutMs = 120_000): Promise<SshResult> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      try { conn.end(); } catch { /* ignore */ }
    };
    const timer = setTimeout(() => finish(() => reject(new Error('SSH command timed out.'))), timeoutMs);

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); return finish(() => reject(err)); }
        let stdout = '';
        let stderr = '';
        stream.on('close', (code: number | null) => {
          clearTimeout(timer);
          finish(() => resolve({ code: code ?? 0, stdout, stderr }));
        });
        stream.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        if (stdin != null) stream.end(stdin);
      });
    });
    conn.on('error', (err) => { clearTimeout(timer); finish(() => reject(new Error(friendly(err)))); });
    // Answer keyboard-interactive prompts with the password (common sshd config).
    if (cfg.password) {
      conn.on('keyboard-interactive', (_name, _instr, _lang, _prompts, cb) => cb([cfg.password!]));
    }

    try {
      conn.connect({
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        privateKey: cfg.privateKey || undefined,
        passphrase: cfg.passphrase || undefined,
        password: cfg.password || undefined,
        // Allow keyboard-interactive too, since many sshd setups answer password
        // prompts that way rather than the plain 'password' method.
        tryKeyboard: !!cfg.password,
        readyTimeout: 20_000,
        // Note: host keys are not pinned (homelab default). Trust the network path.
      });
    } catch (err) {
      clearTimeout(timer);
      finish(() => reject(new Error(friendly(err as Error))));
    }
  });
}

function friendly(err: Error & { level?: string; code?: string }): string {
  const msg = err.message || String(err);
  if (err.level === 'client-authentication' || /authentication/i.test(msg)) {
    return 'SSH authentication failed — check the username and private key.';
  }
  if (err.code === 'ECONNREFUSED') return 'SSH connection refused — check the host and port.';
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return 'SSH host could not be resolved.';
  if (/timed out/i.test(msg)) return 'SSH connection timed out.';
  return `SSH error: ${msg}`;
}
