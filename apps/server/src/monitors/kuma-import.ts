import type { MonitorInput } from '@cerebro/shared';

/**
 * Translate an Uptime Kuma backup export (Settings → Backup → Export, 1.x)
 * into monitor inputs. Only the types we have probes for are mapped; the rest
 * are reported back as skipped so nothing silently disappears.
 */
export function kumaToInputs(payload: unknown): { inputs: MonitorInput[]; skipped: { name: string; reason: string }[] } {
  const inputs: MonitorInput[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const root = (payload ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.monitorList) ? root.monitorList : Array.isArray(payload) ? payload : null;
  if (!list) throw new Error('Not a Kuma backup: expected a "monitorList" array.');

  for (const raw of list) {
    const m = (raw ?? {}) as Record<string, unknown>;
    const name = String(m.name ?? '').trim() || 'Imported monitor';
    const type = String(m.type ?? '');
    const common = {
      name,
      enabled: m.active === undefined ? true : !!m.active,
      intervalSec: toInt(m.interval, 60),
      retries: toInt(m.maxretries, 0),
      retryIntervalSec: toInt(m.retryInterval, toInt(m.interval, 60)),
      timeoutSec: Math.max(1, Math.round(toNum(m.timeout, 10))),
      // Kuma stores resend as an interval of beats too.
      resendEveryN: toInt(m.resendInterval, 0),
      upsideDown: !!m.upsideDown,
      description: m.description ? String(m.description) : undefined,
      tags: Array.isArray(m.tags)
        ? (m.tags as Record<string, unknown>[]).map((t) => (t.value ? `${t.name}:${t.value}` : String(t.name ?? ''))).filter(Boolean)
        : [],
    };

    switch (type) {
      case 'http':
      case 'keyword':
      case 'json-query':
        inputs.push({
          ...common,
          type: 'http',
          config: {
            url: String(m.url ?? ''),
            method: String(m.method ?? 'GET').toUpperCase(),
            acceptedStatus: Array.isArray(m.accepted_statuscodes) ? m.accepted_statuscodes.join(', ') : '200-299',
            keyword: type === 'keyword' ? String(m.keyword ?? '') : '',
            keywordInvert: type === 'keyword' ? !!m.invertKeyword : false,
            ignoreTls: !!m.ignoreTls,
            certExpiryDays: m.expiryNotification === false ? 0 : 14,
            maxRedirects: toInt(m.maxredirects, 10),
            headers: kumaHeaders(m.headers),
            body: m.body ? String(m.body) : '',
          },
        });
        if (type === 'json-query') skipped.push({ name, reason: 'Imported as plain HTTP — JSON query conditions are not supported yet.' });
        break;
      case 'ping':
        inputs.push({ ...common, type: 'ping', config: { host: String(m.hostname ?? '') } });
        break;
      case 'port':
        inputs.push({ ...common, type: 'tcp', config: { host: String(m.hostname ?? ''), port: toInt(m.port, 0) } });
        break;
      case 'dns':
        inputs.push({
          ...common,
          type: 'dns',
          config: {
            hostname: String(m.hostname ?? ''),
            recordType: String(m.dns_resolve_type ?? 'A').toUpperCase(),
            resolver: m.dns_resolve_server ? String(m.dns_resolve_server) : '',
            expected: '',
          },
        });
        break;
      default:
        skipped.push({ name, reason: `Monitor type "${type || 'unknown'}" is not supported.` });
    }
  }
  return { inputs, skipped };
}

function toNum(v: unknown, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function toInt(v: unknown, dflt: number): number {
  return Math.round(toNum(v, dflt));
}

/** Kuma stores headers as a JSON object string; we use "Name: value" lines. */
function kumaHeaders(v: unknown): string {
  if (!v) return '';
  try {
    const obj = typeof v === 'string' ? JSON.parse(v) : v;
    if (obj && typeof obj === 'object') {
      return Object.entries(obj as Record<string, unknown>).map(([k, val]) => `${k}: ${val}`).join('\n');
    }
  } catch {
    /* fall through */
  }
  return String(v);
}
