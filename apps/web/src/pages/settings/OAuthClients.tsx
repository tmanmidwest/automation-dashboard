import { useEffect, useState } from 'react';
import { Copy, Check, Trash2, Boxes, Power, ShieldOff, KeyRound, Server } from 'lucide-react';
import type { OAuthClientCreated, OAuthClientSummary, OAuthGrantSummary } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';

const BASE = '/api/settings/oauth/clients';

type ClientType = OAuthClientSummary['type'];

const TYPE_HELP: Record<ClientType, string> = {
  public: 'PKCE, no secret — for desktop/CLI MCP clients.',
  confidential: 'Has a secret — for server-side clients that sign in as a user.',
  machine: 'Client credentials, no user — read-only access to the agent catalog (/api/v1/agents), e.g. a Saviynt REST connector.',
};

const linesOf = (text: string) => text.split('\n').map((s) => s.trim()).filter(Boolean);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

export function OAuthClients() {
  const { can } = useAuth();
  const writable = can('settings:write');

  const [clients, setClients] = useState<OAuthClientSummary[] | null>(null);
  const [grants, setGrants] = useState<OAuthGrantSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Create dialog.
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [redirects, setRedirects] = useState('');
  const [type, setType] = useState<ClientType>('public');
  const [ipAllowlist, setIpAllowlist] = useState('');
  const [busy, setBusy] = useState(false);

  // Reveal-once (created client).
  const [revealed, setRevealed] = useState<(OAuthClientCreated & { rotated?: boolean }) | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function load() {
    try {
      setClients(await api.get<OAuthClientSummary[]>(BASE));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load clients');
    }
  }
  async function loadGrants() {
    try {
      setGrants(await api.get<OAuthGrantSummary[]>('/api/oauth/grants'));
    } catch { /* non-fatal */ }
  }
  useEffect(() => { load(); loadGrants(); }, []);

  async function revokeGrant(g: OAuthGrantSummary) {
    if (!confirm(`Revoke your authorization for "${g.clientName}"? Its active sessions will stop working.`)) return;
    try {
      await api.delete(`/api/oauth/grants/${encodeURIComponent(g.clientId)}`);
      await loadGrants();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to revoke authorization');
    }
  }

  function openCreate() {
    setName('');
    setRedirects('');
    setType('public');
    setIpAllowlist('');
    setErr(null);
    setCreating(true);
  }

  async function submitCreate() {
    setBusy(true);
    setErr(null);
    try {
      const body = type === 'machine'
        ? { name: name.trim(), type, ipAllowlist: linesOf(ipAllowlist) }
        : { name: name.trim(), type, redirectUris: linesOf(redirects) };
      const created = await api.post<OAuthClientCreated>(BASE, body);
      setCreating(false);
      setRevealed(created);
      setCopied(null);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to create client');
    } finally {
      setBusy(false);
    }
  }

  async function toggleDisabled(c: OAuthClientSummary) {
    try {
      await api.patch(`${BASE}/${c.id}`, { disabled: !c.disabled });
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to update client');
    }
  }

  async function rotate(c: OAuthClientSummary) {
    if (!confirm(`Issue a new secret for "${c.name}"? The current secret stops working right away; tokens already issued run out within 15 minutes.`)) return;
    try {
      const rotated = await api.post<OAuthClientCreated>(`${BASE}/${c.id}/rotate-secret`);
      setRevealed({ ...rotated, rotated: true });
      setCopied(null);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to rotate the secret');
    }
  }

  async function remove(c: OAuthClientSummary) {
    if (!confirm(`Delete "${c.name}"? Any client using it will immediately lose access.`)) return;
    try {
      await api.delete(`${BASE}/${c.id}`);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to delete client');
    }
  }

  async function copy(text: string, which: string) {
    await navigator.clipboard.writeText(text);
    setCopied(which);
  }

  return (
    <>
      <PageHeader
        title="OAuth Clients"
        description="Register MCP/API clients that connect via the OAuth flow instead of a static token."
      />

      {err && !creating && (
        <div className="mb-4 text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">
          {err}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">Registered clients</CardTitle>
            <CardDescription>Admin-registered — clients cannot self-register. Loopback redirect URIs match any port.</CardDescription>
          </div>
          {writable && <Button onClick={openCreate}>Register client</Button>}
        </CardHeader>
        <CardContent>
          {clients && clients.length === 0 && (
            <p className="text-sm text-muted-foreground">No clients yet.</p>
          )}
          {clients && clients.length > 0 && (
            <div className="divide-y divide-border">
              {clients.map((c) => (
                <div key={c.id} className="flex items-center gap-4 py-3">
                  <div className="h-9 w-9 rounded-lg bg-primary/15 text-primary grid place-items-center shrink-0">
                    {c.type === 'machine' ? <Server className="h-4 w-4" /> : <Boxes className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">
                      {c.name}
                      {c.disabled && <span className="ml-2 text-xs text-muted-foreground">(disabled)</span>}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      <code>{c.clientId}</code> · {c.type}{c.clientSecretSet ? ' · secret set' : ''}
                    </p>
                    {c.type === 'machine' && (
                      <p className="text-xs text-muted-foreground truncate">
                        Scopes {c.allowedScopes.join(', ') || 'none'} · IPs {c.ipAllowlist.length ? c.ipAllowlist.join(', ') : 'any'} ·
                        last used {when(c.lastUsedAt)}{c.secretRotatedAt ? ` · secret rotated ${when(c.secretRotatedAt)}` : ''}
                      </p>
                    )}
                  </div>
                  {writable && (
                    <>
                      {c.type !== 'public' && (
                        <Button variant="ghost" size="icon" onClick={() => rotate(c)} aria-label={`Rotate secret for ${c.name}`} title="Rotate secret">
                          <KeyRound className="h-4 w-4" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" onClick={() => toggleDisabled(c)} aria-label={c.disabled ? `Enable ${c.name}` : `Disable ${c.name}`}>
                        <Power className={`h-4 w-4 ${c.disabled ? 'text-muted-foreground' : 'text-emerald-400'}`} />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => remove(c)} aria-label={`Delete ${c.name}`}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {grants && grants.length > 0 && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-base">Authorized applications</CardTitle>
            <CardDescription>Apps you have granted access to your account. Revoking stops their active sessions.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border">
              {grants.map((g) => (
                <div key={g.clientId} className="flex items-center gap-4 py-3">
                  <div className="h-9 w-9 rounded-lg bg-primary/15 text-primary grid place-items-center shrink-0">
                    <ShieldOff className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{g.clientName}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {g.scopes.join(', ')} · {g.activeTokenCount} active session{g.activeTokenCount === 1 ? '' : 's'}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => revokeGrant(g)}>Revoke</Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Create dialog */}
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Register OAuth client"
        description="Public clients use PKCE and need no secret; confidential and machine clients get a secret shown once."
        footer={
          <>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={submitCreate} disabled={busy || !name.trim() || (type !== 'machine' && !redirects.trim())}>
              {busy ? 'Registering…' : 'Register'}
            </Button>
          </>
        }
      >
        {err && (
          <div className="mb-4 text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">
            {err}
          </div>
        )}
        <div className="space-y-4">
          <div>
            <Label>Name</Label>
            <Input value={name} placeholder="Claude Desktop" onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>Client type</Label>
            <div className="mt-1 space-y-2">
              {(['public', 'confidential', 'machine'] as const).map((t) => (
                <label key={t} className="flex items-start gap-3 cursor-pointer rounded-md border border-border p-3 hover:bg-muted/50">
                  <input type="radio" name="ctype" className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]"
                    checked={type === t} onChange={() => setType(t)} />
                  <span>
                    <span className="text-sm font-medium capitalize">{t}</span>
                    <span className="block text-xs text-muted-foreground">
                      {TYPE_HELP[t]}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          {type === 'machine' ? (
            <div>
              <Label>Allowed IP addresses <span className="text-muted-foreground font-normal">(one IP or CIDR per line; blank allows any)</span></Label>
              <textarea
                value={ipAllowlist}
                onChange={(e) => setIpAllowlist(e.target.value)}
                rows={3}
                placeholder={'203.0.113.10\n198.51.100.0/24'}
                className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Scope is fixed to <code>agents:read</code>. Tokens last 15 minutes and only work on <code>/api/v1/agents</code>.
              </p>
            </div>
          ) : (
            <div>
              <Label>Redirect URIs <span className="text-muted-foreground font-normal">(one per line)</span></Label>
              <textarea
                value={redirects}
                onChange={(e) => setRedirects(e.target.value)}
                rows={3}
                placeholder={'http://localhost/callback\nhttps://client.example.com/callback'}
                className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
          )}
        </div>
      </Dialog>

      {/* Reveal-once dialog */}
      <Dialog
        open={!!revealed}
        onClose={() => setRevealed(null)}
        title={revealed?.rotated ? 'New secret issued' : 'Client registered'}
        description={revealed?.clientSecret ? 'Copy the secret now — it is shown only once.' : 'Configure your client with this client ID.'}
        footer={<Button onClick={() => setRevealed(null)}>Done</Button>}
      >
        {revealed && (
          <div className="space-y-3">
            <div>
              <Label>Client ID</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 break-all rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">{revealed.client.clientId}</code>
                <Button variant="secondary" size="icon" onClick={() => copy(revealed.client.clientId, 'id')} aria-label="Copy client ID">
                  {copied === 'id' ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            {revealed.clientSecret && (
              <div>
                <Label>Client secret</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 break-all rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">{revealed.clientSecret}</code>
                  <Button variant="secondary" size="icon" onClick={() => copy(revealed.clientSecret!, 'secret')} aria-label="Copy client secret">
                    {copied === 'secret' ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            )}
            {revealed.client.type === 'machine' && (
              <div className="text-xs text-muted-foreground space-y-1">
                <p>
                  Token URL: <code>{window.location.origin}/oauth/token</code> with <code>grant_type=client_credentials</code> and
                  scope <code>agents:read</code> (client ID and secret as HTTP Basic or form fields).
                </p>
                <p>Then call <code>GET {window.location.origin}/api/v1/agents</code> with <code>Authorization: Bearer &lt;token&gt;</code>.</p>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
