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
  MonitorPlay,
  Video,
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
  code: string;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, code: '01-000' },
  { to: '/connectors', label: 'Connectors', icon: Puzzle, perm: 'connectors:read', code: '02-114' },
  { to: '/viewscreen', label: 'Viewscreen', icon: Video, perm: 'connectors:read', code: '03-CAM' },
  { to: '/monitors', label: 'Monitors', icon: Activity, perm: 'monitors:read', code: '04-256' },
  { to: '/users', label: 'Users', icon: Users, perm: 'users:read', code: '05-378' },
  { to: '/logs', label: 'Logs', icon: ScrollText, perm: 'logs:read', code: '06-512' },
  { to: '/settings', label: 'Settings', icon: Settings, perm: 'settings:read', code: '07-640' },
  { to: '/about', label: 'About', icon: Info, code: '08-777' },
  { to: '/panel', label: 'Panel', icon: MonitorPlay, code: '09-KSK' },
];

/**
 * The LCARS pill nav, shared by the desktop rail and the mobile drawer.
 * When `collapsed`, pills render as an icon-only rail. `onNavigate` fires on
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
    <div className="flex flex-col gap-1.5 h-full min-h-0">
      <nav className="flex-1 flex flex-col gap-1.5 overflow-y-auto pr-0.5">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            onClick={onNavigate}
            title={collapsed ? item.label : undefined}
            className={cn('lcars-pill relative', collapsed && 'lcars-pill--collapsed')}
          >
            {({ isActive }) => (
              <>
                {/* data-active drives the LCARS active fill; NavLink's render-prop gives us isActive */}
                <span
                  aria-hidden
                  className="absolute inset-0 rounded-[inherit] pointer-events-none"
                  data-active={isActive}
                  style={isActive ? { background: 'hsl(var(--primary))' } : undefined}
                />
                <item.icon className={cn('h-5 w-5 shrink-0 relative z-10', isActive && 'text-[hsl(222_47%_8%)]')} />
                {!collapsed && (
                  <span className={cn('relative z-10 flex-1 truncate', isActive && 'text-[hsl(222_47%_8%)]')}>
                    {item.label}
                  </span>
                )}
                {!collapsed && (
                  <span
                    className={cn(
                      'relative z-10 text-[0.6rem] tracking-wider tabular-nums opacity-55',
                      isActive && 'text-[hsl(222_47%_8%)]',
                    )}
                  >
                    {item.code}
                  </span>
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Account + sign out cap */}
      <div className="flex flex-col gap-1.5">
        {!collapsed && (
          <NavLink
            to="/account"
            onClick={onNavigate}
            className="rounded-[0_18px_18px_0] bg-card border border-border/60 px-4 py-2 hover:bg-muted/60 transition-colors"
          >
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
    </div>
  );
}
