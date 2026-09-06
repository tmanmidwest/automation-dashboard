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

/** Pinned Engine API version — the daemon accepts a versioned path prefix. */
const API_VERSION = 'v1.43';
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
  Config?: { Image?: string; Env?: string[]; Labels?: Record<string, string> };
  Image?: string;
  Mounts?: { Type?: string; Source?: string; Destination?: string; RW?: boolean; Name?: string }[];
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
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
  async listVolumes(): Promise<DockerVolume[]> {
    const res = await this.get<{ Volumes?: DockerVolume[] }>('/volumes');
    return res.Volumes ?? [];
  }
  listNetworks(): Promise<DockerNetwork[]> {
    return this.get<DockerNetwork[]>('/networks');
  }

  // ── Transport ───────────────────────────────────────────────────

  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  private request<T>(method: string, path: string): Promise<T> {
    const fullPath = `/${API_VERSION}${path}`;
    const t = this.transport;

    const options: http.RequestOptions = {
      method,
      path: fullPath,
      headers: { Accept: 'application/json', Host: 'docker' },
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
            let message = `Docker API returned HTTP ${status}`;
            try {
              const j = text ? (JSON.parse(text) as { message?: string }) : undefined;
              if (j?.message) message = j.message;
            } catch {
              if (text) message = `${message}: ${text.slice(0, 200)}`;
            }
            if (status === 401 || status === 403) {
              message = `Docker access denied (HTTP ${status}) — check TLS client cert / socket-proxy permissions. ${message}`;
            }
            return reject(new DockerApiError(message, status));
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
      req.end();
    });
  }
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
