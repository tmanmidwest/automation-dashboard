import { useState } from 'react';
import { KeyRound, ShieldCheck, Loader2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function Account() {
  const { user } = useAuth();
  const isSso = user?.authProvider === 'oidc';

  const [step, setStep] = useState<'idle' | 'sent'>('idle');
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function requestCode() {
    setSending(true); setMsg(null);
    try {
      const res = await api.post<{ email: string }>('/api/account/password/request');
      setStep('sent');
      setMsg({ ok: true, text: `We sent a verification code to ${res.email}. Enter it below.` });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Failed to send code' });
    } finally {
      setSending(false);
    }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (pw !== pw2) { setMsg({ ok: false, text: 'Passwords do not match.' }); return; }
    setSaving(true);
    try {
      await api.post('/api/account/password/confirm', { code: code.trim(), newPassword: pw });
      setStep('idle'); setCode(''); setPw(''); setPw2('');
      setMsg({ ok: true, text: 'Password changed successfully.' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Failed to change password' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader title="Account" description="Your profile and sign-in settings." />

      <Card className="mb-6 max-w-lg">
        <CardContent className="pt-6">
          <dl className="text-sm divide-y divide-border/50">
            <div className="flex justify-between py-2"><dt className="text-muted-foreground">Name</dt><dd>{user?.displayName}</dd></div>
            <div className="flex justify-between py-2"><dt className="text-muted-foreground">Email</dt><dd>{user?.email}</dd></div>
            <div className="flex justify-between py-2"><dt className="text-muted-foreground">Role</dt><dd>{user?.roleName}</dd></div>
            <div className="flex justify-between py-2"><dt className="text-muted-foreground">Sign-in</dt><dd className="capitalize">{isSso ? 'Single sign-on' : 'Local password'}</dd></div>
          </dl>
        </CardContent>
      </Card>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><KeyRound className="h-4 w-4" /> Password</CardTitle>
          <CardDescription>Change your password. We'll email you a verification code first.</CardDescription>
        </CardHeader>
        <CardContent>
          {msg && (
            <div className={`mb-4 text-sm rounded-md px-3 py-2 border ${
              msg.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-destructive/40 bg-destructive/10 text-destructive'}`}>
              {msg.text}
            </div>
          )}

          {isSso ? (
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="h-4 w-4 mt-0.5 text-accent shrink-0" />
              You sign in through a single sign-on provider, so there's no Cerebro password to change. Manage your credentials with your identity provider.
            </div>
          ) : step === 'idle' ? (
            <Button onClick={requestCode} disabled={sending}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Send verification code
            </Button>
          ) : (
            <form onSubmit={confirm} className="space-y-4">
              <div>
                <Label>Verification code</Label>
                <Input value={code} onChange={(e) => setCode(e.target.value)} required inputMode="numeric" placeholder="6-digit code from your email" />
              </div>
              <div>
                <Label>New password</Label>
                <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={10} />
              </div>
              <div>
                <Label>Confirm new password</Label>
                <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} required minLength={10} />
              </div>
              <p className="text-xs text-muted-foreground">Minimum 10 characters. The code expires in 10 minutes.</p>
              <div className="flex gap-2">
                <Button type="submit" disabled={saving}>{saving ? 'Changing…' : 'Change password'}</Button>
                <Button type="button" variant="ghost" onClick={requestCode} disabled={sending}>Resend code</Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </>
  );
}
