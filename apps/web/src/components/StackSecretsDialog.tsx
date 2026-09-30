import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleSlash, KeyRound, Loader2, TriangleAlert, Upload, X } from 'lucide-react';
import type { BindSecretInput, SecretSummary, StackSecretsReport, StackSecretView } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';

const selectCls = 'h-8 rounded-md border border-input bg-background/60 px-2 text-xs';

const STATE_ICON: Record<string, typeof CheckCircle2> = {
  bound: CheckCircle2,
  drifted: TriangleAlert,
  missing: TriangleAlert,
  unbound: CircleSlash,
};
const STATE_COLOR: Record<string, string> = {
  bound: 'text-emerald-400',
  drifted: 'text-amber-400',
  missing: 'text-amber-400',
  unbound: 'text-muted-foreground',
};
const STATE_TEXT: Record<string, string> = {
  bound: 'in the vault',
  drifted: 'vault value has changed',
  missing: 'vault key is gone',
  unbound: 'not in the vault',
};

/**
 * What the vault knows about one stack's credentials, and the two ways to fix a
 * gap: bind a variable to a key that already exists, or promote its live value
 * into a new one. Promotion is the migration path from "a password somebody
 * typed into an .env on a bare host" to something a restore can re-materialize.
 */
export function StackSecretsDialog({ instanceId, stackName, canWrite, onClose, onChanged }: {
  instanceId: string;
  stackName: string;
  canWrite: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [report, setReport] = useState<StackSecretsReport | null>(null);
  const [vaultKeys, setVaultKeys] = useState<SecretSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bindFor, setBindFor] = useState<string | null>(null);
  const [bindKey, setBindKey] = useState('');
  const [onlySecretish, setOnlySecretish] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      setReport(await api.get<StackSecretsReport>(
        `/api/stack-backup/secrets/${instanceId}/${encodeURIComponent(stackName)}`,
      ));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not read this stack’s secrets.');
    } finally {
      setLoading(false);
    }
  }, [instanceId, stackName]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    // Best-effort: needs secrets:read, and the dialog still works without it.
    api.get<SecretSummary[]>('/api/secrets').then(setVaultKeys).catch(() => setVaultKeys([]));
  }, []);

  async function act(key: string, body: BindSecretInput) {
    setBusy(key); setErr(null);
    try {
      setReport(await api.post<StackSecretsReport>(
        `/api/stack-backup/secrets/${instanceId}/${encodeURIComponent(stackName)}/bind`, body,
      ));
      setBindFor(null); setBindKey('');
      onChanged?.();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  async function unbind(varName: string) {
    setBusy(varName); setErr(null);
    try {
      setReport(await api.delete<StackSecretsReport>(
        `/api/stack-backup/secrets/${instanceId}/${encodeURIComponent(stackName)}/bind/${encodeURIComponent(varName)}`,
      ));
      onChanged?.();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  const shown = (report?.variables ?? []).filter((v) => !onlySecretish || v.secretish || v.vaultKey);

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={`${stackName} — secrets`}
      description="Matched against the vault by keyed digest: no plaintext is compared, and looking does not mark a secret as used."
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      {err && <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</div>}

      {loading && !report ? (
        <div className="py-8 text-center"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></div>
      ) : !report ? null : (
        <div className="space-y-4">
          <div
            className={`rounded-md border px-3 py-2 text-sm ${
              report.referenceReady
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-border bg-muted/30'
            }`}
          >
            {report.referenceReady ? (
              <>Every credential here is in the vault — this stack can use <strong>vault-reference</strong> backups, which store no secret values at all.</>
            ) : (
              <>Vault-reference backups are not available yet: {report.referenceBlockedBy}</>
            )}
          </div>

          {report.fileSecrets.length > 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              <div className="font-medium mb-1">Credentials in host files — not captured by a backup</div>
              <ul className="list-disc pl-4 space-y-0.5">
                {report.fileSecrets.map((f) => <li key={f} className="font-mono break-all">{f}</li>)}
              </ul>
            </div>
          )}

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={onlySecretish} onChange={(e) => setOnlySecretish(e.target.checked)} />
            Only credential-looking variables ({report.variables.length - shown.length} hidden)
          </label>

          <div className="divide-y divide-border">
            {shown.map((v) => (
              <SecretRow
                key={v.name}
                v={v}
                canWrite={canWrite}
                busy={busy === v.name}
                binding={bindFor === v.name}
                bindKey={bindKey}
                vaultKeys={vaultKeys}
                onStartBind={() => { setBindFor(v.name); setBindKey(v.vaultKey ?? ''); }}
                onCancelBind={() => setBindFor(null)}
                onBindKeyChange={setBindKey}
                onBind={() => act(v.name, { varName: v.name, vaultKey: bindKey })}
                onPromote={() => act(v.name, { varName: v.name, promote: true })}
                onUnbind={() => unbind(v.name)}
              />
            ))}
            {!shown.length && <p className="py-3 text-sm text-muted-foreground">No variables to show.</p>}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function SecretRow({
  v, canWrite, busy, binding, bindKey, vaultKeys,
  onStartBind, onCancelBind, onBindKeyChange, onBind, onPromote, onUnbind,
}: {
  v: StackSecretView;
  canWrite: boolean;
  busy: boolean;
  binding: boolean;
  bindKey: string;
  vaultKeys: SecretSummary[];
  onStartBind: () => void;
  onCancelBind: () => void;
  onBindKeyChange: (v: string) => void;
  onBind: () => void;
  onPromote: () => void;
  onUnbind: () => void;
}) {
  const Icon = STATE_ICON[v.state] ?? CircleSlash;
  return (
    <div className="py-2.5">
      <div className="flex items-start gap-3 flex-wrap">
        <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${STATE_COLOR[v.state] ?? ''}`} />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm break-all">{v.name}</div>
          <div className="text-xs text-muted-foreground">
            <span className={STATE_COLOR[v.state]}>{STATE_TEXT[v.state] ?? v.state}</span>
            {v.vaultKey && <> · <span className="font-mono">{v.vaultKey}</span></>}
            {v.origin && <> · {v.origin === 'inferred' ? 'matched by value' : v.origin}</>}
            {v.containers.length > 0 && <> · {v.containers.join(', ')}</>}
          </div>
        </div>
        {canWrite && !binding && (
          <div className="flex items-center gap-1 shrink-0">
            {v.state === 'unbound' && (
              <Button size="sm" variant="outline" disabled={busy} onClick={onPromote} title="Write the live value into the vault and bind to it">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1.5" />}
                Promote
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={onStartBind}>
              <KeyRound className="h-3.5 w-3.5 mr-1.5" /> Bind
            </Button>
            {v.origin === 'declared' && (
              <Button size="icon" variant="ghost" disabled={busy} onClick={onUnbind} aria-label="Clear declaration">
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        )}
      </div>

      {binding && (
        <div className="mt-2 pl-7 flex items-end gap-2 flex-wrap">
          <div className="min-w-64 flex-1">
            <Label className="text-xs">Vault key</Label>
            {vaultKeys.length ? (
              <select className={`${selectCls} mt-1 w-full`} value={bindKey} onChange={(e) => onBindKeyChange(e.target.value)}>
                <option value="">Choose a key…</option>
                {vaultKeys.map((k) => <option key={k.key} value={k.key}>{k.key} — {k.label}</option>)}
              </select>
            ) : (
              <Input className="mt-1 h-8 text-xs" value={bindKey} onChange={(e) => onBindKeyChange(e.target.value)} placeholder="vault key" />
            )}
          </div>
          <Button size="sm" disabled={!bindKey || busy} onClick={onBind}>
            {busy && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />} Bind
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancelBind}>Cancel</Button>
        </div>
      )}
    </div>
  );
}
