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

/** Double-quote a scalar for the generated YAML (paths may contain spaces). */
function yq(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Render the mounts as a `docker-compose.override.yml` string, or null when there
 * are none (the caller then removes any stale override on the host). Uses the long
 * mount syntax so a `:` in a path can never be misparsed, and sets
 * `create_host_path: false` on binds so a missing host path (e.g. a NAS share that
 * didn't mount) fails loudly instead of silently binding an empty local directory.
 */
export function renderComposeOverride(project: string, mounts: ReplicatorMount[]): string | null {
  if (!mounts.length) return null;

  const byService = new Map<string, ReplicatorMount[]>();
  for (const m of mounts) {
    const list = byService.get(m.service) ?? [];
    list.push(m);
    byService.set(m.service, list);
  }
  const namedVolumes = [...new Set(mounts.filter((m) => m.type === 'volume').map((m) => m.source))];

  const lines: string[] = [
    `# Generated by Cerebro App Replicator for "${project}" — operator-added mounts.`,
    '# Do not edit: this file is regenerated (or removed) on every deploy.',
    'services:',
  ];
  for (const [service, list] of byService) {
    lines.push(`  ${service}:`);
    lines.push('    volumes:');
    for (const m of list) {
      lines.push(`      - type: ${m.type}`);
      lines.push(`        source: ${yq(m.source)}`);
      lines.push(`        target: ${yq(m.target)}`);
      if (m.readOnly) lines.push('        read_only: true');
      if (m.type === 'bind') lines.push('        bind:\n          create_host_path: false');
    }
  }
  if (namedVolumes.length) {
    lines.push('volumes:');
    for (const name of namedVolumes) lines.push(`  ${name}: {}`);
  }
  return lines.join('\n') + '\n';
}
