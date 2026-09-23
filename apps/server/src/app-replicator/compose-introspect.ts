import type { ReplicatorVariable, ReplicatorVarRole } from '@cerebro/shared';

/**
 * Derive an app's variable/port schema from its Docker Compose file. The compose
 * file IS the manifest: every `${VAR:-default}` interpolation becomes a typed
 * variable, roles inferred from where the token appears (a `ports:` mapping → a
 * published host port; `image:`/`container_name:` → auto-managed per deployment;
 * a secret-looking name → a vault-backed secret). Dependency-free, line/indent
 * based — good enough for standard compose; the demo hrDemoWebApp is the
 * acceptance case.
 *
 * Plenty of apps don't interpolate at all — they declare `env_file: .env` and ship
 * a committed `.env.example` documenting the keys. Those files are parsed here too
 * (see `parseDotenv` / `envFileVariables`) and folded into the same schema, so the
 * register form, deploy wizard and vault work identically either way. Compose stays
 * authoritative where the two overlap, since only it carries port/image structure.
 * See docs/app-replicator.md.
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
  /** Paths named by `env_file:`, relative to the compose file's own directory. */
  envFiles: string[];
  warnings: string[];
}

/** One `KEY=value` assignment read out of an env file, with its leading comment. */
export interface DotenvEntry {
  name: string;
  value: string;
  /** The `#` lines directly above the entry, joined — the repo's own documentation. */
  comment: string | null;
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

/**
 * Split a compose ports item into its top-level colon segments, ignoring colons
 * inside a `${VAR:-default}` interpolation. Docker short syntax is
 * `[HOST_IP:][HOST_PORT:]CONTAINER_PORT[/proto]`, so segment position tells us
 * whether a `${VAR}` on the line is a bind address or a published host port.
 */
function portSegments(item: string): string[] {
  const s = item.trim().replace(/^["']|["']$/g, '').split('/')[0];
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

/** Resolve a segment to a fixed container port: its literal number or a `${VAR:-8000}` default. */
function portOfSegment(seg: string): number | null {
  const toks = tokensIn(seg);
  const fromDefault = toks.length && toks[0].default != null ? Number(toks[0].default) : NaN;
  if (Number.isFinite(fromDefault) && fromDefault > 0) return fromDefault;
  const literal = Number(seg.trim());
  return Number.isFinite(literal) && literal > 0 ? literal : null;
}

/**
 * Assign roles to the `${VAR}` tokens on a `ports:` list item by segment: in a
 * 3-segment `HOST_IP:HOST_PORT:CONTAINER` mapping the leading token is a bind
 * address (host_ip, free text), the middle is the published host port; the
 * trailing container-port token (rare) is fixed config, treated as plain.
 */
function addPortsTokens(map: Map<string, ReplicatorVariable>, item: string, service: string | null): void {
  const segs = portSegments(item);
  const last = segs.length - 1;
  const containerPort = portOfSegment(segs[last]);
  segs.forEach((seg, idx) => {
    const toks = tokensIn(seg);
    if (!toks.length) return;
    let role: ReplicatorVarRole;
    if (idx === last) role = 'plain'; // the container-port slot — fixed, not a host binding
    else if (segs.length >= 3 && idx === 0) role = 'host_ip';
    else role = 'host_port';
    for (const t of toks) addVar(map, t, role, service, role === 'host_port' ? containerPort : null);
  });
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
      source: 'compose',
    });
    return;
  }
  // A managed/port role always wins over 'plain'; keep the first non-null default/port.
  const rank: Record<ReplicatorVarRole, number> = { plain: 0, secret: 1, host_ip: 2, host_port: 2, image_tag: 2, container_name: 2 };
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
  const envFiles = new Set<string>();
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

    // `env_file:` targets, in either compose form: the scalar `env_file: .env`,
    // or a list whose items are bare paths or the long `- path: ./x.env`.
    if (fieldKey === 'env_file' && keyM![2].trim()) addEnvFile(envFiles, keyM![2]);
    else if (parentKey === 'env_file' && listM) addEnvFile(envFiles, listM[1].replace(/^path:\s*/, ''));

    const toks = tokensIn(raw);
    if (toks.length) {
      if (parentKey === 'ports' && listM) {
        // A ports mapping needs per-segment roles (bind IP vs host port vs container port).
        addPortsTokens(vars, listM[1], service);
      } else {
        let role: ReplicatorVarRole = 'plain';
        if (fieldKey === 'image') role = 'image_tag';
        else if (fieldKey === 'container_name') role = 'container_name';
        for (const t of toks) addVar(vars, t, role, service, null);
      }
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
    envFiles: [...envFiles],
    warnings,
  };
}

/** Record one `env_file:` path, skipping empties and unresolvable interpolations. */
function addEnvFile(into: Set<string>, raw: string): void {
  const p = raw.trim().replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
  // A path built from a `${VAR}` can't be resolved at register time — skip it.
  if (!p || p.includes('${')) return;
  into.add(p.replace(/^\.\//, ''));
}

/** Order the form sensibly: ports first, then secrets, then plain; managed vars last. */
function sortVars(a: ReplicatorVariable, b: ReplicatorVariable): number {
  const order: Record<ReplicatorVarRole, number> = { host_ip: 0, host_port: 0, secret: 1, plain: 2, image_tag: 3, container_name: 3 };
  return order[a.role] - order[b.role] || a.name.localeCompare(b.name);
}

// ── Env files ─────────────────────────────────────────────────────
//
// An app that reads its config from `env_file:` has no `${VAR}` tokens for the
// compose introspector to find, so its keys come from whichever env file the repo
// actually commits — usually `.env.example` (a real `.env` is nearly always
// gitignored). RepoIntrospectService picks the file; these functions turn its
// contents into the same ReplicatorVariable shape the rest of the flow speaks.

/** Strip matching surrounding quotes, or a trailing ` # comment` on a bare value. */
function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"') && t.length > 1) || (t.startsWith("'") && t.endsWith("'") && t.length > 1)) {
    return t.slice(1, -1);
  }
  // Only whitespace-preceded `#` starts a comment; `pass#word` is a literal value.
  return t.replace(/\s+#.*$/, '').trim();
}

/**
 * Parse an env file into its assignments. Deliberately forgiving and
 * dependency-free (same posture as the compose parser): `export` prefixes,
 * quoted values and inline comments are handled; multi-line values are not.
 * The `#` lines directly above an entry are kept as its comment — that's the
 * repo's own documentation for the key, and it's what makes the generated form
 * readable.
 */
export function parseDotenv(text: string): DotenvEntry[] {
  const out: DotenvEntry[] = [];
  const seen = new Set<string>();
  let comment: string[] = [];
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) { comment = []; continue; } // a blank line ends the comment block
    if (line.startsWith('#')) {
      const body = line.replace(/^#+\s?/, '').trim();
      // A commented-out assignment (`#SMTP_HOST=…`) is a disabled key, not prose.
      if (body && !/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(body)) comment.push(body);
      continue;
    }
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) { comment = []; continue; }
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push({ name: m[1], value: unquote(m[2]), comment: comment.join(' ') || null });
    }
    comment = [];
  }
  return out;
}

/**
 * Turn parsed env-file entries into variables. Everything is plain config or a
 * secret — an env file carries no port/image structure — and the sample value
 * becomes the default so the deploy form starts from the repo's own working
 * config.
 *
 * A secret is the exception: a committed sample credential (`DB_PASSWORD=changeme`)
 * must never become a real deployment's value, so it keeps no default and is
 * marked required, forcing the operator to supply one. A blank non-secret stays
 * optional — `.env.example` blanks are ambiguous, and blocking the deploy on one
 * would be worse than leaving the key unset.
 */
export function envFileVariables(entries: DotenvEntry[], envFile: string): ReplicatorVariable[] {
  return entries.map((e) => {
    const secret = SECRET_RE.test(e.name) && !NOT_SECRET_RE.test(e.name);
    return {
      name: e.name,
      default: secret || e.value === '' ? null : e.value,
      role: secret ? 'secret' : 'plain',
      service: null,
      containerPort: null,
      required: secret,
      secret,
      source: 'env_file',
      envFile,
      comment: e.comment,
    } satisfies ReplicatorVariable;
  });
}

/**
 * Fold env-file variables into a compose-derived schema. Compose wins wherever
 * the two name the same variable — only it knows that a name is a published port,
 * an image tag or a container name — but an env file's sample value and comment
 * fill gaps compose left, which is how an app that does both ends up fully
 * documented in the form.
 */
export function mergeEnvFileVars(composeVars: ReplicatorVariable[], envVars: ReplicatorVariable[]): ReplicatorVariable[] {
  const byName = new Map(composeVars.map((v) => [v.name, { ...v }]));
  for (const e of envVars) {
    const existing = byName.get(e.name);
    if (!existing) { byName.set(e.name, e); continue; }
    if (!existing.comment && e.comment) existing.comment = e.comment;
    // `${VAR}` with no `:-default` + a sample value in the env file → use it.
    if ((existing.role === 'plain' || existing.role === 'secret') && existing.default == null && e.default != null) {
      existing.default = e.default;
      existing.required = false;
    }
  }
  return [...byName.values()].sort(sortVars);
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
