import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Keyboard } from 'lucide-react';
import RFB from '@novnc/novnc';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ConsoleResponse {
  token: string;
  type: 'vnc' | 'terminal';
  password?: string;
  wsPath: string;
}

export function Console() {
  const { id, kind, resourceId } = useParams();
  const [params] = useSearchParams();
  const mode = params.get('mode') === 'serial' ? 'serial' : 'vnc';
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];

    async function start() {
      try {
        const res = await api.post<ConsoleResponse>(`/api/connectors/instances/${id}/console`, { kind, resourceId, mode });
        if (disposed || !screenRef.current) return;
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${proto}//${location.host}${res.wsPath}?token=${encodeURIComponent(res.token)}`;

        if (res.type === 'terminal') {
          startTerminal(url, screenRef.current, cleanups, setStatus, setError);
        } else {
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
          cleanups.push(() => { try { rfb.disconnect(); } catch { /* ignore */ } });
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to open the console.');
        setStatus('disconnected');
      }
    }
    void start();
    return () => {
      disposed = true;
      cleanups.forEach((c) => c());
    };
  }, [id, kind, resourceId, mode]);

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div className="h-12 shrink-0 bg-sidebar border-b border-border flex items-center justify-between px-4">
        <Link to={`/connectors/${id}`} className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" /> Back to connector
        </Link>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-xs uppercase tracking-wider text-muted-foreground mr-1">{mode === 'serial' ? 'Serial' : 'VNC'}</span>
          <span className={cn('inline-flex items-center gap-1.5',
            status === 'connected' ? 'text-emerald-400' : status === 'connecting' ? 'text-amber-400' : 'text-muted-foreground')}>
            <span className={cn('h-2 w-2 rounded-full',
              status === 'connected' ? 'bg-emerald-400' : status === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-muted-foreground')} />
            {status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Disconnected'}
          </span>
          {mode === 'vnc' && (
            <Button variant="outline" size="sm" disabled={status !== 'connected'}
              onClick={() => rfbRef.current?.sendCtrlAltDel()}>
              <Keyboard className="h-4 w-4" /> Ctrl+Alt+Del
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="m-3 text-sm rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex-1 relative grid place-items-center">
        {status === 'connecting' && !error && (
          <div className="absolute inset-0 grid place-items-center text-muted-foreground pointer-events-none">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}
        <div ref={screenRef} className={cn('w-full h-full', mode === 'serial' && 'p-2')} />
      </div>
    </div>
  );
}

/** Serial console over Proxmox's termproxy protocol (xterm.js). */
function startTerminal(
  url: string,
  target: HTMLElement,
  cleanups: Array<() => void>,
  setStatus: (s: 'connecting' | 'connected' | 'disconnected') => void,
  setError: (e: string | null) => void,
) {
  const term = new Terminal({ cursorBlink: true, fontSize: 14, fontFamily: 'ui-monospace, monospace', theme: { background: '#000000' } });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(target);
  fit.fit();

  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const sendResize = () => {
    if (ws.readyState === WebSocket.OPEN) ws.send(`1:${term.cols}:${term.rows}:`);
  };

  ws.onopen = () => {
    setStatus('connected');
    fit.fit();
    sendResize();
  };
  ws.onmessage = (ev) => {
    term.write(typeof ev.data === 'string' ? ev.data : dec.decode(ev.data as ArrayBuffer));
  };
  ws.onclose = () => setStatus('disconnected');
  ws.onerror = () => setError('The serial connection was closed.');

  // Proxmox termproxy input protocol: "0:<byteLength>:<data>".
  const onData = term.onData((d) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(`0:${enc.encode(d).length}:${d}`);
  });

  const ro = new ResizeObserver(() => { fit.fit(); sendResize(); });
  ro.observe(target);

  cleanups.push(() => {
    onData.dispose();
    ro.disconnect();
    try { ws.close(); } catch { /* ignore */ }
    term.dispose();
  });
}
