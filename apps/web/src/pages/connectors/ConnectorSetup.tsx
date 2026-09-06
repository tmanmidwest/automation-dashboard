import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type { ConnectorConfigField, ConnectorInstanceConfig, ConnectorManifest, SecretSummary } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { ConnectorHelpPanel } from '@/components/ConnectorHelpPanel';
import { ConfigField } from '@/components/ConfigField';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Values = Record<string, unknown>;

function defaultsFor(manifest: ConnectorManifest): Values {
  const v: Values = {};
  for (const f of manifest.configFields) if (f.default !== undefined) v[f.key] = f.default;
  return v;
}

export function ConnectorSetup() {
  const { connectorId, id } = useParams();
  const editing = !!id;
  const navigate = useNavigate();
  const { can } = useAuth();
  const writable = can('connectors:write');

  const [manifest, setManifest] = useState<ConnectorManifest | null>(null);
  const [name, setName] = useState('');
  const [values, setValues] = useState<Values>({});
  const [secretsSet, setSecretsSet] = useState<Record<string, boolean>>({});
  // Per secret field: 'value' = type a literal, 'vault' = reference a shared vault secret.
  const [secretMode, setSecretMode] = useState<Record<string, 'value' | 'vault'>>({});
  const [secretRefs, setSecretRefs] = useState<Record<string, string>>({}); // field → vault key
  const [vaultSecrets, setVaultSecrets] = useState<SecretSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    async function load() {
      // Best-effort — only users with secrets:read get the list; others just don't see the option.
      const vault = await api.get<SecretSummary[]>('/api/secrets').catch(() => [] as SecretSummary[]);
      setVaultSecrets(vault);
      if (editing) {
        const inst = await api.get<ConnectorInstanceConfig>(`/api/connectors/instances/${id}`);
        const m = await api.get<ConnectorManifest>(`/api/connectors/available/${inst.connectorId}`);
        setManifest(m);
        setName(inst.name);
        setValues({ ...defaultsFor(m), ...inst.config });
        setSecretsSet(inst.secretFieldsSet);
        const refs = inst.secretRefs ?? {};
        setSecretRefs(refs);
        setSecretMode(Object.fromEntries(Object.keys(refs).map((k) => [k, 'vault' as const])));
      } else if (connectorId) {
        const m = await api.get<ConnectorManifest>(`/api/connectors/available/${connectorId}`);
        setManifest(m);
        setValues(defaultsFor(m));
      }
    }
    load().catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load'));
  }, [id, connectorId, editing]);

  if (!manifest) return null;

  function setField(key: string, value: unknown) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  /** Build the values payload, turning vault-mode secret fields into `{ $secretRef }`. */
  function buildPayload(): Values {
    const payload: Values = {};
    for (const f of manifest!.configFields) {
      if (!f.secret) {
        payload[f.key] = values[f.key];
        continue;
      }
      if (secretMode[f.key] === 'vault') {
        if (secretRefs[f.key]) payload[f.key] = { $secretRef: secretRefs[f.key] };
        // vault mode with nothing selected → send nothing (keeps existing on edit)
      } else if (values[f.key] != null && values[f.key] !== '') {
        payload[f.key] = values[f.key]; // a literal value (only when filled in)
      }
    }
    return payload;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = buildPayload();
      if (editing) {
        await api.put(`/api/connectors/instances/${id}`, { name, values: payload });
        navigate(`/connectors/${id}`);
      } else {
        const created = await api.post<{ id: string }>('/api/connectors/instances', {
          connectorId: manifest!.id, name, values: payload,
        });
        navigate(`/connectors/${created.id}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Link to={editing ? `/connectors/${id}` : '/connectors'}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-3">
        <ArrowLeft className="h-4 w-4" /> Back
      </Link>
      <PageHeader
        title={editing ? `Edit ${name || manifest.name}` : `Add ${manifest.name}`}
        description={manifest.description}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Configuration</CardTitle>
            <CardDescription>You can add more than one {manifest.name} connection.</CardDescription>
          </CardHeader>
          <CardContent>
            {error && (
              <div className="mb-4 text-sm rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2">
                {error}
              </div>
            )}
            <form onSubmit={submit} className="space-y-4">
              <div>
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!writable} required
                  placeholder={`e.g. Home ${manifest.name}`} />
                <p className="text-xs text-muted-foreground mt-1">A friendly name to tell multiple connections apart.</p>
              </div>

              {manifest.configFields.map((f) =>
                f.secret && vaultSecrets.length > 0 ? (
                  <SecretField
                    key={f.key}
                    field={f}
                    value={values[f.key]}
                    secretSet={secretsSet[f.key]}
                    disabled={!writable}
                    vaultSecrets={vaultSecrets}
                    mode={secretMode[f.key] ?? 'value'}
                    refKey={secretRefs[f.key] ?? ''}
                    onModeChange={(m) => setSecretMode((s) => ({ ...s, [f.key]: m }))}
                    onRefChange={(k) => setSecretRefs((s) => ({ ...s, [f.key]: k }))}
                    onValueChange={(v) => setField(f.key, v)}
                  />
                ) : (
                  <ConfigField key={f.key} field={f} value={values[f.key]} secretSet={secretsSet[f.key]}
                    disabled={!writable} onChange={(v) => setField(f.key, v)} />
                ),
              )}

              {writable && (
                <Button type="submit" disabled={busy}>
                  {busy ? 'Saving…' : editing ? 'Save changes' : `Add ${manifest.name}`}
                </Button>
              )}
            </form>
          </CardContent>
        </Card>

        <ConnectorHelpPanel help={manifest.help} />
      </div>
    </>
  );
}

/** A secret field that can take a literal value OR reference a shared vault secret. */
function SecretField({
  field, value, secretSet, disabled, vaultSecrets, mode, refKey,
  onModeChange, onRefChange, onValueChange,
}: {
  field: ConnectorConfigField;
  value: unknown;
  secretSet?: boolean;
  disabled?: boolean;
  vaultSecrets: SecretSummary[];
  mode: 'value' | 'vault';
  refKey: string;
  onModeChange: (m: 'value' | 'vault') => void;
  onRefChange: (key: string) => void;
  onValueChange: (v: unknown) => void;
}) {
  return (
    <div>
      {!disabled && (
        <div className="flex justify-end mb-1">
          <div className="inline-flex text-xs rounded-md border border-border overflow-hidden">
            {(['value', 'vault'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onModeChange(m)}
                className={cn('px-2.5 py-1 transition-colors',
                  mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                {m === 'value' ? 'Enter value' : 'Use vault secret'}
              </button>
            ))}
          </div>
        </div>
      )}

      {mode === 'vault' ? (
        <div>
          <Label>{field.label}</Label>
          <select
            value={refKey}
            disabled={disabled}
            onChange={(e) => onRefChange(e.target.value)}
            className="mt-1 w-full h-9 rounded-md border border-input bg-background/60 px-2 text-sm"
          >
            <option value="">Select a vault secret…</option>
            {vaultSecrets.map((s) => (
              <option key={s.key} value={s.key}>{s.label} · {s.category}</option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground mt-1">
            References a shared secret from the vault — rotate it once, and every connector using it picks up the change.
          </p>
        </div>
      ) : (
        <ConfigField field={field} value={value} secretSet={secretSet} disabled={disabled} onChange={onValueChange} />
      )}
    </div>
  );
}
