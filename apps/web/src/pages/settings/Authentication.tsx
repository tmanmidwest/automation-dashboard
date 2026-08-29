import { useEffect, useState } from 'react';
import { Copy, Check, Plus, Pencil, Trash2, PlugZap } from 'lucide-react';
import type { IdentityProviderConfig } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { ProviderIcon } from '@/components/ProviderIcon';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Role { slug: string; name: string }

interface FormState {
  label: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  buttonLabel: string;
  icon: string;
  scopes: string;
  enabled: boolean;
  autoCreateUsers: boolean;
  defaultRoleSlug: string;
  allowedDomains: string;
}

const PRESETS: { key: string; label: string; apply: Partial<FormState> }[] = [
  { key: 'google', label: 'Google', apply: { icon: 'google', issuer: 'https://accounts.google.com', buttonLabel: 'Continue with Google' } },
  { key: 'microsoft', label: 'Microsoft Entra', apply: { icon: 'microsoft', issuer: 'https://login.microsoftonline.com/<tenant-id>/v2.0', buttonLabel: 'Sign in with Microsoft' } },
  { key: 'authentik', label: 'Authentik', apply: { icon: 'authentik', issuer: 'https://authentik.example.com/application/o/cerebro/', buttonLabel: 'Sign in with Authentik' } },
  { key: 'generic', label: 'Generic OIDC', apply: { icon: 'generic', issuer: '', buttonLabel: 'Sign in with SSO' } },
];

const EMPTY: FormState = {
  label: '', issuer: '', clientId: '', clientSecret: '', buttonLabel: 'Sign in with SSO',
  icon: 'generic', scopes: 'openid email profile', enabled: true,
  autoCreateUsers: false, defaultRoleSlug: 'viewer', allowedDomains: '',
};

export function Authentication() {
  const { can } = useAuth();
  const writable = can('settings:write');
  const [providers, setProviders] = useState<IdentityProviderConfig[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [editing, setEditing] = useState<IdentityProviderConfig | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function load() {
    setProviders(await api.get<IdentityProviderConfig[]>('/api/settings/auth/providers'));
    setRoles(await api.get<Role[]>('/api/roles'));
  }
  useEffect(() => { void load(); }, []);

  function openNew() {
    setForm(EMPTY);
    setEditing('new');
    setMsg(null);
  }
  function openEdit(p: IdentityProviderConfig) {
    setForm({
      label: p.label, issuer: p.issuer, clientId: p.clientId, clientSecret: '',
      buttonLabel: p.buttonLabel, icon: p.icon, scopes: p.scopes, enabled: p.enabled,
      autoCreateUsers: p.autoCreateUsers, defaultRoleSlug: p.defaultRoleSlug,
      allowedDomains: p.allowedDomains.join(', '),
    });
    setEditing(p);
    setMsg(null);
  }
  function applyPreset(key: string) {
    const preset = PRESETS.find((p) => p.key === key);
    if (!preset) return;
    setForm((f) => ({ ...f, ...preset.apply, label: f.label || preset.label }));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const body = {
      label: form.label, issuer: form.issuer, clientId: form.clientId,
      clientSecret: form.clientSecret || undefined, buttonLabel: form.buttonLabel,
      icon: form.icon, scopes: form.scopes, enabled: form.enabled,
      autoCreateUsers: form.autoCreateUsers, defaultRoleSlug: form.defaultRoleSlug,
      allowedDomains: form.allowedDomains.split(',').map((d) => d.trim()).filter(Boolean),
    };
    try {
      if (editing === 'new') await api.post('/api/settings/auth/providers', body);
      else if (editing) await api.put(`/api/settings/auth/providers/${editing.id}`, body);
      setEditing(null);
      await load();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Save failed' });
    }
  }

  async function toggle(p: IdentityProviderConfig) {
    await api.patch(`/api/settings/auth/providers/${p.id}/enabled`, { enabled: !p.enabled });
    await load();
  }
  async function remove(p: IdentityProviderConfig) {
    if (!confirm(`Delete provider "${p.label}"? Users linked only to it will lose SSO access.`)) return;
    try {
      await api.delete(`/api/settings/auth/providers/${p.id}`);
      await load();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Delete failed' });
    }
  }
  async function test(p: IdentityProviderConfig) {
    setMsg(null);
    try {
      const res = await api.post<{ ok: boolean; message: string }>(`/api/settings/auth/providers/${p.id}/test`);
      setMsg({ ok: res.ok, text: `${p.label}: ${res.message}` });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Test failed' });
    }
  }

  function copyUri(uri: string) {
    navigator.clipboard.writeText(uri);
    setCopied(uri);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <>
      <PageHeader
        title="Authentication"
        description="Local accounts are always available. Add one or more single sign-on providers."
        actions={writable && editing === null && (
          <Button onClick={openNew}><Plus className="h-4 w-4" /> Add provider</Button>
        )}
      />

      {msg && (
        <div className={`mb-4 text-sm rounded-md px-3 py-2 border ${
          msg.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                 : 'border-destructive/40 bg-destructive/10 text-destructive'}`}>
          {msg.text}
        </div>
      )}

      {editing !== null && (
        <Card className="mb-6 border-primary/40">
          <CardHeader>
            <CardTitle className="text-base">{editing === 'new' ? 'Add SSO provider' : `Edit ${editing.label}`}</CardTitle>
            <CardDescription>OpenID Connect. Works with Google, Entra, Authentik, Keycloak, Okta, Auth0.</CardDescription>
          </CardHeader>
          <CardContent>
            {editing === 'new' && (
              <div className="mb-5">
                <Label>Start from a template</Label>
                <div className="flex flex-wrap gap-2">
                  {PRESETS.map((p) => (
                    <button key={p.key} type="button" onClick={() => applyPreset(p.key)}
                      className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted transition-colors">
                      <ProviderIcon icon={p.apply.icon || 'generic'} /> {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {editing !== 'new' && (
              <div className="mb-5 rounded-md bg-muted/50 border border-border p-3">
                <Label className="mb-1">Redirect URI (register this at the provider)</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs bg-background rounded px-2 py-1.5 break-all">{editing.redirectUri}</code>
                  <Button type="button" variant="outline" size="icon" onClick={() => copyUri(editing.redirectUri)}>
                    {copied === editing.redirectUri ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            )}

            <form onSubmit={save} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label>Display label</Label>
                  <Input value={form.label} disabled={!writable} required
                    onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Company Google" />
                </div>
                <div>
                  <Label>Sign-in button text</Label>
                  <Input value={form.buttonLabel} disabled={!writable}
                    onChange={(e) => setForm({ ...form, buttonLabel: e.target.value })} />
                </div>
              </div>
              <div>
                <Label>Issuer URL</Label>
                <Input value={form.issuer} disabled={!writable} required
                  onChange={(e) => setForm({ ...form, issuer: e.target.value })}
                  placeholder="https://accounts.google.com" />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label>Client ID</Label>
                  <Input value={form.clientId} disabled={!writable} required
                    onChange={(e) => setForm({ ...form, clientId: e.target.value })} />
                </div>
                <div>
                  <Label>Client secret {editing !== 'new' && editing.clientSecretSet &&
                    <span className="text-muted-foreground font-normal">(saved — blank keeps)</span>}</Label>
                  <Input type="password" value={form.clientSecret} disabled={!writable}
                    placeholder={editing !== 'new' && editing.clientSecretSet ? '••••••••' : ''}
                    onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} />
                </div>
              </div>

              <div className="rounded-md border border-border p-4 space-y-4">
                <p className="text-sm font-medium">Provisioning</p>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]"
                    checked={form.autoCreateUsers} disabled={!writable}
                    onChange={(e) => setForm({ ...form, autoCreateUsers: e.target.checked })} />
                  <span className="text-sm">Auto-create accounts on first sign-in</span>
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label>Default role for new users</Label>
                    <select className="flex h-10 w-full rounded-md border border-input bg-background/60 px-3 text-sm"
                      value={form.defaultRoleSlug} disabled={!writable || !form.autoCreateUsers}
                      onChange={(e) => setForm({ ...form, defaultRoleSlug: e.target.value })}>
                      {roles.map((r) => <option key={r.slug} value={r.slug}>{r.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <Label>Allowed email domains <span className="text-muted-foreground font-normal">(optional, comma-separated)</span></Label>
                    <Input value={form.allowedDomains} disabled={!writable}
                      onChange={(e) => setForm({ ...form, allowedDomains: e.target.value })}
                      placeholder="example.com, corp.example.com" />
                  </div>
                </div>
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]"
                  checked={form.enabled} disabled={!writable}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
                <span className="text-sm font-medium">Enabled (show on the login screen)</span>
              </label>

              {writable && (
                <div className="flex gap-2">
                  <Button type="submit">{editing === 'new' ? 'Create provider' : 'Save changes'}</Button>
                  <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                </div>
              )}
            </form>
          </CardContent>
        </Card>
      )}

      {providers.length === 0 && editing === null ? (
        <Card>
          <CardContent className="pt-10 pb-10 text-center">
            <p className="font-medium">No SSO providers yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Add Google, Microsoft Entra, Authentik, or any OpenID Connect provider. Local sign-in stays available.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {providers.map((p) => (
            <Card key={p.id}>
              <CardContent className="pt-4 pb-4 flex items-center gap-4">
                <div className="h-10 w-10 rounded-lg bg-muted grid place-items-center shrink-0">
                  <ProviderIcon icon={p.icon} className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium truncate">{p.label}</p>
                    {p.enabled
                      ? <span className="text-xs rounded-full bg-emerald-500/15 text-emerald-400 px-2 py-0.5">Enabled</span>
                      : <span className="text-xs rounded-full bg-muted text-muted-foreground px-2 py-0.5">Disabled</span>}
                    {p.autoCreateUsers && <span className="text-xs rounded-full bg-secondary/25 text-secondary-foreground px-2 py-0.5">Auto-provision</span>}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">{p.issuer}</p>
                </div>
                {writable && (
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="sm" onClick={() => test(p)} title="Test discovery"><PlugZap className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="sm" onClick={() => toggle(p)}>{p.enabled ? 'Disable' : 'Enable'}</Button>
                    <Button variant="ghost" size="icon" onClick={() => openEdit(p)}><Pencil className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" onClick={() => remove(p)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
