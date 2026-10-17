import { BadRequestException } from '@nestjs/common';
import type { ReplicatorMount } from '@cerebro/shared';

/**
 * Operator-added volume mounts, layered onto a deployment without touching the
 * repo's own compose file. The replicator deploys the cloned compose verbatim
 * (`docker compose -f <repo compose> up`); to add a mount we generate a second
 * compose file — a `docker-compose.override.yml` — and pass it as an extra `-f`,
 * which Docker merges over the base. The base manifest stays pristine, so a schema
 * refresh or an upstream change never clobbers the operator's mounts.
 *
 * A host bind mount punches straight through the replicator's per-instance
 * isolation (the whole point of the feature), so `sanitizeMounts` is the security
 * edge: it refuses the Docker socket and the host paths that would hand a
 * "deployment" control of the box, requires absolute paths, and blocks `..`
 * traversal. We deliberately expose only these specific fields — never a raw
 * compose fragment — so an operator can add storage but not re-open `privileged`,
 * `cap_add`, `network_mode`, or new services. See docs/app-replicator.md.
 */

/** Host-path prefixes a bind mount may never touch — the socket + anything that owns the host. */
const DENIED_SOURCE_PREFIXES = [
  '/proc', '/sys', '/dev', '/boot', '/etc',
  '/root', '/run', '/var/run', '/var/lib/docker',
];

/** Exact host paths a bind mount may never be (beyond the prefix rules). */
const DENIED_SOURCE_EXACT = new Set(['/', '/var/run/docker.sock', '/run/docker.sock']);

const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function isAbsolute(p: string): boolean {
  return p.startsWith('/');
}

function hasTraversal(p: string): boolean {
  return p.split('/').some((seg) => seg === '..');
}

/** True when `path` is the denied path or sits inside a denied directory. */
function underDenied(path: string, denied: string): boolean {
  return path === denied || path.startsWith(`${denied}/`);
}

/**
 * Validate the operator's mounts and normalize them into the stored shape. Throws
 * a BadRequestException on anything unsafe or malformed, so a bad mount fails at
 * the request edge rather than producing broken compose on the host.
 *
 * `knownServices` is the set of real service names in the app's compose; a mount
 * must attach to one (so the override never invents a phantom, image-less service
 * that would fail `docker compose config`). When detection found no service names
 * at all, any non-empty service is allowed rather than deadlocking the operator.
 */
export function sanitizeMounts(
  entries: ReplicatorMount[] | undefined,
  knownServices: Set<string>,
): ReplicatorMount[] {
  const out: ReplicatorMount[] = [];
  const seen = new Set<string>(); // service|target — one target per service

  for (const raw of entries ?? []) {
    const service = String(raw?.service ?? '').trim();
    const type = raw?.type === 'volume' ? 'volume' : 'bind';
    const source = String(raw?.source ?? '').trim();
    const target = String(raw?.target ?? '').trim();
    const readOnly = !!raw?.readOnly;

    if (!service) throw new BadRequestException('Every mount needs a service.');
    if (knownServices.size > 0 && !knownServices.has(service)) {
      throw new BadRequestException(`"${service}" isn't a service in this app's compose. Pick one of: ${[...knownServices].join(', ')}.`);
    }

    if (!source) throw new BadRequestException(`The ${type === 'bind' ? 'host path' : 'volume name'} is required for the mount on ${service}.`);
    if (!target) throw new BadRequestException(`The container path is required for the mount on ${service}.`);
    if (!isAbsolute(target) || hasTraversal(target)) {
      throw new BadRequestException(`The container path "${target}" must be an absolute path with no "..".`);
    }

    if (type === 'bind') {
      if (!isAbsolute(source) || hasTraversal(source)) {
        throw new BadRequestException(`The host path "${source}" must be an absolute path with no "..".`);
      }
      if (DENIED_SOURCE_EXACT.has(source) || DENIED_SOURCE_PREFIXES.some((d) => underDenied(source, d))) {
        throw new BadRequestException(`"${source}" can't be bind-mounted — it's a host system path (or the Docker socket). Mount a dedicated data directory instead.`);
      }
    } else {
      if (!VOLUME_NAME_RE.test(source)) {
        throw new BadRequestException(`"${source}" isn't a valid Docker volume name — use letters, digits, and _ . - (starting with a letter or digit).`);
      }
    }

    const key = `${service}|${target}`;
    if (seen.has(key)) throw new BadRequestException(`The service ${service} already has a mount at ${target}.`);
    seen.add(key);

    out.push({ service, type, source, target, readOnly });
  }
  return out;
}

/**
 * A double-quoted YAML scalar for the generated override. `$` is doubled because
 * Compose runs its own `${..}` interpolation over the override file too, so a
 * literal `$` in a path or value must be escaped or it would be read as a (usually
 * unset) variable reference — the same reason the `.env` writer doubles `$`.
 */
function yq(s: string): string {
  const esc = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$');
  return `"${esc}"`;
}

/**
 * Render the operator's additions as a `docker-compose.override.yml` string, or
 * null when there's nothing to add (the caller then removes any stale override on
 * the host). Two kinds of addition ride in it:
 *
 *  - **Mounts** — bind/named volumes, in the long mount syntax so a `:` in a path
 *    can't be misparsed, with `create_host_path: false` on binds so a missing host
 *    path (e.g. a NAS share that didn't mount) fails loudly instead of silently
 *    binding an empty local directory.
 *  - **Extra env** — the deployment's operator-added environment, injected into the
 *    container's `environment:`. The replicator also writes these into the stack's
 *    `.env`, but Compose only uses `.env` for `${VAR}` *interpolation*: a key the
 *    app's compose never references (and no `env_file:` pulls in) would otherwise
 *    sit in `.env` and never reach the container. Injecting it here makes an extra
 *    actually take effect regardless of what the repo's compose mentions.
 *
 * Extra env is deployment-wide, so it's attached to every known service
 * (`envServices`); falling back to the mount services when none are known.
 */
export function renderComposeOverride(
  project: string,
  mounts: ReplicatorMount[],
  extraEnv: Record<string, string> = {},
  envServices: string[] = [],
): string | null {
  const envKeys = Object.keys(extraEnv);
  if (!mounts.length && envKeys.length === 0) return null;

  const mountsBySvc = new Map<string, ReplicatorMount[]>();
  for (const m of mounts) {
    const list = mountsBySvc.get(m.service) ?? [];
    list.push(m);
    mountsBySvc.set(m.service, list);
  }
  const envSvcSet = new Set(
    envKeys.length ? (envServices.length ? envServices : [...mountsBySvc.keys()]) : [],
  );
  const services = new Set<string>([...mountsBySvc.keys(), ...envSvcSet]);
  const namedVolumes = [...new Set(mounts.filter((m) => m.type === 'volume').map((m) => m.source))];

  const lines: string[] = [
    `# Generated by Cerebro App Replicator for "${project}" — operator-added mounts + env.`,
    '# Do not edit: this file is regenerated (or removed) on every deploy.',
    'services:',
  ];
  for (const service of services) {
    lines.push(`  ${service}:`);
    if (envSvcSet.has(service) && envKeys.length) {
      lines.push('    environment:');
      for (const k of envKeys) lines.push(`      ${k}: ${yq(extraEnv[k])}`);
    }
    const ms = mountsBySvc.get(service) ?? [];
    if (ms.length) {
      lines.push('    volumes:');
      for (const m of ms) {
        lines.push(`      - type: ${m.type}`);
        lines.push(`        source: ${yq(m.source)}`);
        lines.push(`        target: ${yq(m.target)}`);
        if (m.readOnly) lines.push('        read_only: true');
        if (m.type === 'bind') lines.push('        bind:\n          create_host_path: false');
      }
    }
  }
  if (namedVolumes.length) {
    lines.push('volumes:');
    for (const name of namedVolumes) lines.push(`  ${name}: {}`);
  }
  return lines.join('\n') + '\n';
}
