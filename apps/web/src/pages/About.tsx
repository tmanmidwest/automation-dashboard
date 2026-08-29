import { useEffect, useState } from 'react';
import type { VersionInfo } from '@cerebro/shared';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Brand } from '@/components/Brand';
import { Card, CardContent } from '@/components/ui/card';

export function About() {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  useEffect(() => {
    api.get<VersionInfo>('/api/version').then(setVersion).catch(() => {});
  }, []);

  return (
    <>
      <PageHeader title="About" description="Version and build information." />
      <Card className="max-w-lg">
        <CardContent className="pt-6">
          <Brand className="mb-4 scale-110 origin-left" />
          <dl className="text-sm divide-y divide-border/50">
            <div className="flex justify-between py-2">
              <dt className="text-muted-foreground">Version</dt>
              <dd className="font-mono">{version ? `v${version.version}` : '…'}</dd>
            </div>
            <div className="flex justify-between py-2">
              <dt className="text-muted-foreground">Build (git)</dt>
              <dd className="font-mono">{version?.gitSha ?? '…'}</dd>
            </div>
            <div className="flex justify-between py-2">
              <dt className="text-muted-foreground">Started</dt>
              <dd className="font-mono">{version?.builtAt ? new Date(version.builtAt).toLocaleString() : '…'}</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground mt-4">
            Cerebro — a self-hosted management platform with pluggable connectors.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
