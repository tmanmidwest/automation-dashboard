import { useEffect, useState } from 'react';
import { Puzzle } from 'lucide-react';
import type { ConnectorManifest } from '@cerebro/shared';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';

export function Connectors() {
  const [available, setAvailable] = useState<ConnectorManifest[]>([]);

  useEffect(() => {
    api.get<ConnectorManifest[]>('/api/connectors/available').then(setAvailable).catch(() => {});
  }, []);

  return (
    <>
      <PageHeader title="Connectors" description="Extensions that let Cerebro view and manage external systems." />

      {available.length === 0 ? (
        <Card>
          <CardContent className="pt-10 pb-10 text-center">
            <div className="mx-auto h-12 w-12 rounded-xl bg-muted grid place-items-center mb-3">
              <Puzzle className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="font-medium">No connectors installed yet</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              The extension host is ready. Proxmox, AWS, and Entra connectors arrive in a later
              phase — once published they'll appear here to install and configure.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {available.map((m) => (
            <Card key={m.id}>
              <CardContent className="pt-6">
                <p className="font-semibold">{m.name}</p>
                <p className="text-sm text-muted-foreground">{m.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
