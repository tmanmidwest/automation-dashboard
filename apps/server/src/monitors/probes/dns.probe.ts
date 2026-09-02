import { Resolver } from 'dns/promises';
import type { Probe, ProbeConfig, ProbeResult } from './probe';
import { errMessage, str } from './probe';

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'] as const;
type RecordType = (typeof RECORD_TYPES)[number];

/** DNS resolution check with an optional expected answer. */
export class DnsProbe implements Probe {
  readonly manifest = {
    id: 'dns',
    label: 'DNS',
    description: 'Resolve a name and optionally verify the answer.',
    icon: 'dns',
    fields: [
      { key: 'hostname', label: 'Hostname', type: 'text' as const, required: true, placeholder: 'example.com' },
      {
        key: 'recordType', label: 'Record type', type: 'select' as const, default: 'A',
        options: RECORD_TYPES.map((t) => ({ label: t, value: t })),
      },
      { key: 'resolver', label: 'Resolver', type: 'text' as const, placeholder: '1.1.1.1', help: 'DNS server to query. Blank uses the system resolver.' },
      { key: 'expected', label: 'Expected answer', type: 'text' as const, placeholder: '93.184.216.34', help: 'Optional. Down unless one record contains this text.' },
    ],
  };

  describeTarget(config: ProbeConfig): string {
    return `${str(config, 'recordType') || 'A'} ${str(config, 'hostname')}`;
  }

  validate(config: ProbeConfig): string | null {
    if (!str(config, 'hostname')) return 'Hostname is required.';
    const t = str(config, 'recordType') || 'A';
    if (!RECORD_TYPES.includes(t as RecordType)) return 'Unsupported record type.';
    return null;
  }

  async run(config: ProbeConfig, timeoutMs: number): Promise<ProbeResult> {
    const hostname = str(config, 'hostname');
    const type = (str(config, 'recordType') || 'A') as RecordType;
    const server = str(config, 'resolver');
    const expected = str(config, 'expected');
    const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
    if (server) {
      try {
        resolver.setServers([server]);
      } catch (err) {
        return { ok: false, message: `Bad resolver: ${errMessage(err)}` };
      }
    }
    const started = Date.now();
    try {
      const raw = await resolver.resolve(hostname, type);
      const latencyMs = Date.now() - started;
      const answers = flatten(raw);
      if (answers.length === 0) return { ok: false, latencyMs, message: 'No records returned' };
      if (expected && !answers.some((a) => a.toLowerCase().includes(expected.toLowerCase()))) {
        return { ok: false, latencyMs, message: `Expected "${expected}", got ${answers.join(', ')}` };
      }
      return { ok: true, latencyMs, message: `${answers.slice(0, 3).join(', ')}${answers.length > 3 ? ', …' : ''} in ${latencyMs} ms` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, message: errMessage(err) };
    }
  }
}

/** Normalize the various dns.resolve() shapes into display strings. */
function flatten(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    if (typeof r === 'string') return r;
    if (Array.isArray(r)) return r.join('');
    if (r && typeof r === 'object') {
      const o = r as Record<string, unknown>;
      if ('exchange' in o) return `${o.priority} ${o.exchange}`;
      return Object.values(o).join(' ');
    }
    return String(r);
  });
}
