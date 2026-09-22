import { Client } from 'ssh2';
import { createHash } from 'crypto';

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  /** Provide a private key OR a password. */
  privateKey?: string;
  passphrase?: string;
  password?: string;
  /** TOFU host-key check: given the server key's sha256 (base64), resolve true to
   *  accept, false to refuse. Omit to skip verification (legacy behavior). */
  verifyHostKey?: (fingerprint: string) => boolean | Promise<boolean>;
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
        // TOFU host-key pinning when a verifier is supplied: refuse a changed key
        // (MITM / rebuilt host) instead of trusting the network path.
        hostVerifier: cfg.verifyHostKey
          ? (key: Buffer, cb: (ok: boolean) => void) => {
              const fp = createHash('sha256').update(key).digest('base64');
              Promise.resolve(cfg.verifyHostKey!(fp)).then((ok) => cb(ok)).catch(() => cb(false));
            }
          : undefined,
      });
    } catch (err) {
      clearTimeout(timer);
      finish(() => reject(new Error(friendly(err as Error))));
    }
  });
}

function friendly(err: Error & { level?: string; code?: string }): string {
  const msg = err.message || String(err);
  if (/host.*verif|verification failed/i.test(msg)) {
    return 'SSH host key mismatch — refusing to connect (possible MITM, or the host was rebuilt). If the host legitimately changed, clear its pinned key and reconnect.';
  }
  if (err.level === 'client-authentication' || /authentication/i.test(msg)) {
    return 'SSH authentication failed — check the username and private key.';
  }
  if (err.code === 'ECONNREFUSED') return 'SSH connection refused — check the host and port.';
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return 'SSH host could not be resolved.';
  if (/timed out/i.test(msg)) return 'SSH connection timed out.';
  return `SSH error: ${msg}`;
}
