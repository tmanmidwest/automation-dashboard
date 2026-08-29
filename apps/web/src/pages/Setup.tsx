import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { Brand } from '@/components/Brand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';

export function Setup() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ displayName: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password !== form.confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/setup', {
        displayName: form.displayName,
        email: form.email,
        password: form.password,
      });
      await refresh();
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Setup failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center cerebro-aurora p-4">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-6">
          <Brand className="scale-125" />
        </div>
        <Card className="backdrop-blur bg-card/80">
          <CardContent className="pt-6">
            <div className="mb-5">
              <span className="text-xs font-medium uppercase tracking-wider text-primary">First-run setup</span>
              <h1 className="text-xl font-semibold mt-1">Create your administrator</h1>
              <p className="text-sm text-muted-foreground">
                This account gets full control of Cerebro. You can add more users later.
              </p>
            </div>

            {error && (
              <div className="mb-4 text-sm rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2">
                {error}
              </div>
            )}

            <form onSubmit={submit} className="space-y-4">
              <div>
                <Label htmlFor="name">Display name</Label>
                <Input id="name" value={form.displayName} onChange={set('displayName')} required minLength={2} />
              </div>
              <div>
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={form.email} onChange={set('email')} required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="pw">Password</Label>
                  <Input id="pw" type="password" value={form.password} onChange={set('password')} required minLength={10} />
                </div>
                <div>
                  <Label htmlFor="cf">Confirm</Label>
                  <Input id="cf" type="password" value={form.confirm} onChange={set('confirm')} required minLength={10} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">Minimum 10 characters.</p>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? 'Creating…' : 'Create administrator & sign in'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
