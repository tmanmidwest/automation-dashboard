import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { SecretsService } from '../secrets/secrets.service';
import { sealBundle } from '../system-backup/bundle';
import { looksSecret } from '../app-replicator/compose-introspect';
import type { BindingOrigin, SecretMode } from '@cerebro/shared';
import type { StackInspection } from './stack-inspect';

/**
 * Decides what a snapshot records about a stack's credentials, and works out
 * which of them the vault already knows.
 *
 * A stack's secrets arrive by three routes (docs/stack-backup.md): the vault, via
 * an App Replicator deployment; a vault git credential, for a git-sourced stack;
 * or plain text somebody typed into an `.env` on the host. The first two Cerebro
 * can re-materialize on restore; the third it cannot, which is why a
 * vault-reference-only design would silently produce unrestorable backups for
 * exactly the hand-rolled bare-host stacks this feature exists to protect.
 *
 * Phase 2 closes that gap from both ends: it *infers* bindings by matching keyed
 * value digests against the vault, and lets an operator *declare* one (promoting
 * a plaintext value into the vault as it goes).
 */

export interface SecretBinding {
  varName: string;
  vaultKey: string;
  origin: BindingOrigin;
  digest?: string;
}

/** One environment variable of a stack, resolved against the vault. */
export interface ResolvedVariable {
  name: string;
  containers: string[];
  /** Live value on the host. Never leaves the server except through a capture. */
  value: string;
  digest: string;
  /** The name looks like a credential (shared heuristic with the App Replicator). */
  secretish: boolean;
  vaultKey?: string;
  origin?: BindingOrigin;
}

/** The unsealed inventory written to the snapshot as `secrets.json`. Names and
 *  keyed digests only — never a value, in any secretMode. */
export interface SecretInventory {
  schema: 1;
  secretMode: SecretMode;
  variables: { name: string; containers: string[]; digest: string; secretish: boolean; vaultKey?: string; origin?: BindingOrigin }[];
  bindings: SecretBinding[];
  sealed: boolean;
  /** Secret-looking variables with no vault binding — what a `reference` restore could not resolve. */
  unbound: string[];
  /** Credentials written literally inside the compose file (see redactCompose). */
  inlineComposeSecrets?: string[];
  /** Compose `secrets:`/`configs:` entries and `*_FILE` targets — host files that are
   *  themselves credentials. Captured into the payload in sealed/raw mode; listed here
   *  either way so it is never a silent gap. */
  fileSecrets?: string[];
  /** Of those, the ones whose contents made it into the snapshot. */
  capturedFiles?: string[];
}

/** The sealed (or, in raw mode, plain) payload carrying actual values. */
export interface SecretPayload {
  schema: 1;
  containers: Record<string, Record<string, string>>;
  env?: string;
  bindings: SecretBinding[];
  /** Literal values lifted out of the compose file, keyed by their redaction marker. */
  composeSecrets?: Record<string, string>;
  /** Credential files read off the host, keyed by their absolute path. */
  files?: Record<string, string>;
}

export interface CaptureSecretsInput {
  instanceId: string;
  stackName: string;
  inspection: StackInspection;
  secretMode: SecretMode;
  envFile?: string;
  compose?: string;
  passphrase?: string;
  /** Reads a credential file off the host, so `*_FILE` and compose `secrets:` targets
   *  are captured rather than silently missing. Returns null when unreadable. */
  readHostFile?: (path: string) => Promise<string | null>;
}

export interface CapturedSecrets {
  files: Record<string, string>;
  inventory: SecretInventory;
  /** The compose to store, with inline credentials redacted when the mode calls for it. */
  compose?: string;
}

@Injectable()
export class SecretCaptureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly secrets: SecretsService,
  ) {}

  // ── Discovery ─────────────────────────────────────────────────────

  /**
   * Bindings Cerebro can state as fact, with no vault reads and no guessing:
   * variables an App Replicator deployment put in the vault itself, and the git
   * credential a git-sourced stack needs in order to be redeployed at all.
   */
  async knownBindings(instanceId: string, stackName: string): Promise<SecretBinding[]> {
    const out: SecretBinding[] = [];

    const deployment = await this.prisma.replicatorDeployment
      .findFirst({ where: { dockerInstanceId: instanceId, project: stackName } })
      .catch(() => null);
    if (deployment) {
      for (const name of [...deployment.secretVars, ...deployment.extraSecretVars]) {
        out.push({ varName: name, vaultKey: `deployment:${deployment.id}:${name}`, origin: 'replicator' });
      }
    }

    const stack = await this.prisma.dockerStack
      .findUnique({ where: { connectorInstanceId_name: { connectorInstanceId: instanceId, name: stackName } } })
      .catch(() => null);
    if (stack?.gitCredKey) {
      out.push({ varName: '@git', vaultKey: stack.gitCredKey, origin: 'git-credential' });
    }
    return out;
  }

  /**
   * Resolve every variable of a running stack against the vault.
   *
   * Precedence is deliberate: a **declared** binding is the operator's word and
   * outranks everything; then what the replicator actually stored; then a
   * digest match, which is strong evidence but still an inference — the same
   * value could legitimately appear in two places.
   */
  async discover(instanceId: string, stackName: string, inspection: StackInspection): Promise<ResolvedVariable[]> {
    const known = new Map((await this.knownBindings(instanceId, stackName)).map((b) => [b.varName, b]));
    const declared = new Map(
      (await this.prisma.stackSecretBinding
        .findMany({ where: { connectorInstanceId: instanceId, stackName, origin: 'declared' } })
        .catch(() => []))
        .map((r) => [r.varName, r]),
    );

    // One pass over the vault, digested — no plaintext crosses the boundary and
    // nothing is marked as "used" just because a backup looked at it.
    const vaultDigests = await this.secrets.digestAll().catch(() => new Map<string, string[]>());

    const seen = new Map<string, { containers: string[]; value: string }>();
    for (const c of inspection.containers) {
      for (const [name, value] of Object.entries(c.env)) {
        const entry = seen.get(name);
        if (entry) entry.containers.push(c.name);
        else seen.set(name, { containers: [c.name], value });
      }
    }

    const out: ResolvedVariable[] = [];
    for (const [name, v] of [...seen.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const digest = this.crypto.valueDigest(v.value);
      let vaultKey: string | undefined;
      let origin: BindingOrigin | undefined;

      const dec = declared.get(name);
      if (dec?.vaultKey) {
        vaultKey = dec.vaultKey;
        origin = 'declared';
      } else if (known.has(name)) {
        vaultKey = known.get(name)!.vaultKey;
        origin = 'replicator';
      } else {
        const match = vaultDigests.get(digest);
        if (match?.length) {
          vaultKey = match[0];
          origin = 'inferred';
        }
      }

      out.push({ name, containers: v.containers, value: v.value, digest, secretish: looksSecret(name), vaultKey, origin });
    }

    // Non-env credentials (the git clone credential) have no container variable
    // but still belong in the map — without it a git stack cannot be redeployed.
    for (const b of known.values()) {
      if (b.varName.startsWith('@') && !out.some((v) => v.name === b.varName)) {
        out.push({ name: b.varName, containers: [], value: '', digest: '', secretish: true, vaultKey: b.vaultKey, origin: b.origin });
      }
    }
    return out;
  }

  /** Write the discovered map back, so the vault can show what uses each key. */
  async persist(instanceId: string, stackName: string, vars: ResolvedVariable[]): Promise<void> {
    for (const v of vars) {
      // Never downgrade an operator's declaration to an inference.
      if (v.origin !== 'declared') {
        const existing = await this.prisma.stackSecretBinding
          .findUnique({ where: { connectorInstanceId_stackName_varName: { connectorInstanceId: instanceId, stackName, varName: v.name } } })
          .catch(() => null);
        if (existing?.origin === 'declared') continue;
      }
      const data = {
        vaultKey: v.vaultKey ?? null,
        origin: v.origin ?? 'inferred',
        valueDigest: v.digest || null,
        secretish: v.secretish,
        lastSeenAt: new Date(),
      };
      await this.prisma.stackSecretBinding.upsert({
        where: { connectorInstanceId_stackName_varName: { connectorInstanceId: instanceId, stackName, varName: v.name } },
        update: data,
        create: { connectorInstanceId: instanceId, stackName, varName: v.name, ...data },
      }).catch(() => { /* bookkeeping must never fail a backup */ });
    }
  }

  // ── Capture ───────────────────────────────────────────────────────

  /**
   * Build the snapshot's secret files. `embed` seals the values under an operator
   * passphrase; `reference` writes only vault placeholders and refuses to run if
   * anything secret-looking is unbound; `raw` writes them as found.
   */
  async capture(input: CaptureSecretsInput): Promise<CapturedSecrets> {
    const { secretMode, inspection } = input;
    if (secretMode === 'embed' && !input.passphrase) {
      throw new BadRequestException('This backup seals its secrets, so it needs a passphrase. Supply one, or switch the policy to raw.');
    }

    const variables = await this.discover(input.instanceId, input.stackName, inspection);
    await this.persist(input.instanceId, input.stackName, variables);

    const bindings: SecretBinding[] = variables
      .filter((v) => v.vaultKey)
      .map((v) => ({ varName: v.name, vaultKey: v.vaultKey!, origin: v.origin!, digest: v.digest || undefined }));
    const unbound = variables.filter((v) => v.secretish && !v.vaultKey).map((v) => v.name);

    // Credentials living literally inside the compose file would otherwise be
    // captured in the clear whatever the mode said — which would quietly break
    // exactly the promise `embed` and `reference` make.
    const { redacted, values: composeSecrets, names: inlineNames } =
      secretMode === 'raw' ? { redacted: input.compose, values: {}, names: [] as string[] } : redactCompose(input.compose);
    const fileSecrets = detectFileSecrets(input.compose, variables);
    const fileSecretLabels = fileSecrets.map((f) => f.label);

    if (secretMode === 'reference') {
      if (unbound.length) {
        throw new BadRequestException(
          `Vault-reference mode needs every credential bound to a vault key first. Unbound: ${unbound.join(', ')}. ` +
          'Promote them into the vault from this stack\'s secrets view, or use sealed mode.',
        );
      }
      if (inlineNames.length) {
        throw new BadRequestException(
          `These credentials are written literally in the compose file, so there is nothing for a vault reference to point at: ${inlineNames.join(', ')}. ` +
          'Move them into the .env (or the vault) first, or use sealed mode.',
        );
      }
    }

    const containers: Record<string, Record<string, string>> = {};
    for (const c of inspection.containers) containers[c.name] = c.env;

    // File-based credentials go into the sealed/raw payload, never in the clear:
    // they are exactly as sensitive as the values in the .env beside them.
    const capturedFileContents: Record<string, string> = {};
    if (input.readHostFile && secretMode !== 'reference') {
      for (const f of fileSecrets) {
        const content = await input.readHostFile(f.path).catch(() => null);
        if (content == null) continue;
        if (Buffer.byteLength(content) > MAX_FILE_SECRET_BYTES) continue; // not a credential at that size
        capturedFileContents[f.path] = content;
      }
    }
    const capturedFiles = Object.keys(capturedFileContents);

    const inventory: SecretInventory = {
      schema: 1,
      secretMode,
      variables: variables.map((v) => ({
        name: v.name,
        containers: v.containers,
        digest: v.digest,
        secretish: v.secretish,
        vaultKey: v.vaultKey,
        origin: v.origin,
      })),
      bindings,
      sealed: secretMode === 'embed',
      unbound,
      ...(inlineNames.length ? { inlineComposeSecrets: inlineNames } : {}),
      ...(fileSecretLabels.length ? { fileSecrets: fileSecretLabels } : {}),
      ...(capturedFiles.length ? { capturedFiles } : {}),
    };

    const files: Record<string, string> = {
      'secrets.json': `${JSON.stringify(inventory, null, 2)}\n`,
    };

    if (secretMode === 'embed') {
      const payload: SecretPayload = {
        schema: 1, containers, env: input.envFile, bindings, composeSecrets, files: capturedFileContents,
      };
      files['secrets.sealed.b64'] = `${sealBundle(payload, input.passphrase!).toString('base64')}\n`;
      if (input.envFile) files['stack.env.redacted'] = redactEnv(input.envFile);
    } else if (secretMode === 'reference') {
      // Nothing secret is written at all: the .env keeps its shape with each bound
      // value replaced by the key it came from, and restore resolves them live.
      const byName = new Map(variables.map((v) => [v.name, v]));
      if (input.envFile) files['stack.env.reference'] = referenceEnv(input.envFile, byName);
    } else {
      const payload: SecretPayload = { schema: 1, containers, env: input.envFile, bindings, files: capturedFileContents };
      files['secrets.raw.json'] = `${JSON.stringify(payload, null, 2)}\n`;
      if (input.envFile) files['stack.env'] = input.envFile;
    }

    return { files, inventory, compose: redacted };
  }
}

/**
 * Keep an `.env`'s shape — key order, comments, which keys exist — while dropping
 * every value. Useful for reading a snapshot's configuration without unsealing it.
 */
export function redactEnv(env: string): string {
  return env
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      const i = line.indexOf('=');
      return i > 0 ? `${line.slice(0, i)}=<sealed>` : line;
    })
    .join('\n');
}

/** Rewrite an `.env` so each bound value becomes the vault key it came from. */
export function referenceEnv(env: string, byName: Map<string, { vaultKey?: string }>): string {
  return env
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      const i = line.indexOf('=');
      if (i <= 0) return line;
      const name = line.slice(0, i).trim();
      const key = byName.get(name)?.vaultKey;
      return key ? `${line.slice(0, i)}=\${vault:${key}}` : line;
    })
    .join('\n');
}

/** A credential file larger than this isn't a credential — don't sweep it in. */
const MAX_FILE_SECRET_BYTES = 256 * 1024;

/** The marker a redacted compose literal is replaced with. */
const COMPOSE_MARKER = (n: number) => `<cerebro-sealed-${n}>`;
const COMPOSE_MARKER_RE = /<cerebro-sealed-(\d+)>/g;

/**
 * Lift credentials written literally inside a compose file out into the sealed
 * payload, leaving a marker behind.
 *
 * Deliberately a line scan rather than a YAML parse — the same pragmatic approach
 * the App Replicator's compose introspector takes — and deliberately conservative:
 * only secret-looking names with a literal value are touched, never a `${VAR}`
 * interpolation. A false positive costs nothing, because restore substitutes the
 * exact original text back.
 */
export function redactCompose(compose?: string): { redacted?: string; values: Record<string, string>; names: string[] } {
  if (!compose) return { redacted: compose, values: {}, names: [] };
  const values: Record<string, string> = {};
  const names: string[] = [];
  let n = 0;

  const out = compose.split('\n').map((line) => {
    // `- KEY=value` (list form) or `KEY: value` (map form) inside environment:.
    const m = /^(\s*-?\s*)([A-Za-z_][A-Za-z0-9_]*)\s*(=|:\s)\s*(.+?)\s*$/.exec(line);
    if (!m) return line;
    const [, indent, name, sep, rawValue] = m;
    if (!looksSecret(name)) return line;

    const value = rawValue.replace(/^["']|["']$/g, '');
    // An interpolation or an empty value is not a literal credential.
    if (!value || value.includes('${') || value.startsWith('<cerebro-sealed-')) return line;

    const marker = COMPOSE_MARKER(n);
    values[marker] = rawValue;
    names.push(name);
    n += 1;
    return `${indent}${name}${sep === '=' ? '=' : ': '}${marker}`;
  });

  return { redacted: out.join('\n'), values, names };
}

/** Put the literals back into a redacted compose file at restore time. */
export function restoreCompose(compose: string, values: Record<string, string> = {}): string {
  return compose.replace(COMPOSE_MARKER_RE, (marker) => values[marker] ?? marker);
}

/** A credential that lives in a file on the host rather than in the environment. */
export interface FileSecret {
  /** How to describe it to a human, e.g. `DB_PASSWORD_FILE=/run/secrets/db`. */
  label: string;
  /** The path to read. Note it is the path *inside the container* for `*_FILE`. */
  path: string;
  /** `env` targets are container paths; `compose` ones are host paths. */
  source: 'env' | 'compose';
}

/**
 * Credentials that live in a *file* — compose `secrets:`/`configs:` entries (host
 * paths) and the `*_FILE` convention (container paths). They usually sit outside
 * the stack's volumes, so without this they would be missing from an otherwise
 * complete backup, and missing silently.
 */
export function detectFileSecrets(compose: string | undefined, variables: { name: string; value: string }[]): FileSecret[] {
  const out = new Map<string, FileSecret>();
  for (const v of variables) {
    if (/_FILE$/i.test(v.name) && v.value.startsWith('/')) {
      out.set(v.value, { label: `${v.name}=${v.value}`, path: v.value, source: 'env' });
    }
  }
  if (compose) {
    // Top-level `secrets:`/`configs:` blocks with a `file:` source.
    for (const m of compose.matchAll(/^\s*file:\s*(.+?)\s*$/gm)) {
      const path = m[1].replace(/^["']|["']$/g, '');
      if (path.startsWith('/') || path.startsWith('./')) {
        out.set(path, { label: path, path, source: 'compose' });
      }
    }
  }
  return [...out.values()];
}
