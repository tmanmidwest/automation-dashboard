import * as http from 'http';
import * as https from 'https';
import type { TLSSocket } from 'tls';
import type { Probe, ProbeConfig, ProbeResult, ProbeCert } from './probe';
import { bool, errMessage, num, str } from './probe';

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const MAX_BODY = 1024 * 1024; // only read up to 1 MB when keyword-matching

/**
 * HTTP(S) check: status code in an accepted set, optional keyword match on the
 * body, redirects followed, and the TLS certificate captured for expiry alerts.
 */
export class HttpProbe implements Probe {
  readonly manifest = {
    id: 'http',
    label: 'HTTP(s)',
    description: 'Fetch a URL and check the status code, and optionally a keyword in the body.',
    icon: 'http',
    fields: [
      { key: 'url', label: 'URL', type: 'url' as const, required: true, placeholder: 'https://example.com/health' },
      {
        key: 'method', label: 'Method', type: 'select' as const, default: 'GET',
        options: METHODS.map((m) => ({ label: m, value: m })),
      },
      { key: 'acceptedStatus', label: 'Accepted status codes', type: 'text' as const, default: '200-299', help: 'Comma-separated codes or ranges, e.g. 200-299, 301.' },
      { key: 'keyword', label: 'Keyword', type: 'text' as const, help: 'Optional. Down unless the response body contains this text.' },
      { key: 'keywordInvert', label: 'Invert keyword', type: 'boolean' as const, help: 'Down if the keyword IS present.' },
      { key: 'ignoreTls', label: 'Ignore TLS errors', type: 'boolean' as const, help: 'Accept self-signed or expired certificates.' },
      { key: 'certExpiryDays', label: 'Certificate expiry warning (days)', type: 'number' as const, default: 14, help: 'Alert when the TLS certificate expires within this many days. 0 disables.' },
      { key: 'maxRedirects', label: 'Max redirects', type: 'number' as const, default: 10 },
      { key: 'headers', label: 'Request headers', type: 'textarea' as const, placeholder: 'Authorization: Bearer …\nAccept: application/json', help: 'One "Name: value" per line.' },
      { key: 'body', label: 'Request body', type: 'textarea' as const, help: 'Sent with POST/PUT/PATCH.' },
    ],
  };

  describeTarget(config: ProbeConfig): string {
    return str(config, 'url');
  }

  validate(config: ProbeConfig): string | null {
    const url = str(config, 'url');
    if (!url) return 'URL is required.';
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'URL must start with http:// or https://.';
    } catch {
      return 'URL is not valid.';
    }
    if (parseAccepted(str(config, 'acceptedStatus') || '200-299').length === 0) {
      return 'Accepted status codes are not valid.';
    }
    const method = str(config, 'method') || 'GET';
    if (!METHODS.includes(method)) return 'Unsupported HTTP method.';
    return null;
  }

  async run(config: ProbeConfig, timeoutMs: number): Promise<ProbeResult> {
    const method = str(config, 'method') || 'GET';
    const accepted = parseAccepted(str(config, 'acceptedStatus') || '200-299');
    const keyword = str(config, 'keyword');
    const invert = bool(config, 'keywordInvert');
    const ignoreTls = bool(config, 'ignoreTls');
    const maxRedirects = Math.max(0, num(config, 'maxRedirects', 10));
    const headers = parseHeaders(str(config, 'headers'));
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? str(config, 'body') : '';
    const wantBody = !!keyword;
    const deadline = Date.now() + timeoutMs;

    let url = str(config, 'url');
    let cert: ProbeCert | undefined;
    const started = Date.now();
    try {
      for (let hop = 0; ; hop++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { ok: false, message: 'Timed out', cert };
        const res = await fetchOnce(url, { method, headers, body, ignoreTls, wantBody, timeoutMs: remaining });
        cert = res.cert ?? cert;
        if (res.status >= 300 && res.status < 400 && res.location) {
          if (hop >= maxRedirects) {
            return { ok: false, latencyMs: Date.now() - started, message: `Too many redirects (${hop + 1})`, cert };
          }
          url = new URL(res.location, url).toString();
          continue;
        }
        const latencyMs = Date.now() - started;
        const statusText = `${res.status} ${res.statusMessage}`.trim();
        if (!accepted.some(([lo, hi]) => res.status >= lo && res.status <= hi)) {
          return { ok: false, latencyMs, message: `Unexpected status ${statusText}`, cert };
        }
        if (keyword) {
          const found = res.body.includes(keyword);
          if (found === invert) {
            return {
              ok: false, latencyMs, cert,
              message: invert ? `Keyword "${keyword}" present` : `Keyword "${keyword}" not found`,
            };
          }
        }
        return { ok: true, latencyMs, message: `${statusText} in ${latencyMs} ms`, cert };
      }
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, message: errMessage(err), cert };
    }
  }
}

interface FetchOpts {
  method: string;
  headers: Record<string, string>;
  body: string;
  ignoreTls: boolean;
  wantBody: boolean;
  timeoutMs: number;
}

interface FetchResult {
  status: number;
  statusMessage: string;
  location?: string;
  body: string;
  cert?: ProbeCert;
}

function fetchOnce(url: string, o: FetchOpts): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      {
        method: o.method,
        headers: { 'user-agent': 'Cerebro-Monitor/1.0', accept: '*/*', ...o.headers },
        rejectUnauthorized: !o.ignoreTls,
        timeout: o.timeoutMs,
      },
      (res) => {
        let cert: ProbeCert | undefined;
        const sock = res.socket as TLSSocket;
        if (u.protocol === 'https:' && typeof sock.getPeerCertificate === 'function') {
          const c = sock.getPeerCertificate();
          if (c && c.valid_to) {
            const validTo = new Date(c.valid_to);
            cert = {
              validTo: validTo.toISOString(),
              daysLeft: Math.floor((validTo.getTime() - Date.now()) / 86_400_000),
              issuer: first(c.issuer?.O) || first(c.issuer?.CN),
              subject: first(c.subject?.CN),
            };
          }
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          if (!o.wantBody || size >= MAX_BODY) return;
          chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? '',
            location: res.headers.location,
            body: o.wantBody ? Buffer.concat(chunks).toString('utf8') : '',
            cert,
          }),
        );
        res.on('error', reject);
        if (!o.wantBody) res.resume();
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('Timed out'), { code: 'ABORT_ERR' })));
    req.on('error', reject);
    if (o.body) req.write(o.body);
    req.end();
  });
}

/** Certificate name fields can be string | string[]; take the first. */
function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** "200-299, 301" → [[200,299],[301,301]]. Empty when nothing parses. */
function parseAccepted(spec: string): [number, number][] {
  const out: [number, number][] = [];
  for (const part of spec.split(',')) {
    const m = /^\s*(\d{3})\s*(?:-\s*(\d{3}))?\s*$/.exec(part);
    if (!m) continue;
    const lo = parseInt(m[1], 10);
    const hi = m[2] ? parseInt(m[2], 10) : lo;
    if (hi >= lo) out.push([lo, hi]);
  }
  return out;
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (name) out[name] = line.slice(i + 1).trim();
  }
  return out;
}
