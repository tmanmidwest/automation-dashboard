import { useEffect, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface OidcCfg {
  enabled: boolean;
  issuer: string;
  clientId: string;
  buttonLabel: string;
  redirectUri: string;
  clientSecretSet: boolean;
}

export function Authentication() {
  const { can } = useAuth();
  const writable = can('settings:write');
  const [cfg, setCfg] = useState<OidcCfg | null>(null);
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.get<OidcCfg>('/api/settings/auth').then(setCfg).catch(() => {});
  }, []);

  if (!cfg) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api.put('/api/settings/auth', {
        enabled: cfg!.enabled,
        issuer: cfg!.issuer,
        clientId: cfg!.clientId,
        buttonLabel: cfg!.buttonLabel,
        clientSecret: secret || undefined,
      });
      setSecret('');
      setMsg({ ok: true, text: 'Authentication settings saved.' });
      setCfg(await api.get<OidcCfg>('/api/settings/auth'));
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Save failed' });
    }
  }

  return (
    <>
      <PageHeader title="Authentication" description="Local accounts are always available. Add OIDC for single sign-on." />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">OIDC / OAuth2 single sign-on</CardTitle>
          <CardDescription>
            Works with Microsoft Entra, Google, Authentik, Keycloak, and any OpenID Connect provider.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-5 rounded-md bg-muted/50 border border-border p-3">
            <Label className="mb-1">Redirect URI (add this to your provider)</Label>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-background rounded px-2 py-1.5 break-all">{cfg.redirectUri}</code>
              <Button type="button" variant="outline" size="icon" onClick={() => {
                navigator.clipboard.writeText(cfg.redirectUri);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {msg && (
            <div className={`mb-4 text-sm rounded-md px-3 py-2 border ${
              msg.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                     : 'border-destructive/40 bg-destructive/10 text-destructive'}`}>
              {msg.text}
            </div>
          )}

          <form onSubmit={save} className="space-y-4">
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]"
                checked={cfg.enabled} disabled={!writable}
                onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
              <span className="text-sm font-medium">Enable OIDC sign-in</span>
            </label>
            <div>
              <Label>Issuer URL</Label>
              <Input placeholder="https://login.microsoftonline.com/<tenant>/v2.0"
                value={cfg.issuer} disabled={!writable}
                onChange={(e) => setCfg({ ...cfg, issuer: e.target.value })} />
            </div>
            <div>
              <Label>Client ID</Label>
              <Input value={cfg.clientId} disabled={!writable}
                onChange={(e) => setCfg({ ...cfg, clientId: e.target.value })} />
            </div>
            <div>
              <Label>Client secret {cfg.clientSecretSet && <span className="text-muted-foreground font-normal">(saved — leave blank to keep)</span>}</Label>
              <Input type="password" placeholder={cfg.clientSecretSet ? '••••••••' : ''}
                value={secret} disabled={!writable} onChange={(e) => setSecret(e.target.value)} />
            </div>
            <div>
              <Label>Sign-in button label</Label>
              <Input value={cfg.buttonLabel} disabled={!writable}
                onChange={(e) => setCfg({ ...cfg, buttonLabel: e.target.value })} />
            </div>
            {writable && <Button type="submit">Save changes</Button>}
          </form>
        </CardContent>
      </Card>
    </>
  );
}
