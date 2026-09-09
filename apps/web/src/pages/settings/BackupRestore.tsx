import { useEffect, useState } from 'react';
import { Loader2, Download, Upload, AlertTriangle, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface BackupInfo { version: string; migration: string | null; pgTools: boolean; signalDir: string }

export function BackupRestore() {
  const [info, setInfo] = useState<BackupInfo | null>(null);

  // Backup form
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [creating, setCreating] = useState(false);
  const [backupMsg, setBackupMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Restore form
  const [file, setFile] = useState<File | null>(null);
  const [restorePass, setRestorePass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { api.get<BackupInfo>('/api/system/backup/info').then(setInfo).catch(() => {}); }, []);

  async function createBackup() {
    setBackupMsg(null);
    if (pass.length < 8) { setBackupMsg({ ok: false, text: 'Use a passphrase of at least 8 characters.' }); return; }
    if (pass !== pass2) { setBackupMsg({ ok: false, text: 'The passphrases do not match.' }); return; }
    setCreating(true);
    try {
      const res = await fetch('/api/system/backup', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: pass }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({ message: 'Backup failed.' })); throw new Error(e.message || 'Backup failed.'); }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const name = /filename="?([^"]+)"?/.exec(cd)?.[1] || 'cerebro-backup.cbak';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      setBackupMsg({ ok: true, text: `Backup downloaded (${(blob.size / 1024).toFixed(0)} KB). Store it and the passphrase safely.` });
      setPass(''); setPass2('');
    } catch (e) { setBackupMsg({ ok: false, text: e instanceof Error ? e.message : 'Backup failed.' }); }
    finally { setCreating(false); }
  }

  async function restore() {
    setRestoreMsg(null);
    if (!file) { setRestoreMsg({ ok: false, text: 'Choose a backup file.' }); return; }
    if (confirm !== 'RESTORE') { setRestoreMsg({ ok: false, text: 'Type RESTORE to confirm.' }); return; }
    setRestoring(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('passphrase', restorePass);
      const res = await fetch('/api/system/restore', { method: 'POST', credentials: 'include', body: fd });
      const data = await res.json().catch(() => ({ message: 'Restore failed.' }));
      if (!res.ok) throw new Error(data.message || 'Restore failed.');
      setRestoreMsg({ ok: true, text: data.message || 'Restore complete.' });
      setConfirm(''); setRestorePass(''); setFile(null);
    } catch (e) { setRestoreMsg({ ok: false, text: e instanceof Error ? e.message : 'Restore failed.' }); }
    finally { setRestoring(false); }
  }

  const Msg = ({ m }: { m: { ok: boolean; text: string } }) => (
    <div className={`text-sm rounded-md px-3 py-2 border ${m.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-destructive/40 bg-destructive/10 text-destructive'}`}>{m.text}</div>
  );

  return (
    <>
      <PageHeader title="Backup &amp; Restore" description="A full, encrypted backup of everything — move Cerebro to another machine." />

      {info && !info.pgTools && (
        <div className="mb-4 flex items-start gap-2 text-sm rounded-md px-3 py-2 border border-amber-500/40 bg-amber-500/10 text-amber-400">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>This image is missing <code>pg_dump</code>/<code>psql</code>. Rebuild with <code>postgresql-client</code> (already in the Dockerfile) to enable backup &amp; restore.</span>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Backup */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><Download className="h-4 w-4 text-primary" /> Create backup</CardTitle>
            <CardDescription>
              Everything — the database, the secrets vault, and Signal state — bundled and encrypted with your passphrase, then downloaded.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label>Passphrase</Label>
              <Input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="At least 8 characters" />
            </div>
            <div>
              <Label>Confirm passphrase</Label>
              <Input type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
            </div>
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5 text-primary" />
              <span>The passphrase is the only thing protecting this file and it is never stored — if you lose it, the backup can't be opened.</span>
            </div>
            {backupMsg && <Msg m={backupMsg} />}
            <Button onClick={createBackup} disabled={creating || !info?.pgTools}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {creating ? 'Building…' : 'Create & download backup'}
            </Button>
          </CardContent>
        </Card>

        {/* Restore */}
        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><Upload className="h-4 w-4 text-destructive" /> Restore</CardTitle>
            <CardDescription>Replace <strong>everything</strong> on this machine with the contents of a backup file. This is destructive and cannot be undone.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label>Backup file (.cbak)</Label>
              <Input type="file" accept=".cbak" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
            <div>
              <Label>Passphrase</Label>
              <Input type="password" autoComplete="off" value={restorePass} onChange={(e) => setRestorePass(e.target.value)} />
            </div>
            <div>
              <Label>Type <span className="font-mono text-destructive">RESTORE</span> to confirm</Label>
              <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="RESTORE" />
            </div>
            {restoreMsg && <Msg m={restoreMsg} />}
            <Button variant="destructive" onClick={restore} disabled={restoring || !info?.pgTools || confirm !== 'RESTORE' || !file}>
              {restoring ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {restoring ? 'Restoring…' : 'Restore from backup'}
            </Button>
            <p className="text-xs text-muted-foreground">After a restore, restart the Cerebro container and sign in again — the restart applies any pending schema migrations.</p>
          </CardContent>
        </Card>
      </div>

      {info && (
        <p className="mt-4 text-xs text-muted-foreground">
          This server: Cerebro v{info.version}{info.migration ? ` · schema ${info.migration}` : ''}. A backup from a newer version can't be restored here — deploy the matching version first.
        </p>
      )}
    </>
  );
}
