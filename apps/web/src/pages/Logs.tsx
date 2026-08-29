import { useEffect, useState } from 'react';
import type { AppLogEntry, AuditLogEntry } from '@cerebro/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const LEVEL_COLOR: Record<string, string> = {
  debug: 'text-muted-foreground',
  info: 'text-accent',
  warn: 'text-amber-400',
  error: 'text-destructive',
};

export function Logs() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'app' | 'audit'>('app');
  const [appLogs, setAppLogs] = useState<AppLogEntry[]>([]);
  const [audit, setAudit] = useState<AuditLogEntry[]>([]);

  useEffect(() => {
    if (tab === 'app' && can('logs:read')) {
      api.get<AppLogEntry[]>('/api/logs/app?limit=200').then(setAppLogs).catch(() => {});
    }
    if (tab === 'audit' && can('audit:read')) {
      api.get<AuditLogEntry[]>('/api/logs/audit?limit=200').then(setAudit).catch(() => {});
    }
  }, [tab, can]);

  return (
    <>
      <PageHeader title="Logs" description="Application diagnostics and the audit trail." />

      <div className="inline-flex rounded-lg border border-border p-1 mb-4 bg-card">
        {(['app', 'audit'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'px-4 py-1.5 text-sm rounded-md transition-colors',
              tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t === 'app' ? 'Application' : 'Audit'}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="p-0 font-mono text-xs">
          {tab === 'app' ? (
            <div className="divide-y divide-border/50">
              {appLogs.map((l) => (
                <div key={l.id} className="px-4 py-2 flex gap-3">
                  <span className="text-muted-foreground shrink-0 w-40">
                    {new Date(l.createdAt).toLocaleString()}
                  </span>
                  <span className={cn('shrink-0 w-12 uppercase font-semibold', LEVEL_COLOR[l.level])}>{l.level}</span>
                  <span className="shrink-0 w-28 text-secondary-foreground/80">{l.context}</span>
                  <span className="flex-1 break-all">{l.message}</span>
                </div>
              ))}
              {appLogs.length === 0 && <div className="px-4 py-8 text-center text-muted-foreground">No log entries.</div>}
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {audit.map((a) => (
                <div key={a.id} className="px-4 py-2 flex gap-3">
                  <span className="text-muted-foreground shrink-0 w-40">
                    {new Date(a.createdAt).toLocaleString()}
                  </span>
                  <span className="shrink-0 w-48 text-accent">{a.action}</span>
                  <span className="shrink-0 w-48 text-muted-foreground truncate">{a.actorEmail ?? '—'}</span>
                  <span className="flex-1 break-all text-muted-foreground">{a.target ?? ''}</span>
                </div>
              ))}
              {audit.length === 0 && <div className="px-4 py-8 text-center text-muted-foreground">No audit entries.</div>}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
