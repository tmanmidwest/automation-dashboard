import { Link } from 'react-router-dom';
import { ShieldCheck, Mail, Bell, KeyRound, Boxes, Lock, DatabaseBackup, Cpu } from 'lucide-react';
import type { Permission } from '@cerebro/shared';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';

type SettingsSection = { to: string; icon: React.ComponentType<{ className?: string }>; title: string; desc: string; perm?: Permission };

export function SettingsHome() {
  const { can } = useAuth();
  // Annotate the array literal (not the .filter() result) so the `perm` string literals
  // are checked against Permission instead of widening to `string`.
  const allSections: SettingsSection[] = [
    { to: '/settings/authentication', icon: ShieldCheck, title: 'Authentication', desc: 'Local accounts and OIDC single sign-on.' },
    { to: '/settings/email', icon: Mail, title: 'Email', desc: 'Outbound SMTP server for notifications.' },
    { to: '/settings/notifications', icon: Bell, title: 'Notifications', desc: 'Outbound alerts by email and SMS.' },
    { to: '/settings/secrets', icon: Lock, title: 'Secrets Vault', desc: 'Stored credentials, rotation policies, and last-used tracking.', perm: 'secrets:read' },
    { to: '/settings/api-tokens', icon: KeyRound, title: 'API Tokens', desc: 'Bearer tokens for programmatic API and MCP access.' },
    { to: '/settings/oauth-clients', icon: Boxes, title: 'OAuth Clients', desc: 'Register MCP/API clients that connect via OAuth.' },
    { to: '/settings/backup', icon: DatabaseBackup, title: 'Backup & Restore', desc: 'Full encrypted backup you can move to another machine.', perm: 'settings:write' },
    { to: '/settings/computer', icon: Cpu, title: 'Computer', desc: 'In-app LLM assistant — self-hosted or OpenAI-compatible model backend.', perm: 'settings:write' },
  ];
  const sections = allSections.filter((s) => !s.perm || can(s.perm));
  return (
    <>
      <PageHeader title="Settings" description="Everything is configured here — no files to edit." />
      <div className="grid gap-4 sm:grid-cols-2">
        {sections.map((s) => (
          <Link key={s.to} to={s.to}>
            <Card className="h-full transition-all hover:border-primary/50">
              <CardContent className="pt-6 flex gap-4">
                <div className="h-10 w-10 rounded-lg bg-primary/15 text-primary grid place-items-center shrink-0">
                  <s.icon className="h-5 w-5" />
                </div>
                <div>
                  <p className="font-semibold">{s.title}</p>
                  <p className="text-sm text-muted-foreground">{s.desc}</p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
