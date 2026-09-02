import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Puzzle,
  Activity,
  Users,
  ScrollText,
  Settings,
  Info,
  LogOut,
} from 'lucide-react';
import type { Permission } from '@cerebro/shared';
import { useAuth } from '@/auth/AuthContext';
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
  { to: '/monitors', label: 'Monitors', icon: Activity, perm: 'monitors:read' },
  { to: '/users', label: 'Users', icon: Users, perm: 'users:read' },
  { to: '/logs', label: 'Logs', icon: ScrollText, perm: 'logs:read' },
  { to: '/settings', label: 'Settings', icon: Settings, perm: 'settings:read' },
  { to: '/about', label: 'About', icon: Info },
];

/**
 * The navigation body, shared by the desktop sidebar and the mobile drawer.
 * When `collapsed`, links render as an icon-only rail. `onNavigate` fires on
 * any link click (used to close the mobile drawer).
 */
export function SidebarNav({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();
  const items = NAV.filter((i) => !i.perm || can(i.perm));

  return (
    <>
      <nav className="flex-1 p-3 space-y-1">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            onClick={onNavigate}
            title={collapsed ? item.label : undefined}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                collapsed && 'justify-center px-0',
                isActive
                  ? 'bg-primary/15 text-primary shadow-[inset_2px_0_0_hsl(var(--primary))]'
                  : 'text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-white/5',
              )
            }
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {!collapsed && item.label}
          </NavLink>
        ))}
      </nav>

      <div className="p-3 border-t border-border/60">
        {!collapsed && (
          <NavLink to="/account" onClick={onNavigate}
            className="block px-3 py-2 mb-1 rounded-md hover:bg-white/5 transition-colors">
            <p className="text-sm font-medium truncate">{user?.displayName}</p>
            <p className="text-xs text-muted-foreground truncate">{user?.roleName} · account</p>
          </NavLink>
        )}
        <Button
          variant="ghost"
          size={collapsed ? 'icon' : 'default'}
          className={cn('text-muted-foreground', collapsed ? 'w-full' : 'w-full justify-start')}
          title={collapsed ? 'Sign out' : undefined}
          onClick={async () => {
            onNavigate?.();
            await logout();
            navigate('/login');
          }}
        >
          <LogOut className="h-4 w-4" />
          {!collapsed && 'Sign out'}
        </Button>
      </div>
    </>
  );
}
