import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import type { FabricSessionTicket } from '@cerebro/shared';
import { SshTerminal, RdpViewer, VncViewer } from './Fabric';

/**
 * Standalone full-tab session viewer. The Fabric page mints the one-time ticket
 * and hands it to this tab via same-origin localStorage (the key is in the URL,
 * the ticket is not), which we read exactly once and then render the matching
 * viewer. Opened in a new browser tab so multiple sessions can run at once.
 */
interface Handoff {
  kind: 'ssh' | 'rdp' | 'vnc';
  ticket: FabricSessionTicket;
  title: string;
  dynamicResize?: boolean;
  vncCreds?: { username?: string; password?: string };
}

export function FabricSession() {
  const [params] = useSearchParams();
  const key = params.get('k');
  const [data, setData] = useState<Handoff | null | undefined>(undefined);

  useEffect(() => {
    if (!key) {
      setData(null);
      return;
    }
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        localStorage.removeItem(key); // single use
        setData(JSON.parse(raw) as Handoff);
      } else {
        setData(null);
      }
    } catch {
      setData(null);
    }
  }, [key]);

  if (data === undefined) {
    return (
      <div className="fixed inset-0 grid place-items-center bg-black text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="fixed inset-0 grid place-items-center bg-black text-muted-foreground text-sm">
        <div className="text-center">
          <p>This session has expired or was already opened.</p>
          <button className="mt-2 text-primary hover:underline" onClick={() => window.close()}>
            Close tab
          </button>
        </div>
      </div>
    );
  }

  const onClose = () => window.close();
  if (data.kind === 'ssh') return <SshTerminal session={data.ticket} title={data.title} onClose={onClose} />;
  if (data.kind === 'rdp')
    return <RdpViewer session={data.ticket} title={data.title} dynamicResize={!!data.dynamicResize} onClose={onClose} />;
  return <VncViewer session={data.ticket} title={data.title} creds={data.vncCreds} onClose={onClose} />;
}
