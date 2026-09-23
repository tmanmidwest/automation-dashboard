import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService, type ActorCtx } from '../secrets/secrets.service';
import { AuditService } from '../logging/audit.service';
import { LoggingService } from '../logging/logging.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { projectName, gitStackEnvPath } from '../connectors/docker/docker-stack.service';
import { dockerTargetFrom, type DockerTarget } from './docker-target';
import { dockerHostVerifier } from '../connectors/docker/docker-hostkey';
import { PortAllocatorService } from './port-allocator.service';
import { IngressService } from './ingress.service';
import { DockerDeployTarget } from './docker-deploy-target';
import { EcsDeployTarget } from './ecs-deploy-target';
import { ecsProfileFrom } from './ecs-target';
import { buildEnvMap } from './deploy-target';
import { parseDotenv } from './compose-introspect';
import { runSsh } from '../connectors/docker/docker-ssh';
import type { DeployTarget, DestroyContext } from './deploy-target';
import type {
  DeployInput, RedeployInput, ReplicatorVariable, ReplicatorPort, ReplicatorDeployment, ReplicatorDeploymentStatus, DeployTargetInfo, PortSuggestion,
  ReplicatorIngress, ReplicatorIngressKind, TargetKind, EcsDeploymentRefs, ExtraEnvEntry,
  DeploymentEnvView, DeploymentEnvEntry, DeploymentEnvOrigin, DeploymentEnvDrift,
} from '@cerebro/shared';
import type { ReplicatorApp as AppRow, ReplicatorDeployment as DeploymentRow, ReplicatorIngress as IngressRow } from '@prisma/client';

/** The vault key holding one deployment's secret variable value. */
function secretKey(deploymentId: string, varName: string): string {
  return `deployment:${deploymentId}:${varName}`;
}

/**
 * Validate the operator's env extras and split them into the non-secret map that
 * lives on the row and the secret values headed for the vault.
 *
 * Extras are free-form, so this is the edge that keeps them safe to write into a
 * `.env`: a shell-safe name, no duplicates, and no shadowing of a schema variable
 * — an extra named `APP_HOST_PORT` would silently fight the port allocator, so it
 * is rejected rather than merged.
 */
function splitExtras(
  entries: ExtraEnvEntry[] | undefined,
  variables: ReplicatorVariable[],
): { values: Record<string, string>; secrets: Record<string, string>; secretNames: string[] } {
  const values: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const secretNames: string[] = [];
  const schema = new Set(variables.map((v) => v.name));
  const seen = new Set<string>();

  for (const raw of entries ?? []) {
    const name = String(raw?.name ?? '').trim();
    if (!name) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new BadRequestException(`"${name}" isn't a usable environment variable name — use letters, digits and underscores, starting with a letter or underscore.`);
    }
    if (schema.has(name)) {
      throw new BadRequestException(`${name} is already one of this app's variables — set it in the form above instead of adding it here.`);
    }
    if (seen.has(name)) throw new BadRequestException(`${name} is listed twice in the extra variables.`);
    seen.add(name);

    const value = raw.value == null ? '' : String(raw.value);
    if (raw.secret) {
      secretNames.push(name);
      // A blank secret means "keep what's stored" — the caller decides whether
      // that's legal (it isn't on a first deploy).
      if (value !== '') secrets[name] = value;
    } else if (value !== '') {
      values[name] = value;
    }
  }
  return { values, secrets, secretNames };
}

/**
 * Deploys, redeploys, and tears down App Replicator instances. The low-level
 * clone + `docker compose up` is the Docker connector's DockerStackService
 * (deployGit), so each deployment is also a managed stack (redeploy/rollback via
 * the connector). This service adds the catalog glue: compose-variable → env
 * assembly, per-instance isolation, vault-backed secrets with teardown cleanup,
 * and host port preflight. See docs/app-replicator.md.
 */
@Injectable()
export class DeploymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: ConnectorInstanceService,
    private readonly secrets: SecretsService,
    private readonly audit: AuditService,
    private readonly ports: PortAllocatorService,
    private readonly ingress: IngressService,
    private readonly logging: LoggingService,
    private readonly docker: DockerDeployTarget,
    private readonly ecs: EcsDeployTarget,
  ) {}

  /** Resolve the backend implementation for a target kind. */
  private targetImpl(kind: TargetKind): DeployTarget {
    if (kind === 'docker') return this.docker;
    if (kind === 'ecs') return this.ecs;
    throw new BadRequestException(`Deploy target "${kind}" is not available.`);
  }

  /** Fast preflight for an ECS target: the AWS connector must exist with a profile. */
  private async ecsPreflight(instanceId: string): Promise<void> {
    const instance = await this.instances.get(instanceId).catch(() => null);
    if (!instance) throw new BadRequestException('The selected AWS connector no longer exists.');
    if (instance.connectorId !== 'aws') throw new BadRequestException('The selected target is not an AWS connector.');
    const ctx = await this.instances.contextFor(instance);
    const profile = ecsProfileFrom(ctx);
    if (!profile) throw new BadRequestException('That AWS connector has no complete ECS deployment profile — set the subnets and task execution role ARN on the connector.');
    if (!profile.builderInstanceId) throw new BadRequestException('That AWS connector’s ECS profile has no image builder — pick a Docker connector to build and push the image.');
  }

  /** Build the SSH deploy target for a Docker connector instance (throws if not deployable). */
  private async targetFor(dockerInstanceId: string): Promise<DockerTarget> {
    const instance = await this.instances.get(dockerInstanceId).catch(() => null);
    if (!instance) throw new BadRequestException('The selected Docker connector no longer exists.');
    if (instance.connectorId !== 'docker') throw new BadRequestException('The selected target is not a Docker connector.');
    const ctx = await this.instances.contextFor(instance);
    const target = dockerTargetFrom(ctx);
    if (!target.deployable) {
      throw new BadRequestException('That Docker connector has no SSH configured — App Replicator deploys over SSH. Set the SSH host + credentials on the connector.');
    }
    // TOFU-pin the host key on every SSH to this host — deploys and the read-only
    // port preflight alike — so no runSsh path to a deploy host skips verification.
    return {
      ...target,
      ssh: { ...target.ssh, verifyHostKey: dockerHostVerifier(this.prisma, target.ssh.host, target.ssh.port) },
    };
  }

  /** Used ports + per-variable free-port suggestions for the deploy wizard. */
  async targetInfo(dockerInstanceId: string, variables: ReplicatorVariable[]): Promise<DeployTargetInfo> {
    const target = await this.targetFor(dockerInstanceId);
    const used = new Set(await this.ports.usedPorts(target.ssh));
    const taken = new Set<number>();
    const suggestions: PortSuggestion[] = variables
      .filter((v) => v.role === 'host_port')
      .map((v) => {
        const cport = v.containerPort ?? Number(v.default) ?? 8080;
        return { variable: v.name, service: v.service ?? 'app', containerPort: cport, suggested: this.ports.suggest(cport, used, taken) };
      });
    return { hostIp: target.hostIp, usedPorts: [...used].sort((a, b) => a - b), suggestions };
  }

  // ── Deploy ────────────────────────────────────────────────────────

  async deploy(appId: string, input: DeployInput, actor: ActorCtx): Promise<ReplicatorDeployment> {
    const app = await this.prisma.replicatorApp.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException('App not found.');
    if (app.usesGeneratedCompose) {
      throw new BadRequestException('This app has no committed docker-compose.yml (Cerebro generated a preview wrapper). Commit a compose file to deploy — Dockerfile-only deploys land in a follow-up.');
    }
    const variables = (app.variables as unknown as ReplicatorVariable[]) ?? [];
    const project = projectName(input.name);
    if (!project) throw new BadRequestException('A valid deployment name is required.');

    const targetKind: TargetKind = input.targetKind ?? 'docker';

    // Name must be unique per target instance.
    const clash = await this.prisma.replicatorDeployment.findFirst({ where: { dockerInstanceId: input.dockerInstanceId, project } });
    if (clash) throw new BadRequestException(`A deployment named "${project}" already exists on that target.`);

    // Resolve ports; Docker preflights them against the host (ECS has no host ports).
    const portList = this.resolvePorts(variables, input.ports);
    if (targetKind === 'docker') {
      const target = await this.targetFor(input.dockerInstanceId);
      await this.preflightPorts(target, portList);
    } else {
      await this.ecsPreflight(input.dockerInstanceId);
    }

    // Validate required non-managed values are supplied (or have a repo default).
    const missing = variables
      .filter((v) => v.required && v.role !== 'host_port' && v.role !== 'image_tag' && v.role !== 'container_name')
      .filter((v) => {
        const provided = v.secret ? input.secrets[v.name] : input.values[v.name];
        return (provided == null || provided === '') && (v.default == null);
      })
      .map((v) => v.name);
    if (missing.length) throw new BadRequestException(`Missing required value(s): ${missing.join(', ')}.`);

    // Persist the row first so secret vault keys can be namespaced by its id.
    const nonSecretValues: Record<string, string> = {};
    for (const v of variables) {
      if ((v.role === 'plain' || v.role === 'host_ip') && input.values[v.name] != null && input.values[v.name] !== '') nonSecretValues[v.name] = String(input.values[v.name]);
    }
    const secretVars = variables.filter((v) => v.secret && input.secrets[v.name] != null && input.secrets[v.name] !== '').map((v) => v.name);

    // Operator-added env entries. On a first deploy there's nothing stored to keep,
    // so a secret extra must actually carry a value.
    const extras = splitExtras(input.extraEnv, variables);
    const blankExtraSecret = extras.secretNames.filter((n) => extras.secrets[n] == null);
    if (blankExtraSecret.length) {
      throw new BadRequestException(`Give the extra secret variable(s) a value: ${blankExtraSecret.join(', ')}.`);
    }

    const row = await this.prisma.replicatorDeployment.create({
      data: {
        appId: app.id,
        targetKind,
        dockerInstanceId: input.dockerInstanceId,
        name: input.name.trim(),
        project,
        values: nonSecretValues,
        secretVars,
        extraEnv: extras.values,
        extraSecretVars: extras.secretNames,
        ports: portList as unknown as object,
        status: 'pending',
        phase: 'Queued…',
      },
    });

    // Store secret values in the vault (encrypted), namespaced to this deployment.
    for (const name of secretVars) {
      await this.secrets.set(secretKey(row.id, name), String(input.secrets[name]), {
        label: `Replicator · ${project} · ${name}`,
      }, actor);
    }
    for (const name of extras.secretNames) {
      await this.secrets.set(secretKey(row.id, name), String(extras.secrets[name]), {
        label: `Replicator · ${project} · ${name}`,
      }, actor);
    }

    // Hand the slow clone/build/up to the background so the request returns now;
    // the row's status + phase reflect progress and the final outcome. All the
    // fast checks (name, ports, required values) already ran above and threw to
    // the caller, so only genuinely long work goes async.
    void this.runDeployment({
      deploymentId: row.id, app, variables, project, targetKind, targetInstanceId: input.dockerInstanceId,
      portList, values: nonSecretValues, secrets: input.secrets,
      extras: { ...extras.values, ...extras.secrets },
      forceRebuild: !!input.forceRebuild,
      taskCpu: input.taskCpu, taskMemory: input.taskMemory, actor, kind: 'deploy',
    });
    return this.map(row, app.name);
  }

  // ── Redeploy (pull latest / rebuild) ───────────────────────────────

  async redeploy(id: string, opts: RedeployInput, actor: ActorCtx): Promise<ReplicatorDeployment> {
    const { row, app } = await this.load(id);
    if (row.status === 'pending' || row.status === 'updating') {
      throw new BadRequestException('This deployment is already in progress.');
    }
    const targetKind: TargetKind = (row.targetKind as TargetKind) ?? 'docker';
    // Fast check (Docker): the SSH target must still be reachable/deployable. ECS
    // has no port preflight, so its target resolution happens in the worker.
    const target = targetKind === 'docker' ? await this.targetFor(row.dockerInstanceId) : null;
    const variables = (app.variables as unknown as ReplicatorVariable[]) ?? [];
    let portList = (row.ports as unknown as ReplicatorPort[]) ?? [];
    let nonSecretValues = (row.values as unknown as Record<string, string>) ?? {};

    // Stored secrets and extras, revealed, so they flow into the env map (and
    // satisfy the required-value checks below).
    const stored = await this.resolveStored(row);
    const secrets = stored.secrets;
    let extras = stored.extras;

    // Edit mode: merge the supplied changes over the stored config, validate, and
    // persist BEFORE running — so a failed validation never mutates the deployment.
    if (opts.edit) {
      // Ports: keep each stored port unless the operator supplied a new one. Preflight
      // against the host, treating this deployment's OWN current ports as free.
      const chosenPorts: Record<string, number> = {};
      for (const p of portList) chosenPorts[p.variable] = p.hostPort;
      for (const [name, val] of Object.entries(opts.ports ?? {})) if (val != null) chosenPorts[name] = Number(val);
      const newPortList = this.resolvePorts(variables, chosenPorts);
      if (target) await this.preflightPorts(target, newPortList, new Set(portList.map((p) => p.hostPort)));

      // Non-secret values: merge provided plain/host_ip values over the stored ones.
      const mergedValues: Record<string, string> = { ...nonSecretValues };
      for (const v of variables) {
        if (v.role !== 'plain' && v.role !== 'host_ip') continue;
        const provided = opts.values?.[v.name];
        if (provided === undefined) continue;
        if (provided === '') delete mergedValues[v.name]; // cleared → fall back to repo default
        else mergedValues[v.name] = String(provided);
      }

      // Required-value validation, accounting for an already-stored secret.
      const missing = variables
        .filter((v) => v.required && v.role !== 'host_port' && v.role !== 'host_ip' && v.role !== 'image_tag' && v.role !== 'container_name')
        .filter((v) => {
          if (v.default != null) return false;
          if (v.secret) return !((opts.secrets?.[v.name] ?? '') !== '' || row.secretVars.includes(v.name));
          return (mergedValues[v.name] ?? '') === '';
        })
        .map((v) => v.name);
      if (missing.length) throw new BadRequestException(`Missing required value(s): ${missing.join(', ')}.`);

      // Rotate any supplied (non-blank) secrets; leave the rest as stored.
      const secretVarSet = new Set(row.secretVars);
      for (const v of variables.filter((x) => x.secret)) {
        const provided = opts.secrets?.[v.name];
        if (provided == null || provided === '') continue;
        await this.secrets.set(secretKey(row.id, v.name), String(provided), { label: `Replicator · ${row.project} · ${v.name}` }, actor);
        secrets[v.name] = String(provided);
        secretVarSet.add(v.name);
      }

      // Env extras replace rather than merge: the operator edits the whole list, so
      // an entry they deleted has to actually disappear (schema variables can fall
      // back to a repo default, extras have nothing to fall back to).
      const nextExtras = opts.extraEnv === undefined
        ? { values: (row.extraEnv as unknown as Record<string, string>) ?? {}, secrets: {}, secretNames: row.extraSecretVars ?? [] }
        : splitExtras(opts.extraEnv, variables);

      const resolvedExtras: Record<string, string> = { ...nextExtras.values };
      for (const name of nextExtras.secretNames) {
        const provided = nextExtras.secrets[name];
        if (provided != null) {
          await this.secrets.set(secretKey(row.id, name), provided, { label: `Replicator · ${row.project} · ${name}` }, actor);
          resolvedExtras[name] = provided;
          continue;
        }
        // Blank → keep the stored value, but only if there is one to keep.
        const stored = extras[name];
        if (stored == null) throw new BadRequestException(`Give the extra secret variable "${name}" a value.`);
        resolvedExtras[name] = stored;
      }

      // Drop the vault entries for extras the operator removed or un-flagged as
      // secret, so teardown isn't the only thing that cleans up after them.
      const keptSecrets = new Set(nextExtras.secretNames);
      for (const name of row.extraSecretVars ?? []) {
        if (!keptSecrets.has(name)) await this.secrets.remove(secretKey(row.id, name), actor).catch(() => {});
      }

      portList = newPortList;
      nonSecretValues = mergedValues;
      extras = resolvedExtras;
      await this.prisma.replicatorDeployment.update({
        where: { id: row.id },
        data: {
          values: nonSecretValues,
          ports: portList as unknown as object,
          secretVars: [...secretVarSet],
          extraEnv: nextExtras.values,
          extraSecretVars: nextExtras.secretNames,
        },
      });
    }

    const updated = await this.prisma.replicatorDeployment.update({ where: { id: row.id }, data: { status: 'updating', phase: 'Queued…' } });
    void this.runDeployment({
      deploymentId: row.id, app, variables, project: row.project, targetKind, targetInstanceId: row.dockerInstanceId,
      portList, values: nonSecretValues, secrets, extras, forceRebuild: !!opts.forceRebuild,
      existingEcs: (row.ecs as unknown as EcsDeploymentRefs | null) ?? null, actor, kind: 'redeploy',
    });
    return this.map(updated, app.name);
  }

  /**
   * The background worker for a deploy/redeploy: runs the (long) clone/build/up,
   * streaming coarse **phase** updates onto the row and the app log, then records
   * the final status + audit event. Fire-and-forget — never awaited by a request.
   */
  private async runDeployment(args: {
    deploymentId: string; app: AppRow; variables: ReplicatorVariable[]; project: string;
    targetKind: TargetKind; targetInstanceId: string;
    portList: ReplicatorPort[]; values: Record<string, string>; secrets: Record<string, string>;
    extras: Record<string, string>;
    forceRebuild: boolean; taskCpu?: string; taskMemory?: string; existingEcs?: EcsDeploymentRefs | null; actor: ActorCtx; kind: 'deploy' | 'redeploy';
  }): Promise<void> {
    const { deploymentId, app, variables, project, targetKind, targetInstanceId, portList, values, secrets, extras, forceRebuild, taskCpu, taskMemory, existingEcs, actor, kind } = args;
    const setPhase = (phase: string | null) => {
      void this.prisma.replicatorDeployment.update({ where: { id: deploymentId }, data: { phase } }).catch(() => {});
      if (phase) void this.logging.info('replicator', `[${project}] ${phase}`);
    };
    const finalAction = (ok: boolean) =>
      ok ? (kind === 'deploy' ? 'replicator.deploy' : 'replicator.redeploy')
         : (kind === 'deploy' ? 'replicator.deploy_failed' : 'replicator.redeploy_failed');

    try {
      await this.audit.record({ ...actor, action: `replicator.${kind}_started`, target: `${app.name}/${project}`, meta: { deploymentId, dockerInstanceId: targetInstanceId, targetKind } });
      const outcome = await this.targetImpl(targetKind).deploy(
        {
          deploymentId, targetInstanceId, project,
          source: { gitUrl: app.gitUrl, gitRef: app.gitRef, gitPath: app.gitPath, gitCredKey: app.gitCredKey },
          variables, portList, values, secrets, extras, forceRebuild, taskCpu, taskMemory, existingEcs,
        },
        (phase) => setPhase(phase),
      );
      await this.prisma.replicatorDeployment.update({
        where: { id: deploymentId },
        data: {
          status: outcome.ok ? 'deployed' : 'error', phase: null, lastMessage: outcome.message.slice(0, 2000),
          ...(outcome.deployedCommit !== undefined ? { deployedCommit: outcome.deployedCommit } : {}),
          ...(outcome.refs ? { ecs: outcome.refs as unknown as object } : {}),
          // A successful (re)deploy pulls latest, so clear any pending "update available".
          ...(outcome.ok ? { updateAvailable: false, availableCommit: null } : {}),
        },
      });
      await this.audit.record({ ...actor, action: finalAction(outcome.ok), target: `${app.name}/${project}`, meta: { ok: outcome.ok } });
      void this.logging[outcome.ok ? 'info' : 'warn']('replicator', `[${project}] ${kind} ${outcome.ok ? 'succeeded' : 'failed'}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : `${kind} failed.`;
      await this.prisma.replicatorDeployment.update({ where: { id: deploymentId }, data: { status: 'error', phase: null, lastMessage: message.slice(0, 2000) } }).catch(() => {});
      await this.audit.record({ ...actor, action: finalAction(false), target: `${app.name}/${project}`, meta: { error: message.slice(0, 300) } }).catch(() => {});
      void this.logging.error('replicator', `[${project}] ${kind} error: ${message.slice(0, 300)}`);
    }
  }

  // ── Environment view (what actually gets written) ──────────────────

  /**
   * Resolve a deployment's environment exactly as a redeploy would — same
   * `buildEnvMap` call, same inputs — and annotate every line with where it came
   * from. This is the answer to "what did this instance actually get?", which the
   * deploy form can only imply: managed values are assigned by Cerebro, env-file
   * defaults are materialized, and blanks fall back (or don't) by provenance.
   *
   * Secret values are withheld. The vault's step-up-gated reveal is the single
   * audited path to plaintext, so this returns the vault key instead — enough to
   * confirm a secret is set and to go read it deliberately.
   */
  async envView(id: string): Promise<DeploymentEnvView> {
    const { row, app } = await this.load(id);
    const variables = (app.variables as unknown as ReplicatorVariable[]) ?? [];
    const portList = (row.ports as unknown as ReplicatorPort[]) ?? [];
    const values = (row.values as unknown as Record<string, string>) ?? {};
    const { secrets, extras } = await this.resolveStored(row);
    const env = buildEnvMap(variables, row.project, portList, values, secrets, extras);

    const byName = new Map(variables.map((v) => [v.name, v]));
    const extraSecrets = new Set(row.extraSecretVars ?? []);
    const entries: DeploymentEnvEntry[] = [...env.entries()].map(([name, value]) => {
      const v = byName.get(name);
      const origin: DeploymentEnvOrigin = !v
        ? 'extra'
        : v.role === 'image_tag' || v.role === 'container_name' || v.role === 'host_port'
          ? 'managed'
          : ((v.source ?? 'compose') as DeploymentEnvOrigin);
      const secret = v ? !!v.secret : extraSecrets.has(name);
      return {
        name,
        value: secret ? null : value,
        secret,
        origin,
        envFile: v?.envFile ?? null,
        comment: v?.comment ?? null,
        vaultKey: secret ? secretKey(row.id, name) : null,
      };
    });

    const targetKind: TargetKind = (row.targetKind as TargetKind) ?? 'docker';
    let path: string | null = null;
    if (targetKind === 'docker') {
      // Best-effort: a target whose SSH config has since been removed shouldn't
      // make the whole view unavailable.
      try {
        const target = await this.targetFor(row.dockerInstanceId);
        path = gitStackEnvPath(target.stacksDir, row.project, app.gitPath);
      } catch { path = null; }
    }
    return {
      targetKind,
      path,
      note: targetKind === 'ecs'
        ? 'Fargate has no .env file — these are interpolated into the task definition, and the file-sourced ones are injected as container environment.'
        : 'Written to the host on every deploy, replacing whatever is there.',
      entries,
    };
  }

  /**
   * Compare the `.env` actually on the host with what Cerebro would write, so a
   * hand-edit on the box is visible *before* the next redeploy silently overwrites
   * it. Reports key names only — never host values — so this can't become a side
   * channel for reading secrets back off the host.
   */
  async envDrift(id: string): Promise<DeploymentEnvDrift> {
    const empty = { onlyOnHost: [], missingOnHost: [], differing: [] };
    const { row, app } = await this.load(id);
    const targetKind: TargetKind = (row.targetKind as TargetKind) ?? 'docker';
    if (targetKind !== 'docker') {
      return { available: false, message: 'This deployment runs on ECS, which has no .env file to compare.', ...empty };
    }

    let target: DockerTarget;
    let path: string;
    try {
      target = await this.targetFor(row.dockerInstanceId);
      path = gitStackEnvPath(target.stacksDir, row.project, app.gitPath);
    } catch (err) {
      return { available: false, message: err instanceof Error ? err.message : 'The Docker target is unavailable.', ...empty };
    }

    const res = await runSsh(target.ssh, `cat '${path}' 2>/dev/null || true`).catch(() => null);
    if (!res) return { available: false, message: 'Could not reach the host to read the file.', ...empty };
    if (!res.stdout.trim()) {
      return { available: false, message: `No .env at ${path} — the deployment may not have run yet.`, ...empty };
    }

    const variables = (app.variables as unknown as ReplicatorVariable[]) ?? [];
    const { secrets, extras } = await this.resolveStored(row);
    const expected = buildEnvMap(
      variables, row.project, (row.ports as unknown as ReplicatorPort[]) ?? [],
      (row.values as unknown as Record<string, string>) ?? {}, secrets, extras,
    );
    const onHost = new Map(parseDotenv(res.stdout).map((e) => [e.name, e.value]));

    const onlyOnHost = [...onHost.keys()].filter((k) => !expected.has(k)).sort();
    const missingOnHost = [...expected.keys()].filter((k) => !onHost.has(k)).sort();
    const differing = [...expected.entries()].filter(([k, v]) => onHost.has(k) && onHost.get(k) !== v).map(([k]) => k).sort();
    const drifted = onlyOnHost.length + missingOnHost.length + differing.length;

    return {
      available: true,
      message: drifted === 0
        ? `The file on the host matches what Cerebro would write (${expected.size} variables).`
        : `${drifted} difference(s) — a redeploy would overwrite the file on the host with Cerebro's version.`,
      onlyOnHost, missingOnHost, differing,
    };
  }

  /**
   * A deployment's stored secret and extra values, revealed from the vault — the
   * inputs `buildEnvMap` needs that aren't on the row itself. Shared by the
   * environment view and the drift check.
   */
  private async resolveStored(row: DeploymentRow): Promise<{ secrets: Record<string, string>; extras: Record<string, string> }> {
    const secrets: Record<string, string> = {};
    for (const name of row.secretVars ?? []) {
      const v = await this.secrets.reveal(secretKey(row.id, name)).catch(() => null);
      if (v != null) secrets[name] = v;
    }
    const extras: Record<string, string> = { ...((row.extraEnv as unknown as Record<string, string>) ?? {}) };
    for (const name of row.extraSecretVars ?? []) {
      const v = await this.secrets.reveal(secretKey(row.id, name)).catch(() => null);
      if (v != null) extras[name] = v;
    }
    return { secrets, extras };
  }

  // ── Teardown (stack down + vault cleanup) ──────────────────────────

  async remove(id: string, actor: ActorCtx): Promise<{ ok: boolean; message: string }> {
    const { row, app } = await this.load(id);
    const problems: string[] = [];

    // Tear down any ingress routes first (CF tunnel routes / NPM proxy hosts),
    // so we don't leave dangling public hostnames pointing at a dead port.
    problems.push(...await this.ingress.removeAllForDeployment(row.id));

    // Best-effort: tear down the backend (Docker stack, or ECS service + task defs
    // + ECR repo + log group). Never blocks the vault/row cleanup below.
    const targetKind: TargetKind = (row.targetKind as TargetKind) ?? 'docker';
    const destroyCtx: DestroyContext = {
      targetInstanceId: row.dockerInstanceId,
      project: row.project,
      ecs: (row.ecs as unknown as EcsDeploymentRefs | null) ?? null,
    };
    try {
      const res = await this.targetImpl(targetKind).destroy(destroyCtx, (phase) => void this.logging.info('replicator', `[${row.project}] ${phase}`));
      problems.push(...res.problems);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : 'Could not reach the target to tear down the deployment.');
    }

    // Always clean up the vault secrets and the row, so nothing is left stale.
    for (const name of [...row.secretVars, ...(row.extraSecretVars ?? [])]) {
      await this.secrets.remove(secretKey(row.id, name), actor).catch(() => {});
    }
    await this.prisma.replicatorDeployment.delete({ where: { id: row.id } });
    await this.audit.record({ ...actor, action: 'replicator.remove', target: `${app.name}/${row.project}`, meta: { problems } });

    return problems.length
      ? { ok: true, message: `Removed the deployment and its secrets. The host stopped with warnings: ${problems.join('; ')}` }
      : { ok: true, message: `Removed "${row.project}" and cleaned up its secrets.` };
  }

  // ── Listing ────────────────────────────────────────────────────────

  async listForApp(appId: string): Promise<ReplicatorDeployment[]> {
    const [app, rows] = await Promise.all([
      this.prisma.replicatorApp.findUnique({ where: { id: appId } }),
      this.prisma.replicatorDeployment.findMany({ where: { appId }, orderBy: { createdAt: 'desc' }, include: { ingress: true } }),
    ]);
    const names = await this.instanceNames();
    return rows.map((r) => this.map(r, app?.name, names.get(r.dockerInstanceId), this.mapIngress(r.ingress, names)));
  }

  async listAll(): Promise<ReplicatorDeployment[]> {
    const [apps, rows, names] = await Promise.all([
      this.prisma.replicatorApp.findMany(),
      this.prisma.replicatorDeployment.findMany({ orderBy: { createdAt: 'desc' }, include: { ingress: true } }),
      this.instanceNames(),
    ]);
    const appName = new Map(apps.map((a) => [a.id, a.name]));
    return rows.map((r) => this.map(r, appName.get(r.appId), names.get(r.dockerInstanceId), this.mapIngress(r.ingress, names)));
  }

  private mapIngress(rows: IngressRow[] | undefined, names: Map<string, string>): ReplicatorIngress[] {
    return (rows ?? []).map((r) => ({
      id: r.id, deploymentId: r.deploymentId, kind: r.kind as ReplicatorIngressKind,
      instanceId: r.instanceId, instanceName: names.get(r.instanceId),
      service: r.service, hostPort: r.hostPort, hostname: r.hostname, ref: r.ref,
      url: `https://${r.hostname}`, createdAt: r.createdAt.toISOString(),
    }));
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private async load(id: string): Promise<{ row: DeploymentRow; app: AppRow }> {
    const row = await this.prisma.replicatorDeployment.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Deployment not found.');
    const app = await this.prisma.replicatorApp.findUnique({ where: { id: row.appId } });
    if (!app) throw new NotFoundException('The deployment’s app no longer exists.');
    return { row, app };
  }

  private async instanceNames(): Promise<Map<string, string>> {
    const list = await this.instances.list().catch(() => []);
    return new Map(list.map((i) => [i.id, i.name]));
  }

  private resolvePorts(variables: ReplicatorVariable[], chosen: Record<string, number>): ReplicatorPort[] {
    return variables
      .filter((v) => v.role === 'host_port')
      .map((v) => {
        const cport = v.containerPort ?? Number(v.default) ?? 8080;
        const hostPort = Number(chosen[v.name] ?? v.default ?? cport);
        if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
          throw new BadRequestException(`Invalid host port for ${v.name}.`);
        }
        return { service: v.service ?? 'app', variable: v.name, hostPort, containerPort: cport };
      });
  }

  private async preflightPorts(target: DockerTarget, portList: ReplicatorPort[], exclude?: Set<number>): Promise<void> {
    const used = new Set(await this.ports.usedPorts(target.ssh));
    // A redeploy's own currently-bound ports aren't a conflict with itself.
    if (exclude) for (const p of exclude) used.delete(p);
    const seen = new Set<number>();
    const conflicts: string[] = [];
    for (const p of portList) {
      if (seen.has(p.hostPort)) conflicts.push(`${p.hostPort} (assigned twice in this deployment)`);
      else if (used.has(p.hostPort)) conflicts.push(`${p.hostPort} (already in use on the host)`);
      seen.add(p.hostPort);
    }
    if (conflicts.length) throw new BadRequestException(`Port conflict: ${conflicts.join(', ')}. Pick different host ports.`);
  }

  private map(row: DeploymentRow, appName?: string, instanceName?: string, ingress?: ReplicatorIngress[]): ReplicatorDeployment {
    return {
      id: row.id,
      appId: row.appId,
      appName,
      name: row.name,
      project: row.project,
      targetKind: (row.targetKind as TargetKind) ?? 'docker',
      dockerInstanceId: row.dockerInstanceId,
      dockerInstanceName: instanceName,
      ecs: (row.ecs as unknown as EcsDeploymentRefs | null) ?? null,
      values: (row.values as unknown as Record<string, string>) ?? {},
      secretVars: row.secretVars ?? [],
      extraEnv: (row.extraEnv as unknown as Record<string, string>) ?? {},
      extraSecretVars: row.extraSecretVars ?? [],
      ports: (row.ports as unknown as ReplicatorPort[]) ?? [],
      status: row.status as ReplicatorDeploymentStatus,
      phase: row.phase,
      lastMessage: row.lastMessage,
      deployedCommit: row.deployedCommit,
      updateAvailable: row.updateAvailable,
      availableCommit: row.availableCommit,
      ingress: ingress ?? [],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
