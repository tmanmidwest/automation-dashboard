import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn, timeAgo } from '@/lib/utils';

type Severity = 'info' | 'warning' | 'critical';
type Status = 'sent' | 'failed' | 'held' | 'throttled';

interface HistoryEntry {
  id: string;
  alertKey: string | null;
  title: string;
  severity: Severity;
  source: string | null;
  channel: string;
  status: Status;
  recipients: number;
  connectorId: string | null;
  detail: string | null;
  createdAt: string;
}

const CHANNEL_LABEL: Record<string, string> = { email: 'Email', textbelt: 'SMS', signal: 'Signal' };

const SEVERITY_DOT: Record<Severity, string> = {
  info: 'bg-sky-400',
  warning: 'bg-amber-400',
  critical: 'bg-red-500',
};

const STATUS_BADGE: Record<Status, string> = {
  sent: 'text-emerald-400 bg-emerald-500/15',
  failed: 'text-destructive bg-destructive/15',
  held: 'text-amber-400 bg-amber-500/15',
  throttled: 'text-muted-foreground bg-muted',
};

const selectClass =
  'h-9 rounded-md border border-input bg-transparent px-2 text-sm text-muted-foreground';

export function NotificationHistory() {
  const [rows, setRows] = useState<HistoryEntry[] | null>(null);
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState('');

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (channel) q.set('channel', channel);
    if (status) q.set('status', status);
    q.set('limit', '100');
    api
      .get<HistoryEntry[]>(`/api/settings/notifications/history?${q.toString()}`)
      .then(setRows)
      .catch(() => setRows([]));
  }, [channel, status]);

  useEffect(() => load(), [load]);

  return (
    <Card>
      <CardContent className="pt-6 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <select className={selectClass} value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">All channels</option>
            <option value="email">Email</option>
            <option value="textbelt">SMS</option>
            <option value="signal">Signal</option>
          </select>
          <select className={selectClass} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All outcomes</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
            <option value="held">Held (quiet hours)</option>
            <option value="throttled">Throttled</option>
          </select>
          <Button variant="ghost" size="sm" onClick={load}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead className="text-left text-muted-foreground border-b border-border">
              <tr>
                <th className="py-2 pr-4 font-medium">When</th>
                <th className="py-2 pr-4 font-medium">Alert</th>
                <th className="py-2 pr-4 font-medium">Channel</th>
                <th className="py-2 pr-4 font-medium">Outcome</th>
                <th className="py-2 font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows?.map((r) => (
                <tr key={r.id} className="border-b border-border/60 align-top">
                  <td className="py-2.5 pr-4 whitespace-nowrap text-muted-foreground" title={new Date(r.createdAt).toLocaleString()}>
                    {timeAgo(r.createdAt)}
                  </td>
                  <td className="py-2.5 pr-4">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn('h-2 w-2 rounded-full shrink-0', SEVERITY_DOT[r.severity])}
                        title={r.severity}
                      />
                      <span className="min-w-0">{r.title}</span>
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 whitespace-nowrap">{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                  <td className="py-2.5 pr-4">
                    <span className={cn('inline-block rounded px-1.5 py-0.5 text-xs font-medium', STATUS_BADGE[r.status])}>
                      {r.status}
                    </span>
                  </td>
                  <td className="py-2.5 text-muted-foreground">{r.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows && rows.length === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No notifications yet. They’ll appear here as alerts fire (and when you send a test).
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
