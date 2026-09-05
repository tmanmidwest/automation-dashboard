import { Brand } from './Brand';
import { cn } from '@/lib/utils';

/** Star-date style code — cosmetic, part of the LCARS vernacular. */
function stardate(): string {
  const n = new Date();
  return (41000 + (n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds()) / 86.4).toFixed(1);
}

/**
 * LCARS-framed shell for the unauthenticated screens (Login / Setup / Consent).
 * Renders the elbow rail + status sweep around whatever form the page provides,
 * over the shared Cerebro aurora backdrop.
 */
export function AuthFrame({
  eyebrow,
  children,
  className,
}: {
  eyebrow: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="min-h-screen grid place-items-center cerebro-aurora p-4">
      <div className={cn('w-full max-w-md', className)}>
        <div className="flex gap-2">
          {/* Left LCARS rail — brand cap, spacer, bottom elbow */}
          <div className="hidden sm:flex flex-col gap-2 w-20 shrink-0">
            <div className="h-16 rounded-tl-[2.2rem] bg-secondary grid place-items-center">
              <Brand showText={false} />
            </div>
            <div className="flex-1 min-h-[32px] rounded-r-md bg-accent/50" />
            <div className="h-16 bg-primary rounded-bl-[2.2rem]" />
          </div>

          {/* Right column — status sweep + content panel */}
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            <div className="lcars-sweep h-16 flex items-center gap-3 px-5 rounded-tr-xl">
              <span className="sm:hidden"><Brand showText={false} /></span>
              <span className="font-lcars text-lg font-semibold leading-none text-[hsl(210_40%_96%)]">{eyebrow}</span>
              <span className="ml-auto lcars-chip tabular-nums">SD {stardate()}</span>
            </div>
            <div className="bg-card/85 backdrop-blur border border-border/60 rounded-b-xl rounded-tr-xl p-6">
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
