import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, CheckCircle2, XCircle, Rocket, ChevronRight, ChevronDown, Ban, Camera } from 'lucide-react';
import type { ConnectorOperation, ConnectorOption, ConnectorJobStatus, SecretSummary } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type Values = Record<string, unknown>;

/** Vault secrets of a given kind (e.g. 'git') as dropdown options, with a blank "none" first. */
async function vaultSecretOptions(kind: string): Promise<ConnectorOption[]> {
  const secrets = await api.get<SecretSummary[]>('/api/secrets').catch(() => [] as SecretSummary[]);
  const opts = secrets.filter((s) => s.kind === kind).map((s) => ({ value: s.key, label: s.label || s.key }));
  return [{ value: '', label: '— none (public repo) —' }, ...opts];
}

function initialValues(op: ConnectorOperation): Values {
  const v: Values = {};
  for (const f of op.fields) if (f.default !== undefined) v[f.key] = f.default;
  return v;
}

/**
 * Read an image file into a data-URL, downscaling large images so the payload
 * stays small (avatars don't need to be big, and the JSON body has a size cap).
 * Small images are passed through untouched to preserve their exact bytes/format.
 */
function imageToDataUrl(file: File, maxDim = 512, passthroughBytes = 60 * 1024): Promise<string> {
  const readRaw = () =>
    new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(file);
    });

  if (file.size <= passthroughBytes) return readRaw();

  return readRaw().then(
    (raw) =>
      new Promise<string>((resolve) => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const g = canvas.getContext('2d');
          if (!g) return resolve(raw);
          g.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.onerror = () => resolve(raw);
        img.src = raw;
      }),
  );
}

export function OperationDialog({
  instanceId,
  operation,
  resourceId,
  extraValues,
  seed,
  open,
  onClose,
  onDone,
}: {
  instanceId: string;
  operation: ConnectorOperation;
  resourceId?: string;
  /** Values merged into the submission (e.g. { kind } for resource-scoped ops). */
  extraValues?: Record<string, unknown>;
  /** Initial form field values (e.g. prefill a stack name when importing). */
  seed?: Record<string, unknown>;
  open: boolean;
  onClose: () => void;
  onDone: (createdResourceId?: string) => void;
}) {
  const [values, setValues] = useState<Values>(() => ({ ...initialValues(operation), ...seed }));
  const [optionsMap, setOptionsMap] = useState<Record<string, ConnectorOption[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'form' | 'running' | 'done'>('form');
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<ConnectorJobStatus | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Inline camera capture for `image` fields (tablet/kiosk setup). Only one at a time.
  const [cameraKey, setCameraKey] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canCamera = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraKey(null);
  }, []);

  const startCamera = useCallback(async (key: string) => {
    setError(null);
    try {
      // 'environment' is a hint (not exact) — desktops fall back to the default webcam.
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      streamRef.current = stream;
      setCameraKey(key);
    } catch {
      setError('Could not access the camera. Check permissions, or choose a file instead.');
    }
  }, []);

  const capturePhoto = useCallback((key: string, set: (k: string, v: unknown) => void) => {
    const video = videoRef.current;
    if (!video) return;
    const maxDim = 512;
    const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
    const scale = Math.min(1, maxDim / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale)), h = Math.max(1, Math.round(vh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const g = canvas.getContext('2d');
    if (g) { g.drawImage(video, 0, 0, w, h); set(key, canvas.toDataURL('image/jpeg', 0.82)); }
    stopCamera();
  }, [stopCamera]);

  // Attach the stream once the <video> is mounted, and always stop the camera
  // when the dialog closes or leaves the form phase.
  useEffect(() => {
    if (cameraKey && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [cameraKey]);
  useEffect(() => { if (!open || phase !== 'form') stopCamera(); }, [open, phase, stopCamera]);
  useEffect(() => () => stopCamera(), [stopCamera]);

  // Reset when (re)opened.
  useEffect(() => {
    if (open) {
      setValues({ ...initialValues(operation), ...seed });
      setOptionsMap({});
      setError(null);
      setPhase('form');
      setJobId(null);
      setJob(null);
      setShowLog(false);
      setCancelling(false);
    }
  }, [open, operation]);

  const optionFields = useMemo(() => operation.fields.filter((f) => f.optionsSource), [operation]);
  // Dependencies may come from form fields or from injected extraValues (e.g. the guest's node).
  const depFor = (d: string) => values[d] ?? extraValues?.[d];
  const depsSignature = JSON.stringify(optionFields.map((f) => (f.dependsOn ?? []).map((d) => depFor(d))));

  // Load dynamic dropdown options (and refresh when dependencies change).
  useEffect(() => {
    if (!open || phase !== 'form') return;
    optionFields.forEach(async (f) => {
      const deps = f.dependsOn ?? [];
      if (deps.some((d) => !depFor(d))) {
        setOptionsMap((m) => ({ ...m, [f.key]: [] }));
        return;
      }
      try {
        // `vault:<kind>` is populated directly from the secrets API (a vault-secret picker),
        // not the connector's options endpoint.
        const opts = f.optionsSource?.startsWith('vault:')
          ? await vaultSecretOptions(f.optionsSource.slice('vault:'.length))
          : await api.post<ConnectorOption[]>(`/api/connectors/instances/${instanceId}/options`, {
              sourceId: f.optionsSource, values: { ...extraValues, ...values },
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

  // Prefill field values from the connector (current CPU/RAM, the chosen template's specs, ...).
  const prefillDeps = operation.prefillDependsOn ?? [];
  const prefillSig = JSON.stringify(prefillDeps.map((k) => values[k]));
  useEffect(() => {
    if (!open || phase !== 'form' || !operation.prefill) return;
    let cancelled = false;
    api
      .post<Record<string, unknown>>(`/api/connectors/instances/${instanceId}/operations/${operation.id}/defaults`, {
        resourceId,
        values: { ...values, ...extraValues },
      })
      .then((d) => {
        if (!cancelled && d && Object.keys(d).length) setValues((v) => ({ ...v, ...d }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phase, prefillSig]);

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
        { resourceId, values: { ...values, ...extraValues } },
      );
      setJobId(jid);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start');
      setPhase('form');
    }
  }

  async function cancelJob() {
    if (!jobId) return;
    setCancelling(true);
    try {
      await api.post(`/api/connectors/instances/${instanceId}/jobs/${jobId}/cancel`, {});
    } catch {
      /* the poll will reflect the outcome */
    }
  }

  const footer =
    phase === 'form' ? (
      <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit}><Rocket className="h-4 w-4" /> {operation.submitLabel ?? 'Run'}</Button>
      </>
    ) : phase === 'running' ? (
      <Button variant="ghost" onClick={cancelJob} disabled={cancelling}>
        {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />} {cancelling ? 'Cancelling…' : 'Cancel operation'}
      </Button>
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
      size={operation.fields.some((f) => f.type === 'textarea') ? 'lg' : 'default'}
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
                  <textarea rows={16} value={String(values[f.key] ?? '')} placeholder={f.placeholder}
                    onChange={(e) => setField(f.key, e.target.value)}
                    onKeyDown={(e) => {
                      // Tab inserts two spaces (YAML) instead of moving focus.
                      if (e.key === 'Tab' && !e.shiftKey) {
                        e.preventDefault();
                        const ta = e.currentTarget;
                        const s = ta.selectionStart, en = ta.selectionEnd;
                        const cur = String(values[f.key] ?? '');
                        setField(f.key, cur.slice(0, s) + '  ' + cur.slice(en));
                        requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
                      }
                    }}
                    spellCheck={false} autoComplete="off" autoCapitalize="off"
                    className="mt-1 block w-full min-h-[16rem] max-h-[60vh] resize-y rounded-md border border-input bg-background/60 px-3 py-2 text-sm leading-snug placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring font-mono" />
                  {f.help && <p className="text-xs text-muted-foreground mt-1">{f.help}</p>}
                </div>
              );
            }
            if (f.type === 'image') {
              const preview = typeof values[f.key] === 'string' && String(values[f.key]).startsWith('data:') ? String(values[f.key]) : '';
              const camActive = cameraKey === f.key;
              return (
                <div key={f.key}>
                  <Label>{f.label}{f.required && <span className="text-primary"> *</span>}</Label>
                  {camActive ? (
                    <div className="mt-1 space-y-2">
                      <video ref={videoRef} autoPlay playsInline muted
                        className="w-full max-h-64 rounded-md border border-input bg-black object-contain" />
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => capturePhoto(f.key, setField)}><Camera className="h-4 w-4" /> Capture</Button>
                        <Button variant="ghost" size="sm" onClick={stopCamera}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-1 flex items-center gap-3 flex-wrap">
                      {preview && <img src={preview} alt="preview" className="h-16 w-16 rounded-md object-cover border border-input" />}
                      <input type="file" accept="image/*" className="text-sm"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          try { setField(f.key, await imageToDataUrl(file)); }
                          catch { setError('Could not read that image.'); }
                        }} />
                      {canCamera && <Button variant="secondary" size="sm" onClick={() => startCamera(f.key)}><Camera className="h-4 w-4" /> Take photo</Button>}
                      {preview && <Button variant="ghost" size="sm" onClick={() => setField(f.key, '')}>Clear</Button>}
                    </div>
                  )}
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
          <div>
            {(job?.steps?.length ?? 0) > 0 && (
              <button type="button" onClick={() => setShowLog((v) => !v)}
                className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors">
                {showLog ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                Activity ({job?.steps?.length ?? 0})
              </button>
            )}
            <div className={cn('mt-2 space-y-1.5', showLog && 'max-h-48 overflow-y-auto pr-1')}>
              {/* Collapsed: show just the latest line; expanded: the full log. */}
              {(showLog ? (job?.steps ?? []) : (job?.steps ?? []).slice(-1)).map((s, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                  <span className="text-muted-foreground break-all">{s}</span>
                </div>
              ))}
              {phase === 'running' && (
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                  <span>{cancelling ? 'Cancelling…' : 'Working…'}</span>
                </div>
              )}
            </div>
          </div>
          {phase === 'done' && job && (
            <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
              job.status === 'success' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                                       : 'border-destructive/40 bg-destructive/10 text-destructive')}>
              {job.status === 'success' ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" /> : <XCircle className="h-4 w-4 shrink-0 mt-0.5" />}
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs max-h-64 overflow-y-auto">{job.message}</span>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
