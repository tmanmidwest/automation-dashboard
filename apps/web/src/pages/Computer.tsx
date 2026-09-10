import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Send, Cpu, Wrench, CheckCircle2, XCircle, Loader2, ShieldAlert, AlertTriangle } from 'lucide-react';
import type {
  AssistantChatMessage,
  AssistantConfigView,
  AssistantPendingCall,
  AssistantStreamEvent,
} from '@cerebro/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** A tool call rendered inline in the transcript while the assistant works. */
interface ToolEvent {
  name: string;
  status: 'running' | 'ok' | 'error';
  summary?: string;
}

interface PendingConfirm {
  pendingId: string;
  call: AssistantPendingCall;
}

/** One message in the visible transcript. Assistant messages may carry tool events. */
interface TranscriptMessage extends AssistantChatMessage {
  tools?: ToolEvent[];
  streaming?: boolean;
  pending?: PendingConfirm | null;
}

export function Computer() {
  const { can } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [config, setConfig] = useState<AssistantConfigView | null>(null);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoAsked = useRef(false);

  useEffect(() => {
    api.get<AssistantConfigView>('/api/assistant/config').then(setConfig).catch(() => setConfig(null));
  }, []);

  // A question handed over from the ⌘K palette (navigate('/computer', { state: { ask } })).
  useEffect(() => {
    const ask = (location.state as { ask?: string } | null)?.ask?.trim();
    if (!ask || autoAsked.current || !config?.ready) return;
    autoAsked.current = true;
    navigate(location.pathname, { replace: true, state: {} }); // clear so a refresh won't resend
    void send(ask);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, location.state]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Mutate the last (assistant) message.
  const patchLast = (fn: (m: TranscriptMessage) => TranscriptMessage) =>
    setMessages((prev) => prev.map((m, i) => (i === prev.length - 1 ? fn(m) : m)));

  /** Read one SSE response body into the current assistant message. */
  async function consume(res: Response): Promise<void> {
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '');
      patchLast((m) => ({ ...m, content: m.content || `⚠ ${t || `Request failed (${res.status})`}`, streaming: false }));
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 2);
        if (!frame.startsWith('data:')) continue;
        const event = JSON.parse(frame.slice(5).trim()) as AssistantStreamEvent;
        if (event.type === 'token') {
          patchLast((m) => ({ ...m, content: m.content + event.text }));
        } else if (event.type === 'tool_call') {
          patchLast((m) => ({ ...m, tools: [...(m.tools ?? []), { name: event.name, status: 'running' }] }));
        } else if (event.type === 'tool_result') {
          patchLast((m) => {
            const tools = [...(m.tools ?? [])];
            for (let i = tools.length - 1; i >= 0; i--) {
              if (tools[i].name === event.name && tools[i].status === 'running') {
                tools[i] = { name: event.name, status: event.ok ? 'ok' : 'error', summary: event.summary };
                break;
              }
            }
            return { ...m, tools };
          });
        } else if (event.type === 'confirm_required') {
          patchLast((m) => ({ ...m, pending: { pendingId: event.pendingId, call: event.call }, streaming: false }));
          return; // wait for the operator; the server closed this stream
        } else if (event.type === 'error') {
          patchLast((m) => ({ ...m, content: m.content || `⚠ ${event.message}`, streaming: false }));
          return;
        } else if (event.type === 'done') {
          patchLast((m) => ({ ...m, streaming: false }));
          return;
        }
      }
    }
    patchLast((m) => ({ ...m, streaming: false }));
  }

  async function send(textOverride?: string) {
    const text = (textOverride ?? input).trim();
    if (!text || busy) return;
    setInput('');

    const history: AssistantChatMessage[] = [
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: text },
    ];

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text },
      { role: 'assistant', content: '', tools: [], streaming: true },
    ]);
    setBusy(true);
    try {
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      });
      await consume(res);
    } catch (err) {
      patchLast((m) => ({ ...m, content: m.content || `⚠ ${err instanceof Error ? err.message : String(err)}`, streaming: false }));
    } finally {
      setBusy(false);
    }
  }

  async function respond(pending: PendingConfirm, approve: boolean) {
    if (busy) return;
    patchLast((m) => ({ ...m, pending: null, streaming: true }));
    setBusy(true);
    try {
      const res = await fetch('/api/assistant/resume', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingId: pending.pendingId, approve }),
      });
      await consume(res);
    } catch (err) {
      patchLast((m) => ({ ...m, content: m.content || `⚠ ${err instanceof Error ? err.message : String(err)}`, streaming: false }));
    } finally {
      setBusy(false);
    }
  }

  const notReady = config && !config.ready;

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <PageHeader
        title="Computer"
        description="Ask the Computer about your infrastructure. State-changing actions ask you to confirm first."
      />

      {notReady && (
        <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          The Computer isn't configured yet.{' '}
          {can('settings:write') ? (
            <Link to="/settings/computer" className="underline font-medium">
              Set up a model backend →
            </Link>
          ) : (
            'Ask an administrator to configure a model backend.'
          )}
        </div>
      )}

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded-md border border-border/60 bg-card/40 p-4 space-y-4"
      >
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-3">
            <Cpu className="h-10 w-10 opacity-40" />
            <p className="text-sm">Try: "which certs expire soon?", "restart the jellyfin container", "what happened last night?"</p>
          </div>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={i} message={m} onRespond={respond} busy={busy} />
        ))}
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          placeholder="Ask the Computer…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy || !!notReady}
        />
        <Button type="submit" disabled={busy || !input.trim() || !!notReady}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </form>
    </div>
  );
}

function MessageBubble({
  message,
  onRespond,
  busy,
}: {
  message: TranscriptMessage;
  onRespond: (p: PendingConfirm, approve: boolean) => void;
  busy: boolean;
}) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap break-words',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted',
        )}
      >
        {(message.tools ?? []).length > 0 && (
          <div className="mb-2 space-y-1">
            {message.tools!.map((t, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs opacity-80">
                {t.status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
                {t.status === 'ok' && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
                {t.status === 'error' && <XCircle className="h-3 w-3 text-red-500" />}
                <Wrench className="h-3 w-3" />
                <span className="font-mono">{t.name}</span>
                {t.summary && t.status !== 'running' && (
                  <span className="truncate max-w-[24rem] opacity-60">{t.summary}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {message.content ||
          (message.streaming && (message.tools ?? []).length === 0 ? (
            <Loader2 className="h-4 w-4 animate-spin opacity-60" />
          ) : (
            ''
          ))}

        {message.pending && <ConfirmCard pending={message.pending} onRespond={onRespond} busy={busy} />}
      </div>
    </div>
  );
}

function ConfirmCard({
  pending,
  onRespond,
  busy,
}: {
  pending: PendingConfirm;
  onRespond: (p: PendingConfirm, approve: boolean) => void;
  busy: boolean;
}) {
  const { call } = pending;
  const args = Object.entries(call.args);
  return (
    <div
      className={cn(
        'mt-2 rounded-md border p-3 text-sm',
        call.destructive ? 'border-red-500/50 bg-red-500/10' : 'border-amber-500/50 bg-amber-500/10',
      )}
    >
      <div className="flex items-center gap-2 font-medium">
        {call.destructive ? <ShieldAlert className="h-4 w-4 text-red-500" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}
        The Computer wants to run <span className="font-mono">{call.name}</span>
        {call.destructive && <span className="text-xs uppercase tracking-wide text-red-500">destructive</span>}
      </div>
      {args.length > 0 && (
        <div className="mt-2 space-y-0.5 font-mono text-xs opacity-80">
          {args.map(([k, v]) => (
            <div key={k}>
              <span className="opacity-60">{k}:</span> {typeof v === 'string' ? v : JSON.stringify(v)}
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Button size="sm" variant={call.destructive ? 'destructive' : 'default'} disabled={busy} onClick={() => onRespond(pending, true)}>
          Approve
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onRespond(pending, false)}>
          Deny
        </Button>
      </div>
    </div>
  );
}
