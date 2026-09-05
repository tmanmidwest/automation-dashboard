import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Plus, Pencil, Trash2, Maximize2, X, VideoOff, RefreshCw } from 'lucide-react';
import type { ConnectorInstanceSummary, ConnectorResource, ViewscreenCamera, ViewscreenConfig } from '@cerebro/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/** Build the same-origin proxy URL for a camera feed (carries the session cookie). */
function streamUrl(c: Pick<ViewscreenCamera, 'instanceId' | 'entityId' | 'mode'>, bust?: number): string {
  const base = `/api/connectors/instances/${c.instanceId}/resources/camera/${encodeURIComponent(c.entityId)}/stream?mode=${c.mode}`;
  return bust ? `${base}&_t=${bust}` : base;
}

const nativeSelect =
  'flex h-10 w-full rounded-md border border-input bg-background/60 px-3 py-2 text-sm ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

/** One camera feed. MJPEG streams continuously; snapshot mode refreshes a still on an interval. */
function CameraFeed({ camera, className }: { camera: ViewscreenCamera; className?: string }) {
  const [bust, setBust] = useState(() => Date.now());
  const [errored, setErrored] = useState(false);

  // Snapshot mode: poll a fresh still every 5s. MJPEG holds one open connection.
  useEffect(() => {
    if (camera.mode !== 'snapshot') return;
    const t = setInterval(() => setBust(Date.now()), 5000);
    return () => clearInterval(t);
  }, [camera.mode, camera.id]);

  // On error, retry after a short delay (HA/camera may be briefly unreachable).
  useEffect(() => {
    if (!errored) return;
    const t = setTimeout(() => {
      setErrored(false);
      setBust(Date.now());
    }, 4000);
    return () => clearTimeout(t);
  }, [errored]);

  if (errored) {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-2 bg-black/60 text-muted-foreground', className)}>
        <VideoOff className="h-8 w-8" />
        <span className="font-lcars text-sm tracking-[0.14em]">SIGNAL LOST</span>
        <span className="text-[0.65rem] opacity-70">retrying…</span>
      </div>
    );
  }

  return (
    <img
      key={bust}
      src={streamUrl(camera, bust)}
      alt={camera.name}
      className={cn('h-full w-full object-cover bg-black', className)}
      onError={() => setErrored(true)}
    />
  );
}

export function Viewscreen() {
  const { can } = useAuth();
  const canEdit = can('connectors:write');

  const [config, setConfig] = useState<ViewscreenConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ViewscreenCamera | null>(null);
  const [expanded, setExpanded] = useState<ViewscreenCamera | null>(null);

  useEffect(() => {
    api.get<ViewscreenConfig>('/api/settings/viewscreen')
      .then((c) => setConfig({ cameras: c.cameras ?? [], columns: c.columns ?? 3 }))
      .catch((e) => setError(e?.message ?? 'Failed to load the Viewscreen layout.'));
  }, []);

  const persist = useCallback(async (next: ViewscreenConfig) => {
    setConfig(next); // optimistic
    try {
      await api.put('/api/settings/viewscreen', next);
    } catch (e) {
      setError((e as Error)?.message ?? 'Failed to save.');
    }
  }, []);

  const upsertCamera = useCallback((cam: ViewscreenCamera) => {
    if (!config) return;
    const exists = config.cameras.some((c) => c.id === cam.id);
    const cameras = exists ? config.cameras.map((c) => (c.id === cam.id ? cam : c)) : [...config.cameras, cam];
    void persist({ ...config, cameras });
  }, [config, persist]);

  const removeCamera = useCallback((id: string) => {
    if (!config) return;
    void persist({ ...config, cameras: config.cameras.filter((c) => c.id !== id) });
  }, [config, persist]);

  const setColumns = useCallback((columns: number) => {
    if (!config) return;
    void persist({ ...config, columns });
  }, [config, persist]);

  const cols = config?.columns ?? 3;
  const cameras = config?.cameras ?? [];

  return (
    <>
      <PageHeader
        title="Viewscreen"
        description="Live camera feeds streamed through Cerebro from Home Assistant."
        actions={
          canEdit && config ? (
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-lcars tracking-[0.14em]">COLUMNS</span>
                <select
                  className="h-9 rounded-md border border-input bg-background/60 px-2 text-sm"
                  value={cols}
                  onChange={(e) => setColumns(Number(e.target.value))}
                >
                  {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <Button onClick={() => { setEditing(null); setEditorOpen(true); }}>
                <Plus className="h-4 w-4" /> Add camera
              </Button>
            </div>
          ) : undefined
        }
      />

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {config && cameras.length === 0 && (
        <div className="grid place-items-center rounded-xl border border-dashed border-border/60 bg-card/40 py-20 text-center">
          <Camera className="h-10 w-10 text-muted-foreground" />
          <p className="mt-3 font-lcars text-xl">No feeds on the Viewscreen</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            {canEdit
              ? 'Add a camera from a Home Assistant connector to start streaming it here.'
              : 'Ask an administrator to add camera feeds.'}
          </p>
          {canEdit && (
            <Button className="mt-4" onClick={() => { setEditing(null); setEditorOpen(true); }}>
              <Plus className="h-4 w-4" /> Add camera
            </Button>
          )}
        </div>
      )}

      {cameras.length > 0 && (
        <div
          className="grid gap-3 [grid-template-columns:repeat(1,minmax(0,1fr))] sm:[grid-template-columns:repeat(2,minmax(0,1fr))] lg:[grid-template-columns:repeat(var(--vs-cols),minmax(0,1fr))]"
          style={{ ['--vs-cols' as string]: String(cols) }}
        >
          {cameras.map((cam) => (
            <div
              key={cam.id}
              className="group relative overflow-hidden rounded-xl border border-border/60 bg-card"
            >
              <div className="relative aspect-video">
                <CameraFeed camera={cam} />
                {/* top gradient + label */}
                <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent p-2.5">
                  <span className="font-lcars text-sm tracking-wide text-white drop-shadow">{cam.name}</span>
                  <span className="rounded-full bg-black/50 px-2 py-0.5 text-[0.6rem] uppercase tracking-[0.14em] text-white/80">
                    {cam.mode === 'snapshot' ? 'Still' : 'Live'}
                  </span>
                </div>
                {/* hover controls */}
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-end gap-1.5 p-2 opacity-0 transition-opacity group-hover:opacity-100">
                  <Button variant="secondary" size="icon" className="h-8 w-8" title="Expand" onClick={() => setExpanded(cam)}>
                    <Maximize2 className="h-4 w-4" />
                  </Button>
                  {canEdit && (
                    <>
                      <Button variant="secondary" size="icon" className="h-8 w-8" title="Edit"
                        onClick={() => { setEditing(cam); setEditorOpen(true); }}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="destructive" size="icon" className="h-8 w-8" title="Remove"
                        onClick={() => removeCamera(cam.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editorOpen && (
        <CameraEditor
          initial={editing}
          onClose={() => setEditorOpen(false)}
          onSave={(cam) => { upsertCamera(cam); setEditorOpen(false); }}
        />
      )}

      {expanded && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/85 p-4" onClick={() => setExpanded(null)}>
          <div className="relative w-full max-w-6xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <span className="font-lcars text-xl text-white">{expanded.name}</span>
              <Button variant="ghost" size="icon" className="text-white" onClick={() => setExpanded(null)} aria-label="Close">
                <X className="h-5 w-5" />
              </Button>
            </div>
            <div className="aspect-video overflow-hidden rounded-xl border border-border/60">
              <CameraFeed camera={expanded} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Add/edit dialog: pick a Home Assistant instance and one of its camera entities. */
function CameraEditor({
  initial,
  onClose,
  onSave,
}: {
  initial: ViewscreenCamera | null;
  onClose: () => void;
  onSave: (cam: ViewscreenCamera) => void;
}) {
  const [instances, setInstances] = useState<ConnectorInstanceSummary[]>([]);
  const [instanceId, setInstanceId] = useState(initial?.instanceId ?? '');
  const [cameras, setCameras] = useState<ConnectorResource[] | null>(null);
  const [entityId, setEntityId] = useState(initial?.entityId ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [mode, setMode] = useState<'mjpeg' | 'snapshot'>(initial?.mode ?? 'mjpeg');
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const nameTouched = useRef(!!initial);

  // Home Assistant instances are the ones that expose camera entities.
  useEffect(() => {
    api.get<ConnectorInstanceSummary[]>('/api/connectors/instances')
      .then((list) => {
        const ha = list.filter((i) => i.connectorId === 'home-assistant' && i.enabled);
        setInstances(ha);
        if (!initial && ha.length === 1) setInstanceId(ha[0].id);
      })
      .catch((e) => setLoadErr(e?.message ?? 'Failed to load connectors.'));
  }, [initial]);

  // Load camera entities whenever the chosen instance changes.
  useEffect(() => {
    if (!instanceId) { setCameras(null); return; }
    setCameras(null);
    setLoadErr(null);
    api.get<ConnectorResource[]>(`/api/connectors/instances/${instanceId}/resources?kind=camera`)
      .then(setCameras)
      .catch((e) => setLoadErr(e?.message ?? 'Failed to load cameras.'));
  }, [instanceId]);

  // Default the tile name from the chosen camera until the user edits it.
  useEffect(() => {
    if (nameTouched.current || !entityId || !cameras) return;
    const found = cameras.find((c) => c.id === entityId);
    if (found) setName(found.name);
  }, [entityId, cameras]);

  const valid = instanceId && entityId && name.trim();

  const save = () => {
    if (!valid) return;
    onSave({
      id: initial?.id ?? (crypto.randomUUID?.() ?? `cam-${Date.now()}`),
      instanceId,
      entityId,
      name: name.trim(),
      mode,
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={initial ? 'Edit camera' : 'Add camera'}
      description="Feeds are proxied through Cerebro — the Home Assistant token never reaches the browser."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!valid}>{initial ? 'Save' : 'Add'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {loadErr && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {loadErr}
          </div>
        )}

        <div className="space-y-1.5">
          <Label>Home Assistant connector</Label>
          {instances.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No enabled Home Assistant connectors found. Add one under Connectors first.
            </p>
          ) : (
            <select
              className={nativeSelect}
              value={instanceId}
              onChange={(e) => { setInstanceId(e.target.value); setEntityId(''); }}
            >
              <option value="" disabled>Choose a connector…</option>
              {instances.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          )}
        </div>

        <div className="space-y-1.5">
          <Label>Camera</Label>
          <select
            className={nativeSelect}
            value={entityId}
            disabled={!instanceId || cameras === null}
            onChange={(e) => setEntityId(e.target.value)}
          >
            <option value="" disabled>
              {!instanceId ? 'Choose a connector first' : cameras === null ? 'Loading cameras…' : cameras.length === 0 ? 'No cameras found' : 'Choose a camera…'}
            </option>
            {(cameras ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="vs-name">Display name</Label>
          <Input
            id="vs-name"
            value={name}
            onChange={(e) => { nameTouched.current = true; setName(e.target.value); }}
            placeholder="Front door"
          />
        </div>

        <div className="space-y-1.5">
          <Label>Feed type</Label>
          <select className={nativeSelect} value={mode} onChange={(e) => setMode(e.target.value as 'mjpeg' | 'snapshot')}>
            <option value="mjpeg">Live (MJPEG stream)</option>
            <option value="snapshot">Snapshot (refreshes every 5s — lighter)</option>
          </select>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <RefreshCw className="h-3 w-3" />
            Live is smoothest; snapshot uses far less bandwidth for many tiles.
          </p>
        </div>
      </div>
    </Dialog>
  );
}
