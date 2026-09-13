import * as yaml from 'js-yaml';
import { slug } from './deploy-target';
import type { EcsTaskDefInput, EcsContainerDef } from '../connectors/aws/aws-api';

/**
 * Translate an app's Docker Compose file into a single Fargate task definition
 * (all services become co-located containers sharing localhost — parity with a
 * single-host `docker compose up`), plus an optional cloudflared sidecar for
 * ingress. Values are interpolated from the resolved env dictionary the Docker
 * target would hand compose; the image of a `build:` service is replaced with the
 * ECR image Cerebro built and pushed. See docs/app-replicator-ecs-target.md.
 */

/** Resolve compose `${VAR}` interpolation forms against the env dictionary. */
export function interpolate(text: string, env: Map<string, string>): string {
  const out = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|-|:\?|\?|:\+|\+)([^}]*))?\}/g, (_m, name: string, op: string, arg: string) => {
    const has = env.has(name);
    const val = env.get(name) ?? '';
    const set = has && val !== ''; // ':' variants treat an empty value as unset
    switch (op) {
      case ':-': return set ? val : (arg ?? '');
      case '-': return has ? val : (arg ?? '');
      case ':+': return set ? (arg ?? '') : '';
      case '+': return has ? (arg ?? '') : '';
      case ':?':
      case '?': return val; // never throw at translate time
      default: return val;
    }
  });
  // Compose uses `$$` to escape a literal `$`.
  return out.replace(/\$\$/g, '$');
}

/** Normalize a compose `environment:` block (list or map form) to name/value pairs. */
function envEntries(raw: unknown, env: Map<string, string>): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const s = String(item);
      const eq = s.indexOf('=');
      if (eq < 0) {
        const name = s.trim();
        const v = env.get(name);
        if (name && v != null) out.push({ name, value: v }); // "KEY" → inherit from the env dict
      } else {
        const name = s.slice(0, eq).trim();
        if (name) out.push({ name, value: interpolate(s.slice(eq + 1), env) });
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
      out.push({ name, value: interpolate(v == null ? '' : String(v), env) });
    }
  }
  return out;
}

/** Container ports from a compose `ports:` block (short `H:C` or long `{target}` form). */
function containerPorts(raw: unknown, env: Map<string, string>): number[] {
  const out: number[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const t = Number((item as { target?: unknown }).target);
      if (Number.isFinite(t) && t > 0) out.push(t);
      continue;
    }
    const s = interpolate(String(item), env).split('/')[0]; // strip /proto
    const segs = s.split(':');
    const n = Number(segs[segs.length - 1].trim());
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

function commandOf(raw: unknown, env: Map<string, string>): string[] | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) return raw.map((c) => interpolate(String(c), env));
  const s = interpolate(String(raw), env).trim();
  return s ? ['sh', '-c', s] : undefined; // compose string form runs under a shell
}

export interface TaskDefBuildInput {
  family: string;
  composeText: string;
  /** ECR image URI for `build:` services (Cerebro built + pushed it). */
  ecrImageUri: string;
  /** Resolved interpolation dictionary (buildEnvMap output). */
  env: Map<string, string>;
  logGroup: string;
  executionRoleArn: string;
  taskRoleArn?: string;
  cpu: string;
  memory: string;
  /** When present, appends a cloudflared sidecar joined to this tunnel (Phase 3 ingress). */
  cloudflared?: { image?: string; tunnelToken: string };
  tags?: Record<string, string>;
}

export interface TaskDefResult {
  taskDef: EcsTaskDefInput;
  warnings: string[];
  /** The first published container port — the sidecar's default route target. */
  primaryContainerPort: number | null;
  /** Compose services that build from the repo (all share the one built ECR image). */
  buildServices: string[];
}

export function composeToTaskDef(input: TaskDefBuildInput): TaskDefResult {
  let doc: unknown;
  try {
    doc = yaml.load(input.composeText);
  } catch (err) {
    throw new Error(`Could not parse the compose file: ${err instanceof Error ? err.message : 'invalid YAML'}`);
  }
  const servicesRaw = (doc && typeof doc === 'object' ? (doc as { services?: unknown }).services : undefined);
  const services = servicesRaw && typeof servicesRaw === 'object' ? (servicesRaw as Record<string, unknown>) : {};

  const warnings: string[] = [];
  const containers: EcsContainerDef[] = [];
  const buildServices: string[] = [];
  let primaryContainerPort: number | null = null;

  for (const [name, svcRaw] of Object.entries(services)) {
    const svc = (svcRaw ?? {}) as Record<string, unknown>;
    const builds = svc.build != null;
    if (builds) buildServices.push(name);
    const image = builds ? input.ecrImageUri : interpolate(String(svc.image ?? ''), input.env);
    if (!image) {
      warnings.push(`Service "${name}" has neither a build nor an image; it was skipped.`);
      continue;
    }
    if (svc.volumes) warnings.push(`Service "${name}" declares volumes; Fargate host mounts aren't supported, so they were ignored.`);
    const cports = containerPorts(svc.ports, input.env);
    if (primaryContainerPort == null && cports.length) primaryContainerPort = cports[0];
    containers.push({
      name: slug(name),
      image,
      essential: true,
      environment: envEntries(svc.environment, input.env),
      portMappings: cports.map((p) => ({ containerPort: p, protocol: 'tcp' as const })),
      command: commandOf(svc.command, input.env),
      logGroup: input.logGroup,
      logStreamPrefix: slug(name),
    });
  }

  if (!containers.length) warnings.push('No deployable services were found in the compose file.');

  if (input.cloudflared?.tunnelToken) {
    containers.push({
      name: 'cloudflared',
      image: input.cloudflared.image || 'cloudflare/cloudflared:latest',
      essential: true,
      command: ['tunnel', '--no-autoupdate', 'run'],
      environment: [{ name: 'TUNNEL_TOKEN', value: input.cloudflared.tunnelToken }],
      logGroup: input.logGroup,
      logStreamPrefix: 'cloudflared',
    });
  }

  const taskDef: EcsTaskDefInput = {
    family: input.family,
    cpu: input.cpu,
    memory: input.memory,
    executionRoleArn: input.executionRoleArn,
    taskRoleArn: input.taskRoleArn,
    containers,
    tags: input.tags,
  };
  return { taskDef, warnings, primaryContainerPort, buildServices };
}
