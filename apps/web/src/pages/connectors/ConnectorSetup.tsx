import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type { ConnectorInstanceConfig, ConnectorManifest } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { ConnectorHelpPanel } from '@/components/ConnectorHelpPanel';
import { ConfigField } from '@/components/ConfigField';
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    async function load() {
      if (editing) {
        const inst = await api.get<ConnectorInstanceConfig>(`/api/connectors/instances/${id}`);
        const m = await api.get<ConnectorManifest>(`/api/connectors/available/${inst.connectorId}`);
        setManifest(m);
        setName(inst.name);
        setValues({ ...defaultsFor(m), ...inst.config });
        setSecretsSet(inst.secretFieldsSet);
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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        // Only send secret fields that were actually filled in.
        const payload: Values = {};
        for (const f of manifest!.configFields) {
          if (f.secret) {
            if (values[f.key]) payload[f.key] = values[f.key];
          } else {
            payload[f.key] = values[f.key];
          }
        }
        await api.put(`/api/connectors/instances/${id}`, { name, values: payload });
        navigate(`/connectors/${id}`);
      } else {
        const created = await api.post<{ id: string }>('/api/connectors/instances', {
          connectorId: manifest!.id, name, values,
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

              {manifest.configFields.map((f) => (
                <ConfigField key={f.key} field={f} value={values[f.key]} secretSet={secretsSet[f.key]}
                  disabled={!writable} onChange={(v) => setField(f.key, v)} />
              ))}

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
