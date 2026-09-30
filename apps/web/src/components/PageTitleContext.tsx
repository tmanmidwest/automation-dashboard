import { createContext, useContext } from 'react';

/**
 * Lets a page publish its title up to the AppShell so the current page name can
 * render in the LCARS status sweep (the blue bar). PageHeader sets it; AppShell
 * consumes it. Pages that compute their title at runtime (connector/monitor
 * detail) work because the value flows through PageHeader's `title` prop.
 */
export const PageTitleContext = createContext<(title: string) => void>(() => {});

export function usePageTitleSetter(): (title: string) => void {
  return useContext(PageTitleContext);
}
