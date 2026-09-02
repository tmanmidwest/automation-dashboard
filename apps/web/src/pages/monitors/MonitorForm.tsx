import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type { MonitorDetail, MonitorInput, MonitorProbeManifest } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { ConfigField } from '@/components/ConfigField';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { TypeIcon } from './monitor-ui';

type Values = Record<string, unknown>;

/** Mirrors MONITOR_MIN_INTERVAL_SEC in @cerebro/shared (the CJS dist doesn't expose named values to Vite). */
const MONITOR_MIN_INTERVAL_SEC = 20;

function defaultsFor(m: MonitorProbeManifest): Values {
  const v: Values = {};
  for (const f of m.fields) if (f.default !== undefined) v[f.key] = f.default;
  return v;
}

const COMMON_DEFAULTS = {
  intervalSec: 60,
  retries: 1,
  retryIntervalSec: 60,
  timeoutSec: 10,
  resendEveryN: 0,
  upsideDown: false,
};

/** Add / edit a monitor. The type-specific fields come from the probe manifest. */
export function MonitorForm() {
  const { id } = useParams();
  const editing = !!id;
  const navigate = useNavigate();

  const [types, setTypes] = useState<MonitorProbeManifest[]>([]);
  const [type, setType] = useState<string>('');
  const [name, setName] = useState('');
  const [config, setConfig] = useState<Values>({});
  const [common, setCommon] = useState(COMMON_DEFAULTS);
  const [tags, setTags] = useState('');
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    async function load() {
      const t = await api.get<MonitorProbeManifest[]>('/api/monitors/types');
      setTypes(t);
      if (editing) {
        const m = await api.get<MonitorDetail>(`/api/monitors/${id}`);
        const manifest = t.find((x) => x.id === m.type);
        setType(m.type);
        setName(m.name);
        setConfig({ ...(manifest ? defaultsFor(manifest) : {}), ...m.config });
        setCommon({
          intervalSec: m.intervalSec, retries: m.retries, retryIntervalSec: m.retryIntervalSec,
          timeoutSec: m.timeoutSec, resendEveryN: m.resendEveryN, upsideDown: m.upsideDown,
        });
        setTags(m.tags.join(', '));
        setDescription(m.description ?? '');
        setEnabled(m.enabled);
      } else if (t.length > 0) {
        setType(t[0].id);
        setConfig(defaultsFor(t[0]));
      }
    }
    load().catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load'));
  }, [id, editing]);

  const manifest = useMemo(() => types.find((t) => t.id === type), [types, type]);

  function pickType(t: MonitorProbeManifest) {
    setType(t.id);
    setConfig(defaultsFor(t));
  }

  function setNum(key: keyof typeof COMMON_DEFAULTS, raw: string) {
    setCommon((c) => ({ ...c, [key]: raw === '' ? ('' as unknown as number) : Number(raw) }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!manifest) return;
    setBusy(true);
    setError(null);
    const payload: MonitorInput = {
      name,
      type,
      config,
      enabled,
      intervalSec: Number(common.intervalSec) || 60,
      retries: Number(common.retries) || 0,
      retryIntervalSec: Number(common.retryIntervalSec) || 60,
      timeoutSec: Number(common.timeoutSec) || 10,
      resendEveryN: Number(common.resendEveryN) || 0,
      upsideDown: common.upsideDown,
      description,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
    };
    try {
      if (editing) {
        await api.put(`/api/monitors/${id}`, payload);
        navigate(`/monitors/${id}`);
      } else {
        const created = await api.post<MonitorDetail>('/api/monitors', payload);
        navigate(`/monitors/${created.id}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Link to={editing ? `/monitors/${id}` : '/monitors'} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-3">
        <ArrowLeft className="h-4 w-4" /> Back
      </Link>
      <PageHeader title={editing ? `Edit ${name || 'monitor'}` : 'Add monitor'} description={editing ? undefined : 'Pick a check type, then tell Cerebro what to watch.'} />

      <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          {!editing && (
            <Card>
              <CardHeader><CardTitle className="text-base">Type</CardTitle></CardHeader>
              <CardContent>
                <div className="grid gap-3 sm:grid-cols-2">
                  {types.map((t) => (
                    <button type="button" key={t.id} onClick={() => pickType(t)}
                      className={cn('flex items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                        type === t.id ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50 hover:bg-muted/40')}>
                      <div className="h-9 w-9 rounded-md bg-primary/15 text-primary grid place-items-center shrink-0"><TypeIcon type={t.id} /></div>
                      <div>
                        <p className="font-medium">{t.label}</p>
                        <p className="text-xs text-muted-foreground">{t.description}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{manifest ? `${manifest.label} check` : 'Check'}</CardTitle>
              {manifest && <CardDescription>{manifest.description}</CardDescription>}
            </CardHeader>
            <CardContent className="space-y-4">
              {error && <div className="text-sm rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2">{error}</div>}
              <div>
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. NAS, Home Assistant, Plex" />
              </div>
              {manifest?.fields.map((f) => (
                <ConfigField key={f.key} field={f} value={config[f.key]} onChange={(v) => setConfig((c) => ({ ...c, [f.key]: v }))} />
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Schedule</CardTitle>
              <CardDescription>How often to check and how tolerant to be before declaring an outage.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <NumberField label="Check interval (seconds)" value={common.intervalSec} min={MONITOR_MIN_INTERVAL_SEC} onChange={(v) => setNum('intervalSec', v)} help={`Minimum ${MONITOR_MIN_INTERVAL_SEC}s.`} />
              <NumberField label="Retries before down" value={common.retries} min={0} max={10} onChange={(v) => setNum('retries', v)} help="Failed checks tolerated (shown as Pending) before the monitor goes Down." />
              <NumberField label="Retry interval (seconds)" value={common.retryIntervalSec} min={MONITOR_MIN_INTERVAL_SEC} onChange={(v) => setNum('retryIntervalSec', v)} help="Check interval while pending." />
              <NumberField label="Timeout (seconds)" value={common.timeoutSec} min={1} max={300} onChange={(v) => setNum('timeoutSec', v)} />
              <NumberField label="Re-notify every N failures" value={common.resendEveryN} min={0} onChange={(v) => setNum('resendEveryN', v)} help="While down, send the alert again every N checks. 0 = only on the transition." />
              <label className="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]" checked={common.upsideDown} onChange={(e) => setCommon((c) => ({ ...c, upsideDown: e.target.checked }))} />
                <span className="text-sm">Upside down<span className="text-muted-foreground"> — treat unreachable as Up and reachable as Down.</span></span>
              </label>
              <label className="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                <span className="text-sm">Enabled</span>
              </label>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Organise</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Tags</Label>
                <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="prod, home, media" />
                <p className="text-xs text-muted-foreground mt-1">Comma-separated. Searchable on the list.</p>
              </div>
              <div>
                <Label>Description</Label>
                <textarea className="flex min-h-[70px] w-full rounded-md border border-input bg-background/60 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
            </CardContent>
          </Card>

          <Button type="submit" disabled={busy || !manifest} className="w-full">
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Add monitor'}
          </Button>
        </div>
      </form>
    </>
  );
}

function NumberField({ label, value, min, max, onChange, help }: { label: string; value: number; min?: number; max?: number; onChange: (raw: string) => void; help?: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <Input type="number" value={value === ('' as unknown as number) ? '' : value} min={min} max={max} required onChange={(e) => onChange(e.target.value)} />
      {help && <p className="text-xs text-muted-foreground mt-1">{help}</p>}
    </div>
  );
}
