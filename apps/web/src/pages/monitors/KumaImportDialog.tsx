import { useState } from 'react';
import type { MonitorImportResult } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Mode = 'db' | 'json';

/**
 * Import monitors from Uptime Kuma. Kuma 2.x has no export, so the primary
 * path is uploading its SQLite database (data/kuma.db). The JSON path covers
 * the 1.x Settings → Backup export, or a `sqlite3 -json` dump of the monitor table.
 */
export function KumaImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const [mode, setMode] = useState<Mode>('db');
  const [dbFile, setDbFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MonitorImportResult | null>(null);

  function reset() {
    setDbFile(null); setText(''); setError(null); setResult(null); setBusy(false);
  }

  async function onJsonFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) setText(await f.text());
  }

  async function run() {
    setError(null);
    setBusy(true);
    try {
      let r: MonitorImportResult;
      if (mode === 'db') {
        if (!dbFile) { setError('Choose your kuma.db file first.'); return; }
        const form = new FormData();
        form.append('file', dbFile);
        const res = await fetch('/api/monitors/import/kuma-db', { method: 'POST', body: form, credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new ApiError(res.status, (data && (data.message || data.error)) || res.statusText);
        r = data as MonitorImportResult;
      } else {
        let backup: unknown;
        try {
          backup = JSON.parse(text);
        } catch {
          setError('That is not valid JSON.');
          return;
        }
        r = await api.post<MonitorImportResult>('/api/monitors/import/kuma', { backup });
      }
      setResult(r);
      onImported();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  const canRun = mode === 'db' ? !!dbFile : !!text.trim();

  return (
    <Dialog
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Import from Uptime Kuma"
      description="HTTP, keyword, ping, port and DNS monitors are imported with their intervals, retries and tags. Other types are listed as skipped."
      footer={result ? (
        <Button onClick={() => { reset(); onClose(); }}>Done</Button>
      ) : (
        <>
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button onClick={run} disabled={busy || !canRun}>{busy ? 'Importing…' : 'Import'}</Button>
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
        <div className="space-y-4">
          {error && <div className="text-sm rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2">{error}</div>}

          <div className="flex rounded-md border border-border overflow-hidden text-sm">
            {([['db', 'Database file (kuma.db)'], ['json', 'Backup JSON']] as [Mode, string][]).map(([m, label]) => (
              <button key={m} type="button" onClick={() => { setMode(m); setError(null); }}
                className={cn('flex-1 px-3 py-1.5', mode === m ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted/40')}>
                {label}
              </button>
            ))}
          </div>

          {mode === 'db' ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Kuma 2.x has no export, so upload its SQLite database instead. It lives in Kuma’s data directory as <span className="font-mono text-foreground">kuma.db</span> (for Docker, the folder you mounted at <span className="font-mono text-foreground">/app/data</span>). Stop Kuma first, or copy the file, so the most recent edits are flushed to it. The file is read once and discarded.
              </p>
              <input type="file" accept=".db,.sqlite,.sqlite3,application/octet-stream,application/x-sqlite3" onChange={(e) => setDbFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary/15 file:text-primary file:px-3 file:py-1.5 file:text-sm file:font-medium" />
              {dbFile && <p className="text-xs text-muted-foreground">{dbFile.name} · {(dbFile.size / 1024 / 1024).toFixed(1)} MB</p>}
              <p className="text-xs text-muted-foreground">Using MariaDB instead of SQLite? Dump the monitor table as JSON and use the Backup JSON tab.</p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Paste a Kuma 1.x backup (Settings → Backup → Export), or a JSON array of rows from the monitor table, e.g. <span className="font-mono text-foreground">sqlite3 -json kuma.db "select * from monitor"</span>.
              </p>
              <input type="file" accept="application/json,.json" onChange={onJsonFile} className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary/15 file:text-primary file:px-3 file:py-1.5 file:text-sm file:font-medium" />
              <textarea
                className="flex min-h-[140px] w-full rounded-md border border-input bg-background/60 px-3 py-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={text} onChange={(e) => setText(e.target.value)} placeholder='{"version": "1.23.x", "monitorList": [ … ]}' />
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
