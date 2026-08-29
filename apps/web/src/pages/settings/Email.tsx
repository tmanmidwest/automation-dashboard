import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface SmtpCfg {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromAddress: string;
  fromName: string;
  passwordSet: boolean;
}

export function Email() {
  const { can } = useAuth();
  const writable = can('settings:write');
  const [cfg, setCfg] = useState<SmtpCfg | null>(null);
  const [password, setPassword] = useState('');
  const [testTo, setTestTo] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.get<SmtpCfg>('/api/settings/smtp').then((c) => { setCfg(c); }).catch(() => {});
  }, []);

  if (!cfg) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api.put('/api/settings/smtp', {
        host: cfg!.host, port: Number(cfg!.port), secure: cfg!.secure,
        username: cfg!.username, fromAddress: cfg!.fromAddress, fromName: cfg!.fromName,
        password: password || undefined,
      });
      setPassword('');
      setMsg({ ok: true, text: 'SMTP settings saved.' });
      setCfg(await api.get<SmtpCfg>('/api/settings/smtp'));
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Save failed' });
    }
  }

  async function sendTest() {
    setMsg(null);
    try {
      const res = await api.post<{ ok: boolean; message: string }>('/api/settings/smtp/test', { to: testTo });
      setMsg({ ok: res.ok, text: res.message });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Test failed' });
    }
  }

  return (
    <>
      <PageHeader title="Email" description="Outbound SMTP server for notifications and invites." />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">SMTP server</CardTitle>
          <CardDescription>Credentials are encrypted at rest.</CardDescription>
        </CardHeader>
        <CardContent>
          {msg && (
            <div className={`mb-4 text-sm rounded-md px-3 py-2 border ${
              msg.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                     : 'border-destructive/40 bg-destructive/10 text-destructive'}`}>
              {msg.text}
            </div>
          )}
          <form onSubmit={save} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Host</Label>
                <Input value={cfg.host} disabled={!writable} placeholder="smtp.example.com"
                  onChange={(e) => setCfg({ ...cfg, host: e.target.value })} />
              </div>
              <div>
                <Label>Port</Label>
                <Input type="number" value={cfg.port} disabled={!writable}
                  onChange={(e) => setCfg({ ...cfg, port: Number(e.target.value) })} />
              </div>
            </div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]"
                checked={cfg.secure} disabled={!writable}
                onChange={(e) => setCfg({ ...cfg, secure: e.target.checked })} />
              <span className="text-sm">Use implicit TLS (port 465)</span>
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Username</Label>
                <Input value={cfg.username} disabled={!writable}
                  onChange={(e) => setCfg({ ...cfg, username: e.target.value })} />
              </div>
              <div>
                <Label>Password {cfg.passwordSet && <span className="text-muted-foreground font-normal">(saved — blank keeps)</span>}</Label>
                <Input type="password" value={password} disabled={!writable}
                  placeholder={cfg.passwordSet ? '••••••••' : ''}
                  onChange={(e) => setPassword(e.target.value)} />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>From address</Label>
                <Input type="email" value={cfg.fromAddress} disabled={!writable}
                  onChange={(e) => setCfg({ ...cfg, fromAddress: e.target.value })} />
              </div>
              <div>
                <Label>From name</Label>
                <Input value={cfg.fromName} disabled={!writable}
                  onChange={(e) => setCfg({ ...cfg, fromName: e.target.value })} />
              </div>
            </div>
            {writable && <Button type="submit">Save changes</Button>}
          </form>

          {writable && (
            <div className="mt-6 pt-6 border-t border-border">
              <Label>Send a test email</Label>
              <div className="flex gap-2">
                <Input type="email" placeholder="you@example.com" value={testTo}
                  onChange={(e) => setTestTo(e.target.value)} />
                <Button type="button" variant="secondary" onClick={sendTest} disabled={!testTo}>Send test</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
