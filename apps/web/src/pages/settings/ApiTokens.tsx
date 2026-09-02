import { useEffect, useMemo, useState } from 'react';
import { Copy, Check, Trash2, KeyRound } from 'lucide-react';
import type { ApiTokenCreated, ApiTokenSummary, Permission } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';

/** Scopes offerable to a token, with friendly labels. Filtered to what the user holds. */
const SCOPES: { scope: Permission; label: string; desc: string; write?: boolean }[] = [
  { scope: 'connectors:read', label: 'Connectors', desc: 'Read connector instances and their resources.' },
  { scope: 'monitors:read', label: 'Monitors', desc: 'Read uptime monitors and their status.' },
  { scope: 'logs:read', label: 'Logs', desc: 'Read application logs.' },
  { scope: 'audit:read', label: 'Audit trail', desc: 'Read the audit log.' },
  { scope: 'users:read', label: 'Users', desc: 'Read user accounts.' },
  { scope: 'settings:read', label: 'Settings', desc: 'Read application settings.' },
  { scope: 'connectors:action', label: 'Connector actions', desc: 'Start/stop/reboot resources and run operations.', write: true },
  { scope: 'monitors:write', label: 'Monitor management', desc: 'Pause, resume, and trigger monitors.', write: true },
];

function relative(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function ApiTokens() {
  const { can } = useAuth();
  const available = useMemo(() => SCOPES.filter((s) => can(s.scope)), [can]);

  const [tokens, setTokens] = useState<ApiTokenSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Create dialog state.
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<Permission>>(new Set());
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);

  // Reveal-once state.
  const [revealed, setRevealed] = useState<ApiTokenCreated | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      setTokens(await api.get<ApiTokenSummary[]>('/api/tokens'));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load tokens');
    }
  }
  useEffect(() => { load(); }, []);

  function openCreate() {
    setName('');
    setScopes(new Set());
    setExpiresAt('');
    setErr(null);
    setCreating(true);
  }

  function toggleScope(s: Permission) {
    setScopes((prev) => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });
  }

  async function submitCreate() {
    setBusy(true);
    setErr(null);
    try {
      const created = await api.post<ApiTokenCreated>('/api/tokens', {
        name: name.trim(),
        scopes: [...scopes],
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
      setCreating(false);
      setRevealed(created);
      setCopied(false);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to create token');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(t: ApiTokenSummary) {
    if (!confirm(`Revoke "${t.name}"? Any client using it will immediately lose access.`)) return;
    try {
      await api.delete(`/api/tokens/${t.id}`);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to revoke token');
    }
  }

  async function copySecret() {
    if (!revealed) return;
    await navigator.clipboard.writeText(revealed.secret);
    setCopied(true);
  }

  return (
    <>
      <PageHeader
        title="API Tokens"
        description="Bearer tokens for programmatic access to the Cerebro API and MCP server."
      />

      {err && !creating && (
        <div className="mb-4 text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">
          {err}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">Your tokens</CardTitle>
            <CardDescription>Read-only access, scoped to permissions you already hold.</CardDescription>
          </div>
          <Button onClick={openCreate} disabled={available.length === 0}>Create token</Button>
        </CardHeader>
        <CardContent>
          {available.length === 0 && (
            <p className="text-sm text-muted-foreground">You have no read permissions to grant a token.</p>
          )}
          {tokens && tokens.length === 0 && available.length > 0 && (
            <p className="text-sm text-muted-foreground">No tokens yet. Create one to query Cerebro programmatically.</p>
          )}
          {tokens && tokens.length > 0 && (
            <div className="divide-y divide-border">
              {tokens.map((t) => (
                <div key={t.id} className="flex items-center gap-4 py-3">
                  <div className="h-9 w-9 rounded-lg bg-primary/15 text-primary grid place-items-center shrink-0">
                    <KeyRound className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{t.name}</p>
                    <p className="text-xs text-muted-foreground">
                      <code>cbro_{t.prefix}…</code> · {t.scopes.join(', ')}
                    </p>
                  </div>
                  <div className="text-right text-xs text-muted-foreground shrink-0 hidden sm:block">
                    <p>Used {relative(t.lastUsedAt)}</p>
                    <p>{t.expiresAt ? `Expires ${new Date(t.expiresAt).toLocaleDateString()}` : 'No expiry'}</p>
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => revoke(t)} aria-label={`Revoke ${t.name}`}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Create API token"
        description="Pick a name and the read scopes this token may access."
        footer={
          <>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={submitCreate} disabled={busy || !name.trim() || scopes.size === 0}>
              {busy ? 'Creating…' : 'Create token'}
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
            <Label>Scopes</Label>
            <div className="space-y-2 mt-1">
              {available.map((s) => (
                <label key={s.scope} className={`flex items-start gap-3 cursor-pointer rounded-md border p-3 ${
                  s.write ? 'border-amber-500/40 bg-amber-500/5 hover:bg-amber-500/10' : 'border-border hover:bg-muted/50'}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]"
                    checked={scopes.has(s.scope)}
                    onChange={() => toggleScope(s.scope)}
                  />
                  <span>
                    <span className="text-sm font-medium">
                      {s.label}
                      {s.write && <span className="ml-2 text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-amber-500/20 text-amber-500">write</span>}
                    </span>
                    <span className="block text-xs text-muted-foreground">{s.desc}</span>
                  </span>
                </label>
              ))}
            </div>
            {[...scopes].some((sc) => SCOPES.find((x) => x.scope === sc)?.write) && (
              <p className="mt-2 text-xs text-amber-500">
                This token will be able to change infrastructure (start/stop resources, run operations, manage monitors). Store it carefully.
              </p>
            )}
          </div>
          <div>
            <Label>Expiry <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
        </div>
      </Dialog>

      {/* Reveal-once dialog */}
      <Dialog
        open={!!revealed}
        onClose={() => setRevealed(null)}
        title="Copy your token now"
        description="This is the only time the full token is shown. Store it somewhere safe."
        footer={<Button onClick={() => setRevealed(null)}>Done</Button>}
      >
        {revealed && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 break-all rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
                {revealed.secret}
              </code>
              <Button variant="secondary" size="icon" onClick={copySecret} aria-label="Copy token">
                {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Use it as <code>Authorization: Bearer &lt;token&gt;</code>. Scopes: {revealed.token.scopes.join(', ')}.
            </p>
          </div>
        )}
      </Dialog>
    </>
  );
}
