import { Injectable } from '@nestjs/common';
import type {
  GpuStatus, OllamaCertOption, OllamaDeployEvent, OllamaDeployRequest, OllamaHost, OllamaSetupEvent,
} from '@cerebro/shared';
import type { ConnectorContext } from '@cerebro/shared';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { DockerApi, type DockerAuth } from '../connectors/docker/docker-api';
import { runSsh, type SshConfig } from '../connectors/docker/docker-ssh';

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

  // ── GPU readiness + NVIDIA Container Toolkit install ──────────────

  /** Probe a Docker host's GPU stack (driver / toolkit / docker runtime) over SSH + Engine API. */
  async gpuStatus(instanceId: string): Promise<GpuStatus> {
    const inst = await this.instances.get(instanceId);
    if (inst.connectorId !== DOCKER_CONNECTOR) throw new Error('Not a Docker host.');
    const ctx = await this.instances.contextFor(inst);

    // Docker `nvidia` runtime via the Engine API (no SSH needed).
    let runtimePresent = false;
    try {
      const info = (await new DockerApi(dockerAuth(ctx)).info()) as { Runtimes?: Record<string, unknown> };
      runtimePresent = !!info.Runtimes && !!info.Runtimes.nvidia;
    } catch { /* leave false */ }

    const ssh = sshFrom(ctx);
    if (!ssh) {
      return {
        sshConfigured: false, reachable: false, distroSupported: false,
        driver: { present: false }, toolkit: { present: false }, runtime: { present: runtimePresent },
        canInstallToolkit: false,
        message: 'This Docker connector has no SSH credentials, so Cerebro can\'t inspect or install GPU components. Add an SSH host, user, and key/password on the connector to enable this.',
      };
    }

    let reachable = false;
    let distro: string | undefined;
    let driver: GpuStatus['driver'] = { present: false };
    let toolkit: GpuStatus['toolkit'] = { present: false };
    try {
      const os = await runSsh(ssh, '. /etc/os-release 2>/dev/null; echo "$ID $VERSION_ID"');
      reachable = true;
      distro = os.stdout.trim() || undefined;
      const smi = await runSsh(ssh, 'nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null');
      if (smi.code === 0 && smi.stdout.trim()) driver = { present: true, detail: firstLine(smi.stdout) };
      const ctk = await runSsh(ssh, 'nvidia-ctk --version 2>/dev/null');
      if (ctk.code === 0 && ctk.stdout.trim()) toolkit = { present: true, detail: firstLine(ctk.stdout) };
    } catch (err) {
      return {
        sshConfigured: true, reachable: false, distroSupported: false,
        driver, toolkit, runtime: { present: runtimePresent }, canInstallToolkit: false,
        message: `Couldn't reach the host over SSH: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const distroId = (distro ?? '').split(' ')[0].toLowerCase();
    const distroSupported = distroId === 'ubuntu' || distroId === 'debian';
    const canInstallToolkit = reachable && distroSupported && !toolkit.present;

    return {
      sshConfigured: true, reachable, distro, distroSupported,
      driver, toolkit, runtime: { present: runtimePresent }, canInstallToolkit,
      message: gpuMessage({ driver, toolkit, runtimePresent, distroSupported, canInstallToolkit }),
    };
  }

  /** Install the NVIDIA Container Toolkit on a Debian/Ubuntu Docker host, streaming progress. */
  async *installToolkit(instanceId: string): AsyncGenerator<OllamaSetupEvent> {
    let ssh: SshConfig | null;
    try {
      const inst = await this.instances.get(instanceId);
      if (inst.connectorId !== DOCKER_CONNECTOR) { yield { type: 'error', message: 'Not a Docker host.' }; return; }
      ssh = sshFrom(await this.instances.contextFor(inst));
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
      return;
    }
    if (!ssh) { yield { type: 'error', message: 'This Docker connector has no SSH credentials.' }; return; }

    try {
      const os = await runSsh(ssh, '. /etc/os-release 2>/dev/null; echo "$ID"');
      const id = os.stdout.trim().toLowerCase();
      if (id !== 'ubuntu' && id !== 'debian') {
        yield { type: 'error', message: `Auto-install supports Debian/Ubuntu only (host reports "${id || 'unknown'}"). Install the NVIDIA Container Toolkit manually.` };
        return;
      }
      // Non-root users need passwordless sudo; root runs the commands directly.
      const S = ssh.username === 'root' ? '' : 'sudo -n ';

      const steps: { label: string; cmd: string; timeoutMs?: number }[] = [
        {
          label: 'Adding the NVIDIA package repository',
          cmd:
            `curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | ${S}gpg --yes --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg && ` +
            `curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | ` +
            `sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | ${S}tee /etc/apt/sources.list.d/nvidia-container-toolkit.list`,
        },
        { label: 'Updating package lists', cmd: `${S}apt-get update`, timeoutMs: 180_000 },
        { label: 'Installing nvidia-container-toolkit', cmd: `${S}apt-get install -y nvidia-container-toolkit`, timeoutMs: 300_000 },
        { label: 'Configuring the Docker runtime', cmd: `${S}nvidia-ctk runtime configure --runtime=docker` },
        { label: 'Restarting Docker', cmd: `${S}systemctl restart docker`, timeoutMs: 60_000 },
      ];

      for (const step of steps) {
        yield { type: 'log', text: `${step.label}…` };
        const r = await runSsh(ssh, step.cmd, undefined, step.timeoutMs ?? 120_000);
        if (r.code !== 0) {
          const detail = tail(r.stderr || r.stdout) || `exit ${r.code}`;
          const hint = S && /sudo/.test(detail) ? ' (the SSH user needs passwordless sudo, or use root)' : '';
          yield { type: 'error', message: `${step.label} failed: ${detail}${hint}` };
          return;
        }
        const out = tail(r.stdout);
        if (out) yield { type: 'log', text: out };
      }

      // Verify the runtime is now registered.
      const verify = await runSsh(ssh, `docker info --format '{{json .Runtimes}}' 2>/dev/null`);
      if (verify.stdout.includes('nvidia')) yield { type: 'log', text: '✓ Docker now has the nvidia runtime.' };
      else yield { type: 'log', text: '⚠ Installed, but the nvidia runtime is not visible yet — a Docker restart or host reboot may be needed.' };

      yield { type: 'done' };
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
    }
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
      // GPU preflight: creating with a DeviceRequest against a host that has no `nvidia`
      // runtime yields a confusing 500 on start. Catch it here with an actionable message.
      if (opts.gpu) {
        const info = (await api.info().catch(() => ({}))) as { Runtimes?: Record<string, unknown> };
        if (!info.Runtimes || !info.Runtimes.nvidia) {
          yield {
            type: 'error',
            message:
              'GPU requested, but this Docker host has no "nvidia" runtime — the NVIDIA Container Toolkit ' +
              'isn\'t installed. Install it on the host (nvidia-ctk runtime configure --runtime=docker, then ' +
              'restart Docker), or uncheck "Request all GPUs" to run on CPU.',
          };
          return;
        }
      }

      yield { type: 'log', text: `Pulling image ${IMAGE} … (first time can take a minute)` };
      await api.pullImage(IMAGE, () => { /* coarse progress; SSE keeps the connection open */ });
      yield { type: 'log', text: 'Image ready.' };

      const desiredBody = (): Record<string, unknown> => ({
        Image: IMAGE,
        ExposedPorts: { [`${OLLAMA_PORT}/tcp`]: {} },
        HostConfig: {
          RestartPolicy: { Name: 'unless-stopped' },
          PortBindings: { [`${OLLAMA_PORT}/tcp`]: [{ HostPort: String(port) }] },
          Binds: [`${VOLUME_NAME}:/root/.ollama`],
          ...(opts.gpu ? { DeviceRequests: [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }] } : {}),
        },
      });

      let existing = (await api.listContainers(true)).find((c) =>
        (c.Names ?? []).some((n) => stripSlash(n) === CONTAINER_NAME),
      );

      // Explicit rebuild, or auto-heal a broken container.
      if (existing && opts.recreate) {
        yield { type: 'log', text: 'Removing existing container to rebuild it…' };
        await api.removeContainer(existing.Id).catch(() => { /* ignore */ });
        existing = undefined;
      }

      if (existing) {
        const id = existing.Id;
        if ((existing.State ?? '') === 'running') {
          yield { type: 'log', text: 'Container "cerebro-ollama" already running — reusing it.' };
        } else {
          yield { type: 'log', text: 'Starting existing cerebro-ollama container…' };
          try {
            await api.startContainer(id);
          } catch (startErr) {
            // A container created by a prior (e.g. GPU) attempt can be un-startable on this
            // host. Rebuild it from scratch with the current options.
            const msg = startErr instanceof Error ? startErr.message : String(startErr);
            yield { type: 'log', text: `⚠ Existing container wouldn't start (${msg}). Rebuilding it…` };
            await api.removeContainer(id).catch(() => { /* ignore */ });
            const newId = await api.createContainer(CONTAINER_NAME, desiredBody());
            await api.startContainer(newId);
          }
        }
      } else {
        yield { type: 'log', text: `Creating container "${CONTAINER_NAME}" (volume ${VOLUME_NAME}, port ${port})…` };
        const id = await api.createContainer(CONTAINER_NAME, desiredBody());
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
        try {
          for await (const line of pullModelStream(baseUrl, opts.model)) yield { type: 'log', text: line };
          yield { type: 'log', text: `Model ${opts.model} ready.` };
        } catch (pullErr) {
          // Non-fatal: the container is up and configured; the model can be pulled on a retry.
          yield {
            type: 'log',
            text: `⚠ Model pull didn't finish (${pullErr instanceof Error ? pullErr.message : String(pullErr)}). The container is running — re-run Deploy to resume the pull (it's resumable).`,
          };
        }
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

/** Build Docker Engine auth from a connector context (mirrors the docker connector). */
function dockerAuth(ctx: ConnectorContext): DockerAuth {
  return {
    endpoint: String(ctx.config.endpoint ?? ''),
    tlsCaCert: str(ctx.config.tlsCaCert),
    tlsClientCert: str(ctx.config.tlsClientCert),
    tlsClientKey: str(ctx.config.tlsClientKey),
    insecureSkipVerify: ctx.config.insecureSkipVerify === true,
  };
}

/** Build an SSH config from a connector context, or null if none is set. */
function sshFrom(ctx: ConnectorContext): SshConfig | null {
  const host = str(ctx.config.sshHost);
  const key = str(ctx.config.sshPrivateKey);
  const password = str(ctx.config.sshPassword);
  if (!host || (!key && !password)) return null;
  return {
    host,
    port: Number(ctx.config.sshPort) || 22,
    username: str(ctx.config.sshUser) || 'root',
    privateKey: key,
    password,
  };
}

function firstLine(s: string): string {
  return s.split('\n')[0].trim();
}

/** Last few non-empty lines, for compact log/error output. */
function tail(s: string, lines = 3): string {
  return s.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-lines).join('\n');
}

function gpuMessage(x: {
  driver: GpuStatus['driver']; toolkit: GpuStatus['toolkit'];
  runtimePresent: boolean; distroSupported: boolean; canInstallToolkit: boolean;
}): string {
  if (x.driver.present && x.toolkit.present && x.runtimePresent) return 'GPU ready — driver, toolkit, and Docker runtime are all present.';
  const missing: string[] = [];
  if (!x.driver.present) missing.push('NVIDIA driver (nvidia-smi)');
  if (!x.toolkit.present) missing.push('NVIDIA Container Toolkit');
  if (x.driver.present && x.toolkit.present && !x.runtimePresent) missing.push('Docker nvidia runtime (restart Docker)');
  const parts = [`Missing: ${missing.join(', ')}.`];
  if (!x.driver.present) parts.push('Install the NVIDIA driver on the host first (Cerebro does not auto-install drivers).');
  if (x.canInstallToolkit) parts.push('Cerebro can install the Container Toolkit for you (button below).');
  else if (!x.toolkit.present && !x.distroSupported) parts.push('Auto-install supports Debian/Ubuntu only; install the toolkit manually here.');
  return parts.join(' ');
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

/**
 * Pull a model via Ollama's STREAMING /api/pull, yielding throttled progress lines. Streaming
 * is essential: a non-streaming pull sends no response until the multi-GB download completes,
 * which trips the HTTP client's headers timeout ("network error"). Progress lines also give
 * the user real feedback. The download is resumable, so a failed pull can just be re-run.
 */
async function* pullModelStream(baseUrl: string, model: string): AsyncGenerator<string> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true }),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`pull failed (${res.status}): ${text.slice(0, 200) || res.statusText}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let lastStatus = '';
  let lastPct = -10;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { status?: string; error?: string; total?: number; completed?: number };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.error) throw new Error(msg.error);
      const status = msg.status ?? '';
      // Emit on a status change, or every ~5% within a download phase (throttle the flood).
      if (msg.total && msg.completed) {
        const pct = Math.floor((msg.completed / msg.total) * 100);
        if (status !== lastStatus || pct - lastPct >= 5) {
          yield `  ${status} — ${pct}% (${fmtBytes(msg.completed)}/${fmtBytes(msg.total)})`;
          lastStatus = status;
          lastPct = pct;
        }
      } else if (status && status !== lastStatus) {
        yield `  ${status}`;
        lastStatus = status;
        lastPct = -10;
      }
    }
  }
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}
