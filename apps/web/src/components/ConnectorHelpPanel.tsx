import { ExternalLink, KeyRound, ListChecks, Info, AlertTriangle } from 'lucide-react';
import type { ConnectorHelp } from '@cerebro/shared';
import { Card, CardContent } from './ui/card';

/** Renders a connector's setup reference: overview, steps, required permissions, links, notes. */
export function ConnectorHelpPanel({ help }: { help?: ConnectorHelp }) {
  if (!help) return null;
  return (
    <Card className="bg-card/60">
      <CardContent className="pt-6 space-y-5 text-sm">
        {help.overview && (
          <div className="flex gap-3">
            <Info className="h-4 w-4 mt-0.5 text-accent shrink-0" />
            <p className="text-muted-foreground">{help.overview}</p>
          </div>
        )}

        {help.setupSteps && help.setupSteps.length > 0 && (
          <div>
            <p className="font-medium flex items-center gap-2 mb-2"><ListChecks className="h-4 w-4 text-primary" /> Setup steps</p>
            <ol className="list-decimal list-inside space-y-1.5 text-muted-foreground marker:text-primary/70">
              {help.setupSteps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          </div>
        )}

        {help.requiredPermissions && help.requiredPermissions.length > 0 && (
          <div>
            <p className="font-medium flex items-center gap-2 mb-2"><KeyRound className="h-4 w-4 text-primary" /> Required permissions</p>
            <ul className="space-y-1.5">
              {help.requiredPermissions.map((p, i) => (
                <li key={i} className="flex gap-2 text-muted-foreground">
                  <span className="text-primary/70 mt-1.5 h-1 w-1 rounded-full bg-current shrink-0" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {help.notes && (
          <div className="flex gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-400 shrink-0" />
            <p className="text-amber-200/90">{help.notes}</p>
          </div>
        )}

        {help.referenceLinks && help.referenceLinks.length > 0 && (
          <div>
            <p className="font-medium mb-2">Reference</p>
            <div className="flex flex-col gap-1.5">
              {help.referenceLinks.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 text-accent hover:underline w-fit">
                  <ExternalLink className="h-3.5 w-3.5" /> {l.label}
                </a>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
