import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { RefreshCw, Save, Trash2, MessageSquare, Rocket } from 'lucide-react';
import type {
  AssistantAgentInput,
  AssistantAgentView,
  AssistantModelInfo,
  AssistantToolInfo,
  LlmBackend,
  McpServerView,
} from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { AgentChat } from '@/components/AgentChat';

const BACKENDS: { value: LlmBackend; label: string; placeholder: string; needsKey?: boolean }[] = [
  { value: 'ollama', label: 'Ollama (self-hosted)', placeholder: 'http://ollama:11434' },
  { value: 'openai-compat', label: 'OpenAI-compatible (LM Studio / vLLM / OpenAI …)', placeholder: 'http://host:1234/v1' },
  { value: 'anthropic', label: 'Claude (Anthropic API)', placeholder: 'https://api.anthropic.com (default)', needsKey: true },
];

const selectCls = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm';

type Draft = AssistantAgentInput & Partial<Pick<AssistantAgentView, 'id' | 'isDefault' | 'apiKeySet' | 'ready' | 'updatedAt'>>;

// Mirrors DEFAULT_ASSISTANT_CONFIG / DEFAULT_AGENT_MAX_ROUNDS (web imports types only from shared).
const NEW_AGENT: Draft = {
  name: '',
  description: '',
  enabled: true,
  backend: 'ollama',
  baseUrl: 'http://ollama:11434',
  model: 'qwen2.5:7b',
  temperature: 0.2,
  instructions: '',
  contextPrimer: true,
  maxRounds: 6,
  toolMode: 'all',
  tools: [],
  allowedRoles: [],
  mcpServerIds: [],
  mcpDisabledTools: [],
  mcpAutoApproveTools: [],
};

/** Settings → Agents → one agent: General, Model, Instructions, Tools. */
export function AgentEditor() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const [agent, setAgent] = useState<Draft | null>(isNew ? NEW_AGENT : null);
  const [apiKey, setApiKey] = useState('');
  const [tools, setTools] = useState<AssistantToolInfo[]>([]);
  const [roles, setRoles] = useState<{ slug: string; name: string }[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerView[]>([]);
  const [models, setModels] = useState<AssistantModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!isNew) {
      api.get<AssistantAgentView>(`/api/assistant/agents/${id}`)
        .then(setAgent)
        .catch((e) => setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to load the agent.' }));
    } else {
      setAgent(NEW_AGENT);
    }
    api.get<AssistantToolInfo[]>('/api/assistant/tools').then(setTools).catch(() => setTools([]));
    api.get<McpServerView[]>('/api/assistant/mcp-servers').then(setMcpServers).catch(() => setMcpServers([]));
    // Needs users:read; without it the role picker simply stays empty.
    api.get<{ slug: string; name: string }[]>('/api/roles').then(setRoles).catch(() => setRoles([]));
  }, [id, isNew]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setAgent((a) => (a ? { ...a, [key]: value } : a));
  }

  async function save(): Promise<AssistantAgentView | null> {
    if (!agent) return null;
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = {
        name: agent.name,
        description: agent.description ?? '',
        enabled: agent.enabled,
        backend: agent.backend,
        baseUrl: agent.baseUrl,
        model: agent.model,
        temperature: agent.temperature,
        instructions: agent.instructions ?? '',
        contextPrimer: agent.contextPrimer,
        maxRounds: agent.maxRounds,
        toolMode: agent.toolMode,
        tools: agent.tools,
        allowedRoles: agent.allowedRoles,
        mcpServerIds: agent.mcpServerIds,
        mcpDisabledTools: agent.mcpDisabledTools,
        mcpAutoApproveTools: agent.mcpAutoApproveTools,
      };
      if (apiKey) body.apiKey = apiKey;
      const saved = isNew
        ? await api.post<AssistantAgentView>('/api/assistant/agents', body)
        : await api.put<AssistantAgentView>(`/api/assistant/agents/${id}`, body);
      setAgent(saved);
      setApiKey('');
      setMsg({ ok: true, text: 'Saved.' });
      if (isNew) navigate(`/settings/agents/${saved.id}`, { replace: true });
      return saved;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to save.' });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function loadModels() {
    setLoadingModels(true);
    try {
      // Save first so the server queries the backend with the current URL and key.
      const saved = await save();
      if (!saved) return;
      setModels(await api.get<AssistantModelInfo[]>(`/api/assistant/agents/${saved.id}/models`));
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not reach the model backend.' });
    } finally {
      setLoadingModels(false);
    }
  }

  async function remove() {
    if (!agent?.id || agent.isDefault) return;
    if (!window.confirm(`Delete the "${agent.name}" agent? Automations that use it will fail until they're pointed at another agent.`)) return;
    try {
      await api.delete(`/api/assistant/agents/${agent.id}`);
      navigate('/settings/agents');
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to delete.' });
    }
  }

  // Tools grouped by the area their permission belongs to (connectors, monitors, …).
  const groups = useMemo(() => {
    const map = new Map<string, AssistantToolInfo[]>();
    for (const t of tools) {
      const area = t.permission.split(':')[0];
      map.set(area, [...(map.get(area) ?? []), t]);
    }
    return [...map.entries()];
  }, [tools]);

  if (!agent) {
    return (
      <>
        <PageHeader title="Agent" />
        {msg ? <p className="text-sm text-red-500">{msg.text}</p> : <p className="text-sm text-muted-foreground">Loading…</p>}
      </>
    );
  }

  const backend = BACKENDS.find((b) => b.value === agent.backend);
  const selected = new Set(agent.tools);
  // Add or remove one `<serverId>:<tool>` key in an MCP policy list.
  const toggleKey = (field: 'mcpDisabledTools' | 'mcpAutoApproveTools', key: string, add: boolean) =>
    set(field, add ? [...new Set([...agent[field], key])] : agent[field].filter((k) => k !== key));
  const toggleTools = (names: string[], on: boolean) => {
    const next = new Set(selected);
    for (const n of names) {
      if (on) next.add(n);
      else next.delete(n);
    }
    set('tools', [...next]);
  };

  return (
    <>
      <PageHeader
        title={isNew ? 'New agent' : agent.name || 'Agent'}
        description={
          agent.isDefault
            ? 'The default agent answers in the Computer chat and in automations unless another agent is picked.'
            : 'A Computer agent with its own model, instructions, and tools.'
        }
        actions={
          <>
            {!isNew && (
              <Button variant="outline" onClick={() => navigate('/computer', { state: { agentId: agent.id } })}>
                <MessageSquare className="h-4 w-4" /> Chat
              </Button>
            )}
            {!isNew && !agent.isDefault && (
              <Button variant="outline" onClick={remove}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            )}
            <Button onClick={() => void save()} disabled={busy}>
              <Save className="h-4 w-4" /> Save
            </Button>
          </>
        }
      />

      {msg && <p className={cn('text-sm mb-4', msg.ok ? 'text-emerald-500' : 'text-red-500')}>{msg.text}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>General</CardTitle>
            <CardDescription>What this agent is for and who may chat with it.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={agent.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Backup Officer" />
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input
                value={agent.description ?? ''}
                onChange={(e) => set('description', e.target.value)}
                placeholder="One line on its purpose (also shown to the model)"
              />
            </div>
            <label className="flex items-center gap-3 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={agent.enabled} onChange={(e) => set('enabled', e.target.checked)} />
              Enabled
            </label>
            <div className="space-y-1.5">
              <Label>Who can use it</Label>
              {roles.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {agent.allowedRoles.length ? `Roles: ${agent.allowedRoles.join(', ')}` : 'Everyone with access to the Computer.'}
                </p>
              ) : (
                <div className="flex flex-wrap gap-3">
                  {roles.map((r) => (
                    <label key={r.slug} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={agent.allowedRoles.includes(r.slug)}
                        onChange={(e) =>
                          set('allowedRoles', e.target.checked
                            ? [...agent.allowedRoles, r.slug]
                            : agent.allowedRoles.filter((s) => s !== r.slug))
                        }
                      />
                      {r.name}
                    </label>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                None ticked = anyone with access to the Computer. Agent managers can always use every agent.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Model</CardTitle>
            <CardDescription>The LLM this agent talks to.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Backend</Label>
              <select className={selectCls} value={agent.backend} onChange={(e) => set('backend', e.target.value as LlmBackend)}>
                {BACKENDS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
              </select>
              {agent.isDefault && agent.backend === 'ollama' && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Rocket className="h-3 w-3" /> Need a model server? <Link className="underline" to="/settings/computer">Deploy Ollama with Cerebro</Link>.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Base URL {agent.backend === 'anthropic' && <span className="text-xs text-muted-foreground">(optional)</span>}</Label>
              <Input value={agent.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder={backend?.placeholder} />
            </div>
            {agent.backend !== 'ollama' && (
              <div className="space-y-1.5">
                <Label>
                  API key {agent.apiKeySet && <span className="text-xs text-emerald-500">(set, leave blank to keep)</span>}
                  {backend?.needsKey && !agent.apiKeySet && <span className="text-xs text-red-500"> (required)</span>}
                </Label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={agent.apiKeySet ? '••••••••' : backend?.needsKey ? 'sk-ant-…' : 'Optional for local servers'}
                />
                <p className="text-xs text-muted-foreground">Stored encrypted in the Secrets Vault.</p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Model</Label>
              <div className="flex gap-2">
                <Input value={agent.model} onChange={(e) => set('model', e.target.value)} placeholder="qwen2.5:7b" />
                <Button type="button" variant="outline" onClick={loadModels} disabled={loadingModels} title="Save and list models">
                  <RefreshCw className={loadingModels ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                </Button>
              </div>
              {models.length > 0 && (
                <select
                  className={selectCls}
                  value={models.some((m) => m.name === agent.model) ? agent.model : ''}
                  onChange={(e) => e.target.value && set('model', e.target.value)}
                >
                  <option value="">Pick a model… ({models.length} available)</option>
                  {models.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
                </select>
              )}
            </div>
            {agent.backend !== 'anthropic' && (
              <div className="space-y-1.5">
                <Label>Temperature: {agent.temperature.toFixed(2)}</Label>
                <input type="range" min={0} max={1} step={0.05} className="w-full"
                  value={agent.temperature} onChange={(e) => set('temperature', Number(e.target.value))} />
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Instructions</CardTitle>
            <CardDescription>
              Added after Cerebro's built-in safety rules (tool output is untrusted data; actions need your approval), which always apply.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <textarea
              className="w-full min-h-32 rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={agent.instructions ?? ''}
              onChange={(e) => set('instructions', e.target.value)}
              placeholder="e.g. You look after stack backups. Answer with the last run, its size, and anything that failed."
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" className="h-4 w-4 mt-0.5" checked={agent.contextPrimer}
                  onChange={(e) => set('contextPrimer', e.target.checked)} />
                <span>
                  Ground each conversation with a live status snapshot
                  <span className="block text-xs text-muted-foreground">Connectors, monitors and recent warnings, filtered by the user's permissions.</span>
                </span>
              </label>
              <div className="space-y-1.5">
                <Label>Max tool rounds per answer</Label>
                <Input type="number" min={1} max={20} value={agent.maxRounds}
                  onChange={(e) => set('maxRounds', Number(e.target.value) || 1)} />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Tools</CardTitle>
            <CardDescription>
              An agent never gets more than the person chatting with it is allowed to do. Actions always ask for approval before they run.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="toolMode" checked={agent.toolMode === 'all'} onChange={() => set('toolMode', 'all')} />
                All built-in tools
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="toolMode" checked={agent.toolMode === 'selected'} onChange={() => set('toolMode', 'selected')} />
                Only the tools I pick ({agent.tools.length} selected)
              </label>
            </div>
            {agent.toolMode === 'selected' && (
              <div className="grid gap-4 md:grid-cols-2">
                {groups.map(([area, list]) => {
                  const names = list.map((t) => t.name);
                  const allOn = names.every((n) => selected.has(n));
                  return (
                    <div key={area} className="rounded-md border border-input p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">{area}</p>
                        <button type="button" className="text-xs underline text-muted-foreground" onClick={() => toggleTools(names, !allOn)}>
                          {allOn ? 'none' : 'all'}
                        </button>
                      </div>
                      {list.map((t) => (
                        <label key={t.name} className="flex items-start gap-2 text-sm" title={t.description}>
                          <input type="checkbox" className="h-4 w-4 mt-0.5" checked={selected.has(t.name)}
                            onChange={(e) => toggleTools([t.name], e.target.checked)} />
                          <span className="min-w-0">
                            <span className="font-mono text-xs">{t.name}</span>{' '}
                            <span className={cn('text-[10px] uppercase', t.kind === 'read' ? 'text-muted-foreground' : t.destructive ? 'text-red-500' : 'text-amber-500')}>
                              {t.kind === 'read' ? 'read' : t.destructive ? 'destructive' : 'action'}
                            </span>
                            <span className="block text-xs text-muted-foreground line-clamp-2">{t.description}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>MCP servers</CardTitle>
            <CardDescription>
              External tools. They run with the server's own credential, not the user's permissions, and are never used in
              automations. Each call asks for approval in chat unless you mark it to run without asking.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {mcpServers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No MCP servers registered. <Link className="underline" to="/settings/mcp-servers">Add one</Link>.
              </p>
            ) : (
              mcpServers.map((s) => {
                const attached = agent.mcpServerIds.includes(s.id);
                return (
                  <div key={s.id} className="rounded-md border border-input p-3 space-y-2">
                    <label className="flex items-start gap-3 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4 mt-0.5"
                        checked={attached}
                        onChange={(e) =>
                          set('mcpServerIds', e.target.checked
                            ? [...agent.mcpServerIds, s.id]
                            : agent.mcpServerIds.filter((x) => x !== s.id))
                        }
                      />
                      <span>
                        {s.name}
                        <span className="block text-xs text-muted-foreground">
                          {s.tools.length} tool{s.tools.length === 1 ? '' : 's'}
                          {!s.enabled && ' · disabled'}
                          {s.lastError && ' · last refresh failed'}
                        </span>
                      </span>
                    </label>
                    {attached && s.tools.length > 0 && (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-xs text-muted-foreground text-left">
                            <th className="font-normal py-1">Tool</th>
                            <th className="font-normal py-1 w-20 text-center">On</th>
                            <th className="font-normal py-1 w-36 text-center">Run without asking</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.tools.map((t) => {
                            const key = `${s.id}:${t.name}`;
                            const on = !agent.mcpDisabledTools.includes(key);
                            const auto = agent.mcpAutoApproveTools.includes(key);
                            return (
                              <tr key={key} className="border-t border-border/50" title={t.description}>
                                <td className="py-1.5 pr-2">
                                  <span className="font-mono text-xs">{t.name}</span>{' '}
                                  {t.destructive && <span className="text-[10px] uppercase text-red-500">destructive</span>}
                                </td>
                                <td className="text-center">
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4"
                                    checked={on}
                                    onChange={(e) => toggleKey('mcpDisabledTools', key, !e.target.checked)}
                                  />
                                </td>
                                <td className="text-center">
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4"
                                    checked={auto && !t.destructive}
                                    disabled={!on || t.destructive}
                                    title={t.destructive ? 'Destructive tools always ask for approval.' : undefined}
                                    onChange={(e) => toggleKey('mcpAutoApproveTools', key, e.target.checked)}
                                  />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })
            )}
            {mcpServers.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Only turn off approval for tools you are sure only read data: the server's own "read-only" label is not
                checked by Cerebro. <Link className="underline" to="/settings/mcp-servers">Manage MCP servers</Link>
              </p>
            )}
          </CardContent>
        </Card>

        {!isNew && agent.id && (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Test</CardTitle>
              <CardDescription>
                Chat with the saved version of this agent. Save your changes first; saving starts a new test conversation.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AgentChat
                key={`${agent.id}:${agent.updatedAt ?? ''}`}
                className="h-[28rem]"
                agentId={agent.id}
                disabled={!agent.ready}
                placeholder={agent.ready ? `Ask ${agent.name}…` : 'Enable the agent and set a model to test it'}
                emptyHint="Try a question this agent is meant to handle. Actions still ask for approval."
              />
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
