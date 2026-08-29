import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Keyboard } from 'lucide-react';
import RFB from '@novnc/novnc';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ConsoleResponse {
  token: string;
  type: string;
  password?: string;
  wsPath: string;
}

export function Console() {
  const { id, kind, resourceId } = useParams();
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    async function start() {
      try {
        const res = await api.post<ConsoleResponse>(`/api/connectors/instances/${id}/console`, { kind, resourceId });
        if (disposed || !screenRef.current) return;
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${proto}//${location.host}${res.wsPath}?token=${encodeURIComponent(res.token)}`;
        const rfb = new RFB(screenRef.current, url, { credentials: { password: res.password } });
        rfb.scaleViewport = true;
        rfb.addEventListener('connect', () => setStatus('connected'));
        rfb.addEventListener('disconnect', (e) => {
          setStatus('disconnected');
          const detail = (e as CustomEvent).detail;
          if (detail && !detail.clean) setError('The console connection was closed.');
        });
        rfb.addEventListener('securityfailure', (e) => {
          const detail = (e as CustomEvent).detail;
          setError(`Authentication failed${detail?.reason ? `: ${detail.reason}` : ''}.`);
        });
        rfbRef.current = rfb;
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to open the console.');
        setStatus('disconnected');
      }
    }
    void start();
    return () => {
      disposed = true;
      try { rfbRef.current?.disconnect(); } catch { /* ignore */ }
    };
  }, [id, kind, resourceId]);

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div className="h-12 shrink-0 bg-sidebar border-b border-border flex items-center justify-between px-4">
        <Link to={`/connectors/${id}`} className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" /> Back to connector
        </Link>
        <div className="flex items-center gap-2 text-sm">
          <span className={cn('inline-flex items-center gap-1.5',
            status === 'connected' ? 'text-emerald-400' : status === 'connecting' ? 'text-amber-400' : 'text-muted-foreground')}>
            <span className={cn('h-2 w-2 rounded-full',
              status === 'connected' ? 'bg-emerald-400' : status === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-muted-foreground')} />
            {status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Disconnected'}
          </span>
          <Button variant="outline" size="sm" disabled={status !== 'connected'}
            onClick={() => rfbRef.current?.sendCtrlAltDel()}>
            <Keyboard className="h-4 w-4" /> Ctrl+Alt+Del
          </Button>
        </div>
      </div>

      {error && (
        <div className="m-3 text-sm rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex-1 relative grid place-items-center">
        {status === 'connecting' && !error && (
          <div className="absolute inset-0 grid place-items-center text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}
        <div ref={screenRef} className="w-full h-full" />
      </div>
    </div>
  );
}
