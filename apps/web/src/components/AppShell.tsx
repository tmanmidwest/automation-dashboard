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

/** Live wall-clock for the LCARS status sweep. */
function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now.toLocaleTimeString('en-GB');
}

/** Star-date style code — cosmetic, part of the LCARS vernacular. */
function stardate(): string {
  const n = new Date();
  return (41000 + (n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds()) / 86.4).toFixed(1);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const clock = useClock();

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

  const railW = collapsed ? 'md:w-16' : 'md:w-60';

  return (
    <div className="h-screen flex flex-col p-2.5 gap-2.5 bg-background text-foreground">
      {/* ── LCARS elbow header: brand block curving into the status sweep ── */}
      <header className="flex gap-2.5 h-16 shrink-0">
        <div
          className={cn(
            'hidden md:flex lcars-elbow items-end justify-end pr-4 pb-2.5 transition-[width] duration-200',
            railW,
          )}
        >
          <span className="font-lcars font-bold leading-none text-[1.55rem]">
            {collapsed ? 'CB' : 'CEREBRO'}
          </span>
        </div>

        <div className="lcars-sweep flex-1 flex items-center gap-3 px-4 min-w-0">
          {/* Mobile: hamburger + wordmark */}
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden text-[hsl(210_40%_96%)] hover:bg-white/10"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          {/* Desktop: collapse toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex text-[hsl(210_40%_96%)] hover:bg-white/10"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
          </Button>

          <span className="md:hidden font-lcars font-semibold text-lg text-[hsl(210_40%_96%)]">CEREBRO</span>

          <div className="ml-auto flex items-center gap-2 min-w-0">
            <span className="hidden lg:flex lcars-chip">SD {stardate()}</span>
            <span className="hidden sm:flex lcars-chip tabular-nums">{clock}</span>
            {user?.roleSlug === 'viewer' && (
              <span className="lcars-chip !bg-[hsl(var(--secondary))] !text-[hsl(210_40%_96%)]">View only</span>
            )}
          </div>
        </div>
      </header>

      {/* ── Body: pill nav rail + scrolling content ── */}
      <div className="flex-1 flex gap-2.5 min-h-0">
        {/* Desktop rail */}
        <aside
          className={cn(
            'hidden md:flex flex-col transition-[width] duration-200 shrink-0',
            railW,
          )}
        >
          <SidebarNav collapsed={collapsed} />
        </aside>

        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="md:hidden fixed inset-0 z-50">
            <div
              className="absolute inset-0 bg-black/60 animate-fade-in"
              onClick={() => setMobileOpen(false)}
              aria-hidden
            />
            <aside className="absolute left-0 top-0 h-full w-64 flex flex-col bg-sidebar text-sidebar-foreground p-2.5 shadow-2xl animate-slide-in-left">
              <div className="flex items-center justify-between mb-2 pl-1">
                <Brand />
                <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)} aria-label="Close menu">
                  <X className="h-5 w-5" />
                </Button>
              </div>
              <SidebarNav onNavigate={() => setMobileOpen(false)} />
            </aside>
          </div>
        )}

        {/* Main content */}
        <main className="flex-1 min-w-0 overflow-auto rounded-xl bg-card/30 border border-border/50 p-4 md:p-6 animate-fade-in">
          {children}
        </main>
      </div>
    </div>
  );
}
