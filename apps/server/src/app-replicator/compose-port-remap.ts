/**
 * Move a hardcoded host port for one deployment. A compose that says
 * `- "5055:5055"` can only run once per host; to give a second deployment its own
 * port, Cerebro rewrites that one mapping in the copy of the compose it hands to
 * Docker (`- "5056:5055"`). The app's stored compose / the repo are never edited.
 *
 * A text rewrite (rather than a merged override) because Compose *appends* `ports`
 * across `-f` files — an override can't take the original binding away without
 * `!override`, which needs Compose 2.24+ and would also have to restate every
 * other port of the service. Rewriting the one literal works on any Compose and
 * keeps bind IPs, other ports and comments exactly as written.
 *
 * Same line/indent walk as compose-introspect, so it finds exactly the mappings
 * introspection reported as fixed ports. See docs/app-replicator.md.
 */

export interface PortRemap {
  service: string;
  protocol: 'tcp' | 'udp';
  /** The host port the compose declares (range start). */
  from: number;
  /** The host port this deployment binds instead (range start; a range keeps its width). */
  to: number;
}

export interface RemapResult {
  text: string;
  /** Remaps whose mapping wasn't found (the compose changed since it was registered). */
  missing: PortRemap[];
}

function indentOf(line: string): number {
  let n = 0;
  for (const c of line) {
    if (c === ' ') n++;
    else if (c === '\t') n += 2;
    else break;
  }
  return n;
}

/** Split `[IP:][HOST:]CONTAINER` on top-level colons (not inside `${..}`), keeping the raw text. */
function splitSegments(s: string): string[] {
  const segs: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    if (c === ':' && depth === 0) { segs.push(cur); cur = ''; }
    else cur += c;
  }
  segs.push(cur);
  return segs;
}

/** A literal `N` or `N-M` → shifted to start at `to`, keeping the width. */
function shiftLiteral(seg: string, from: number, to: number): string | null {
  const m = seg.trim().match(/^(\d+)(?:-(\d+))?$/);
  if (!m || Number(m[1]) !== from) return null;
  if (m[2] == null) return String(to);
  return `${to}-${to + (Number(m[2]) - from)}`;
}

/**
 * Rewrite a short-form ports item's host segment. `content` is the text after
 * `- `, possibly quoted and with a trailing comment. Returns the new content, or
 * null when this item isn't the mapping being moved.
 */
function remapShort(content: string, r: PortRemap): string | null {
  const cm = content.match(/^(.*?)(\s+#.*)?$/);
  const body = (cm?.[1] ?? content).trim();
  const comment = cm?.[2] ?? '';
  const q = body[0] === '"' || body[0] === "'" ? body[0] : '';
  const inner = q && body.endsWith(q) ? body.slice(1, -1) : body;
  const pm = inner.match(/^(.*?)(\/(?:tcp|udp|sctp))?$/i);
  const mapping = pm?.[1] ?? inner;
  const protoSuffix = pm?.[2] ?? '';
  const proto = protoSuffix.toLowerCase() === '/udp' ? 'udp' : 'tcp';
  if (proto !== r.protocol) return null;
  const segs = splitSegments(mapping);
  if (segs.length < 2) return null;
  const hostIdx = segs.length - 2;
  const shifted = shiftLiteral(segs[hostIdx], r.from, r.to);
  if (shifted == null) return null;
  segs[hostIdx] = shifted;
  return `${q}${segs.join(':')}${protoSuffix}${q}${comment}`;
}

/** Apply every remap to the compose text. Each remap rewrites the first matching mapping only. */
export function remapComposePorts(text: string, remaps: PortRemap[]): RemapResult {
  const pending = remaps.filter((r) => r.from !== r.to);
  if (!pending.length) return { text, missing: [] };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const done = new Set<PortRemap>();
  const stack: { indent: number; key: string }[] = [];

  // A long-form item spans lines: remember where `published:` sits and its fields.
  let long: { service: string | null; publishedLine?: number; published?: string; protocol?: string } | null = null;
  const flushLong = () => {
    if (!long || long.publishedLine == null || long.published == null) { long = null; return; }
    const clean = (v: string) => v.replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
    const proto = clean(long.protocol ?? '').toLowerCase() === 'udp' ? 'udp' : 'tcp';
    const value = clean(long.published);
    for (const r of pending) {
      if (done.has(r) || r.service !== long.service || r.protocol !== proto) continue;
      const shifted = shiftLiteral(value, r.from, r.to);
      if (shifted == null) continue;
      const idx = long.publishedLine;
      lines[idx] = lines[idx].replace(/(published:\s*["']?)[0-9-]+/, `$1${shifted}`);
      done.add(r);
      break;
    }
    long = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = indentOf(raw);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const keyM = raw.match(/^\s*([A-Za-z0-9_.-]+):\s*(.*)$/);
    const listM = raw.match(/^(\s*-\s*)(.*)$/);
    const parentKey = stack.length ? stack[stack.length - 1].key : undefined;
    const path = stack.map((f) => f.key);
    const service = path[0] === 'services' ? (path[1] ?? null) : null;

    if (long && parentKey !== 'ports') flushLong();

    if (parentKey === 'ports' && service) {
      if (listM) {
        const content = listM[2];
        const lm = content.trim().match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
        if (lm) {
          flushLong();
          long = { service };
          if (lm[1] === 'published') { long.published = lm[2]; long.publishedLine = i; }
          else if (lm[1] === 'protocol') long.protocol = lm[2];
        } else {
          for (const r of pending) {
            if (done.has(r) || r.service !== service) continue;
            const next = remapShort(content, r);
            if (next == null) continue;
            lines[i] = listM[1] + next;
            done.add(r);
            break;
          }
        }
      } else if (keyM && long) {
        if (keyM[1] === 'published') { long.published = keyM[2]; long.publishedLine = i; }
        else if (keyM[1] === 'protocol') long.protocol = keyM[2];
      }
    }

    if (keyM && keyM[2].trim() === '') stack.push({ indent, key: keyM[1] });
  }
  flushLong();

  return { text: lines.join(eol), missing: pending.filter((r) => !done.has(r)) };
}
