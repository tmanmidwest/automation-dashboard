import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Save, BookOpen, Rocket, Loader2, Server } from 'lucide-react';
import type {
  AssistantConfigView, AssistantModelInfo, LlmBackend,
  OllamaCertOption, OllamaDeployEvent, OllamaHost,
} from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';

const BACKENDS: { value: LlmBackend; label: string; hint: string; needsKey?: boolean; placeholder?: string }[] = [
  { value: 'ollama', label: 'Ollama (self-hosted)', hint: 'Base URL like http://ollama:11434 — no API key.', placeholder: 'http://ollama:11434' },
  {
    value: 'openai-compat',
    label: 'OpenAI-compatible (LM Studio / vLLM / OpenAI …)',
    hint: 'Base URL ending in /v1, e.g. http://host:1234/v1 or https://api.openai.com/v1.',
    placeholder: 'http://host:1234/v1',
  },
  {
    value: 'anthropic',
    label: 'Claude (Anthropic API)',
    hint: 'Frontier tool-calling. Leave the base URL blank for the default endpoint. Requires an API key.',
    needsKey: true,
    placeholder: 'https://api.anthropic.com (default)',
  },
];

export function ComputerSettings() {
  const [cfg, setCfg] = useState<AssistantConfigView | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<AssistantModelInfo[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);

  // "Deploy Ollama with Cerebro" wizard state.
  const [wizardOpen, setWizardOpen] = useState(false);
  const [hosts, setHosts] = useState<OllamaHost[] | null>(null);
  const [wInstance, setWInstance] = useState('');
  const [wPort, setWPort] = useState(11434);
  const [wGpu, setWGpu] = useState(false);
  const [wModel, setWModel] = useState('qwen2.5:7b');
  const [wBaseUrlOverride, setWBaseUrlOverride] = useState('');
  const [deployLog, setDeployLog] = useState<string[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [deployDone, setDeployDone] = useState(false);
  // Reverse-proxy (NPM) option.
  const [wProxyOn, setWProxyOn] = useState(false);
  const [proxies, setProxies] = useState<OllamaHost[]>([]);
  const [wProxyInstance, setWProxyInstance] = useState('');
  const [wProxyDomain, setWProxyDomain] = useState('');
  const [proxyCerts, setProxyCerts] = useState<OllamaCertOption[]>([]);
  const [wProxyCertId, setWProxyCertId] = useState(0);

  useEffect(() => {
    api.get<AssistantConfigView>('/api/assistant/config').then(setCfg).catch(() => setCfg(null));
  }, []);

  function set<K extends keyof AssistantConfigView>(key: K, value: AssistantConfigView[K]) {
    setCfg((c) => (c ? { ...c, [key]: value } : c));
  }

  async function loadModels() {
    if (!cfg) return;
    setLoadingModels(true);
    setMsg(null);
    try {
      // Save current URL/key first so the server queries the right backend.
      await save(false);
      setModels(await api.get<AssistantModelInfo[]>('/api/assistant/models'));
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not reach the model backend.' });
    } finally {
      setLoadingModels(false);
    }
  }

  async function save(announce = true) {
    if (!cfg) return;
    setBusy(true);
    if (announce) setMsg(null);
    try {
      const body: Record<string, unknown> = {
        enabled: cfg.enabled,
        backend: cfg.backend,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        temperature: cfg.temperature,
        systemPromptExtra: cfg.systemPromptExtra ?? '',
        contextPrimer: cfg.contextPrimer,
      };
      if (apiKey) body.apiKey = apiKey;
      const updated = await api.put<AssistantConfigView>('/api/assistant/config', body);
      setCfg(updated);
      setApiKey('');
      if (announce) setMsg({ ok: true, text: 'Saved.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to save.' });
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function openWizard() {
    if (!cfg) return;
    setDeployLog([]); setDeployDone(false); setWizardOpen(true);
    setWModel(cfg.model || 'qwen2.5:7b');
    setHosts(null);
    setWProxyOn(false); setProxyCerts([]); setWProxyCertId(0);
    try {
      const [h, p] = await Promise.all([
        api.get<OllamaHost[]>('/api/assistant/ollama/hosts'),
        api.get<OllamaHost[]>('/api/assistant/ollama/proxies').catch(() => [] as OllamaHost[]),
      ]);
      setHosts(h);
      if (h.length) setWInstance((cur) => cur || h[0].instanceId);
      setProxies(p);
      if (p.length) setWProxyInstance((cur) => cur || p[0].instanceId);
    } catch {
      setHosts([]);
    }
  }

  // Load NPM certificate options when the chosen proxy instance changes.
  useEffect(() => {
    if (!wProxyOn || !wProxyInstance) return;
    setProxyCerts([]);
    api.get<OllamaCertOption[]>(`/api/assistant/ollama/proxy-certs?instanceId=${encodeURIComponent(wProxyInstance)}`)
      .then(setProxyCerts)
      .catch(() => setProxyCerts([]));
  }, [wProxyOn, wProxyInstance]);

  async function deployOllama() {
    if (!wInstance || deploying) return;
    setDeploying(true); setDeployDone(false); setDeployLog([]);
    const append = (line: string) => setDeployLog((l) => [...l, line]);
    try {
      const res = await fetch('/api/assistant/ollama/deploy', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instanceId: wInstance, port: wPort, gpu: wGpu,
          model: wModel.trim() || undefined,
          baseUrlOverride: wBaseUrlOverride.trim() || undefined,
          proxy: wProxyOn && wProxyInstance && wProxyDomain.trim()
            ? { instanceId: wProxyInstance, domain: wProxyDomain.trim(), certificateId: wProxyCertId, sslForced: wProxyCertId > 0 }
            : undefined,
        }),
      });
      if (!res.ok || !res.body) throw new Error((await res.text().catch(() => '')) || `Request failed (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 2);
          if (!frame.startsWith('data:')) continue;
          const ev = JSON.parse(frame.slice(5).trim()) as OllamaDeployEvent;
          if (ev.type === 'log') append(ev.text);
          else if (ev.type === 'error') { append(`⚠ ${ev.message}`); }
          else if (ev.type === 'done') {
            append('✓ Done.');
            // Persist: point the Computer at the freshly deployed backend and enable it.
            const updated = await api.put<AssistantConfigView>('/api/assistant/config', {
              enabled: true, backend: 'ollama', baseUrl: ev.baseUrl,
              model: ev.model || wModel.trim() || cfg!.model,
              temperature: cfg!.temperature, systemPromptExtra: cfg!.systemPromptExtra ?? '',
              contextPrimer: cfg!.contextPrimer,
            });
            setCfg(updated);
            setDeployDone(true);
          }
        }
      }
    } catch (e) {
      append(`⚠ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeploying(false);
    }
  }

  if (!cfg) return <div className="text-sm text-muted-foreground">Loading…</div>;

  const backend = BACKENDS.find((b) => b.value === cfg.backend);

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Computer"
        description="The in-app LLM assistant. Runs contained to Cerebro via a self-hosted model, or points at any OpenAI-compatible endpoint."
      />

      <Card>
        <CardHeader>
          <CardTitle>Model backend</CardTitle>
          <CardDescription>
            The Computer uses the tools your account can access, and is read-only in this phase.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={cfg.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
            />
            <span>Enable the Computer</span>
          </label>

          <div className="space-y-1.5">
            <Label>Backend</Label>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={cfg.backend}
              onChange={(e) => set('backend', e.target.value as LlmBackend)}
            >
              {BACKENDS.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
            {backend && <p className="text-xs text-muted-foreground">{backend.hint}</p>}
          </div>

          <BackendGuide backend={cfg.backend} />

          {cfg.backend === 'ollama' && (
            <div className="rounded-md border border-primary/40 bg-primary/5 p-3 flex items-start gap-3">
              <Rocket className="h-4 w-4 text-primary mt-0.5 shrink-0" />
              <div className="flex-1 text-sm">
                <p className="font-medium">Let Cerebro deploy it</p>
                <p className="text-xs text-muted-foreground">
                  Provision the Ollama container onto one of your Docker connector hosts — no compose editing.
                  Cerebro pulls the image, starts the container, pulls a model, and fills in the Base URL for you.
                </p>
              </div>
              <Button type="button" size="sm" onClick={openWizard}>
                <Rocket className="h-4 w-4" /> Deploy with Cerebro
              </Button>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Base URL {cfg.backend === 'anthropic' && <span className="text-xs text-muted-foreground">(optional)</span>}</Label>
            <Input value={cfg.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder={backend?.placeholder} />
          </div>

          {(cfg.backend === 'openai-compat' || cfg.backend === 'anthropic') && (
            <div className="space-y-1.5">
              <Label>
                API key {cfg.apiKeySet && <span className="text-xs text-emerald-500">(set — leave blank to keep)</span>}
                {backend?.needsKey && !cfg.apiKeySet && <span className="text-xs text-red-500"> (required)</span>}
              </Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={cfg.apiKeySet ? '••••••••' : backend?.needsKey ? 'sk-ant-…' : 'Optional for local servers'}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Model</Label>
            <div className="flex gap-2">
              <Input value={cfg.model} onChange={(e) => set('model', e.target.value)} placeholder="qwen2.5:7b" list="assistant-models" />
              <Button type="button" variant="outline" onClick={loadModels} disabled={loadingModels}>
                <RefreshCw className={loadingModels ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
              </Button>
            </div>
            <datalist id="assistant-models">
              {models.map((m) => (
                <option key={m.name} value={m.name} />
              ))}
            </datalist>
            {models.length > 0 && (
              <p className="text-xs text-muted-foreground">{models.length} models available on this backend.</p>
            )}
          </div>

          {cfg.backend !== 'anthropic' && (
            <div className="space-y-1.5">
              <Label>Temperature: {cfg.temperature.toFixed(2)}</Label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                className="w-full"
                value={cfg.temperature}
                onChange={(e) => set('temperature', Number(e.target.value))}
              />
            </div>
          )}

          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 mt-0.5"
              checked={cfg.contextPrimer}
              onChange={(e) => set('contextPrimer', e.target.checked)}
            />
            <span>
              Ground each conversation with a live status snapshot
              <span className="block text-xs text-muted-foreground">
                Prepends a compact digest (connectors, monitors, recent warnings) so the Computer answers
                "what's wrong?" without a lookup. Respects your permissions.
              </span>
            </span>
          </label>

          <div className="space-y-1.5">
            <Label>System prompt additions (optional)</Label>
            <textarea
              className="w-full min-h-20 rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={cfg.systemPromptExtra ?? ''}
              onChange={(e) => set('systemPromptExtra', e.target.value)}
              placeholder="Extra house rules for the Computer…"
            />
          </div>

          {msg && (
            <p className={msg.ok ? 'text-sm text-emerald-500' : 'text-sm text-red-500'}>{msg.text}</p>
          )}

          <div className="flex justify-end">
            <Button onClick={() => save()} disabled={busy}>
              <Save className="h-4 w-4 mr-2" />
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={wizardOpen} onClose={() => { if (!deploying) setWizardOpen(false); }}
        title="Deploy Ollama with Cerebro"
        description="Cerebro provisions the Ollama container on a Docker host you already manage."
        footer={<>
          <Button variant="outline" onClick={() => setWizardOpen(false)} disabled={deploying}>
            {deployDone ? 'Close' : 'Cancel'}
          </Button>
          {!deployDone && (
            <Button onClick={deployOllama} disabled={deploying || !wInstance}>
              {deploying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />} Deploy
            </Button>
          )}
        </>}>
        {hosts === null ? (
          <p className="text-sm text-muted-foreground">Loading Docker hosts…</p>
        ) : hosts.length === 0 ? (
          <p className="text-sm">
            No Docker connector hosts found. <Link to="/connectors" className="underline">Add a Docker connector</Link> first,
            then come back here.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5"><Server className="h-3.5 w-3.5" /> Docker host — where Ollama will run</Label>
              <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={wInstance} onChange={(e) => setWInstance(e.target.value)} disabled={deploying}>
                {hosts.map((h) => <option key={h.instanceId} value={h.instanceId}>{h.name}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">
                Can be a different machine than Cerebro — e.g. a GPU box. Cerebro deploys there and connects to it remotely.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Published port</Label>
                <Input type="number" value={wPort} onChange={(e) => setWPort(Number(e.target.value) || 11434)} disabled={deploying} />
              </div>
              <div className="space-y-1.5">
                <Label>Model to pull</Label>
                <Input value={wModel} onChange={(e) => setWModel(e.target.value)} placeholder="qwen2.5:7b" disabled={deploying} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={wGpu} onChange={(e) => setWGpu(e.target.checked)} disabled={deploying} />
              <span>Request all GPUs (host must have the NVIDIA container runtime)</span>
            </label>
            <div className="space-y-1.5">
              <Label>Base URL override <span className="text-xs text-muted-foreground">(optional, advanced)</span></Label>
              <Input value={wBaseUrlOverride} onChange={(e) => setWBaseUrlOverride(e.target.value)}
                placeholder="auto — e.g. http://gpu-box:11434" disabled={deploying} />
              <p className="text-xs text-muted-foreground">
                Leave blank to derive it from the Docker host. Set it if Cerebro should reach Ollama at a
                different address than the Docker API (e.g. a LAN IP vs a VPN IP).
              </p>
            </div>

            <div className="rounded-md border border-border/60 p-3 space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4" checked={wProxyOn}
                  onChange={(e) => setWProxyOn(e.target.checked)}
                  disabled={deploying || proxies.length === 0} />
                <span>Put it behind a reverse proxy (Nginx Proxy Manager)</span>
              </label>
              {proxies.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No Nginx Proxy Manager connector configured. <Link to="/connectors" className="underline">Add one</Link> to
                  route Ollama through a clean hostname with optional TLS.
                </p>
              ) : wProxyOn && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Proxy manager</Label>
                      <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={wProxyInstance} onChange={(e) => setWProxyInstance(e.target.value)} disabled={deploying}>
                        {proxies.map((p) => <option key={p.instanceId} value={p.instanceId}>{p.name}</option>)}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Certificate</Label>
                      <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={wProxyCertId} onChange={(e) => setWProxyCertId(Number(e.target.value) || 0)} disabled={deploying}>
                        <option value={0}>None (HTTP)</option>
                        {proxyCerts.filter((c) => c.id > 0).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Public hostname</Label>
                    <Input value={wProxyDomain} onChange={(e) => setWProxyDomain(e.target.value)}
                      placeholder="ollama.lan or ollama.example.com" disabled={deploying} />
                    <p className="text-xs text-muted-foreground">
                      The Computer will connect via {wProxyCertId > 0 ? 'https' : 'http'}://{wProxyDomain.trim() || '<hostname>'} instead of the direct URL.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {deployLog.length > 0 && (
              <pre className="max-h-56 overflow-y-auto rounded border border-border/60 bg-background/70 p-2 text-xs font-mono leading-relaxed whitespace-pre-wrap">
                {deployLog.join('\n')}
              </pre>
            )}
            {deployDone && (
              <p className="text-sm text-emerald-500">Deployed and configured — the Computer now points at this Ollama. Close this dialog and try it.</p>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}

const ollamaCompose = `services:
  ollama:
    image: ollama/ollama:latest
    restart: unless-stopped
    volumes:
      - ollama:/root/.ollama
    # GPU (optional): uncomment if the host has the NVIDIA runtime
    # deploy:
    #   resources:
    #     reservations:
    #       devices: [{ driver: nvidia, count: all, capabilities: [gpu] }]
volumes:
  ollama:`;

/** Step-by-step setup directions for the selected backend. */
function BackendGuide({ backend }: { backend: LlmBackend }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium mb-2">
        <BookOpen className="h-4 w-4 text-primary" />
        Setup guide
      </div>

      {backend === 'ollama' && (
        <ol className="list-decimal pl-5 space-y-1.5 text-muted-foreground">
          <li className="text-foreground">
            <b>Easiest:</b> use <b>Deploy with Cerebro</b> below — it provisions everything for you. The steps
            below are the manual alternative if you'd rather run it yourself.
          </li>
          <li>
            Run an Ollama container on the same Docker network as Cerebro. Add this to your
            <code className="mx-1 rounded bg-background/70 px-1">docker-compose.override.yml</code> and redeploy:
            <Snippet text={ollamaCompose} />
          </li>
          <li>
            Pull a model into it (once): <Code>docker compose exec ollama ollama pull qwen2.5:7b</Code>. On a GPU
            host, prefer a larger model such as <Code>qwen2.5:14b</Code> or <Code>qwen2.5:32b</Code> for reliable
            tool-calling.
          </li>
          <li>Set <b>Base URL</b> to <Code>http://ollama:11434</Code> (the in-network service name).</li>
          <li>Click the refresh icon by <b>Model</b> to list installed models, pick one, then <b>Save</b>.</li>
          <li className="text-amber-500/90">
            CPU-only works but is slow and less reliable at multi-step actions — a GPU is recommended if you want
            the Computer to take actions, not just answer questions.
          </li>
        </ol>
      )}

      {backend === 'openai-compat' && (
        <ol className="list-decimal pl-5 space-y-1.5 text-muted-foreground">
          <li>
            Works with any OpenAI-compatible server: <b>LM Studio</b>, <b>vLLM</b>, <b>llama.cpp server</b>,
            <b> LocalAI</b>, or the <b>OpenAI API</b> itself. It must expose a streaming
            <Code>/chat/completions</Code> endpoint with tool-calling.
          </li>
          <li>
            Set <b>Base URL</b> to the API root ending in <Code>/v1</Code> — e.g. <Code>http://192.168.1.50:1234/v1</Code>
            {' '}(LM Studio) or <Code>https://api.openai.com/v1</Code>.
          </li>
          <li>
            <b>API key</b>: leave blank for most local servers; required for OpenAI (starts with <Code>sk-</Code>).
          </li>
          <li>
            Enter the <b>Model</b> id (e.g. <Code>gpt-4o-mini</Code>, or the exact name your local server reports),
            or click refresh to list what the server advertises. Then <b>Save</b>.
          </li>
          <li>This backend leaves your box only if the base URL is remote (e.g. OpenAI); a local server stays contained.</li>
        </ol>
      )}

      {backend === 'anthropic' && (
        <ol className="list-decimal pl-5 space-y-1.5 text-muted-foreground">
          <li>
            Create an API key at{' '}
            <a className="underline" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
              console.anthropic.com
            </a>{' '}
            — it starts with <Code>sk-ant-</Code>.
          </li>
          <li>Leave <b>Base URL</b> blank to use the default endpoint (<Code>https://api.anthropic.com</Code>).</li>
          <li>Paste the key into <b>API key</b>.</li>
          <li>
            Set <b>Model</b> to e.g. <Code>claude-opus-5</Code> (best), <Code>claude-sonnet-5</Code>, or
            {' '}<Code>claude-haiku-4-5</Code> (cheapest); or click refresh to list available models. Then <b>Save</b>.
          </li>
          <li className="text-amber-500/90">
            Best-in-class tool-calling, but not self-contained — requests go to Anthropic and are billed per token.
            Temperature is ignored (current Claude models set it internally).
          </li>
        </ol>
      )}
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-background/70 px-1 text-xs font-mono">{children}</code>;
}

function Snippet({ text }: { text: string }) {
  return (
    <pre className="mt-1 overflow-x-auto rounded border border-border/60 bg-background/70 p-2 text-xs font-mono leading-relaxed">
      {text}
    </pre>
  );
}
