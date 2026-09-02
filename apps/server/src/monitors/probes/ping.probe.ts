import { execFile } from 'child_process';
import type { Probe, ProbeConfig, ProbeResult } from './probe';
import { str } from './probe';

/**
 * ICMP echo via the system `ping` binary (the same approach Uptime Kuma uses).
 * In Docker this needs iputils-ping in the image and CAP_NET_RAW on the
 * container — both are set in the Dockerfile / compose file.
 */
export class PingProbe implements Probe {
  readonly manifest = {
    id: 'ping',
    label: 'Ping',
    description: 'ICMP echo to a hostname or IP address.',
    icon: 'ping',
    fields: [
      { key: 'host', label: 'Hostname or IP', type: 'text' as const, required: true, placeholder: '10.0.0.5 or nas.local' },
    ],
  };

  describeTarget(config: ProbeConfig): string {
    return str(config, 'host');
  }

  validate(config: ProbeConfig): string | null {
    const host = str(config, 'host');
    if (!host) return 'Hostname is required.';
    if (/[\s;&|`$]/.test(host)) return 'Hostname contains invalid characters.';
    return null;
  }

  run(config: ProbeConfig, timeoutMs: number): Promise<ProbeResult> {
    const host = str(config, 'host');
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
    // Linux (iputils): -W = seconds to wait for a reply. macOS/BSD: -t = overall timeout.
    const args =
      process.platform === 'darwin'
        ? ['-c', '1', '-t', String(secs), host]
        : ['-c', '1', '-W', String(secs), '-n', host];
    const started = Date.now();
    return new Promise((resolve) => {
      execFile('ping', args, { timeout: timeoutMs + 1000 }, (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`;
        const m = /time[=<]\s*([\d.]+)\s*ms/i.exec(out);
        const latencyMs = m ? Math.round(parseFloat(m[1])) : Date.now() - started;
        if (!err) return resolve({ ok: true, latencyMs, message: `Reply in ${latencyMs} ms` });
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return resolve({ ok: false, message: 'ping binary not found on server' });
        }
        // Exit 1 = no reply; 2 = resolution or socket error (message in stderr).
        const detail = (stderr || stdout).split('\n').map((s) => s.trim()).filter(Boolean).pop();
        const permission = /operation not permitted|socket/i.test(out)
          ? ' (container may lack CAP_NET_RAW)'
          : '';
        resolve({ ok: false, message: (detail && !/packets transmitted/.test(detail) ? detail : 'No reply') + permission });
      });
    });
  }
}
