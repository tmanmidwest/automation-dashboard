import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { AssistantAgentSummary } from '@cerebro/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { AgentChat } from '@/components/AgentChat';

export function Computer() {
  const { can } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AssistantAgentSummary[] | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  // A question handed over from the ⌘K palette; `askNonce` remounts the chat for each new one.
  const [ask, setAsk] = useState<string | undefined>();
  const [askNonce, setAskNonce] = useState(0);

  useEffect(() => {
    api.get<AssistantAgentSummary[]>('/api/assistant/agents').then(setAgents).catch(() => setAgents([]));
  }, []);

  // Nav state from ⌘K (`{ ask }`) or the agent editor's Chat button (`{ agentId }`). Handled on
  // every change, not just mount, so ⌘K works while already on this page.
  useEffect(() => {
    const state = location.state as { ask?: string; agentId?: string } | null;
    if (!state || (!state.ask && !state.agentId)) return;
    if (state.agentId) setAgentId(state.agentId);
    if (state.ask?.trim()) {
      setAsk(state.ask.trim());
      setAskNonce((n) => n + 1);
    }
    navigate(location.pathname, { replace: true, state: {} }); // clear so a refresh won't resend
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  const agent = agents?.find((a) => a.id === agentId) ?? agents?.find((a) => a.isDefault) ?? agents?.[0] ?? null;
  const notReady = agent && !agent.ready;
  const setupLink = agent && !agent.isDefault ? `/settings/agents/${agent.id}` : '/settings/computer';
  const canSetUp = agent && !agent.isDefault ? can('agents:manage') : can('settings:write');

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <PageHeader
        title="Computer"
        description={
          agent && !agent.isDefault && agent.description
            ? agent.description
            : 'Ask the Computer about your infrastructure. State-changing actions ask you to confirm first.'
        }
        actions={
          agents && agents.length > 1 ? (
            <select
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={agent?.id ?? ''}
              onChange={(e) => { setAsk(undefined); setAgentId(e.target.value); }}
              title="Which agent answers (starts a new conversation)"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}{a.ready ? '' : ' (not ready)'}
                </option>
              ))}
            </select>
          ) : undefined
        }
      />

      {notReady && (
        <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          {agent.isDefault ? "The Computer isn't configured yet." : `The "${agent.name}" agent isn't configured or is disabled.`}{' '}
          {canSetUp ? (
            <Link to={setupLink} className="underline font-medium">
              Set up a model backend →
            </Link>
          ) : (
            'Ask an administrator to configure a model backend.'
          )}
        </div>
      )}

      {agents !== null && (
        // Keyed by agent: switching agents starts a fresh conversation (and drops any paused action).
        <AgentChat
          key={`${agent?.id ?? 'none'}:${askNonce}`}
          className="flex-1"
          agentId={agent?.id}
          disabled={!agent || !!notReady}
          initialQuestion={ask}
          placeholder={agent && !agent.isDefault ? `Ask ${agent.name}…` : 'Ask the Computer…'}
          emptyHint='Try: "which certs expire soon?", "restart the jellyfin container", "what happened last night?"'
        />
      )}
    </div>
  );
}
