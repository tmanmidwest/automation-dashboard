import { useEffect, useState } from 'react';
import { PRIVATE_NETWORK_CIDRS, type LocalLoginPolicyView } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

/** The caller's /24 (IPv4) or the exact address (IPv6) — a sensible "my network" entry. */
function myNetwork(ip: string): string {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : `${ip}/128`;
}

function splitList(text: string): string[] {
  return text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/** Settings → Authentication: restrict email + password sign-in by client IP. */
export function LocalLoginPolicyCard({ writable }: { writable: boolean }) {
  const [view, setView] = useState<LocalLoginPolicyView | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [cidrs, setCidrs] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function apply(v: LocalLoginPolicyView) {
    setView(v);
    setEnabled(v.enabled);
    setCidrs(v.allowedCidrs.join('\n'));
  }
  useEffect(() => {
    api.get<LocalLoginPolicyView>('/api/settings/auth/local-login').then(apply).catch(() => {});
  }, []);

  function add(entries: string[]) {
    const cur = splitList(cidrs);
    setCidrs([...cur, ...entries.filter((e) => !cur.includes(e))].join('\n'));
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      apply(await api.put<LocalLoginPolicyView>('/api/settings/auth/local-login', {
        enabled, allowedCidrs: splitList(cidrs),
      }));
      setMsg({ ok: true, text: 'Saved.' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Save failed' });
    } finally {
      setBusy(false);
    }
  }

  if (!view) return null;
  const restricted = enabled && splitList(cidrs).length > 0;

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">Password sign-in</CardTitle>
        <CardDescription>
          Limit email + password sign-in to trusted networks (e.g. your LAN or VPN), or turn it off and use
          single sign-on only. SSO is never affected.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]"
            checked={enabled} disabled={!writable}
            onChange={(e) => setEnabled(e.target.checked)} />
          <span className="text-sm font-medium">Allow password sign-in</span>
        </label>

        <div className="space-y-1.5">
          <Label>Allowed addresses <span className="text-muted-foreground font-normal">(IPs or CIDR ranges, one per line; empty = from anywhere)</span></Label>
          <textarea
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[6rem] disabled:opacity-60"
            value={cidrs} disabled={!writable || !enabled}
            placeholder={'192.168.1.0/24\n10.8.0.0/24'}
            onChange={(e) => setCidrs(e.target.value)}
          />
          {writable && enabled && (
            <div className="flex flex-wrap gap-2">
              {view.yourIp && (
                <Button type="button" variant="outline" size="sm" onClick={() => add([myNetwork(view.yourIp!)])}>
                  Add my network ({myNetwork(view.yourIp)})
                </Button>
              )}
              <Button type="button" variant="outline" size="sm" onClick={() => add(PRIVATE_NETWORK_CIDRS)}>
                Add private networks
              </Button>
            </div>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Your address as Cerebro sees it: <code>{view.yourIp ?? 'unknown'}</code> —{' '}
          {view.yourIpAllowed ? 'password sign-in is allowed from here.' : 'password sign-in is blocked from here.'}
          {restricted && ' Behind a reverse proxy this must be your real client IP (the proxy has to set X-Forwarded-For); if it shows the proxy\'s address, the list can\'t tell clients apart.'}
        </p>

        <div className="rounded-md bg-muted/50 border border-border p-3 text-xs">
          <p className="font-medium mb-1">Locked out?</p>
          <p className="text-muted-foreground mb-1.5">On the Docker host, this re-opens password sign-in from anywhere:</p>
          <code className="block bg-background rounded px-2 py-1.5 break-all">{view.breakGlassCommand}</code>
        </div>

        {msg && (
          <div className={`text-sm rounded-md px-3 py-2 border ${
            msg.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                   : 'border-destructive/40 bg-destructive/10 text-destructive'}`}>
            {msg.text}
          </div>
        )}

        {writable && <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>}
      </CardContent>
    </Card>
  );
}
