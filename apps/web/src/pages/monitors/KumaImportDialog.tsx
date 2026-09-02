import { useState } from 'react';
import type { MonitorImportResult } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/** Paste or upload an Uptime Kuma backup JSON (Settings → Backup → Export) and import its monitors. */
export function KumaImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MonitorImportResult | null>(null);

  function reset() {
    setText(''); setError(null); setResult(null); setBusy(false);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setText(await f.text());
  }

  async function run() {
    setError(null);
    let backup: unknown;
    try {
      backup = JSON.parse(text);
    } catch {
      setError('That is not valid JSON.');
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<MonitorImportResult>('/api/monitors/import/kuma', { backup });
      setResult(r);
      onImported();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Import from Uptime Kuma"
      description="In Kuma go to Settings → Backup → Export, then upload or paste the JSON here. HTTP, keyword, ping, port and DNS monitors are imported; other types are listed as skipped."
      footer={result ? (
        <Button onClick={() => { reset(); onClose(); }}>Done</Button>
      ) : (
        <>
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button onClick={run} disabled={busy || !text.trim()}>{busy ? 'Importing…' : 'Import'}</Button>
        </>
      )}
    >
      {result ? (
        <div className="space-y-3 text-sm">
          <p className="font-medium">Imported {result.imported} monitor{result.imported === 1 ? '' : 's'}.</p>
          {result.skipped.length > 0 && (
            <div>
              <p className="text-muted-foreground mb-1">Skipped or noted ({result.skipped.length}):</p>
              <ul className="space-y-1 max-h-60 overflow-y-auto">
                {result.skipped.map((s, i) => (
                  <li key={i} className="rounded-md border border-border px-2 py-1">
                    <span className="font-medium">{s.name}</span> <span className="text-muted-foreground">— {s.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {error && <div className="text-sm rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2">{error}</div>}
          <input type="file" accept="application/json,.json" onChange={onFile} className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary/15 file:text-primary file:px-3 file:py-1.5 file:text-sm file:font-medium" />
          <textarea
            className="flex min-h-[160px] w-full rounded-md border border-input bg-background/60 px-3 py-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={text} onChange={(e) => setText(e.target.value)} placeholder='{"version": "1.23.x", "monitorList": [ … ]}' />
        </div>
      )}
    </Dialog>
  );
}
