import * as net from 'net';
import type { Probe, ProbeConfig, ProbeResult } from './probe';
import { errMessage, num, str } from './probe';

/** TCP connect check — "is something listening on host:port". */
export class TcpProbe implements Probe {
  readonly manifest = {
    id: 'tcp',
    label: 'TCP Port',
    description: 'Open a TCP connection to a host and port.',
    icon: 'tcp',
    fields: [
      { key: 'host', label: 'Hostname or IP', type: 'text' as const, required: true, placeholder: '10.0.0.5' },
      { key: 'port', label: 'Port', type: 'number' as const, required: true, placeholder: '22' },
    ],
  };

  describeTarget(config: ProbeConfig): string {
    return `${str(config, 'host')}:${num(config, 'port', 0)}`;
  }

  validate(config: ProbeConfig): string | null {
    if (!str(config, 'host')) return 'Hostname is required.';
    const port = num(config, 'port', 0);
    if (port < 1 || port > 65535) return 'Port must be between 1 and 65535.';
    return null;
  }

  run(config: ProbeConfig, timeoutMs: number): Promise<ProbeResult> {
    const host = str(config, 'host');
    const port = num(config, 'port', 0);
    const started = Date.now();
    return new Promise((resolve) => {
      const sock = net.connect({ host, port });
      const done = (r: ProbeResult) => {
        sock.destroy();
        resolve(r);
      };
      sock.setTimeout(timeoutMs, () => done({ ok: false, message: 'Timed out' }));
      sock.once('connect', () => {
        const latencyMs = Date.now() - started;
        done({ ok: true, latencyMs, message: `Connected in ${latencyMs} ms` });
      });
      sock.once('error', (err) => done({ ok: false, message: errMessage(err) }));
    });
  }
}
