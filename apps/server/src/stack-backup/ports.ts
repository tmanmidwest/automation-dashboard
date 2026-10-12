/**
 * Published-host-port remapping for the stack migrator, split into a RESOLVE step and an
 * APPLY step so a `${VAR}` port is matched once (where the current value is known) and the
 * same decision is applied verbatim at deploy — pre-flight and deploy never disagree.
 *
 * A published host port is either a literal (`"8080:80"`, `published: 8080`) → rewritten
 * in the compose, or a variable (`"${WEB_PORT}:80"`, `published: ${WEB_PORT}`) → the value
 * changes in the `.env` (which is what Compose interpolates a `${VAR}` in a compose file
 * from). Container ports, protocols, host IPs and ranges are never touched. The parsing
 * skeleton mirrors sandbox.ts `unpublishPorts`.
 */

export interface PortRemapOps {
  /** Literal host ports to rewrite in the compose: oldHostPort → newHostPort. */
  literal: Record<number, number>;
  /** Env vars (used as a `${VAR}` host port) to set in the `.env`: VAR → newHostPort. */
  vars: Record<string, number>;
  /** Requested old host ports that are neither a literal nor a resolvable ${VAR} port. */
  unresolved: number[];
}

/**
 * Work out HOW to apply a {oldHostPort → newHostPort} map to a compose, using `env` (which
 * should be as complete as possible — the stack's `.env` plus the running containers'
 * resolved environment) to resolve `${VAR}` host ports to their current value.
 */
export function resolvePortRemap(compose: string, env: string, map: Record<string | number, number>): PortRemapOps {
  const want = toNumMap(map);
  const ops: PortRemapOps = { literal: {}, vars: {}, unresolved: [] };
  if (!want.size) return ops;
  const envMap = parseEnv(env);
  const resolved = new Set<number>();

  forEachHostToken(compose, (token) => {
    const t = token.trim();
    if (/^\d+$/.test(t)) {
      const old = Number(t);
      if (want.has(old)) { ops.literal[old] = want.get(old)!; resolved.add(old); }
      return;
    }
    const varName = parseVarToken(t);
    if (varName) {
      const current = Number((envMap.get(varName.name) ?? varName.def ?? '').trim());
      if (Number.isFinite(current) && want.has(current)) { ops.vars[varName.name] = want.get(current)!; resolved.add(current); }
    }
  });

  ops.unresolved = [...want.keys()].filter((o) => !resolved.has(o)).sort((a, b) => a - b);
  return ops;
}

/** Apply pre-resolved operations: rewrite literal host ports in the compose, set the env
 *  vars in the `.env` (updating or appending). Pure string work — no resolution. */
export function applyPortRemap(
  compose: string,
  env: string,
  literal: Record<string | number, number>,
  vars: Record<string, number>,
): { compose: string; env: string } {
  const lit = toNumMap(literal);
  const lines = compose.split('\n');
  const out: string[] = [];
  let portsIndent: number | null = null;

  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (portsIndent !== null && trimmed && indent <= portsIndent) portsIndent = null;
    if (/^ports:\s*(#.*)?$/.test(trimmed)) { portsIndent = indent; out.push(line); continue; }
    if (portsIndent === null) { out.push(line); continue; }

    const longForm = /^(\s*published:\s*)(["']?)([^"'#\s]+)\2\s*(#.*)?$/.exec(line);
    if (longForm) {
      const [, prefix, quote, value, comment] = longForm;
      const nt = rewriteLiteral(value, lit);
      out.push(nt === null ? line : `${prefix}${quote}${nt}${quote}${comment ? ` ${comment}` : ''}`);
      continue;
    }
    const short = /^(\s*-\s*)(["']?)([^"'#]+)\2\s*(#.*)?$/.exec(line);
    if (short && !isMapping(short[3].trim())) {
      const [, prefix, quote, value, comment] = short;
      const nt = rewriteSpec(value.trim(), lit);
      out.push(nt === null ? line : `${prefix}${quote}${nt}${quote}${comment ? ` ${comment}` : ''}`);
      continue;
    }
    out.push(line);
  }

  return { compose: out.join('\n'), env: Object.keys(vars).length ? setEnvVars(env, vars) : env };
}

// ── helpers ──────────────────────────────────────────────────────────

function toNumMap(map: Record<string | number, number>): Map<number, number> {
  const m = new Map<number, number>();
  for (const [k, v] of Object.entries(map)) {
    const o = Number(k);
    const n = Number(v);
    if (Number.isFinite(o) && Number.isFinite(n) && o > 0 && n > 0) m.set(o, n);
  }
  return m;
}

/** Call `fn` with every published-port HOST token (literal or ${VAR}) in the compose. */
function forEachHostToken(compose: string, fn: (hostToken: string) => void): void {
  let portsIndent: number | null = null;
  for (const line of compose.split('\n')) {
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (portsIndent !== null && trimmed && indent <= portsIndent) portsIndent = null;
    if (/^ports:\s*(#.*)?$/.test(trimmed)) { portsIndent = indent; continue; }
    if (portsIndent === null) continue;

    const longForm = /^published:\s*(["']?)([^"'#\s]+)\1/.exec(trimmed);
    if (longForm) { fn(longForm[2]); continue; }
    const short = /^-\s*(["']?)([^"'#]+)\1/.exec(trimmed);
    if (short && !isMapping(short[2].trim())) { const h = hostTokenOf(short[2].trim()); if (h !== null) fn(h); }
  }
}

/** Split on `sep`, but never on a separator INSIDE a `${...}` group — so a defaulted
 *  port var like `${HRSOT_HOST_PORT:-8000}` isn't shredded by the host/container colon. */
function splitTop(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** Parse a short-form spec `[[host_ip:]host:]container[/proto]`, treating `${...}` as
 *  opaque. Returns null for container-only (no host port) or anything ambiguous (IPv6). */
function parseSpec(spec: string): { hostIp: string; host: string; container: string; proto: string } | null {
  const bySlash = splitTop(spec, '/');
  const proto = bySlash.length > 1 ? `/${bySlash.slice(1).join('/')}` : '';
  const parts = splitTop(bySlash[0], ':');
  if (parts.length === 2) return { hostIp: '', host: parts[0].trim(), container: parts[1], proto };
  if (parts.length === 3) return { hostIp: parts[0], host: parts[1].trim(), container: parts[2], proto };
  return null; // container-only, IPv6 host_ip, or otherwise not a plain host:container
}

/** Extract the host-port token from a short-form spec. */
function hostTokenOf(spec: string): string | null {
  return parseSpec(spec)?.host ?? null;
}

/** Rewrite a short-form spec's literal host port if it's in `lit`; else null (unchanged). */
function rewriteSpec(spec: string, lit: Map<number, number>): string | null {
  const p = parseSpec(spec);
  if (!p) return null;
  const nt = rewriteLiteral(p.host, lit);
  if (nt === null) return null;
  return `${p.hostIp ? `${p.hostIp}:` : ''}${nt}:${p.container}${p.proto}`;
}

function rewriteLiteral(token: string, lit: Map<number, number>): string | null {
  const t = token.trim();
  if (!/^\d+$/.test(t)) return null;
  const old = Number(t);
  return lit.has(old) ? String(lit.get(old)) : null;
}

function parseVarToken(t: string): { name: string; def?: string } | null {
  const v = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}$/.exec(t);
  return v ? { name: v[1], def: v[2] } : null;
}

function parseEnv(env: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of (env ?? '').split('\n')) {
    const mm = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (mm) m.set(mm[1], mm[2].replace(/^["']|["']$/g, ''));
  }
  return m;
}

function setEnvVars(env: string, vars: Record<string, number>): string {
  const seen = new Set<string>();
  const lines = (env ?? '').split('\n').map((line) => {
    const mm = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*).*$/.exec(line);
    if (mm && mm[2] in vars) { seen.add(mm[2]); return `${mm[1]}${mm[2]}${mm[3]}${vars[mm[2]]}`; }
    return line;
  });
  for (const [k, v] of Object.entries(vars)) if (!seen.has(k)) lines.push(`${k}=${v}`);
  return lines.join('\n');
}

function isMapping(value: string): boolean {
  return value.startsWith('{') || /^[A-Za-z_][A-Za-z0-9_]*\s*:\s/.test(value);
}
