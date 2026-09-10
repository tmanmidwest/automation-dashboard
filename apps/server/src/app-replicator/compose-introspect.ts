import type { ReplicatorVariable, ReplicatorVarRole } from '@cerebro/shared';

/**
 * Derive an app's variable/port schema from its Docker Compose file. The compose
 * file IS the manifest: every `${VAR:-default}` interpolation becomes a typed
 * variable, roles inferred from where the token appears (a `ports:` mapping → a
 * published host port; `image:`/`container_name:` → auto-managed per deployment;
 * a secret-looking name → a vault-backed secret). Dependency-free, line/indent
 * based — good enough for standard compose; the demo hrDemoWebApp is the
 * acceptance case. See docs/app-replicator.md.
 */

/** Names that look like a credential get flagged secret even when they carry a default. */
const SECRET_RE = /(secret|password|passwd|token|api[_-]?key|apikey|private[_-]?key|credential)/i;
/**
 * …but not when the name is clearly a duration/count/path that merely contains a
 * secret-ish word (e.g. TOKEN_LIFETIME_SECONDS, API_KEY_FILE). Only a starting
 * guess — the operator can still toggle any variable's secret flag at register time.
 */
const NOT_SECRET_RE = /(_seconds|_days|_minutes|_hours|_ms|_lifetime|_timeout|_ttl|_retention|_max_age|_file|_path|_url|_enabled|_algorithm)$/i;

export interface ParsedCompose {
  variables: ReplicatorVariable[];
  services: string[];
  warnings: string[];
}

interface RawToken {
  name: string;
  default: string | null; // null = no `:-`/`-` default declared
}

/** Extract ${VAR}, ${VAR:-def}, ${VAR-def}, ${VAR:?err} tokens from a line. */
function tokensIn(text: string): RawToken[] {
  const out: RawToken[] = [];
  // name, then optional operator (:-  -  :?  ?  :+  +) and its argument.
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|-|:\?|\?|:\+|\+)([^}]*))?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [, name, op, arg] = m;
    let def: string | null = null;
    if (op === ':-' || op === '-') def = arg ?? '';
    // :?/? = required (no default); :+/+ = replacement, not a default → leave null.
    out.push({ name, default: def });
  }
  return out;
}

/** Leading-space count; tabs count as two. */
function indentOf(line: string): number {
  let n = 0;
  for (const c of line) {
    if (c === ' ') n++;
    else if (c === '\t') n += 2;
    else break;
  }
  return n;
}

/** The container port from a compose ports item, e.g. "127.0.0.1:8000:8000/tcp" → 8000. */
function containerPortOf(item: string): number | null {
  const cleaned = item.trim().replace(/^["']|["']$/g, '').split('/')[0];
  const parts = cleaned.split(':');
  const last = parts[parts.length - 1];
  const n = Number(last);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Fold a newly-seen token into the map, keeping the most specific role/default. */
function addVar(
  map: Map<string, ReplicatorVariable>,
  tok: RawToken,
  role: ReplicatorVarRole,
  service: string | null,
  containerPort: number | null,
): void {
  const existing = map.get(tok.name);
  if (!existing) {
    map.set(tok.name, {
      name: tok.name,
      default: tok.default,
      role,
      service,
      containerPort,
      required: tok.default === null,
      secret: false, // decided after the whole file is parsed
    });
    return;
  }
  // A managed/port role always wins over 'plain'; keep the first non-null default/port.
  const rank: Record<ReplicatorVarRole, number> = { plain: 0, secret: 1, host_port: 2, image_tag: 2, container_name: 2 };
  if (rank[role] > rank[existing.role]) existing.role = role;
  if (existing.default === null && tok.default !== null) { existing.default = tok.default; existing.required = false; }
  if (existing.containerPort == null && containerPort != null) existing.containerPort = containerPort;
  if (!existing.service && service) existing.service = service;
}

/** Parse a compose file's text into the variable/port schema. */
export function introspectCompose(text: string): ParsedCompose {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const services = new Set<string>();
  const vars = new Map<string, ReplicatorVariable>();
  const warnings: string[] = [];

  // Stack of open mapping keys (indent + key), so we know the path to each line.
  const stack: { indent: number; key: string }[] = [];

  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = indentOf(raw);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();

    const keyM = raw.match(/^\s*([A-Za-z0-9_.-]+):\s*(.*)$/);
    const listM = raw.match(/^\s*-\s*(.*)$/);
    const parentKey = stack.length ? stack[stack.length - 1].key : undefined;
    const path = stack.map((f) => f.key);
    const service = path[0] === 'services' ? (path[1] ?? null) : null;

    // A key whose immediate parent is `services:` is a service name.
    if (keyM && parentKey === 'services') services.add(keyM[1]);

    const fieldKey = keyM ? keyM[1] : undefined;
    const toks = tokensIn(raw);
    if (toks.length) {
      let role: ReplicatorVarRole = 'plain';
      let containerPort: number | null = null;
      if (fieldKey === 'image') role = 'image_tag';
      else if (fieldKey === 'container_name') role = 'container_name';
      else if (parentKey === 'ports' && listM) {
        role = 'host_port';
        containerPort = containerPortOf(listM[1]);
      }
      for (const t of toks) addVar(vars, t, role, service, containerPort);
    }

    // Opening a nested block (a key with no inline value) pushes context.
    if (keyM && keyM[2].trim() === '') stack.push({ indent, key: keyM[1] });
  }

  // Finalize secret flags: a secret-looking name that isn't a managed/port var.
  for (const v of vars.values()) {
    if (v.role === 'plain' && SECRET_RE.test(v.name) && !NOT_SECRET_RE.test(v.name)) { v.role = 'secret'; v.secret = true; }
    else v.secret = v.role === 'secret';
  }

  const hostPorts = [...vars.values()].filter((v) => v.role === 'host_port');
  if (hostPorts.some((v) => v.containerPort == null)) {
    warnings.push('A published-port variable had no detectable container port; defaulting it to the host port at deploy.');
  }
  if (!hostPorts.length) {
    warnings.push('No published-port variable detected — this app may not expose a reachable port.');
  }

  return {
    variables: [...vars.values()].sort(sortVars),
    services: [...services],
    warnings,
  };
}

/** Order the form sensibly: ports first, then secrets, then plain; managed vars last. */
function sortVars(a: ReplicatorVariable, b: ReplicatorVariable): number {
  const order: Record<ReplicatorVarRole, number> = { host_port: 0, secret: 1, plain: 2, image_tag: 3, container_name: 3 };
  return order[a.role] - order[b.role] || a.name.localeCompare(b.name);
}

/**
 * For a repo that ships only a Dockerfile (no compose), synthesize a minimal
 * parameterized compose wrapper so the same downstream flow (variable form,
 * per-instance image/name, port mapping) applies uniformly. `exposed` is the
 * container port from the Dockerfile's EXPOSE (defaults to 8080).
 */
export function generateComposeWrapper(exposed: number): string {
  const port = exposed > 0 ? exposed : 8080;
  return [
    'services:',
    '  app:',
    '    build: .',
    '    image: ${APP_IMAGE:-app:local}',
    '    container_name: ${APP_CONTAINER_NAME:-app}',
    '    ports:',
    `      - "\${APP_HOST_PORT:-${port}}:${port}"`,
    '    restart: unless-stopped',
    '',
  ].join('\n');
}

/** First EXPOSEd port in a Dockerfile, or null. */
export function exposedPortOf(dockerfile: string): number | null {
  const m = dockerfile.match(/^\s*EXPOSE\s+(\d+)/im);
  return m ? Number(m[1]) : null;
}
