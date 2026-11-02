import { useState } from 'react';
import { Ban, Check, CheckCheck, Crosshair, X } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/components/ui/button';

/** A network client Cerebro has seen (GET /api/devices). */
export interface NetworkDevice {
  mac: string;
  instanceId: string;
  name: string | null;
  vendor: string | null;
  ip: string | null;
  network: string | null;
  via: string | null;
  deviceType: string | null;
  typeOverride: string | null;
  privateMac: boolean;
  status: 'new' | 'known' | 'blocked';
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface DeviceList {
  devices: NetworkDevice[];
  alertPrivateMacs: boolean;
}

/** Blocks a client on the UniFi gateway (the connector's own Block action) after a confirm. */
export async function blockClient(instanceId: string, mac: string, name: string): Promise<boolean> {
  if (!window.confirm(`Block ${name} (${mac}) on the UniFi gateway?\n\nIt will be disconnected and can't rejoin until you unblock it (UniFi connector → Blocked clients).`)) return false;
  await api.post(`/api/connectors/instances/${encodeURIComponent(instanceId)}/resources/client/${encodeURIComponent(mac)}/actions/block`, {});
  await api.post(`/api/devices/${encodeURIComponent(mac)}/review`, { status: 'blocked' }).catch(() => undefined);
  return true;
}

/** "Block" for one UniFi client, shown on a device's open row. */
export function BlockButton({ instanceId, mac, name, onDone }: { instanceId: string; mac: string; name: string; onDone?: () => void }) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'idle' | 'done' | string>('idle');
  if (!can('connectors:action')) return null;
  if (state === 'done') return <span className="text-sm text-red-500 self-center">Blocked</span>;
  return (
    <>
      <Button size="sm" variant="outline" disabled={busy} title={state !== 'idle' ? state : 'Block this device on the UniFi gateway'}
        className="text-red-600 dark:text-red-400 border-red-500/40 hover:bg-red-500/10"
        onClick={async () => {
          setBusy(true);
          try {
            if (await blockClient(instanceId, mac, name)) { setState('done'); onDone?.(); }
          } catch (e) {
            setState(e instanceof Error ? e.message : 'Block failed');
          } finally {
            setBusy(false);
          }
        }}>
        <Ban className="h-3.5 w-3.5" /> Block
      </Button>
      {state !== 'idle' && <span className="text-xs text-red-500 self-center">{state}</span>}
    </>
  );
}

const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

/** The open row for Needs attention → New devices. */
export function NewDevicesRow({ list, onChanged, onShow, onClose }: {
  list: DeviceList;
  onChanged: () => void;
  onShow: (mac: string) => void;
  onClose: () => void;
}) {
  const { can } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = can('connectors:action');

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-primary/50 bg-primary/[0.04] p-4 flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-base font-semibold">New devices</h3>
        <span className="text-sm text-muted-foreground">Joined the network since Cerebro started watching. Mark the ones you recognise as known, block the rest.</span>
        <span className="ml-auto flex flex-wrap gap-2">
          {act && list.devices.length > 1 && (
            <Button size="sm" variant="outline" disabled={!!busy}
              onClick={() => window.confirm(`Mark all ${list.devices.length} new devices as known?`) && run('all', () => api.post('/api/devices/review-all', {}))}>
              <CheckCheck className="h-3.5 w-3.5" /> Mark all as known
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
        </span>
      </div>

      {err && <div className="text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">{err}</div>}

      {list.devices.length === 0 ? (
        <div className="text-sm text-muted-foreground">Nothing new. You'll get a "New device on the network" alert when something joins.</div>
      ) : (
        <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
          {list.devices.map((d) => {
            const name = d.name ?? d.mac;
            return (
              <div key={d.mac} className="rounded-lg border border-amber-400/60 bg-card px-3.5 py-3 flex flex-col gap-2 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="h-2 w-2 rounded-full shrink-0 bg-amber-400" />
                  <span className="text-[15px] font-semibold truncate">{name}</span>
                  <span className="ml-auto text-xs text-muted-foreground shrink-0">{ago(d.firstSeenAt)}</span>
                </div>
                <DeviceType type={d.typeOverride ?? d.deviceType} source={d.typeOverride ? 'You' : d.deviceType ? 'Guess' : null}
                  mac={d.mac} instanceId={d.instanceId} onSaved={() => onChanged()} />
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px]">
                  <dt className="text-muted-foreground">MAC</dt>
                  <dd className="font-mono truncate">{d.mac}{d.privateMac && <span className="ml-1.5 font-sans text-xs text-muted-foreground">(private)</span>}</dd>
                  <dt className="text-muted-foreground">Maker</dt>
                  <dd className="truncate">{d.vendor ?? (d.privateMac ? 'Hidden (private MAC, usually a phone or tablet)' : 'Unknown')}</dd>
                  {d.ip && <><dt className="text-muted-foreground">IP</dt><dd className="truncate">{d.ip}</dd></>}
                  {d.network && <><dt className="text-muted-foreground">Network</dt><dd className="truncate">{d.network}</dd></>}
                  {d.via && <><dt className="text-muted-foreground">Connected via</dt><dd className="truncate">{d.via}</dd></>}
                </dl>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button size="sm" variant="outline" onClick={() => onShow(d.mac)}><Crosshair className="h-3.5 w-3.5" /> Show</Button>
                  {act && (
                    <>
                      <Button size="sm" variant="outline" disabled={!!busy}
                        onClick={() => run(d.mac, () => api.post(`/api/devices/${encodeURIComponent(d.mac)}/review`, { status: 'known' }))}>
                        <Check className="h-3.5 w-3.5" /> Mark as known
                      </Button>
                      <Button size="sm" variant="outline" disabled={!!busy}
                        className="text-red-600 dark:text-red-400 border-red-500/40 hover:bg-red-500/10"
                        onClick={() => run(d.mac, () => blockClient(d.instanceId, d.mac, name))}>
                        <Ban className="h-3.5 w-3.5" /> Block
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {can('connectors:write') && (
        <label className={cn('flex items-center gap-2 text-sm text-muted-foreground', busy === 'setting' && 'opacity-60')}>
          <input type="checkbox" checked={list.alertPrivateMacs} disabled={busy === 'setting'}
            onChange={(e) => { const on = e.target.checked; run('setting', () => api.put('/api/devices/settings', { alertPrivateMacs: on })); }} />
          Also send an alert for private-MAC devices (phones and tablets that randomize their address; usually guests)
        </label>
      )}
    </div>
  );
}

/** Common answers for "what is this?"; any text is allowed. */
const TYPE_CHOICES = [
  'Smart TV', 'Streaming player', 'Phone', 'Tablet', 'Laptop', 'Computer', 'Printer', 'Camera', 'Doorbell camera',
  'Smart speaker', 'Speaker', 'Game console', 'Thermostat', 'Smart lighting', 'Smart plug / IoT', 'Appliance',
  'Coffee maker', 'Robot vacuum', 'NAS / storage', 'Server', 'Virtual machine', 'Network gear', 'Car', 'Unknown',
];

/**
 * "Type: Smart TV (guess from maker) · Set type": what a device is, with a small editor to
 * say what it really is. The type the user sets wins over UniFi's and Cerebro's guesses.
 */
export function DeviceType({ type, model, source, mac, instanceId, onSaved }: {
  type?: string | null;
  model?: string | null;
  source?: string | null;
  mac: string;
  instanceId?: string;
  onSaved: (type: string | null) => void;
}) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(type ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canEdit = !!instanceId && can('connectors:action');
  const listId = `types-${mac}`;

  const save = async (v: string | null) => {
    if (!instanceId) return;
    setBusy(true);
    setErr(null);
    try {
      await api.put(`/api/devices/${encodeURIComponent(mac)}/type`, { instanceId, type: v });
      setEditing(false);
      onSaved(v);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <form className="flex flex-wrap items-center gap-2 text-sm" onSubmit={(e) => { e.preventDefault(); save(value.trim() || null); }}>
        <span className="text-muted-foreground">Type</span>
        <input autoFocus list={listId} value={value} onChange={(e) => setValue(e.target.value)} maxLength={60} placeholder="e.g. Smart TV"
          className="h-8 w-56 rounded-md border border-border bg-background px-2 text-sm" />
        <datalist id={listId}>{TYPE_CHOICES.map((t) => <option key={t} value={t} />)}</datalist>
        <Button size="sm" type="submit" disabled={busy}>Save</Button>
        {source === 'You' && <Button size="sm" type="button" variant="outline" disabled={busy} onClick={() => save(null)}>Use the guess</Button>}
        <Button size="sm" type="button" variant="ghost" onClick={() => { setEditing(false); setValue(type ?? ''); }}>Cancel</Button>
        {err && <span className="text-xs text-red-500">{err}</span>}
      </form>
    );
  }
  const from = source === 'You' ? 'set by you' : source ? source.charAt(0).toLowerCase() + source.slice(1) : null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="text-muted-foreground">Type</span>
      {type ? <span className="font-medium">{type}{model ? ` · ${model}` : ''}</span> : <span className="text-muted-foreground">Not known</span>}
      {from && <span className={cn('rounded px-1.5 py-0.5 text-[11px] leading-none', source === 'You' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground')}>{from}</span>}
      {canEdit && <button className="text-accent hover:underline text-sm" onClick={() => { setValue(type ?? ''); setEditing(true); }}>{type ? 'Change' : 'Set type'}</button>}
    </span>
  );
}
