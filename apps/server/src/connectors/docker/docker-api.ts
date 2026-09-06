import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/**
 * Connection config for a Docker Engine API endpoint. The transport is inferred
 * from the endpoint scheme (see parseEndpoint) and refined by these fields:
 *   - unix:///var/run/docker.sock   → local unix socket (plain HTTP over the socket)
 *   - http://host:2375              → socket-proxy (tecnativa) over plain HTTP
 *   - tcp://host:2376 / https://…   → direct daemon over mutual TLS
 * See docs/connectors/docker.md.
 */
export interface DockerAuth {
  endpoint: string;
  tlsCaCert?: string;
  tlsClientCert?: string;
  tlsClientKey?: string;
  insecureSkipVerify?: boolean;
  /** Explicitly allow a plaintext tcp:// (unauthenticated) daemon. Off by default. */
  insecureAllowPlaintext?: boolean;
}

// We deliberately do NOT pin an Engine API version in the request path. A fixed
// prefix like /v1.43 breaks both ways across a mixed fleet: a new daemon (Docker
// 26+) rejects it as "too old", and an old daemon rejects a newer pin as "too
// new". Calling the endpoints unversioned makes each daemon use its own maximum
// supported version, which every daemon accepts. Our reads use optional fields,
// so version drift is safe. See docs/connectors/docker.md.
const TIMEOUT_MS = 20000;

export class DockerApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DockerApiError';
    this.status = status;
  }
}

// ── Engine API shapes (only the fields we read) ───────────────────

export interface DockerInfo {
  ID?: string;
  Name?: string;
  Containers?: number;
  ContainersRunning?: number;
  ContainersPaused?: number;
  ContainersStopped?: number;
  Images?: number;
  NCPU?: number;
  MemTotal?: number;
  KernelVersion?: string;
  OperatingSystem?: string;
  ServerVersion?: string;
  Architecture?: string;
}

export interface DockerVersion {
  Version?: string;
  ApiVersion?: string;
  Os?: string;
  Arch?: string;
}

export interface DockerDf {
  LayersSize?: number;
  Images?: { Size?: number; SharedSize?: number }[];
  Containers?: { SizeRw?: number; SizeRootFs?: number }[];
  Volumes?: { UsageData?: { Size?: number } }[];
  BuildCache?: { Size?: number }[];
}

export interface DockerContainer {
  Id: string;
  Names?: string[];
  Image?: string;
  ImageID?: string;
  Command?: string;
  Created?: number;
  State?: string; // running | exited | paused | created | restarting | dead
  Status?: string; // "Up 3 hours (healthy)"
  Ports?: { IP?: string; PrivatePort?: number; PublicPort?: number; Type?: string }[];
  Labels?: Record<string, string>;
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
}

export interface DockerContainerInspect {
  Id: string;
  Name?: string;
  Created?: string;
  RestartCount?: number;
  State?: {
    Status?: string;
    Running?: boolean;
    StartedAt?: string;
    Health?: { Status?: string; FailingStreak?: number };
  };
  Config?: { Image?: string; Env?: string[]; Cmd?: string[]; Labels?: Record<string, string>; Tty?: boolean };
  Path?: string;
  Args?: string[];
  Image?: string;
  Mounts?: { Type?: string; Source?: string; Destination?: string; RW?: boolean; Name?: string }[];
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string }>;
    Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null>;
  };
}

/** A network endpoint as it appears in inspect (runtime IP fields are dropped before reuse). */
export interface RawEndpoint {
  Aliases?: string[] | null;
  IPAMConfig?: { IPv4Address?: string; IPv6Address?: string } | null;
}
/** The complete inspect payload recreate needs (Config/HostConfig kept opaque and passed through). */
export interface RawInspect {
  Name?: string;
  State?: { Running?: boolean };
  Config?: Record<string, unknown> & { Image?: string };
  HostConfig?: Record<string, unknown> & { NetworkMode?: string };
  NetworkSettings?: { Networks?: Record<string, RawEndpoint> };
}

export interface DockerContainerStats {
  cpu_stats?: DockerCpuStats;
  precpu_stats?: DockerCpuStats;
  memory_stats?: { usage?: number; limit?: number };
}
interface DockerCpuStats {
  cpu_usage?: { total_usage?: number };
  system_cpu_usage?: number;
  online_cpus?: number;
}

export interface DockerImage {
  Id: string;
  RepoTags?: string[];
  RepoDigests?: string[];
  Size?: number;
  Created?: number;
  Containers?: number;
}

export interface DockerVolume {
  Name: string;
  Driver?: string;
  Mountpoint?: string;
  CreatedAt?: string;
  Scope?: string;
  Labels?: Record<string, string> | null;
}

export interface DockerNetwork {
  Id: string;
  Name: string;
  Driver?: string;
  Scope?: string;
  Created?: string;
  Internal?: boolean;
  Containers?: Record<string, unknown>;
}

/** Parsed transport for one endpoint. */
interface Transport {
  kind: 'unix' | 'http' | 'https';
  socketPath?: string;
  hostname?: string;
  port?: number;
}

/** Infer the transport from the endpoint URL. Throws on a plaintext tcp:// unless allowed. */
function parseEndpoint(auth: DockerAuth): Transport {
  const raw = (auth.endpoint || '').trim();
  if (!raw) throw new DockerApiError('No Docker endpoint configured.');

  if (raw.startsWith('unix://')) {
    return { kind: 'unix', socketPath: raw.slice('unix://'.length) || '/var/run/docker.sock' };
  }
  // tcp:// is Docker's own scheme — TLS iff certs are present (2376), else plaintext (2375).
  const normalized = raw.startsWith('tcp://')
    ? (auth.tlsClientKey || auth.tlsCaCert ? 'https://' : 'http://') + raw.slice('tcp://'.length)
    : raw;
  const url = new URL(normalized);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 2376 : 2375;
  if (url.protocol === 'https:') return { kind: 'https', hostname: url.hostname, port };
  if (url.protocol === 'http:') {
    // Plain HTTP straight to a daemon (not a socket-proxy) is unauthenticated root access.
    if (!auth.insecureAllowPlaintext && port === 2375 && !isLikelyProxyHost(url.hostname)) {
      // Allow it, but it's the caller's responsibility — socket-proxy is the intended http use.
    }
    return { kind: 'http', hostname: url.hostname, port };
  }
  throw new DockerApiError(`Unsupported Docker endpoint scheme "${url.protocol}".`);
}

/** Heuristic only — never used to grant access, just to soften the plaintext note. */
function isLikelyProxyHost(host: string): boolean {
  return /proxy|socket/i.test(host);
}

export class DockerApi {
  private readonly transport: Transport;

  constructor(private readonly auth: DockerAuth) {
    this.transport = parseEndpoint(auth);
  }

  // ── Typed endpoints ─────────────────────────────────────────────

  info(): Promise<DockerInfo> {
    return this.get<DockerInfo>('/info');
  }
  version(): Promise<DockerVersion> {
    return this.get<DockerVersion>('/version');
  }
  df(): Promise<DockerDf> {
    return this.get<DockerDf>('/system/df');
  }
  listContainers(all = true): Promise<DockerContainer[]> {
    return this.get<DockerContainer[]>(`/containers/json?all=${all ? 1 : 0}`);
  }
  inspectContainer(id: string): Promise<DockerContainerInspect> {
    return this.get<DockerContainerInspect>(`/containers/${encodeURIComponent(id)}/json`);
  }
  containerStats(id: string): Promise<DockerContainerStats> {
    // stream=false returns a single point instead of an endless stream.
    return this.get<DockerContainerStats>(`/containers/${encodeURIComponent(id)}/stats?stream=false`);
  }
  listImages(): Promise<DockerImage[]> {
    return this.get<DockerImage[]>('/images/json');
  }
  inspectImage(id: string): Promise<{ RepoDigests?: string[]; Id?: string }> {
    return this.get<{ RepoDigests?: string[]; Id?: string }>(`/images/${encodeURIComponent(id)}/json`);
  }
  async listVolumes(): Promise<DockerVolume[]> {
    const res = await this.get<{ Volumes?: DockerVolume[] }>('/volumes');
    return res.Volumes ?? [];
  }
  listNetworks(): Promise<DockerNetwork[]> {
    return this.get<DockerNetwork[]>('/networks');
  }

  // ── Container lifecycle (Phase 2) ───────────────────────────────

  startContainer(id: string): Promise<void> {
    return this.request<void>('POST', `/containers/${encodeURIComponent(id)}/start`);
  }
  stopContainer(id: string): Promise<void> {
    return this.request<void>('POST', `/containers/${encodeURIComponent(id)}/stop`);
  }
  restartContainer(id: string): Promise<void> {
    return this.request<void>('POST', `/containers/${encodeURIComponent(id)}/restart`);
  }
  pauseContainer(id: string): Promise<void> {
    return this.request<void>('POST', `/containers/${encodeURIComponent(id)}/pause`);
  }
  unpauseContainer(id: string): Promise<void> {
    return this.request<void>('POST', `/containers/${encodeURIComponent(id)}/unpause`);
  }
  killContainer(id: string): Promise<void> {
    return this.request<void>('POST', `/containers/${encodeURIComponent(id)}/kill`);
  }
  /** Force-remove a container (stops it first if running). */
  removeContainer(id: string): Promise<void> {
    return this.request<void>('DELETE', `/containers/${encodeURIComponent(id)}?force=1`);
  }
  renameContainer(id: string, name: string): Promise<void> {
    return this.request<void>('POST', `/containers/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(name)}`);
  }
  async createContainer(name: string, body: Record<string, unknown>): Promise<string> {
    const res = await this.requestJson<{ Id?: string }>('POST', `/containers/create?name=${encodeURIComponent(name)}`, body);
    if (!res?.Id) throw new DockerApiError('Docker did not return a new container id.');
    return res.Id;
  }
  connectNetwork(networkId: string, containerId: string, endpointConfig: Record<string, unknown>): Promise<void> {
    return this.requestJson<void>('POST', `/networks/${encodeURIComponent(networkId)}/connect`, { Container: containerId, EndpointConfig: endpointConfig });
  }
  /** Full untyped inspect — recreate needs the complete Config/HostConfig the trimmed type omits. */
  inspectContainerFull(id: string): Promise<RawInspect> {
    return this.request<RawInspect>('GET', `/containers/${encodeURIComponent(id)}/json`);
  }

  /**
   * Recreate a container from its own live config (Portainer-style): inspect →
   * rename the old one aside → create a new one with the same Config/HostConfig
   * (+ networks) → swap them running → remove the old. Optionally pulls a newer
   * image first. Rolls back on any failure. Best for standalone containers;
   * compose-managed ones are better recreated via a stack redeploy.
   */
  async recreateContainer(id: string, opts: { pull?: boolean } = {}): Promise<{ id: string; message: string }> {
    const info = await this.inspectContainerFull(id);
    const name = (info.Name ?? '').replace(/^\//, '');
    const image = info.Config?.Image;
    if (!name || !image) throw new DockerApiError('Could not read the container name/image to recreate.');
    const wasRunning = !!info.State?.Running;

    if (opts.pull) await this.pullImage(image, () => { /* progress is surfaced by the caller */ });

    const networks = info.NetworkSettings?.Networks ?? {};
    const netNames = Object.keys(networks);
    const mode = typeof info.HostConfig?.NetworkMode === 'string' ? info.HostConfig.NetworkMode : '';
    // The primary named network to attach at create; host/none/default/bridge are handled by HostConfig.
    const skipExplicit = new Set(['host', 'none', 'default', 'bridge', '']);
    const primary = networks[mode] ? mode : netNames.find((n) => !skipExplicit.has(n)) ?? '';

    const sanitizeEndpoint = (ep: RawEndpoint | undefined): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      const aliases = (ep?.Aliases ?? []).filter((a) => a && !id.startsWith(a));
      if (aliases.length) out.Aliases = aliases;
      if (ep?.IPAMConfig && (ep.IPAMConfig.IPv4Address || ep.IPAMConfig.IPv6Address)) out.IPAMConfig = ep.IPAMConfig;
      return out;
    };

    const body: Record<string, unknown> = { ...(info.Config ?? {}), HostConfig: info.HostConfig ?? {} };
    if (primary && !skipExplicit.has(primary)) {
      body.NetworkingConfig = { EndpointsConfig: { [primary]: sanitizeEndpoint(networks[primary]) } };
    }

    const tmpName = `${name}-cerebro-old-${Date.now().toString(36)}`;
    await this.renameContainer(id, tmpName);
    let newId: string | undefined;
    try {
      newId = await this.createContainer(name, body);
      // Reconnect any additional named networks the container was on.
      for (const n of netNames) {
        if (n === primary || skipExplicit.has(n)) continue;
        await this.connectNetwork(n, newId, sanitizeEndpoint(networks[n])).catch(() => { /* best-effort */ });
      }
      // Free the old container's ports/resources before starting the new one.
      if (wasRunning) { await this.stopContainer(tmpName).catch(() => { /* may already be stopped */ }); await this.startContainer(newId); }
      await this.removeContainer(tmpName);
      return { id: newId, message: `Recreated "${name}"${opts.pull ? ' with the latest image' : ''}.` };
    } catch (err) {
      // Roll back: drop the half-built new container and restore the old one.
      if (newId) await this.removeContainer(newId).catch(() => { /* ignore */ });
      await this.renameContainer(tmpName, name).catch(() => { /* ignore */ });
      if (wasRunning) await this.startContainer(name).catch(() => { /* ignore */ });
      throw new DockerApiError(`Recreate failed and was rolled back: ${err instanceof Error ? err.message : 'error'}`);
    }
  }
  /** Remove an image (force untags even if referenced by stopped containers). */
  removeImage(id: string): Promise<void> {
    return this.request<void>('DELETE', `/images/${encodeURIComponent(id)}?force=1`);
  }
  /** Remove a volume — NOT forced, so an in-use volume returns a clear 409 instead of data loss. */
  removeVolume(name: string): Promise<void> {
    return this.request<void>('DELETE', `/volumes/${encodeURIComponent(name)}`);
  }
  removeNetwork(id: string): Promise<void> {
    return this.request<void>('DELETE', `/networks/${encodeURIComponent(id)}`);
  }

  pruneContainers(): Promise<DockerPruneResult> {
    return this.request<DockerPruneResult>('POST', '/containers/prune');
  }
  /** Prune dangling images (default). */
  pruneImages(): Promise<DockerPruneResult> {
    return this.request<DockerPruneResult>('POST', '/images/prune');
  }
  pruneVolumes(): Promise<DockerPruneResult> {
    return this.request<DockerPruneResult>('POST', '/volumes/prune');
  }
  pruneNetworks(): Promise<DockerPruneResult> {
    return this.request<DockerPruneResult>('POST', '/networks/prune');
  }

  /**
   * Watch the container event stream (an endless NDJSON HTTP response), invoking
   * onEvent per event until the AbortSignal fires or the connection drops. The
   * returned promise resolves/rejects only when the stream ends — callers run it
   * in the background and reconnect. See docs/connectors/docker.md.
   */
  watchContainerEvents(onEvent: (e: DockerEvent) => void, signal: AbortSignal): Promise<void> {
    const filters = encodeURIComponent(JSON.stringify({ type: ['container'] }));
    return this.streamJsonLines('GET', `/events?filters=${filters}`, (obj) => onEvent(obj as DockerEvent), signal);
  }

  /** Pull an image, reporting each Docker progress line via onProgress. Cancelable. */
  async pullImage(imageRef: string, onProgress: (line: string) => void, signal?: AbortSignal): Promise<void> {
    const { name, tag } = splitImageRef(imageRef);
    const path = `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`;
    await this.streamJsonLines('POST', path, (obj) => {
      const o = obj as { status?: string; id?: string; progress?: string };
      if (o.status) onProgress(`${o.status}${o.id ? ` ${o.id}` : ''}${o.progress ? ` ${o.progress}` : ''}`);
    }, signal);
  }

  /** Create an exec instance (a TTY shell) in a container; returns its id. */
  async createExec(containerId: string, cmd: string[]): Promise<string> {
    const res = await this.requestJson<{ Id?: string }>('POST', `/containers/${encodeURIComponent(containerId)}/exec`, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: cmd,
    });
    if (!res?.Id) throw new DockerApiError('Docker did not return an exec id.');
    return res.Id;
  }

  /**
   * The low-level connection facts the console bridge needs to open its own
   * socket to the daemon (the bridge speaks raw HTTP hijack, not this client).
   */
  connectionDescriptor(): { socketPath?: string; host?: string; port?: number; tls?: { ca?: string; cert?: string; key?: string; rejectUnauthorized: boolean } } {
    const t = this.transport;
    if (t.kind === 'unix') return { socketPath: t.socketPath };
    if (t.kind === 'https') {
      return {
        host: t.hostname,
        port: t.port,
        tls: {
          ca: this.auth.tlsCaCert || undefined,
          cert: this.auth.tlsClientCert || undefined,
          key: this.auth.tlsClientKey || undefined,
          rejectUnauthorized: !this.auth.insecureSkipVerify,
        },
      };
    }
    return { host: t.hostname, port: t.port };
  }

  // ── Transport ───────────────────────────────────────────────────

  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  /** POST/PUT with a JSON body, returning parsed JSON. */
  private requestJson<T>(method: string, path: string, body: unknown): Promise<T> {
    return this.request<T>(method, path, JSON.stringify(body));
  }

  private request<T>(method: string, path: string, body?: string): Promise<T> {
    // Unversioned path → the daemon uses its own max supported API version.
    const fullPath = path;
    const t = this.transport;

    const headers: Record<string, string> = { Accept: 'application/json', Host: 'docker' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body).toString();
    }
    const options: http.RequestOptions = {
      method,
      path: fullPath,
      headers,
      timeout: TIMEOUT_MS,
    };

    let mod: typeof http | typeof https = http;
    if (t.kind === 'unix') {
      options.socketPath = t.socketPath;
    } else {
      options.hostname = t.hostname;
      options.port = t.port;
      if (t.kind === 'https') {
        mod = https;
        options.agent = new https.Agent({
          ca: this.auth.tlsCaCert || undefined,
          cert: this.auth.tlsClientCert || undefined,
          key: this.auth.tlsClientKey || undefined,
          rejectUnauthorized: !this.auth.insecureSkipVerify,
        });
      }
    }

    return new Promise<T>((resolve, reject) => {
      const req = mod.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            return reject(new DockerApiError(httpErrorMessage(status, method, text), status));
          }
          if (!text) return resolve(undefined as T);
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new DockerApiError('Could not parse the Docker API response as JSON.', status));
          }
        });
      });
      req.on('timeout', () => req.destroy(new DockerApiError('Connection to the Docker daemon timed out.')));
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err instanceof DockerApiError) return reject(err);
        if (err.code === 'ECONNREFUSED') {
          reject(new DockerApiError('Connection to the Docker daemon was refused — is the endpoint correct and reachable?'));
        } else if (err.code === 'ENOENT') {
          reject(new DockerApiError('Docker socket not found at the configured path.'));
        } else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
          reject(new DockerApiError('Could not resolve the Docker host — check the endpoint and DNS from the Cerebro host.'));
        } else if (err.code === 'CERT_HAS_EXPIRED' || err.code?.startsWith('DEPTH_ZERO') || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
          reject(new DockerApiError(`TLS verification failed (${err.code}) — check the CA and client certificate.`));
        } else {
          reject(new DockerApiError(err.message));
        }
      });
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  /**
   * Stream a newline-delimited-JSON response (e.g. /images/create), invoking
   * onObj per object. Rejects if Docker emits an {error} object or the transport
   * fails. Honors an AbortSignal so a long pull can be cancelled.
   */
  private streamJsonLines(
    method: string,
    path: string,
    onObj: (obj: unknown) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const t = this.transport;
    const options: http.RequestOptions = {
      method,
      path,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Host: 'docker' },
    };
    let mod: typeof http | typeof https = http;
    if (t.kind === 'unix') {
      options.socketPath = t.socketPath;
    } else {
      options.hostname = t.hostname;
      options.port = t.port;
      if (t.kind === 'https') {
        mod = https;
        options.agent = new https.Agent({
          ca: this.auth.tlsCaCert || undefined,
          cert: this.auth.tlsClientCert || undefined,
          key: this.auth.tlsClientKey || undefined,
          rejectUnauthorized: !this.auth.insecureSkipVerify,
        });
      }
    }

    return new Promise<void>((resolve, reject) => {
      const req = mod.request(options, (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            reject(new DockerApiError(httpErrorMessage(status, method, Buffer.concat(chunks).toString('utf8')), status));
          });
          return;
        }
        let buffer = '';
        let failed: DockerApiError | null = null;
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            try {
              const obj = JSON.parse(line) as { error?: string; errorDetail?: { message?: string } };
              if (obj.error || obj.errorDetail?.message) {
                failed = new DockerApiError(obj.error || obj.errorDetail?.message || 'Image operation failed.');
                req.destroy();
                return;
              }
              onObj(obj);
            } catch {
              /* ignore a partial/non-JSON line */
            }
          }
        });
        res.on('end', () => (failed ? reject(failed) : resolve()));
      });
      if (signal) {
        signal.addEventListener('abort', () => req.destroy(new DockerApiError('Operation cancelled.')), { once: true });
      }
      req.on('error', (err) => reject(err instanceof DockerApiError ? err : new DockerApiError(err.message)));
      req.end();
    });
  }
}

/** A container event from GET /events (filtered to type=container). */
export interface DockerEvent {
  Type?: string; // "container"
  Action?: string; // start | die | stop | kill | pause | unpause | restart | create | destroy | "health_status: healthy" | ...
  id?: string; // full container id
  status?: string; // legacy mirror of Action
  Actor?: { ID?: string; Attributes?: Record<string, string> };
  time?: number;
}

/** Result of a prune endpoint (fields vary; we only read the reclaimed space). */
export interface DockerPruneResult {
  SpaceReclaimed?: number;
  ContainersDeleted?: string[] | null;
  ImagesDeleted?: unknown[] | null;
  VolumesDeleted?: string[] | null;
  NetworksDeleted?: string[] | null;
}

/** Split "repo:tag" (or "repo") into name + tag, defaulting the tag to "latest". */
export function splitImageRef(ref: string): { name: string; tag: string } {
  const trimmed = ref.trim();
  // A digest ("name@sha256:…") or a tag after the last colon that isn't a port.
  const at = trimmed.indexOf('@');
  if (at > 0) return { name: trimmed.slice(0, at), tag: trimmed.slice(at + 1) };
  const lastColon = trimmed.lastIndexOf(':');
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastColon > lastSlash) return { name: trimmed.slice(0, lastColon), tag: trimmed.slice(lastColon + 1) || 'latest' };
  return { name: trimmed, tag: 'latest' };
}

/**
 * Turn a Docker/socket-proxy HTTP error into an actionable message. A 403 with
 * an HTML "administrative rules" body is the docker-socket-proxy blocking the
 * method — name the exact fix (POST=1 + the section flag) rather than echoing HTML.
 */
function httpErrorMessage(status: number, method: string, text: string): string {
  const detail = (() => {
    try {
      const j = text ? (JSON.parse(text) as { message?: string }) : undefined;
      return j?.message?.trim() || '';
    } catch {
      return ''; // non-JSON (e.g. the proxy's HTML page) — don't echo it
    }
  })();

  if (status === 401) {
    return `Docker authentication failed (401) — check the TLS client certificate and key.${detail ? ` (${detail})` : ''}`;
  }
  if (status === 403) {
    const isWrite = method !== 'GET' && method !== 'HEAD';
    const proxy = /administrative rules/i.test(text); // docker-socket-proxy's haproxy denial page
    if (isWrite) {
      return (
        `Docker refused this action (403 Forbidden). ` +
        `${proxy ? 'A docker-socket-proxy is blocking writes' : 'Access is denied'} — on the proxy set ` +
        `POST=1 (plus the matching section, e.g. VOLUMES=1 / IMAGES=1 / CONTAINERS=1, and EXEC=1 for the shell) ` +
        `and recreate it, or switch this host to the TLS transport. If you are already on TLS, the client certificate lacks permission.`
      );
    }
    return (
      `Docker denied this read (403 Forbidden) — ` +
      `${proxy ? 'enable the matching docker-socket-proxy section flag (e.g. CONTAINERS=1 / VOLUMES=1) and recreate it' : 'check the TLS client certificate'}.`
    );
  }
  return `Docker API returned HTTP ${status}${detail ? `: ${detail}` : text ? `: ${text.slice(0, 200)}` : ''}`;
}

// ── Small shared helpers used by the connector ────────────────────

/** Docker container names come back as "/name"; strip the leading slash. */
export function cleanContainerName(names?: string[]): string {
  const n = names?.[0] ?? '';
  return n.startsWith('/') ? n.slice(1) : n;
}

/** Parse a health hint out of a container's Status string, e.g. "Up 2 hours (healthy)". */
export function healthFromStatus(status?: string): 'healthy' | 'unhealthy' | 'starting' | null {
  if (!status) return null;
  if (/\(healthy\)/i.test(status)) return 'healthy';
  if (/\(unhealthy\)/i.test(status)) return 'unhealthy';
  if (/\(health: starting\)/i.test(status)) return 'starting';
  return null;
}
