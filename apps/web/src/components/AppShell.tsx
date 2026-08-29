import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Puzzle,
  Users,
  ScrollText,
  Settings,
  Info,
  LogOut,
} from 'lucide-react';
import type { Permission } from '@cerebro/shared';
import { useAuth } from '@/auth/AuthContext';
import { Brand } from './Brand';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  perm?: Permission;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/connectors', label: 'Connectors', icon: Puzzle, perm: 'connectors:read' },
  { to: '/users', label: 'Users', icon: Users, perm: 'users:read' },
  { to: '/logs', label: 'Logs', icon: ScrollText, perm: 'logs:read' },
  { to: '/settings', label: 'Settings', icon: Settings, perm: 'settings:read' },
  { to: '/about', label: 'About', icon: Info },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();

  const items = NAV.filter((i) => !i.perm || can(i.perm));

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="hidden md:flex w-64 flex-col bg-sidebar text-sidebar-foreground border-r border-border/60">
        <div className="h-16 flex items-center px-5 border-b border-border/60">
          <Brand />
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary/15 text-primary shadow-[inset_2px_0_0_hsl(var(--primary))]'
                    : 'text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-white/5',
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-border/60">
          <div className="px-3 py-2 mb-1">
            <p className="text-sm font-medium truncate">{user?.displayName}</p>
            <p className="text-xs text-muted-foreground truncate">{user?.roleName}</p>
          </div>
          <Button
            variant="ghost"
            className="w-full justify-start text-muted-foreground"
            onClick={async () => {
              await logout();
              navigate('/login');
            }}
          >
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 border-b border-border/60 flex items-center justify-between px-6 bg-background/80 backdrop-blur">
          <div className="md:hidden">
            <Brand showText={false} />
          </div>
          <div className="ml-auto flex items-center gap-2">
            {user?.roleSlug === 'viewer' && (
              <span className="text-xs rounded-full bg-secondary/30 text-secondary-foreground px-2.5 py-1">
                View only
              </span>
            )}
          </div>
        </header>
        <main className="flex-1 p-6 animate-fade-in">{children}</main>
      </div>
    </div>
  );
}
