/**
 * Remap the PUBLISHED HOST ports of a compose file per a {oldHostPort → newHostPort}
 * map — used by the stack migrator when a target host already has a port in use.
 *
 * Only the host side of a published port is touched; container ports, protocols, host
 * IPs, ranges and every unrelated port are left exactly as they were. Two forms of host
 * port are understood:
 *   - a literal (`"8080:80"`, `published: 8080`) → rewritten in the compose, and
 *   - a variable (`"${WEB_PORT}:80"`, `published: ${WEB_PORT}`) → resolved against the
 *     stack's `.env` and rewritten THERE (so App-Replicator-style stacks, whose host
 *     ports are env vars, remap correctly).
 *
 * Anything it cannot safely rewrite (a range that spans a mapped port, an IPv6 host
 * address, a port that simply isn't found) is reported in `unresolved` so the caller
 * refuses the migration cleanly instead of deploying a wrong mapping. The parsing
 * skeleton mirrors sandbox.ts `unpublishPorts`.
 */

export interface RemapResult {
  compose: string;
  env: string;
  /** Requested old host ports that could NOT be remapped (left untouched). */
  unresolved: number[];
}

export function remapPorts(compose: string, env: string, map: Record<string | number, number>): RemapResult {
  const want = new Map<number, number>();
  for (const [k, v] of Object.entries(map)) {
    const o = Number(k);
    const n = Number(v);
    if (Number.isFinite(o) && Number.isFinite(n) && o > 0 && n > 0) want.set(o, n);
  }
  if (!want.size) return { compose, env, unresolved: [] };

  const envMap = parseEnv(env);
  const resolved = new Set<number>();
  const envUpdates = new Map<string, number>(); // VAR → new value

  const lines = compose.split('\n');
  const out: string[] = [];
  let portsIndent: number | null = null;

  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (portsIndent !== null && trimmed && indent <= portsIndent) portsIndent = null;

    if (/^ports:\s*(#.*)?$/.test(trimmed)) { portsIndent = indent; out.push(line); continue; }
    if (portsIndent === null) { out.push(line); continue; }

    // Long form: `published: <host>`
    const longForm = /^(\s*published:\s*)(["']?)([^"'#\s]+)\2\s*(#.*)?$/.exec(line);
    if (longForm) {
      const [, prefix, quote, value, comment] = longForm;
      const rewritten = remapHostToken(value, want, envMap, envUpdates, resolved);
      out.push(rewritten === null ? line : `${prefix}${quote}${rewritten}${quote}${comment ? ` ${comment}` : ''}`);
      continue;
    }

    // Short form list item: `- "[host_ip:]host:container[/proto]"`
    const short = /^(\s*-\s*)(["']?)([^"'#]+)\2\s*(#.*)?$/.exec(line);
    if (short && !isMapping(short[3].trim())) {
      const [, prefix, quote, value, comment] = short;
      const rewritten = remapPortSpec(value.trim(), want, envMap, envUpdates, resolved);
      out.push(rewritten === null ? line : `${prefix}${quote}${rewritten}${quote}${comment ? ` ${comment}` : ''}`);
      continue;
    }
    out.push(line);
  }

  // Apply env-var rewrites (for ${VAR} host ports).
  const newEnv = envUpdates.size ? rewriteEnv(env, envUpdates) : env;

  const unresolved = [...want.keys()].filter((o) => !resolved.has(o)).sort((a, b) => a - b);
  return { compose: out.join('\n'), env: newEnv, unresolved };
}

/** Rewrite a full short-form port spec `[[host_ip:]host:]container[/proto]`. Returns the
 *  new spec, or null when there is no host port / nothing to change. */
function remapPortSpec(
  spec: string,
  want: Map<number, number>,
  envMap: Map<string, string>,
  envUpdates: Map<string, number>,
  resolved: Set<number>,
): string | null {
  const slash = spec.lastIndexOf('/');
  const proto = slash > -1 ? spec.slice(slash) : '';
  const body = slash > -1 ? spec.slice(0, slash) : spec;

  // Split off the container port (after the final colon); everything before is
  // [host_ip:]host. An IPv6 host_ip has many colons — too ambiguous to remap safely.
  const lastColon = body.lastIndexOf(':');
  if (lastColon < 0) return null; // container-only, no host port to remap
  const hostPart = body.slice(0, lastColon);
  const container = body.slice(lastColon + 1);

  // hostPart = "[host_ip:]host". A single colon → host_ip present; >1 → IPv6, skip.
  const hc = hostPart.split(':');
  if (hc.length > 2) return null; // IPv6 host_ip — leave it alone
  const hostIp = hc.length === 2 ? hc[0] : '';
  const hostToken = hc.length === 2 ? hc[1] : hc[0];

  const newHost = remapHostToken(hostToken, want, envMap, envUpdates, resolved);
  if (newHost === null) return null;
  return `${hostIp ? `${hostIp}:` : ''}${newHost}:${container}${proto}`;
}

/** Remap a single host-port token (a literal number or a ${VAR}). Returns the new token
 *  text for a literal, the SAME token for a var (the change goes to env), or null when
 *  it isn't a mapped port. Records env-var updates + which old ports were resolved. */
function remapHostToken(
  token: string,
  want: Map<number, number>,
  envMap: Map<string, string>,
  envUpdates: Map<string, number>,
  resolved: Set<number>,
): string | null {
  const t = token.trim();
  // Literal port.
  if (/^\d+$/.test(t)) {
    const old = Number(t);
    if (!want.has(old)) return null;
    resolved.add(old);
    return String(want.get(old));
  }
  // Variable: ${VAR} or ${VAR:-default} / ${VAR:default}.
  const v = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}$/.exec(t);
  if (v) {
    const name = v[1];
    const def = v[2];
    const current = envMap.get(name) ?? def;
    const old = Number((current ?? '').trim());
    if (Number.isFinite(old) && want.has(old)) {
      envUpdates.set(name, want.get(old)!);
      resolved.add(old);
    }
    return t; // the compose keeps ${VAR}; the value changes in .env
  }
  return null; // a range or something exotic — not remappable
}

function parseEnv(env: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of (env ?? '').split('\n')) {
    const mm = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (mm) m.set(mm[1], mm[2].replace(/^["']|["']$/g, ''));
  }
  return m;
}

/** Rewrite (or append) KEY=value lines for the given updates, preserving other lines. */
function rewriteEnv(env: string, updates: Map<string, number>): string {
  const seen = new Set<string>();
  const lines = (env ?? '').split('\n').map((line) => {
    const mm = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*).*$/.exec(line);
    if (mm && updates.has(mm[2])) { seen.add(mm[2]); return `${mm[1]}${mm[2]}${mm[3]}${updates.get(mm[2])}`; }
    return line;
  });
  for (const [k, v] of updates) if (!seen.has(k)) lines.push(`${k}=${v}`);
  return lines.join('\n');
}

function isMapping(value: string): boolean {
  return value.startsWith('{') || /^[A-Za-z_][A-Za-z0-9_]*\s*:\s/.test(value);
}
