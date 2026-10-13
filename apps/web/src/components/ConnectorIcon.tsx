import { Server, Cloud, Cloudy, Building2, House, Puzzle, Container, LayoutGrid, Route, Flame, Network } from 'lucide-react';

/**
 * Custom connector glyphs, authored in the lucide line style (24×24, fill none,
 * stroke=currentColor, round caps/joins, 2px) so they sit alongside the lucide
 * icons and inherit the LCARS theme colour like every other glyph. Used where a
 * stock lucide icon doesn't evoke the brand.
 */
const svgProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** Microsoft Azure — the brand "A" chevron. */
function AzureGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} {...svgProps} aria-hidden="true">
      <path d="M12 4 5 20M12 4l7 16M8.5 14.5h7" />
    </svg>
  );
}

/** Jellyfin — a simplified jellyfish (dome + tentacles). */
function JellyfinGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} {...svgProps} aria-hidden="true">
      <path d="M5 11a7 7 0 0 1 14 0" />
      <path d="M5 11h14" />
      <path d="M8.5 12c-.6 1.4-.6 2.6 0 4M12 12c.6 1.6.6 3 0 4.5M15.5 12c.6 1.4.6 2.6 0 4" />
    </svg>
  );
}

/** Maps a connector manifest icon key to a glyph. */
export function ConnectorIcon({ icon, className = 'h-5 w-5' }: { icon?: string; className?: string }) {
  switch (icon) {
    case 'proxmox':
      return <Server className={className} />;
    case 'aws':
      return <Cloud className={className} />;
    case 'azure':
      return <AzureGlyph className={className} />;
    case 'o365':
      return <LayoutGrid className={className} />;
    case 'entra':
      return <Building2 className={className} />;
    case 'backblaze':
      return <Flame className={className} />;
    case 'home-assistant':
      return <House className={className} />;
    case 'cloudflare':
      return <Cloudy className={className} />;
    case 'docker':
      return <Container className={className} />;
    case 'jellyfin':
      return <JellyfinGlyph className={className} />;
    case 'nginx-proxy-manager':
      return <Route className={className} />;
    case 'technitium':
      return <Network className={className} />;
    default:
      return <Puzzle className={className} />;
  }
}
