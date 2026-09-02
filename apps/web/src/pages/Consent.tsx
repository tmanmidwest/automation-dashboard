import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShieldCheck, AlertTriangle } from 'lucide-react';
import type { Permission } from '@cerebro/shared';

/** A scope that grants write/action access (not read-only). Mirrors shared's isWriteScope;
 *  inlined because the web only imports types from the (CJS-built) shared package. */
const isWriteScope = (s: Permission): boolean => !s.endsWith(':read');
import { api, ApiError } from '@/lib/api';
import { Brand } from '@/components/Brand';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

interface ConsentInfo {
  clientId: string;
  clientName: string;
  scopes: Permission[];
}

const SCOPE_LABELS: Record<string, string> = {
  'connectors:read': 'Read connectors and their resources',
  'monitors:read': 'Read uptime monitors and status',
  'logs:read': 'Read application logs',
  'audit:read': 'Read the audit trail',
  'users:read': 'Read user accounts',
  'settings:read': 'Read application settings',
  'connectors:action': 'Perform connector actions — start/stop/reboot resources, run operations',
  'monitors:write': 'Manage monitors — pause, resume, and trigger checks',
};

export function Consent() {
  const [params] = useSearchParams();
  const [info, setInfo] = useState<ConsentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const qs = params.toString();

  useEffect(() => {
    (async () => {
      try {
        const data = await api.get<ConsentInfo>(
          `/api/oauth/consent-info?client_id=${encodeURIComponent(params.get('client_id') ?? '')}` +
            `&redirect_uri=${encodeURIComponent(params.get('redirect_uri') ?? '')}` +
            `&scope=${encodeURIComponent(params.get('scope') ?? '')}`,
        );
        setInfo(data);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // No session — send through login, returning to the authorize endpoint.
          window.location.href = `/login?returnTo=${encodeURIComponent(`/oauth/authorize?${qs}`)}`;
          return;
        }
        setError(err instanceof ApiError ? err.message : 'Could not load the authorization request.');
      }
    })();
  }, [params, qs]);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, string | boolean> = { approve };
      for (const k of ['client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'response_type', 'resource']) {
        const v = params.get(k);
        if (v !== null) payload[k] = v;
      }
      const { redirectTo } = await api.post<{ redirectTo: string }>('/api/oauth/authorize/decision', payload);
      window.location.href = redirectTo; // back to the OAuth client
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit your decision.');
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center cerebro-aurora p-4">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-6"><Brand className="scale-125" /></div>
        <Card className="backdrop-blur bg-card/80">
          <CardContent className="pt-6">
            {error && (
              <div className="mb-4 text-sm rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2">
                {error}
              </div>
            )}

            {!info && !error && <p className="text-sm text-muted-foreground">Loading…</p>}

            {info && (
              <>
                <div className="flex items-center gap-3 mb-4">
                  <div className="h-10 w-10 rounded-lg bg-primary/15 text-primary grid place-items-center shrink-0">
                    <ShieldCheck className="h-5 w-5" />
                  </div>
                  <div>
                    <h1 className="text-lg font-semibold leading-tight">Authorize access</h1>
                    <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">{info.clientName}</span> wants to access Cerebro.</p>
                  </div>
                </div>

                <p className="text-sm mb-2">It will be able to:</p>
                <ul className="mb-4 space-y-1.5">
                  {info.scopes.map((s) => {
                    const write = isWriteScope(s);
                    return (
                      <li key={s} className="flex items-start gap-2 text-sm">
                        {write
                          ? <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-500 shrink-0" />
                          : <ShieldCheck className="h-4 w-4 mt-0.5 text-emerald-400 shrink-0" />}
                        <span>{SCOPE_LABELS[s] ?? s}</span>
                      </li>
                    );
                  })}
                </ul>
                {info.scopes.some(isWriteScope) && (
                  <div className="mb-6 text-xs rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-500 px-3 py-2">
                    This grants write access — the app will be able to change your infrastructure, not just read it.
                  </div>
                )}

                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={() => decide(false)} disabled={busy}>Deny</Button>
                  <Button className="flex-1" onClick={() => decide(true)} disabled={busy}>{busy ? 'Authorizing…' : 'Allow'}</Button>
                </div>
                <p className="mt-3 text-xs text-muted-foreground text-center">You can revoke this later in Settings.</p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
