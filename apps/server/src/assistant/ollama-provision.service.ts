import { Injectable } from '@nestjs/common';
import type { OllamaCertOption, OllamaDeployEvent, OllamaDeployRequest, OllamaHost } from '@cerebro/shared';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { DockerApi, type DockerAuth } from '../connectors/docker/docker-api';

const CONTAINER_NAME = 'cerebro-ollama';
const VOLUME_NAME = 'cerebro-ollama';
const IMAGE = 'ollama/ollama:latest';
const OLLAMA_PORT = '11434';
const DOCKER_CONNECTOR = 'docker';
const NPM_CONNECTOR = 'nginx-proxy-manager';

/**
 * One-click Ollama provisioning: deploy a self-hosted Ollama container onto one of the
 * user's existing Docker connector hosts, straight from the UI — no hand-edited compose.
 * Reuses the Docker connector's low-level Engine client (image pull / create / start) and
 * then pulls a model via Ollama's own HTTP API. See docs/assistant-computer.md.
 */
@Injectable()
export class OllamaProvisionService {
  constructor(private readonly instances: ConnectorInstanceService) {}

  /** Docker connector instances that can host Ollama. */
  async hosts(): Promise<OllamaHost[]> {
    const rows = await this.instances.list();
    return rows.filter((r) => r.connectorId === DOCKER_CONNECTOR).map((r) => ({ instanceId: r.id, name: r.name }));
  }

  /** Nginx Proxy Manager instances available to front Ollama (reverse-proxy option). */
  async proxies(): Promise<OllamaHost[]> {
    const rows = await this.instances.list();
    return rows.filter((r) => r.connectorId === NPM_CONNECTOR).map((r) => ({ instanceId: r.id, name: r.name }));
  }

  /** Certificates an NPM instance offers (id 0 = None / HTTP only). */
  async proxyCerts(instanceId: string): Promise<OllamaCertOption[]> {
    const opts = await this.instances.resolveOptions(instanceId, 'npm-certs', {}).catch(() => []);
    return opts.map((o) => ({ id: Number(o.value) || 0, name: o.label }));
  }

  /** Deploy (or reuse) the Ollama container and optionally pull a model, streaming progress. */
  async *deploy(opts: OllamaDeployRequest): AsyncGenerator<OllamaDeployEvent> {
    const port = opts.port || Number(OLLAMA_PORT);
    let api: DockerApi;
    let endpoint: string;
    try {
      const inst = await this.instances.get(opts.instanceId);
      if (inst.connectorId !== 'docker') {
        yield { type: 'error', message: 'The selected connector is not a Docker host.' };
        return;
      }
      const ctx = await this.instances.contextFor(inst);
      endpoint = String(ctx.config.endpoint ?? '');
      const auth: DockerAuth = {
        endpoint,
        tlsCaCert: str(ctx.config.tlsCaCert),
        tlsClientCert: str(ctx.config.tlsClientCert),
        tlsClientKey: str(ctx.config.tlsClientKey),
        insecureSkipVerify: ctx.config.insecureSkipVerify === true,
      };
      api = new DockerApi(auth);
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
      return;
    }

    try {
      yield { type: 'log', text: `Pulling image ${IMAGE} … (first time can take a minute)` };
      await api.pullImage(IMAGE, () => { /* coarse progress; SSE keeps the connection open */ });
      yield { type: 'log', text: 'Image ready.' };

      const existing = (await api.listContainers(true)).find((c) =>
        (c.Names ?? []).some((n) => stripSlash(n) === CONTAINER_NAME),
      );

      if (existing) {
        if ((existing.State ?? '') !== 'running') {
          yield { type: 'log', text: 'Starting existing cerebro-ollama container…' };
          await api.startContainer(existing.Id);
        } else {
          yield { type: 'log', text: 'Container "cerebro-ollama" already running — reusing it.' };
        }
      } else {
        yield { type: 'log', text: `Creating container "${CONTAINER_NAME}" (volume ${VOLUME_NAME}, port ${port})…` };
        const body: Record<string, unknown> = {
          Image: IMAGE,
          ExposedPorts: { [`${OLLAMA_PORT}/tcp`]: {} },
          HostConfig: {
            RestartPolicy: { Name: 'unless-stopped' },
            PortBindings: { [`${OLLAMA_PORT}/tcp`]: [{ HostPort: String(port) }] },
            Binds: [`${VOLUME_NAME}:/root/.ollama`],
            ...(opts.gpu
              ? { DeviceRequests: [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }] }
              : {}),
          },
        };
        const id = await api.createContainer(CONTAINER_NAME, body);
        yield { type: 'log', text: 'Starting container…' };
        await api.startContainer(id);
      }

      const override = opts.baseUrlOverride?.trim();
      const baseUrl = override || deriveBaseUrl(endpoint, port);
      yield {
        type: 'log',
        text: override ? `Container is up. Using your Base URL: ${baseUrl}` : `Container is up. Base URL: ${baseUrl}`,
      };

      // Wait for the Ollama HTTP API to answer before pulling a model.
      yield { type: 'log', text: 'Waiting for Ollama to become ready…' };
      const ready = await waitReady(baseUrl);
      if (!ready) {
        yield {
          type: 'log',
          text: `Couldn't reach ${baseUrl} from Cerebro yet. The container is running — you may need to adjust the Base URL (host/port reachability). Skipping model pull.`,
        };
        yield { type: 'done', baseUrl };
        return;
      }
      yield { type: 'log', text: 'Ollama is ready.' };

      if (opts.model) {
        yield { type: 'log', text: `Pulling model ${opts.model} … (several minutes on first download)` };
        await pullModel(baseUrl, opts.model);
        yield { type: 'log', text: `Model ${opts.model} ready.` };
      }

      // Optional: front it with an Nginx Proxy Manager proxy host and hand the Computer the
      // proxy URL. The deploy + model pull above used the direct URL; only the connection the
      // Computer keeps is moved behind the proxy. On failure we warn and fall back to direct.
      let finalUrl = baseUrl;
      if (opts.proxy?.instanceId && opts.proxy.domain?.trim()) {
        const domain = opts.proxy.domain.trim();
        const certId = opts.proxy.certificateId ?? 0;
        try {
          const direct = new URL(baseUrl);
          const forwardHost = direct.hostname;
          const forwardPort = Number(direct.port) || port;
          yield { type: 'log', text: `Creating reverse proxy ${domain} → ${forwardHost}:${forwardPort} …` };
          const res = await this.instances.runResourceOperationAwait(opts.proxy.instanceId, 'create-proxy-host', undefined, {
            domain_names: domain,
            forward_scheme: 'http',
            forward_host: forwardHost,
            forward_port: forwardPort,
            certificate_id: String(certId),
            ssl_forced: certId > 0 && !!opts.proxy.sslForced,
            block_exploits: true,
            allow_websocket_upgrade: true,
            caching_enabled: false,
          });
          if (!res.ok) {
            yield { type: 'log', text: `⚠ Reverse proxy not created (${res.message || 'NPM rejected it'}). Using the direct URL instead.` };
          } else {
            finalUrl = `${certId > 0 ? 'https' : 'http'}://${domain}`;
            yield { type: 'log', text: `Reverse proxy ready. The Computer will connect via ${finalUrl}` };
          }
        } catch (err) {
          yield { type: 'log', text: `⚠ Reverse proxy failed (${err instanceof Error ? err.message : String(err)}). Using the direct URL instead.` };
        }
      }

      yield { type: 'done', baseUrl: finalUrl, model: opts.model };
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function stripSlash(n: string): string {
  return n.startsWith('/') ? n.slice(1) : n;
}

/** Suggest a Base URL Cerebro can use to reach the container. Best-effort; user can edit. */
function deriveBaseUrl(endpoint: string, port: number): string {
  if (endpoint.startsWith('tcp://')) {
    try {
      const host = new URL(endpoint.replace(/^tcp:\/\//, 'http://')).hostname;
      if (host) return `http://${host}:${port}`;
    } catch {
      /* fall through */
    }
  }
  // unix:// or npipe:// — the daemon is local to the Docker host; localhost works when
  // Cerebro shares that host's network. The user can adjust if not.
  return `http://localhost:${port}`;
}

/** Poll GET {baseUrl}/api/tags until it answers (or give up). */
async function waitReady(baseUrl: string, attempts = 20, delayMs = 2000): Promise<boolean> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/tags`;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

/** Pull a model via Ollama's own HTTP API (blocking until complete). */
async function pullModel(baseUrl: string, model: string): Promise<void> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: false }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`model pull failed (${res.status}): ${text.slice(0, 300) || res.statusText}`);
  }
}
