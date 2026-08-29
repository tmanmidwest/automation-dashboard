import { useEffect, useState } from 'react';
import { Menu, X, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { Brand } from './Brand';
import { SidebarNav } from './SidebarNav';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

const COLLAPSE_KEY = 'cerebro.sidebar.collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  // Close the mobile drawer on Escape.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMobileOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  return (
    <div className="flex min-h-screen">
      {/* ── Desktop sidebar (collapsible to an icon rail) ── */}
      <aside
        className={cn(
          'hidden md:flex flex-col bg-sidebar text-sidebar-foreground border-r border-border/60 transition-[width] duration-200',
          collapsed ? 'w-16' : 'w-64',
        )}
      >
        <div className={cn('h-16 flex items-center border-b border-border/60', collapsed ? 'justify-center px-2' : 'px-5')}>
          {collapsed ? <Brand showText={false} /> : <Brand />}
        </div>
        <SidebarNav collapsed={collapsed} />
      </aside>

      {/* ── Mobile drawer ── */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/60 animate-fade-in"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <aside className="absolute left-0 top-0 h-full w-64 flex flex-col bg-sidebar text-sidebar-foreground border-r border-border/60 shadow-2xl animate-slide-in-left">
            <div className="h-16 flex items-center justify-between pl-5 pr-3 border-b border-border/60">
              <Brand />
              <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)} aria-label="Close menu">
                <X className="h-5 w-5" />
              </Button>
            </div>
            <SidebarNav onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      {/* ── Main column ── */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 border-b border-border/60 flex items-center gap-2 px-4 md:px-6 bg-background/80 backdrop-blur sticky top-0 z-30">
          {/* Mobile: hamburger */}
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          {/* Desktop: collapse toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
          </Button>

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
        <main className="flex-1 p-4 md:p-6 animate-fade-in">{children}</main>
      </div>
    </div>
  );
}
