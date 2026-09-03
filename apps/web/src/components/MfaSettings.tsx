import { useEffect, useState } from 'react';
import { ShieldCheck, ShieldAlert, Loader2, Copy, Check } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Status = { enabled: boolean; pending: boolean };
type Setup = { otpauthUrl: string; qrDataUrl: string };

/** Pull the base32 secret out of an otpauth:// URL for manual entry. */
function secretFromUri(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get('secret');
  } catch {
    return null;
  }
}

export function MfaSettings({ isSso }: { isSso: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Local UI state machine: view (enrolled/off) → 'enroll' (scan+confirm) → 'codes' (show once).
  const [mode, setMode] = useState<'view' | 'enroll' | 'codes'>('view');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  // Inline step-up code entry for disable / regenerate.
  const [action, setAction] = useState<'none' | 'disable' | 'regen'>('none');
  const [actionCode, setActionCode] = useState('');

  async function loadStatus() {
    try {
      setStatus(await api.get<Status>('/api/account/mfa'));
    } catch {
      setStatus({ enabled: false, pending: false });
    }
  }
  useEffect(() => { if (!isSso) void loadStatus(); }, [isSso]);

  async function beginSetup() {
    setBusy(true); setMsg(null);
    try {
      setSetup(await api.post<Setup>('/api/account/mfa/setup'));
      setCode('');
      setMode('enroll');
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Could not start setup.' });
    } finally {
      setBusy(false);
    }
  }

  async function enable(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const res = await api.post<{ recoveryCodes: string[] }>('/api/account/mfa/enable', { code: code.trim() });
      setRecovery(res.recoveryCodes);
      setMode('codes');
      await loadStatus();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Could not enable.' });
    } finally {
      setBusy(false);
    }
  }

  async function runAction(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      if (action === 'disable') {
        await api.post('/api/account/mfa/disable', { code: actionCode.trim() });
        setMsg({ ok: true, text: 'Two-factor authentication disabled.' });
        setAction('none'); setActionCode('');
        await loadStatus();
      } else if (action === 'regen') {
        const res = await api.post<{ recoveryCodes: string[] }>('/api/account/mfa/recovery-codes', { code: actionCode.trim() });
        setRecovery(res.recoveryCodes);
        setAction('none'); setActionCode('');
        setMode('codes');
      }
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'That code was not accepted.' });
    } finally {
      setBusy(false);
    }
  }

  function copyCodes() {
    navigator.clipboard?.writeText(recovery.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  const secret = setup ? secretFromUri(setup.otpauthUrl) : null;

  return (
    <Card className="mt-6 max-w-lg">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> Two-factor authentication
        </CardTitle>
        <CardDescription>Require a time-based code from an authenticator app at sign-in.</CardDescription>
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
            You sign in through single sign-on. Manage two-factor authentication with your identity provider.
          </div>
        ) : !status ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : mode === 'codes' ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 text-sm">
              <ShieldAlert className="h-4 w-4 mt-0.5 text-amber-400 shrink-0" />
              <span>Save these recovery codes somewhere safe. Each works once if you lose your authenticator. <b>They won't be shown again.</b></span>
            </div>
            <div className="grid grid-cols-2 gap-2 font-mono text-sm rounded-md border border-border bg-background/40 p-3">
              {recovery.map((c) => <div key={c}>{c}</div>)}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={copyCodes}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy codes'}
              </Button>
              <Button type="button" size="sm" onClick={() => { setMode('view'); setRecovery([]); }}>I've saved these</Button>
            </div>
          </div>
        ) : mode === 'enroll' && setup ? (
          <form onSubmit={enable} className="space-y-4">
            <p className="text-sm text-muted-foreground">Scan this with your authenticator app (Google Authenticator, 1Password, Authy…), then enter the code it shows.</p>
            <img src={setup.qrDataUrl} alt="TOTP QR code" className="rounded-md border border-border bg-white p-2" width={180} height={180} />
            {secret && (
              <p className="text-xs text-muted-foreground">Can't scan? Enter this key manually: <span className="font-mono text-foreground break-all">{secret}</span></p>
            )}
            <div>
              <Label>Verification code</Label>
              <Input value={code} onChange={(e) => setCode(e.target.value)} required inputMode="numeric" autoComplete="one-time-code" placeholder="123456" />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>{busy ? 'Verifying…' : 'Enable'}</Button>
              <Button type="button" variant="ghost" onClick={() => setMode('view')}>Cancel</Button>
            </div>
          </form>
        ) : status.enabled ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-emerald-400">
              <ShieldCheck className="h-4 w-4" /> Two-factor authentication is on.
            </div>
            {action === 'none' ? (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => { setAction('regen'); setActionCode(''); setMsg(null); }}>Regenerate recovery codes</Button>
                <Button variant="ghost" size="sm" className="text-destructive" onClick={() => { setAction('disable'); setActionCode(''); setMsg(null); }}>Disable</Button>
              </div>
            ) : (
              <form onSubmit={runAction} className="space-y-3">
                <div>
                  <Label>{action === 'disable' ? 'Enter a current code to disable' : 'Enter a current code to regenerate'}</Label>
                  <Input value={actionCode} onChange={(e) => setActionCode(e.target.value)} required inputMode="numeric" autoComplete="one-time-code" placeholder="123456 or recovery code" />
                </div>
                <div className="flex gap-2">
                  <Button type="submit" disabled={busy} variant={action === 'disable' ? 'destructive' : 'default'}>
                    {busy ? 'Working…' : action === 'disable' ? 'Disable 2FA' : 'Regenerate'}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => { setAction('none'); setActionCode(''); }}>Cancel</Button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <Button onClick={beginSetup} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Set up two-factor
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
