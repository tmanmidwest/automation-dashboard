import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { sealBundle } from '../system-backup/bundle';
import type { SecretMode } from '@cerebro/shared';
import type { StackInspection } from './stack-inspect';

/**
 * Decides what a snapshot records about a stack's credentials.
 *
 * A stack's secrets arrive by three routes (docs/stack-backup.md): the vault, via
 * an App Replicator deployment; a vault git credential, for a git-sourced stack;
 * or plain text somebody typed into an `.env` on the host. The first two Cerebro
 * can re-materialize on restore; the third it cannot, which is why a
 * vault-reference-only design would silently produce unrestorable backups for
 * exactly the hand-rolled bare-host stacks this feature exists to protect.
 *
 * Phase 1 records the **known** bindings (no vault reads, no guessing) and the
 * keyed digest of every value, and captures the values themselves according to
 * the policy's secretMode. Phase 2 adds inferred + declared bindings.
 */

/** Where a var→vault-key binding came from. */
export type BindingOrigin = 'replicator' | 'git-credential' | 'inferred' | 'declared';

export interface SecretBinding {
  /** Environment variable name, or a pseudo-name like `@git` for a non-env credential. */
  varName: string;
  vaultKey: string;
  origin: BindingOrigin;
  /** Keyed digest of the value at capture time — detects drift at restore time. */
  digest?: string;
}

/** The unsealed inventory written to the snapshot as `secrets.json`. Names and
 *  keyed digests only — never a value, in any secretMode. */
export interface SecretInventory {
  schema: 1;
  secretMode: SecretMode;
  /** Every env var seen across the stack's containers, with a keyed digest. */
  variables: { name: string; containers: string[]; digest: string; vaultKey?: string; origin?: BindingOrigin }[];
  bindings: SecretBinding[];
  /** True when the `.env` values live in `secrets.sealed` rather than `stack.env`. */
  sealed: boolean;
  /** Vars with no known vault binding — the ones a `reference`-mode restore could not resolve. */
  unbound: string[];
}

/** The sealed (or, in raw mode, plain) payload carrying actual values. */
export interface SecretPayload {
  schema: 1;
  /** Resolved environment per container name. */
  containers: Record<string, Record<string, string>>;
  /** The stack's `.env` file as found on the host, when there is one. */
  env?: string;
  bindings: SecretBinding[];
}

export interface CaptureSecretsInput {
  instanceId: string;
  stackName: string;
  inspection: StackInspection;
  secretMode: SecretMode;
  /** The stack's `.env` contents, when Cerebro could read one. */
  envFile?: string;
  /** Required for secretMode 'embed'. */
  passphrase?: string;
}

export interface CapturedSecrets {
  /** Files to add to the snapshot's meta directory. */
  files: Record<string, string>;
  inventory: SecretInventory;
}

@Injectable()
export class SecretCaptureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

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
   * Build the snapshot's secret files. `embed` seals the values under an operator
   * passphrase (so the backup survives losing Cerebro without handing credentials
   * to whoever holds the repository key); `raw` writes them as found; `reference`
   * is Phase 2 and is rejected here rather than silently degrading.
   */
  async capture(input: CaptureSecretsInput): Promise<CapturedSecrets> {
    const { secretMode, inspection } = input;
    if (secretMode === 'reference') {
      throw new Error("secretMode 'reference' arrives in Phase 2 — use 'embed' (sealed) or 'raw' for now.");
    }
    if (secretMode === 'embed' && !input.passphrase) {
      throw new Error('This backup seals its secrets, so it needs a passphrase. Supply one, or switch the policy to raw.');
    }

    const bindings = await this.knownBindings(input.instanceId, input.stackName);
    const byVar = new Map(bindings.map((b) => [b.varName, b]));

    // One entry per distinct variable across the stack, with the containers that carry it.
    const seen = new Map<string, { containers: string[]; value: string }>();
    const containers: Record<string, Record<string, string>> = {};
    for (const c of inspection.containers) {
      containers[c.name] = c.env;
      for (const [name, value] of Object.entries(c.env)) {
        const entry = seen.get(name);
        if (entry) entry.containers.push(c.name);
        else seen.set(name, { containers: [c.name], value });
      }
    }

    const variables = [...seen.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, v]) => {
        const binding = byVar.get(name);
        return {
          name,
          containers: v.containers,
          digest: this.crypto.valueDigest(v.value),
          vaultKey: binding?.vaultKey,
          origin: binding?.origin,
        };
      });

    // Stamp each binding with the digest of the value actually captured, so a Phase 3
    // restore can tell "the vault still holds what this snapshot was taken with" from
    // "someone rotated it since" — the case that otherwise restores a database volume
    // and an .env that disagree about the password.
    for (const b of bindings) {
      const v = seen.get(b.varName);
      if (v) b.digest = this.crypto.valueDigest(v.value);
    }

    const payload: SecretPayload = { schema: 1, containers, env: input.envFile, bindings };
    const inventory: SecretInventory = {
      schema: 1,
      secretMode,
      variables,
      bindings,
      sealed: secretMode === 'embed',
      unbound: variables.filter((v) => !v.vaultKey).map((v) => v.name),
    };

    const files: Record<string, string> = {
      'secrets.json': `${JSON.stringify(inventory, null, 2)}\n`,
    };
    if (secretMode === 'embed') {
      files['secrets.sealed.b64'] = `${sealBundle(payload, input.passphrase!).toString('base64')}\n`;
      // The plaintext .env is deliberately NOT written alongside a sealed capture.
      if (input.envFile) files['stack.env.redacted'] = redactEnv(input.envFile);
    } else {
      files['secrets.raw.json'] = `${JSON.stringify(payload, null, 2)}\n`;
      if (input.envFile) files['stack.env'] = input.envFile;
    }
    return { files, inventory };
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
