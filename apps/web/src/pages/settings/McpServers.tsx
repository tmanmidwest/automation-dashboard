import { useEffect, useState } from 'react';
import { Plug, Plus, RefreshCw, Pencil, Trash2, AlertTriangle } from 'lucide-react';
import type { McpAuthType, McpServerView } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const selectCls = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm';

type Form = {
  id?: string;
  name: string;
  description: string;
  enabled: boolean;
  url: string;
  authType: McpAuthType;
  authHeader: string;
  credential: string;
  credentialSet: boolean;
};

const EMPTY: Form = { name: '', description: '', enabled: true, url: '', authType: 'bearer', authHeader: '', credential: '', credentialSet: false };

/**
 * Settings → MCP Servers: external MCP servers the Computer's agents can call. Refreshing a
 * server pins its current tool list; only pinned tools are offered, and every call needs the
 * operator's approval in chat.
 */
export function McpServers() {
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function load() {
    try {
      setServers(await api.get<McpServerView[]>('/api/assistant/mcp-servers'));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load MCP servers.');
    }
  }
  useEffect(() => { void load(); }, []);

  const replace = (v: McpServerView) =>
    setServers((list) => (list ? (list.some((s) => s.id === v.id) ? list.map((s) => (s.id === v.id ? v : s)) : [...list, v]) : [v]));

  async function refresh(id: string) {
    setRefreshing(id);
    try {
      replace(await api.post<McpServerView>(`/api/assistant/mcp-servers/${id}/refresh`));
      setExpanded(id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Refresh failed.');
    } finally {
      setRefreshing(null);
    }
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    setFormError(null);
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        description: form.description,
        enabled: form.enabled,
        url: form.url,
        authType: form.authType,
        authHeader: form.authType === 'header' ? form.authHeader : '',
      };
      if (form.credential) body.credential = form.credential;
      const saved = form.id
        ? await api.put<McpServerView>(`/api/assistant/mcp-servers/${form.id}`, body)
        : await api.post<McpServerView>('/api/assistant/mcp-servers', body);
      replace(saved);
      setForm(null);
      // A new server is useless until its tools are discovered, so do that right away.
      if (!form.id) void refresh(saved.id);
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(s: McpServerView) {
    const used = s.agents.length ? ` It will be removed from: ${s.agents.join(', ')}.` : '';
    if (!window.confirm(`Delete the MCP server "${s.name}"?${used}`)) return;
    try {
      await api.delete(`/api/assistant/mcp-servers/${s.id}`);
      setServers((list) => list?.filter((x) => x.id !== s.id) ?? null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to delete.');
    }
  }

  return (
    <>
      <PageHeader
        title="MCP Servers"
        description="External MCP servers your agents can use as tools. Refresh pins the server's tool list; every call still asks for approval in chat."
        actions={<Button onClick={() => { setForm(EMPTY); setFormError(null); }}><Plus className="h-4 w-4" /> Add server</Button>}
      />
      {error && <p className="text-sm text-red-500 mb-4">{error}</p>}
      {servers === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {servers?.length === 0 && (
        <p className="text-sm text-muted-foreground">No MCP servers yet. Add one, then attach it to an agent in Settings → Agents.</p>
      )}
      <div className="space-y-4">
        {servers?.map((s) => (
          <Card key={s.id}>
            <CardContent className="pt-6 space-y-3">
              <div className="flex flex-wrap items-start gap-4">
                <div className="h-10 w-10 rounded-lg bg-primary/15 text-primary grid place-items-center shrink-0">
                  <Plug className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    {s.name} {!s.enabled && <span className="text-xs font-normal text-amber-500">disabled</span>}
                  </p>
                  {s.description && <p className="text-sm text-muted-foreground">{s.description}</p>}
                  <p className="text-xs text-muted-foreground font-mono truncate">{s.url}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {s.tools.length} tool{s.tools.length === 1 ? '' : 's'} pinned
                    {s.toolsRefreshedAt && ` · refreshed ${new Date(s.toolsRefreshedAt).toLocaleString()}`}
                    {' · '}{s.agents.length ? `used by ${s.agents.join(', ')}` : 'not attached to any agent'}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => refresh(s.id)} disabled={refreshing === s.id} title="Connect and pin the current tool list">
                    <RefreshCw className={cn('h-4 w-4', refreshing === s.id && 'animate-spin')} /> Refresh tools
                  </Button>
                  <Button variant="outline" size="sm" title="Edit" onClick={() => {
                    setFormError(null);
                    setForm({
                      id: s.id, name: s.name, description: s.description ?? '', enabled: s.enabled, url: s.url,
                      authType: s.authType, authHeader: s.authHeader ?? '', credential: '', credentialSet: s.credentialSet,
                    });
                  }}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" size="sm" title="Delete" onClick={() => remove(s)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {s.lastError && (
                <p className="text-sm text-red-500 flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> {s.lastError}
                </p>
              )}
              {s.tools.length > 0 && (
                <div>
                  <button type="button" className="text-xs underline text-muted-foreground"
                    onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                    {expanded === s.id ? 'Hide tools' : 'Show tools'}
                  </button>
                  {expanded === s.id && (
                    <ul className="mt-2 grid gap-2 md:grid-cols-2">
                      {s.tools.map((t) => (
                        <li key={t.name} className="rounded-md border border-input p-2 text-sm">
                          <span className="font-mono text-xs">{t.name}</span>{' '}
                          <span className={cn('text-[10px] uppercase', t.destructive ? 'text-red-500' : t.readOnly ? 'text-muted-foreground' : 'text-amber-500')}>
                            {t.destructive ? 'destructive' : t.readOnly ? 'says read-only' : 'action'}
                          </span>
                          {t.description && <span className="block text-xs text-muted-foreground line-clamp-3">{t.description}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog
        open={!!form}
        onClose={() => { if (!saving) setForm(null); }}
        title={form?.id ? 'Edit MCP server' : 'Add MCP server'}
        description="Streamable HTTP servers only. The credential is stored encrypted in the Secrets Vault."
        footer={
          <>
            <Button variant="outline" onClick={() => setForm(null)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{form?.id ? 'Save' : 'Add and discover tools'}</Button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. GitHub" />
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Optional" />
            </div>
            <div className="space-y-1.5">
              <Label>URL</Label>
              <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://mcp.example.com/mcp" />
            </div>
            <div className="space-y-1.5">
              <Label>Authentication</Label>
              <select className={selectCls} value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value as McpAuthType })}>
                <option value="bearer">Bearer token (Authorization header)</option>
                <option value="header">API key in a custom header</option>
                <option value="none">None</option>
              </select>
            </div>
            {form.authType === 'header' && (
              <div className="space-y-1.5">
                <Label>Header name</Label>
                <Input value={form.authHeader} onChange={(e) => setForm({ ...form, authHeader: e.target.value })} placeholder="X-API-Key" />
              </div>
            )}
            {form.authType !== 'none' && (
              <div className="space-y-1.5">
                <Label>
                  {form.authType === 'bearer' ? 'Token' : 'API key'}{' '}
                  {form.credentialSet && <span className="text-xs text-emerald-500">(set, leave blank to keep)</span>}
                </Label>
                <Input type="password" value={form.credential} onChange={(e) => setForm({ ...form, credential: e.target.value })}
                  placeholder={form.credentialSet ? '••••••••' : ''} />
                <p className="text-xs text-muted-foreground">
                  Every agent this server is attached to acts with this credential, whoever is chatting. Give it the narrowest scope that works.
                </p>
              </div>
            )}
            <label className="flex items-center gap-3 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
              Enabled
            </label>
            {formError && <p className="text-sm text-red-500">{formError}</p>}
          </div>
        )}
      </Dialog>
    </>
  );
}
