import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, ChevronRight } from 'lucide-react';
import type { ConnectorInstanceSummary, ConnectorManifest } from '@cerebro/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { ConnectorIcon } from '@/components/ConnectorIcon';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export function ConnectorsList() {
  const { can } = useAuth();
  const writable = can('connectors:write');
  const [instances, setInstances] = useState<ConnectorInstanceSummary[]>([]);
  const [available, setAvailable] = useState<ConnectorManifest[]>([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api.get<ConnectorInstanceSummary[]>('/api/connectors/instances').then(setInstances).catch(() => {});
    api.get<ConnectorManifest[]>('/api/connectors/available').then(setAvailable).catch(() => {});
  }, []);

  return (
    <>
      <PageHeader
        title="Connectors"
        description="Connect Cerebro to external systems to view and manage their resources."
        actions={writable && available.length > 0 && (
          <Button onClick={() => setAdding((a) => !a)}><Plus className="h-4 w-4" /> Add connector</Button>
        )}
      />

      {adding && (
        <Card className="mb-6 border-primary/40">
          <CardContent className="pt-6">
            <p className="text-sm font-medium mb-3">Choose a connector to add</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {available.map((m) => (
                <Link key={m.id} to={`/connectors/new/${m.id}`} onClick={() => setAdding(false)}>
                  <div className="flex items-start gap-3 rounded-lg border border-border p-3 hover:border-primary/50 hover:bg-muted/40 transition-colors">
                    <div className="h-9 w-9 rounded-md bg-primary/15 text-primary grid place-items-center shrink-0">
                      <ConnectorIcon icon={m.icon} className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="font-medium">{m.name}</p>
                      <p className="text-xs text-muted-foreground">{m.description}</p>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {instances.length === 0 ? (
        <Card>
          <CardContent className="pt-10 pb-10 text-center">
            <div className="mx-auto h-12 w-12 rounded-xl bg-muted grid place-items-center mb-3">
              <ConnectorIcon className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="font-medium">No connectors configured yet</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              {writable
                ? 'Add a connector to start managing external systems. Proxmox is available now.'
                : 'Ask an administrator to configure a connector.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {instances.map((inst) => (
            <Link key={inst.id} to={`/connectors/${inst.id}`}>
              <Card className="transition-all hover:border-primary/50">
                <CardContent className="pt-4 pb-4 flex items-center gap-4">
                  <div className="h-10 w-10 rounded-lg bg-primary/15 text-primary grid place-items-center shrink-0">
                    <ConnectorIcon icon={inst.icon} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium truncate">{inst.name}</p>
                      {inst.enabled
                        ? <span className="text-xs rounded-full bg-emerald-500/15 text-emerald-400 px-2 py-0.5">Enabled</span>
                        : <span className="text-xs rounded-full bg-muted text-muted-foreground px-2 py-0.5">Disabled</span>}
                    </div>
                    <p className="text-xs text-muted-foreground">{inst.connectorName}</p>
                  </div>
                  <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
