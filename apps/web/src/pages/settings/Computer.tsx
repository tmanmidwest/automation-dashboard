import { useEffect, useState } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import type { AssistantConfigView, AssistantModelInfo, LlmBackend } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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
    </div>
  );
}
