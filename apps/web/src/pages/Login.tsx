import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { PublicIdentityProvider } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { Brand } from '@/components/Brand';
import { ProviderIcon } from '@/components/ProviderIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';

export function Login() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(params.get('error'));
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<PublicIdentityProvider[]>([]);

  useEffect(() => {
    api.get<PublicIdentityProvider[]>('/api/auth/providers').then(setProviders).catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { email, password });
      await refresh();
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center cerebro-aurora p-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-6">
          <Brand className="scale-125" />
        </div>
        <Card className="backdrop-blur bg-card/80">
          <CardContent className="pt-6">
            <h1 className="text-xl font-semibold mb-1">Welcome back</h1>
            <p className="text-sm text-muted-foreground mb-5">Sign in to your Cerebro console.</p>

            {error && (
              <div className="mb-4 text-sm rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2">
                {error}
              </div>
            )}

            <form onSubmit={submit} className="space-y-4">
              <div>
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" autoComplete="username" value={email}
                  onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div>
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" autoComplete="current-password" value={password}
                  onChange={(e) => setPassword(e.target.value)} required />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>

            {providers.length > 0 && (
              <>
                <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
                </div>
                <div className="space-y-2">
                  {providers.map((p) => (
                    <Button key={p.slug} variant="outline" className="w-full"
                      onClick={() => (window.location.href = `/api/auth/sso/${p.slug}/login`)}>
                      <ProviderIcon icon={p.icon} />
                      {p.buttonLabel}
                    </Button>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
