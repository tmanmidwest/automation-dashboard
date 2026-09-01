import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';
import { EnableToggle } from './notify-ui';

interface SignalCfg {
  enabled: boolean;
  recipients: string;
}
interface SignalStatus {
  available: boolean;
  linked: boolean;
  account: string | null;
  accounts: string[];
}
interface LinkState {
  status: 'waiting' | 'linked' | 'error';
  uri?: string;
  account?: string;
  error?: string;
}

export function SignalCard({
  value,
  writable,
  onChange,
  onTest,
}: {
  value: SignalCfg;
  writable: boolean;
  onChange: (v: SignalCfg) => void;
  onTest: () => void;
}) {
  const [status, setStatus] = useState<SignalStatus | null>(null);
  const [dialog, setDialog] = useState<'link' | 'register' | null>(null);

  const refreshStatus = useCallback(() => {
    api.get<SignalStatus>('/api/settings/notifications/signal/status').then(setStatus).catch(() => {});
  }, []);
  // A fresh link/registration takes a moment to reflect in signal-cli, so
  // re-check a few times rather than once (else the card stays "not linked"
  // until a manual page refresh).
  const refreshStatusSoon = useCallback(() => {
    refreshStatus();
    const t1 = setTimeout(refreshStatus, 1500);
    const t2 = setTimeout(refreshStatus, 4000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [refreshStatus]);
  useEffect(() => refreshStatus(), [refreshStatus]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="text-base">Signal</CardTitle>
            <CardDescription>
              Sent via the bundled signal-cli. Link a device or register a number below.
            </CardDescription>
          </div>
          <EnableToggle
            checked={value.enabled}
            disabled={!writable}
            onChange={(enabled) => onChange({ ...value, enabled })}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status line */}
        <div className="text-sm">
          {status == null ? (
            <span className="text-muted-foreground">Checking Signal status…</span>
          ) : !status.available ? (
            <span className="text-amber-400">
              signal-cli isn’t available in this image — rebuild with the Signal-enabled Dockerfile.
            </span>
          ) : status.linked ? (
            <span className="text-emerald-400">
              Linked — sending as <code>{status.account}</code>
            </span>
          ) : (
            <span className="text-muted-foreground">Not linked yet.</span>
          )}
        </div>

        {writable && status?.available && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={() => setDialog('link')}>
              {status.linked ? 'Link another device' : 'Link device (QR)'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setDialog('register')}>
              Register a number
            </Button>
          </div>
        )}

        <div>
          <Label>Recipient numbers</Label>
          <Input
            value={value.recipients}
            disabled={!writable}
            placeholder="+15551234567, group.AbCd… (for a group)"
            onChange={(e) => onChange({ ...value, recipients: e.target.value })}
          />
        </div>

        {writable && (
          <Button type="button" variant="secondary" onClick={onTest} disabled={!status?.linked}>
            Send test Signal
          </Button>
        )}
      </CardContent>

      {dialog === 'link' && (
        <LinkDialog
          onClose={() => {
            setDialog(null);
            refreshStatus();
          }}
          onLinked={refreshStatusSoon}
        />
      )}
      {dialog === 'register' && (
        <RegisterDialog
          onClose={() => {
            setDialog(null);
            refreshStatus();
          }}
          onRegistered={refreshStatusSoon}
        />
      )}
    </Card>
  );
}

/* ── Link (QR / secondary device) ──────────────────────────── */

function LinkDialog({ onClose, onLinked }: { onClose: () => void; onLinked: () => void }) {
  const [link, setLink] = useState<LinkState>({ status: 'waiting' });
  const idRef = useRef<string | null>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;

    (async () => {
      try {
        const res = await api.post<{ id: string; uri?: string }>(
          '/api/settings/notifications/signal/link',
          { deviceName: 'Cerebro' },
        );
        idRef.current = res.id;
        if (!stop) setLink((l) => ({ ...l, uri: res.uri }));
        const poll = async () => {
          if (stop || !idRef.current) return;
          try {
            const s = await api.get<LinkState>(`/api/settings/notifications/signal/link/${idRef.current}`);
            if (stop) return;
            setLink(s);
            if (s.status === 'linked') {
              onLinked();
              return;
            }
            if (s.status === 'error') return;
          } catch {
            /* keep polling */
          }
          timer = setTimeout(poll, 1500);
        };
        timer = setTimeout(poll, 1200);
      } catch (err) {
        if (!stop) setLink({ status: 'error', error: err instanceof ApiError ? err.message : 'Failed to start linking.' });
      }
    })();

    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [onLinked]);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Link a Signal device"
      description="On your phone: Signal → Settings → Linked devices → Link new device, then scan this code."
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      {link.status === 'linked' ? (
        <p className="text-emerald-400">
          Linked successfully{link.account ? ` as ${link.account}` : ''}. You can close this.
        </p>
      ) : link.status === 'error' ? (
        <p className="text-destructive">{link.error ?? 'Linking failed.'}</p>
      ) : link.uri ? (
        <div className="flex flex-col items-center gap-4">
          <div className="rounded-lg bg-white p-4">
            <QRCodeSVG value={link.uri} size={232} />
          </div>
          <p className="text-sm text-muted-foreground text-center">
            Waiting for your phone to confirm… this dialog updates automatically.
          </p>
        </div>
      ) : (
        <p className="text-muted-foreground">Generating link code…</p>
      )}
    </Dialog>
  );
}

/* ── Register a fresh number ───────────────────────────────── */

function RegisterDialog({ onClose, onRegistered }: { onClose: () => void; onRegistered: () => void }) {
  const [step, setStep] = useState<'number' | 'code'>('number');
  const [number, setNumber] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [captchaRequired, setCaptchaRequired] = useState(false);
  const [voice, setVoice] = useState(false);
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function sendCode() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.post<{ ok: boolean; captchaRequired?: boolean; message: string }>(
        '/api/settings/notifications/signal/register',
        { number, captcha: captcha || undefined, voice },
      );
      setMsg({ ok: res.ok, text: res.message });
      if (res.captchaRequired) setCaptchaRequired(true);
      if (res.ok) setStep('code');
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Registration failed.' });
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.post<{ ok: boolean; message: string }>(
        '/api/settings/notifications/signal/verify',
        { number, code, pin: pin || undefined },
      );
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        onRegistered();
        setTimeout(onClose, 900);
      }
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Verification failed.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Register a Signal number"
      description="Provision a dedicated number. Signal will send a verification code by SMS or voice."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {step === 'number' ? (
            <Button onClick={sendCode} disabled={busy || !/^\+\d{6,15}$/.test(number)}>
              {busy ? 'Sending…' : 'Send code'}
            </Button>
          ) : (
            <Button onClick={verify} disabled={busy || !code}>
              {busy ? 'Verifying…' : 'Verify'}
            </Button>
          )}
        </>
      }
    >
      {msg && (
        <div
          className={`mb-4 text-sm rounded-md px-3 py-2 border ${
            msg.ok
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
              : 'border-destructive/40 bg-destructive/10 text-destructive'
          }`}
        >
          {msg.text}
        </div>
      )}

      {step === 'number' ? (
        <div className="space-y-4">
          <div>
            <Label>Phone number (E.164)</Label>
            <Input value={number} placeholder="+15551234567" onChange={(e) => setNumber(e.target.value)} />
          </div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[hsl(var(--primary))]"
              checked={voice}
              onChange={(e) => setVoice(e.target.checked)}
            />
            <span className="text-sm">Receive the code by voice call instead of SMS</span>
          </label>
          {captchaRequired && (
            <div>
              <Label>Captcha token</Label>
              <Input value={captcha} placeholder="signalcaptcha://…" onChange={(e) => setCaptcha(e.target.value)} />
              <p className="text-xs text-muted-foreground mt-1">
                Solve the captcha at{' '}
                <a
                  className="underline"
                  href="https://signalcaptchas.org/registration/generate.html"
                  target="_blank"
                  rel="noreferrer"
                >
                  signalcaptchas.org
                </a>
                , then paste the resulting token here.
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <Label>Verification code</Label>
            <Input value={code} placeholder="123-456" onChange={(e) => setCode(e.target.value)} />
          </div>
          <div>
            <Label>
              Registration PIN <span className="text-muted-foreground font-normal">(only if set)</span>
            </Label>
            <Input value={pin} onChange={(e) => setPin(e.target.value)} />
          </div>
        </div>
      )}
    </Dialog>
  );
}
