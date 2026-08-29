import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, CheckCircle2, XCircle, Rocket } from 'lucide-react';
import type { ConnectorOperation, ConnectorOption, ConnectorJobStatus } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type Values = Record<string, unknown>;

function initialValues(op: ConnectorOperation): Values {
  const v: Values = {};
  for (const f of op.fields) if (f.default !== undefined) v[f.key] = f.default;
  return v;
}

export function OperationDialog({
  instanceId,
  operation,
  resourceId,
  open,
  onClose,
  onDone,
}: {
  instanceId: string;
  operation: ConnectorOperation;
  resourceId?: string;
  open: boolean;
  onClose: () => void;
  onDone: (createdResourceId?: string) => void;
}) {
  const [values, setValues] = useState<Values>(() => initialValues(operation));
  const [optionsMap, setOptionsMap] = useState<Record<string, ConnectorOption[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'form' | 'running' | 'done'>('form');
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<ConnectorJobStatus | null>(null);

  // Reset when (re)opened.
  useEffect(() => {
    if (open) {
      setValues(initialValues(operation));
      setOptionsMap({});
      setError(null);
      setPhase('form');
      setJobId(null);
      setJob(null);
    }
  }, [open, operation]);

  const optionFields = useMemo(() => operation.fields.filter((f) => f.optionsSource), [operation]);
  const depsSignature = JSON.stringify(optionFields.map((f) => (f.dependsOn ?? []).map((d) => values[d])));

  // Load dynamic dropdown options (and refresh when dependencies change).
  useEffect(() => {
    if (!open || phase !== 'form') return;
    optionFields.forEach(async (f) => {
      const deps = f.dependsOn ?? [];
      if (deps.some((d) => !values[d])) {
        setOptionsMap((m) => ({ ...m, [f.key]: [] }));
        return;
      }
      try {
        const opts = await api.post<ConnectorOption[]>(`/api/connectors/instances/${instanceId}/options`, {
          sourceId: f.optionsSource, values,
        });
        setOptionsMap((m) => ({ ...m, [f.key]: opts }));
        // Clear a now-invalid selection.
        setValues((v) => (v[f.key] && !opts.some((o) => o.value === v[f.key]) ? { ...v, [f.key]: '' } : v));
      } catch {
        setOptionsMap((m) => ({ ...m, [f.key]: [] }));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsSignature, open, phase]);

  const pollJob = useCallback(async (jid: string) => {
    try {
      const j = await api.get<ConnectorJobStatus>(`/api/connectors/instances/${instanceId}/jobs/${jid}`);
      setJob(j);
      if (j.status !== 'running') setPhase('done');
    } catch {
      /* keep polling */
    }
  }, [instanceId]);

  useEffect(() => {
    if (!jobId || phase !== 'running') return;
    void pollJob(jobId);
    const t = setInterval(() => pollJob(jobId), 1500);
    return () => clearInterval(t);
  }, [jobId, phase, pollJob]);

  const visible = (fieldKey: string) => {
    const f = operation.fields.find((x) => x.key === fieldKey)!;
    if (!f.showWhen) return true;
    return values[f.showWhen.field] === f.showWhen.equals;
  };

  function setField(key: string, value: unknown) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function submit() {
    setError(null);
    // Basic required check on visible fields.
    for (const f of operation.fields) {
      if (f.required && visible(f.key) && (values[f.key] === undefined || values[f.key] === '')) {
        setError(`${f.label} is required.`);
        return;
      }
    }
    setPhase('running');
    try {
      const { jobId: jid } = await api.post<{ jobId: string }>(
        `/api/connectors/instances/${instanceId}/operations/${operation.id}`,
        { resourceId, values },
      );
      setJobId(jid);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start');
      setPhase('form');
    }
  }

  const footer =
    phase === 'form' ? (
      <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit}><Rocket className="h-4 w-4" /> {operation.submitLabel ?? 'Run'}</Button>
      </>
    ) : phase === 'done' ? (
      <>
        {job?.status === 'success' && job.createdResourceId && (
          <Button variant="secondary" onClick={() => onDone(job.createdResourceId)}>View resource</Button>
        )}
        <Button onClick={() => { onDone(job?.createdResourceId); }}>Done</Button>
      </>
    ) : null;

  return (
    <Dialog open={open} onClose={phase === 'running' ? () => {} : onClose}
      title={operation.label} description={operation.description} footer={footer}>
      {phase === 'form' && (
        <div className="space-y-4">
          {error && <div className="text-sm rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2">{error}</div>}
          {operation.fields.filter((f) => visible(f.key)).map((f) => {
            const opts = f.options ?? optionsMap[f.key] ?? [];
            if (f.type === 'boolean') {
              return (
                <label key={f.key} className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]"
                    checked={values[f.key] === true} onChange={(e) => setField(f.key, e.target.checked)} />
                  <span className="text-sm">{f.label}</span>
                </label>
              );
            }
            if (f.type === 'select') {
              const loading = f.optionsSource && !f.options && optionsMap[f.key] === undefined;
              return (
                <div key={f.key}>
                  <Label>{f.label}{f.required && <span className="text-primary"> *</span>}</Label>
                  <select className="flex h-10 w-full rounded-md border border-input bg-background/60 px-3 text-sm"
                    value={String(values[f.key] ?? '')} onChange={(e) => setField(f.key, e.target.value)}>
                    <option value="">{loading ? 'Loading…' : opts.length ? 'Select…' : '(none available)'}</option>
                    {opts.map((o) => {
                      const desc = (o as ConnectorOption).description;
                      return <option key={o.value} value={o.value}>{o.label}{desc ? ` — ${desc}` : ''}</option>;
                    })}
                  </select>
                  {f.help && <p className="text-xs text-muted-foreground mt-1">{f.help}</p>}
                </div>
              );
            }
            if (f.type === 'textarea') {
              return (
                <div key={f.key}>
                  <Label>{f.label}{f.required && <span className="text-primary"> *</span>}</Label>
                  <textarea rows={3} value={String(values[f.key] ?? '')} placeholder={f.placeholder}
                    onChange={(e) => setField(f.key, e.target.value)}
                    className="flex w-full rounded-md border border-input bg-background/60 px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring font-mono" />
                  {f.help && <p className="text-xs text-muted-foreground mt-1">{f.help}</p>}
                </div>
              );
            }
            const inputType = f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text';
            return (
              <div key={f.key}>
                <Label>{f.label}{f.required && <span className="text-primary"> *</span>}</Label>
                <Input type={inputType} value={String(values[f.key] ?? '')} placeholder={f.placeholder}
                  onChange={(e) => setField(f.key, f.type === 'number' ? Number(e.target.value) : e.target.value)} />
                {f.help && <p className="text-xs text-muted-foreground mt-1">{f.help}</p>}
              </div>
            );
          })}
        </div>
      )}

      {phase !== 'form' && (
        <div className="space-y-3">
          <div className="space-y-2">
            {(job?.steps ?? []).map((s, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                <span className="text-muted-foreground">{s}</span>
              </div>
            ))}
            {phase === 'running' && (
              <div className="flex items-center gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                <span>Working…</span>
              </div>
            )}
          </div>
          {phase === 'done' && job && (
            <div className={cn('flex items-center gap-2 rounded-md border px-3 py-2 text-sm',
              job.status === 'success' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                                       : 'border-destructive/40 bg-destructive/10 text-destructive')}>
              {job.status === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              {job.message}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
