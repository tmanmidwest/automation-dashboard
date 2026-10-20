import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Save, PlugZap } from 'lucide-react';
import type { ZumaAuthMode, ZumaConnectionView } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

const selectCls = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm';

/**
 * Settings → Saviynt Zuma: the tenant connection Cerebro uses to register its agents in the
 * Zuma agent registry. The client secret (or token) is stored in the Secrets Vault.
 */
export function ZumaSettings() {
  const [cfg, setCfg] = useState<ZumaConnectionView | null>(null);
  const [credential, setCredential] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.get<ZumaConnectionView>('/api/assistant/zuma/connection')
      .then(setCfg)
      .catch((e) => setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to load the connection.' }));
  }, []);

  const set = <K extends keyof ZumaConnectionView>(key: K, value: ZumaConnectionView[K]) =>
    setCfg((c) => (c ? { ...c, [key]: value } : c));

  async function save(): Promise<boolean> {
    if (!cfg) return false;
    setBusy('save');
    setMsg(null);
    try {
      const body: Record<string, unknown> = {
        enabled: cfg.enabled,
        baseUrl: cfg.baseUrl,
        tenantId: cfg.tenantId,
        authMode: cfg.authMode,
        tokenUrl: cfg.tokenUrl,
        clientId: cfg.clientId,
        scope: cfg.scope,
        publicUrl: cfg.publicUrl,
      };
      if (credential) body.credential = credential;
      setCfg(await api.put<ZumaConnectionView>('/api/assistant/zuma/connection', body));
      setCredential('');
      setMsg({ ok: true, text: 'Saved.' });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to save.' });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    if (!(await save())) return;
    setBusy('test');
    try {
      const res = await api.post<{ ok: true; agentCount: number | null }>('/api/assistant/zuma/connection/test');
      setMsg({
        ok: true,
        text: `Connected. ${res.agentCount === null ? '' : `The tenant has ${res.agentCount} registered agent${res.agentCount === 1 ? '' : 's'}.`}`.trim(),
      });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Connection test failed.' });
    } finally {
      setBusy(null);
    }
  }

  if (!cfg) {
    return (
      <>
        <PageHeader title="Saviynt Zuma" />
        {msg ? <p className="text-sm text-red-500">{msg.text}</p> : <p className="text-sm text-muted-foreground">Loading…</p>}
      </>
    );
  }

  const cc = cfg.authMode === 'client_credentials';
  return (
    <>
      <PageHeader
        title="Saviynt Zuma"
        description="Register your agents in Saviynt's AI agent registry. Cerebro calls Zuma; Zuma assigns each agent its ID."
        actions={
          <>
            <Button variant="outline" onClick={test} disabled={!!busy}>
              <PlugZap className={cn('h-4 w-4', busy === 'test' && 'animate-pulse')} /> Save and test
            </Button>
            <Button onClick={save} disabled={!!busy}>
              <Save className="h-4 w-4" /> Save
            </Button>
          </>
        }
      />
      {msg && <p className={cn('text-sm mb-4', msg.ok ? 'text-emerald-500' : 'text-red-500')}>{msg.text}</p>}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Tenant</CardTitle>
            <CardDescription>Where your Zuma agent registry lives.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-center gap-3 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={cfg.enabled} onChange={(e) => set('enabled', e.target.checked)} />
              Enabled
            </label>
            <div className="space-y-1.5">
              <Label>Zuma URL</Label>
              <Input value={cfg.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://identisphere-dev.saviyntqa.com" />
              <p className="text-xs text-muted-foreground">Without the path; Cerebro adds /agent/v2/registry/agents.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Tenant ID</Label>
              <Input value={cfg.tenantId} onChange={(e) => set('tenantId', e.target.value)} placeholder="Sent as X-Tenant-Id" />
            </div>
            <div className="space-y-1.5">
              <Label>Cerebro public URL</Label>
              <Input value={cfg.publicUrl} onChange={(e) => set('publicUrl', e.target.value)}
                placeholder={cfg.effectivePublicUrl && !cfg.publicUrl ? `${cfg.effectivePublicUrl} (from APP_URL)` : 'https://cerebro.example.com'} />
              <p className="text-xs text-muted-foreground">
                Each agent is registered with a link back to its page here. Blank uses APP_URL.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Authentication</CardTitle>
            <CardDescription>Zuma takes a Cognito JWT as a bearer token.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>How Cerebro gets the token</Label>
              <select className={selectCls} value={cfg.authMode} onChange={(e) => set('authMode', e.target.value as ZumaAuthMode)}>
                <option value="client_credentials">OAuth client credentials (refreshed automatically)</option>
                <option value="token">Paste a token (replace it when it expires)</option>
              </select>
            </div>
            {cc && (
              <>
                <div className="space-y-1.5">
                  <Label>Token URL</Label>
                  <Input value={cfg.tokenUrl} onChange={(e) => set('tokenUrl', e.target.value)}
                    placeholder="https://<domain>.auth.<region>.amazoncognito.com/oauth2/token" />
                </div>
                <div className="space-y-1.5">
                  <Label>Client ID</Label>
                  <Input value={cfg.clientId} onChange={(e) => set('clientId', e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Scope</Label>
                  <Input value={cfg.scope} onChange={(e) => set('scope', e.target.value)} placeholder="Optional" />
                </div>
              </>
            )}
            <div className="space-y-1.5">
              <Label>
                {cc ? 'Client secret' : 'Access token'}{' '}
                {cfg.credentialSet && <span className="text-xs text-emerald-500">(set, leave blank to keep)</span>}
              </Label>
              <Input type="password" value={credential} onChange={(e) => setCredential(e.target.value)}
                placeholder={cfg.credentialSet ? '••••••••' : ''} />
              <p className="text-xs text-muted-foreground">Stored encrypted in the Secrets Vault.</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="text-sm text-muted-foreground mt-6">
        To register an agent, fill in its Governance card in <Link className="underline" to="/settings/agents">Settings → Agents</Link> and
        press Save and register. New agents start as pending until they're approved in Saviynt.
      </p>
    </>
  );
}
