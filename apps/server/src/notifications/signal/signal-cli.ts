import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Where signal-cli keeps its account state (keys, registration). This MUST be a
 * persistent volume in production, or the account is lost on every restart.
 * Passed to signal-cli as `--config` on every invocation.
 */
export const SIGNAL_CONFIG_DIR = process.env.SIGNAL_CLI_CONFIG || '/data/signal';

export class SignalError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SignalError';
  }
}

/** Turn a signal-cli failure into a short, human-readable message. */
function friendly(err: unknown): SignalError {
  const e = err as { code?: string | number; stderr?: string; message?: string } | undefined;
  const stderr = (e?.stderr || '').toString();
  const msg = stderr || e?.message || String(err);
  if ((e?.code as string) === 'ENOENT' && /signal-cli/.test(e?.message || String(err))) {
    return new SignalError('signal-cli is not installed in the server image.', 'ENOENT');
  }
  if (/captcha/i.test(msg)) {
    return new SignalError('Signal requires a captcha token to continue.', 'captcha');
  }
  if (/rate.?limit|\b429\b|too many/i.test(msg)) {
    return new SignalError('Signal is rate-limiting requests — wait a while and retry.', 'ratelimit');
  }
  if (/invalid verification code|verification failed|incorrect/i.test(msg)) {
    return new SignalError('The verification code was rejected.', 'verify');
  }
  if (/not registered|unregistered|no such account/i.test(msg)) {
    return new SignalError('That Signal account is not registered on this server.', 'unregistered');
  }
  if (/UnknownGroup|group not found/i.test(msg)) {
    return new SignalError('Unknown Signal group id.', 'group');
  }
  const first =
    msg
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)[0] || 'signal-cli command failed.';
  return new SignalError(first);
}

/**
 * Thin wrapper around the bundled `signal-cli` binary (same shell-out approach
 * as the restic connector). Every call is a fresh, short-lived invocation — no
 * daemon to babysit — which suits low-frequency alerting. State lives in
 * `--config <dir>` on a persistent volume.
 */
export class SignalCli {
  constructor(private readonly configDir: string = SIGNAL_CONFIG_DIR) {}

  private base(): string[] {
    return ['--config', this.configDir];
  }

  private async run(args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> {
    try {
      const { stdout } = await execFileAsync('signal-cli', [...this.base(), ...args], { maxBuffer });
      return stdout;
    } catch (err) {
      throw friendly(err);
    }
  }

  /** Version string — also a cheap "is the binary present" probe. */
  async version(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('signal-cli', ['--version'], { maxBuffer: 1 << 20 });
      return stdout.trim();
    } catch (err) {
      throw friendly(err);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.version();
      return true;
    } catch {
      return false;
    }
  }

  /** Registered/linked accounts (E.164 numbers) known to this signal-cli config. */
  async listAccounts(): Promise<string[]> {
    let raw = '';
    try {
      raw = await this.run(['-o', 'json', 'listAccounts']);
    } catch {
      try {
        raw = await this.run(['listAccounts']);
      } catch {
        return [];
      }
    }
    const nums = new Set<string>();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const a of parsed) {
          const n = a?.number ?? a?.account;
          if (typeof n === 'string') nums.add(n);
        }
      }
    } catch {
      /* not JSON — fall through to regex scan */
    }
    for (const m of raw.matchAll(/\+\d{6,15}/g)) nums.add(m[0]);
    return [...nums];
  }

  /** Request registration of a fresh number (SMS by default). Captcha may be required. */
  async register(number: string, opts: { voice?: boolean; captcha?: string } = {}): Promise<void> {
    const args = ['-a', number, 'register'];
    if (opts.voice) args.push('--voice');
    if (opts.captcha) args.push('--captcha', opts.captcha);
    await this.run(args);
  }

  /** Complete registration with the SMS/voice code (and PIN if the number has one). */
  async verify(number: string, code: string, pin?: string): Promise<void> {
    const args = ['-a', number, 'verify', code];
    if (pin) args.push('--pin', pin);
    await this.run(args);
  }

  /** Send a message from `account` to each recipient (E.164 number or `group.<id>`). */
  async send(account: string, recipients: string[], message: string): Promise<void> {
    const numbers = recipients.filter((r) => !r.startsWith('group.'));
    const groups = recipients.filter((r) => r.startsWith('group.'));
    if (numbers.length) {
      await this.run(['-a', account, 'send', '-m', message, ...numbers], 8 * 1024 * 1024);
    }
    for (const g of groups) {
      await this.run(['-a', account, 'send', '-m', message, '-g', g], 8 * 1024 * 1024);
    }
  }

  /**
   * Link this server as a secondary device to an existing Signal account.
   * Spawns the (blocking) `signal-cli link`, delivers the linking URI via
   * `onUri` (render it as a QR the phone scans under Signal → Linked devices),
   * and resolves once the phone confirms. Rejects on error or timeout.
   */
  link(deviceName: string, onUri: (uri: string) => void, timeoutMs = 5 * 60 * 1000): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('signal-cli', [...this.base(), 'link', '-n', deviceName]);
      let acc = '';
      let stderr = '';
      let sawUri = false;
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        settle(() => reject(new SignalError('Linking timed out — the QR was not scanned in time.', 'timeout')));
      }, timeoutMs);

      const scanForUri = () => {
        if (sawUri) return;
        const m = acc.match(/(sgnl:\/\/linkdevice\?\S+|tsdevice:\/?\?\S+)/);
        if (m) {
          sawUri = true;
          onUri(m[1].trim());
        }
      };

      child.stdout.on('data', (d: Buffer) => {
        acc += d.toString();
        scanForUri();
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      child.on('error', (err) => settle(() => reject(friendly(err))));
      child.on('close', (code) => {
        scanForUri();
        if (code === 0) settle(resolve);
        else settle(() => reject(friendly({ code: code ?? undefined, stderr })));
      });
    });
  }
}
