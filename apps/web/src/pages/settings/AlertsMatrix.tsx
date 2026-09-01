import { Fragment, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SeveritySelect, type Severity } from './notify-ui';

interface ChannelInfo {
  id: string;
  label: string;
  enabled: boolean;
  ready: boolean;
}
interface AlertRow {
  key: string;
  label: string;
  description: string;
  category: string;
  severity: Severity;
  enabled: boolean;
  channels: string[];
}
interface AlertsData {
  channels: ChannelInfo[];
  alerts: AlertRow[];
}

/** Short note on whether a channel can actually deliver right now. */
function channelHint(c: ChannelInfo): string {
  if (!c.enabled) return 'off';
  if (!c.ready) return 'no recipients';
  return '';
}

export function AlertsMatrix({ writable }: { writable: boolean }) {
  const [data, setData] = useState<AlertsData | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.get<AlertsData>('/api/settings/notifications/alerts').then(setData).catch(() => {});
  }, []);

  const categories = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, AlertRow[]>();
    for (const a of data.alerts) {
      const list = map.get(a.category) ?? [];
      list.push(a);
      map.set(a.category, list);
    }
    return [...map.entries()];
  }, [data]);

  if (!data) return null;

  function updateAlert(key: string, fn: (a: AlertRow) => AlertRow) {
    setData((d) => (d ? { ...d, alerts: d.alerts.map((a) => (a.key === key ? fn(a) : a)) } : d));
  }

  function toggleChannel(key: string, chId: string, on: boolean) {
    updateAlert(key, (a) => ({
      ...a,
      channels: on ? [...new Set([...a.channels, chId])] : a.channels.filter((c) => c !== chId),
    }));
  }

  async function save() {
    setMsg(null);
    try {
      await api.put('/api/settings/notifications/alerts', {
        alerts: data!.alerts.map(({ key, enabled, severity, channels }) => ({
          key,
          enabled,
          severity,
          channels,
        })),
      });
      setMsg({ ok: true, text: 'Alert rules saved.' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Save failed' });
    }
  }

  return (
    <Card>
      <CardContent className="pt-6 space-y-4">
        {msg && (
          <div
            className={`text-sm rounded-md px-3 py-2 border ${
              msg.ok
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                : 'border-destructive/40 bg-destructive/10 text-destructive'
            }`}
          >
            {msg.text}
          </div>
        )}

        <p className="text-sm text-muted-foreground">
          Turn each alert on or off, set how loud it is, and pick which channels it goes to. An
          alert only sends to channels that are enabled and have recipients.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border">
                <th className="py-2 pr-4 font-medium">Alert</th>
                <th className="py-2 px-3 font-medium text-center">On</th>
                <th className="py-2 px-3 font-medium">Severity</th>
                {data.channels.map((c) => (
                  <th key={c.id} className="py-2 px-3 font-medium text-center whitespace-nowrap">
                    {c.label}
                    {channelHint(c) && (
                      <span className="block text-[11px] font-normal text-amber-400/80">
                        {channelHint(c)}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {categories.map(([category, rows]) => (
                <Fragment key={category}>
                  <tr>
                    <td
                      colSpan={3 + data.channels.length}
                      className="pt-4 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      {category}
                    </td>
                  </tr>
                  {rows.map((a) => (
                    <tr key={a.key} className="border-b border-border/60 align-top">
                      <td className="py-3 pr-4">
                        <div className="font-medium">{a.label}</div>
                        <div className="text-xs text-muted-foreground">{a.description}</div>
                      </td>
                      <td className="py-3 px-3 text-center">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[hsl(var(--primary))]"
                          checked={a.enabled}
                          disabled={!writable}
                          onChange={(e) => updateAlert(a.key, (x) => ({ ...x, enabled: e.target.checked }))}
                        />
                      </td>
                      <td className="py-3 px-3">
                        <div className="w-32">
                          <SeveritySelect
                            value={a.severity}
                            disabled={!writable || !a.enabled}
                            onChange={(v) => updateAlert(a.key, (x) => ({ ...x, severity: v }))}
                          />
                        </div>
                      </td>
                      {data.channels.map((c) => (
                        <td key={c.id} className="py-3 px-3 text-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-[hsl(var(--primary))]"
                            checked={a.channels.includes(c.id)}
                            disabled={!writable || !a.enabled}
                            onChange={(e) => toggleChannel(a.key, c.id, e.target.checked)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {writable && (
          <Button type="button" onClick={save}>
            Save alert rules
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
