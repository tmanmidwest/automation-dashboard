import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bot, Plus, Star } from 'lucide-react';
import type { AssistantAgentView } from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/** Settings → Agents: every Computer agent profile, with a link into its editor. */
export function Agents() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AssistantAgentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<AssistantAgentView[]>('/api/assistant/agents/manage')
      .then(setAgents)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load agents.'));
  }, []);

  return (
    <>
      <PageHeader
        title="Agents"
        description="Computer agents: each one has its own model, instructions, tools, and who may use it."
        actions={
          <Button onClick={() => navigate('/settings/agents/new')}>
            <Plus className="h-4 w-4" /> New agent
          </Button>
        }
      />
      {error && <p className="text-sm text-red-500 mb-4">{error}</p>}
      {agents === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        {agents?.map((a) => (
          <Link key={a.id} to={`/settings/agents/${a.id}`}>
            <Card className="h-full transition-all hover:border-primary/50">
              <CardContent className="pt-6 flex gap-4">
                <div className="h-10 w-10 rounded-lg bg-primary/15 text-primary grid place-items-center shrink-0">
                  <Bot className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold flex items-center gap-2">
                    {a.name}
                    {a.isDefault && (
                      <span className="inline-flex items-center gap-1 text-xs font-normal text-primary">
                        <Star className="h-3 w-3" /> default
                      </span>
                    )}
                  </p>
                  {a.description && <p className="text-sm text-muted-foreground">{a.description}</p>}
                  <p className="text-xs text-muted-foreground mt-1 truncate">
                    {a.backend} · {a.model || 'no model'} ·{' '}
                    {a.toolMode === 'all' ? 'all tools' : `${a.tools.length} tool${a.tools.length === 1 ? '' : 's'}`}
                    {a.allowedRoles.length > 0 && ` · ${a.allowedRoles.join(', ')}`}
                  </p>
                  <p className={a.ready ? 'text-xs text-emerald-500 mt-1' : 'text-xs text-amber-500 mt-1'}>
                    {a.ready ? 'Ready' : a.enabled ? 'Not configured' : 'Disabled'}
                    {a.zuma.agentId && (
                      <span className={a.zuma.outOfDate || a.zuma.lastError ? 'text-amber-500' : 'text-muted-foreground'}>
                        {' · '}Zuma{a.zuma.status ? `: ${a.zuma.status}` : ''}
                        {a.zuma.lastError ? ' (sync failed)' : a.zuma.outOfDate ? ' (out of date)' : ''}
                      </span>
                    )}
                  </p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
