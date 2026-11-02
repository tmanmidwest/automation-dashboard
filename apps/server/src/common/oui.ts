import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * MAC → manufacturer, from the IEEE's public OUI registry, for when a device (UniFi,
 * DHCP) doesn't name the vendor itself. The registry (~3 MB CSV) is downloaded once,
 * cached on disk (re-downloaded at startup once the copy is a month old); lookups return
 * null until it has loaded, and any failure (offline, disk read-only) leaves them blank.
 */

const SOURCE = 'https://standards-oui.ieee.org/oui/oui.csv';
const MAX_AGE_MS = 30 * 24 * 3600_000;
const RETRY_MS = 6 * 3600_000;

let table: Map<string, string> | null = null;
let loading: Promise<void> | null = null;
let lastAttempt = 0;

function cachePath(): string {
  return process.env.OUI_CACHE_PATH || '/data/oui/oui.csv';
}

/** Second-lowest bit of the first octet: set on randomized / private MACs (phones, tablets). */
export function isPrivateMac(mac: string): boolean {
  const first = parseInt(mac.replace(/[^0-9a-f]/gi, '').slice(0, 2), 16);
  return Number.isFinite(first) && (first & 0b10) !== 0;
}

/** Parse the IEEE CSV: Registry,Assignment,Organization Name,Organization Address. */
export function parseOuiCsv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^MA-L,([0-9A-F]{6}),("(?:[^"]|"")*"|[^,]*)/.exec(line);
    if (m) out.set(m[1], m[2].replace(/^"|"$/g, '').replace(/""/g, '"').trim());
  }
  return out;
}

async function load(): Promise<void> {
  lastAttempt = Date.now();
  const file = cachePath();
  let text: string | null = null;
  let fresh = false;
  try {
    const st = await fs.stat(file);
    text = await fs.readFile(file, 'utf8');
    fresh = Date.now() - st.mtimeMs < MAX_AGE_MS;
  } catch {
    /* no cache yet */
  }
  if (!fresh) {
    try {
      const res = await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      if (parseOuiCsv(body).size > 1000) {
        text = body;
        for (const target of [file, path.join(os.tmpdir(), 'cerebro-oui.csv')]) {
          try {
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, body);
            break;
          } catch {
            /* try the next location */
          }
        }
      }
    } catch {
      /* offline: keep whatever cache we had */
    }
  }
  if (text) table = parseOuiCsv(text);
}

/** Manufacturer for a MAC, or null (unknown, private MAC, or registry not loaded yet). */
export function ouiVendor(mac: string | null | undefined): string | null {
  if (!mac || isPrivateMac(mac)) return null;
  if (!table && !loading && Date.now() - lastAttempt > RETRY_MS) {
    loading = load().finally(() => { loading = null; });
  }
  return table?.get(mac.replace(/[^0-9a-f]/gi, '').slice(0, 6).toUpperCase()) ?? null;
}

/** For tests. */
export function setOuiTable(t: Map<string, string> | null): void {
  table = t;
}
