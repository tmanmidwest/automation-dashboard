import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface MonAlert {
  key: string;
  label: string;
  description: string;
  globalEnabled: boolean;
  globalSeverity: 'info' | 'warning' | 'critical';
  globalChannels: string[];
  muted: boolean;
}

/** Per-monitor alert muting. Unmuted alerts follow the global rules on Settings → Notifications. */
export function MonitorAlerts({ monitorId }: { monitorId: string }) {
  const { can } = useAuth();
  const writable = can('monitors:write');
  const [alerts, setAlerts] = useState<MonAlert[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ alerts: MonAlert[] }>(`/api/monitors/${monitorId}/alerts`).then((d) => setAlerts(d.alerts)).catch(() => setAlerts(null));
  }, [monitorId]);

  async function save() {
    if (!alerts) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.put(`/api/monitors/${monitorId}/alerts`, { muted: alerts.filter((a) => a.muted).map((a) => a.key) });
      setMsg({ ok: true, text: 'Saved.' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Save failed' });
    } finally {
      setBusy(false);
    }
  }

  if (!alerts) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Alerts</CardTitle>
        <CardDescription>Mute specific alerts for this monitor. Everything else follows the global rules in Settings → Notifications.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {alerts.map((a) => (
          <label key={a.key} className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-[hsl(var(--primary))]" checked={a.muted} disabled={!writable}
              onChange={(e) => setAlerts((list) => list!.map((x) => (x.key === a.key ? { ...x, muted: e.target.checked } : x)))} />
            <span className="text-sm">
              <span className="font-medium">Mute “{a.label}”</span>
              <span className="block text-xs text-muted-foreground">
                {a.description} Globally {a.globalEnabled ? `on · ${a.globalSeverity} · ${a.globalChannels.join(', ') || 'no channels'}` : 'off'}.
              </span>
            </span>
          </label>
        ))}
        {writable && (
          <div className="flex items-center gap-3 pt-1">
            <Button size="sm" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
            {msg && <span className={`text-xs ${msg.ok ? 'text-emerald-400' : 'text-destructive'}`}>{msg.text}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
