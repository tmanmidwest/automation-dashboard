import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, Trash2, RotateCcw, Puzzle, Bell, ShieldCheck, Lock, Eye, Copy, Check } from 'lucide-react';
import type { RevealSecretResult, SecretCategory, SecretHealth, SecretSummary, SecretUpsertInput } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

// Category display order + chrome. Defined locally (web imports only types from shared).
const CATEGORIES: { id: SecretCategory; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'connector', label: 'Connectors', icon: Puzzle },
  { id: 'notification', label: 'Notifications', icon: Bell },
  { id: 'api', label: 'API & Authentication', icon: ShieldCheck },
  { id: 'manual', label: 'Manual', icon: Lock },
];

const HEALTH: Record<SecretHealth, { label: string; cls: string }> = {
  ok: { label: 'OK', cls: 'bg-emerald-500/15 text-emerald-400' },
  due: { label: 'Rotate soon', cls: 'bg-amber-500/15 text-amber-400' },
  expired: { label: 'Expired', cls: 'bg-destructive/15 text-destructive' },
};

function relative(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** What the current user must supply to reveal a value (GET /api/secrets/reveal-requirements). */
interface RevealRequirements {
  password: boolean;
  totp: boolean;
  canReveal: boolean;
}

export function Secrets() {
  const { can } = useAuth();
  const canWrite = can('secrets:write');
  const canRead = can('secrets:read');

  const [secrets, setSecrets] = useState<SecretSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Reveal (step-up re-auth) dialog state. Nothing is cached: closing clears the
  // value and the entered credentials, so the next reveal re-authenticates.
  const [revealing, setRevealing] = useState<SecretSummary | null>(null);
  const [revealReq, setRevealReq] = useState<RevealRequirements | null>(null);
  const [revealForm, setRevealForm] = useState<{ password: string; totp: string }>({ password: '', totp: '' });
  const [revealValue, setRevealValue] = useState<string | null>(null);
  const [revealErr, setRevealErr] = useState<string | null>(null);
  const [revealBusy, setRevealBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Edit/rotate dialog state.
  const [editing, setEditing] = useState<SecretSummary | null>(null);
  const [form, setForm] = useState<SecretUpsertInput>({});
  const [busy, setBusy] = useState(false);

  // Create-new-secret dialog state.
  const [creating, setCreating] = useState(false);
  const [newSecret, setNewSecret] = useState<{ key: string; label: string; category: SecretCategory; value: string; kind: 'generic' | 'git'; gitHost: string; gitUsername: string }>({
    key: '', label: '', category: 'manual', value: '', kind: 'generic', gitHost: '', gitUsername: '',
  });

  async function load() {
    try {
      setSecrets(await api.get<SecretSummary[]>('/api/secrets'));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load secrets');
    }
  }
  useEffect(() => {
    load();
  }, []);

  function openEdit(s: SecretSummary) {
    setEditing(s);
    setForm({
      label: s.label,
      description: s.description ?? '',
      rotateAfterDays: s.rotateAfterDays ?? null,
      expiresAt: s.expiresAt ? s.expiresAt.slice(0, 10) : null,
      value: '',
    });
    setErr(null);
  }

  async function submitEdit() {
    if (!editing) return;
    setBusy(true);
    setErr(null);
    try {
      const body: SecretUpsertInput = {
        label: form.label?.trim() || editing.label,
        description: form.description?.toString().trim() || null,
        rotateAfterDays: form.rotateAfterDays ? Number(form.rotateAfterDays) : null,
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      };
      if (form.value && form.value.length > 0) body.value = form.value;
      await api.put(`/api/secrets/${encodeURIComponent(editing.key)}`, body);
      setEditing(null);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  }

  async function submitCreate() {
    const key = newSecret.key.trim();
    if (!key || !newSecret.value) return;
    setBusy(true);
    setErr(null);
    try {
      // Git credentials are stored as one JSON value {host, username, secret}, kind='git'.
      const value = newSecret.kind === 'git'
        ? JSON.stringify({ host: newSecret.gitHost.trim(), username: newSecret.gitUsername.trim(), secret: newSecret.value })
        : newSecret.value;
      await api.put(`/api/secrets/${encodeURIComponent(key)}`, {
        value,
        label: newSecret.label.trim() || key,
        kind: newSecret.kind,
        category: newSecret.category,
      });
      setCreating(false);
      setNewSecret({ key: '', label: '', category: 'manual', value: '', kind: 'generic', gitHost: '', gitUsername: '' });
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to create secret');
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: SecretSummary) {
    const warn =
      s.category === 'connector'
        ? 'A connector may still use this credential and stop working. '
        : '';
    if (!confirm(`Delete secret "${s.label}"? ${warn}This cannot be undone.`)) return;
    try {
      await api.delete(`/api/secrets/${encodeURIComponent(s.key)}`);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to delete');
    }
  }

  async function openReveal(s: SecretSummary) {
    setRevealing(s);
    setRevealForm({ password: '', totp: '' });
    setRevealValue(null);
    setRevealErr(null);
    setCopied(false);
    // Load which factors this account must supply (same for every secret).
    if (!revealReq) {
      try {
        setRevealReq(await api.get<RevealRequirements>('/api/secrets/reveal-requirements'));
      } catch {
        // Fall back to prompting for a password; the server still enforces the real rule.
        setRevealReq({ password: true, totp: false, canReveal: true });
      }
    }
  }

  function closeReveal() {
    setRevealing(null);
    // Wipe the plaintext + credentials from memory immediately.
    setRevealForm({ password: '', totp: '' });
    setRevealValue(null);
    setRevealErr(null);
  }

  async function submitReveal() {
    if (!revealing) return;
    setRevealBusy(true);
    setRevealErr(null);
    try {
      const res = await api.post<RevealSecretResult>(
        `/api/secrets/${encodeURIComponent(revealing.key)}/reveal`,
        { password: revealForm.password || undefined, totp: revealForm.totp || undefined },
      );
      setRevealValue(res.value);
    } catch (e) {
      setRevealErr(e instanceof ApiError ? e.message : 'Failed to reveal secret');
    } finally {
      setRevealBusy(false);
    }
  }

  async function copyValue() {
    if (revealValue == null) return;
    try {
      await navigator.clipboard.writeText(revealValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable (insecure context) — ignore */
    }
  }

  const revealReady =
    !!revealReq &&
    revealReq.canReveal &&
    (!revealReq.password || revealForm.password.length > 0) &&
    (!revealReq.totp || revealForm.totp.trim().length > 0);

  /** Pretty-print a Git credential's JSON value; show everything else verbatim. */
  function displayValue(s: SecretSummary, value: string): string {
    if (s.kind === 'git') {
      try {
        return JSON.stringify(JSON.parse(value), null, 2);
      } catch {
        /* not valid JSON after all — fall through */
      }
    }
    return value;
  }

  const grouped = (cat: SecretCategory) => (secrets ?? []).filter((s) => s.category === cat);

  return (
    <>
      <PageHeader
        title="Secrets Vault"
        description="Every stored credential, encrypted at rest. Revealing a value re-verifies your identity every time."
        actions={canWrite ? <Button onClick={() => { setNewSecret({ key: '', label: '', category: 'manual', value: '', kind: 'generic', gitHost: '', gitUsername: '' }); setErr(null); setCreating(true); }}>New secret</Button> : undefined}
      />

      {err && !editing && !creating && (
        <div className="mb-4 text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">
          {err}
        </div>
      )}

      {secrets && secrets.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            No secrets stored yet. They appear here as you configure connectors, email, and SSO.
          </CardContent>
        </Card>
      )}

      <div className="space-y-4">
        {CATEGORIES.map((c) => {
          const rows = grouped(c.id);
          if (rows.length === 0) return null;
          return (
            <Card key={c.id}>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <c.icon className="h-4 w-4 text-primary" />
                  {c.label}
                  <span className="text-xs font-normal text-muted-foreground">({rows.length})</span>
                </CardTitle>
                <CardDescription>Encrypted with AES-256-GCM. Rotating replaces the value in place.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="divide-y divide-border">
                  {rows.map((s) => (
                    <div key={s.key} className="flex items-center gap-4 py-3">
                      <div className="h-9 w-9 rounded-lg bg-muted grid place-items-center shrink-0">
                        <KeyRound className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-medium truncate">{s.label}</p>
                          <span className={cn('text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5', HEALTH[s.health].cls)}>
                            {HEALTH[s.health].label}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
                          {s.description ? `${s.description} · ` : ''}
                          <code>{s.key}</code>
                          {s.owningConnectorId && (
                            <>
                              {' · '}
                              <Link to={`/connectors/${s.owningConnectorId}`} className="text-accent hover:underline">
                                open connector
                              </Link>
                            </>
                          )}
                        </p>
                      </div>
                      <div className="text-right text-xs text-muted-foreground shrink-0 hidden sm:block">
                        <p>Rotated {s.ageDays === 0 ? 'today' : `${s.ageDays}d ago`}</p>
                        <p>{s.lastUsedAt ? `Used ${relative(s.lastUsedAt)}` : 'Never used'}</p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {canRead && (
                          <Button variant="ghost" size="icon" onClick={() => openReveal(s)} aria-label={`Reveal ${s.label}`}>
                            <Eye className="h-4 w-4" />
                          </Button>
                        )}
                        {canWrite && (
                          <>
                            <Button variant="ghost" size="icon" onClick={() => openEdit(s)} aria-label={`Rotate ${s.label}`}>
                              <RotateCcw className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" onClick={() => remove(s)} aria-label={`Delete ${s.label}`}>
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Reveal (step-up re-auth) dialog */}
      <Dialog
        open={!!revealing}
        onClose={closeReveal}
        title={revealing ? `Reveal ${revealing.label}` : ''}
        description={
          revealValue == null
            ? 'Confirm your identity to view this value. Re-authentication is required every time.'
            : 'This value is shown only now. Copy it if you need it, then close.'
        }
        footer={
          revealValue == null ? (
            <>
              <Button variant="outline" onClick={closeReveal}>Cancel</Button>
              <Button onClick={submitReveal} disabled={revealBusy || !revealReady}>
                {revealBusy ? 'Verifying…' : 'Reveal'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={copyValue}>
                {copied ? <><Check className="h-4 w-4 mr-1.5" /> Copied</> : <><Copy className="h-4 w-4 mr-1.5" /> Copy</>}
              </Button>
              <Button onClick={closeReveal}>Done</Button>
            </>
          )
        }
      >
        {revealErr && (
          <div className="mb-4 text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">
            {revealErr}
          </div>
        )}

        {revealValue == null ? (
          revealReq && !revealReq.canReveal ? (
            <div className="text-sm text-muted-foreground">
              This account can't reveal secrets because it has no way to re-authenticate. Set an account
              password or enable two-factor authentication, then try again.
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => { e.preventDefault(); if (revealReady && !revealBusy) submitReveal(); }}
            >
              <p className="text-xs text-muted-foreground">
                <code>{revealing?.key}</code>
              </p>
              {revealReq?.password && (
                <div>
                  <Label>Account password</Label>
                  <Input
                    type="password"
                    autoComplete="current-password"
                    autoFocus
                    placeholder="••••••••"
                    value={revealForm.password}
                    onChange={(e) => setRevealForm((f) => ({ ...f, password: e.target.value }))}
                  />
                </div>
              )}
              {revealReq?.totp && (
                <div>
                  <Label>Authenticator code</Label>
                  <Input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus={!revealReq.password}
                    placeholder="123456"
                    maxLength={6}
                    value={revealForm.totp}
                    onChange={(e) => setRevealForm((f) => ({ ...f, totp: e.target.value.replace(/\D/g, '') }))}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">The 6-digit code from your authenticator app.</p>
                </div>
              )}
              {/* Submit on Enter without a visible extra button. */}
              <button type="submit" className="hidden" aria-hidden />
            </form>
          )
        ) : (
          <div>
            <Label>Value</Label>
            <pre className="mt-1 max-h-60 overflow-auto rounded-md border border-input bg-muted/40 px-3 py-2 text-sm font-mono whitespace-pre-wrap break-all select-all">
              {revealing ? displayValue(revealing, revealValue) : revealValue}
            </pre>
          </div>
        )}
      </Dialog>

      {/* New secret dialog */}
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New secret"
        description="Create a shared credential you can reference from connectors (e.g. an SSH password used across hosts)."
        footer={
          <>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={submitCreate} disabled={busy || !newSecret.key.trim() || !newSecret.value}>
              {busy ? 'Saving…' : 'Create'}
            </Button>
          </>
        }
      >
        {err && (
          <div className="mb-4 text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">{err}</div>
        )}
        <div className="space-y-4">
          <div>
            <Label>Type</Label>
            <select
              value={newSecret.kind}
              onChange={(e) => setNewSecret((s) => ({ ...s, kind: e.target.value as 'generic' | 'git' }))}
              className="mt-1 w-full h-9 rounded-md border border-input bg-background/60 px-2 text-sm"
            >
              <option value="generic">Generic secret</option>
              <option value="git">Git credential</option>
            </select>
          </div>
          <div>
            <Label>Key</Label>
            <Input value={newSecret.key} placeholder={newSecret.kind === 'git' ? 'github-pat' : 'docker-ssh'}
              onChange={(e) => setNewSecret((s) => ({ ...s, key: e.target.value }))} />
            <p className="mt-1 text-xs text-muted-foreground">A unique id used to reference this secret. Cannot be changed later.</p>
          </div>
          <div>
            <Label>Label</Label>
            <Input value={newSecret.label} placeholder={newSecret.kind === 'git' ? 'GitHub deploy token' : 'Docker host SSH password'}
              onChange={(e) => setNewSecret((s) => ({ ...s, label: e.target.value }))} />
          </div>
          {newSecret.kind === 'git' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Host</Label>
                <Input value={newSecret.gitHost} placeholder="github.com"
                  onChange={(e) => setNewSecret((s) => ({ ...s, gitHost: e.target.value }))} />
              </div>
              <div>
                <Label>Username</Label>
                <Input value={newSecret.gitUsername} placeholder="x-access-token"
                  onChange={(e) => setNewSecret((s) => ({ ...s, gitUsername: e.target.value }))} />
              </div>
            </div>
          )}
          {newSecret.kind === 'generic' && (
            <div>
              <Label>Category</Label>
              <select
                value={newSecret.category}
                onChange={(e) => setNewSecret((s) => ({ ...s, category: e.target.value as SecretCategory }))}
                className="mt-1 w-full h-9 rounded-md border border-input bg-background/60 px-2 text-sm"
              >
                <option value="manual">Manual</option>
                <option value="connector">Connector</option>
                <option value="notification">Notification</option>
                <option value="api">API &amp; Auth</option>
              </select>
            </div>
          )}
          <div>
            <Label>{newSecret.kind === 'git' ? 'Token / Password' : 'Value'}</Label>
            <Input type="password" autoComplete="new-password" placeholder="••••••••" value={newSecret.value}
              onChange={(e) => setNewSecret((s) => ({ ...s, value: e.target.value }))} />
            <p className="mt-1 text-xs text-muted-foreground">
              {newSecret.kind === 'git' ? 'A personal-access-token or password. Stored encrypted with the host/username as one credential.' : 'Stored encrypted; never shown again after this.'}
            </p>
          </div>
        </div>
      </Dialog>

      {/* Edit / rotate dialog */}
      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing ? `Edit ${editing.label}` : ''}
        description="Change the metadata, set a rotation policy, or enter a new value to rotate the secret."
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={submitEdit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
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
            <Label>Label</Label>
            <Input value={form.label ?? ''} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
          </div>
          <div>
            <Label>Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input
              value={form.description?.toString() ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Rotate after (days)</Label>
              <Input
                type="number"
                min={1}
                placeholder="none"
                value={form.rotateAfterDays ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, rotateAfterDays: e.target.value ? Number(e.target.value) : null }))}
              />
            </div>
            <div>
              <Label>Expires on</Label>
              <Input
                type="date"
                value={form.expiresAt?.toString() ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value || null }))}
              />
            </div>
          </div>
          <div>
            <Label>New value <span className="text-muted-foreground font-normal">(leave blank to keep current)</span></Label>
            <Input
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              value={form.value ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              The current value is never displayed. Entering a new one replaces it and resets the rotation clock.
            </p>
          </div>
        </div>
      </Dialog>
    </>
  );
}
