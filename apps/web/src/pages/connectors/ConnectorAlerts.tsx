import { useEffect, useMemo, useState } from 'react';
import type { OverviewMetric } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatMoney } from '@/lib/utils';

type Severity = 'info' | 'warning' | 'critical';

interface ConnAlert {
  key: string;
  label: string;
  description: string;
  category: string;
  globalEnabled: boolean;
  globalSeverity: Severity;
  globalChannels: string[];
  muted: boolean;
}

/** Per-connector metric thresholds — mirror of server metric-thresholds.ts. */
const THRESHOLD_DEFS = [
  { id: 'cost', metricKey: 'costMtd', alertKey: 'cost.threshold', label: 'Monthly cost' },
  { id: 'storage', metricKey: 'repoSizeGb', alertKey: 'storage.threshold', label: 'Storage size' },
];
const THRESHOLD_ALERT_KEYS = new Set(THRESHOLD_DEFS.map((d) => d.alertKey));

function fmtMetric(m: OverviewMetric): string {
  if (m.unit && /^[A-Z]{3}$/.test(m.unit)) return formatMoney(m.value, m.unit);
  return m.unit ? `${m.value} ${m.unit}` : String(m.value);
}

/** Per-connector alert muting + metric thresholds. Unmuted alerts follow the global rules. */
export function ConnectorAlerts({
  instanceId,
  metrics = [],
}: {
  instanceId: string;
  metrics?: OverviewMetric[];
}) {
  const { can } = useAuth();
  const writable = can('settings:write');
  const [alerts, setAlerts] = useState<ConnAlert[] | null>(null);
  const [thresholds, setThresholds] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api
      .get<{ alerts: ConnAlert[]; thresholds: Record<string, number> }>(
        `/api/settings/notifications/connectors/${instanceId}/alerts`,
      )
      .then((d) => {
        setAlerts(d.alerts);
        const t: Record<string, string> = {};
        for (const [k, v] of Object.entries(d.thresholds ?? {})) t[k] = v ? String(v) : '';
        setThresholds(t);
      })
      .catch(() => setAlerts(null));
  }, [instanceId]);

  // Thresholds this connector actually supports (it reports the underlying metric).
  const activeThresholds = useMemo(
    () =>
      THRESHOLD_DEFS.map((def) => ({ def, metric: metrics.find((m) => m.key === def.metricKey) })).filter(
        (x): x is { def: (typeof THRESHOLD_DEFS)[number]; metric: OverviewMetric } => !!x.metric,
      ),
    [metrics],
  );
  const applicableAlertKeys = useMemo(
    () => new Set(activeThresholds.map((x) => x.def.alertKey)),
    [activeThresholds],
  );

  // Hide threshold alerts whose metric this connector doesn't report.
  const categories = useMemo(() => {
    if (!alerts) return [];
    const map = new Map<string, ConnAlert[]>();
    for (const a of alerts) {
      if (THRESHOLD_ALERT_KEYS.has(a.key) && !applicableAlertKeys.has(a.key)) continue;
      const list = map.get(a.category) ?? [];
      list.push(a);
      map.set(a.category, list);
    }
    return [...map.entries()];
  }, [alerts, applicableAlertKeys]);

  if (!alerts) return null;

  function setMuted(key: string, muted: boolean) {
    setAlerts((list) => (list ? list.map((a) => (a.key === key ? { ...a, muted } : a)) : list));
  }

  async function save() {
    setMsg(null);
    const outThresholds: Record<string, number> = {};
    for (const { def } of activeThresholds) outThresholds[def.id] = Number(thresholds[def.id]) || 0;
    try {
      await api.put(`/api/settings/notifications/connectors/${instanceId}/alerts`, {
        muted: alerts!.filter((a) => a.muted).map((a) => a.key),
        thresholds: outThresholds,
      });
      setMsg({ ok: true, text: 'Alert overrides saved.' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Save failed' });
    }
  }

  function globalSummary(a: ConnAlert): string {
    if (!a.globalEnabled) return 'Global: off';
    const where = a.globalChannels.length ? a.globalChannels.join(', ') : 'no channels';
    return `Global: ${a.globalSeverity} → ${where}`;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Alerts</CardTitle>
        <CardDescription>
          Set thresholds and mute specific alerts for this connector. Anything left unmuted follows
          the global rules on the Notifications settings page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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

        {activeThresholds.length > 0 && (
          <div className="rounded-md border border-border/60 px-3 py-3 space-y-3">
            {activeThresholds.map(({ def, metric }) => (
              <div key={def.id}>
                <Label>{def.label} alert</Label>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-sm text-muted-foreground shrink-0">
                    Alert when it exceeds {metric.unit}
                  </span>
                  <Input
                    type="number"
                    min={0}
                    step="1"
                    className="w-32"
                    value={thresholds[def.id] ?? ''}
                    disabled={!writable}
                    placeholder="0 = off"
                    onChange={(e) => setThresholds((t) => ({ ...t, [def.id]: e.target.value }))}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Currently {fmtMetric(metric)}. Fires once when crossed.
                </p>
              </div>
            ))}
          </div>
        )}

        {categories.map(([category, rows]) => (
          <div key={category}>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
              {category}
            </div>
            <div className="rounded-md border border-border/60 divide-y divide-border/60">
              {rows.map((a) => (
                <div key={a.key} className="flex items-start justify-between gap-4 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">
                      {a.label}
                      {a.muted && (
                        <span className="ml-2 text-[11px] font-normal text-amber-400">muted here</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">{a.description}</div>
                    <div className="text-[11px] text-muted-foreground/80 mt-0.5">{globalSummary(a)}</div>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer shrink-0 pt-0.5">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[hsl(var(--primary))]"
                      checked={a.muted}
                      disabled={!writable}
                      onChange={(e) => setMuted(a.key, e.target.checked)}
                    />
                    <span className="text-sm">Mute</span>
                  </label>
                </div>
              ))}
            </div>
          </div>
        ))}

        {writable && (
          <Button type="button" onClick={save}>
            Save alert overrides
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
