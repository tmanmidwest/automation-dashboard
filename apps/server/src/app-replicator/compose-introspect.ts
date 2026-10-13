import type { ReplicatorVariable, ReplicatorVarRole, ReplicatorFixedPort } from '@cerebro/shared';

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

/**
 * Does this variable name look like it holds a credential? Exported because stack
 * backup asks the same question of a running stack's environment — one heuristic,
 * so the two features agree on what counts as a secret.
 */
export function looksSecret(name: string): boolean {
  return SECRET_RE.test(name) && !NOT_SECRET_RE.test(name);
}

export interface ParsedCompose {
  variables: ReplicatorVariable[];
  /** Reachable ports not backed by an adjustable `${VAR}` (literals, ranges, host-network). */
  fixedPorts: ReplicatorFixedPort[];
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

/** Protocol suffix of a ports item (`"8080:80/udp"` → "udp"); defaults to tcp. */
function protoOf(item: string): 'tcp' | 'udp' {
  return /\/udp\s*$/i.test(item.trim().replace(/^["']|["']$/g, '')) ? 'udp' : 'tcp';
}

/** A literal port segment resolved to [start, end] (end set only for a range). */
function literalRange(seg: string): { start: number; end: number | null } | null {
  const s = seg.trim();
  const m = s.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] != null ? Number(m[2]) : null;
  if (!Number.isFinite(start) || start < 1) return null;
  return { start, end: end && Number.isFinite(end) ? end : null };
}

/**
 * Parse one `ports:` SHORT-form item (`[IP:][HOST:]CONTAINER[/proto]`). A host
 * segment that interpolates a `${VAR}` stays modeled as a `host_port` variable
 * (adjustable per deployment, as before); a literal host segment becomes a fixed
 * port. A bare `CONTAINER` with no host segment publishes to an ephemeral host
 * port Docker chooses — not targetable by ingress — so it's skipped.
 */
function addShortPort(
  map: Map<string, ReplicatorVariable>,
  fixed: ReplicatorFixedPort[],
  item: string,
  service: string | null,
): void {
  const proto = protoOf(item);
  const segs = portSegments(item);
  if (segs.length < 2) return; // container-only → ephemeral host port, can't target
  const last = segs.length - 1;
  const hostSeg = segs[last - 1];
  const containerPort = portOfSegment(segs[last]) ?? literalRange(segs[last])?.start ?? portOfSegment(hostSeg) ?? literalRange(hostSeg)?.start ?? null;

  // Bind IP (3-segment form): a `${VAR}` there is free-text host_ip config.
  if (segs.length >= 3) for (const t of tokensIn(segs[0])) addVar(map, t, 'host_ip', service, null);

  const hostToks = tokensIn(hostSeg);
  if (hostToks.length) {
    // Parameterized host port — unchanged behavior, adjustable via the var.
    for (const t of hostToks) addVar(map, t, 'host_port', service, containerPort);
    return;
  }
  const range = literalRange(hostSeg);
  if (!range || containerPort == null) return;
  fixed.push({
    service,
    containerPort,
    hostPort: range.start,
    hostPortEnd: range.end,
    mode: 'published',
    protocol: proto,
    variable: null,
    adjustable: false,
    source: 'compose',
  });
}

/**
 * Parse one `ports:` LONG-form item (`{ target, published, protocol, host_ip }`).
 * Same split as short form: a `${VAR}` in `published` is an adjustable host_port
 * variable; a literal is a fixed port.
 */
function addLongPort(
  map: Map<string, ReplicatorVariable>,
  fixed: ReplicatorFixedPort[],
  item: { service: string | null; target?: string; published?: string; protocol?: string },
): void {
  const containerPort = item.target != null ? (portOfSegment(item.target) ?? literalRange(item.target)?.start ?? null) : null;
  const published = (item.published ?? '').trim().replace(/^["']|["']$/g, '');
  if (!published) return; // no host side → ephemeral, skip
  const proto = item.protocol?.trim().toLowerCase() === 'udp' ? 'udp' : 'tcp';
  const toks = tokensIn(published);
  if (toks.length) {
    for (const t of toks) addVar(map, t, 'host_port', item.service, containerPort);
    return;
  }
  const range = literalRange(published);
  if (!range || containerPort == null) return;
  fixed.push({
    service: item.service,
    containerPort,
    hostPort: range.start,
    hostPortEnd: range.end,
    mode: 'published',
    protocol: proto,
    variable: null,
    adjustable: false,
    source: 'compose',
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
  const fixedPorts: ReplicatorFixedPort[] = [];
  const netHostServices = new Set<string>();
  const envFiles = new Set<string>();
  const warnings: string[] = [];

  // Stack of open mapping keys (indent + key), so we know the path to each line.
  const stack: { indent: number; key: string }[] = [];
  // A long-form ports item is spread across several indented lines; accumulate it
  // and flush when the next item starts or the `ports:` block closes.
  let longPort: { service: string | null; target?: string; published?: string; protocol?: string } | null = null;
  const flushLong = () => { if (longPort) { addLongPort(vars, fixedPorts, longPort); longPort = null; } };

  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = indentOf(raw);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();

    const keyM = raw.match(/^\s*([A-Za-z0-9_.-]+):\s*(.*)$/);
    const listM = raw.match(/^\s*-\s*(.*)$/);
    const parentKey = stack.length ? stack[stack.length - 1].key : undefined;
    const path = stack.map((f) => f.key);
    const service = path[0] === 'services' ? (path[1] ?? null) : null;

    // Left the ports block → finalize any half-built long-form item.
    if (longPort && parentKey !== 'ports') flushLong();

    // A key whose immediate parent is `services:` is a service name.
    if (keyM && parentKey === 'services') services.add(keyM[1]);

    const fieldKey = keyM ? keyM[1] : undefined;

    // `network_mode: host` → the service binds host ports directly (no mapping).
    if (fieldKey === 'network_mode' && /\bhost\b/.test(keyM![2]) && service) netHostServices.add(service);

    // `env_file:` targets, in either compose form: the scalar `env_file: .env`,
    // or a list whose items are bare paths or the long `- path: ./x.env`.
    if (fieldKey === 'env_file' && keyM![2].trim()) addEnvFile(envFiles, keyM![2]);
    else if (parentKey === 'env_file' && listM) addEnvFile(envFiles, listM[1].replace(/^path:\s*/, ''));

    if (parentKey === 'ports') {
      // Ports are parsed structurally — whether or not they carry a `${VAR}` —
      // so literal mappings and ranges are detected, not just parameterized ones.
      if (listM) {
        const content = listM[1].trim();
        const lm = content.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
        if (lm) { flushLong(); longPort = { service }; applyLongField(longPort, lm[1], lm[2]); }
        else addShortPort(vars, fixedPorts, content, service);
      } else if (keyM && longPort) {
        applyLongField(longPort, keyM[1], keyM[2]);
      }
    } else {
      const toks = tokensIn(raw);
      if (toks.length) {
        let role: ReplicatorVarRole = 'plain';
        if (fieldKey === 'image') role = 'image_tag';
        else if (fieldKey === 'container_name') role = 'container_name';
        for (const t of toks) addVar(vars, t, role, service, null);
      }
    }

    // Opening a nested block (a key with no inline value) pushes context.
    if (keyM && keyM[2].trim() === '') stack.push({ indent, key: keyM[1] });
  }
  flushLong();

  // Finalize secret flags: a secret-looking name that isn't a managed/port var.
  for (const v of vars.values()) {
    if (v.role === 'plain' && looksSecret(v.name)) { v.role = 'secret'; v.secret = true; }
    else v.secret = v.role === 'secret';
  }

  // Host-network services publish nothing, so infer the reachable port from a
  // PORT-style env var when there is an unambiguous one.
  for (const svc of netHostServices) {
    const pv = pickPortVar([...vars.values()], svc);
    if (pv) {
      const def = Number(pv.default);
      fixedPorts.push({ service: svc, containerPort: def, hostPort: def, mode: 'host_network', protocol: 'tcp', variable: pv.name, adjustable: true, source: 'compose' });
    } else {
      warnings.push(`Service "${svc}" uses host networking; Cerebro could not infer which port it listens on — add a reachable port by hand if you want to set up ingress.`);
    }
  }

  const paramHostPorts = [...vars.values()].filter((v) => v.role === 'host_port');
  if (paramHostPorts.some((v) => v.containerPort == null)) {
    warnings.push('A published-port variable had no detectable container port; defaulting it to the host port at deploy.');
  }
  if (!paramHostPorts.length && !fixedPorts.length) {
    warnings.push('No reachable port detected — this app may not expose a reachable port, or it binds one in a way Cerebro could not read. Add a reachable port by hand to set up ingress.');
  }

  return {
    variables: [...vars.values()].sort(sortVars),
    fixedPorts: dedupeFixed(fixedPorts),
    services: [...services],
    envFiles: [...envFiles],
    warnings,
  };
}

/** Apply one long-form `ports:` field (`target`/`published`/`protocol`). */
function applyLongField(item: { target?: string; published?: string; protocol?: string }, key: string, val: string): void {
  const v = val.trim();
  if (key === 'target') item.target = v;
  else if (key === 'published') item.published = v;
  else if (key === 'protocol') item.protocol = v;
}

/**
 * Pick the env var a host-network service listens on: an exact `PORT`, else a
 * single `*_PORT`/`*PORT` with a numeric default. Deliberately conservative — a
 * wrong guess would expose the wrong port, so ambiguity yields nothing (and a
 * warning telling the operator to add it by hand).
 */
function pickPortVar(vars: ReplicatorVariable[], service: string): ReplicatorVariable | null {
  const numeric = (v: ReplicatorVariable) => v.default != null && /^\d+$/.test(String(v.default)) && Number(v.default) > 0;
  const inSvc = vars.filter((v) => v.role === 'plain' && (v.service === service || v.service == null) && numeric(v));
  const exact = inSvc.find((v) => v.name === 'PORT');
  if (exact) return exact;
  const portish = inSvc.filter((v) => /_?PORT$/i.test(v.name));
  return portish.length === 1 ? portish[0] : null;
}

/** Drop duplicate fixed ports (same host port + protocol), keeping the first. */
function dedupeFixed(ports: ReplicatorFixedPort[]): ReplicatorFixedPort[] {
  const seen = new Set<string>();
  const out: ReplicatorFixedPort[] = [];
  for (const p of ports) {
    const k = `${p.hostPort}-${p.hostPortEnd ?? ''}-${p.protocol ?? 'tcp'}-${p.mode}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
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
    const secret = looksSecret(e.name);
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
