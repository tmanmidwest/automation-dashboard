import { dump } from 'js-yaml';
import type { StackInspection } from './stack-inspect';

/**
 * Reconstruct a docker-compose.yml from a running stack's inspection, for migrating a
 * stack Cerebro has no compose for (e.g. one deployed by Portainer, whose compose lives
 * in Portainer's own storage). Best-effort and meant to be reviewed/edited before use:
 *
 *  - image / restart / published ports / environment / volumes / custom networks are
 *    reconstructed from what's actually running;
 *  - built images are migrated as images (save→load), so `image:` is correct even though
 *    a `build:` context can't be recovered;
 *  - named volumes are referenced by their REAL name as `external: true`, so the restored
 *    data maps to the exact volume the stack used (no compose project-prefix guessing);
 *  - command/entrypoint/healthcheck are left to the image defaults (the container ran with
 *    them); container_name is omitted so Compose names them under the new project.
 *
 * Env values are included (the stack needs them) and sealed by the migration's secret mode
 * like any other compose. A handful of image/runtime-default vars are dropped as noise.
 */
const ENV_DENYLIST = new Set(['PATH', 'HOME', 'HOSTNAME', 'TERM', 'PWD', 'SHLVL', 'container', 'GPG_KEY', 'LANG']);
const BUILTIN_NETWORKS = new Set(['bridge', 'host', 'none']);

export function synthesizeCompose(inspection: StackInspection): string | null {
  const containers = inspection.containers ?? [];
  if (!containers.length) return null;

  const services: Record<string, Record<string, unknown>> = {};
  const volumes: Record<string, unknown> = {};
  const networks: Record<string, unknown> = {};
  const usedNames = new Set<string>();

  // Compose starts dependencies first; `created` order approximates that.
  const ordered = [...containers].sort((a, b) => (a.created ?? 0) - (b.created ?? 0));

  for (const c of ordered) {
    let name = (c.service || sanitize(c.name) || sanitize(c.image) || 'service').slice(0, 63) || 'service';
    while (usedNames.has(name)) name = `${name}-2`;
    usedNames.add(name);

    const svc: Record<string, unknown> = {};
    if (c.image) svc.image = c.image;
    if (c.restartPolicy && c.restartPolicy !== 'no' && c.restartPolicy !== '') svc.restart = c.restartPolicy;

    const ports = (c.ports ?? [])
      .filter((p) => p.hostPort)
      .map((p) => {
        const ip = p.hostIp && p.hostIp !== '0.0.0.0' && p.hostIp !== '::' ? `${p.hostIp}:` : '';
        return `${ip}${p.hostPort}:${p.containerPort}`;
      });
    if (ports.length) svc.ports = ports;

    const vols: string[] = [];
    for (const m of c.mounts ?? []) {
      const ro = m.rw === false ? ':ro' : '';
      if (m.type === 'volume' && m.name) {
        vols.push(`${m.name}:${m.destination}${ro}`);
        volumes[m.name] = { external: true }; // reference the exact existing volume
      } else if (m.type === 'bind' && m.source) {
        vols.push(`${m.source}:${m.destination}${ro}`);
      }
    }
    if (vols.length) svc.volumes = vols;

    const env: string[] = [];
    for (const [k, v] of Object.entries(c.env ?? {})) if (!ENV_DENYLIST.has(k)) env.push(`${k}=${v}`);
    if (env.length) svc.environment = env;

    const nets = (c.networks ?? []).filter((n) => n && !BUILTIN_NETWORKS.has(n) && !n.endsWith('_default'));
    if (nets.length) {
      svc.networks = nets;
      for (const n of nets) networks[n] = { external: true };
    }

    services[name] = svc;
  }

  const doc: Record<string, unknown> = { services };
  if (Object.keys(volumes).length) doc.volumes = volumes;
  if (Object.keys(networks).length) doc.networks = networks;

  const header =
    '# Reconstructed by Cerebro from the running containers (no compose was available for\n' +
    '# this stack). Review and edit before migrating — build contexts, command/entrypoint,\n' +
    '# healthchecks and networks may need adjusting.\n';
  return header + dump(doc, { lineWidth: 160, noRefs: true });
}

function sanitize(v?: string): string {
  return (v ?? '').toLowerCase().replace(/^\/+/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}
