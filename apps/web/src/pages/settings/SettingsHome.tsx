import { Link } from 'react-router-dom';
import { ShieldCheck, Mail, Bell, KeyRound } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';

export function SettingsHome() {
  const sections = [
    { to: '/settings/authentication', icon: ShieldCheck, title: 'Authentication', desc: 'Local accounts and OIDC single sign-on.' },
    { to: '/settings/email', icon: Mail, title: 'Email', desc: 'Outbound SMTP server for notifications.' },
    { to: '/settings/notifications', icon: Bell, title: 'Notifications', desc: 'Outbound alerts by email and SMS.' },
    { to: '/settings/api-tokens', icon: KeyRound, title: 'API Tokens', desc: 'Bearer tokens for programmatic API and MCP access.' },
  ];
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
