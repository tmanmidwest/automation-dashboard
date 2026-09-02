import type { MonitorInput } from '@cerebro/shared';

/**
 * Translate Uptime Kuma monitors into monitor inputs. Accepts either shape:
 *  - the 1.x backup JSON (`{ monitorList: [...] }`, camelCase keys), or
 *  - rows straight from Kuma's `monitor` table (snake_case columns) — what we
 *    read out of a 2.x `kuma.db`, or a `sqlite3 -json` dump of it.
 * Only the types we have probes for are mapped; the rest are reported back as
 * skipped so nothing silently disappears.
 */
export type KumaRow = Record<string, unknown>;

export function kumaToInputs(payload: unknown): { inputs: MonitorInput[]; skipped: { name: string; reason: string }[] } {
  const inputs: MonitorInput[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const root = (payload ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.monitorList) ? root.monitorList : Array.isArray(payload) ? payload : null;
  if (!list) throw new Error('Not a Kuma backup: expected a "monitorList" array (or an array of monitor rows).');

  for (const raw of list) {
    const m = (raw ?? {}) as KumaRow;
    const name = String(m.name ?? '').trim() || 'Imported monitor';
    const type = String(m.type ?? '');
    const interval = toInt(m.interval, 60);
    const common = {
      name,
      enabled: m.active === undefined || m.active === null ? true : truthy(m.active),
      intervalSec: interval,
      retries: toInt(m.maxretries, 0),
      retryIntervalSec: toInt(pick(m, 'retryInterval', 'retry_interval'), interval),
      timeoutSec: Math.max(1, Math.round(toNum(m.timeout, 10))),
      // Kuma's "resend interval" is a count of consecutive failures, like ours.
      resendEveryN: toInt(pick(m, 'resendInterval', 'resend_interval'), 0),
      upsideDown: truthy(pick(m, 'upsideDown', 'upside_down')),
      description: m.description ? String(m.description) : undefined,
      tags: kumaTags(m.tags),
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
            acceptedStatus: acceptedCodes(pick(m, 'accepted_statuscodes', 'accepted_statuscodes_json')),
            keyword: type === 'keyword' ? String(m.keyword ?? '') : '',
            keywordInvert: type === 'keyword' ? truthy(pick(m, 'invertKeyword', 'invert_keyword')) : false,
            ignoreTls: truthy(pick(m, 'ignoreTls', 'ignore_tls')),
            certExpiryDays: pick(m, 'expiryNotification', 'expiry_notification') === undefined
              ? 14
              : truthy(pick(m, 'expiryNotification', 'expiry_notification')) ? 14 : 0,
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
            recordType: String(pick(m, 'dns_resolve_type') ?? 'A').toUpperCase(),
            resolver: pick(m, 'dns_resolve_server') ? String(pick(m, 'dns_resolve_server')) : '',
            expected: '',
          },
        });
        break;
      case 'group':
        skipped.push({ name, reason: 'Groups are not supported; its child monitors were imported individually.' });
        break;
      default:
        skipped.push({ name, reason: `Monitor type "${type || 'unknown'}" is not supported.` });
    }
  }
  return { inputs, skipped };
}

function pick(m: KumaRow, ...keys: string[]): unknown {
  for (const k of keys) if (m[k] !== undefined && m[k] !== null) return m[k];
  return undefined;
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function toNum(v: unknown, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function toInt(v: unknown, dflt: number): number {
  return Math.round(toNum(v, dflt));
}

/** Accepted status codes arrive as an array (JSON export) or a JSON string (DB column). */
function acceptedCodes(v: unknown): string {
  let arr: unknown = v;
  if (typeof v === 'string') {
    try { arr = JSON.parse(v); } catch { arr = [v]; }
  }
  return Array.isArray(arr) && arr.length > 0 ? arr.map(String).join(', ') : '200-299';
}

/** Tags: JSON export gives [{name,value}], the DB reader hands us ["name:value"] strings. */
function kumaTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((t) => {
      if (typeof t === 'string') return t;
      const o = (t ?? {}) as Record<string, unknown>;
      return o.value ? `${o.name}:${o.value}` : String(o.name ?? '');
    })
    .filter(Boolean);
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
