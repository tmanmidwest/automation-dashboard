import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EnableToggle, type Severity } from './notify-ui';
import { SignalCard } from './SignalCard';
import { AlertsMatrix } from './AlertsMatrix';
import { NotificationHistory } from './NotificationHistory';

interface QuietCfg {
  enabled: boolean;
  start: string;
  end: string;
  floor: Severity;
  channels: string[];
}
interface NotifCfg {
  email: { enabled: boolean; recipients: string };
  textbelt: { enabled: boolean; recipients: string; endpoint: string; keySet: boolean };
  signal: { enabled: boolean; recipients: string };
  throttleWindowSec: number;
  quiet: QuietCfg;
}

const QUIET_CHANNELS: { id: string; label: string }[] = [
  { id: 'email', label: 'Email' },
  { id: 'textbelt', label: 'SMS' },
  { id: 'signal', label: 'Signal' },
];
const QUIET_FLOORS: { value: Severity; label: string }[] = [
  { value: 'critical', label: 'Critical only' },
  { value: 'warning', label: 'Warning & Critical' },
  { value: 'info', label: 'Everything (no hold)' },
];

export function Notifications() {
  const { can } = useAuth();
  const writable = can('settings:write');
  const [cfg, setCfg] = useState<NotifCfg | null>(null);
  const [textbeltKey, setTextbeltKey] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.get<NotifCfg>('/api/settings/notifications').then(setCfg).catch(() => {});
  }, []);

  if (!cfg) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api.put('/api/settings/notifications', {
        email: cfg!.email,
        textbelt: { ...cfg!.textbelt, key: textbeltKey || undefined },
        signal: cfg!.signal,
        throttleWindowSec: Number(cfg!.throttleWindowSec),
        quiet: cfg!.quiet,
      });
      setTextbeltKey('');
      setMsg({ ok: true, text: 'Channel settings saved.' });
      setCfg(await api.get<NotifCfg>('/api/settings/notifications'));
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Save failed' });
    }
  }

  async function sendTest(channel: 'email' | 'textbelt' | 'signal') {
    setMsg(null);
    try {
      const res = await api.post<{ ok: boolean; message: string }>(
        '/api/settings/notifications/test',
        { channel },
      );
      setMsg({ ok: res.ok, text: res.message });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Test failed' });
    }
  }

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Deliver outbound alerts by email, SMS, and Signal. Configure the channels, then choose which alerts go where."
      />

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

      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
        Channels
      </h2>
      <form onSubmit={save} className="space-y-4">
        {/* ── Email ─────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle className="text-base">Email</CardTitle>
                <CardDescription>Uses your configured SMTP server.</CardDescription>
              </div>
              <EnableToggle
                checked={cfg.email.enabled}
                disabled={!writable}
                onChange={(enabled) => setCfg({ ...cfg, email: { ...cfg.email, enabled } })}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Recipients</Label>
              <Input
                value={cfg.email.recipients}
                disabled={!writable}
                placeholder="alerts@example.com, you@example.com"
                onChange={(e) => setCfg({ ...cfg, email: { ...cfg.email, recipients: e.target.value } })}
              />
            </div>
            {writable && (
              <Button type="button" variant="secondary" onClick={() => sendTest('email')}>
                Send test email
              </Button>
            )}
          </CardContent>
        </Card>

        {/* ── SMS (Textbelt) ────────────────────────────────── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle className="text-base">SMS (Textbelt)</CardTitle>
                <CardDescription>
                  Outbound text via textbelt.com. Use key <code>textbelt_test</code> for a free dry run.
                </CardDescription>
              </div>
              <EnableToggle
                checked={cfg.textbelt.enabled}
                disabled={!writable}
                onChange={(enabled) => setCfg({ ...cfg, textbelt: { ...cfg.textbelt, enabled } })}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Recipient numbers</Label>
              <Input
                value={cfg.textbelt.recipients}
                disabled={!writable}
                placeholder="+15551234567, +15557654321"
                onChange={(e) =>
                  setCfg({ ...cfg, textbelt: { ...cfg.textbelt, recipients: e.target.value } })
                }
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>
                  API key{' '}
                  {cfg.textbelt.keySet && (
                    <span className="text-muted-foreground font-normal">(saved — blank keeps)</span>
                  )}
                </Label>
                <Input
                  type="password"
                  value={textbeltKey}
                  disabled={!writable}
                  placeholder={cfg.textbelt.keySet ? '••••••••' : 'your Textbelt key'}
                  onChange={(e) => setTextbeltKey(e.target.value)}
                />
              </div>
              <div>
                <Label>
                  Endpoint <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input
                  value={cfg.textbelt.endpoint}
                  disabled={!writable}
                  placeholder="https://textbelt.com/text"
                  onChange={(e) =>
                    setCfg({ ...cfg, textbelt: { ...cfg.textbelt, endpoint: e.target.value } })
                  }
                />
              </div>
            </div>
            {writable && (
              <Button type="button" variant="secondary" onClick={() => sendTest('textbelt')}>
                Send test SMS
              </Button>
            )}
          </CardContent>
        </Card>

        {/* ── Signal ────────────────────────────────────────── */}
        <SignalCard
          value={cfg.signal}
          writable={writable}
          onChange={(signal) => setCfg({ ...cfg, signal })}
          onTest={() => sendTest('signal')}
        />

        {/* ── Quiet hours ───────────────────────────────────── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle className="text-base">Quiet hours</CardTitle>
                <CardDescription>
                  Hold non-urgent alerts overnight on the chosen channels (server time).
                </CardDescription>
              </div>
              <EnableToggle
                checked={cfg.quiet.enabled}
                disabled={!writable}
                onChange={(enabled) => setCfg({ ...cfg, quiet: { ...cfg.quiet, enabled } })}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label>From</Label>
                <Input
                  type="time"
                  value={cfg.quiet.start}
                  disabled={!writable || !cfg.quiet.enabled}
                  onChange={(e) => setCfg({ ...cfg, quiet: { ...cfg.quiet, start: e.target.value } })}
                />
              </div>
              <div>
                <Label>To</Label>
                <Input
                  type="time"
                  value={cfg.quiet.end}
                  disabled={!writable || !cfg.quiet.enabled}
                  onChange={(e) => setCfg({ ...cfg, quiet: { ...cfg.quiet, end: e.target.value } })}
                />
              </div>
              <div>
                <Label>Still deliver</Label>
                <select
                  value={cfg.quiet.floor}
                  disabled={!writable || !cfg.quiet.enabled}
                  onChange={(e) =>
                    setCfg({ ...cfg, quiet: { ...cfg.quiet, floor: e.target.value as Severity } })
                  }
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm disabled:opacity-50"
                >
                  {QUIET_FLOORS.map((f) => (
                    <option key={f.value} value={f.value} className="bg-background">
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <Label>Applies to</Label>
              <div className="flex flex-wrap gap-4 mt-1">
                {QUIET_CHANNELS.map((ch) => (
                  <label key={ch.id} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[hsl(var(--primary))]"
                      checked={cfg.quiet.channels.includes(ch.id)}
                      disabled={!writable || !cfg.quiet.enabled}
                      onChange={(e) =>
                        setCfg({
                          ...cfg,
                          quiet: {
                            ...cfg.quiet,
                            channels: e.target.checked
                              ? [...new Set([...cfg.quiet.channels, ch.id])]
                              : cfg.quiet.channels.filter((c) => c !== ch.id),
                          },
                        })
                      }
                    />
                    <span className="text-sm">{ch.label}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                During quiet hours, only alerts at the “still deliver” level and above go to these
                channels. Others (e.g. Email) are unaffected.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ── Delivery ──────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Delivery</CardTitle>
            <CardDescription>
              Rate-limiting protects you from alert storms (and SMS costs).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-w-xs">
              <Label>Dedupe window (seconds)</Label>
              <Input
                type="number"
                min={0}
                value={cfg.throttleWindowSec}
                disabled={!writable}
                onChange={(e) => setCfg({ ...cfg, throttleWindowSec: Number(e.target.value) })}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Identical alerts within this window are sent once. 0 disables throttling.
              </p>
            </div>
          </CardContent>
        </Card>

        {writable && <Button type="submit">Save channel settings</Button>}
      </form>

      {/* ── Alerts ────────────────────────────────────────────── */}
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mt-8 mb-3">
        Alerts
      </h2>
      <AlertsMatrix writable={writable} />

      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mt-8 mb-3">
        History
      </h2>
      <NotificationHistory />
    </>
  );
}
