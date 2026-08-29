import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Puzzle, ShieldCheck, Mail, ScrollText } from 'lucide-react';
import type { VersionInfo } from '@cerebro/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export function Dashboard() {
  const { user } = useAuth();
  const [version, setVersion] = useState<VersionInfo | null>(null);

  useEffect(() => {
    api.get<VersionInfo>('/api/version').then(setVersion).catch(() => {});
  }, []);

  const tiles = [
    { to: '/connectors', icon: Puzzle, title: 'Connectors', desc: 'Install & manage extensions like Proxmox, AWS, Entra.' },
    { to: '/settings/authentication', icon: ShieldCheck, title: 'Authentication', desc: 'Local accounts and OIDC single sign-on.' },
    { to: '/settings/email', icon: Mail, title: 'Email', desc: 'Configure the outbound SMTP server.' },
    { to: '/logs', icon: ScrollText, title: 'Logs & Audit', desc: 'View application logs and the audit trail.' },
  ];

  return (
    <>
      <PageHeader
        title={`Welcome, ${user?.displayName?.split(' ')[0] ?? ''}`}
        description="Your Cerebro control center."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <Link key={t.to} to={t.to}>
            <Card className="h-full transition-all hover:border-primary/50 hover:shadow-glow">
              <CardHeader>
                <div className="h-10 w-10 rounded-lg bg-primary/15 text-primary grid place-items-center mb-2">
                  <t.icon className="h-5 w-5" />
                </div>
                <CardTitle className="text-base">{t.title}</CardTitle>
                <CardDescription>{t.desc}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>

      <Card className="mt-6">
        <CardContent className="pt-6 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">System</p>
            <p className="text-sm text-muted-foreground">
              Cerebro {version ? `v${version.version}` : '…'}
              {version?.gitSha && version.gitSha !== 'dev' ? ` · ${version.gitSha.slice(0, 7)}` : ''}
            </p>
          </div>
          <span className="inline-flex items-center gap-2 text-sm text-emerald-400">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" /> Operational
          </span>
        </CardContent>
      </Card>
    </>
  );
}
